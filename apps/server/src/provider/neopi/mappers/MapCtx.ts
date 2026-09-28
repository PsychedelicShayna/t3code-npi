import type { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";

/**
 * Shared context for the pure NeoPi/OMP frame mappers.
 *
 * `agentId` and `parentToolUseId` are optional. The parent turn omits them.
 * N12 passes them when it re-enters `mapCoreFrame` / `mapToolFrame` for a
 * nested subagent event so item payloads can carry the owning agent.
 */
export interface MapCtx {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly sessionKey?: string;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly agentId?: string;
  readonly parentToolUseId?: string;
  readonly now: () => string;
  readonly newEventId: () => string;
}

/** Keep native IDs stable inside a session, but never reuse them across sessions or turns. */
export function scopedItemId(ctx: MapCtx, nativeId: string): string {
  return `neopi:${JSON.stringify([
    ctx.providerInstanceId,
    ctx.sessionKey ?? null,
    ctx.threadId,
    ctx.turnId ?? null,
    ctx.agentId ?? null,
    nativeId,
  ])}`;
}
