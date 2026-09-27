import {
  type ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type NeoPiSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import type { SpawnFn } from "effect-neopi-rpc/client";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { emptyCoreState, mapCoreFrame } from "../neopi/mappers/core.ts";
import type { MapCtx } from "../neopi/mappers/MapCtx.ts";
import { emptyToolState, mapToolFrame, withHostToolNames } from "../neopi/mappers/tools.ts";
import {
  emptyUiState,
  flushUiSettlements,
  mapUiRequest,
  NEOPI_CAP_TOOL_APPROVAL,
  type PendingUi,
} from "../neopi/mappers/ui.ts";
import type { NeoPiDiscoveryHub } from "../neopi/NeoPiDiscovery.ts";
import { makeNeoPiSessionRuntime, type NeoPiRuntimeInput } from "../neopi/NeoPiSessionRuntime.ts";
import type {
  NeoPiResumeCursor,
  NeoPiRuntimeFrame,
  NeoPiSessionRuntimeShape,
} from "../neopi/NeoPiRuntimeTypes.ts";
import type { NeoPiAdapterShape } from "../Services/NeoPiAdapter.ts";

const PROVIDER = ProviderDriverKind.make("neopi");
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

interface Session {
  session: ProviderSession;
  runtime: NeoPiSessionRuntimeShape;
  scope: Scope.Closeable;
  pending: Map<string, PendingUi>;
  ui: ReturnType<typeof emptyUiState>;
  activeTurnId?: TurnId;
}

export interface NeoPiAdapterOptions {
  readonly settings: NeoPiSettings;
  readonly instanceId: ProviderInstanceId;
  readonly binary: string;
  readonly cwd: string;
  readonly t3Home: string;
  readonly attachmentsDir: string;
  readonly environment: Record<string, string>;
  readonly spawn: SpawnFn;
  readonly discovery: NeoPiDiscoveryHub;
  readonly makeRuntime?: (
    input: NeoPiRuntimeInput,
  ) => Effect.Effect<NeoPiSessionRuntimeShape, never, FileSystem.FileSystem>;
  readonly hostToolNames?: ReadonlyArray<string>;
}

export const makeNeoPiAdapter = Effect.fn("NeoPiAdapter.make")(function* (
  options: NeoPiAdapterOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const events = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const sessions = new Map<ThreadId, Session>();
  let eventSequence = 0;
  const stamp = (now: string): Pick<MapCtx, "now" | "newEventId"> => ({
    now: () => now,
    newEventId: () => `neopi-${options.instanceId}-${++eventSequence}`,
  });
  const context = (session: Session, now: string, turnId?: TurnId): MapCtx => ({
    provider: PROVIDER,
    providerInstanceId: options.instanceId,
    threadId: session.session.threadId,
    ...(turnId ? { turnId } : {}),
    ...stamp(now),
  });
  const publish = (items: ReadonlyArray<ProviderRuntimeEvent>) =>
    Effect.forEach(items, (item) => PubSub.publish(events, item), { discard: true });
  const requireSession = (threadId: ThreadId) =>
    sessions.get(threadId)
      ? Effect.succeed(sessions.get(threadId)!)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  const rpcError = (threadId: ThreadId, method: string, cause: { message: string }) =>
    new ProviderAdapterRequestError({ provider: PROVIDER, method, detail: cause.message, cause });
  const processFrame = (session: Session, frame: NeoPiRuntimeFrame) =>
    Effect.gen(function* () {
      const data = record(frame);
      const turnId = frame.turnId ?? session.activeTurnId;
      const ctx = context(session, DateTime.formatIso(yield* DateTime.now), turnId);
      // The RPC startup event may precede subscription; seed negotiated capabilities at start.
      if (data.type === "available_commands_update") {
        const commands = Array.isArray(data.commands)
          ? data.commands.flatMap((entry) => {
              const cmd = record(entry);
              return typeof cmd.name === "string" && cmd.name.length > 0
                ? [
                    {
                      name: cmd.name,
                      ...(typeof cmd.description === "string" && cmd.description
                        ? { description: cmd.description }
                        : {}),
                    },
                  ]
                : [];
            })
          : [];
        yield* options.discovery.publish({
          cwd: session.session.cwd ?? options.cwd,
          source: "live",
          at: ctx.now(),
          commands,
          skills: [],
        });
      }
      const core = mapCoreFrame(ctx, frame, coreState.get(session) ?? emptyCoreState());
      coreState.set(session, core.state);
      const tools = mapToolFrame(ctx, frame, toolState.get(session) ?? emptyToolState());
      toolState.set(session, tools.state);
      const ui = mapUiRequest(ctx, frame, session.ui);
      if (ui.pending) session.pending.set(ui.pending.requestId, ui.pending);
      yield* publish([...core.events, ...tools.events, ...ui.events]);
      if (data.type === "t3.turn.outcome") {
        delete session.activeTurnId;
        session.session = {
          ...session.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: ctx.now(),
          resumeCursor: yield* SubscriptionRef.get(session.runtime.cursor),
        };
      } else if (data.type === "t3.session.exited") {
        delete session.activeTurnId;
        session.session = {
          ...session.session,
          status: "error",
          activeTurnId: undefined,
          updatedAt: ctx.now(),
        };
      }
    });
  const coreState = new WeakMap<Session, ReturnType<typeof emptyCoreState>>();
  const toolState = new WeakMap<Session, ReturnType<typeof emptyToolState>>();
  const stopInternal = (session: Session) =>
    Effect.gen(function* () {
      sessions.delete(session.session.threadId);
      yield* session.runtime.stop;
      yield* Scope.close(session.scope, Exit.void);
    });
  const startSession: NeoPiAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const existing = sessions.get(input.threadId);
      if (existing) {
        if (existing.session.runtimeMode !== input.runtimeMode) {
          yield* existing.runtime.setRuntimeMode(input.runtimeMode).pipe(
            Effect.catch((cause) =>
              cause.code !== "runtime_mode_deferred"
                ? Effect.fail(rpcError(input.threadId, "setRuntimeMode", cause))
                : Effect.gen(function* () {
                    const ctx = context(
                      existing,
                      DateTime.formatIso(yield* DateTime.now),
                      existing.activeTurnId,
                    );
                    const mapped = mapCoreFrame(
                      ctx,
                      { type: "notice", level: "warning", message: cause.message },
                      coreState.get(existing) ?? emptyCoreState(),
                    );
                    coreState.set(existing, mapped.state);
                    yield* publish(mapped.events);
                  }),
            ),
          );
          existing.session = { ...existing.session, runtimeMode: input.runtimeMode };
        }
        return existing.session;
      }
      const cwd = input.cwd ?? options.cwd;
      const cursor = record(input.resumeCursor);
      const resume: NeoPiResumeCursor | undefined =
        cursor.v === 1 &&
        typeof cursor.sessionId === "string" &&
        typeof cursor.sessionFile === "string" &&
        typeof cursor.sessionDir === "string"
          ? {
              v: 1,
              sessionId: cursor.sessionId,
              sessionFile: cursor.sessionFile,
              sessionDir: cursor.sessionDir,
              turnBoundaries: Array.isArray(cursor.turnBoundaries)
                ? (cursor.turnBoundaries as NeoPiResumeCursor["turnBoundaries"])
                : [],
            }
          : undefined;
      const sessionScope = yield* Scope.make();
      const runtimeInput: NeoPiRuntimeInput = {
        threadId: input.threadId,
        binary: options.binary,
        cwd,
        t3Home: options.t3Home,
        env: options.environment,
        projectId: input.threadId,
        profile: options.settings.profile,
        launchArgs: options.settings.launchArgs,
        runtimeMode: input.runtimeMode,
        ...(resume ? { cursor: resume } : {}),
        spawn: options.spawn,
      };
      const runtime = yield* (options.makeRuntime ?? makeNeoPiSessionRuntime)(runtimeInput).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Scope.Scope, sessionScope),
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      const entry: Session = {
        runtime,
        scope: sessionScope,
        pending: new Map(),
        ui: emptyUiState(),
        session: {
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd,
          createdAt: now,
          updatedAt: now,
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        },
      };
      toolState.set(entry, withHostToolNames(emptyToolState(), options.hostToolNames ?? []));
      yield* runtime.start.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause.message,
              cause,
            }),
        ),
        Effect.tapError(() => Scope.close(sessionScope, Exit.void)),
      );
      entry.ui.capabilities.clear();
      for (const capability of runtime.capabilities) entry.ui.capabilities.add(capability);
      // Explicit gate for #102; legacy select approvals remain available on older peers.
      if (!runtime.capabilities.has(NEOPI_CAP_TOOL_APPROVAL))
        entry.ui.capabilities.delete(NEOPI_CAP_TOOL_APPROVAL);
      entry.session = {
        ...entry.session,
        status: "ready",
        resumeCursor: yield* SubscriptionRef.get(runtime.cursor),
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      };
      sessions.set(input.threadId, entry);
      yield* Stream.runForEach(runtime.frames, (frame) => processFrame(entry, frame)).pipe(
        Effect.forkIn(scope),
      );
      return entry.session;
    });
  const sendTurn: NeoPiAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const session = yield* requireSession(input.threadId);
      const images: Array<{ data: string; mimeType: string }> = [];
      const text = [input.input ?? ""];
      for (const attachment of input.attachments ?? []) {
        const path = resolveAttachmentPath({ attachmentsDir: options.attachmentsDir, attachment });
        if (!path)
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        if (attachment.type === "image") {
          const bytes = yield* fs
            .readFile(path)
            .pipe(Effect.mapError((cause) => rpcError(input.threadId, "prompt", cause)));
          images.push({
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        } else if (!text[0]?.includes(path))
          text.push(`Attached file "${attachment.name}": "${path}"`);
      }
      if (!text.some(Boolean) && !images.length)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Turn requires text or attachments.",
        });
      const turnId =
        session.activeTurnId ??
        TurnId.make(
          `neopi-${options.instanceId}-${DateTime.toEpochMillis(yield* DateTime.now)}-${++eventSequence}`,
        );
      const selection =
        input.modelSelection?.instanceId === options.instanceId ? input.modelSelection : undefined;
      const prompt = {
        text: text.filter(Boolean).join("\n\n"),
        images,
        ...(selection ? { modelSelection: selection } : {}),
        turnId,
      };
      if (session.activeTurnId)
        yield* session.runtime
          .steer(prompt)
          .pipe(Effect.mapError((cause) => rpcError(input.threadId, "steer", cause)));
      else {
        session.activeTurnId = turnId;
        yield* session.runtime.startTurn(prompt).pipe(
          Effect.mapError((cause) => rpcError(input.threadId, "prompt", cause)),
          Effect.tapError(() =>
            Effect.sync(() => {
              delete session.activeTurnId;
            }),
          ),
        );
        session.session = {
          ...session.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
      }
      if (prompt.text.startsWith("/"))
        yield* session.runtime.onSessionIdentityMayHaveChanged.pipe(Effect.ignore);
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: yield* SubscriptionRef.get(session.runtime.cursor),
      };
    });
  const respond = (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    value: Parameters<PendingUi["reply"]>[0],
    kind: PendingUi["kind"],
  ) =>
    Effect.gen(function* () {
      const session = yield* requireSession(threadId);
      const pending = session.pending.get(requestId);
      if (!pending || pending.kind !== kind)
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondUi",
          detail: `Unknown pending ${kind} request: ${requestId}`,
        });
      const response = pending.reply(value);
      if (response._tag === "ExtensionUi")
        yield* session.runtime
          .respondUi(response.frame)
          .pipe(Effect.mapError((cause) => rpcError(threadId, "respondUi", cause)));
      else
        yield* session.runtime
          .writeFrame(response.frame)
          .pipe(Effect.mapError((cause) => rpcError(threadId, "tool_approval_response", cause)));
      session.pending.delete(requestId);
      yield* publish(
        flushUiSettlements(context(session, DateTime.formatIso(yield* DateTime.now)), session.ui),
      );
    });
  const readThread: NeoPiAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const session = yield* requireSession(threadId);
      if ((yield* SubscriptionRef.get(session.runtime.state)) !== "ready")
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "get_messages_page",
          detail: "session_busy: retry when the NeoPi/OMP turn has settled",
        });
      const messages: unknown[] = [];
      let cursor: string | undefined;
      do {
        const page = record(
          yield* session.runtime
            .request({ type: "get_messages_page", ...(cursor ? { cursor } : {}) })
            .pipe(Effect.mapError((cause) => rpcError(threadId, "get_messages_page", cause))),
        );
        if (Array.isArray(page.messages)) messages.push(...page.messages);
        cursor =
          typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      } while (cursor);
      const turns: Array<{ id: TurnId; items: unknown[] }> = [];
      for (const message of messages) {
        const item = record(message);
        if (item.role === "user" || turns.length === 0)
          turns.push({ id: TurnId.make(`neopi-history-${turns.length + 1}`), items: [] });
        turns[turns.length - 1]!.items.push(message);
      }
      return { threadId, turns };
    });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.values()], stopInternal, { discard: true }),
  );
  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      promptlessTurnContinuation: false,
      supportsConversationRollback: false,
    },
    compaction: {
      type: "native",
      start: (threadId) =>
        Effect.flatMap(requireSession(threadId), (session) =>
          session.runtime
            .compact()
            .pipe(Effect.mapError((cause) => rpcError(threadId, "compact", cause))),
        ),
    },
    startSession,
    sendTurn,
    interruptTurn: (threadId) =>
      Effect.flatMap(requireSession(threadId), (session) =>
        session.runtime.interrupt.pipe(
          Effect.mapError((cause) => rpcError(threadId, "abort", cause)),
        ),
      ),
    respondToRequest: (threadId, requestId, decision) =>
      respond(threadId, requestId, decision, "approval"),
    respondToUserInput: (threadId, requestId, answers) =>
      respond(threadId, requestId, answers, "user-input"),
    stopSession: (threadId) => Effect.flatMap(requireSession(threadId), stopInternal),
    listSessions: () =>
      Effect.forEach([...sessions.values()], (session) =>
        SubscriptionRef.get(session.runtime.cursor).pipe(
          Effect.map((resumeCursor) => ({ ...session.session, resumeCursor })),
        ),
      ),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread,
    rollbackThread: (threadId) =>
      Effect.flatMap(requireSession(threadId), () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: "conversation rollback not available yet",
          }),
        ),
      ),
    stopAll: () => Effect.forEach([...sessions.values()], stopInternal, { discard: true }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies NeoPiAdapterShape;
});
