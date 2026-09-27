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
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly agentId?: string;
  readonly parentToolUseId?: string;
  readonly now: () => string;
  readonly newEventId: () => string;
}
