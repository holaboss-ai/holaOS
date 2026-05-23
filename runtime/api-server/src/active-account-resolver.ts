// Account resolution for "which of the user's N connected accounts
// should this workspace use for provider X right now?"
//
// Four-layer model (described in detail in the PM discussion that
// produced this code — see commit message for context):
//
//   1. conversation_pin (session × provider) — user said "switch to
//      personal gmail for this conversation"; ephemeral, per-session.
//      Implemented as a target_type="conversation_pin" binding row
//      keyed by target_id=<session_id>. Cleared when the session ends
//      or the user explicitly unsets it.
//
//   2. app_binding (workspace × app × provider) — declared at app
//      register time; persistent. Not consulted here — app context
//      uses the per-app binding row directly via the existing path.
//
//   3. workspace_default (workspace × provider) — Settings → Integrations
//      "default account for this provider in this workspace". Persistent,
//      survives across sessions and desktops for the same workspace.
//      Stored as target_type="workspace_default", target_id=<workspace_id>.
//
//   4. first_active fallback — when no explicit choice has ever been
//      made and only one account is active, just use it. When multiple
//      are active and nothing is set, agent should prompt the user
//      before this fallback fires.
//
// This resolver is the single source of truth for "default for direct
// (non-app) Composio tool calls" — composio-mcp manager + the agent
// runtime tools both consult it.

import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

export const WORKSPACE_DEFAULT_TARGET_TYPE = "workspace_default";
export const CONVERSATION_PIN_TARGET_TYPE = "conversation_pin";

export type ActiveAccountSource =
  | "conversation_pin"
  | "workspace_default"
  | "first_active";

export interface ActiveAccountResolution {
  connectionId: string;
  source: ActiveAccountSource;
  /** Total number of active connections for this provider — useful for
   *  callers that want to decide whether to render a "pick account" card. */
  candidateCount: number;
}

export interface ResolveActiveAccountParams {
  store: RuntimeStateStore;
  workspaceId: string;
  providerId: string;
  /** Optional — if supplied, conversation_pin takes precedence over
   *  workspace_default. Pass null/undefined for non-session callers
   *  (e.g. composio-mcp host bootstrap, which is per-workspace). */
  sessionId?: string | null;
}

/** Filters connections to only active ones for the given provider, then
 *  walks the priority chain. Returns null when the user has zero active
 *  connections for the provider — caller should propose_connect. */
export function resolveActiveAccount(
  params: ResolveActiveAccountParams,
): ActiveAccountResolution | null {
  const providerKey = params.providerId.trim().toLowerCase();
  if (!providerKey) return null;

  const connections = params.store
    .listIntegrationConnections({ providerId: params.providerId })
    .filter((conn) => conn.status.trim().toLowerCase() === "active");
  if (connections.length === 0) return null;
  const candidateIds = new Set(connections.map((c) => c.connectionId));

  const sessionId = params.sessionId?.trim() ?? "";
  if (sessionId) {
    const pin = params.store.getIntegrationBindingByTarget({
      workspaceId: params.workspaceId,
      targetType: CONVERSATION_PIN_TARGET_TYPE,
      targetId: sessionId,
      integrationKey: params.providerId,
    });
    if (pin && candidateIds.has(pin.connectionId)) {
      return {
        connectionId: pin.connectionId,
        source: "conversation_pin",
        candidateCount: connections.length,
      };
    }
  }

  const workspaceDefault = params.store.getIntegrationBindingByTarget({
    workspaceId: params.workspaceId,
    targetType: WORKSPACE_DEFAULT_TARGET_TYPE,
    targetId: params.workspaceId,
    integrationKey: params.providerId,
  });
  if (workspaceDefault && candidateIds.has(workspaceDefault.connectionId)) {
    return {
      connectionId: workspaceDefault.connectionId,
      source: "workspace_default",
      candidateCount: connections.length,
    };
  }

  return {
    connectionId: connections[0]!.connectionId,
    source: "first_active",
    candidateCount: connections.length,
  };
}
