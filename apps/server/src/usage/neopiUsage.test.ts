// @effect-diagnostics nodeBuiltinImport:off - the suite seeds session trees on
// disk, mirroring the reader's deliberate node:fs usage.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { deriveServerPaths } from "../config.ts";
import {
  neopiLegacySessionRoot,
  neopiProjectSessionDir,
  neopiSessionRoot,
} from "../provider/neopi/NeoPiPaths.ts";

import { discoverNeoPiSessionRoots, readNeoPiUsage } from "./neopiUsage.ts";

const fixturePath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "testFixtures",
  "neopi-session.jsonl",
);

function assistant(input: {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly timestampMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoningTokens?: number;
  readonly cost: number;
}) {
  return {
    type: "message",
    id: input.id,
    parentId: null,
    timestamp: DateTime.formatIso(DateTime.makeUnsafe(input.timestampMs)),
    message: {
      role: "assistant",
      provider: input.provider,
      model: input.model,
      timestamp: input.timestampMs,
      usage: {
        input: input.inputTokens,
        output: input.outputTokens,
        cacheRead: input.cacheRead ?? 0,
        cacheWrite: input.cacheWrite ?? 0,
        totalTokens: input.inputTokens + input.outputTokens,
        ...(input.reasoningTokens === undefined ? {} : { reasoningTokens: input.reasoningTokens }),
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: input.cost,
        },
      },
    },
  };
}

function modelUsage(input: {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly timestamp: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
}) {
  return {
    type: "model_usage",
    id: input.id,
    parentId: null,
    timestamp: input.timestamp,
    purpose: "title",
    api: "openai-responses",
    provider: input.provider,
    model: input.model,
    usage: {
      input: input.inputTokens,
      output: input.outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input.inputTokens + input.outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input.cost },
    },
    stopReason: "stop",
  };
}

async function writeSession(
  dir: string,
  name: string,
  header: Record<string, unknown>,
  entries: readonly unknown[],
): Promise<string> {
  const file = NodePath.join(dir, name);
  const body = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await NodeFSP.writeFile(file, body);
  return file;
}

describe("readNeoPiUsage", () => {
  it("reads the redacted fixture: two assistant messages and one model_usage", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "neopi-usage-"));
    try {
      const file = NodePath.join(dir, "neopi-session.jsonl");
      await NodeFSP.copyFile(fixturePath, file);
      const firstLine = (await NodeFSP.readFile(file)).subarray(0, 256).toString("utf8");
      expect(Buffer.byteLength(firstLine)).toBe(256);
      expect(firstLine.endsWith("\n")).toBe(true);
      expect(JSON.parse(firstLine).type).toBe("title");

      const result = await readNeoPiUsage([dir], 0);
      expect(result.roots[0]?.error).toBe(false);
      const records = result.roots.flatMap((root) => root.files.flatMap((entry) => entry.records));
      expect(records).toHaveLength(3);
      expect(records.map((record) => record.model)).toEqual([
        "openai-codex/gpt-5.4",
        "anthropic/claude-sonnet-4",
        "openai-codex/gpt-5.4-mini",
      ]);
      expect(records[0]).toMatchObject({
        provider: "neopi",
        sessionId: "sess-redacted",
        timestampMs: 1754049602000,
        reportedCostUsd: 0.033,
        fast: false,
        dedupeKey: `${file}:ent-a2`,
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 30,
          cacheCreationTokens: 40,
          outputTokens: 20,
          reasoningTokens: 5,
        },
      });
      expect(records[1]?.totals.reasoningTokens).toBe(0);
      expect(records[1]?.reportedCostUsd).toBe(1.5);
      expect(records[2]).toMatchObject({
        timestampMs: Date.parse("2026-08-01T12:00:04.000Z"),
        reportedCostUsd: 0.003,
        dedupeKey: `${file}:ent-m1`,
        totals: {
          uncachedInputTokens: 3,
          cachedInputTokens: 1,
          cacheCreationTokens: 2,
          outputTokens: 4,
          reasoningTokens: 1,
        },
      });
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not double count entries a branch copied from its parent", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "neopi-usage-branch-"));
    try {
      const copied = [
        assistant({
          id: "ent-a2",
          provider: "openai-codex",
          model: "gpt-5.4",
          timestampMs: 1754049602000,
          inputTokens: 100,
          outputTokens: 20,
          cost: 0.033,
        }),
        assistant({
          id: "ent-a3",
          provider: "anthropic",
          model: "claude-sonnet-4",
          timestampMs: 1754049603000,
          inputTokens: 7,
          outputTokens: 8,
          cost: 1.5,
        }),
        modelUsage({
          id: "ent-m1",
          provider: "openai-codex",
          model: "gpt-5.4-mini",
          timestamp: "2026-08-01T12:00:04.000Z",
          inputTokens: 3,
          outputTokens: 4,
          cost: 0.003,
        }),
      ];
      const parent = await writeSession(
        dir,
        "parent.jsonl",
        {
          type: "session",
          version: 3,
          id: "parent-session",
          timestamp: "2026-08-01T12:00:00.000Z",
          cwd: "/redacted",
        },
        copied,
      );
      const childOnly = assistant({
        id: "ent-new",
        provider: "openai-codex",
        model: "gpt-5.4",
        timestampMs: 1754049700000,
        inputTokens: 1,
        outputTokens: 2,
        cost: 0.5,
      });
      await writeSession(
        dir,
        "branch.jsonl",
        {
          type: "session",
          version: 3,
          id: "branch-session",
          timestamp: "2026-08-01T12:10:00.000Z",
          cwd: "/redacted",
          parentSession: parent,
        },
        [...copied, childOnly],
      );
      await writeSession(
        dir,
        "fork.jsonl",
        {
          type: "session",
          version: 3,
          id: "fork-session",
          timestamp: "2026-08-01T12:20:00.000Z",
          cwd: "/redacted",
          parentSession: "parent-session",
        },
        [copied[0]],
      );

      const records = (await readNeoPiUsage([dir], 0)).roots.flatMap((root) =>
        root.files.flatMap((entry) => entry.records),
      );
      expect(records.map((record) => record.dedupeKey?.split(":").at(-1)).sort()).toEqual([
        "ent-a2",
        "ent-a3",
        "ent-m1",
        "ent-new",
      ]);
      expect(records.filter((record) => record.dedupeKey?.endsWith(":ent-a2"))).toHaveLength(1);
      expect(records.find((record) => record.dedupeKey?.endsWith(":ent-a2"))?.sessionId).toBe(
        "parent-session",
      );
      expect(records.find((record) => record.dedupeKey?.endsWith(":ent-new"))?.sessionId).toBe(
        "branch-session",
      );
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the same entry id when the files are not one lineage", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "neopi-usage-unrelated-"));
    try {
      const entry = assistant({
        id: "ent-same",
        provider: "openai-codex",
        model: "gpt-5.4",
        timestampMs: 1754049602000,
        inputTokens: 4,
        outputTokens: 5,
        cost: 0.1,
      });
      await writeSession(
        dir,
        "one.jsonl",
        { type: "session", id: "one", timestamp: "2026-08-01T12:00:00.000Z", cwd: "/redacted" },
        [entry],
      );
      await writeSession(
        dir,
        "two.jsonl",
        { type: "session", id: "two", timestamp: "2026-08-01T12:00:00.000Z", cwd: "/redacted" },
        [entry],
      );
      const records = (await readNeoPiUsage([dir], 0)).roots.flatMap((root) =>
        root.files.flatMap((file) => file.records),
      );
      expect(records).toHaveLength(2);
      expect(new Set(records.map((record) => record.sessionId))).toEqual(new Set(["one", "two"]));
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("discoverNeoPiSessionRoots", () => {
  it("includes the shared omp sessions dir, both T3 roots, and existing profile dirs", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "neopi-usage-roots-"));
    try {
      const baseDir = NodePath.join(home, "t3");
      const stateDir = NodePath.join(baseDir, "userdata");
      const xdg = NodePath.join(home, "xdg");
      await NodeFSP.mkdir(NodePath.join(stateDir, "neopi", "sessions"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(home, ".omp", "profiles", "work", "agent", "sessions"), {
        recursive: true,
      });
      await NodeFSP.mkdir(NodePath.join(xdg, "omp", "profiles", "xdgwork", "agent", "sessions"), {
        recursive: true,
      });
      const roots = await discoverNeoPiSessionRoots({
        home,
        baseDir,
        stateDir,
        env: { XDG_DATA_HOME: xdg },
      });
      expect(roots).toContain(NodePath.join(home, ".omp", "agent", "sessions"));
      expect(roots).toContain(neopiSessionRoot({ baseDir }));
      expect(roots).toContain(neopiLegacySessionRoot({ stateDir }));
      expect(roots).toContain(NodePath.join(home, ".omp", "profiles", "work", "agent", "sessions"));
      expect(roots).toContain(NodePath.join(xdg, "omp", "sessions"));
      expect(roots).toContain(
        NodePath.join(xdg, "omp", "profiles", "xdgwork", "agent", "sessions"),
      );
      expect(roots).toHaveLength(6);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });

  it.effect("uses a real server config and still reads an existing legacy stateDir root", () =>
    Effect.gen(function* () {
      const baseDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "neopi-config-roots-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(baseDir, { recursive: true, force: true })),
      );
      const userdata = yield* deriveServerPaths(baseDir, undefined);
      const dev = yield* deriveServerPaths(baseDir, new URL("http://127.0.0.1:3773/"));
      expect(userdata.stateDir).toBe(NodePath.join(baseDir, "userdata"));
      expect(dev.stateDir).toBe(NodePath.join(baseDir, "dev"));
      expect(neopiSessionRoot({ baseDir })).toBe(NodePath.join(baseDir, "neopi", "sessions"));
      expect(neopiSessionRoot({ baseDir })).not.toBe(
        neopiLegacySessionRoot({ stateDir: userdata.stateDir }),
      );

      const canonical = neopiProjectSessionDir({
        baseDir,
        profile: "work",
        projectId: "proj",
      });
      const legacy = neopiLegacySessionRoot({ stateDir: userdata.stateDir });
      const header = (id: string) => ({
        type: "session",
        id,
        timestamp: "2026-08-01T12:00:00.000Z",
        cwd: "/redacted",
      });
      const entry = (id: string) =>
        assistant({
          id,
          provider: "openai-codex",
          model: "gpt-5.4",
          timestampMs: Date.parse("2026-08-01T12:00:00.000Z"),
          inputTokens: 10,
          outputTokens: 2,
          cost: 0.01,
        });
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(canonical, { recursive: true });
        await NodeFSP.mkdir(legacy, { recursive: true });
        await writeSession(canonical, "live.jsonl", header("live"), [entry("live-entry")]);
        await writeSession(legacy, "old.jsonl", header("old"), [entry("old-entry")]);
      });

      const devRoots = yield* Effect.promise(() =>
        discoverNeoPiSessionRoots({
          home: baseDir,
          baseDir,
          stateDir: dev.stateDir,
          env: {},
        }),
      );
      expect(devRoots).toContain(neopiSessionRoot({ baseDir }));
      expect(devRoots).not.toContain(neopiLegacySessionRoot({ stateDir: dev.stateDir }));

      const roots = yield* Effect.promise(() =>
        discoverNeoPiSessionRoots({
          home: baseDir,
          baseDir,
          stateDir: userdata.stateDir,
          env: {},
        }),
      );
      expect(roots).toContain(neopiSessionRoot({ baseDir }));
      expect(roots).toContain(legacy);
      const records = yield* Effect.promise(async () =>
        (await readNeoPiUsage(roots, 0)).roots.flatMap((root) =>
          root.files.flatMap((file) => file.records),
        ),
      );
      expect(records.map((record) => record.sessionId).sort()).toEqual(["live", "old"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
