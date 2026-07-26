import { invalidateIntegrationAccountCache } from "./integrationAccountStore";
import { invalidateAllIntegrationConnections } from "./listAllIntegrationConnections";

// Sever one integration connection. Mirrors IntegrationsPane.performDisconnect's
// core: revoke the upstream Composio account first (that's the real disconnect —
// it releases the OAuth grant), then remove the local row for bot-token
// connections (Composio rows are remote-only, so there's nothing local to delete).
// Finally invalidate the caches so every surface re-reads the connection set.
//
// Throws if the upstream revoke fails — the caller surfaces it and keeps the
// account, rather than pretending it disconnected. A Composio 404 (already gone)
// is a success upstream and does not reach here.
export async function disconnectConnection(params: {
  connectionId: string;
  /** `account_external_id` — the Composio connected_account id, when present. */
  externalId?: string | null;
  /** `auth_mode` — only non-"composio" (bot-token) rows live in the local store. */
  authMode: string;
}): Promise<void> {
  const { connectionId, externalId, authMode } = params;
  const upstreamId = externalId?.trim();
  if (upstreamId) {
    await window.electronAPI.workspace.composioDeleteUpstream(upstreamId);
  }
  if (authMode !== "composio") {
    await window.electronAPI.workspace.deleteIntegrationConnection(connectionId);
  }
  invalidateIntegrationAccountCache([connectionId]);
  invalidateAllIntegrationConnections();
}
