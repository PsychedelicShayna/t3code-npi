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

import type { MapCtx } from "./MapCtx.ts";
import { approvalRequestType, parseApprovalPrompt } from "./approvalPrompt.ts";

export const NEOPI_CAP_TOOL_APPROVAL = "tool_approval_request";

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

/** The adapter sends ExtensionUi through respondUi and ToolApproval through writeFrame. */
export interface PendingUi {
  readonly requestId: ReturnType<typeof ApprovalRequestId.make>;
  readonly nativeId: string;
  readonly kind: "approval" | "user-input";
  readonly reply: (answer: ProviderApprovalDecision | Record<string, unknown>) => UiReply;
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
    ...(itemId ? { itemId: RuntimeItemId.make(itemId) } : {}),
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
          state.settlements.push({ id, decision: String(answer) });
          return { _tag: "ToolApproval", frame: { type: "tool_approval_response", id, decision } };
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
            state.settlements.push({ id, decision: String(answer) });
            return { _tag: "ExtensionUi", frame: { id, value } };
          },
        },
      };
    }

    const descriptions = Array.isArray(data.optionDetails) ? data.optionDetails : [];
    const questionOptions = options.flatMap((option, index) => {
      const label = nonempty(option);
      if (!label) return [];
      return [
        { label, description: text(record(descriptions[index])?.description) ?? "", value: option },
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
              allowCustomAnswer: method !== "select",
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
          const first = Object.values(answers)[0];
          const response: UiResponseWire =
            first === undefined
              ? { id, cancelled: true }
              : method === "confirm"
                ? { id, confirmed: first === true || first === "true" }
                : { id, value: String(first) };
          state.settlements.push({ id, answers });
          return { _tag: "ExtensionUi", frame: response };
        },
      },
    };
  }

  let event: ProviderRuntimeEvent | undefined;
  if (method === "notify") {
    const message = nonempty(data.message);
    if (message)
      event =
        data.notifyType === "info"
          ? makeEvent(ctx, frame, "thread.metadata.updated", { metadata: { notice: message } })
          : makeEvent(ctx, frame, "runtime.warning", { message, detail: data.notifyType });
  } else if (method === "setStatus") {
    event = makeEvent(ctx, frame, "thread.metadata.updated", {
      metadata: { status: { key: data.statusKey, text: data.statusText ?? "" } },
    });
  } else if (method === "setWidget") {
    event = makeEvent(ctx, frame, "thread.metadata.updated", {
      metadata: {
        widget: {
          key: data.widgetKey,
          lines: data.widgetLines ?? [],
          ...(data.widgetPlacement ? { placement: data.widgetPlacement } : {}),
        },
      },
    });
  } else if (method === "set_editor_text") {
    event = makeEvent(ctx, frame, "thread.metadata.updated", {
      metadata: { composerText: data.text },
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
