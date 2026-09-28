import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  applyUsageLimits,
  clearNeoPiUsageProbeCache,
  resolveUsedFraction,
  toUsageLimits,
} from "./neopiUsageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const secret = "secret-user@example.com";
const resetsAt = 1_700_000_000_000;

function limit(input: {
  readonly id: string;
  readonly label: string;
  readonly windowId?: string;
  readonly durationMs?: number;
  readonly amount: Record<string, unknown>;
  readonly resetsAt?: number;
}) {
  return {
    id: input.id,
    label: input.label,
    scope: { provider: "redacted" },
    ...(input.windowId
      ? {
          window: {
            id: input.windowId,
            label: input.windowId,
            ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
            ...(input.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
          },
        }
      : {}),
    amount: input.amount,
  };
}

function payload(reports: readonly Record<string, unknown>[]) {
  return {
    generatedAt: resetsAt,
    reports,
    accountsWithoutUsage: [],
    disabledCredentials: [],
    capacity: {},
  };
}

const codexReport = {
  provider: "openai-codex",
  fetchedAt: resetsAt,
  metadata: { email: secret },
  raw: { token: secret },
  notes: [secret],
  resetCredits: {
    availableCount: 2,
    nextCreditId: "credit-do-not-offer",
    credits: [{ id: "credit-do-not-offer", expiresAt: "2026-10-01T00:00:00.000Z" }],
  },
  limits: [
    limit({
      id: "openai-codex:primary",
      label: "Primary",
      windowId: "7d",
      durationMs: 7 * 24 * 60 * 60 * 1000,
      resetsAt,
      amount: { used: 5, unit: "percent" },
    }),
    limit({
      id: "openai-codex:requests",
      label: "Requests",
      windowId: "7d",
      amount: { used: 3, unit: "requests" },
    }),
  ],
};

const openCodeReport = {
  provider: "opencode-go",
  fetchedAt: resetsAt,
  limits: [
    limit({
      id: "monthly",
      label: "Monthly",
      windowId: "monthly",
      durationMs: 30 * 24 * 60 * 60 * 1000,
      amount: { usedFraction: 0.4, unit: "percent" },
    }),
    limit({
      id: "5h",
      label: "5 Hour",
      windowId: "5h",
      durationMs: 5 * 60 * 60 * 1000,
      amount: { remaining: 25, limit: 100, unit: "tokens" },
    }),
    limit({
      id: "7d",
      label: "7 Day",
      windowId: "7d",
      durationMs: 7 * 24 * 60 * 60 * 1000,
      amount: { used: 10, limit: 100, unit: "requests" },
    }),
  ],
};

const previous: ServerProviderUsageLimits = {
  checkedAt: "2026-09-03T11:00:00.000Z",
  windows: [
    {
      id: "neopi:openai-codex:openai-codex:primary",
      kind: "weekly",
      label: "Primary",
      usedPercent: 1,
    },
  ],
};

describe("toUsageLimits", () => {
  it("maps the redacted openai-codex and opencode-go fixtures", () => {
    const codex = toUsageLimits({
      payload: payload([codexReport, openCodeReport]),
      activeProvider: "openai-codex",
      checkedAt,
    });
    expect(codex).toEqual({
      checkedAt,
      windows: [
        {
          id: "neopi:openai-codex:openai-codex:primary",
          kind: "weekly",
          label: "Primary",
          usedPercent: 5,
          resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAt)),
          windowDurationMins: 7 * 24 * 60,
        },
      ],
      resetCredits: { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" },
    });
    expect(containsText(codex, secret)).toBe(false);
    expect(containsText(codex, "credit-do-not-offer")).toBe(false);
    expect(containsText(codex, "metadata")).toBe(false);

    const openCode = toUsageLimits({
      payload: payload([openCodeReport]),
      activeProvider: "opencode-go",
      checkedAt,
    });
    expect(openCode?.windows.map((window) => [window.id, window.kind, window.usedPercent])).toEqual(
      [
        ["neopi:opencode-go:5h", "session", 75],
        ["neopi:opencode-go:7d", "weekly", 10],
        ["neopi:opencode-go:monthly", "monthly", 40],
      ],
    );
  });

  it("resolves remaining/limit and skips a request count with no limit", () => {
    expect(resolveUsedFraction({ remaining: 25, limit: 100, unit: "tokens" })).toBe(0.75);
    expect(
      resolveUsedFraction({ usedFraction: 0.05, remaining: 0, limit: 1, unit: "percent" }),
    ).toBe(0.05);
    expect(
      toUsageLimits({
        payload: payload([
          {
            provider: "cursor",
            limits: [
              limit({
                id: "requests",
                label: "Requests",
                amount: { used: 3, unit: "requests" },
              }),
            ],
          },
        ]),
        activeProvider: "cursor",
        checkedAt,
      }),
    ).toEqual({ checkedAt, windows: [] });
  });

  it("treats a missing provider as unsupported and a bad payload as unmapped", () => {
    expect(
      toUsageLimits({
        payload: payload([codexReport]),
        activeProvider: "missing",
        checkedAt,
      })?.unavailable,
    ).toEqual({
      reason: "unsupported",
      message: "NeoPi/OMP has no usage windows for this provider.",
    });
    expect(
      toUsageLimits({ payload: { generatedAt: 1 }, activeProvider: "openai-codex", checkedAt }),
    ).toBe(undefined);
  });
  it("does not publish another credential's exhausted window as the active account", () => {
    const exhausted = {
      ...codexReport,
      metadata: { accountId: "inactive" },
      limits: [
        limit({
          id: "openai-codex:primary",
          label: "Primary",
          amount: { usedFraction: 1 },
        }),
      ],
    };
    const result = toUsageLimits({
      payload: payload([codexReport, exhausted]),
      activeProvider: "openai-codex",
      checkedAt,
    });
    expect(result?.windows).toEqual([]);
    expect(result?.unavailable?.message).toContain("active account");
  });
});

describe("applyUsageLimits", () => {
  it.effect("uses a capable live session report without spawning the CLI fallback", () =>
    Effect.gen(function* () {
      clearNeoPiUsageProbeCache();
      const commands: ChildProcess.StandardCommand[] = [];
      const requestedProviders: string[] = [];
      const result = yield* applyUsageLimits({
        binary: "/bin/npi",
        activeProvider: "openai-codex",
        cwd: "/work",
        previous,
        getLiveUsage: (activeProvider) =>
          Effect.sync(() => {
            requestedProviders.push(activeProvider);
            return payload([codexReport]);
          }),
      }).pipe(
        Effect.provide(
          scriptedSpawner(commands, () => handle({ code: 1, stdout: "must not spawn" })),
        ),
      );

      expect(requestedProviders).toEqual(["openai-codex"]);
      expect(commands).toHaveLength(0);
      expect(result.windows).toEqual([
        expect.objectContaining({
          id: "neopi:openai-codex:openai-codex:primary",
          usedPercent: 5,
        }),
      ]);
      expect(containsText(result, secret)).toBe(false);
    }),
  );
  it.effect("rejects a malformed live report without leaking into the CLI fallback", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.StandardCommand[] = [];
      const result = yield* applyUsageLimits({
        binary: "/bin/npi",
        activeProvider: "openai-codex",
        cwd: "/work",
        previous,
        getLiveUsage: () =>
          Effect.succeed({
            generatedAt: resetsAt,
            reports: [{ provider: "openai-codex", limits: [{ id: 42 }] }],
          }),
      }).pipe(
        Effect.provide(
          scriptedSpawner(commands, () => handle({ code: 0, stdout: JSON.stringify(payload([])) })),
        ),
      );

      expect(commands).toHaveLength(0);
      expect(result).toBe(previous);
    }),
  );

  it.effect("probes the active provider and keeps previous windows when the command fails", () =>
    Effect.gen(function* () {
      clearNeoPiUsageProbeCache();
      const commands: ChildProcess.StandardCommand[] = [];
      const spawner = scriptedSpawner(commands, () =>
        handle({
          code: commands.length === 1 ? 0 : 1,
          stdout: JSON.stringify(payload([codexReport, openCodeReport])),
        }),
      );
      const first = yield* applyUsageLimits({
        binary: "/bin/npi",
        activeProvider: "openai-codex",
        profile: "work",
        cwd: "/work",
        environment: { PATH: "/usr/bin" },
        previous,
        getLiveUsage: () => Effect.succeed(undefined),
      }).pipe(Effect.provide(spawner));
      expect(commands[0]?.args).toEqual([
        "usage",
        "--json",
        "--redact",
        "--provider",
        "openai-codex",
      ]);
      expect(commands[0]?.options.env).toMatchObject({ PATH: "/usr/bin", OMP_PROFILE: "work" });
      expect(commands[0]?.options.cwd).toBe("/work");
      expect(first.windows).toEqual([
        expect.objectContaining({
          id: "neopi:openai-codex:openai-codex:primary",
          usedPercent: 5,
        }),
      ]);
      expect(containsText(first, secret)).toBe(false);

      const cached = yield* applyUsageLimits({
        binary: "/bin/npi",
        activeProvider: "OpenAI-Codex",
        profile: "work",
        cwd: "/work",
        environment: { PATH: "/usr/bin" },
        previous,
      }).pipe(Effect.provide(spawner));
      expect(commands).toHaveLength(1);
      expect(cached.windows[0]?.usedPercent).toBe(5);

      const anotherCredential = yield* applyUsageLimits({
        binary: "/bin/npi",
        activeProvider: "openai-codex",
        profile: "work",
        cwd: "/work",
        environment: { PATH: "/usr/bin", OMP_AUTH_BROKER: "other" },
        previous,
      }).pipe(Effect.provide(spawner));
      expect(commands).toHaveLength(2);
      expect(anotherCredential).toBe(previous);

      clearNeoPiUsageProbeCache();
      const failed = yield* applyUsageLimits({
        binary: "/bin/npi",
        activeProvider: "openai-codex",
        profile: "work",
        cwd: "/work",
        previous,
      }).pipe(Effect.provide(spawner));
      expect(failed).toBe(previous);
    }),
  );

  it.effect("returns unsupported without spawning when no active provider is known", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.StandardCommand[] = [];
      const result = yield* applyUsageLimits({
        binary: "/bin/npi",
        activeProvider: "  ",
        cwd: "/work",
      }).pipe(Effect.provide(scriptedSpawner(commands, () => handle({ code: 0, stdout: "{}" }))));
      expect(commands).toHaveLength(0);
      expect(result.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect("does not probe the role picker label as a native provider", () =>
    Effect.gen(function* () {
      const commands: ChildProcess.StandardCommand[] = [];
      const requested: string[] = [];
      const result = yield* applyUsageLimits({
        binary: "/bin/npi",
        activeProvider: "Roles",
        cwd: "/work",
        getLiveUsage: (provider) =>
          Effect.sync(() => {
            requested.push(provider);
            return { reports: [] };
          }),
      }).pipe(Effect.provide(scriptedSpawner(commands, () => handle({ code: 0, stdout: "{}" }))));
      expect(commands).toHaveLength(0);
      expect(requested).toEqual([]);
      expect(result.unavailable?.reason).toBe("unsupported");
    }),
  );

  it.effect("times out as probeFailed and keeps the previous windows", () =>
    Effect.gen(function* () {
      clearNeoPiUsageProbeCache();
      const result = yield* applyUsageLimits({
        binary: "/bin/npi",
        activeProvider: "openai-codex",
        cwd: "/work",
        previous,
        timeout: 0,
      }).pipe(
        Effect.provide(
          scriptedSpawner([], () =>
            handle({
              code: 0,
              stdout: "",
              exit: Effect.never as Effect.Effect<ChildProcessSpawner.ExitCode>,
            }),
          ),
        ),
      );
      expect(result).toBe(previous);
    }),
  );
});

function scriptedSpawner(
  commands: ChildProcess.StandardCommand[],
  next: () => ChildProcessSpawner.ChildProcessHandle,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (command._tag === "StandardCommand") commands.push(command);
        return next();
      }),
    ),
  );
}

function handle(input: {
  readonly code: number;
  readonly stdout: string;
  readonly exit?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.exit ?? Effect.succeed(ChildProcessSpawner.ExitCode(input.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(input.stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function containsText(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value).includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsText(item, needle));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, item]) => key.includes(needle) || containsText(item, needle),
    );
  }
  return false;
}
