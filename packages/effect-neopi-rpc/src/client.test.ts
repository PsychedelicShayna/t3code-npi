import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as Client from "./client.ts";
import { NeoPiRpcError } from "./errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const v2Ready = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
  capabilities: ["rpc-ui"],
};

const v1Ready = {
  type: "ready",
  protocolVersion: 1,
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 64 * 1024 * 1024,
};

interface CapturedCommand {
  readonly id?: string;
  readonly type?: string;
  readonly [key: string]: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asCommand = (value: unknown): CapturedCommand | undefined =>
  isRecord(value) ? value : undefined;

const scriptedPeer = Effect.fn("scriptedPeer")(function* (input: {
  readonly ready?: Record<string, unknown>;
  /** Leave stderr open after exit, as a descendant inheriting the pipe would. */
  readonly holdStderr?: boolean;
  readonly onLine: (
    message: CapturedCommand,
    emit: (frame: unknown) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
}) {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const stderr = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const captured = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const exitGate = yield* Deferred.make<{ code: number | null; signal: string | null }>();
  const signals: Array<string> = [];

  const emit = (frame: unknown): Effect.Effect<void> =>
    encodeJson(frame).pipe(
      Effect.orDie,
      Effect.flatMap((line) => Queue.offer(stdout, encoder.encode(`${line}\n`))),
      Effect.asVoid,
    );

  const finish = (status: { code: number | null; signal: string | null }) =>
    Effect.gen(function* () {
      yield* Queue.end(stdout).pipe(Effect.ignore);
      if (!input.holdStderr) yield* Queue.end(stderr).pipe(Effect.ignore);
      yield* Deferred.succeed(exitGate, status).pipe(Effect.ignore);
    });

  const exitProcess = (status: { code: number | null; signal: string | null }) =>
    Deferred.succeed(exitGate, status).pipe(Effect.ignore);

  if (input.ready) yield* emit(input.ready);
  yield* Effect.gen(function* () {
    let pending = "";
    while (true) {
      const chunk = yield* Queue.take(stdin);
      pending += decoder.decode(chunk);
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        if (line.trim().length === 0) {
          continue;
        }
        const parsed = asCommand(yield* decodeJson(line));
        if (parsed) {
          yield* input.onLine(parsed, emit);
        }
      }
    }
  }).pipe(Effect.ignore, Effect.forkScoped);

  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(41),
    exitCode: Deferred.await(exitGate).pipe(
      Effect.flatMap((status) =>
        status.signal === null
          ? Effect.succeed(ChildProcessSpawner.ExitCode(status.code ?? 0))
          : Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "exitCode",
                cause: new Error(
                  `Process interrupted due to receipt of signal: '${status.signal}'`,
                ),
              }),
            ),
      ),
    ),
    isRunning: Deferred.isDone(exitGate).pipe(Effect.map((done) => !done)),
    kill: (options) =>
      Effect.gen(function* () {
        signals.push(options?.killSignal ?? "SIGTERM");
        if (options?.forceKillAfter !== undefined) {
          yield* Effect.sleep(options.forceKillAfter);
          signals.push("SIGKILL");
          yield* finish({ code: null, signal: "SIGKILL" });
          return;
        }
        yield* finish({ code: null, signal: options?.killSignal ?? "SIGTERM" });
      }),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Queue.offer(stdin, chunk).pipe(Effect.andThen(Queue.offer(captured, chunk))),
    ),
    stdout: Stream.fromQueue(stdout),
    stderr: Stream.fromQueue(stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

  return {
    handle,
    emit,
    finish,
    exitProcess,
    endStdout: Queue.end(stdout),
    writeStderr: (text: string) => Queue.offer(stderr, encoder.encode(text)).pipe(Effect.asVoid),
    signals,
    stdin: captured,
  };
});

const makeClient = (
  peer: { readonly handle: ChildProcessSpawner.ChildProcessHandle },
  requestTimeoutMs = 2_000,
) =>
  Effect.gen(function* () {
    const client = yield* Client.make({
      spawn: () => Effect.succeed(peer.handle),
      command: "npi",
      args: ["--mode", "rpc-ui"],
      cwd: "/tmp",
      env: {},
      requestTimeoutMs,
    });
    yield* Effect.addFinalizer(() => client.close(20));
    return client;
  });

const negotiate = (
  message: CapturedCommand,
  emit: (frame: unknown) => Effect.Effect<void>,
): Effect.Effect<boolean> => {
  if (message.type !== "negotiate_protocol") {
    return Effect.succeed(false);
  }
  return emit({
    id: message.id,
    type: "response",
    command: "negotiate_protocol",
    success: true,
    data: { protocolVersion: 2 },
  }).pipe(Effect.as(true));
};

const readLines = (chunks: Queue.Dequeue<Uint8Array, Cause.Done<void>>, count: number) =>
  Effect.gen(function* () {
    const lines: Array<string> = [];
    let pending = "";
    while (lines.length < count) {
      pending += decoder.decode(yield* Queue.take(chunks));
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        lines.push(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
    const parsed: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      const value = asCommand(yield* decodeJson(line));
      if (value) {
        parsed.push(value);
      }
    }
    return parsed;
  });

it.live("negotiates v2 and records the capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({
        ready: v2Ready,
        onLine: (message, emit) => negotiate(message, emit).pipe(Effect.asVoid),
      });
      const client = yield* makeClient(peer);
      assert.equal(client.capabilities.has("v2"), true);
      assert.equal(client.capabilities.has("rpc-ui"), true);
      assert.equal(client.ready.protocolVersion, 1);
    }),
  ),
);

it.live("rejects unsupported ready versions and incorrect v2 acknowledgements", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const ready of [{ ...v2Ready, protocolVersion: 42 }, v2Ready]) {
        const peer = yield* scriptedPeer({
          ready,
          onLine: (message, emit) =>
            message.type === "negotiate_protocol"
              ? emit({
                  id: message.id,
                  type: "response",
                  command: message.type,
                  success: true,
                  data: { protocolVersion: 1 },
                })
              : Effect.void,
        });
        const error = yield* makeClient(peer).pipe(Effect.flip);
        assert.equal(error.code, "bad_frame");
      }
    }),
  ),
);

it.live("sends a one-way approval response without waiting for a reply", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* Deferred.make<CapturedCommand>();
      const peer = yield* scriptedPeer({
        ready: v2Ready,
        onLine: (message, emit) =>
          negotiate(message, emit).pipe(
            Effect.flatMap((handled) =>
              handled
                ? Effect.void
                : message.type === "tool_approval_response"
                  ? Deferred.succeed(received, message).pipe(Effect.asVoid)
                  : emit({
                      id: message.id,
                      type: "response",
                      command: message.type,
                      success: true,
                      data: { ok: true },
                    }),
            ),
          ),
      });
      const client = yield* makeClient(peer);
      yield* client.writeFrame({
        type: "tool_approval_response",
        id: "approval-1",
        decision: "allow_once",
      });
      assert.deepEqual(yield* Deferred.await(received), {
        type: "tool_approval_response",
        id: "approval-1",
        decision: "allow_once",
      });
      assert.deepEqual(yield* client.request({ type: "get_state" }), { ok: true });
    }),
  ),
);

it.live("escalates close from SIGTERM to SIGKILL", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({
        ready: v2Ready,
        onLine: (message, emit) => negotiate(message, emit).pipe(Effect.asVoid),
      });
      const client = yield* makeClient(peer);
      yield* client.close(20);
      assert.deepEqual(peer.signals, ["SIGTERM", "SIGKILL"]);
    }),
  ),
);

it.live("stays on v1 and rejects rpc_chunk as bad_chunk", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({
        ready: v1Ready,
        onLine: (message, emit) =>
          emit({
            type: "rpc_chunk",
            chunkId: "v1",
            index: 0,
            count: 2,
            byteLength: 2,
            data: "e30=",
          }).pipe(
            Effect.andThen(
              emit({
                id: message.id,
                type: "response",
                command: message.type,
                success: true,
                data: {},
              }),
            ),
          ),
      });
      const client = yield* makeClient(peer);
      assert.equal(client.capabilities.has("v2"), false);
      yield* client.request({ type: "get_state" }).pipe(
        Effect.match({
          onFailure: (error) => {
            assert.instanceOf(error, NeoPiRpcError);
            assert.equal(error.code, "bad_chunk");
          },
          onSuccess: () => {
            assert.equal(true, false);
          },
        }),
      );
    }),
  ),
);

it.live("resolves out-of-order responses and a late prompt rejection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commands = yield* Queue.unbounded<CapturedCommand>();
      const peer = yield* scriptedPeer({
        ready: v2Ready,
        onLine: (message, emit) =>
          negotiate(message, emit).pipe(
            Effect.flatMap((handled) => (handled ? Effect.void : Queue.offer(commands, message))),
          ),
      });
      const client = yield* makeClient(peer);
      const first = yield* Effect.forkChild(client.request({ type: "get_state" }));
      const second = yield* Effect.forkChild(client.request({ type: "get_entries" }));
      const left = yield* Queue.take(commands);
      const right = yield* Queue.take(commands);
      yield* peer.emit({
        id: right.id,
        type: "response",
        command: "get_entries",
        success: true,
        data: { which: "right" },
      });
      yield* peer.emit({
        id: left.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { which: "left" },
      });
      assert.deepEqual(yield* Fiber.join(first), { which: "left" });
      assert.deepEqual(yield* Fiber.join(second), { which: "right" });

      const handle = yield* client.prompt({ type: "prompt", message: "later" });
      const prompt = yield* Queue.take(commands);
      yield* peer.emit({
        id: prompt.id,
        type: "response",
        command: "prompt",
        success: true,
      });
      yield* peer.emit({
        id: prompt.id,
        type: "response",
        command: "prompt",
        success: false,
        error: "scheduling failed",
        code: "prompt_failed",
      });
      assert.deepEqual(yield* Deferred.await(handle.outcome), {
        kind: "rejected",
        error: "scheduling failed",
        code: "prompt_failed",
      });
    }),
  ),
);

it.live("delivers a late failure for an already admitted prompt in event order", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commands = yield* Queue.unbounded<CapturedCommand>();
      const peer = yield* scriptedPeer({
        ready: v2Ready,
        onLine: (message, emit) =>
          negotiate(message, emit).pipe(
            Effect.flatMap((handled) => (handled ? Effect.void : Queue.offer(commands, message))),
          ),
      });
      const client = yield* makeClient(peer);
      const received = yield* Queue.unbounded<Client.SessionEventFrame>();
      yield* Stream.runForEach(client.events, (frame) => Queue.offer(received, frame)).pipe(
        Effect.forkScoped,
      );
      const handle = yield* client.prompt({ type: "prompt", message: "say hi" });
      const prompt = yield* Queue.take(commands);
      yield* peer.emit({
        id: prompt.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { agentInvoked: true },
      });
      yield* peer.emit({ type: "agent_start" });
      assert.deepEqual(yield* Deferred.await(handle.outcome), { kind: "agent" });
      yield* peer.emit({
        id: prompt.id,
        type: "response",
        command: "prompt",
        success: false,
        error: "late upstream rejection",
      });
      assert.equal((yield* Queue.take(received)).type, "agent_start");
      assert.deepEqual(yield* Queue.take(received), {
        type: "t3.prompt.failed",
        id: prompt.id,
        error: "late upstream rejection",
        code: undefined,
      });
    }),
  ),
);

it.live("fails admitted work and kills a peer that sends a malformed chunk", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commands = yield* Queue.unbounded<CapturedCommand>();
      const peer = yield* scriptedPeer({
        ready: v2Ready,
        onLine: (message, emit) =>
          negotiate(message, emit).pipe(
            Effect.flatMap((handled) => (handled ? Effect.void : Queue.offer(commands, message))),
          ),
      });
      const client = yield* makeClient(peer);
      const frames = yield* Queue.unbounded<Client.SessionEventFrame>();
      yield* Stream.runForEach(client.events, (frame) => Queue.offer(frames, frame)).pipe(
        Effect.forkScoped,
      );
      const prompt = yield* client.prompt({ type: "prompt", message: "work" });
      const command = yield* Queue.take(commands);
      yield* peer.emit({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { agentInvoked: true },
      });
      yield* peer.emit({ type: "agent_start" });
      assert.deepEqual(yield* Deferred.await(prompt.outcome), { kind: "agent" });
      yield* peer.emit({
        type: "rpc_chunk",
        chunkId: "bad",
        index: 3,
        count: 1,
        byteLength: 1,
        data: "YQ==",
      });
      assert.equal((yield* Queue.take(frames)).type, "agent_start");
      const fault = yield* Queue.take(frames);
      assert.equal(fault.type, "t3.prompt.failed");
      assert.equal(fault.code, "bad_chunk");
      yield* Deferred.await(client.exit);
      assert.ok(peer.signals.includes("SIGTERM"));
    }),
  ),
);

it.live("resolves local exactly once and agent after ack", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commands = yield* Queue.unbounded<CapturedCommand>();
      const peer = yield* scriptedPeer({
        ready: v2Ready,
        onLine: (message, emit) =>
          negotiate(message, emit).pipe(
            Effect.flatMap((handled) => (handled ? Effect.void : Queue.offer(commands, message))),
          ),
      });
      const client = yield* makeClient(peer);

      const local = yield* client.prompt({ type: "prompt", message: "/help" });
      const localCommand = yield* Queue.take(commands);
      yield* peer.emit({
        id: localCommand.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { agentInvoked: false },
      });
      yield* peer.emit({
        type: "prompt_result",
        id: localCommand.id,
        agentInvoked: false,
      });
      assert.deepEqual(yield* Deferred.await(local.outcome), {
        kind: "local",
        agentInvoked: false,
      });

      const fromResult = yield* client.prompt({ type: "prompt", message: "/local" });
      const resultCommand = yield* Queue.take(commands);
      yield* peer.emit({
        id: resultCommand.id,
        type: "response",
        command: "prompt",
        success: true,
      });
      yield* peer.emit({
        type: "prompt_result",
        id: resultCommand.id,
        agentInvoked: false,
      });
      assert.deepEqual(yield* Deferred.await(fromResult.outcome), {
        kind: "local",
        agentInvoked: false,
      });

      const agent = yield* client.prompt({ type: "prompt", message: "say hi" });
      const agentCommand = yield* Queue.take(commands);
      yield* peer.emit({
        id: agentCommand.id,
        type: "response",
        command: "prompt",
        success: true,
      });
      yield* peer.emit({ type: "agent_start" });
      assert.deepEqual(yield* Deferred.await(agent.outcome), { kind: "agent" });
    }),
  ),
);

it.live("routes side channels and writes single-line host replies", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({
        ready: v2Ready,
        onLine: (message, emit) => {
          if (message.type !== "negotiate_protocol") {
            return Effect.void;
          }
          return emit({
            type: "host_uri_request",
            id: "uri-1",
            operation: "read",
            url: "skill://redacted",
          }).pipe(Effect.andThen(negotiate(message, emit)));
        },
      });
      const client = yield* makeClient(peer);
      const ui = yield* Queue.unbounded<{ id: string }>();
      const tools = yield* Queue.unbounded<{ id: string }>();
      const uris = yield* Queue.unbounded<{ id: string }>();
      yield* Stream.runForEach(client.uiRequests, (frame) => Queue.offer(ui, frame)).pipe(
        Effect.forkScoped,
      );
      yield* Stream.runForEach(client.hostToolCalls, (frame) => Queue.offer(tools, frame)).pipe(
        Effect.forkScoped,
      );
      yield* Stream.runForEach(client.hostUriRequests, (frame) => Queue.offer(uris, frame)).pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;

      yield* peer.emit({
        type: "extension_ui_request",
        id: "ui-1",
        method: "confirm",
        title: "Allow?",
      });
      yield* peer.emit({
        type: "host_tool_call",
        id: "tool-1",
        toolCallId: "call-1",
        toolName: "preview",
        arguments: { path: "redacted-path" },
      });
      yield* peer.emit({
        type: "host_uri_request",
        id: "uri-2",
        operation: "read",
        url: "skill://other",
      });

      const uiFrame = yield* Queue.take(ui);
      const toolFrame = yield* Queue.take(tools);
      assert.equal(uiFrame.id, "ui-1");
      assert.equal(toolFrame.id, "tool-1");
      const handledUri = yield* Queue.take(uris);
      assert.equal(handledUri.id, "uri-2");

      yield* client.respondUi({ id: "ui-1", confirmed: true });
      yield* client.hostToolResult("tool-1", {
        content: [{ type: "text", text: "ok" }],
      });

      const parsed = yield* readLines(peer.stdin, 4).pipe(
        Effect.timeout("2 seconds"),
        Effect.orDie,
      );
      const uriError = parsed.find(
        (frame) => frame.type === "host_uri_result" && frame.id === "uri-1",
      );
      assert.equal(uriError?.isError, true);
      assert.equal(uriError?.error, "unsupported");
      const uiReply = parsed.find((frame) => frame.type === "extension_ui_response");
      assert.equal(uiReply?.id, "ui-1");
      assert.equal(uiReply?.confirmed, true);
      const toolReply = parsed.find((frame) => frame.type === "host_tool_result");
      assert.equal(toolReply?.id, "tool-1");
    }),
  ),
);

it.live("bounds the whole transport handshake even when the hook waits for ready", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({ onLine: () => Effect.void });
      const error = yield* Effect.flip(
        Client.make({
          spawn: () => Effect.succeed(peer.handle),
          command: "npi",
          args: ["--mode", "rpc-ui"],
          cwd: "/tmp",
          env: {},
          requestTimeoutMs: 40,
          onTransportReady: (transport) => transport.transportReady.pipe(Effect.ignore),
        }),
      );
      assert.equal(error.code, "timeout");
      yield* Effect.gen(function* () {
        while (!peer.signals.includes("SIGTERM")) yield* Effect.sleep("10 millis");
      }).pipe(Effect.timeout("1 second"));
    }),
  ),
);

it.live("fails ready immediately when the peer exits without sending a ready frame", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({ onLine: () => Effect.void });
      yield* peer.finish({ code: 1, signal: null });
      const error = yield* Effect.flip(
        Client.make({
          spawn: () => Effect.succeed(peer.handle),
          command: "npi",
          args: ["--mode", "rpc-ui"],
          cwd: "/tmp",
          env: {},
          requestTimeoutMs: 2_000,
          onTransportReady: (transport) => transport.transportReady.pipe(Effect.ignore),
        }),
      );
      assert.equal(error.code, "exited");
    }),
  ),
);

it.live("surfaces a leased-session startup failure with its file and owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({ onLine: () => Effect.void });
      yield* peer.writeStderr(
        '{"type":"startup_error","code":"session_in_use","pid":42,"sessionFile":"/tmp/busy.jsonl"}\n',
      );
      yield* peer.finish({ code: 1, signal: null });
      const error = yield* Effect.flip(
        Client.make({
          spawn: () => Effect.succeed(peer.handle),
          command: "npi",
          args: ["--mode", "rpc-ui", "--session", "/tmp/busy.jsonl"],
          cwd: "/tmp",
          env: {},
          requestTimeoutMs: 2_000,
        }),
      );
      assert.equal(error.code, "session_in_use");
      assert.match(error.message, /already in use.*busy\.jsonl.*PID 42/);
    }),
  ),
);

it.live("fails ready when stdout ends but the process remains alive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({ onLine: () => Effect.void });
      yield* peer.endStdout;
      const error = yield* Effect.flip(
        Client.make({
          spawn: () => Effect.succeed(peer.handle),
          command: "npi",
          args: ["--mode", "rpc-ui"],
          cwd: "/tmp",
          env: {},
          requestTimeoutMs: 2_000,
          onTransportReady: (transport) => transport.transportReady.pipe(Effect.ignore),
        }),
      );
      assert.equal(error.code, "exited");
    }),
  ),
);

it.live("fails an admitted turn when stdout ends after ready while the process stays alive", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({
        ready: v1Ready,
        onLine: (message, emit) =>
          message.type === "prompt"
            ? emit({
                id: message.id,
                type: "response",
                command: "prompt",
                success: true,
                data: { agentInvoked: true },
              })
            : Effect.void,
      });
      const client = yield* makeClient(peer);
      const handle = yield* client.prompt({ type: "prompt", message: "hi" });
      const admitted = yield* Deferred.await(handle.outcome).pipe(Effect.timeout("2 seconds"));
      assert.equal(admitted.kind, "agent");
      const pending = yield* Effect.forkChild(client.request({ type: "get_state" }));
      yield* Effect.yieldNow;
      yield* peer.endStdout;
      const outcome = yield* Fiber.join(pending).pipe(Effect.timeout("2 seconds"), Effect.result);
      assert.equal(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.equal(outcome.failure._tag, "NeoPiRpcError");
        if (outcome.failure._tag === "NeoPiRpcError") assert.equal(outcome.failure.code, "closed");
      }
      const exit = yield* Deferred.await(client.exit).pipe(Effect.timeout("2 seconds"));
      assert.equal(peer.signals.includes("SIGTERM"), true);
      assert.equal(exit.code === 0 && exit.signal === null, false);
    }),
  ),
);

it.live("completes close when a descendant keeps stderr open after the process exits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({
        ready: v1Ready,
        holdStderr: true,
        onLine: () => Effect.void,
      });
      const client = yield* Client.make({
        spawn: () => Effect.succeed(peer.handle),
        command: "npi",
        args: ["--mode", "rpc-ui"],
        cwd: "/tmp",
        env: {},
        requestTimeoutMs: 2_000,
      });
      yield* peer.writeStderr("held-by-descendant\n");
      yield* peer.exitProcess({ code: 0, signal: null });
      const exit = yield* Deferred.await(client.exit).pipe(Effect.timeout("2 seconds"));
      assert.equal(exit.code, 0);
      assert.equal(exit.stderrTail.includes("held-by-descendant"), true);
      yield* client.close(40).pipe(Effect.timeout("2 seconds"));
    }),
  ),
);

it.live("does not retain stderr written before any consumer subscribes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* scriptedPeer({
        ready: v1Ready,
        onLine: () => Effect.void,
      });
      const client = yield* makeClient(peer);
      for (let index = 0; index < 200; index++) {
        yield* peer.writeStderr(`early-${index}\n`);
      }
      yield* Effect.sleep("30 millis");
      const seen = yield* Queue.unbounded<string>();
      yield* Stream.runForEach(client.stderr, (text) => Queue.offer(seen, text)).pipe(
        Effect.forkScoped,
      );
      yield* Effect.sleep("20 millis");
      yield* peer.writeStderr("after-subscribe\n");
      const received: Array<string> = [];
      yield* Effect.gen(function* () {
        while (!received.some((text) => text.includes("after-subscribe"))) {
          received.push(yield* Queue.take(seen).pipe(Effect.timeout("1 second")));
        }
      });
      assert.equal(
        received.some((text) => text.includes("early-0")),
        false,
      );
      assert.equal(
        received.some((text) => text.includes("after-subscribe")),
        true,
      );
    }),
  ),
);

it.live("rejects malformed ready while accepting a startup UI response during negotiation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const malformed = yield* scriptedPeer({
        ready: { type: "ready", protocolVersion: 9 },
        onLine: () => Effect.void,
      });
      const bad = yield* Effect.flip(
        Client.make({
          spawn: () => Effect.succeed(malformed.handle),
          command: "npi",
          args: ["--mode", "rpc-ui"],
          cwd: "/tmp",
          env: {},
          requestTimeoutMs: 2_000,
        }),
      );
      assert.equal(bad.code, "bad_frame");

      const uiAnswered = yield* Deferred.make<void>();
      const peer = yield* scriptedPeer({
        ready: v2Ready,
        onLine: (cmd, emit) =>
          cmd.type === "extension_ui_response"
            ? Deferred.succeed(uiAnswered, undefined).pipe(Effect.asVoid)
            : negotiate(cmd, emit).pipe(Effect.asVoid),
      });
      yield* peer.emit({ type: "extension_ui_request", id: "startup-ui", method: "confirm" });
      const scope = yield* Effect.scope;
      const client = yield* Client.make({
        spawn: () => Effect.succeed(peer.handle),
        command: "npi",
        args: ["--mode", "rpc-ui"],
        cwd: "/tmp",
        env: {},
        requestTimeoutMs: 2_000,
        onTransportReady: (transport) =>
          Stream.runForEach(transport.uiRequests, (frame) =>
            transport.respondUi({ id: frame.id, confirmed: true }),
          ).pipe(Effect.forkIn(scope), Effect.asVoid),
      });
      yield* Effect.addFinalizer(() => client.close(20));
      assert.equal(client.capabilities.has("v2"), true);
      yield* Deferred.await(uiAnswered).pipe(Effect.timeout("2 seconds"));
    }),
  ),
);

const peerPath = new URL("../test/fixtures/neopi-mock-peer.ts", import.meta.url);

const spawnClient = (env: Record<string, string>, args: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const client = yield* Client.make({
      spawn: (command) => spawner.spawn(command),
      command: process.execPath,
      args: [peerPath.pathname, ...args],
      cwd: new URL("..", import.meta.url).pathname,
      env,
      requestTimeoutMs: 20_000,
    });
    yield* Effect.addFinalizer(() => client.close(50));
    return client;
  });

const withNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

it.live("replays the captured handshake", () =>
  withNode(
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = new URL("../test/fixtures/scenarios/handshake.json", import.meta.url);
        const client = yield* spawnClient({}, [scenario.pathname]);
        assert.equal(client.capabilities.has("v2"), true);
        assert.equal(client.ready.maxReassembledFrameBytes, 67_108_864);
      }),
    ),
  ),
);

it.live("writes a 2 MiB image prompt as one line and echoes its length", () =>
  withNode(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* spawnClient({ NEOPI_MOCK_MODE: "echo-image" });
        const image = "A".repeat(2 * 1024 * 1024);
        const data = yield* client.request({
          type: "prompt",
          message: "look",
          images: [{ data: image, mimeType: "image/png" }],
        });
        assert.deepEqual(data, { imageLength: image.length });
      }),
    ),
  ),
);

it.live("closes with EOF, drains stdout, then SIGTERM and SIGKILL", () =>
  withNode(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* spawnClient({ NEOPI_MOCK_MODE: "hang" });
        const seen = yield* Queue.unbounded<string>();
        yield* Stream.runForEach(client.events, (frame) =>
          Queue.offer(seen, `${frame.type}:${String(frame.message ?? "")}`),
        ).pipe(Effect.forkScoped);
        const pending = yield* Effect.forkScoped(client.request({ type: "get_state" }));
        yield* Effect.yieldNow;
        yield* client.close(200);
        yield* Fiber.join(pending).pipe(
          Effect.match({
            onFailure: (error) => {
              assert.equal(error.code, "closed");
            },
            onSuccess: () => {
              assert.equal(true, false);
            },
          }),
        );
        const exit = yield* Deferred.await(client.exit);
        assert.equal(exit.stderrTail.includes("neopi-rpc-tail"), true);
        const notices: Array<string> = [];
        yield* Effect.gen(function* () {
          while (true) {
            const next = yield* Queue.take(seen).pipe(Effect.timeout("50 millis"));
            notices.push(next);
          }
        }).pipe(Effect.ignore);
        assert.equal(notices.includes("notice:after-eof"), true);
        assert.equal(exit.code === 0 && exit.signal === null, false);
      }),
    ),
  ),
);
