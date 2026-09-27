// @effect-diagnostics nodeBuiltinImport:off -- compare session identities with Node path resolution.
import { dirname, resolve, sep } from "node:path";
import type { ModelSelection, RuntimeMode, ThreadId, TurnId } from "@t3tools/contracts";
import {
  make as makeClient,
  type NeoPiRpcClient,
  type PromptHandle,
  type SpawnFn,
  type HostToolCallFrame,
} from "effect-neopi-rpc/client";
import { NeoPiRpcError } from "effect-neopi-rpc/errors";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { buildNeoPiLaunchPlan } from "./NeoPiLaunchArgs.ts";
import { NeoPiRuntimeError } from "./NeoPiRuntimeError.ts";
import type {
  NeoPiResumeCursor,
  NeoPiRuntimeFrame,
  NeoPiRuntimeState,
  NeoPiSessionRuntimeShape,
  NeoPiTurnInput,
} from "./NeoPiRuntimeTypes.ts";

interface SessionState {
  sessionId?: string;
  sessionFile?: string;
  messageCount?: number;
  contextUsage?: { tokens?: number };
  [key: string]: unknown;
}
interface HostBridge {
  readonly definitions: ReadonlyArray<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    loadMode?: string;
  }>;
  readonly handle: (
    call: HostToolCallFrame,
    signal: AbortSignal,
  ) => Effect.Effect<
    {
      content: ReadonlyArray<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      >;
      details?: unknown;
      isError?: boolean;
    },
    never
  >;
}
export interface NeoPiRuntimeInput {
  readonly threadId: ThreadId;
  readonly binary: string;
  readonly cwd: string;
  readonly t3Home: string;
  readonly env?: Record<string, string>;
  readonly projectId: string;
  readonly profile?: string;
  readonly launchArgs?: string;
  readonly runtimeMode: RuntimeMode;
  readonly cursor?: NeoPiResumeCursor;
  readonly spawn: SpawnFn;
  readonly hostBridge?: HostBridge;
  readonly requestTimeoutMs?: number;
  readonly closeGraceMs?: number;
}

const rpcError = (cause: unknown): NeoPiRuntimeError =>
  new NeoPiRuntimeError({
    code: "rpc",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const identityError = (message: string) =>
  new NeoPiRuntimeError({ code: "identity_mismatch", message });
const unknownCommand = (error: NeoPiRuntimeError) => /unknown command/i.test(error.message);
const activeUiMethods = new Set(["select", "confirm", "input", "editor"]);

type ActiveTurn = {
  readonly id: TurnId;
  readonly text: string;
  readonly baselineLeaf?: string;
  readonly boundaryDone: Deferred.Deferred<void>;
  boundaryStarted: boolean;
  promptId?: string;
  agentInvoked: boolean;
  interrupted: boolean;
  error?: { reason: string; message?: string };
};

export const makeNeoPiSessionRuntime = Effect.fn("NeoPiSessionRuntime.make")(function* (
  input: NeoPiRuntimeInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const state = yield* SubscriptionRef.make<NeoPiRuntimeState>("stopped");
  const cursor = yield* SubscriptionRef.make<NeoPiResumeCursor>(
    input.cursor ?? { v: 1, sessionFile: "", sessionId: "", sessionDir: "", turnBoundaries: [] },
  );
  const frames = yield* Queue.unbounded<NeoPiRuntimeFrame, Cause.Done<void>>();
  const capabilities = new Set<string>();
  const uiPending = new Set<string>();
  const hostPending = new Map<string, Scope.Closeable>();
  let client: NeoPiRpcClient | undefined;
  let lifetime: Scope.Closeable | undefined;
  let generation = 0;
  let active: ActiveTurn | undefined;
  let compacting = false;
  let mode = input.runtimeMode;
  let pendingMode = false;

  const emit = (frame: NeoPiRuntimeFrame) =>
    Queue.offer(frames, frame).pipe(Effect.orDie, Effect.asVoid);
  const setState = (value: NeoPiRuntimeState) => SubscriptionRef.set(state, value);
  const current = () =>
    client
      ? Effect.succeed(client)
      : Effect.fail(
          new NeoPiRuntimeError({ code: "closed", message: "NeoPi/OMP session is not connected" }),
        );
  const request: NeoPiRpcClient["request"] = (cmd) =>
    client
      ? client.request(cmd)
      : Effect.fail(
          new NeoPiRpcError({
            code: "closed",
            message: "NeoPi/OMP session is not connected",
            command: cmd.type,
          }),
        );
  const getState = () =>
    request({ type: "get_state" }).pipe(
      Effect.map((data) => record(data) as SessionState),
      Effect.mapError(rpcError),
    );
  const publishState = () =>
    Effect.flatMap(getState(), (value) => emit({ type: "t3.state", state: value }));
  const cancelPending = Effect.gen(function* () {
    for (const id of uiPending) {
      yield* client?.respondUi({ id, cancelled: true }).pipe(Effect.ignore) ?? Effect.void;
      yield* emit({
        type: "extension_ui_request",
        id,
        method: "cancel",
        targetId: id,
        ...(active ? { turnId: active.id } : {}),
      });
    }
    uiPending.clear();
    for (const [id, requestScope] of hostPending) {
      yield* Scope.close(requestScope, Exit.void);
      yield* emit({
        type: "host_tool_cancel",
        id,
        targetId: id,
        ...(active ? { turnId: active.id } : {}),
      });
    }
    hostPending.clear();
  });
  const captureBoundary = (turn: ActiveTurn) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = record(
          yield* request({
            type: "get_entries",
            ...(turn.baselineLeaf ? { since: turn.baselineLeaf } : {}),
          }).pipe(Effect.mapError(rpcError)),
        );
        const entries = Array.isArray(result.entries) ? result.entries.map(record) : [];
        const user = entries.find((entry) => {
          const message = record(entry.message);
          const content = Array.isArray(message.content) ? message.content.map(record) : [];
          return (
            entry.type === "message" &&
            message.role === "user" &&
            typeof entry.id === "string" &&
            content.some((block) => block.type === "text" && block.text === turn.text)
          );
        });
        if (user && typeof user.id === "string") {
          const previous = yield* SubscriptionRef.get(cursor);
          yield* SubscriptionRef.set(cursor, {
            ...previous,
            turnBoundaries: [...previous.turnBoundaries, { turnId: turn.id, userEntryId: user.id }],
          });
          return;
        }
        if (attempt < 2) yield* Effect.sleep("50 millis");
      }
      yield* emit({
        type: "notice",
        level: "warning",
        message: "NeoPi/OMP did not expose this turn's user entry; rollback is unavailable for it",
        turnId: turn.id,
      });
    });
  const rememberBoundary = (turn: ActiveTurn) =>
    captureBoundary(turn).pipe(
      Effect.catch((error) =>
        emit({
          type: "notice",
          level: "warning",
          message: `NeoPi/OMP boundary capture failed: ${error.message}`,
          turnId: turn.id,
        }),
      ),
      Effect.ensuring(Deferred.succeed(turn.boundaryDone, undefined).pipe(Effect.ignore)),
    );
  const settle = (
    turn: ActiveTurn,
    outcome: "completed" | "failed" | "interrupted",
    errorMessage?: string,
  ) =>
    Effect.gen(function* () {
      if (active !== turn) return;
      active = undefined;
      if (turn.agentInvoked && client && (yield* SubscriptionRef.get(state)) !== "failed") {
        if (turn.boundaryStarted) yield* Deferred.await(turn.boundaryDone);
        else yield* rememberBoundary(turn);
      }
      if ((yield* SubscriptionRef.get(state)) === "running") yield* setState("ready");
      yield* emit({
        type: "t3.turn.outcome",
        state: outcome,
        ...(errorMessage ? { errorMessage } : {}),
        turnId: turn.id,
      });
      if ((yield* SubscriptionRef.get(state)) === "ready")
        yield* publishState().pipe(Effect.ignore);
    });
  const observePrompt = (turn: ActiveTurn, handle: PromptHandle) =>
    Effect.gen(function* () {
      const outcome = yield* Deferred.await(handle.outcome);
      if (active !== turn || outcome.kind !== "agent") return;
      turn.agentInvoked = true;
      if (!turn.boundaryStarted) {
        turn.boundaryStarted = true;
        yield* rememberBoundary(turn).pipe(Effect.forkIn(lifetime!));
      }
    });
  const handleEvent = (frame: NeoPiRuntimeFrame) =>
    Effect.gen(function* () {
      const turn = active;
      yield* emit({ ...frame, ...(turn ? { turnId: turn.id } : {}) });
      if (
        (frame.type === "model_changed" || frame.type === "config_warnings_changed") &&
        !record(frame).model
      ) {
        if (lifetime) yield* publishState().pipe(Effect.ignore, Effect.forkIn(lifetime));
      }
      if (!turn) return;
      if (
        (frame.type === "t3.prompt.local" ||
          (frame.type === "prompt_result" && frame.agentInvoked === false)) &&
        (!turn.promptId || frame.id === turn.promptId)
      ) {
        yield* settle(turn, "completed");
        return;
      }
      if (frame.type === "t3.prompt.failed" && (!turn.promptId || frame.id === turn.promptId)) {
        yield* settle(
          turn,
          "failed",
          typeof frame.error === "string" ? frame.error : "prompt failed",
        );
        return;
      }
      if (frame.type === "agent_start") {
        turn.agentInvoked = true;
        delete turn.error;
      }
      if (frame.type === "message_start" && record(frame.message).role === "assistant")
        delete turn.error;
      if (frame.type === "message_update") {
        const event = record(frame.assistantMessageEvent);
        if (event.type === "error" && (event.reason === "aborted" || event.reason === "error")) {
          turn.error = {
            reason: event.reason,
            ...(typeof record(event.error).errorMessage === "string"
              ? { message: String(record(event.error).errorMessage) }
              : {}),
          };
        }
      }
      if (frame.type !== "agent_end" || frame.isTerminal === false) return;
      const last = Array.isArray(frame.messages)
        ? frame.messages
            .map(record)
            .filter((message) => message.role === "assistant")
            .at(-1)
        : undefined;
      const reason = last?.stopReason ?? turn.error?.reason;
      const message =
        turn.error?.message ??
        (typeof last?.errorMessage === "string" ? last.errorMessage : undefined);
      yield* settle(
        turn,
        reason === "aborted" || (turn.interrupted && reason !== "error")
          ? "interrupted"
          : reason === "error"
            ? "failed"
            : "completed",
        message,
      );
    });
  const pumpHost = (peer: NeoPiRpcClient) =>
    Stream.runForEach(peer.hostToolCalls, (call) =>
      Effect.gen(function* () {
        if (call.type === "host_tool_cancel") {
          const requestScope = hostPending.get(call.targetId);
          if (requestScope) yield* Scope.close(requestScope, Exit.void);
          hostPending.delete(call.targetId);
        } else if (input.hostBridge) {
          const requestScope = yield* Scope.make();
          const signal = yield* Effect.abortSignal.pipe(
            Effect.provideService(Scope.Scope, requestScope),
          );
          hostPending.set(call.id, requestScope);
          yield* input.hostBridge.handle(call, signal).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({
                content: [{ type: "text" as const, text: String(cause) }],
                isError: true,
              }),
            ),
            Effect.flatMap((result) => peer.hostToolResult(call.id, result, result.isError)),
            Effect.ensuring(
              Scope.close(requestScope, Exit.void).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    hostPending.delete(call.id);
                  }),
                ),
              ),
            ),
            Effect.ignore,
            Effect.forkIn(lifetime!),
          );
        }
        yield* emit({ ...call, ...(active ? { turnId: active.id } : {}) });
      }),
    );
  const closePeer = Effect.gen(function* () {
    generation++;
    yield* cancelPending;
    const closing = client;
    if (closing) yield* closing.close(input.closeGraceMs ?? 150).pipe(Effect.ignore);
    const exit = closing ? yield* Deferred.await(closing.exit) : undefined;
    if (lifetime) yield* Scope.close(lifetime, Exit.void).pipe(Effect.ignore);
    client = undefined;
    lifetime = undefined;
    return exit;
  });
  const start: NeoPiSessionRuntimeShape["start"] = Effect.gen(function* () {
    const previous = yield* SubscriptionRef.get(state);
    if (previous !== "stopped" && previous !== "failed")
      return yield* new NeoPiRuntimeError({
        code: "not_ready",
        message: "NeoPi/OMP runtime is already started",
      });
    yield* setState("starting");
    const epoch = ++generation;
    const saved = yield* SubscriptionRef.get(cursor);
    const resume = saved.sessionId ? saved : undefined;
    const launch = yield* buildNeoPiLaunchPlan({
      ...input,
      runtimeMode: mode,
      ...(resume ? { cursor: resume } : {}),
    }).pipe(Effect.tapError(() => setState("failed")));
    const scope = yield* Scope.make();
    lifetime = scope;
    const begin = Effect.gen(function* () {
      if (launch.sessionDir) yield* fs.makeDirectory(launch.sessionDir, { recursive: true });
      const peer = yield* makeClient({
        spawn: input.spawn,
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: launch.env,
        ...(input.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: input.requestTimeoutMs }),
      }).pipe(Effect.provideService(Scope.Scope, scope));
      client = peer;
      capabilities.clear();
      for (const item of peer.capabilities) capabilities.add(item);
      yield* Stream.runForEach(peer.events, handleEvent).pipe(
        Effect.forkScoped,
        Effect.provideService(Scope.Scope, scope),
      );
      yield* Stream.runForEach(peer.uiRequests, (frame) =>
        Effect.gen(function* () {
          if (activeUiMethods.has(frame.method)) {
            if (
              (yield* SubscriptionRef.get(state)) === "failed" ||
              (yield* SubscriptionRef.get(state)) === "stopping"
            ) {
              yield* emit({
                type: "extension_ui_request",
                id: frame.id,
                method: "cancel",
                targetId: frame.id,
                ...(active ? { turnId: active.id } : {}),
              });
            } else uiPending.add(frame.id);
          }
          if (frame.method === "cancel" && typeof frame.targetId === "string")
            uiPending.delete(frame.targetId);
          yield* emit({ ...frame, ...(active ? { turnId: active.id } : {}) });
        }),
      ).pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, scope));
      yield* pumpHost(peer).pipe(Effect.forkScoped, Effect.provideService(Scope.Scope, scope));
      yield* Deferred.await(peer.exit).pipe(
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            if (epoch !== generation) return;
            const requested = (yield* SubscriptionRef.get(state)) === "stopping";
            yield* setState(requested ? "stopped" : "failed");
            if (active) yield* settle(active, "failed", "NeoPi/OMP process exited during the turn");
            yield* cancelPending;
            yield* emit({ type: "t3.session.exited", recoverable: !requested, ...exit });
          }),
        ),
        Effect.forkScoped,
        Effect.provideService(Scope.Scope, scope),
      );
      const initial = yield* getState();
      const file = typeof initial.sessionFile === "string" ? resolve(initial.sessionFile) : "";
      const expected = resolve(launch.sessionDir) + sep;
      if (
        !initial.sessionId ||
        !file ||
        (resume
          ? initial.sessionId !== resume.sessionId || file !== resolve(resume.sessionFile)
          : initial.messageCount !== 0 ||
            (!launch.args.includes("--new-session") && !file.startsWith(expected)))
      ) {
        return yield* identityError(
          resume
            ? "NeoPi/OMP resumed a different session"
            : "NeoPi/OMP fresh launch selected a non-empty or foreign session",
        );
      }
      yield* SubscriptionRef.set(cursor, {
        ...saved,
        v: 1 as const,
        sessionId: initial.sessionId,
        sessionFile: file,
        sessionDir: launch.sessionDir || dirname(file),
      });
      if (input.hostBridge)
        yield* peer
          .request({ type: "set_host_tools", tools: input.hostBridge.definitions })
          .pipe(Effect.mapError(rpcError));
      for (const command of [
        { type: "set_subagent_subscription", level: "events" },
        { type: "set_interrupt_mode", mode: "immediate" },
      ] as const) {
        yield* peer.request(command).pipe(
          Effect.mapError(rpcError),
          Effect.catchIf(unknownCommand, () => Effect.void),
        );
      }
      yield* setState("ready");
    });
    yield* begin.pipe(
      Effect.mapError((error) => (error instanceof NeoPiRuntimeError ? error : rpcError(error))),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* setState("failed");
          yield* closePeer;
          return yield* error;
        }),
      ),
    );
  });
  const applyModelSelection = (selection: ModelSelection) =>
    Effect.gen(function* () {
      const slash = selection.model.indexOf("/");
      if (slash > 0)
        yield* request({
          type: "set_model",
          provider: selection.model.slice(0, slash),
          modelId: selection.model.slice(slash + 1),
        }).pipe(Effect.mapError(rpcError));
      for (const option of selection.options ?? []) {
        if (option.id === "reasoningEffort" && typeof option.value === "string")
          yield* request({ type: "set_thinking_level", level: option.value }).pipe(
            Effect.mapError(rpcError),
          );
        if (option.id === "fastMode" && typeof option.value === "boolean") {
          const data = record(
            yield* request({ type: "set_fast_mode", enabled: option.value }).pipe(
              Effect.mapError(rpcError),
            ),
          );
          yield* emit({ type: "t3.fast_mode", enabled: data.enabled, active: data.active });
          if (data.enabled && !data.active)
            yield* emit({
              type: "notice",
              level: "warning",
              message: "NeoPi/OMP fast mode is enabled but not active for the current model",
            });
        }
      }
    });
  const restart = (_reason: "runtime-mode-change") =>
    Effect.gen(function* () {
      if ((yield* SubscriptionRef.get(state)) !== "ready" || compacting)
        return yield* new NeoPiRuntimeError({
          code: "not_ready",
          message: "NeoPi/OMP can restart only between turns",
        });
      yield* closePeer;
      yield* setState("stopped");
      yield* start;
      pendingMode = false;
    });
  const startTurn = (turn: NeoPiTurnInput) =>
    Effect.gen(function* () {
      if (pendingMode && (yield* SubscriptionRef.get(state)) === "ready")
        yield* restart("runtime-mode-change");
      if ((yield* SubscriptionRef.get(state)) !== "ready" || compacting)
        return yield* new NeoPiRuntimeError({
          code: "not_ready",
          message: "NeoPi/OMP is not ready for a turn",
        });
      if (turn.modelSelection) yield* applyModelSelection(turn.modelSelection);
      const peer = yield* current();
      const baseline = record(
        yield* request({ type: "get_entries" }).pipe(Effect.mapError(rpcError)),
      );
      const entry: ActiveTurn = {
        id: turn.turnId,
        text: turn.text,
        ...(typeof baseline.leafId === "string" ? { baselineLeaf: baseline.leafId } : {}),
        boundaryDone: yield* Deferred.make<void>(),
        boundaryStarted: false,
        agentInvoked: false,
        interrupted: false,
      };
      active = entry;
      yield* setState("running");
      const handle = yield* peer
        .prompt({
          type: "prompt",
          message: turn.text,
          ...(turn.images.length ? { images: turn.images } : {}),
        })
        .pipe(
          Effect.mapError(rpcError),
          Effect.tapError(() =>
            Effect.gen(function* () {
              active = undefined;
              yield* setState("ready");
            }),
          ),
        );
      entry.promptId = handle.id;
      yield* observePrompt(entry, handle).pipe(Effect.forkIn(lifetime!));
      return { turnId: turn.turnId };
    });
  const steer = (turn: NeoPiTurnInput) =>
    Effect.gen(function* () {
      if ((yield* SubscriptionRef.get(state)) !== "running" || !active || compacting)
        return yield* new NeoPiRuntimeError({
          code: "not_running",
          message: "NeoPi/OMP has no running turn to steer",
        });
      yield* request({
        type: "steer",
        message: turn.text,
        ...(turn.images.length ? { images: turn.images } : {}),
      }).pipe(Effect.mapError(rpcError));
    });
  const interrupt = Effect.gen(function* () {
    if ((yield* SubscriptionRef.get(state)) !== "running" || !active)
      return yield* new NeoPiRuntimeError({
        code: "not_running",
        message: "NeoPi/OMP has no running turn to interrupt",
      });
    const turn = active;
    turn.interrupted = true;
    yield* request({ type: "abort" }).pipe(
      Effect.mapError(rpcError),
      Effect.tapError(() =>
        Effect.sync(() => {
          if (active === turn) turn.interrupted = false;
        }),
      ),
    );
  });
  const compact = (customInstructions?: string) =>
    Effect.gen(function* () {
      if ((yield* SubscriptionRef.get(state)) !== "ready" || compacting)
        return yield* new NeoPiRuntimeError({
          code: "not_ready",
          message: "NeoPi/OMP can compact only between turns",
        });
      compacting = true;
      const result = yield* request({
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      }).pipe(
        Effect.mapError(rpcError),
        Effect.ensuring(
          Effect.sync(() => {
            compacting = false;
          }),
        ),
      );
      const before = record(result).tokensBefore;
      const after = yield* getState();
      yield* emit({
        type: "t3.compaction",
        ...(typeof before === "number" ? { beforeTokens: before } : {}),
        ...(typeof after.contextUsage?.tokens === "number"
          ? { afterTokens: after.contextUsage.tokens }
          : {}),
      });
      yield* emit({ type: "t3.state", state: after });
    });
  const stop = Effect.gen(function* () {
    const previous = yield* SubscriptionRef.get(state);
    if (previous === "stopped") return;
    yield* setState("stopping");
    const exit = yield* closePeer;
    if (active) yield* settle(active, "failed", "NeoPi/OMP session was stopped");
    yield* setState("stopped");
    if (exit && previous !== "failed")
      yield* emit({ type: "t3.session.exited", recoverable: false, ...exit });
    yield* Queue.end(frames);
  });
  const onSessionIdentityMayHaveChanged = Effect.gen(function* () {
    const fresh = yield* getState();
    if (!fresh.sessionId || !fresh.sessionFile)
      return yield* identityError("NeoPi/OMP did not report its current session identity");
    const previous = yield* SubscriptionRef.get(cursor);
    yield* SubscriptionRef.set(cursor, {
      ...previous,
      sessionId: fresh.sessionId,
      sessionFile: resolve(fresh.sessionFile),
    });
    yield* emit({ type: "t3.state", state: fresh });
  });
  const setRuntimeMode = (next: RuntimeMode) =>
    Effect.gen(function* () {
      if (mode === next) return;
      mode = next;
      const status = yield* SubscriptionRef.get(state);
      if (status === "ready") yield* restart("runtime-mode-change");
      else if (status === "running") {
        pendingMode = true;
        return yield* new NeoPiRuntimeError({
          code: "runtime_mode_deferred",
          message: "NeoPi/OMP runtime mode takes effect after the current turn",
        });
      }
    });
  return {
    threadId: input.threadId,
    state,
    cursor,
    capabilities,
    start,
    startTurn,
    steer,
    interrupt,
    compact,
    request,
    writeFrame: (frame) =>
      client
        ? client.writeFrame(frame)
        : Effect.fail(
            new NeoPiRpcError({ code: "closed", message: "NeoPi/OMP session is not connected" }),
          ),
    frames: Stream.fromQueue(frames),
    restart,
    stop,
    setRuntimeMode,
    onSessionIdentityMayHaveChanged,
    applyModelSelection,
    respondUi: (response) =>
      Effect.gen(function* () {
        uiPending.delete(response.id);
        if (!client)
          return yield* new NeoPiRpcError({
            code: "closed",
            message: "NeoPi/OMP session is not connected",
          });
        yield* client.respondUi(response);
      }),
  } satisfies NeoPiSessionRuntimeShape;
});
