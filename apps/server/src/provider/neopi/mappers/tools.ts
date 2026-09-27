/**
 * Pure NeoPi RPC tool-lifecycle mapper (§2.5 / N6).
 *
 * `tool_execution_*` frames become one runtime item per `toolCallId`.
 * `host_tool_call` is recorded and otherwise ignored — the host bridge
 * executes it. Bash `partialResult` text is a rolling tail snapshot, not an
 * append-only chunk.
 */
import {
  EventId,
  ProviderItemId,
  RuntimeItemId,
  type CanonicalItemType,
  type ItemLifecyclePayload,
  type ProviderRuntimeEvent,
  type ToolActivitySource,
} from "@t3tools/contracts";

import { snapshotDelta } from "./snapshotDelta.ts";

/** Alias to the shared mapper context, exported for callers of this mapper. */
export type ToolMapCtx = import("./MapCtx.ts").MapCtx;

export interface InFlightTool {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly host: boolean;
  readonly bashSnapshot?: string;
}

export interface ToolState {
  readonly inFlightTools: Readonly<Record<string, InFlightTool>>;
  /** Names registered with NeoPi via `set_host_tools`. */
  readonly hostToolNames: ReadonlySet<string>;
  /** `toolCallId`s seen on `host_tool_call`, including calls that already finished. */
  readonly hostToolCallIds: ReadonlySet<string>;
  /** Finished `toolCallId`s. A replay must not open a second item. */
  readonly completedToolCallIds: ReadonlySet<string>;
}

/** Wire `toolSource` for T3-owned host tools. Key is the plan's `"t3-code"`. */
export const T3_CODE_TOOL_SOURCE = {
  key: "t3-code",
  name: "T3 Code",
  kind: "integration",
} as const satisfies ToolActivitySource;

const FILE_CHANGE_TOOLS = new Set(["edit", "write", "delete", "move"]);

export function emptyToolState(): ToolState {
  return {
    inFlightTools: {},
    hostToolNames: new Set(),
    hostToolCallIds: new Set(),
    completedToolCallIds: new Set(),
  };
}

export function withHostToolNames(state: ToolState, names: Iterable<string>): ToolState {
  const hostToolNames = new Set(state.hostToolNames);
  for (const name of names) {
    if (name.length > 0) hostToolNames.add(name);
  }
  return hostToolNames.size === state.hostToolNames.size ? state : { ...state, hostToolNames };
}

export function inFlightToolList(state: ToolState): ReadonlyArray<InFlightTool> {
  return Object.values(state.inFlightTools);
}

export function mapToolFrame(
  ctx: ToolMapCtx,
  frame: unknown,
  state: ToolState,
): { events: ProviderRuntimeEvent[]; state: ToolState } {
  const record = asRecord(frame);
  const type = typeof record?.type === "string" ? record.type : undefined;
  if (!record || !type) {
    return { events: [], state };
  }

  if (type === "host_tool_call") {
    return mapHostToolCall(record, state);
  }
  if (type === "tool_execution_start") {
    return mapStart(ctx, record, frame, state);
  }
  if (type === "tool_execution_update") {
    return mapUpdate(ctx, record, frame, state);
  }
  if (type === "tool_execution_end") {
    return mapEnd(ctx, record, frame, state);
  }
  return { events: [], state };
}

function mapHostToolCall(
  record: Record<string, unknown>,
  state: ToolState,
): { events: ProviderRuntimeEvent[]; state: ToolState } {
  const toolCallId = stringField(record.toolCallId);
  return {
    events: [],
    state: toolCallId ? addId(state, "hostToolCallIds", toolCallId) : state,
  };
}

function mapStart(
  ctx: ToolMapCtx,
  record: Record<string, unknown>,
  frame: unknown,
  state: ToolState,
): { events: ProviderRuntimeEvent[]; state: ToolState } {
  const identity = callIdentity(record);
  if (!identity) return { events: [], state };
  if (
    state.inFlightTools[identity.toolCallId] ||
    state.completedToolCallIds.has(identity.toolCallId)
  ) {
    return { events: [], state };
  }

  const call = beginCall(state, identity.toolCallId, identity.toolName, record.args);
  return {
    events: [startedEvent(ctx, frame, call)],
    state: putInFlight(state, call),
  };
}

function mapUpdate(
  ctx: ToolMapCtx,
  record: Record<string, unknown>,
  frame: unknown,
  state: ToolState,
): { events: ProviderRuntimeEvent[]; state: ToolState } {
  const identity = callIdentity(record);
  if (!identity) return { events: [], state };
  if (state.completedToolCallIds.has(identity.toolCallId)) {
    return { events: [], state };
  }

  const events: ProviderRuntimeEvent[] = [];
  let next = state;
  let call = next.inFlightTools[identity.toolCallId];
  if (!call) {
    call = beginCall(next, identity.toolCallId, identity.toolName, record.args);
    events.push(startedEvent(ctx, frame, call));
    next = putInFlight(next, call);
  } else if (record.args !== undefined) {
    call = { ...call, args: record.args };
    next = putInFlight(next, call);
  }

  if (call.itemType !== "command_execution") {
    return { events, state: next };
  }

  const snapshot = snapshotText(record.partialResult);
  if (snapshot === undefined) {
    return { events, state: next };
  }

  const compared = snapshotDelta(call.bashSnapshot ?? "", snapshot);
  call = { ...call, bashSnapshot: snapshot };
  next = putInFlight(next, call);

  if ("delta" in compared) {
    if (compared.delta.length > 0) {
      events.push(contentDelta(ctx, frame, call.toolCallId, compared.delta));
    }
    return { events, state: next };
  }

  if (compared.replace.length > 0) {
    events.push(
      itemEvent(ctx, frame, call, "item.updated", {
        itemType: call.itemType,
        status: "inProgress",
        title: call.title,
        detail: compared.replace,
        data: startData(call),
        ...(call.host ? { toolSource: T3_CODE_TOOL_SOURCE } : {}),
      }),
    );
  }
  return { events, state: next };
}

function mapEnd(
  ctx: ToolMapCtx,
  record: Record<string, unknown>,
  frame: unknown,
  state: ToolState,
): { events: ProviderRuntimeEvent[]; state: ToolState } {
  const identity = callIdentity(record);
  if (!identity) return { events: [], state };
  if (state.completedToolCallIds.has(identity.toolCallId)) {
    return { events: [], state };
  }

  const events: ProviderRuntimeEvent[] = [];
  let call = state.inFlightTools[identity.toolCallId];
  if (!call) {
    call = beginCall(state, identity.toolCallId, identity.toolName, record.args);
    events.push(startedEvent(ctx, frame, call));
  } else if (record.args !== undefined) {
    call = { ...call, args: record.args };
  }
  if (!call.host && state.hostToolCallIds.has(identity.toolCallId)) {
    const classified = classify(call.toolName, true);
    call = { ...call, host: true, itemType: classified.itemType, title: classified.title };
  }

  const failed = record.isError === true || asRecord(record.result)?.isError === true;
  events.push(
    itemEvent(ctx, frame, call, "item.completed", {
      itemType: call.itemType,
      status: failed ? "failed" : "completed",
      title: call.title,
      data: completedData(call, record.result),
      ...(call.host ? { toolSource: T3_CODE_TOOL_SOURCE } : {}),
    }),
  );

  const inFlightTools = { ...state.inFlightTools };
  delete inFlightTools[identity.toolCallId];
  return {
    events,
    state: {
      ...state,
      inFlightTools,
      completedToolCallIds: addToSet(state.completedToolCallIds, identity.toolCallId),
    },
  };
}

function beginCall(
  state: ToolState,
  toolCallId: string,
  toolName: string,
  args: unknown,
): InFlightTool {
  const host = state.hostToolNames.has(toolName) || state.hostToolCallIds.has(toolCallId);
  const classified = classify(toolName, host);
  return {
    toolCallId,
    toolName,
    args,
    itemType: classified.itemType,
    title: classified.title,
    host,
  };
}

function classify(toolName: string, host: boolean): { itemType: CanonicalItemType; title: string } {
  if (host) return { itemType: "mcp_tool_call", title: toolName };
  if (toolName === "bash") return { itemType: "command_execution", title: "Ran command" };
  if (FILE_CHANGE_TOOLS.has(toolName)) return { itemType: "file_change", title: "File change" };
  if (toolName === "web_search") return { itemType: "web_search", title: "Web search" };
  if (toolName.startsWith("mcp__")) return { itemType: "mcp_tool_call", title: toolName };
  return { itemType: "dynamic_tool_call", title: toolName };
}

function startedEvent(ctx: ToolMapCtx, frame: unknown, call: InFlightTool): ProviderRuntimeEvent {
  return itemEvent(ctx, frame, call, "item.started", {
    itemType: call.itemType,
    status: "inProgress",
    title: call.title,
    ...(startData(call) !== undefined ? { data: startData(call) } : {}),
    ...(call.host ? { toolSource: T3_CODE_TOOL_SOURCE } : {}),
  });
}

function startData(call: InFlightTool): unknown {
  if (call.host || call.itemType === "mcp_tool_call") {
    return {
      toolName: call.toolName,
      args: call.args,
      ...(asRecord(call.args) ? { arguments: call.args } : {}),
      ...(call.host ? { server: "t3-code", tool: call.toolName } : {}),
    };
  }
  if (call.itemType === "command_execution") {
    const command = commandFromArgs(call.args);
    return command === undefined ? undefined : { command };
  }
  if (call.itemType === "file_change") {
    const paths = pathsFromArgs(call.args);
    return paths.length > 0 ? { paths, files: paths.map((path) => ({ path })) } : undefined;
  }
  if (call.itemType === "web_search") {
    const query = stringField(asRecord(call.args)?.query);
    return query === undefined ? { args: call.args } : { query, args: call.args };
  }
  return { args: call.args };
}

function completedData(call: InFlightTool, result: unknown): unknown {
  const base = asRecord(startData(call)) ?? {};
  const data: Record<string, unknown> = { ...base };
  const blocks = contentBlocks(result);
  const text = joinText(blocks);
  const images = imageBlocks(blocks);
  const details = asRecord(asRecord(result)?.details);

  if (call.toolName === "write" && !call.host) {
    const written = asRecord(call.args)?.content;
    if (typeof written === "string") data.content = written;
  } else if (text !== undefined) {
    data.content = text;
  }

  if (call.toolName === "edit" && !call.host) {
    const diff = editDiff(details);
    if (diff !== undefined) data.diff = diff;
  }

  if (images.length > 0) data.images = images;

  const exitCode = details?.exitCode;
  if (typeof exitCode === "number" && Number.isInteger(exitCode)) {
    data.exitCode = exitCode;
  }

  if (call.itemType === "file_change") {
    const paths = uniqueStrings([
      ...(Array.isArray(data.paths) ? data.paths : []),
      ...pathsFromArgs(call.args),
      ...pathsFromDetails(details),
    ]);
    if (paths.length > 0) {
      data.paths = paths;
      data.files = paths.map((path) => ({ path }));
    }
  }

  return Object.keys(data).length > 0 ? data : undefined;
}

function editDiff(details: Record<string, unknown> | undefined): string | undefined {
  if (!details) return undefined;
  if (typeof details.diff === "string" && details.diff.length > 0) return details.diff;
  if (!Array.isArray(details.perFileResults)) return undefined;
  const diffs: string[] = [];
  for (const entry of details.perFileResults) {
    const diff = asRecord(entry)?.diff;
    if (typeof diff === "string" && diff.length > 0) diffs.push(diff);
  }
  return diffs.length > 0 ? diffs.join("\n") : undefined;
}

function itemEvent(
  ctx: ToolMapCtx,
  frame: unknown,
  call: InFlightTool,
  type: "item.started" | "item.updated" | "item.completed",
  payload: ItemLifecyclePayload,
): ProviderRuntimeEvent {
  const data = payload.data;
  return {
    type,
    eventId: EventId.make(ctx.newEventId()),
    provider: ctx.provider,
    providerInstanceId: ctx.providerInstanceId,
    threadId: ctx.threadId,
    createdAt: ctx.now(),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    itemId: RuntimeItemId.make(call.toolCallId),
    payload: {
      itemType: payload.itemType,
      ...(payload.status ? { status: payload.status } : {}),
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload.detail ? { detail: payload.detail } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(payload.toolSource ? { toolSource: payload.toolSource } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(ctx.parentToolUseId ? { parentToolUseId: ctx.parentToolUseId } : {}),
    },
    providerRefs: { providerItemId: ProviderItemId.make(call.toolCallId) },
    raw: { source: "neopi.rpc", payload: frame },
  };
}

function contentDelta(
  ctx: ToolMapCtx,
  frame: unknown,
  toolCallId: string,
  delta: string,
): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    eventId: EventId.make(ctx.newEventId()),
    provider: ctx.provider,
    providerInstanceId: ctx.providerInstanceId,
    threadId: ctx.threadId,
    createdAt: ctx.now(),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    itemId: RuntimeItemId.make(toolCallId),
    payload: {
      streamKind: "command_output",
      delta,
    },
    providerRefs: { providerItemId: ProviderItemId.make(toolCallId) },
    raw: { source: "neopi.rpc", payload: frame },
  };
}

function putInFlight(state: ToolState, call: InFlightTool): ToolState {
  return {
    ...state,
    inFlightTools: { ...state.inFlightTools, [call.toolCallId]: call },
  };
}

function addId(
  state: ToolState,
  key: "hostToolCallIds" | "completedToolCallIds",
  id: string,
): ToolState {
  if (state[key].has(id)) return state;
  return { ...state, [key]: addToSet(state[key], id) };
}

function addToSet(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set);
  next.add(value);
  return next;
}

function callIdentity(
  record: Record<string, unknown>,
): { toolCallId: string; toolName: string } | undefined {
  const toolCallId = stringField(record.toolCallId);
  const toolName = stringField(record.toolName);
  if (!toolCallId || !toolName) return undefined;
  return { toolCallId, toolName };
}

function commandFromArgs(args: unknown): string | undefined {
  if (typeof args === "string" && args.length > 0) return args;
  const record = asRecord(args);
  if (!record) return undefined;
  const command = record.command ?? record.cmd;
  if (typeof command === "string" && command.length > 0) return command;
  if (Array.isArray(command)) {
    const parts = command.filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    if (parts.length > 0) return parts.join(" ");
  }
  return undefined;
}

function pathsFromArgs(args: unknown): string[] {
  const record = asRecord(args);
  if (!record) return [];
  const paths: string[] = [];
  pushPath(paths, record.path);
  pushPath(paths, record.filePath);
  pushPath(paths, record.file);
  pushPath(paths, record.sourcePath);
  pushPath(paths, record.from);
  pushPath(paths, record.to);
  pushPath(paths, record.source);
  pushPath(paths, record.destination);
  pushPath(paths, record.rename);
  pushPath(paths, record.move);
  if (Array.isArray(record.paths)) {
    for (const entry of record.paths) pushPath(paths, entry);
  }
  if (Array.isArray(record.edits)) {
    for (const edit of record.edits) {
      const file = asRecord(edit);
      if (!file) continue;
      pushPath(paths, file.path);
      pushPath(paths, file.filePath);
      pushPath(paths, file.move);
      pushPath(paths, file.rename);
    }
  }
  if (typeof record.input === "string") {
    for (const match of record.input.matchAll(/^\[([^\]#\n]+)(?:#[^\]]+)?\]/gm)) {
      pushPath(paths, match[1]);
    }
  }
  return uniqueStrings(paths);
}

function pathsFromDetails(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  const paths: string[] = [];
  pushPath(paths, details.path);
  pushPath(paths, details.sourcePath);
  pushPath(paths, details.move);
  if (Array.isArray(details.perFileResults)) {
    for (const entry of details.perFileResults) {
      const file = asRecord(entry);
      if (!file) continue;
      pushPath(paths, file.path);
      pushPath(paths, file.sourcePath);
      pushPath(paths, file.move);
    }
  }
  return paths;
}

function snapshotText(partialResult: unknown): string | undefined {
  if (typeof partialResult === "string") return partialResult;
  const record = asRecord(partialResult);
  if (!record) return undefined;
  if (typeof record.text === "string") return record.text;
  if (typeof record.output === "string") return record.output;
  if (!Array.isArray(record.content)) return undefined;
  return joinText(record.content);
}

function contentBlocks(result: unknown): ReadonlyArray<unknown> {
  if (typeof result === "string") return [{ type: "text", text: result }];
  const content = asRecord(result)?.content;
  return Array.isArray(content) ? content : [];
}

function joinText(blocks: ReadonlyArray<unknown>): string | undefined {
  const parts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function imageBlocks(blocks: ReadonlyArray<unknown>): Array<{ mimeType: string; data: string }> {
  const images: Array<{ mimeType: string; data: string }> = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (record?.type !== "image") continue;
    if (typeof record.mimeType !== "string" || typeof record.data !== "string") continue;
    images.push({ mimeType: record.mimeType, data: record.data });
  }
  return images;
}

function pushPath(paths: string[], value: unknown): void {
  if (typeof value === "string" && value.trim().length > 0) paths.push(value);
}

function uniqueStrings(values: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
