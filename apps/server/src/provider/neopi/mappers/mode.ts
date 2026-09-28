import { EventId, RuntimeRequestId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { isRecord, type NeoPiInteractionMode } from "effect-neopi-rpc/schema";
import { NEOPI_CAPABILITIES } from "../NeoPiCompatibility.ts";
import type { MapCtx } from "./MapCtx.ts";

export function neoPiInteractionModeFromFrame(frame: unknown): NeoPiInteractionMode | undefined {
  if (!isRecord(frame)) return undefined;
  if (frame.type === "mode_changed") {
    return frame.mode === "default" || frame.mode === "plan" ? frame.mode : undefined;
  }
  if (frame.type !== "t3.state" || !isRecord(frame.state)) return undefined;
  return frame.state.mode === "default" || frame.state.mode === "plan"
    ? frame.state.mode
    : undefined;
}

export function mapPlanProposal(
  ctx: MapCtx,
  frame: unknown,
  capabilities: ReadonlySet<string>,
): {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly proposal?: { readonly id: string; readonly planMarkdown: string };
} {
  if (!capabilities.has(NEOPI_CAPABILITIES.setMode) || !isRecord(frame)) return { events: [] };
  if (
    frame.type !== "plan_proposal_request" ||
    typeof frame.id !== "string" ||
    frame.id.length === 0 ||
    typeof frame.planMarkdown !== "string" ||
    frame.planMarkdown.trim().length === 0
  )
    return { events: [] };

  const requestId = RuntimeRequestId.make(frame.id);
  const event = {
    type: "turn.proposed.completed",
    eventId: EventId.make(ctx.newEventId()),
    provider: ctx.provider,
    providerInstanceId: ctx.providerInstanceId,
    threadId: ctx.threadId,
    createdAt: ctx.now(),
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    requestId,
    providerRefs: { providerRequestId: frame.id },
    payload: { planMarkdown: frame.planMarkdown.trim() },
    raw: { source: "neopi.rpc", method: "plan_proposal_request", payload: frame },
  } satisfies Extract<ProviderRuntimeEvent, { type: "turn.proposed.completed" }>;

  // The native request stays pending until the user acts on the T3 plan card.
  return {
    events: [event],
    proposal: { id: frame.id, planMarkdown: frame.planMarkdown.trim() },
  };
}
