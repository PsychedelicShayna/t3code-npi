import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import {
  emptyStderrTail,
  encodeFrameLine,
  endQueue,
  pushStderrTail,
  signalFromExitFailure,
  stderrTailText,
  stdoutLines,
} from "./_internal/stdio.ts";
import { NeoPiRpcError } from "./errors.ts";
import { MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, isRpcChunkFrame } from "./frame.ts";
import type {
  AgentToolResultWire,
  Frame,
  HostToolCallFrame,
  HostToolCancelFrame,
  HostUriRequestFrame,
  HostUriResultWire,
  PromptCommand,
  ReadyFrame,
  ResponseFrame,
  SessionEventFrame,
  UiRequestFrame,
  UiResponseWire,
} from "./schema.ts";
import { decodeFrameLine, isRecord } from "./schema.ts";

export type {
  AgentToolResultWire,
  Frame,
  HostToolCallFrame,
  HostToolCancelFrame,
  HostUriRequestFrame,
  HostUriResultWire,
  PromptCommand,
  ReadyFrame,
  ResponseFrame,
  SessionEventFrame,
  UiRequestFrame,
  UiResponseWire,
};

/** `ChildProcessSpawner` `spawn`, so T3 can pass `spawner.spawn` directly. */
export type SpawnFn = (
  command: ChildProcess.Command,
) => Effect.Effect<
  ChildProcessSpawner.ChildProcessHandle,
  PlatformError.PlatformError,
  Scope.Scope
>;

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_STDERR_TAIL_BYTES = 16 * 1024;
export const DEFAULT_CLOSE_GRACE_MS = 5_000;

export interface NeoPiRpcClientOptions {
  readonly spawn: SpawnFn;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** Applies to command/response only, not the prompt lifecycle. Default 30s. */
  readonly requestTimeoutMs?: number;
  readonly stderrTailBytes?: number;
  readonly onTransportReady?: (transport: NeoPiRpcTransport) => Effect.Effect<void>;
}

/** Streams and replies available immediately after stdio is connected, before ready negotiation. */
export type NeoPiRpcTransport = Pick<
  NeoPiRpcClient,
  | "events"
  | "uiRequests"
  | "respondUi"
  | "hostToolCalls"
  | "hostToolResult"
  | "hostUriRequests"
  | "hostUriResult"
  | "exit"
> & { readonly transportReady: Effect.Effect<ReadyFrame, NeoPiRpcError> };

export interface NeoPiRpcClient {
  readonly ready: ReadyFrame;
  readonly capabilities: ReadonlySet<string>;
  readonly request: <C extends { type: string }>(cmd: C) => Effect.Effect<unknown, NeoPiRpcError>;
  /** One-way protocol frame; unlike request, it has no response correlation. */
  readonly writeFrame: (frame: unknown) => Effect.Effect<void, NeoPiRpcError>;
  readonly prompt: (cmd: PromptCommand) => Effect.Effect<PromptHandle, NeoPiRpcError>;
  readonly events: Stream.Stream<SessionEventFrame>;
  readonly uiRequests: Stream.Stream<UiRequestFrame>;
  readonly respondUi: (response: UiResponseWire) => Effect.Effect<void, NeoPiRpcError>;
  readonly hostToolCalls: Stream.Stream<HostToolCallFrame | HostToolCancelFrame>;
  readonly hostToolUpdate: (
    id: string,
    partialResult: AgentToolResultWire,
  ) => Effect.Effect<void, NeoPiRpcError>;
  readonly hostToolResult: (
    id: string,
    result: AgentToolResultWire,
    isError?: boolean,
  ) => Effect.Effect<void, NeoPiRpcError>;
  readonly hostUriRequests: Stream.Stream<HostUriRequestFrame>;
  readonly hostUriResult: (result: HostUriResultWire) => Effect.Effect<void, NeoPiRpcError>;
  readonly stderr: Stream.Stream<string>;
  readonly exit: Deferred.Deferred<ProcessExit>;
  readonly close: (graceMs?: number) => Effect.Effect<void>;
}

export interface PromptHandle {
  readonly id: string;
  readonly outcome: Deferred.Deferred<PromptOutcome>;
}

export type PromptOutcome =
  | { readonly kind: "local"; readonly agentInvoked: false }
  | { readonly kind: "rejected"; readonly error: string; readonly code?: string }
  | { readonly kind: "agent" };

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;
}

interface PendingRequest {
  readonly command: string;
  readonly deferred: Deferred.Deferred<unknown, NeoPiRpcError>;
}

interface PromptRecord {
  readonly id: string;
  readonly outcome: Deferred.Deferred<PromptOutcome>;
  acked: boolean;
  sawAgentStart: boolean;
}

const unsupportedUriResult = (id: string): HostUriResultWire => ({
  type: "host_uri_result",
  id,
  isError: true,
  error: "unsupported",
});

export const make = Effect.fn("effect-neopi-rpc/NeoPiRpcClient.make")(function* (
  options: NeoPiRpcClientOptions,
) {
  const lifetime = yield* Effect.scope;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const stderrTailBytes = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
  const command = ChildProcess.make(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: true,
  });
  const handle = yield* options.spawn(command).pipe(
    Effect.mapError(
      (cause) =>
        new NeoPiRpcError({
          code: "spawn",
          message: `failed to spawn NeoPi/OMP (${options.command}): ${cause.message}`,
        }),
    ),
  );

  const outbound = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const events = yield* Queue.unbounded<SessionEventFrame, Cause.Done<void>>();
  const uiRequests = yield* Queue.unbounded<UiRequestFrame, Cause.Done<void>>();
  const hostToolCalls = yield* Queue.unbounded<
    HostToolCallFrame | HostToolCancelFrame,
    Cause.Done<void>
  >();
  const hostUriRequests = yield* Queue.unbounded<HostUriRequestFrame, Cause.Done<void>>();
  const stderr = yield* Queue.unbounded<string, Cause.Done<void>>();
  const exit = yield* Deferred.make<ProcessExit>();
  const readyDeferred = yield* Deferred.make<ReadyFrame, NeoPiRpcError>();

  const pending = new Map<string, PendingRequest>();
  const prompts = new Map<string, PromptRecord>();
  let nextRequestId = 0;
  let protocol: 1 | 2 = 1;
  let ceiling = MAX_RPC_REASSEMBLED_BYTES;
  let fatal: NeoPiRpcError | undefined;
  let closed = false;
  let uriListeners = 0;
  const stderrTail = emptyStderrTail();
  const decoder = { current: new RpcFrameDecoder(ceiling) };

  const failPending = (error: NeoPiRpcError): Effect.Effect<void> =>
    Effect.gen(function* () {
      fatal ??= error;
      for (const request of pending.values()) {
        yield* Deferred.fail(request.deferred, error).pipe(Effect.ignore);
      }
      pending.clear();
      for (const prompt of prompts.values()) {
        yield* Queue.offer(events, {
          type: "t3.prompt.failed",
          id: prompt.id,
          error: error.message,
          code: error.code,
        }).pipe(Effect.ignore);
        yield* completePrompt(prompt, {
          kind: "rejected",
          error: error.message,
          ...(error.code !== undefined ? { code: error.code } : {}),
        });
      }
      prompts.clear();
    });

  const writeFrame = (frame: unknown): Effect.Effect<void, NeoPiRpcError> =>
    Effect.gen(function* () {
      if (closed || fatal) {
        return yield* (
          fatal ??
            new NeoPiRpcError({
              code: "closed",
              message: "NeoPi/OMP RPC client is closed",
            })
        );
      }
      const offered = yield* Queue.offer(outbound, encodeFrameLine(frame)).pipe(
        Effect.mapError(
          () =>
            new NeoPiRpcError({
              code: "closed",
              message: "NeoPi/OMP stdin is closed",
            }),
        ),
      );
      if (!offered) {
        return yield* new NeoPiRpcError({
          code: "closed",
          message: "NeoPi/OMP stdin is closed",
        });
      }
    });

  const allocateId = (existing: unknown): string => {
    if (typeof existing === "string" && existing.length > 0) {
      return existing;
    }
    nextRequestId += 1;
    return `npi-${nextRequestId}`;
  };

  const request = <C extends { type: string }>(cmd: C): Effect.Effect<unknown, NeoPiRpcError> =>
    Effect.gen(function* () {
      if (fatal) {
        return yield* fatal;
      }
      if (closed) {
        return yield* new NeoPiRpcError({
          code: "closed",
          message: "NeoPi/OMP RPC client is closed",
          command: cmd.type,
        });
      }
      const id = allocateId(readCommandId(cmd));
      const deferred = yield* Deferred.make<unknown, NeoPiRpcError>();
      pending.set(id, { command: cmd.type, deferred });
      yield* writeFrame({ ...cmd, id }).pipe(
        Effect.tap(() => Effect.sync(() => {})),
        Effect.tapError(() =>
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
      );
      return yield* Deferred.await(deferred).pipe(
        Effect.timeout(Duration.millis(requestTimeoutMs)),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new NeoPiRpcError({
              code: "timeout",
              message: `timed out waiting for ${cmd.type}`,
              command: cmd.type,
            }),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
      );
    });

  const prompt = (cmd: PromptCommand): Effect.Effect<PromptHandle, NeoPiRpcError> =>
    Effect.gen(function* () {
      if (fatal) {
        return yield* fatal;
      }
      const id = allocateId(cmd.id);
      const outcome = yield* Deferred.make<PromptOutcome>();
      const record: PromptRecord = { id, outcome, acked: false, sawAgentStart: false };
      prompts.set(id, record);
      yield* writeFrame({ ...cmd, id, type: "prompt" }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            prompts.delete(id);
          }),
        ),
      );
      return { id, outcome } satisfies PromptHandle;
    });

  const onResponse = (frame: ResponseFrame): Effect.Effect<void> =>
    Effect.gen(function* () {
      const id = frame.id;
      if (id !== undefined) {
        const promptRecord = prompts.get(id);
        if (promptRecord) {
          yield* onPromptResponse(promptRecord, frame);
          return;
        }
        const requestRecord = pending.get(id);
        if (requestRecord) {
          pending.delete(id);
          if (frame.success) {
            yield* Deferred.succeed(requestRecord.deferred, frame.data).pipe(Effect.ignore);
          } else {
            yield* Deferred.fail(requestRecord.deferred, responseError(frame)).pipe(Effect.ignore);
          }
        }
      }
    });

  const onPromptResponse = (record: PromptRecord, frame: ResponseFrame): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!frame.success) {
        yield* completePrompt(record, {
          kind: "rejected",
          error: frame.error ?? "prompt rejected",
          ...(frame.code !== undefined ? { code: frame.code } : {}),
        });
        yield* Queue.offer(events, {
          type: "t3.prompt.failed",
          id: record.id,
          error: frame.error ?? "prompt rejected",
          code: frame.code,
        }).pipe(Effect.ignore);
        prompts.delete(record.id);
        return;
      }
      if (record.acked) {
        return;
      }
      record.acked = true;
      const agentInvoked = agentInvokedOf(frame.data);
      if (agentInvoked === false) {
        yield* completePrompt(record, { kind: "local", agentInvoked: false });
        yield* Queue.offer(events, { type: "t3.prompt.local", id: record.id }).pipe(Effect.ignore);
        prompts.delete(record.id);
        return;
      }
      if (agentInvoked === true || record.sawAgentStart) {
        yield* completePrompt(record, { kind: "agent" });
      }
    });

  const onAgentStart = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const open = oldestOpenPrompt();
      if (!open) {
        return;
      }
      if (open.acked) {
        yield* completePrompt(open, { kind: "agent" });
        return;
      }
      open.sawAgentStart = true;
    });

  const onPromptResult = (frame: SessionEventFrame): Effect.Effect<void> =>
    Effect.gen(function* () {
      const id = frame.id;
      if (typeof id !== "string") {
        return;
      }
      const record = prompts.get(id);
      if (!record) {
        return;
      }
      if (frame.agentInvoked === false) {
        yield* completePrompt(record, { kind: "local", agentInvoked: false });
        return;
      }
      if (frame.agentInvoked === true && record.acked) {
        yield* completePrompt(record, { kind: "agent" });
      }
    });

  const oldestOpenPrompt = (): PromptRecord | undefined => {
    for (const record of prompts.values()) {
      if (!Deferred.isDoneUnsafe(record.outcome)) {
        return record;
      }
    }
    return undefined;
  };

  const publishEvent = (frame: SessionEventFrame): Effect.Effect<void> =>
    Queue.offer(events, frame).pipe(Effect.ignore);

  const handleLogicalFrame = (frame: Frame): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (!(yield* Deferred.isDone(readyDeferred))) {
        if (frame.type !== "ready") {
          return yield* failReady(
            new NeoPiRpcError({
              code: "bad_frame",
              message: "expected ready before any other frame",
            }),
          );
        }
        const ready = frame as ReadyFrame;
        if (ready.protocolVersion !== 1) {
          return yield* failReady(
            new NeoPiRpcError({
              code: "bad_frame",
              message: `unsupported NeoPi/OMP ready protocolVersion: ${String(ready.protocolVersion)}`,
            }),
          );
        }
        if (
          typeof ready.maxReassembledFrameBytes === "number" &&
          ready.maxReassembledFrameBytes > 0
        ) {
          ceiling = ready.maxReassembledFrameBytes;
          decoder.current = new RpcFrameDecoder(ceiling);
        }
        yield* Deferred.succeed(readyDeferred, ready).pipe(Effect.ignore);
        return;
      }

      switch (frame.type) {
        case "response":
          return yield* onResponse(frame as ResponseFrame);
        case "extension_ui_request":
          return yield* Queue.offer(uiRequests, frame as UiRequestFrame).pipe(Effect.ignore);
        case "host_tool_call":
        case "host_tool_cancel":
          return yield* Queue.offer(
            hostToolCalls,
            frame as HostToolCallFrame | HostToolCancelFrame,
          ).pipe(Effect.ignore);
        case "host_uri_request": {
          const uri = frame as HostUriRequestFrame;
          if (uriListeners === 0) {
            yield* writeFrame(unsupportedUriResult(uri.id)).pipe(Effect.ignore);
            return;
          }
          yield* Queue.offer(hostUriRequests, uri).pipe(Effect.ignore);
          return;
        }
        case "agent_start":
          yield* onAgentStart();
          return yield* publishEvent(frame as SessionEventFrame);
        case "prompt_result":
          yield* onPromptResult(frame as SessionEventFrame);
          yield* publishEvent(frame as SessionEventFrame);
          if (frame.agentInvoked === false && typeof frame.id === "string")
            prompts.delete(frame.id);
          return;
        case "agent_end":
          yield* publishEvent(frame as SessionEventFrame);
          if (frame.isTerminal !== false) prompts.clear();
          return;
        default:
          return yield* publishEvent(frame as SessionEventFrame);
      }
    });

  const abortTransport = (error: NeoPiRpcError): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (fatal) return;
      yield* failPending(error);
      yield* Deferred.fail(readyDeferred, error).pipe(Effect.ignore);
      yield* handle
        .kill({
          killSignal: "SIGTERM",
          forceKillAfter: Duration.millis(150),
        })
        .pipe(Effect.ignore, Effect.forkIn(lifetime));
    });

  const failReady = abortTransport;
  const noteBadChunk = (message: string): Effect.Effect<void> =>
    abortTransport(new NeoPiRpcError({ code: "bad_chunk", message }));

  const ingestLine = (line: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const parsed = yield* decodeFrameLine(line).pipe(
        Effect.catch((error) => failReady(error).pipe(Effect.as(undefined))),
      );
      if (parsed === undefined) {
        return;
      }
      if (isRpcChunkFrame(parsed)) {
        if (protocol !== 2) {
          return yield* noteBadChunk("rpc_chunk is not valid on protocol v1");
        }
      }
      const pushed = pushChunk(decoder.current, parsed);
      if (!pushed.ok) {
        return yield* noteBadChunk(pushed.message);
      }
      if (pushed.frame) {
        yield* handleLogicalFrame(pushed.frame as Frame);
      }
    });

  const stdoutDone = yield* Deferred.make<void>();
  const stderrDone = yield* Deferred.make<void>();

  yield* Stream.runForEach(stdoutLines(handle.stdout), ingestLine).pipe(
    Effect.catch((error) =>
      abortTransport(
        new NeoPiRpcError({
          code: "closed",
          message: `NeoPi/OMP stdout failed: ${String(error)}`,
        }),
      ),
    ),
    Effect.andThen(
      Effect.sync(() => finishChunks(decoder.current)).pipe(
        Effect.flatMap((message) => (message === undefined ? Effect.void : noteBadChunk(message))),
      ),
    ),
    Effect.andThen(
      Deferred.isDone(readyDeferred).pipe(
        Effect.flatMap((done) =>
          done
            ? Effect.void
            : abortTransport(
                new NeoPiRpcError({
                  code: "exited",
                  message: "NeoPi/OMP stdout ended before the ready frame",
                }),
              ),
        ),
      ),
    ),
    Effect.ensuring(Deferred.succeed(stdoutDone, undefined).pipe(Effect.ignore)),
    Effect.forkScoped,
  );

  const stderrDecoder = new TextDecoder("utf-8", { fatal: false });
  yield* Stream.runForEach(handle.stderr, (chunk) =>
    Effect.sync(() => {
      pushStderrTail(stderrTail, chunk, stderrTailBytes);
      return stderrDecoder.decode(chunk, { stream: true });
    }).pipe(
      Effect.flatMap((text) =>
        text.length === 0 ? Effect.void : Queue.offer(stderr, text).pipe(Effect.ignore),
      ),
    ),
  ).pipe(
    Effect.ignore,
    Effect.ensuring(Deferred.succeed(stderrDone, undefined).pipe(Effect.ignore)),
    Effect.forkScoped,
  );

  yield* Stream.fromQueue(outbound).pipe(
    Stream.run(handle.stdin),
    Effect.catch(() =>
      abortTransport(
        new NeoPiRpcError({
          code: "closed",
          message: "NeoPi/OMP stdin write failed",
        }),
      ),
    ),
    Effect.forkScoped,
  );

  const readExit = handle.exitCode.pipe(
    Effect.match({
      onSuccess: (code) => ({ code: code as number, signal: null as string | null }),
      onFailure: (error) => ({ code: null as number | null, signal: signalFromExitFailure(error) }),
    }),
  );

  yield* readExit.pipe(
    Effect.flatMap((status) =>
      Effect.gen(function* () {
        if (!(yield* Deferred.isDone(readyDeferred))) {
          yield* Deferred.fail(
            readyDeferred,
            new NeoPiRpcError({ code: "exited", message: "NeoPi/OMP process exited before ready" }),
          ).pipe(Effect.ignore);
        }
        yield* Effect.all([Deferred.await(stdoutDone), Deferred.await(stderrDone)], {
          concurrency: "unbounded",
        });
        if (fatal) {
          yield* failPending(fatal);
        } else if (!closed) {
          yield* failPending(
            new NeoPiRpcError({
              code: "exited",
              message: "NeoPi/OMP process exited",
            }),
          );
        }
        yield* endQueue(events);
        yield* endQueue(uiRequests);
        yield* endQueue(hostToolCalls);
        yield* endQueue(hostUriRequests);
        yield* endQueue(stderr);
        yield* Deferred.succeed(exit, {
          code: status.code,
          signal: status.signal,
          stderrTail: stderrTailText(stderrTail),
        }).pipe(Effect.ignore);
      }),
    ),
    Effect.forkScoped,
  );

  const close = (graceMs: number = DEFAULT_CLOSE_GRACE_MS): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (closed) {
          return yield* Deferred.await(exit).pipe(Effect.ignore);
        }
        closed = true;
        yield* failPending(
          new NeoPiRpcError({
            code: "closed",
            message: "NeoPi/OMP RPC client is closed",
          }),
        );
        yield* Queue.end(outbound).pipe(Effect.ignore);
        const slices = Math.max(1, Math.ceil(graceMs / 20));
        for (let slice = 0; slice < slices; slice++) {
          if (yield* Deferred.isDone(exit)) {
            break;
          }
          yield* Effect.sleep("20 millis");
        }
        if (!(yield* Deferred.isDone(exit))) {
          yield* handle
            .kill({ killSignal: "SIGTERM", forceKillAfter: Duration.millis(graceMs) })
            .pipe(Effect.ignore);
        }
        yield* Deferred.await(exit).pipe(Effect.ignore);
      }),
    );

  yield* Effect.addFinalizer(() => close());

  const hostUriRequestsStream = Stream.unwrap(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          uriListeners += 1;
        }),
        () =>
          Effect.sync(() => {
            uriListeners -= 1;
          }),
      );
      return Stream.fromQueue(hostUriRequests);
    }),
  );

  const respondUi = (response: UiResponseWire): Effect.Effect<void, NeoPiRpcError> =>
    writeFrame({ type: "extension_ui_response", ...response });

  const hostToolUpdate = (
    id: string,
    partialResult: AgentToolResultWire,
  ): Effect.Effect<void, NeoPiRpcError> =>
    writeFrame({ type: "host_tool_update", id, partialResult });

  const hostToolResult = (
    id: string,
    result: AgentToolResultWire,
    isError?: boolean,
  ): Effect.Effect<void, NeoPiRpcError> =>
    writeFrame({
      type: "host_tool_result",
      id,
      result,
      ...(isError !== undefined ? { isError } : {}),
    });

  const hostUriResult = (result: HostUriResultWire): Effect.Effect<void, NeoPiRpcError> =>
    writeFrame(result);

  const ready = yield* Effect.gen(function* () {
    if (options.onTransportReady) {
      yield* options.onTransportReady({
        transportReady: Deferred.await(readyDeferred),
        events: Stream.fromQueue(events),
        uiRequests: Stream.fromQueue(uiRequests),
        respondUi,
        hostToolCalls: Stream.fromQueue(hostToolCalls),
        hostToolResult,
        hostUriRequests: hostUriRequestsStream,
        hostUriResult,
        exit,
      });
    }
    return yield* Deferred.await(readyDeferred);
  }).pipe(
    Effect.timeout(Duration.millis(requestTimeoutMs)),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new NeoPiRpcError({
          code: "timeout",
          message: "timed out waiting for the ready frame",
        }),
      ),
    ),
    Effect.tapError(abortTransport),
  );

  const supported = ready.supportedProtocolVersions;
  const capabilities = new Set<string>(
    Array.isArray(ready.capabilities)
      ? ready.capabilities.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
  if (Array.isArray(supported) && supported.includes(2)) {
    const result = yield* request({ type: "negotiate_protocol", protocolVersion: 2 });
    if (!isRecord(result) || result.protocolVersion !== 2) {
      const error = new NeoPiRpcError({
        code: "bad_frame",
        message: "NeoPi/OMP peer did not confirm protocol v2 negotiation",
      });
      yield* abortTransport(error);
      return yield* error;
    }
    protocol = 2;
    capabilities.add("v2");
  }

  return {
    ready,
    capabilities,
    request,
    writeFrame,
    prompt,
    events: Stream.fromQueue(events),
    uiRequests: Stream.fromQueue(uiRequests),
    respondUi,
    hostToolCalls: Stream.fromQueue(hostToolCalls),
    hostToolUpdate,
    hostToolResult,
    hostUriRequests: hostUriRequestsStream,
    hostUriResult,
    stderr: Stream.fromQueue(stderr),
    exit,
    close,
  } satisfies NeoPiRpcClient;
});

const completePrompt = (record: PromptRecord, outcome: PromptOutcome): Effect.Effect<void> =>
  Deferred.isDone(record.outcome).pipe(
    Effect.flatMap((done) =>
      done ? Effect.void : Deferred.succeed(record.outcome, outcome).pipe(Effect.ignore),
    ),
  );

const responseError = (frame: ResponseFrame): NeoPiRpcError =>
  new NeoPiRpcError({
    message: frame.error ?? "command failed",
    command: frame.command,
    ...(frame.code !== undefined ? { code: frame.code } : {}),
  });

const agentInvokedOf = (data: unknown): boolean | undefined => {
  if (!isRecord(data) || typeof data.agentInvoked !== "boolean") {
    return undefined;
  }
  return data.agentInvoked;
};

const readCommandId = (cmd: { readonly type: string }): unknown =>
  "id" in cmd ? cmd.id : undefined;

const pushChunk = (
  decoder: RpcFrameDecoder,
  value: unknown,
): { ok: true; frame: Record<string, unknown> | undefined } | { ok: false; message: string } => {
  try {
    return { ok: true, frame: decoder.push(value) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "bad rpc chunk" };
  }
};

const finishChunks = (decoder: RpcFrameDecoder): string | undefined => {
  try {
    decoder.finish();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "rpc chunk sequence truncated";
  }
};
