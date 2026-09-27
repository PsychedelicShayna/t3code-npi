import {
  ApprovalRequestId,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import type { UiResponseWire } from "effect-neopi-rpc/schema";
import { NEOPI_CAPABILITIES } from "../NeoPiCompatibility.ts";

import { scopedItemId, type MapCtx } from "./MapCtx.ts";
import { approvalRequestType, parseApprovalPrompt } from "./approvalPrompt.ts";

export const NEOPI_CAP_TOOL_APPROVAL = NEOPI_CAPABILITIES.toolApprovalRequest;

export type UiReply =
  | { readonly _tag: "ExtensionUi"; readonly frame: UiResponseWire }
  | {
      readonly _tag: "ToolApproval";
      readonly frame: {
        readonly type: "tool_approval_response";
        readonly id: string;
        readonly decision: "allow_once" | "allow_session" | "deny";
      };
    };

/** Replies are prepared without mutating UI state; commit only after wire delivery. */
export interface PendingUi {
  readonly requestId: ReturnType<typeof ApprovalRequestId.make>;
  readonly nativeId: string;
  readonly kind: "approval" | "user-input";
  readonly reply: (answer: ProviderApprovalDecision | Record<string, unknown>) => UiReply;
  readonly settle: (answer: ProviderApprovalDecision | Record<string, unknown>) => void;
}

interface OpenUi {
  readonly kind: PendingUi["kind"];
  readonly requestType?: CanonicalRequestType;
  readonly frame: unknown;
}

interface Settlement {
  readonly id: string;
  readonly answers?: Record<string, unknown>;
  readonly decision?: string;
}

export interface UiState {
  readonly capabilities: Set<string>;
  readonly inFlightTools: Record<string, { readonly toolName: string; readonly args: unknown }>;
  readonly open: Map<string, OpenUi>;
  readonly settlements: Settlement[];
}

export function emptyUiState(): UiState {
  return { capabilities: new Set(), inFlightTools: {}, open: new Map(), settlements: [] };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonempty(value: unknown): string | undefined {
  return text(value)?.trim() || undefined;
}

function timeoutSuffix(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? `\nTimeout: ${value}ms`
    : "";
}

function makeEvent(
  ctx: MapCtx,
  frame: unknown,
  type: ProviderRuntimeEvent["type"],
  payload: unknown,
  id?: string,
  itemId?: string,
): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(ctx.newEventId()),
    provider: ctx.provider,
    providerInstanceId: ctx.providerInstanceId,
    threadId: ctx.threadId,
    createdAt: ctx.now(),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    ...(id
      ? { requestId: RuntimeRequestId.make(id), providerRefs: { providerRequestId: id } }
      : {}),
    ...(itemId ? { itemId: RuntimeItemId.make(scopedItemId(ctx, itemId)) } : {}),
    raw: { source: "neopi.rpc", payload: frame },
    type,
    payload,
  } as ProviderRuntimeEvent;
}

/** Flush replies immediately after responding, or at the start of the next RPC frame. */
export function flushUiSettlements(ctx: MapCtx, state: UiState): ProviderRuntimeEvent[] {
  const events: ProviderRuntimeEvent[] = [];
  for (const settlement of state.settlements.splice(0)) {
    const opened = state.open.get(settlement.id);
    if (!opened) continue;
    state.open.delete(settlement.id);
    events.push(
      opened.kind === "approval"
        ? makeEvent(
            ctx,
            opened.frame,
            "request.resolved",
            { requestType: opened.requestType, decision: settlement.decision },
            settlement.id,
          )
        : makeEvent(
            ctx,
            opened.frame,
            "user-input.resolved",
            { answers: settlement.answers ?? {} },
            settlement.id,
          ),
    );
  }
  return events;
}

export function mapUiRequest(
  ctx: MapCtx,
  frame: unknown,
  state: UiState,
): { events: ProviderRuntimeEvent[]; state: UiState; pending?: PendingUi } {
  const events = flushUiSettlements(ctx, state);
  const data = record(frame);
  const type = data?.type;
  if (!data) return { events, state };

  if (type === "ready") {
    if (Array.isArray(data.capabilities)) {
      state.capabilities.clear();
      for (const cap of data.capabilities) if (typeof cap === "string") state.capabilities.add(cap);
    }
    return { events, state };
  }
  if (type === "t3.state" || type === "chat_mode_changed") {
    const mode = type === "t3.state" ? record(data.state)?.chatMode : data.mode;
    if (mode === "off" || mode === "chat" || mode === "erp" || mode === "raw")
      events.push(
        makeEvent(ctx, frame, "runtime.warning", {
          message: `NeoPi/OMP chat mode: ${mode}`,
          detail: { neopiUi: { kind: "chat-mode", mode } },
        }),
      );
    return { events, state };
  }
  if (type === "tool_execution_start") {
    const id = nonempty(data.toolCallId);
    const toolName = nonempty(data.toolName);
    if (id && toolName) state.inFlightTools[id] = { toolName, args: data.args };
    return { events, state };
  }
  if (type === "tool_execution_end") {
    const id = nonempty(data.toolCallId);
    if (id) delete state.inFlightTools[id];
    return { events, state };
  }

  if (
    type === "tool_approval_cancel" ||
    (type === "extension_ui_request" && data.method === "cancel")
  ) {
    const target = nonempty(data.targetId);
    const opened = target && state.open.get(target);
    if (!opened) {
      events.push(
        makeEvent(ctx, frame, "runtime.warning", {
          message: `Ignored NeoPi/OMP UI cancel for unknown request ${target ?? "(missing target)"}`,
        }),
      );
    } else {
      state.open.delete(target);
      events.push(
        opened.kind === "approval"
          ? makeEvent(
              ctx,
              frame,
              "request.resolved",
              { requestType: opened.requestType, decision: "cancel", resolution: "cancelled" },
              target,
            )
          : makeEvent(
              ctx,
              frame,
              "user-input.resolved",
              { answers: { resolution: "cancelled" } },
              target,
            ),
      );
    }
    return { events, state };
  }

  const id = nonempty(data.id);
  if (!id) return { events, state };

  if (type === "tool_approval_request") {
    if (!state.capabilities.has(NEOPI_CAP_TOOL_APPROVAL)) return { events, state };
    const toolName = nonempty(data.toolName);
    if (!toolName) return { events, state };
    const requestType = approvalRequestType(toolName);
    const details = Array.isArray(data.details)
      ? data.details.filter(
          (detail): detail is string => typeof detail === "string" && detail.length > 0,
        )
      : [];
    const detail =
      [
        `Allow tool: ${toolName}`,
        ...(nonempty(data.reason) ? [`Reason: ${data.reason}`] : []),
        ...details,
      ].join("\n") + timeoutSuffix(data.timeout);
    const toolCallId = nonempty(data.toolCallId);
    state.open.set(id, { kind: "approval", requestType, frame });
    events.push(
      makeEvent(
        ctx,
        frame,
        "request.opened",
        {
          requestType,
          detail,
          options: [
            { decision: "accept", label: "Approve" },
            { decision: "acceptForSession", label: "Always allow this session" },
            { decision: "decline", label: "Deny" },
          ],
          ...(Object.hasOwn(data, "args") ? { args: data.args } : {}),
        },
        id,
        toolCallId,
      ),
    );
    return {
      events,
      state,
      pending: {
        requestId: ApprovalRequestId.make(id),
        nativeId: id,
        kind: "approval",
        reply: (answer) => {
          const decision =
            answer === "accept"
              ? "allow_once"
              : answer === "acceptForSession" || answer === "acceptAlways"
                ? "allow_session"
                : "deny";
          return { _tag: "ToolApproval", frame: { type: "tool_approval_response", id, decision } };
        },
        settle: (answer) => {
          state.settlements.push({ id, decision: String(answer) });
        },
      },
    };
  }

  if (type !== "extension_ui_request") return { events, state };
  const method = data.method;
  if (method === "select" || method === "input" || method === "editor" || method === "confirm") {
    const title = nonempty(data.title) ?? String(method);
    const options = Array.isArray(data.options)
      ? data.options.filter((option): option is string => typeof option === "string")
      : [];
    const approval = method === "select" ? parseApprovalPrompt(title, options) : undefined;
    if (approval) {
      const matches = Object.entries(state.inFlightTools).filter(
        ([, tool]) => tool.toolName === approval.toolName,
      );
      const tool = matches.length === 1 ? matches[0] : undefined;
      state.open.set(id, { kind: "approval", requestType: approval.requestType, frame });
      events.push(
        makeEvent(
          ctx,
          frame,
          "request.opened",
          {
            requestType: approval.requestType,
            detail: approval.detail + timeoutSuffix(data.timeout),
            // A select response cannot persist a session/always allow upstream.
            options: [
              { decision: "accept", label: "Approve" },
              { decision: "decline", label: "Deny" },
            ],
            ...(tool ? { args: tool[1].args } : {}),
          },
          id,
          tool?.[0],
        ),
      );
      return {
        events,
        state,
        pending: {
          requestId: ApprovalRequestId.make(id),
          nativeId: id,
          kind: "approval",
          reply: (answer) => {
            const value =
              answer === "accept" || answer === "acceptForSession" || answer === "acceptAlways"
                ? "Approve"
                : "Deny";
            return { _tag: "ExtensionUi", frame: { id, value } };
          },
          settle: (answer) => {
            state.settlements.push({ id, decision: String(answer) });
          },
        },
      };
    }

    const descriptions = Array.isArray(data.optionDetails) ? data.optionDetails : [];
    const questionOptions =
      method === "confirm"
        ? [
            { label: "Yes", description: "", value: "true" },
            { label: "No", description: "", value: "false" },
          ]
        : options.flatMap((option, index) => {
            const label = nonempty(option);
            if (!label) return [];
            return [
              {
                label,
                description: text(record(descriptions[index])?.description) ?? "",
                value: option,
              },
            ];
          });
    const prefill = method === "editor" ? text(data.prefill) : undefined;
    if (prefill && nonempty(prefill))
      questionOptions.push({ label: prefill.trim(), description: "", value: prefill });
    const question =
      (method === "confirm" ? (nonempty(data.message) ?? title) : title) +
      timeoutSuffix(data.timeout);
    state.open.set(id, { kind: "user-input", frame });
    events.push(
      makeEvent(
        ctx,
        frame,
        "user-input.requested",
        {
          questions: [
            {
              id,
              header: title,
              question,
              options: questionOptions,
              allowCustomAnswer: method !== "select" && method !== "confirm",
              multiSelect: false,
            },
          ],
        },
        id,
      ),
    );
    return {
      events,
      state,
      pending: {
        requestId: ApprovalRequestId.make(id),
        nativeId: id,
        kind: "user-input",
        reply: (answer) => {
          const answers = record(answer) ?? {};
          const first = answers[id];
          const response: UiResponseWire =
            first === undefined
              ? { id, cancelled: true }
              : method === "confirm"
                ? { id, confirmed: first === true || first === "true" }
                : { id, value: String(first) };
          return { _tag: "ExtensionUi", frame: response };
        },
        settle: (answer) => {
          state.settlements.push({ id, answers: record(answer) ?? {} });
        },
      },
    };
  }

  let event: ProviderRuntimeEvent | undefined;
  if (method === "notify") {
    const message = nonempty(data.message);
    if (message)
      event = makeEvent(ctx, frame, "runtime.warning", {
        message,
        detail: { neopiUi: { kind: "notice", level: data.notifyType } },
      });
  } else if (method === "setStatus") {
    const key = nonempty(data.statusKey);
    if (key)
      event = makeEvent(ctx, frame, "runtime.warning", {
        message: nonempty(data.statusText) ?? `NeoPi status ${key} cleared`,
        detail: { neopiUi: { kind: "status", key, text: text(data.statusText) ?? "" } },
      });
  } else if (method === "setWidget") {
    const key = nonempty(data.widgetKey);
    const lines = Array.isArray(data.widgetLines)
      ? data.widgetLines.filter((line): line is string => typeof line === "string")
      : [];
    if (key)
      event = makeEvent(ctx, frame, "runtime.warning", {
        message: lines.join("\n") || `NeoPi widget ${key} cleared`,
        detail: { neopiUi: { kind: "widget", key, lines } },
      });
  } else if (method === "set_editor_text") {
    if (typeof data.text === "string")
      event = makeEvent(ctx, frame, "runtime.warning", {
        message: "NeoPi/OMP suggested composer text",
        detail: { neopiUi: { kind: "editor", text: data.text } },
      });
  } else if (method === "open_url") {
    event = makeEvent(ctx, frame, "runtime.warning", {
      message: nonempty(data.instructions) ?? "Open URL",
      detail: data.launchUrl ? { url: data.url, launchUrl: data.launchUrl } : data.url,
    });
  } else if (method === "setTitle") {
    event = nonempty(data.title)
      ? makeEvent(ctx, frame, "thread.metadata.updated", { name: data.title })
      : makeEvent(ctx, frame, "runtime.warning", { message: "Ignored empty NeoPi/OMP title" });
  }
  if (event) events.push(event);
  return { events, state };
}
