// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ApprovalRequestId,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeNeoPiSessionRuntime, type NeoPiRuntimeInput } from "./NeoPiSessionRuntime.ts";
import type { NeoPiResumeCursor } from "./NeoPiRuntimeTypes.ts";
import { makeNeoPiAdapter } from "../Layers/NeoPiAdapter.ts";
import { makeNeoPiDiscoveryHub } from "./NeoPiDiscovery.ts";
import { makeOrchestrationIntegrationHarness } from "../../../integration/OrchestrationEngineHarness.integration.ts";

const root = "/tmp/neopi-runtime-tests";
const sessionDir = `${root}/neopi/sessions/default/test`;
const sessionFile = `${sessionDir}/session.jsonl`;
type Command = { id?: string; type: string; [key: string]: unknown };
const decodeCommand = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeCommand = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
type Emitter = (frame: unknown) => Effect.Effect<void>;
const defaultReady = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  capabilities: ["rpc-ui"],
};
const testPeer = Effect.fn("testPeer")(function* (
  handler: (cmd: Command, emit: Emitter) => Effect.Effect<void>,
  ready: unknown = defaultReady,
) {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const exited = yield* Deferred.make<string | null>();
  const commands: Command[] = [];
  const signals: string[] = [];
  const emit: Emitter = (frame) =>
    Queue.offer(stdout, new TextEncoder().encode(`${JSON.stringify(frame)}\n`)).pipe(Effect.asVoid);
  const finish = (signal: string | null) =>
    Effect.gen(function* () {
      yield* Queue.end(stdout).pipe(Effect.ignore);
      yield* Deferred.succeed(exited, signal).pipe(Effect.ignore);
    });
  yield* emit(ready);
  yield* Effect.gen(function* () {
    let pending = "";
    while (true) {
      pending += new TextDecoder().decode(yield* Queue.take(stdin));
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const command = decodeCommand(line) as Command;
        commands.push(command);
        yield* ready === defaultReady && command.type === "negotiate_protocol"
          ? answer(command, emit, { protocolVersion: 2 })
          : handler(command, emit);
      }
    }
  }).pipe(Effect.ignore, Effect.forkScoped);
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    exitCode: Deferred.await(exited).pipe(
      Effect.flatMap((signal) =>
        signal
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "exitCode",
                cause: new Error(`Process interrupted due to receipt of signal: '${signal}'`),
              }),
            )
          : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      ),
    ),
    isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
    kill: (options) =>
      Effect.gen(function* () {
        signals.push(options?.killSignal ?? "SIGTERM");
        if (options?.forceKillAfter) {
          yield* Effect.sleep(options.forceKillAfter);
          signals.push("SIGKILL");
          yield* finish("SIGKILL");
        } else yield* finish(options?.killSignal ?? "SIGTERM");
      }),
    stdin: Sink.forEach((chunk: Uint8Array) => Queue.offer(stdin, chunk)),
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
  return { handle, commands, emit, finish, signals };
});
const answer = (cmd: Command, emit: Emitter, data: unknown = {}) =>
  emit({ type: "response", id: cmd.id, command: cmd.type, success: true, data });
const basicHandler = (cmd: Command, emit: Emitter) =>
  cmd.type === "get_state"
    ? answer(cmd, emit, { sessionId: "s1", sessionFile, messageCount: 0 })
    : cmd.type === "get_entries"
      ? answer(cmd, emit, { entries: [], leafId: null })
      : answer(cmd, emit);
const make = (
  spawn: NeoPiRuntimeInput["spawn"],
  cursor?: { sessionId: string; sessionFile: string; sessionDir: string; v: 1; turnBoundaries: [] },
  hostBridge?: NeoPiRuntimeInput["hostBridge"],
  sharedSessionCapabilities?: ReadonlySet<string>,
) =>
  makeNeoPiSessionRuntime({
    threadId: "thread-test" as ThreadId,
    binary: "npi",
    cwd: "/tmp",
    t3Home: root,
    projectId: "test",
    runtimeMode: "approval-required",
    spawn,
    ...(cursor ? { cursor } : {}),
    ...(hostBridge ? { hostBridge } : {}),
    ...(sharedSessionCapabilities ? { sharedSessionCapabilities } : {}),
    closeGraceMs: 20,
  });
const turn = (id: string) => ({ turnId: id as TurnId, text: "hello", images: [] });
const capture = (runtime: Effect.Success<ReturnType<typeof make>>) =>
  Effect.gen(function* () {
    const frames: Array<Record<string, unknown>> = [];
    yield* Stream.runForEach(runtime.frames, (frame) =>
      Effect.sync(() => {
        frames.push(frame as Record<string, unknown>);
      }),
    ).pipe(Effect.forkScoped);
    return frames;
  });
const awaitOutcomes = (frames: Array<Record<string, unknown>>, count: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const outcomes = frames.filter((frame) => frame.type === "t3.turn.outcome");
      if (outcomes.length >= count) return outcomes;
      yield* Effect.sleep("5 millis");
    }
    throw new Error(
      `Expected ${count} outcomes, observed ${frames.filter((frame) => frame.type === "t3.turn.outcome").length}`,
    );
  });

it.live("uses shared files only with both lease and fresh-session capabilities", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const advertised of [
        [],
        ["session_lease"],
        ["new_session"],
        ["session_lease", "new_session"],
      ]) {
        const shared = advertised.length === 2;
        const file = shared ? "/tmp/omp-sessions/session.jsonl" : sessionFile;
        const peer = yield* testPeer(
          (cmd, emit) =>
            cmd.type === "negotiate_protocol"
              ? answer(cmd, emit, { protocolVersion: 2 })
              : cmd.type === "get_state"
                ? answer(cmd, emit, { sessionId: "s1", sessionFile: file, messageCount: 0 })
                : basicHandler(cmd, emit),
          { ...defaultReady, capabilities: ["rpc-ui", ...advertised] },
        );
        const launches: ReadonlyArray<string>[] = [];
        const runtime = yield* make(
          (command) =>
            Effect.sync(() => {
              if (!ChildProcess.isStandardCommand(command))
                throw new Error("Expected a standard NeoPi command");
              launches.push(command.args);
              return peer.handle;
            }),
          undefined,
          undefined,
          new Set(advertised),
        );
        yield* runtime.start;
        NodeAssert.equal(launches[0]?.includes("--new-session"), shared);
        NodeAssert.equal(launches[0]?.includes("--session-dir"), !shared);
        NodeAssert.equal(
          (yield* SubscriptionRef.get(runtime.cursor)).sessionDir,
          shared ? "/tmp/omp-sessions" : sessionDir,
        );
        yield* runtime.stop;
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("routes role aliases through set_role only when get_roles is advertised", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const advertiseRole of [false, true]) {
        const peer = yield* testPeer(
          (cmd, emit) =>
            cmd.type === "negotiate_protocol"
              ? answer(cmd, emit, { protocolVersion: 2 })
              : basicHandler(cmd, emit),
          {
            ...defaultReady,
            capabilities: advertiseRole ? ["rpc-ui", "get_roles"] : ["rpc-ui"],
          },
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        yield* runtime.start;
        yield* runtime.applyModelSelection({
          instanceId: ProviderInstanceId.make("neopi"),
          model: "@smol",
        });
        NodeAssert.deepEqual(
          peer.commands
            .filter((command) => command.type === "set_role")
            .map(({ id: _, ...command }) => command),
          advertiseRole ? [{ type: "set_role", role: "smol" }] : [],
        );
        yield* runtime.stop;
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("holds a plan proposal until refine feedback continues a new T3 turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let promptStarted = false;
      const peer = yield* testPeer(
        (cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "negotiate_protocol")
              return yield* answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "get_entries")
              return yield* answer(
                cmd,
                emit,
                promptStarted
                  ? {
                      entries: [
                        {
                          id: "native-user",
                          type: "message",
                          parentId: null,
                          message: { role: "user", content: [{ type: "text", text: "plan this" }] },
                        },
                        {
                          id: "proposal-tool",
                          type: "message",
                          parentId: "native-user",
                          message: {
                            role: "assistant",
                            content: [{ type: "text", text: "# Plan" }],
                          },
                        },
                      ],
                      leafId: "proposal-tool",
                    }
                  : { entries: [], leafId: null },
              );
            if (cmd.type === "prompt") {
              promptStarted = true;
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({
                type: "plan_proposal_request",
                id: "proposal-1",
                title: "Plan",
                planFilePath: "xd://plan/test",
                planMarkdown: "# Plan",
              });
              return;
            }
            if (cmd.type === "plan_proposal_response") {
              yield* emit({
                type: "agent_end",
                isTerminal: true,
                messages: [{ role: "assistant", stopReason: "stop" }],
              });
              return;
            }
            yield* basicHandler(cmd, emit);
          }),
        { ...defaultReady, capabilities: ["rpc-ui", "set_mode"] },
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn({ ...turn("source"), text: "plan this" });
      yield* awaitOutcomes(frames, 1);
      NodeAssert.equal(
        peer.commands.some((cmd) => cmd.type === "plan_proposal_response"),
        false,
      );
      NodeAssert.deepEqual((yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries, [
        { turnId: "source", userEntryId: "native-user" },
      ]);
      yield* runtime.resolvePlanProposal(
        { decision: "refine", feedback: "Please simplify step two" },
        { ...turn("refine"), text: "Please simplify step two" },
      );
      yield* awaitOutcomes(frames, 2);
      NodeAssert.deepEqual(
        peer.commands
          .filter((cmd) => cmd.type === "plan_proposal_response")
          .map(({ type, id, decision, feedback }) => ({ type, id, decision, feedback })),
        [
          {
            type: "plan_proposal_response",
            id: "proposal-1",
            decision: "refine",
            feedback: "Please simplify step two",
          },
        ],
      );
      NodeAssert.deepEqual((yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries, [
        { turnId: "source", userEntryId: "native-user" },
        { turnId: "refine", kind: "continuation", afterEntryId: "proposal-tool" },
      ]);
      NodeAssert.equal(
        frames.some((frame) => frame.type === "t3.turn.outcome" && frame.turnId === "refine"),
        true,
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("interrupting a pending plan proposal refuses it without approval", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(
        (cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "negotiate_protocol")
              return yield* answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "prompt") {
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({
                type: "plan_proposal_request",
                id: "pending-plan",
                planMarkdown: "# Plan",
              });
              return;
            }
            if (cmd.type === "abort") {
              yield* answer(cmd, emit);
              yield* emit({ type: "agent_end", isTerminal: true });
              return;
            }
            yield* basicHandler(cmd, emit);
          }),
        { ...defaultReady, capabilities: ["rpc-ui", "set_mode"] },
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn({ ...turn("source"), text: "plan this" });
      yield* awaitOutcomes(frames, 1);
      yield* runtime.interrupt;
      NodeAssert.deepEqual(
        peer.commands
          .filter((cmd) => cmd.type === "plan_proposal_response")
          .map(({ type, id, decision }) => ({ type, id, decision })),
        [{ type: "plan_proposal_response", id: "pending-plan", decision: "refine" }],
      );
      NodeAssert.equal(
        peer.commands.some((cmd) => cmd.type === "abort"),
        true,
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects a v1-only peer during live session admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(basicHandler, { type: "ready", protocolVersion: 1 });
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const error = yield* Effect.flip(runtime.start);
      NodeAssert.equal(error.code, "startup");
      NodeAssert.match(error.message, /protocol v2/);
      NodeAssert.equal(
        peer.commands.some((cmd) => cmd.type === "get_state"),
        false,
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects auto-resumed fresh sessions and mismatched resume ids, closing both peers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const cursor of [
        undefined,
        { v: 1 as const, sessionFile, sessionId: "expected", sessionDir, turnBoundaries: [] as [] },
      ]) {
        const peer = yield* testPeer((cmd, emit) =>
          cmd.type === "get_state"
            ? answer(cmd, emit, { sessionId: "unexpected", sessionFile, messageCount: 3 })
            : basicHandler(cmd, emit),
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle), cursor);
        const failure = yield* runtime.start.pipe(Effect.flip);
        NodeAssert.equal(failure.code, "identity_mismatch");
        NodeAssert.equal(yield* SubscriptionRef.get(runtime.state), "failed");
        NodeAssert.ok(peer.signals.includes("SIGKILL"));
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
it.live(
  "settles late rejection, local response, local prompt_result and terminal agent_end exactly once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* testPeer((cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type !== "prompt") return yield* basicHandler(cmd, emit);
            if (cmd.message === "reject") {
              yield* answer(cmd, emit);
              yield* emit({
                type: "response",
                id: cmd.id,
                command: "prompt",
                success: false,
                error: "denied",
              });
            } else if (cmd.message === "data-local")
              yield* answer(cmd, emit, { agentInvoked: false });
            else if (cmd.message === "event-local") {
              yield* answer(cmd, emit);
              yield* emit({ type: "command_output", text: "local output" });
              yield* emit({ type: "prompt_result", id: cmd.id, agentInvoked: false });
            } else {
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              yield* emit({ type: "agent_end", isTerminal: false, hasFinalResponse: true });
              yield* emit({ type: "agent_end", isTerminal: true });
            }
          }),
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        const frames = yield* capture(runtime);
        yield* runtime.start;
        for (const [i, text] of ["reject", "data-local", "event-local", "agent"].entries()) {
          yield* runtime.startTurn({ ...turn(`turn-${i}`), text });
          const outcomes = yield* awaitOutcomes(frames, i + 1);
          NodeAssert.equal(outcomes[i]?.state, i === 0 ? "failed" : "completed");
          NodeAssert.equal(yield* SubscriptionRef.get(runtime.state), "ready");
        }
        NodeAssert.equal(frames.filter((frame) => frame.type === "t3.turn.outcome").length, 4);
        NodeAssert.deepEqual(
          (yield* SubscriptionRef.get(runtime.cursor)).turnBoundaries.map((boundary) =>
            "kind" in boundary ? boundary.kind : boundary.userEntryId,
          ),
          ["unknown", "local", "local", "unknown"],
        );
        NodeAssert.ok(
          frames.findIndex((frame) => frame.type === "command_output") <
            frames.findIndex(
              (frame) => frame.turnId === "turn-2" && frame.type === "t3.turn.outcome",
            ),
        );
        yield* runtime.stop;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.live(
  "steers only running turns, interrupts at terminal end and captures one user boundary per prompt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let ordinal = 0;
        const entries: Array<{
          id: string;
          parentId: string | null;
          type: string;
          message: { role: string; content: Array<{ type: string; text: string }> };
        }> = [];
        const append = (id: string, text: string) => {
          entries.push({
            id,
            parentId: entries.at(-1)?.id ?? null,
            type: "message",
            message: { role: "user", content: [{ type: "text", text }] },
          });
        };
        const peer = yield* testPeer((cmd, emit) =>
          Effect.gen(function* () {
            if (cmd.type === "get_entries") {
              return yield* answer(cmd, emit, {
                entries,
                leafId: entries.at(-1)?.id ?? null,
              });
            }
            if (cmd.type === "prompt") {
              ordinal++;
              append(`user-${ordinal}`, `expanded: ${String(cmd.message)}`);
              append(`hidden-${ordinal}`, "extension instruction");
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              return;
            }
            if (cmd.type === "steer") append("steer-1", String(cmd.message));
            return yield* basicHandler(cmd, emit);
          }),
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        const frames = yield* capture(runtime);
        yield* runtime.start;
        NodeAssert.equal(
          (yield* runtime.steer(turn("unused")).pipe(Effect.flip)).code,
          "not_running",
        );
        yield* runtime.startTurn(turn("t1"));
        yield* runtime.steer(turn("steer-not-a-turn"));
        NodeAssert.equal(
          (yield* runtime.restart("runtime-mode-change").pipe(Effect.flip)).code,
          "not_ready",
        );
        yield* peer.emit({ type: "agent_end", isTerminal: true });
        yield* awaitOutcomes(frames, 1);
        yield* runtime.startTurn(turn("t2"));
        yield* runtime.interrupt;
        yield* peer.emit({ type: "agent_end", isTerminal: true });
        const outcomes = yield* awaitOutcomes(frames, 2);
        NodeAssert.deepEqual(
          outcomes.map((event) => [event.turnId, event.state]),
          [
            ["t1", "completed"],
            ["t2", "interrupted"],
          ],
        );
        const cursor = yield* SubscriptionRef.get(runtime.cursor);
        NodeAssert.deepEqual(
          cursor.turnBoundaries.map((boundary) =>
            "userEntryId" in boundary ? boundary.userEntryId : boundary.kind,
          ),
          ["user-1", "user-2"],
        );
        NodeAssert.ok(peer.commands.some((cmd) => cmd.type === "get_entries"));
        NodeAssert.equal(peer.commands.filter((cmd) => cmd.type === "steer").length, 1);
        NodeAssert.equal(peer.commands.filter((cmd) => cmd.type === "abort").length, 1);
        yield* runtime.stop;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.live("restarts with the verified cursor and updated approval mode", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peers = [yield* testPeer(basicHandler), yield* testPeer(basicHandler)];
      const args: string[][] = [];
      let index = 0;
      const runtime = yield* make((cmd) =>
        Effect.sync(() => {
          NodeAssert.equal(cmd._tag, "StandardCommand");
          if (cmd._tag !== "StandardCommand") throw new Error("unexpected piped command");
          args.push([...cmd.args]);
          return peers[index++]!.handle;
        }),
      );
      yield* runtime.start;
      yield* runtime.setRuntimeMode("auto");
      NodeAssert.equal(args.length, 2);
      NodeAssert.equal(args[1]?.[args[1]!.indexOf("--session") + 1], sessionFile);
      NodeAssert.equal(args[1]?.[args[1]!.indexOf("--approval-mode") + 1], "yolo");
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
it.live(
  "fails one running turn on unexpected process exit and cancels pending UI and host requests",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const peer = yield* testPeer((cmd, emit) =>
          cmd.type === "prompt"
            ? answer(cmd, emit, { agentInvoked: true })
            : basicHandler(cmd, emit),
        );
        const runtime = yield* make(() => Effect.succeed(peer.handle));
        const frames = yield* capture(runtime);
        yield* runtime.start;
        yield* runtime.startTurn(turn("exit-turn"));
        yield* peer.emit({
          type: "extension_ui_request",
          id: "ui1",
          method: "select",
          title: "Approve",
        });
        yield* peer.finish("SIGKILL");
        const outcomes = yield* awaitOutcomes(frames, 1);
        NodeAssert.equal(outcomes[0]?.state, "failed");
        NodeAssert.equal(yield* SubscriptionRef.get(runtime.state), "failed");
        NodeAssert.ok(
          frames.some((frame) => frame.type === "t3.session.exited" && frame.recoverable === true),
        );
        NodeAssert.ok(
          frames.some((frame) => frame.method === "cancel" && frame.targetId === "ui1"),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.live("removes a dead adapter session after mock peer exit and resumes on the next send", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-test");
      const instanceId = ProviderInstanceId.make("neopi-exit-test");
      const adapterHandler = (cmd: Command, emit: Emitter) =>
        cmd.type === "get_state"
          ? answer(cmd, emit, {
              sessionId: "s1",
              sessionFile: `${root}/neopi/sessions/default/thread-test/session.jsonl`,
              messageCount: 0,
            })
          : cmd.type === "prompt"
            ? answer(cmd, emit, { agentInvoked: true })
            : basicHandler(cmd, emit);
      const peers = [yield* testPeer(adapterHandler), yield* testPeer(adapterHandler)];
      let launches = 0;
      const adapter = yield* makeNeoPiAdapter({
        settings: {
          enabled: true,
          binaryPath: "npi",
          profile: "",
          launchArgs: "",
          customModels: [],
        },
        instanceId,
        binary: "npi",
        cwd: "/tmp",
        t3Home: root,
        attachmentsDir: root,
        environment: {},
        spawn: () => Effect.succeed(peers[launches++]!.handle),
        discovery: yield* makeNeoPiDiscoveryHub(),
      });
      const events: Array<{ type: string; payload: unknown }> = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ).pipe(Effect.forkScoped);
      const sessionInput = {
        threadId,
        provider: ProviderDriverKind.make("neopi"),
        providerInstanceId: instanceId,
        cwd: "/tmp",
        runtimeMode: "approval-required" as const,
      };
      const first = yield* adapter.startSession(sessionInput);
      yield* adapter.sendTurn({ threadId, input: "before exit" });
      yield* peers[0]!.finish("SIGKILL");
      for (
        let attempt = 0;
        attempt < 200 &&
        !(
          events.some((event) => event.type === "session.exited") &&
          !(yield* adapter.hasSession(threadId))
        );
        attempt++
      )
        yield* Effect.sleep("5 millis");
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
      NodeAssert.ok(
        events.some(
          (event) =>
            event.type === "session.exited" &&
            (event.payload as { recoverable?: boolean; exitKind?: string }).recoverable === true &&
            (event.payload as { exitKind?: string }).exitKind === "error",
        ),
      );
      const resumed = yield* adapter.startSession({
        ...sessionInput,
        resumeCursor: first.resumeCursor,
      });
      NodeAssert.equal(resumed.status, "ready");
      yield* adapter.sendTurn({ threadId, input: "after exit" });
      NodeAssert.equal(launches, 2);
      yield* adapter.stopAll();
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("cancels pending UI and host work and kills a peer ignoring EOF and SIGTERM", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(basicHandler);
      const signals: AbortSignal[] = [];
      const runtime = yield* make(() => Effect.succeed(peer.handle), undefined, {
        definitions: [{ name: "preview", description: "preview", parameters: {} }],
        handle: (_call, signal) =>
          Effect.sync(() => {
            signals.push(signal);
          }).pipe(Effect.andThen(Effect.never)),
      });
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* peer.emit({
        type: "extension_ui_request",
        id: "select-pending",
        method: "select",
        title: "Approve?",
      });
      yield* peer.emit({
        type: "host_tool_call",
        id: "host-pending",
        toolCallId: "tc1",
        toolName: "preview",
        arguments: {},
      });
      for (
        let i = 0;
        i < 100 && (signals.length === 0 || !frames.some((frame) => frame.id === "select-pending"));
        i++
      )
        yield* Effect.sleep("5 millis");
      NodeAssert.equal(signals.length, 1);
      yield* runtime.stop;
      NodeAssert.equal(yield* SubscriptionRef.get(runtime.state), "stopped");
      NodeAssert.ok(peer.signals.includes("SIGKILL"));
      NodeAssert.equal(signals[0]?.aborted, true);
      NodeAssert.ok(
        frames.some((frame) => frame.method === "cancel" && frame.targetId === "select-pending"),
      );
      NodeAssert.ok(
        frames.some(
          (frame) => frame.type === "host_tool_cancel" && frame.targetId === "host-pending",
        ),
      );
      NodeAssert.ok(
        peer.commands.some(
          (cmd) =>
            cmd.type === "extension_ui_response" &&
            cmd.id === "select-pending" &&
            cmd.cancelled === true,
        ),
      );
      for (let i = 0; i < 100 && !frames.some((frame) => frame.type === "t3.session.exited"); i++)
        yield* Effect.sleep("5 millis");
      NodeAssert.ok(
        frames.some(
          (frame) =>
            frame.type === "t3.session.exited" &&
            frame.recoverable === false &&
            frame.signal === "SIGKILL",
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
it.live(
  "defers a running mode change until the following turn and classifies streamed errors",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let ordinal = 0;
        const handler = (cmd: Command, emit: Emitter) =>
          Effect.gen(function* () {
            if (cmd.type === "get_entries")
              return yield* answer(cmd, emit, {
                entries: [
                  {
                    id: `user-${ordinal}`,
                    type: "message",
                    message: { role: "user", content: [{ type: "text", text: "hello" }] },
                  },
                ],
                leafId: `leaf-${ordinal}`,
              });
            if (cmd.type === "prompt") {
              ordinal++;
              yield* answer(cmd, emit, { agentInvoked: true });
              yield* emit({ type: "agent_start" });
              return;
            }
            yield* basicHandler(cmd, emit);
          });
        const peers = [yield* testPeer(handler), yield* testPeer(handler)];
        const args: string[][] = [];
        let index = 0;
        const runtime = yield* make((cmd) =>
          Effect.sync(() => {
            NodeAssert.equal(cmd._tag, "StandardCommand");
            if (cmd._tag !== "StandardCommand") throw new Error("unexpected piped command");
            args.push([...cmd.args]);
            return peers[index++]!.handle;
          }),
        );
        const frames = yield* capture(runtime);
        yield* runtime.start;
        yield* runtime.startTurn(turn("first"));
        const deferred = yield* runtime.setRuntimeMode("full-access").pipe(Effect.flip);
        NodeAssert.equal(deferred.code, "runtime_mode_deferred");
        NodeAssert.ok(deferred.message.includes("takes effect after the current turn"));
        yield* peers[0]!.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "error",
            reason: "error",
            error: { errorMessage: "upstream failed" },
          },
        });
        yield* peers[0]!.emit({ type: "agent_end", isTerminal: true });
        NodeAssert.equal((yield* awaitOutcomes(frames, 1))[0]?.state, "failed");
        yield* runtime.startTurn(turn("second"));
        NodeAssert.equal(args.length, 2);
        NodeAssert.equal(args[1]?.[args[1]!.indexOf("--approval-mode") + 1], "yolo");
        yield* peers[1]!.emit({
          type: "message_update",
          assistantMessageEvent: { type: "error", reason: "aborted", error: {} },
        });
        yield* peers[1]!.emit({ type: "agent_end", isTerminal: true });
        NodeAssert.equal((yield* awaitOutcomes(frames, 2))[1]?.state, "interrupted");
        yield* runtime.stop;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("treats recovered nonterminal errors as a successful original turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer((cmd, emit) =>
        cmd.type === "prompt"
          ? answer(cmd, emit, { agentInvoked: true }).pipe(
              Effect.andThen(emit({ type: "agent_start" })),
            )
          : basicHandler(cmd, emit),
      );
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      const frames = yield* capture(runtime);
      yield* runtime.start;
      yield* runtime.startTurn(turn("retry-success"));
      yield* peer.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "error",
          reason: "error",
          error: { errorMessage: "temporary provider failure" },
        },
      });
      yield* peer.emit({ type: "agent_end", isTerminal: false });
      yield* peer.emit({ type: "agent_start" });
      yield* peer.emit({ type: "message_start", message: { role: "assistant" } });
      yield* peer.emit({
        type: "agent_end",
        isTerminal: true,
        messages: [{ role: "assistant", stopReason: "stop" }],
      });
      const outcomes = yield* awaitOutcomes(frames, 1);
      NodeAssert.equal(outcomes[0]?.state, "completed");
      NodeAssert.equal(outcomes[0]?.errorMessage, undefined);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("answers first-session startup UI through ProviderService before v2 negotiation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let negotiateId: string | undefined;
      const peer = yield* testPeer(
        (cmd, emit) => {
          if (cmd.type === "negotiate_protocol") {
            negotiateId = cmd.id;
            return emit({
              type: "extension_ui_request",
              id: "startup-input",
              method: "confirm",
              title: "Enable extension?",
              message: "Continue?",
            });
          }
          if (cmd.type === "extension_ui_response" && negotiateId)
            return answer({ type: "negotiate_protocol", id: negotiateId }, emit, {
              protocolVersion: 2,
            });
          if (cmd.type === "get_state")
            return answer(cmd, emit, {
              sessionId: "s1",
              sessionFile: `${root}/neopi/sessions/default/thread-test/session.jsonl`,
              messageCount: 0,
            });
          return answer(cmd, emit);
        },
        {
          type: "ready",
          protocolVersion: 1,
          supportedProtocolVersions: [2],
          capabilities: ["rpc-ui"],
        },
      );
      const threadId = ThreadId.make("thread-test");
      const adapter = yield* makeNeoPiAdapter({
        settings: {
          enabled: true,
          binaryPath: "npi",
          profile: "",
          launchArgs: "",
          customModels: [],
        },
        instanceId: ProviderInstanceId.make("neopi"),
        binary: "npi",
        cwd: "/tmp",
        t3Home: root,
        attachmentsDir: root,
        environment: {},
        spawn: () => Effect.succeed(peer.handle),
        discovery: yield* makeNeoPiDiscoveryHub(),
      });
      const provider = ProviderDriverKind.make("neopi");
      const instanceId = ProviderInstanceId.make("neopi");
      const projectId = ProjectId.make("neopi-startup-test-project");
      const harness = yield* makeOrchestrationIntegrationHarness({ provider, adapter });
      yield* Effect.addFinalizer(() => harness.dispose);
      const createdAt = "2026-09-27T00:00:00.000Z";
      yield* harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("neopi-startup-project-create"),
        projectId,
        title: "NeoPi startup",
        workspaceRoot: harness.workspaceDir,
        defaultModelSelection: { instanceId, model: "neopi-current" },
        createdAt,
      });
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("neopi-startup-thread-create"),
        threadId,
        projectId,
        title: "Startup UI",
        modelSelection: { instanceId, model: "neopi-current" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: harness.workspaceDir,
        createdAt,
      });
      yield* Stream.runForEach(harness.providerService.streamEvents, (event) =>
        event.type === "user-input.requested"
          ? harness.providerService.respondToUserInput({
              threadId,
              requestId: ApprovalRequestId.make(event.requestId!),
              answers: { "startup-input": "true" },
            })
          : Effect.void,
      ).pipe(Effect.forkScoped);
      const session = yield* harness.providerService
        .startSession(threadId, {
          threadId,
          provider,
          providerInstanceId: instanceId,
          cwd: harness.workspaceDir,
          runtimeMode: "approval-required",
        })
        .pipe(Effect.timeout("5 seconds"));
      NodeAssert.equal(session.status, "ready");
      NodeAssert.ok(
        peer.commands.some((cmd) => cmd.type === "extension_ui_response" && cmd.confirmed === true),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("installs host tools without credential frames and suppresses cancelled results", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(basicHandler);
      const signals: AbortSignal[] = [];
      const runtime = yield* make(() => Effect.succeed(peer.handle), undefined, {
        definitions: [
          {
            name: "list_thread_pull_requests",
            description: "List PRs",
            parameters: { type: "object" },
            loadMode: "discoverable",
          },
        ],
        handle: (_call, signal) =>
          Effect.sync(() => {
            signals.push(signal);
          }).pipe(Effect.andThen(Effect.never)),
      });
      yield* runtime.start;
      NodeAssert.deepEqual(
        peer.commands.find((command) => command.type === "set_host_tools")?.tools,
        [
          {
            name: "list_thread_pull_requests",
            description: "List PRs",
            parameters: { type: "object" },
            loadMode: "discoverable",
          },
        ],
      );
      NodeAssert.equal(encodeCommand(peer.commands).includes("Bearer "), false);
      yield* peer.emit({
        type: "host_tool_call",
        id: "host-cancelled",
        toolCallId: "tool-cancelled",
        toolName: "list_thread_pull_requests",
        arguments: {},
      });
      for (let count = 0; count < 100 && signals.length === 0; count++)
        yield* Effect.sleep("5 millis");
      NodeAssert.equal(signals.length, 1);
      yield* peer.emit({
        type: "host_tool_cancel",
        id: "cancel-frame",
        targetId: "host-cancelled",
      });
      for (let count = 0; count < 100 && signals[0]?.aborted !== true; count++)
        yield* Effect.sleep("5 millis");
      NodeAssert.equal(signals[0]?.aborted, true);
      NodeAssert.equal(
        peer.commands.some((cmd) => cmd.type === "host_tool_result" && cmd.id === "host-cancelled"),
        false,
      );
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("answers unexpected host calls with an explicit error when no bridge is installed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* testPeer(basicHandler);
      const runtime = yield* make(() => Effect.succeed(peer.handle));
      yield* runtime.start;
      yield* peer.emit({
        type: "host_tool_call",
        id: "unsupported-call",
        toolCallId: "tool-1",
        toolName: "unknown_host_tool",
        arguments: {},
      });
      for (
        let count = 0;
        count < 100 && !peer.commands.some((cmd) => cmd.type === "host_tool_result");
        count++
      )
        yield* Effect.sleep("5 millis");
      const result = peer.commands.find((cmd) => cmd.type === "host_tool_result");
      NodeAssert.equal(result?.id, "unsupported-call");
      NodeAssert.equal(result?.isError, true);
      NodeAssert.match(encodeCommand(result), /Unsupported host tool/);
      yield* runtime.stop;
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "routes capability-gated chat changes to RPC and exposes mode through adapter activities",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let mode: "off" | "chat" | "erp" | "raw" = "off";
        const peer = yield* testPeer(
          (cmd, emit) => {
            if (cmd.type === "get_entries") return answer(cmd, emit, { entries: [], leafId: null });
            if (cmd.type === "get_messages_page") return answer(cmd, emit, { messages: [] });
            if (cmd.type === "negotiate_protocol") return answer(cmd, emit, { protocolVersion: 2 });
            if (cmd.type === "get_state")
              return answer(cmd, emit, {
                sessionId: "s1",
                sessionFile: `${root}/neopi/sessions/default/thread-test/session.jsonl`,
                messageCount: 0,
                chatMode: mode,
              });
            if (cmd.type === "set_chat_mode") {
              if (
                cmd.mode === "off" ||
                cmd.mode === "chat" ||
                cmd.mode === "erp" ||
                cmd.mode === "raw"
              )
                mode = cmd.mode;
              return answer(cmd, emit, { mode }).pipe(
                Effect.andThen(emit({ type: "chat_mode_changed", mode })),
              );
            }
            return answer(cmd, emit);
          },
          {
            type: "ready",
            protocolVersion: 1,
            supportedProtocolVersions: [2],
            capabilities: ["rpc-ui", "set_chat_mode"],
          },
        );
        const threadId = ThreadId.make("thread-test");
        const adapter = yield* makeNeoPiAdapter({
          settings: {
            enabled: true,
            binaryPath: "npi",
            profile: "",
            launchArgs: "",
            customModels: [],
          },
          instanceId: ProviderInstanceId.make("neopi-chat-test"),
          binary: "npi",
          cwd: "/tmp",
          t3Home: root,
          attachmentsDir: root,
          environment: {},
          spawn: () => Effect.succeed(peer.handle),
          discovery: yield* makeNeoPiDiscoveryHub(),
        });
        const warnings: unknown[] = [];
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            if (event.type === "runtime.warning") warnings.push(event.payload.detail);
          }),
        ).pipe(Effect.forkScoped);
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("neopi"),
          providerInstanceId: ProviderInstanceId.make("neopi-chat-test"),
          cwd: "/tmp",
          runtimeMode: "approval-required",
        });
        yield* adapter.sendTurn({ threadId, input: "/chat erp" });
        NodeAssert.equal(mode, "erp");
        yield* adapter.sendTurn({ threadId, input: "/chat" });
        NodeAssert.equal(mode, "off");
        yield* adapter.sendTurn({ threadId, input: "/chat" });
        NodeAssert.equal(mode, "erp");
        NodeAssert.deepEqual(
          peer.commands.filter((cmd) => cmd.type === "set_chat_mode").map((cmd) => cmd.mode),
          ["erp", "off", "erp"],
        );
        NodeAssert.equal(
          peer.commands.some((cmd) => cmd.type === "prompt"),
          false,
        );
        const cursorBefore = (yield* adapter.listSessions())[0]?.resumeCursor as NeoPiResumeCursor;
        NodeAssert.deepEqual(
          cursorBefore.turnBoundaries.map((boundary) =>
            "kind" in boundary ? boundary.kind : boundary.userEntryId,
          ),
          ["local", "local", "local"],
        );
        yield* adapter.rollbackThread(threadId, 1);
        const cursorAfter = (yield* adapter.listSessions())[0]?.resumeCursor as NeoPiResumeCursor;
        NodeAssert.equal(cursorAfter.turnBoundaries.length, 2);
        NodeAssert.equal(
          peer.commands.some((cmd) => cmd.type === "branch"),
          false,
        );
        for (let count = 0; count < 100 && warnings.length < 2; count++)
          yield* Effect.sleep("5 millis");
        NodeAssert.ok(
          warnings.some((detail) => JSON.stringify(detail).includes('\"mode\":\"erp\"')),
        );
        yield* adapter.stopAll();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
