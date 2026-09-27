// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { NEOPI_CURRENT_MODEL, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NeoPiRpcClient from "effect-neopi-rpc/client";
import type { SpawnFn } from "effect-neopi-rpc/client";
import { expect } from "vite-plus/test";

import * as TextGeneration from "./TextGeneration.ts";
import { makeNeoPiTextGeneration } from "./NeoPiTextGeneration.ts";
import { sanitizeCommitSubject } from "./TextGenerationUtils.ts";

const MOCK_PEER_PATH = new URL(
  "../../../../packages/effect-neopi-rpc/test/fixtures/neopi-mock-peer.ts",
  import.meta.url,
).pathname;
const TEST_MODEL = createModelSelection(
  ProviderInstanceId.make("neopi"),
  "openai-codex/gpt-5.6-luna",
);
const CURRENT_MODEL = createModelSelection(ProviderInstanceId.make("neopi"), NEOPI_CURRENT_MODEL);
const PROFILE = "neopi-text-generation-test";
const GENERATED_REPLY = {
  subject:
    "  Add the NeoPi RPC text-generation provider integration with a deliberately overlong subject line.\nsecond line",
  body: "\n## Summary\n\n- Add the provider\n\n## Testing\n\n- Run focused tests\n",
  title: "  Improve NeoPi pull request output\nsecondary title line",
  branch: "../Add!!! NeoPi Provider...",
  needsRefinement: false,
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const GENERATED_JSON = encodeJson(GENERATED_REPLY);

interface SpawnCapture {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sessionDir: string;
  pid?: number;
}

interface HarnessOptions {
  readonly responseText?: string;
  readonly peerSource?: string;
  readonly peerArgs?: ReadonlyArray<string>;
  readonly deadlineMs?: number;
}

interface Harness {
  readonly textGeneration: TextGeneration.TextGeneration["Service"];
  readonly captures: Array<SpawnCapture>;
  readonly root: string;
}

const scenarioFor = (reply: string) => ({
  scenario: [
    {
      emit: [
        {
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1_048_576,
          maxReassembledFrameBytes: 67_108_864,
          capabilities: ["rpc-ui"],
        },
      ],
    },
    {
      on: { type: "negotiate_protocol", protocolVersion: 2 },
      emit: [
        {
          id: "$id",
          type: "response",
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: 2 },
        },
      ],
    },
    {
      on: { type: "prompt" },
      emit: [
        {
          id: "$id",
          type: "response",
          command: "prompt",
          success: true,
        },
        { type: "agent_start" },
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "NOT OUTPUT " },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: reply.slice(0, 17) },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: reply.slice(17) },
        },
        {
          type: "agent_end",
          isTerminal: true,
          messages: [{ role: "assistant", content: [{ type: "text", text: reply }] }],
        },
      ],
    },
  ],
});

const exitingPeer = `
import * as readline from "node:readline";
const write = (frame) => new Promise((resolve) => process.stdout.write(JSON.stringify(frame) + "\\n", resolve));
const ready = { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864, capabilities: ["rpc-ui"] };
await write(ready);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "negotiate_protocol") {
    void write({ id: message.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
  } else if (message.type === "prompt") {
    void (async () => {
      await write({ id: message.id, type: "response", command: "prompt", success: true });
      await write({ type: "agent_start" });
      await write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
      process.stderr.write("neopi-stderr-tail\\\\n", () => process.exit(3));
    })();
  }
});
`;

const hangingPeer = `
import * as readline from "node:readline";
import * as fs from "node:fs";
const marker = process.argv[2];
const write = (frame) => new Promise((resolve) => process.stdout.write(JSON.stringify(frame) + "\\n", resolve));
const ready = { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864, capabilities: ["rpc-ui"] };
await write(ready);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "negotiate_protocol") {
    void write({ id: message.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } });
  } else if (message.type === "prompt") {
    void (async () => {
      await write({ id: message.id, type: "response", command: "prompt", success: true });
      await write({ type: "agent_start" });
      fs.writeFileSync(marker, "prompt received");
      setInterval(() => {}, 1000);
    })();
  }
});
`;

const makeHarness = (
  options: HarnessOptions = {},
): Effect.Effect<Harness, never, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-neopi-text-test-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const peerArgs = [...(options.peerArgs ?? [])];
    let peerPath = MOCK_PEER_PATH;
    if (options.peerSource !== undefined) {
      peerPath = NodePath.join(root, "mock-peer.mjs");
      NodeFS.writeFileSync(peerPath, options.peerSource, "utf8");
    } else {
      const scenarioPath = NodePath.join(root, "scenario.json");
      NodeFS.writeFileSync(
        scenarioPath,
        encodeJson(
          scenarioFor(
            options.responseText ??
              `\n\u0060\u0060\u0060json\n${GENERATED_JSON}\n\u0060\u0060\u0060\n`,
          ),
        ),
        "utf8",
      );
      peerArgs.unshift(scenarioPath);
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const captures: Array<SpawnCapture> = [];
    const spawn: SpawnFn = (command) =>
      Effect.gen(function* () {
        const standard = command as ChildProcess.StandardCommand;
        const sessionIndex = standard.args.indexOf("--session-dir");
        const sessionDir = standard.args[sessionIndex + 1];
        if (sessionIndex < 0 || sessionDir === undefined) {
          return yield* Effect.die("NeoPi text generation omitted --session-dir");
        }
        const capture: SpawnCapture = {
          args: [...standard.args],
          env: standard.options.env ?? {},
          sessionDir,
        };
        captures.push(capture);
        NodeFS.writeFileSync(NodePath.join(sessionDir, "disposable-marker"), "remove me", "utf8");
        const handle = yield* spawner.spawn(command);
        capture.pid = handle.pid;
        return handle;
      });

    const textGeneration = makeNeoPiTextGeneration({
      binary: "npi",
      env: { OMP_PROFILE: PROFILE },
      spawn,
      makeClient: (clientOptions) =>
        NeoPiRpcClient.make({
          ...clientOptions,
          command: process.execPath,
          args: [peerPath, ...peerArgs, ...clientOptions.args],
        }),
      deadlineMs: options.deadlineMs ?? 5_000,
    });
    return { textGeneration, captures, root };
  });

const withNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

const outputText = (json: string): string =>
  `\n\u0060\u0060\u0060json\n${json}\n\u0060\u0060\u0060\n`;

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForFile = (path: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (NodeFS.existsSync(path)) return true;
      yield* Effect.sleep("10 millis");
    }
    return false;
  });

it.live("generates all four text operations through a trimmed disposable RPC loadout", () =>
  withNode(
    Effect.scoped(
      Effect.gen(function* () {
        const { textGeneration, captures } = yield* makeHarness();
        const commit = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "main",
          stagedSummary: "M apps/server/src/provider/neopi/NeoPiSessionRuntime.ts",
          stagedPatch: "diff --git a/runtime.ts b/runtime.ts",
          includeBranch: true,
          modelSelection: TEST_MODEL,
        });
        const pr = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/neopi-rpc",
          commitSummary: "Add NeoPi RPC support",
          diffSummary: "1 file changed",
          diffPatch: "diff --git a/provider.ts b/provider.ts",
          modelSelection: TEST_MODEL,
        });
        const branch = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Add a NeoPi provider branch",
          modelSelection: TEST_MODEL,
        });
        const title = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Implement NeoPi automatic titles",
          modelSelection: CURRENT_MODEL,
        });

        expect(commit.subject).toBe(sanitizeCommitSubject(GENERATED_REPLY.subject));
        expect(commit.subject.length).toBeLessThanOrEqual(72);
        expect(commit.subject.endsWith(".")).toBe(false);
        expect(commit.body).toBe(
          "## Summary\n\n- Add the provider\n\n## Testing\n\n- Run focused tests",
        );
        expect(commit.branch).toBe("feature/add-neopi-provider");
        expect(pr.title).toBe("Improve NeoPi pull request output");
        expect(pr.body).toBe(
          "## Summary\n\n- Add the provider\n\n## Testing\n\n- Run focused tests",
        );
        expect(branch.branch).toBe("add-neopi-provider");
        expect(title.title).toBe("Improve NeoPi pull request output");
        expect(title.needsRefinement).toBeUndefined();
        expect(captures).toHaveLength(4);

        const disabledFlags = [
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-rules",
          "--no-session",
        ];
        for (const capture of captures) {
          for (const flag of disabledFlags) expect(capture.args).toContain(flag);
          expect(capture.args).toContain("--mode");
          expect(capture.args).toContain("rpc");
          expect(capture.args).toContain("--no-title");
          expect(capture.args).toContain("--cwd");
          expect(capture.env.OMP_PROFILE).toBe(PROFILE);
          expect(NodeFS.existsSync(capture.sessionDir)).toBe(false);
        }
        expect(captures[0]?.args).toContain("--model");
        expect(captures[0]?.args).toContain("openai-codex/gpt-5.6-luna");
        const titleArgs = captures[3]?.args ?? [];
        expect(titleArgs).not.toContain(NEOPI_CURRENT_MODEL);
        expect(titleArgs).not.toContain("--model");
      }),
    ),
  ),
);

it.live("fails invalid JSON as TextGenerationError and still removes the session directory", () =>
  withNode(
    Effect.scoped(
      Effect.gen(function* () {
        const { textGeneration, captures } = yield* makeHarness({
          responseText: "not a JSON object",
        });
        const result = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Generate a title",
            modelSelection: TEST_MODEL,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ error }),
              onSuccess: (value) => ({ value }),
            }),
          );
        expect("error" in result).toBe(true);
        if ("error" in result) {
          expect(result.error._tag).toBe("TextGenerationError");
          expect(result.error.detail).toContain("not valid JSON");
        }
        expect(captures).toHaveLength(1);
        expect(NodeFS.existsSync(captures[0]!.sessionDir)).toBe(false);
      }),
    ),
  ),
);

it.live("includes the stderr tail when the RPC peer exits mid-stream", () =>
  withNode(
    Effect.scoped(
      Effect.gen(function* () {
        const { textGeneration, captures } = yield* makeHarness({ peerSource: exitingPeer });
        const result = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Generate a title",
            modelSelection: TEST_MODEL,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ error }),
              onSuccess: (value) => ({ value }),
            }),
          );
        expect("error" in result).toBe(true);
        if ("error" in result) {
          expect(result.error._tag).toBe("TextGenerationError");
          expect(result.error.detail).toContain("neopi-stderr-tail");
        }
        expect(captures).toHaveLength(1);
        expect(NodeFS.existsSync(captures[0]!.sessionDir)).toBe(false);
      }),
    ),
  ),
);

it.live("closes the RPC process when the generation deadline expires", () =>
  withNode(
    Effect.scoped(
      Effect.gen(function* () {
        const marker = NodePath.join(NodeOS.tmpdir(), `t3-neopi-hang-${NodeCrypto.randomUUID()}`);
        const { textGeneration, captures } = yield* makeHarness({
          peerSource: hangingPeer,
          peerArgs: [marker],
          deadlineMs: 700,
        });
        const result = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Generate a title",
            modelSelection: TEST_MODEL,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ error }),
              onSuccess: (value) => ({ value }),
            }),
          );
        expect("error" in result).toBe(true);
        if ("error" in result) {
          expect(result.error._tag).toBe("TextGenerationError");
          expect(result.error.detail).toContain("deadline");
        }
        expect(captures).toHaveLength(1);
        expect(captures[0]?.pid).toBeDefined();
        expect(isProcessAlive(captures[0]!.pid!)).toBe(false);
        expect(NodeFS.existsSync(captures[0]!.sessionDir)).toBe(false);
        NodeFS.rmSync(marker, { force: true });
      }),
    ),
  ),
);

it.live("closes the RPC process when a generation fiber is interrupted", () =>
  withNode(
    Effect.scoped(
      Effect.gen(function* () {
        const marker = NodePath.join(
          NodeOS.tmpdir(),
          `t3-neopi-interrupt-${NodeCrypto.randomUUID()}`,
        );
        const { textGeneration, captures } = yield* makeHarness({
          peerSource: hangingPeer,
          peerArgs: [marker],
          deadlineMs: 10_000,
        });
        const fiber = yield* textGeneration
          .generateThreadTitle({
            cwd: process.cwd(),
            message: "Generate a title",
            modelSelection: TEST_MODEL,
          })
          .pipe(Effect.forkChild);
        expect(yield* waitForFile(marker)).toBe(true);
        expect(captures).toHaveLength(1);
        const pid = captures[0]?.pid;
        expect(pid).toBeDefined();
        yield* Fiber.interrupt(fiber);
        expect(isProcessAlive(pid!)).toBe(false);
        expect(NodeFS.existsSync(captures[0]!.sessionDir)).toBe(false);
        NodeFS.rmSync(marker, { force: true });
      }),
    ),
  ),
);
