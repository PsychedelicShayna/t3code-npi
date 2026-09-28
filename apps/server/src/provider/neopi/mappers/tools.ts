/**
 * Pure NeoPi RPC tool-lifecycle mapper (§2.5 / N6).
 *
 * `tool_execution_*` frames become one runtime item per `toolCallId`.
 * `host_tool_call` is recorded and otherwise ignored — the host bridge
 * executes it. Bash `partialResult` text is a rolling tail snapshot. Prefix
 * growth and rollover both publish the current window on `item.updated`
 * as `item.aggregatedOutput` / `rawOutput`, the shapes ingestion and the
 * work log keep. `content.delta` is not used: T3 drops non-assistant deltas.
 * The completing result replaces that window.
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

import { scopedItemId } from "./MapCtx.ts";

import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

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
const MAX_COMMAND_DISPLAY_CHARS = 2048;
const OMITTED_COMMAND_OUTPUT = "[earlier output omitted]\n";

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
  const visible = visibleCommandSnapshot(compared, snapshot);
  call = { ...call, bashSnapshot: snapshot };
  next = putInFlight(next, call);
  if (visible === undefined) {
    return { events, state: next };
  }

  events.push(
    itemEvent(ctx, frame, call, "item.updated", {
      itemType: call.itemType,
      status: "inProgress",
      title: call.title,
      data: commandData(call, visible),
      ...(call.host ? { toolSource: T3_CODE_TOOL_SOURCE } : {}),
    }),
  );
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
    const classified = classify(call.toolName, true, call.args);
    call = { ...call, host: true, itemType: classified.itemType, title: classified.title };
  }
  const previewPath = workspaceImagePath(call.args, asRecord(asRecord(record.result)?.details));
  if (previewPath && !call.host && call.itemType === "dynamic_tool_call") {
    call = { ...call, itemType: "image_view", title: "Image view" };
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
  const classified = classify(toolName, host, args);
  return {
    toolCallId,
    toolName,
    args,
    itemType: classified.itemType,
    title: classified.title,
    host,
  };
}

function classify(
  toolName: string,
  host: boolean,
  args: unknown,
): { itemType: CanonicalItemType; title: string } {
  if (host) return { itemType: "mcp_tool_call", title: toolName };
  if (toolName === "bash") return { itemType: "command_execution", title: "Ran command" };
  if (FILE_CHANGE_TOOLS.has(toolName)) return { itemType: "file_change", title: "File change" };
  if (workspaceImagePath(args, undefined)) return { itemType: "image_view", title: "Image view" };
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
    return commandData(call, undefined);
  }
  if (call.itemType === "file_change") {
    const paths = pathsFromArgs(call.args);
    return paths.length > 0 ? { paths, files: paths.map((path) => ({ path })) } : undefined;
  }
  if (call.itemType === "image_view") {
    return imageData(call, undefined, []);
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
  const diff = call.toolName === "edit" && !call.host ? editDiff(details) : undefined;

  if (call.toolName === "write" && !call.host) {
    const written = asRecord(call.args)?.content;
    if (typeof written === "string") data.content = written;
  } else if (text !== undefined) {
    data.content = text;
  }

  if (call.itemType === "command_execution") {
    // The completing result is authoritative, including when it replaces a tail window.
    const output = text !== undefined ? text : call.bashSnapshot;
    Object.assign(data, commandData(call, output, integerField(details?.exitCode)));
    if (output) {
      data.displayOutput =
        output.length <= MAX_COMMAND_DISPLAY_CHARS
          ? output
          : OMITTED_COMMAND_OUTPUT +
            Array.from(
              output.slice(OMITTED_COMMAND_OUTPUT.length - MAX_COMMAND_DISPLAY_CHARS),
            ).join("");
    }
  } else if (diff !== undefined) {
    data.diff = diff;
    data.rawOutput = { content: diff };
    data.item = { aggregatedOutput: diff };
  } else {
    assignPresentedText(data, call, text);
  }

  if (images.length > 0 || call.itemType === "image_view") {
    Object.assign(data, imageData(call, details, images));
  }

  const exitCode = integerField(details?.exitCode);
  if (exitCode !== undefined && call.itemType !== "command_execution") {
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

function commandData(
  call: InFlightTool,
  output: string | undefined,
  exitCode?: number,
): Record<string, unknown> {
  const command = commandFromArgs(call.args);
  const data: Record<string, unknown> = {};
  if (command !== undefined) data.command = command;
  const item: Record<string, unknown> = {};
  if (command !== undefined) item.command = command;
  if (output !== undefined && output.length > 0) {
    item.aggregatedOutput = output;
    data.rawOutput = { content: output, stdout: output };
    data.result = { content: output };
  }
  if (exitCode !== undefined) {
    item.exitCode = exitCode;
    data.exitCode = exitCode;
  }
  if (Object.keys(item).length > 0) data.item = item;
  return data;
}

function assignPresentedText(
  data: Record<string, unknown>,
  call: InFlightTool,
  text: string | undefined,
): void {
  if (text === undefined || text.length === 0) return;
  data.rawOutput = { content: text };
  data.result = { content: [{ type: "text", text }] };
  if (call.itemType !== "mcp_tool_call") return;
  data.item = {
    type: "mcpToolCall",
    id: call.toolCallId,
    tool: call.toolName,
    status: "completed",
    arguments: call.args,
    result: { content: [{ type: "text", text }] },
    ...(call.host ? { server: "t3-code" } : {}),
  };
}

function imageData(
  call: InFlightTool,
  details: Record<string, unknown> | undefined,
  images: ReadonlyArray<{ mimeType: string; data: string }>,
): Record<string, unknown> {
  const imagePath = workspaceImagePath(call.args, details);
  const data: Record<string, unknown> = { args: call.args };
  if (imagePath) {
    data.imagePath = imagePath;
    data.toolName = call.toolName;
    data.input = { file_path: imagePath, path: imagePath };
  }
  if (images.length > 0) data.images = images;
  return data;
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

function integerField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function workspaceImagePath(
  args: unknown,
  details: Record<string, unknown> | undefined,
): string | undefined {
  const record = asRecord(args);
  const source = asRecord(asRecord(details?.meta)?.source);
  const candidates = [
    record?.imagePath,
    record?.file_path,
    record?.path,
    details?.imagePath,
    details?.resolvedPath,
    details?.displayTarget,
    details?.path,
    source?.type === "path" ? source.value : undefined,
  ];
  for (const candidate of candidates) {
    const path = localImagePath(candidate);
    if (path) return path;
  }
  return undefined;
}

function localImagePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isWorkspaceImagePreviewPath(trimmed)) return undefined;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname.length > 0 && url.hostname !== "localhost") return undefined;
      const pathname = decodeURIComponent(url.pathname);
      const path = /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
      return isWorkspaceImagePreviewPath(path) ? path : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) return undefined;
  return trimmed;
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
    itemId: RuntimeItemId.make(scopedItemId(ctx, call.toolCallId)),
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

function visibleCommandSnapshot(
  compared: ReturnType<typeof snapshotDelta>,
  snapshot: string,
): string | undefined {
  if ("delta" in compared && compared.delta.length === 0) return undefined;
  const visible = withoutTrailingIncompleteCodePoint(snapshot);
  return visible.length > 0 ? visible : undefined;
}

function withoutTrailingIncompleteCodePoint(value: string): string {
  if (value.length === 0) return value;
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
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
