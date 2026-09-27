import { randomUUID } from "node:crypto";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type NeoPiSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import type { SpawnFn } from "effect-neopi-rpc/client";
import type { NeoPiChatMode, SetChatModeCommand } from "effect-neopi-rpc/schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { resolveActiveMcpCredential } from "../../mcp/McpSessionRegistry.ts";
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
import { emptySubagentState, mapSubagentFrame } from "../neopi/mappers/subagents.ts";
import {
  emptyUiState,
  flushUiSettlements,
  mapUiRequest,
  NEOPI_CAP_TOOL_APPROVAL,
  type PendingUi,
} from "../neopi/mappers/ui.ts";
import { toNeoPiCommandCatalog, type NeoPiAvailableCommand } from "../neopi/NeoPiCommandCatalog.ts";
import { NEOPI_CAPABILITIES } from "../neopi/NeoPiCompatibility.ts";
import type { NeoPiDiscoveryHub } from "../neopi/NeoPiDiscovery.ts";
import { makeNeoPiHostToolBridge, type NeoPiHostToolBridge } from "../neopi/NeoPiHostToolBridge.ts";
import { makeNeoPiSessionRuntime, type NeoPiRuntimeInput } from "../neopi/NeoPiSessionRuntime.ts";
import { groupNeoPiHistory, rollbackNeoPiConversation } from "../neopi/NeoPiRollback.ts";
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

function parseResumeCursor(value: unknown): NeoPiResumeCursor | undefined {
  if (value === undefined || value === null) return undefined;
  const cursor = record(value);
  if (
    cursor.v !== 1 ||
    typeof cursor.sessionId !== "string" ||
    !cursor.sessionId ||
    typeof cursor.sessionFile !== "string" ||
    !cursor.sessionFile ||
    typeof cursor.sessionDir !== "string" ||
    !cursor.sessionDir ||
    !Array.isArray(cursor.turnBoundaries) ||
    !cursor.turnBoundaries.every((boundary) => {
      const entry = record(boundary);
      return (
        typeof entry.turnId === "string" &&
        entry.turnId.length > 0 &&
        ((typeof entry.userEntryId === "string" && entry.userEntryId.length > 0) ||
          entry.kind === "local" ||
          entry.kind === "unknown")
      );
    })
  )
    throw new Error("Invalid NeoPi/OMP resume cursor: refusing to start a fresh session");
  return cursor as NeoPiResumeCursor;
}

interface Session {
  session: ProviderSession;
  runtime: NeoPiSessionRuntimeShape;
  scope: Scope.Closeable;
  readonly sessionKey: string;
  readonly mcpProviderSessionId?: string;
  pending: Map<string, PendingUi>;
  ui: ReturnType<typeof emptyUiState>;
  activeTurnId?: TurnId;
  lastChatMode?: Exclude<NeoPiChatMode, "off">;
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
  readonly makeHostBridge?: (
    input: Parameters<typeof makeNeoPiHostToolBridge>[0],
  ) => Effect.Effect<NeoPiHostToolBridge>;
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
  const incarnationId = randomUUID();
  let eventSequence = 0;
  const stamp = (now: string): Pick<MapCtx, "now" | "newEventId"> => ({
    now: () => now,
    newEventId: () => `neopi-${options.instanceId}-${incarnationId}-${++eventSequence}`,
  });
  const context = (session: Session, now: string, turnId?: TurnId): MapCtx => ({
    provider: PROVIDER,
    providerInstanceId: options.instanceId,
    sessionKey: session.sessionKey,
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
      if (data.type === "available_commands_update") {
        const commands = Array.isArray(data.commands)
          ? data.commands.filter(
              (entry): entry is NeoPiAvailableCommand =>
                typeof entry === "object" && entry !== null && typeof entry.name === "string",
            )
          : [];
        const catalog = toNeoPiCommandCatalog(
          commands,
          new Set([...session.ui.capabilities, ...session.runtime.capabilities]),
        );
        yield* options.discovery.publish({
          cwd: session.session.cwd ?? options.cwd,
          source: "live",
          at: ctx.now(),
          commands: catalog.slashCommands,
          skills: catalog.skills,
        });
      }
      const chatMode =
        data.type === "t3.state"
          ? record(data.state).chatMode
          : data.type === "chat_mode_changed"
            ? data.mode
            : undefined;
      if (chatMode === "chat" || chatMode === "erp" || chatMode === "raw")
        session.lastChatMode = chatMode;
      if (
        data.type === "extension_ui_request" &&
        data.method === "cancel" &&
        typeof data.targetId === "string"
      )
        session.pending.delete(ApprovalRequestId.make(data.targetId));
      if (data.type === "tool_approval_cancel" && typeof data.targetId === "string")
        session.pending.delete(ApprovalRequestId.make(data.targetId));
      const core = mapCoreFrame(ctx, frame, coreState.get(session) ?? emptyCoreState());
      coreState.set(session, core.state);
      const tools = mapToolFrame(ctx, frame, toolState.get(session) ?? emptyToolState());
      toolState.set(session, tools.state);
      const ui = mapUiRequest(ctx, frame, session.ui);
      if (ui.pending) session.pending.set(ui.pending.requestId, ui.pending);
      const subagents = mapSubagentFrame(
        ctx,
        frame,
        subagentState.get(session) ?? emptySubagentState(),
        [...(toolState.get(session)?.hostToolNames ?? [])],
      );
      subagentState.set(session, subagents.state);
      yield* publish([...core.events, ...tools.events, ...subagents.events, ...ui.events]);
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
        if (sessions.get(session.session.threadId) === session) {
          sessions.delete(session.session.threadId);
          yield* stopInternal(session).pipe(Effect.forkIn(scope));
        }
      }
    });
  const coreState = new WeakMap<Session, ReturnType<typeof emptyCoreState>>();
  const toolState = new WeakMap<Session, ReturnType<typeof emptyToolState>>();
  const subagentState = new WeakMap<Session, ReturnType<typeof emptySubagentState>>();
  const stopInternal = (session: Session) =>
    Effect.gen(function* () {
      if (sessions.get(session.session.threadId) === session)
        sessions.delete(session.session.threadId);
      yield* session.runtime.stop;
      yield* Scope.close(session.scope, Exit.void);
    });
  const startSession: NeoPiAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const requestedResume = yield* Effect.try({
        try: () => parseResumeCursor(input.resumeCursor),
        catch: (cause) =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: String(cause),
          }),
      });
      const cwd = input.cwd ?? options.cwd;
      const existing = sessions.get(input.threadId);
      const issuedMcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
      const mcpSession =
        issuedMcpSession?.providerInstanceId === options.instanceId ? issuedMcpSession : undefined;
      const credentialChanged =
        existing !== undefined && existing.mcpProviderSessionId !== mcpSession?.providerSessionId;
      const latestCursor = credentialChanged
        ? yield* SubscriptionRef.get(existing.runtime.cursor)
        : undefined;
      if (
        existing &&
        (existing.session.cwd !== cwd ||
          (requestedResume !== undefined &&
            requestedResume.sessionFile !==
              (yield* SubscriptionRef.get(existing.runtime.cursor)).sessionFile) ||
          (yield* SubscriptionRef.get(existing.runtime.state)) === "failed" ||
          credentialChanged ||
          (yield* SubscriptionRef.get(existing.runtime.state)) === "stopped")
      ) {
        yield* stopInternal(existing);
      }
      if (existing && sessions.get(input.threadId) === existing) {
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
          if ((yield* SubscriptionRef.get(existing.runtime.state)) === "ready")
            existing.session = { ...existing.session, runtimeMode: input.runtimeMode };
        }
        return existing.session;
      }
      const resume =
        requestedResume && requestedResume.sessionFile !== latestCursor?.sessionFile
          ? requestedResume
          : (latestCursor ?? requestedResume);
      const invocation = mcpSession
        ? yield* resolveActiveMcpCredential(mcpSession.authorizationHeader)
        : undefined;
      const hostBridge =
        invocation &&
        mcpSession &&
        invocation.threadId === input.threadId &&
        invocation.providerInstanceId === options.instanceId &&
        invocation.providerSessionId === mcpSession.providerSessionId
          ? yield* (options.makeHostBridge ?? makeNeoPiHostToolBridge)({
              threadId: input.threadId,
              capabilities: invocation.capabilities,
              credential: mcpSession.authorizationHeader,
              context: invocation,
            })
          : undefined;
      const sessionScope = yield* Scope.make();
      const deviceEnvironment = McpProviderSession.withAgentDeviceEnvironment(
        options.environment,
        hostBridge ? mcpSession : undefined,
      );
      const runtimeInput: NeoPiRuntimeInput = {
        threadId: input.threadId,
        binary: options.binary,
        cwd,
        t3Home: options.t3Home,
        env: Object.fromEntries(
          Object.entries(deviceEnvironment).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        projectId: input.threadId,
        profile: options.settings.profile,
        launchArgs: options.settings.launchArgs,
        runtimeMode: input.runtimeMode,
        ...(resume ? { cursor: resume } : {}),
        spawn: options.spawn,
        ...(hostBridge ? { hostBridge } : {}),
      };
      const runtime = yield* (options.makeRuntime ?? makeNeoPiSessionRuntime)(runtimeInput).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Scope.Scope, sessionScope),
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      const entry: Session = {
        runtime,
        ...(hostBridge && mcpSession ? { mcpProviderSessionId: mcpSession.providerSessionId } : {}),
        scope: sessionScope,
        sessionKey: randomUUID(),
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
      toolState.set(
        entry,
        withHostToolNames(emptyToolState(), hostBridge?.definitions.map((tool) => tool.name) ?? []),
      );
      // Startup dialogs must be routable while runtime.start checks the session identity.
      sessions.set(input.threadId, entry);
      yield* Stream.runForEach(runtime.frames, (frame) => processFrame(entry, frame)).pipe(
        Effect.forkIn(sessionScope),
      );
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
        Effect.tapError(() => stopInternal(entry)),
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
      if (runtime.capabilities.has(NEOPI_CAPABILITIES.setChatMode)) {
        const state = yield* runtime.request({ type: "get_state" }).pipe(Effect.option);
        if (state._tag === "Some")
          yield* processFrame(entry, { type: "t3.state", state: state.value });
      }
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
      if (
        session.runtime.capabilities.has(NEOPI_CAPABILITIES.setChatMode) &&
        /^\/chat(?:\s|$)/.test(prompt.text)
      ) {
        if (session.activeTurnId)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Change chat mode after the current turn finishes.",
          });
        const match = /^\/chat(?:\s+(chat|erp|raw|off))?(?:\s+--include\s+(\S+))?\s*$/.exec(
          prompt.text,
        );
        if (!match || images.length)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Use /chat [chat|erp|raw|off] [--include categories] without attachments.",
          });
        const current = record(
          yield* session.runtime
            .request({ type: "get_state" })
            .pipe(Effect.mapError((cause) => rpcError(input.threadId, "get_state", cause))),
        );
        const mode: NeoPiChatMode =
          match[1] === "chat" || match[1] === "erp" || match[1] === "raw" || match[1] === "off"
            ? match[1]
            : current.chatMode === "off"
              ? (session.lastChatMode ?? "chat")
              : "off";
        const command: SetChatModeCommand = {
          type: "set_chat_mode",
          mode,
          ...(match[2] ? { include: match[2] } : {}),
        };
        yield* session.runtime
          .request(command)
          .pipe(Effect.mapError((cause) => rpcError(input.threadId, "set_chat_mode", cause)));
        const updated = record(
          yield* session.runtime
            .request({ type: "get_state" })
            .pipe(Effect.mapError((cause) => rpcError(input.threadId, "get_state", cause))),
        );
        const previous = yield* SubscriptionRef.get(session.runtime.cursor);
        yield* SubscriptionRef.set(session.runtime.cursor, {
          ...previous,
          turnBoundaries: [...previous.turnBoundaries, { turnId, kind: "local" }],
        });
        yield* processFrame(session, { type: "agent_start", turnId });
        yield* processFrame(session, { type: "t3.state", state: updated, turnId });
        yield* processFrame(session, { type: "t3.turn.outcome", state: "completed", turnId });
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: yield* SubscriptionRef.get(session.runtime.cursor),
        };
      }
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
      pending.settle(value);
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
      const entries = record(
        yield* session.runtime
          .request({ type: "get_entries" })
          .pipe(Effect.mapError((cause) => rpcError(threadId, "get_entries", cause))),
      );
      const turns = yield* Effect.try({
        try: () =>
          groupNeoPiHistory(
            messages,
            entries.entries,
            entries.leafId,
            session.session.resumeCursor as NeoPiResumeCursor,
          ),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "readThread",
            detail: String(cause),
          }),
      });
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
      supportsConversationRollback: true,
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
    hasSession: (threadId) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session) return false;
        const state = yield* SubscriptionRef.get(session.runtime.state);
        return state !== "failed" && state !== "stopped" && state !== "stopping";
      }),
    readThread,
    rollbackThread: (threadId, numTurns) =>
      Effect.gen(function* () {
        const session = yield* requireSession(threadId);
        const status = yield* SubscriptionRef.get(session.runtime.state);
        if (status === "running")
          yield* session.runtime.interrupt.pipe(
            Effect.mapError((cause) => rpcError(threadId, "abort", cause)),
          );
        else if (status !== "ready")
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: "NeoPi/OMP session is not ready to branch",
          });
        if (status === "running") {
          let settled = false;
          for (let attempt = 0; attempt < 200; attempt++) {
            const current = yield* SubscriptionRef.get(session.runtime.state);
            if (current === "ready" && session.activeTurnId === undefined) {
              settled = true;
              break;
            }
            if (current === "failed" || current === "stopped") break;
            yield* Effect.sleep("50 millis");
          }
          if (!settled)
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "rollbackThread",
              detail: "NeoPi/OMP abort did not settle; refusing to branch a running session",
            });
        }
        const cursor = yield* SubscriptionRef.get(session.runtime.cursor);
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        const next = yield* Effect.tryPromise({
          try: () =>
            rollbackNeoPiConversation({
              cursor,
              numTurns,
              request: (command) => runPromise(session.runtime.request(command)),
              onBranched: async (branched) => {
                await runPromise(SubscriptionRef.set(session.runtime.cursor, branched));
                session.session = { ...session.session, resumeCursor: branched };
              },
            }),
          catch: (cause) =>
            rpcError(
              threadId,
              "rollbackThread",
              cause instanceof Error ? cause : { message: String(cause) },
            ),
        });
        yield* SubscriptionRef.set(session.runtime.cursor, next);
        session.session = { ...session.session, resumeCursor: next };
        return yield* readThread(threadId);
      }),
    stopAll: () => Effect.forEach([...sessions.values()], stopInternal, { discard: true }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies NeoPiAdapterShape;
});
