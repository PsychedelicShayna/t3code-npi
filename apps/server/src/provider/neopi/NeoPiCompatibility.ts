import type { ReadyFrame } from "effect-neopi-rpc/schema";
import type { ServerProviderCompatibilityAdvisory } from "@t3tools/contracts";

/** Native feature gates are shared by probing, adapter routing and launch planning. */
export const NEOPI_CAPABILITIES = {
  toolApprovalRequest: "tool_approval_request",
  setMode: "set_mode",
  getRoles: "get_roles",
  getUsage: "get_usage",
  sessionLease: "session_lease",
  newSession: "new_session",
  setChatMode: "set_chat_mode",
  promptEntryIds: "prompt_entry_ids",
  planProposalCancel: "plan_proposal_cancel",
} as const;

/** v2 negotiation is the required transport floor; all named features are optional. */
export function neopiCompatibility(
  ready: ReadyFrame | null,
  negotiatedV2: boolean,
): ServerProviderCompatibilityAdvisory {
  const compatible =
    ready?.protocolVersion === 1 &&
    negotiatedV2 &&
    ready.supportedProtocolVersions?.includes(2) === true;
  return {
    status: compatible ? "supported" : "unsupported",
    message: compatible
      ? null
      : "NeoPi/OMP RPC peer is too old or returned an invalid ready handshake; protocol v2 is required. Update the CLI to continue.",
    recommendedVersion: null,
    recommendedRange: null,
  };
}

export function supportsNeoPiCapability(
  capabilities: ReadonlySet<string>,
  name: keyof typeof NEOPI_CAPABILITIES,
): boolean {
  return capabilities.has(NEOPI_CAPABILITIES[name]);
}
