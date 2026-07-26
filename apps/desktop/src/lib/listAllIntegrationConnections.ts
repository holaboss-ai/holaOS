import { composioToolkitSlugForProvider } from "@/lib/workspaceDesktop";

// Composio connections live only in the remote Hono API — they are no longer
// mirrored into the local control-plane store, so the local
// `listIntegrationConnections` IPC returns bot-token connections only. This
// helper is the single place that returns the COMPLETE set — local bot-token ∪
// remote Composio (mapped to the same payload shape) — so every renderer
// surface (recommendations, suggestions, proposal cards, onboarding, counts)
// sees the same connections the agent does. The merged result is briefly
// cached so a burst of mounting components doesn't each re-fetch.

const MERGE_TTL_MS = 5000;

let cache: {
  at: number;
  value: { connections: IntegrationConnectionPayload[] };
} | null = null;
let inflight: Promise<{ connections: IntegrationConnectionPayload[] }> | null =
  null;
// Set by invalidate(): the NEXT merged fetch must also bypass the main-process
// composio connections cache (~90s TTL), else a just-connected account stays
// invisible even after we drop this module's own cache. Consumed once — later
// reads ride the fresh 5s cache the forced read just wrote.
let forceNextRemoteRead = false;

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

async function fetchMerged(): Promise<{
  connections: IntegrationConnectionPayload[];
}> {
  let botTokenLocal: IntegrationConnectionPayload[] = [];
  try {
    const local =
      await window.electronAPI.workspace.listIntegrationConnections();
    botTokenLocal = local.connections.filter(
      (conn) => trimmed(conn.auth_mode).toLowerCase() !== "composio",
    );
  } catch {
    botTokenLocal = [];
  }

  let remoteComposio: IntegrationConnectionPayload[] = [];
  try {
    const forceRemote = forceNextRemoteRead;
    forceNextRemoteRead = false;
    const [catalogResult, composioResult] = await Promise.all([
      window.electronAPI.workspace.listIntegrationCatalog(),
      window.electronAPI.workspace.composioListConnections(forceRemote),
    ]);
    const providerByToolkitSlug = new Map<string, string>();
    for (const provider of catalogResult.providers) {
      const pid = trimmed(provider.provider_id).toLowerCase();
      if (!pid) {
        continue;
      }
      const slug = composioToolkitSlugForProvider(pid);
      if (!providerByToolkitSlug.has(slug)) {
        providerByToolkitSlug.set(slug, pid);
      }
    }
    remoteComposio = composioResult.connections.map((remote) => {
      const slug = trimmed(remote.toolkitSlug).toLowerCase();
      const providerId = providerByToolkitSlug.get(slug) ?? slug;
      const status = trimmed(remote.status).toLowerCase() || "active";
      return {
        connection_id: remote.id,
        provider_id: providerId,
        owner_user_id: remote.userId ?? "",
        account_label: trimmed(remote.toolkitName) || "Account",
        account_external_id: remote.id,
        account_handle: null,
        account_email: null,
        auth_mode: "composio",
        granted_scopes: [],
        status,
        secret_ref: null,
        created_at: remote.createdAt ?? "",
        updated_at: remote.createdAt ?? "",
      };
    });
  } catch {
    remoteComposio = [];
  }

  return { connections: [...botTokenLocal, ...remoteComposio] };
}

/** Local bot-token connections merged with remote Composio connections —
 *  the complete set every renderer surface should read. Never throws; on a
 *  remote failure it falls back to whatever local connections resolved. */
export async function listAllIntegrationConnections(): Promise<{
  connections: IntegrationConnectionPayload[];
}> {
  const now = Date.now();
  if (cache && now - cache.at < MERGE_TTL_MS) {
    return cache.value;
  }
  if (inflight) {
    return inflight;
  }
  inflight = fetchMerged()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function invalidateAllIntegrationConnections(): void {
  cache = null;
  forceNextRemoteRead = true;
}
