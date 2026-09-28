import {
  EventId,
  RuntimeItemId,
  type ProviderRuntimeEvent,
  type TurnTokenUsage,
} from "@t3tools/contracts";

import { scopedItemId, type MapCtx } from "./MapCtx.ts";

/**
 * Frames the runtime injects around native RPC events. Native `agent_end`
 * never settles a turn; N3 injects `t3.turn.outcome` after it decides the
 * terminal state. `t3.state` is the post-settle / post-compaction
 * `get_state` snapshot. `t3.compaction` covers a manual compact that did
 * not also surface `auto_compaction_end`.
 */
export const T3_TURN_OUTCOME_TYPE = "t3.turn.outcome";
export const T3_STATE_TYPE = "t3.state";
export const T3_COMPACTION_TYPE = "t3.compaction";

const TURN_STATES = ["completed", "failed", "interrupted", "cancelled"] as const;
type TurnState = (typeof TURN_STATES)[number];

export interface CoreState {
  readonly model: string | undefined;
  readonly thinkingLevel: string | undefined;
  readonly nextMessageOrdinal: number;
  readonly turnStarted: boolean;
  readonly openMessageOrdinal: number | undefined;
  readonly messages: ReadonlyArray<AssistantMessageRecord>;
  readonly openItems: Readonly<Record<string, OpenContentItem>>;
  readonly usage: UsageTotals;
  readonly hasSubagents: boolean;
  readonly compaction: CompactionTracker | undefined;
  readonly commandSeq: number;
}

interface AssistantMessageRecord {
  readonly ordinal: number;
  readonly signature: string;
  readonly hasUsage: boolean;
  readonly terminal: boolean;
}

interface OpenContentItem {
  readonly itemId: string;
  readonly ordinal: number;
  readonly contentIndex: number;
  readonly itemType: "assistant_message" | "reasoning";
  readonly text: string;
  readonly started: boolean;
  readonly pendingComplete: boolean;
  readonly failed: boolean;
}

interface UsageTotals {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly sawReasoning: boolean;
  readonly totalCostUsd: number;
  readonly sawCost: boolean;
  readonly withUsage: number;
  readonly withoutUsage: number;
}

interface CompactionTracker {
  readonly itemId: string;
  readonly open: boolean;
  readonly settled: boolean;
  readonly beforeTokens: number | undefined;
  readonly afterTokens: number | undefined;
}

interface ParsedUsage {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly reasoning: number | undefined;
  readonly costTotal: number | undefined;
}

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  sawReasoning: false,
  totalCostUsd: 0,
  sawCost: false,
  withUsage: 0,
  withoutUsage: 0,
};

export function emptyCoreState(): CoreState {
  return {
    model: undefined,
    thinkingLevel: undefined,
    nextMessageOrdinal: 1,
    turnStarted: false,
    openMessageOrdinal: undefined,
    messages: [],
    openItems: {},
    usage: EMPTY_USAGE,
    hasSubagents: false,
    compaction: undefined,
    commandSeq: 0,
  };
}

/** Turn usage accumulated since the last `agent_start`, after dedupe. */
export function coreTurnTokenUsage(state: CoreState): TurnTokenUsage {
  return tokenUsageFrom(state);
}

export function mapCoreFrame(
  ctx: MapCtx,
  frame: unknown,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const record = asRecord(frame);
  if (!record || typeof record.type !== "string") {
    return { events: [], state };
  }
  switch (record.type) {
    case "agent_start":
      return mapAgentStart(ctx, record, state);
    case "message_start":
      return mapMessageStart(record, state);
    case "message_update":
      return mapMessageUpdate(ctx, record, state);
    case "message_end":
      return mapMessageEnd(ctx, record, state);
    case "agent_end":
      return mapAgentEnd(ctx, record, state);
    case "turn_end": {
      const closed = closeOpenContent(ctx, record, state, state.openMessageOrdinal, false);
      return {
        events: closed.events,
        state: { ...closed.state, openMessageOrdinal: state.openMessageOrdinal },
      };
    }
    case "command_output":
      return mapCommandOutput(ctx, record, state);
    case "subagent_lifecycle":
    case "subagent_progress":
    case "subagent_event":
      return { events: [], state: { ...state, hasSubagents: true } };
    case "notice":
      return mapNotice(ctx, record, state);
    case "auto_retry_start":
      return mapAutoRetryStart(ctx, record, state);
    case "auto_retry_end":
      return mapAutoRetryEnd(ctx, record, state);
    case "retry_fallback_applied":
      return mapRetryFallback(ctx, record, state);
    case "config_update":
      return mapConfigUpdate(ctx, record, state);
    case "thinking_level_changed":
      return mapThinkingLevel(ctx, record, state);
    case "auto_compaction_start":
      return mapCompactionStart(ctx, record, state);
    case "auto_compaction_end":
      return mapCompactionEnd(ctx, record, state);
    case "extension_error":
      return mapExtensionError(ctx, record, state);
    case T3_TURN_OUTCOME_TYPE:
      return mapTurnOutcome(ctx, record, state);
    case T3_STATE_TYPE:
      return mapSessionState(ctx, record, state);
    case T3_COMPACTION_TYPE:
      return mapInjectedCompaction(ctx, record, state);
    case "t3.session.exited": {
      const stderr =
        typeof record.stderrTail === "string" ? record.stderrTail.trim().slice(-512) : "";
      const processStatus = [
        `code ${String(record.code ?? "unknown")}`,
        ...(typeof record.signal === "string" ? [`signal ${record.signal}`] : []),
      ].join(", ");
      return {
        events: [
          emit(ctx, frame, "session.exited", {
            reason:
              record.recoverable === true
                ? `NeoPi/OMP process exited (${processStatus})${stderr ? `: ${stderr}` : ""}`
                : "NeoPi/OMP session stopped",
            recoverable: record.recoverable === true,
            exitKind: record.recoverable === true ? "error" : "graceful",
          }),
        ],
        state,
      };
    }
    default:
      return { events: [], state };
  }
}

function mapAgentStart(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const model = modelSlug(frame.model) ?? text(frame.model) ?? state.model;
  const effort = text(frame.effort) ?? text(frame.thinkingLevel) ?? state.thinkingLevel;
  if (state.turnStarted) {
    return { events: [], state: { ...state, model, thinkingLevel: effort } };
  }
  const next: CoreState = {
    ...state,
    model,
    thinkingLevel: effort,
    turnStarted: true,
    openMessageOrdinal: undefined,
    messages: [],
    openItems: {},
    usage: EMPTY_USAGE,
    hasSubagents: false,
  };
  if (ctx.agentId !== undefined) {
    return { events: [], state: next };
  }
  return {
    events: [
      emit(ctx, frame, "turn.started", {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }),
    ],
    state: next,
  };
}

function mapMessageStart(
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const message = asRecord(frame.message);
  if (message?.role !== "assistant") {
    return { events: [], state: { ...state, openMessageOrdinal: undefined } };
  }
  return { events: [], state: openAssistant(state, message) };
}

function mapMessageUpdate(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const assistantEvent = asRecord(frame.assistantMessageEvent);
  if (!assistantEvent || typeof assistantEvent.type !== "string") {
    return { events: [], state };
  }
  const message =
    asRecord(frame.message) ?? asRecord(assistantEvent.partial) ?? asRecord(assistantEvent.message);
  let next =
    message?.role === "assistant" || message === undefined
      ? ensureOpenAssistant(state, message)
      : state;
  const kind = contentKind(assistantEvent.type);
  if (!kind || next.openMessageOrdinal === undefined) {
    if (assistantEvent.type === "error" || assistantEvent.type === "done") {
      const final = asRecord(assistantEvent.message) ?? asRecord(assistantEvent.error);
      if (final?.role === "assistant") {
        next = noteUsage(next, next.openMessageOrdinal, final, true);
        next = rememberSignature(next, next.openMessageOrdinal, signatureOf(final));
      }
      const closed = closeOpenContent(
        ctx,
        frame,
        next,
        next.openMessageOrdinal,
        assistantEvent.type === "error",
      );
      return {
        events: closed.events,
        state: { ...closed.state, openMessageOrdinal: next.openMessageOrdinal },
      };
    }
    return { events: [], state: next };
  }
  const contentIndex = contentIndexOf(assistantEvent);
  const itemType = kind === "thinking" ? "reasoning" : "assistant_message";
  const streamKind = kind === "thinking" ? "reasoning_text" : "assistant_text";
  const itemId = contentItemId(next.openMessageOrdinal, kind, contentIndex);
  let item = next.openItems[itemId];
  const events: ProviderRuntimeEvent[] = [];
  if (
    assistantEvent.type === "text_start" ||
    assistantEvent.type === "thinking_start" ||
    assistantEvent.type.endsWith("_delta")
  ) {
    if (!item) {
      item = {
        itemId,
        ordinal: next.openMessageOrdinal,
        contentIndex,
        itemType,
        text: "",
        started: false,
        pendingComplete: false,
        failed: false,
      };
    }
    if (!item.started) {
      events.push(
        emit(
          ctx,
          frame,
          "item.started",
          {
            itemType,
            status: "inProgress",
            title: itemType === "reasoning" ? "Thinking" : "Assistant",
          },
          itemId,
        ),
      );
      item = { ...item, started: true };
    }
  }
  if (assistantEvent.type.endsWith("_delta")) {
    const delta = typeof assistantEvent.delta === "string" ? assistantEvent.delta : "";
    if (item && delta.length > 0) {
      events.push(emit(ctx, frame, "content.delta", { streamKind, delta, contentIndex }, itemId));
      item = { ...item, text: item.text + delta };
    }
  }
  if (assistantEvent.type === "text_end" || assistantEvent.type === "thinking_end") {
    const finalText =
      typeof assistantEvent.content === "string" ? assistantEvent.content : (item?.text ?? "");
    if (!item) {
      item = {
        itemId,
        ordinal: next.openMessageOrdinal,
        contentIndex,
        itemType,
        text: finalText,
        started: false,
        pendingComplete: false,
        failed: false,
      };
    } else {
      item = { ...item, text: finalText || item.text };
    }
    item = { ...item, pendingComplete: true };
  }
  next = putItem(next, item);
  const flushed = flushReadyItems(ctx, frame, next, next.openMessageOrdinal, false);
  return { events: [...events, ...flushed.events], state: flushed.state };
}

function mapMessageEnd(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const message = asRecord(frame.message);
  if (message?.role !== "assistant") {
    return { events: [], state: { ...state, openMessageOrdinal: undefined } };
  }
  let next = state.openMessageOrdinal === undefined ? openAssistant(state, message) : state;
  next = noteUsage(next, next.openMessageOrdinal, message, true);
  next = rememberSignature(next, next.openMessageOrdinal, signatureOf(message));
  return closeOpenContent(ctx, frame, next, next.openMessageOrdinal, false);
}

function mapAgentEnd(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const messages = Array.isArray(frame.messages) ? frame.messages.filter(isAssistantMessage) : [];
  let next = pairAgentEndMessages(state, messages);
  const closed = closeOpenContent(ctx, frame, next, next.openMessageOrdinal, false);
  next = closed.state;
  return { events: closed.events, state: { ...next, openMessageOrdinal: undefined } };
}

function mapCommandOutput(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const textValue = typeof frame.text === "string" ? frame.text : "";
  if (textValue.length === 0) {
    return { events: [], state };
  }
  const seq = state.commandSeq + 1;
  const itemId = `neopi:command:${seq}`;
  const events = [
    emit(
      ctx,
      frame,
      "item.started",
      { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
      itemId,
    ),
    emit(ctx, frame, "content.delta", { streamKind: "assistant_text", delta: textValue }, itemId),
    emit(
      ctx,
      frame,
      "item.completed",
      { itemType: "assistant_message", status: "completed", title: "Assistant", detail: textValue },
      itemId,
    ),
  ];
  return { events, state: { ...state, commandSeq: seq } };
}

function mapNotice(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const message = text(frame.message);
  if (!message) return { events: [], state };
  const detail = noticeDetail(frame);
  if (frame.level === "error") {
    return {
      events: [
        emit(ctx, frame, "runtime.error", {
          message,
          class: "provider_error",
          ...(detail ? { detail } : {}),
        }),
      ],
      state,
    };
  }
  return {
    events: [emit(ctx, frame, "runtime.warning", { message, ...(detail ? { detail } : {}) })],
    state,
  };
}

function mapAutoRetryStart(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const attempt = nonNeg(frame.attempt);
  const maxAttempts = nonNeg(frame.maxAttempts);
  const message =
    text(frame.errorMessage) ??
    `NeoPi/OMP is retrying${attempt !== undefined ? ` (attempt ${attempt}${maxAttempts !== undefined ? `/${maxAttempts}` : ""})` : ""}`;
  return {
    events: [
      emit(ctx, frame, "runtime.warning", {
        message,
        detail: {
          ...(attempt !== undefined ? { attempt } : {}),
          ...(maxAttempts !== undefined ? { maxAttempts } : {}),
          ...(nonNeg(frame.delayMs) !== undefined ? { delayMs: nonNeg(frame.delayMs) } : {}),
          ...(frame.errorId !== undefined ? { errorId: frame.errorId } : {}),
        },
      }),
    ],
    state,
  };
}

function mapAutoRetryEnd(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  if (frame.success !== false) return { events: [], state };
  const message = text(frame.finalError) ?? "NeoPi/OMP retry failed";
  return {
    events: [
      emit(ctx, frame, "runtime.warning", {
        message,
        detail: {
          ...(nonNeg(frame.attempt) !== undefined ? { attempt: nonNeg(frame.attempt) } : {}),
        },
      }),
    ],
    state,
  };
}

function mapRetryFallback(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const fromModel = text(frame.from);
  const toModel = text(frame.to);
  if (!fromModel || !toModel) return { events: [], state };
  const role = text(frame.role);
  const reason = text(frame.reason) ?? (role ? `Retry fallback (${role})` : "Retry fallback");
  return {
    events: [emit(ctx, frame, "model.rerouted", { fromModel, toModel, reason })],
    state: { ...state, model: toModel },
  };
}

function mapConfigUpdate(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const hasModel = Object.prototype.hasOwnProperty.call(frame, "model");
  const hasThinking = Object.prototype.hasOwnProperty.call(frame, "thinkingLevel");
  const model = hasModel ? (modelSlug(frame.model) ?? text(frame.model)) : state.model;
  const thinkingLevel = hasThinking ? text(frame.thinkingLevel) : state.thinkingLevel;
  return metadataRefresh(
    ctx,
    frame,
    state,
    model,
    thinkingLevel,
    hasThinking && thinkingLevel === undefined,
  );
}

function mapThinkingLevel(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const thinkingLevel = text(frame.thinkingLevel) ?? text(frame.resolved) ?? text(frame.configured);
  return metadataRefresh(
    ctx,
    frame,
    state,
    state.model,
    thinkingLevel,
    thinkingLevel === undefined,
  );
}

function mapExtensionError(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  return {
    events: [
      emit(ctx, frame, "runtime.warning", {
        message: errorText(frame.error),
        detail: {
          ...(text(frame.extensionPath) ? { extensionPath: text(frame.extensionPath) } : {}),
          ...(text(frame.event) ? { event: text(frame.event) } : {}),
        },
      }),
    ],
    state,
  };
}

function mapCompactionStart(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  if (state.compaction?.open) return { events: [], state };
  const itemId = `neopi:compaction:${state.commandSeq + 1}`;
  const detail = text(frame.reason) ?? text(frame.action);
  return {
    events: [
      emit(
        ctx,
        frame,
        "item.started",
        {
          itemType: "context_compaction",
          status: "inProgress",
          title: "Context compaction",
          ...(detail ? { detail } : {}),
        },
        itemId,
      ),
    ],
    state: {
      ...state,
      commandSeq: state.commandSeq + 1,
      compaction: {
        itemId,
        open: true,
        settled: false,
        beforeTokens: undefined,
        afterTokens: undefined,
      },
    },
  };
}

function mapCompactionEnd(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const result = asRecord(frame.result);
  return settleCompaction(ctx, frame, state, {
    beforeTokens: nonNeg(result?.tokensBefore),
    afterTokens: nonNeg(result?.tokensAfter),
    skipped: frame.skipped === true,
    aborted: frame.aborted === true,
    errorMessage: text(frame.errorMessage),
    summary: text(result?.summary) ?? text(result?.shortSummary),
  });
}

function mapInjectedCompaction(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const result = asRecord(frame.result);
  return settleCompaction(ctx, frame, state, {
    beforeTokens:
      nonNeg(frame.beforeTokens) ?? nonNeg(frame.tokensBefore) ?? nonNeg(result?.tokensBefore),
    afterTokens:
      nonNeg(frame.afterTokens) ?? nonNeg(frame.tokensAfter) ?? nonNeg(result?.tokensAfter),
    skipped: frame.skipped === true,
    aborted: frame.aborted === true,
    errorMessage: text(frame.errorMessage),
    summary: text(frame.summary) ?? text(result?.summary),
  });
}

function mapTurnOutcome(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  if (!isTurnState(frame.state)) return { events: [], state };
  const closed = closeOpenContent(ctx, frame, state, undefined, frame.state === "failed");
  if (ctx.agentId !== undefined) {
    return { events: closed.events, state: resetTurn(closed.state) };
  }
  const errorMessage = text(frame.errorMessage);
  const tokenUsage = tokenUsageFrom(closed.state);
  const events: ProviderRuntimeEvent[] = [
    ...closed.events,
    emit(ctx, frame, "turn.completed", {
      state: frame.state,
      ...(errorMessage ? { errorMessage } : {}),
      tokenUsage,
      ...(closed.state.usage.sawCost ? { totalCostUsd: closed.state.usage.totalCostUsd } : {}),
    }),
  ];
  return { events, state: resetTurn(closed.state) };
}

function mapSessionState(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const session = asRecord(frame.state) ?? frame;
  const model = modelSlug(session.model) ?? text(session.model) ?? state.model;
  const thinkingLevel = Object.prototype.hasOwnProperty.call(session, "thinkingLevel")
    ? text(session.thinkingLevel)
    : state.thinkingLevel;
  const next: CoreState = { ...state, model, thinkingLevel };
  const context = asRecord(session.contextUsage);
  const usedTokens = nonNeg(context?.tokens);
  if (usedTokens === undefined) return { events: [], state: next };
  const maxTokens = positive(context?.contextWindow);
  return {
    events: [
      emit(ctx, frame, "thread.token-usage.updated", {
        usage: {
          usedTokens,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        },
      }),
    ],
    state: next,
  };
}

function metadataRefresh(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
  model: string | undefined,
  thinkingLevel: string | undefined,
  clearThinking: boolean,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const next: CoreState = {
    ...state,
    model,
    thinkingLevel: clearThinking ? undefined : thinkingLevel,
  };
  const metadata: Record<string, unknown> = {};
  if (model) metadata.model = model;
  if (thinkingLevel) metadata.thinkingLevel = thinkingLevel;
  else if (clearThinking) metadata.thinkingLevel = null;
  if (Object.keys(metadata).length === 0) return { events: [], state: next };
  return {
    events: [emit(ctx, frame, "thread.metadata.updated", { metadata })],
    state: next,
  };
}

function settleCompaction(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: CoreState,
  input: {
    readonly beforeTokens: number | undefined;
    readonly afterTokens: number | undefined;
    readonly skipped: boolean;
    readonly aborted: boolean;
    readonly errorMessage: string | undefined;
    readonly summary: string | undefined;
  },
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const failed = input.aborted || input.errorMessage !== undefined;
  const itemId = state.compaction?.itemId ?? `neopi:compaction:${state.commandSeq + 1}`;
  const beforeTokens = input.beforeTokens ?? state.compaction?.beforeTokens;
  const afterTokens = input.afterTokens ?? state.compaction?.afterTokens;
  const events: ProviderRuntimeEvent[] = [];
  if (!state.compaction?.open && !state.compaction) {
    events.push(
      emit(
        ctx,
        frame,
        "item.started",
        { itemType: "context_compaction", status: "inProgress", title: "Context compaction" },
        itemId,
      ),
    );
  }
  const status = input.skipped ? "declined" : failed ? "failed" : "completed";
  const alreadyClosed = state.compaction?.settled === true && state.compaction.open === false;
  if (!alreadyClosed) {
    events.push(
      emit(
        ctx,
        frame,
        "item.completed",
        {
          itemType: "context_compaction",
          status,
          title: "Context compaction",
          ...(input.summary
            ? { detail: input.summary }
            : input.errorMessage
              ? { detail: input.errorMessage }
              : {}),
        },
        itemId,
      ),
    );
  }
  const shouldAnnounce =
    !input.skipped && !failed && !sameCompaction(state.compaction, beforeTokens, afterTokens);
  if (shouldAnnounce) {
    events.push(
      emit(ctx, frame, "thread.state.changed", {
        state: "compacted",
        ...(beforeTokens !== undefined ? { beforeTokens } : {}),
        ...(afterTokens !== undefined ? { afterTokens } : {}),
        ...(input.summary ? { detail: input.summary } : {}),
      }),
    );
  }
  return {
    events,
    state: {
      ...state,
      commandSeq: state.compaction ? state.commandSeq : state.commandSeq + 1,
      compaction: {
        itemId,
        open: false,
        settled: true,
        beforeTokens,
        afterTokens,
      },
    },
  };
}

function closeOpenContent(
  ctx: MapCtx,
  frame: unknown,
  state: CoreState,
  ordinal: number | undefined,
  failed: boolean,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const openItems = Object.values(state.openItems).map((item) =>
    ordinal !== undefined && item.ordinal !== ordinal
      ? item
      : { ...item, pendingComplete: true, failed: failed || item.failed },
  );
  let next = state;
  for (const item of openItems) next = putItem(next, item);
  const flushed = flushReadyItems(ctx, frame, next, ordinal, true);
  return {
    events: flushed.events,
    state: { ...flushed.state, openMessageOrdinal: undefined },
  };
}

function flushReadyItems(
  ctx: MapCtx,
  frame: unknown,
  state: CoreState,
  ordinal: number | undefined,
  force: boolean,
): { readonly events: ProviderRuntimeEvent[]; readonly state: CoreState } {
  const items = Object.values(state.openItems).filter(
    (item) => ordinal === undefined || item.ordinal === ordinal,
  );
  const reasoningOpen = items.some(
    (item) => item.itemType === "reasoning" && !item.pendingComplete,
  );
  const ready = items
    .filter((item) => item.pendingComplete || force)
    .filter((item) => force || item.itemType === "reasoning" || !reasoningOpen)
    .sort((left, right) =>
      left.itemType === right.itemType
        ? left.contentIndex - right.contentIndex
        : left.itemType === "reasoning"
          ? -1
          : 1,
    );
  const events: ProviderRuntimeEvent[] = [];
  let next = state;
  for (const item of ready) {
    if (!item.started) {
      events.push(
        emit(
          ctx,
          frame,
          "item.started",
          {
            itemType: item.itemType,
            status: "inProgress",
            title: item.itemType === "reasoning" ? "Thinking" : "Assistant",
          },
          item.itemId,
        ),
      );
    }
    const status = item.failed ? "failed" : "completed";
    const payload = {
      itemType: item.itemType,
      status,
      title: item.itemType === "reasoning" ? "Thinking" : "Assistant",
      ...(item.text.trim().length > 0 ? { detail: item.text } : {}),
    } as const;
    if (item.text.trim().length > 0) {
      events.push(emit(ctx, frame, "item.updated", payload, item.itemId));
    }
    events.push(emit(ctx, frame, "item.completed", payload, item.itemId));
    const { [item.itemId]: _removed, ...rest } = next.openItems;
    next = { ...next, openItems: rest };
  }
  return { events, state: next };
}

function openAssistant(state: CoreState, message: Record<string, unknown> | undefined): CoreState {
  const ordinal = state.nextMessageOrdinal;
  return {
    ...state,
    nextMessageOrdinal: ordinal + 1,
    openMessageOrdinal: ordinal,
    messages: [
      ...state.messages,
      { ordinal, signature: message ? signatureOf(message) : "", hasUsage: false, terminal: false },
    ],
  };
}

function ensureOpenAssistant(
  state: CoreState,
  message: Record<string, unknown> | undefined,
): CoreState {
  if (state.openMessageOrdinal !== undefined) return state;
  return openAssistant(state, message);
}

function noteUsage(
  state: CoreState,
  ordinal: number | undefined,
  message: Record<string, unknown>,
  terminal: boolean,
): CoreState {
  if (ordinal === undefined) return state;
  const usage = readUsage(message);
  const existing = state.messages.find((entry) => entry.ordinal === ordinal);
  if (!existing) return state;
  if (existing.hasUsage) {
    return terminal && !existing.terminal
      ? replaceMessage(state, { ...existing, terminal: true })
      : state;
  }
  if (!usage) {
    if (!terminal || existing.terminal) return state;
    return {
      ...replaceMessage(state, {
        ...existing,
        terminal: true,
        signature: existing.signature || signatureOf(message),
      }),
      usage: { ...state.usage, withoutUsage: state.usage.withoutUsage + 1 },
    };
  }
  const wasLacking = existing.terminal;
  return {
    ...replaceMessage(state, {
      ...existing,
      hasUsage: true,
      terminal: terminal || existing.terminal,
      signature: signatureOf(message) || existing.signature,
    }),
    usage: addUsage(state.usage, usage, wasLacking),
  };
}

function rememberSignature(
  state: CoreState,
  ordinal: number | undefined,
  signature: string,
): CoreState {
  if (ordinal === undefined || signature.length === 0) return state;
  const existing = state.messages.find((entry) => entry.ordinal === ordinal);
  if (!existing || existing.signature === signature) return state;
  return replaceMessage(state, { ...existing, signature });
}

function pairAgentEndMessages(
  state: CoreState,
  messages: ReadonlyArray<Record<string, unknown>>,
): CoreState {
  const existing = state.messages;
  const matched = new Set<number>();
  const pairs: Array<number | undefined> = messages.map(() => undefined);
  // Match stable message identities first; repeated signatures still consume distinct ordinals.
  messages.forEach((message, index) => {
    const signature = signatureOf(message);
    if (!signature) return;
    const match = existing.findIndex(
      (entry, candidate) => !matched.has(candidate) && entry.signature === signature,
    );
    if (match < 0) return;
    matched.add(match);
    pairs[index] = existing[match]?.ordinal;
  });
  // Native compact terminal frames can contain only a suffix of the streamed messages.
  // Preserve the original indices while matching leftovers; never splice the candidates.
  const offset = Math.max(0, existing.length - messages.length);
  messages.forEach((_, index) => {
    if (pairs[index] !== undefined) return;
    const preferred = messages.length < existing.length ? index + offset : index;
    const candidate = !matched.has(preferred)
      ? preferred
      : existing.findIndex((entry, position) => position >= offset && !matched.has(position));
    if (candidate < 0 || candidate >= existing.length) return;
    matched.add(candidate);
    pairs[index] = existing[candidate]?.ordinal;
  });
  let next = state;
  messages.forEach((message, index) => {
    const ordinal = pairs[index];
    if (ordinal !== undefined) {
      next = noteUsage(next, ordinal, message, true);
      return;
    }
    next = openAssistant(next, message);
    next = noteUsage(next, next.openMessageOrdinal, message, true);
  });
  return { ...next, openMessageOrdinal: state.openMessageOrdinal };
}

function addUsage(totals: UsageTotals, usage: ParsedUsage, wasLacking: boolean): UsageTotals {
  return {
    inputTokens: totals.inputTokens + usage.input + usage.cacheRead + usage.cacheWrite,
    cachedInputTokens: totals.cachedInputTokens + usage.cacheRead,
    cacheCreationTokens: totals.cacheCreationTokens + usage.cacheWrite,
    outputTokens: totals.outputTokens + usage.output,
    reasoningTokens: totals.reasoningTokens + (usage.reasoning ?? 0),
    sawReasoning: totals.sawReasoning || usage.reasoning !== undefined,
    totalCostUsd: totals.totalCostUsd + (usage.costTotal ?? 0),
    sawCost: totals.sawCost || usage.costTotal !== undefined,
    withUsage: totals.withUsage + 1,
    withoutUsage: wasLacking ? Math.max(0, totals.withoutUsage - 1) : totals.withoutUsage,
  };
}

function tokenUsageFrom(state: CoreState): TurnTokenUsage {
  const common = {
    usageScope: "main_agent" as const,
    hasSubagents: state.hasSubagents,
    ...(state.usage.withUsage > 0
      ? {
          cachedInputTokens: state.usage.cachedInputTokens,
          cacheCreationTokens: state.usage.cacheCreationTokens,
          ...(state.usage.sawReasoning ? { reasoningTokens: state.usage.reasoningTokens } : {}),
        }
      : {}),
  };
  if (state.usage.withUsage === 0) {
    return { ...common, usageStatus: "unavailable" };
  }
  if (state.usage.withoutUsage > 0) {
    return {
      ...common,
      usageStatus: "partial",
      inputTokens: state.usage.inputTokens,
      outputTokens: state.usage.outputTokens,
    };
  }
  return {
    ...common,
    usageStatus: "complete",
    inputTokens: state.usage.inputTokens,
    outputTokens: state.usage.outputTokens,
  };
}

function resetTurn(state: CoreState): CoreState {
  return {
    ...state,
    turnStarted: false,
    openMessageOrdinal: undefined,
    messages: [],
    openItems: {},
    usage: EMPTY_USAGE,
    hasSubagents: false,
  };
}

function replaceMessage(state: CoreState, message: AssistantMessageRecord): CoreState {
  return {
    ...state,
    messages: state.messages.map((entry) => (entry.ordinal === message.ordinal ? message : entry)),
  };
}

function putItem(state: CoreState, item: OpenContentItem | undefined): CoreState {
  if (!item) return state;
  return { ...state, openItems: { ...state.openItems, [item.itemId]: item } };
}

function contentItemId(ordinal: number, kind: "text" | "thinking", contentIndex: number): string {
  return `neopi:m${ordinal}:${kind}:${contentIndex}`;
}

function contentKind(type: string): "text" | "thinking" | undefined {
  if (type.startsWith("text_")) return "text";
  if (type.startsWith("thinking_")) return "thinking";
  return undefined;
}

function contentIndexOf(event: Record<string, unknown>): number {
  return nonNeg(event.contentIndex) ?? 0;
}

function signatureOf(message: Record<string, unknown>): string {
  const usage = asRecord(message.usage);
  const body = {
    timestamp: message.timestamp ?? null,
    responseId: message.responseId ?? null,
    provider: message.provider ?? null,
    model: message.model ?? null,
    text: contentFingerprint(message.content),
    input: usage?.input ?? null,
    output: usage?.output ?? null,
    cacheRead: usage?.cacheRead ?? null,
    cacheWrite: usage?.cacheWrite ?? null,
  };
  const empty =
    body.timestamp === null &&
    body.responseId === null &&
    body.provider === null &&
    body.model === null &&
    body.text === "" &&
    body.input === null;
  return empty ? "" : JSON.stringify(body);
}

function contentFingerprint(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      if (!record) return "";
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "thinking" && typeof record.thinking === "string") return record.thinking;
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

function readUsage(message: Record<string, unknown>): ParsedUsage | undefined {
  const usage = asRecord(message.usage);
  if (!usage) return undefined;
  const input = nonNeg(usage.input);
  const output = nonNeg(usage.output);
  const cacheRead = nonNeg(usage.cacheRead);
  const cacheWrite = nonNeg(usage.cacheWrite);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    input: input ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    output: output ?? 0,
    reasoning: nonNeg(usage.reasoningTokens),
    costTotal: readCost(usage.cost),
  };
}

function readCost(cost: unknown): number | undefined {
  const record = asRecord(cost);
  const total = record?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

function isAssistantMessage(value: unknown): value is Record<string, unknown> {
  return asRecord(value)?.role === "assistant";
}

function modelSlug(model: unknown): string | undefined {
  const record = asRecord(model);
  if (!record) return undefined;
  const provider = text(record.provider);
  const id = text(record.id) ?? text(record.modelId);
  if (provider && id) return `${provider}/${id}`;
  return id;
}

function noticeDetail(frame: Record<string, unknown>): Record<string, unknown> | undefined {
  const detail: Record<string, unknown> = {};
  if (typeof frame.level === "string") detail.level = frame.level;
  const source = text(frame.source);
  if (source) detail.source = source;
  return Object.keys(detail).length > 0 ? detail : undefined;
}

function errorText(error: unknown): string {
  const direct = text(error);
  if (direct) return direct;
  const record = asRecord(error);
  return text(record?.message) ?? text(record?.error) ?? "NeoPi/OMP extension error";
}

function sameCompaction(
  tracker: CompactionTracker | undefined,
  beforeTokens: number | undefined,
  afterTokens: number | undefined,
): boolean {
  if (!tracker?.settled) return false;
  return tracker.beforeTokens === beforeTokens && tracker.afterTokens === afterTokens;
}

function emit<T extends ProviderRuntimeEvent["type"]>(
  ctx: MapCtx,
  frame: unknown,
  type: T,
  payload: Extract<ProviderRuntimeEvent, { type: T }>["payload"],
  itemId?: string,
): Extract<ProviderRuntimeEvent, { type: T }> {
  const agent =
    ctx.agentId !== undefined &&
    (type === "item.started" || type === "item.updated" || type === "item.completed")
      ? {
          ...(payload && typeof payload === "object" ? payload : {}),
          agentId: ctx.agentId,
          ...(ctx.parentToolUseId ? { parentToolUseId: ctx.parentToolUseId } : {}),
        }
      : payload;
  return {
    type,
    eventId: EventId.make(ctx.newEventId()),
    provider: ctx.provider,
    providerInstanceId: ctx.providerInstanceId,
    threadId: ctx.threadId,
    createdAt: ctx.now(),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    ...(itemId ? { itemId: RuntimeItemId.make(scopedItemId(ctx, itemId)) } : {}),
    payload: agent,
    raw: { source: "neopi.rpc", payload: frame },
  } as Extract<ProviderRuntimeEvent, { type: T }>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonNeg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function positive(value: unknown): number | undefined {
  const parsed = nonNeg(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function isTurnState(value: unknown): value is TurnState {
  return typeof value === "string" && (TURN_STATES as ReadonlyArray<string>).includes(value);
}
