import {
  EventId,
  RuntimeTaskId,
  type ProviderRuntimeEvent,
  type RuntimeTaskStatus,
  type RuntimeTaskUsage,
} from "@t3tools/contracts";

import { coreTurnTokenUsage, emptyCoreState, mapCoreFrame, type CoreState } from "./core.ts";
import type { MapCtx } from "./MapCtx.ts";
import { emptyToolState, mapToolFrame, withHostToolNames, type ToolState } from "./tools.ts";

/**
 * Nested NeoPi/OMP subagents. Lifecycle and progress become the same task.*
 * rows Claude and Codex use for the Agents surface. Child session events are
 * re-entered through the core and tool mappers with an agent-scoped MapCtx,
 * so item ids and tool state cannot collide with the parent turn.
 *
 * Child assistant/reasoning deltas are not republished as content.delta.
 * Ingestion appends those stream kinds to the parent answer, and the payload
 * schema has no agentId to re-home them. Claude drops the same narration.
 * The child's text is attributed on task.progress instead, and its token
 * totals stay on task.completed.typedUsage.
 */
export interface SubagentState {
  readonly runs: Readonly<Record<string, ChildRun>>;
  readonly generations: Readonly<Record<string, number>>;
  readonly toolOwners: Readonly<Record<string, string>>;
}

interface ChildRun {
  readonly nativeId: string;
  readonly taskId: string;
  readonly parentToolUseId?: string;
  readonly parentAgentId?: string;
  readonly description: string;
  readonly role?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly terminal: boolean;
  readonly core: CoreState;
  readonly tools: ToolState;
  readonly text: string;
  readonly toolUses: number;
  readonly lastSummary?: string;
}

export function emptySubagentState(): SubagentState {
  return { runs: {}, generations: {}, toolOwners: {} };
}

export function mapSubagentFrame(
  ctx: MapCtx,
  frame: unknown,
  state: SubagentState,
  hostToolNames?: ReadonlyArray<string>,
): { readonly events: ProviderRuntimeEvent[]; readonly state: SubagentState } {
  const record = asRecord(frame);
  if (!record || typeof record.type !== "string") return { events: [], state };
  switch (record.type) {
    case "subagent_lifecycle":
      return mapLifecycle(ctx, record, state, hostToolNames);
    case "subagent_progress":
      return mapProgress(ctx, record, state, hostToolNames);
    case "subagent_event":
      return mapEvent(ctx, record, state, hostToolNames);
    default:
      return { events: [], state };
  }
}

function mapLifecycle(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: SubagentState,
  hostToolNames: ReadonlyArray<string> | undefined,
): { readonly events: ProviderRuntimeEvent[]; readonly state: SubagentState } {
  const payload = payloadOf(frame);
  const id = text(payload.id);
  const status = text(payload.status);
  if (!id || !status) return { events: [], state };
  if (status === "started") return startRun(ctx, frame, state, id, payload, hostToolNames);
  if (status !== "completed" && status !== "failed" && status !== "aborted") {
    return { events: [], state };
  }
  const run = state.runs[id];
  if (!run || run.terminal) return { events: [], state };
  const typedUsage = taskUsage(run);
  return {
    events: [
      emit(ctx, frame, "task.completed", {
        taskId: RuntimeTaskId.make(run.taskId),
        status: status === "failed" ? "failed" : status === "aborted" ? "stopped" : "completed",
        ...(run.text.trim().length > 0 ? { summary: tail(run.text) } : {}),
        ...(typedUsage ? { typedUsage } : {}),
        ...linkage(run),
      }),
    ],
    state: putRun(state, { ...run, terminal: true }),
  };
}

function mapProgress(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: SubagentState,
  hostToolNames: ReadonlyArray<string> | undefined,
): { readonly events: ProviderRuntimeEvent[]; readonly state: SubagentState } {
  const payload = payloadOf(frame);
  const progress = asRecord(payload.progress) ?? {};
  const id = text(progress.id) ?? text(payload.id);
  if (!id) return { events: [], state };
  const opened = ensureRun(ctx, frame, state, id, payload, hostToolNames);
  const description = text(payload.task) ?? opened.run.description;
  const summary =
    progressSummary(progress) ??
    (opened.run.text.trim().length > 0 ? tail(opened.run.text) : undefined);
  const status = progressStatus(text(progress.status));
  const lastToolName = text(progress.currentTool);
  const lastSummary = summary ?? opened.run.lastSummary;
  const run = {
    ...opened.run,
    description,
    ...(lastSummary === undefined ? {} : { lastSummary }),
  };
  return {
    events: [
      ...opened.events,
      emit(ctx, frame, "task.progress", {
        taskId: RuntimeTaskId.make(run.taskId),
        description,
        ...(summary ? { summary } : {}),
        ...(status ? { status } : {}),
        ...(lastToolName ? { lastToolName } : {}),
        ...linkage(run),
      }),
    ],
    state: putRun(opened.state, run),
  };
}

function mapEvent(
  ctx: MapCtx,
  frame: Record<string, unknown>,
  state: SubagentState,
  hostToolNames: ReadonlyArray<string> | undefined,
): { readonly events: ProviderRuntimeEvent[]; readonly state: SubagentState } {
  const payload = payloadOf(frame);
  const id = text(payload.id);
  if (!id || payload.event === undefined) return { events: [], state };
  const opened = ensureRun(ctx, frame, state, id, payload, hostToolNames);
  const event = payload.event;
  const childCtx: MapCtx = {
    ...ctx,
    agentId: opened.run.taskId,
    ...(opened.run.parentToolUseId ? { parentToolUseId: opened.run.parentToolUseId } : {}),
  };
  const core = mapCoreFrame(childCtx, event, opened.run.core);
  const tools = mapToolFrame(childCtx, event, opened.run.tools);
  const eventRecord = asRecord(event);
  const textAdded = textFromChildEvent(eventRecord);
  const narration = textAdded.length > 0 ? `${opened.run.text}${textAdded}` : opened.run.text;
  const toolUses = opened.run.toolUses + (eventRecord?.type === "tool_execution_end" ? 1 : 0);
  const toolCallId =
    eventRecord?.type === "tool_execution_start" ? text(eventRecord.toolCallId) : undefined;
  const model = eventRecord?.type === "agent_start" ? modelSlug(eventRecord.model) : undefined;
  const effort =
    eventRecord?.type === "agent_start"
      ? (text(eventRecord.effort) ?? text(eventRecord.thinkingLevel))
      : undefined;
  const run: ChildRun = {
    ...opened.run,
    core: core.state,
    tools: tools.state,
    text: narration,
    toolUses,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
  const summary = textAdded.length > 0 ? tail(narration) : undefined;
  const progress =
    summary && summary !== run.lastSummary
      ? [
          emit(ctx, frame, "task.progress", {
            taskId: RuntimeTaskId.make(run.taskId),
            description: run.description,
            summary,
            status: "running",
            ...linkage(run),
          }),
        ]
      : [];
  return {
    events: [...opened.events, ...core.events.filter(keepChildEvent), ...tools.events, ...progress],
    state: {
      ...putRun(opened.state, { ...run, ...(summary ? { lastSummary: summary } : {}) }),
      ...(toolCallId
        ? { toolOwners: { ...opened.state.toolOwners, [toolCallId]: run.taskId } }
        : {}),
    },
  };
}

function startRun(
  ctx: MapCtx,
  frame: unknown,
  state: SubagentState,
  id: string,
  payload: Record<string, unknown>,
  hostToolNames: ReadonlyArray<string> | undefined,
): { readonly events: ProviderRuntimeEvent[]; readonly state: SubagentState } {
  const existing = state.runs[id];
  if (existing && !existing.terminal) {
    const description = text(payload.description) ?? existing.description;
    const run = description === existing.description ? existing : { ...existing, description };
    return { events: [], state: run === existing ? state : putRun(state, run) };
  }
  const generation = (state.generations[id] ?? 0) + 1;
  const parentToolUseId = text(payload.parentToolCallId);
  const role = text(payload.agent);
  const run: ChildRun = {
    nativeId: id,
    taskId: generation === 1 ? id : `${id}#${generation}`,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    ...(parentToolUseId && state.toolOwners[parentToolUseId]
      ? { parentAgentId: state.toolOwners[parentToolUseId] }
      : {}),
    description: text(payload.description) ?? text(payload.agent) ?? id,
    ...(role ? { role } : {}),
    terminal: false,
    core: emptyCoreState(),
    tools: withHostToolNames(emptyToolState(), hostToolNames ?? []),
    text: "",
    toolUses: 0,
  };
  return {
    events: [taskStarted(ctx, frame, run)],
    state: {
      ...state,
      generations: { ...state.generations, [id]: generation },
      runs: { ...state.runs, [id]: run },
    },
  };
}

function ensureRun(
  ctx: MapCtx,
  frame: unknown,
  state: SubagentState,
  id: string,
  payload: Record<string, unknown>,
  hostToolNames: ReadonlyArray<string> | undefined,
): {
  readonly events: ProviderRuntimeEvent[];
  readonly state: SubagentState;
  readonly run: ChildRun;
} {
  const existing = state.runs[id];
  if (existing && !existing.terminal) return { events: [], state, run: existing };
  const started = startRun(ctx, frame, state, id, payload, hostToolNames);
  const run = started.state.runs[id];
  if (!run) return { events: [], state, run: existing ?? placeholder(id) };
  return { events: started.events, state: started.state, run };
}

function taskStarted(ctx: MapCtx, frame: unknown, run: ChildRun): ProviderRuntimeEvent {
  return emit(ctx, frame, "task.started", {
    taskId: RuntimeTaskId.make(run.taskId),
    description: run.description,
    ...linkage(run),
  });
}

function linkage(run: ChildRun): {
  taskType: "subagent";
  agentId: string;
  title?: string;
  role?: string;
  model?: string;
  effort?: string;
  toolUseId?: string;
  parentToolUseId?: string;
  parentAgentId?: string;
  timelineBypass: true;
} {
  return {
    taskType: "subagent",
    agentId: run.taskId,
    ...(run.description ? { title: run.description } : {}),
    ...(run.role ? { role: run.role } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.effort ? { effort: run.effort } : {}),
    ...(run.parentToolUseId
      ? { toolUseId: run.parentToolUseId, parentToolUseId: run.parentToolUseId }
      : {}),
    ...(run.parentAgentId ? { parentAgentId: run.parentAgentId } : {}),
    timelineBypass: true,
  };
}

function taskUsage(run: ChildRun): RuntimeTaskUsage | undefined {
  const usage = coreTurnTokenUsage(run.core);
  if (usage.usageStatus === "unavailable") {
    return run.toolUses > 0 ? { totalTokens: 0, toolUses: run.toolUses } : undefined;
  }
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage.reasoningTokens !== undefined
      ? { reasoningOutputTokens: usage.reasoningTokens }
      : {}),
    ...(run.toolUses > 0 ? { toolUses: run.toolUses } : {}),
  };
}

function keepChildEvent(event: ProviderRuntimeEvent): boolean {
  if (
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "thread.token-usage.updated" ||
    event.type === "thread.metadata.updated" ||
    event.type === "thread.state.changed" ||
    event.type === "session.exited" ||
    event.type === "session.state.changed" ||
    event.type === "session.started" ||
    event.type === "model.rerouted"
  ) {
    return false;
  }
  if (event.type === "content.delta") {
    return (
      event.payload.streamKind !== "assistant_text" &&
      event.payload.streamKind !== "reasoning_text" &&
      event.payload.streamKind !== "reasoning_summary_text"
    );
  }
  if (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  ) {
    return event.payload.itemType !== "assistant_message" && event.payload.itemType !== "reasoning";
  }
  return true;
}

function progressSummary(progress: Record<string, unknown>): string | undefined {
  if (typeof progress.recentOutput === "string") return text(progress.recentOutput);
  if (Array.isArray(progress.recentOutput)) {
    for (let index = progress.recentOutput.length - 1; index >= 0; index -= 1) {
      const entry = text(progress.recentOutput[index]);
      if (entry) return entry;
    }
  }
  return text(progress.lastIntent) ?? text(progress.currentTool) ?? text(progress.description);
}

function progressStatus(status: string | undefined): RuntimeTaskStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
    case "idle":
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    case "aborted":
      return "cancelled";
    default:
      return undefined;
  }
}

function textFromChildEvent(event: Record<string, unknown> | undefined): string {
  const assistant = asRecord(event?.assistantMessageEvent);
  if (!assistant || typeof assistant.type !== "string") return "";
  if (!assistant.type.endsWith("_delta")) return "";
  if (!assistant.type.startsWith("text_") && !assistant.type.startsWith("thinking_")) return "";
  return typeof assistant.delta === "string" ? assistant.delta : "";
}

function payloadOf(frame: Record<string, unknown>): Record<string, unknown> {
  return asRecord(frame.payload) ?? frame;
}

function putRun(state: SubagentState, run: ChildRun): SubagentState {
  return { ...state, runs: { ...state.runs, [run.nativeId]: run } };
}

function placeholder(id: string): ChildRun {
  return {
    nativeId: id,
    taskId: id,
    description: id,
    terminal: true,
    core: emptyCoreState(),
    tools: emptyToolState(),
    text: "",
    toolUses: 0,
  };
}

function emit<T extends ProviderRuntimeEvent["type"]>(
  ctx: MapCtx,
  frame: unknown,
  type: T,
  payload: Extract<ProviderRuntimeEvent, { type: T }>["payload"],
): Extract<ProviderRuntimeEvent, { type: T }> {
  return {
    type,
    eventId: EventId.make(ctx.newEventId()),
    provider: ctx.provider,
    providerInstanceId: ctx.providerInstanceId,
    threadId: ctx.threadId,
    createdAt: ctx.now(),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    payload,
    raw: { source: "neopi.rpc", payload: frame },
  } as Extract<ProviderRuntimeEvent, { type: T }>;
}

function modelSlug(model: unknown): string | undefined {
  const direct = text(model);
  if (direct) return direct;
  const record = asRecord(model);
  if (!record) return undefined;
  const provider = text(record.provider);
  const id = text(record.id) ?? text(record.modelId);
  if (provider && id) return `${provider}/${id}`;
  return id;
}

function tail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 160 ? trimmed : trimmed.slice(-160);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
