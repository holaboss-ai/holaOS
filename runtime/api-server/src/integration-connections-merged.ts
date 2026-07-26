import type {
  IntegrationConnectionRecord,
  RuntimeStateStore,
} from "@holaboss/runtime-state-store";

import { getRemoteComposioSource } from "./composio-remote-source.js";
import type { RemoteComposioConnection } from "./composio-toolkit-resolver.js";

// Merged view of a workspace's integration connections: bot-token / manual
// connections live in the local store; Composio connections live ONLY in the
// remote Hono API (single source of truth). These helpers union the two so
// callers see the complete set. On a remote error we degrade to local-only.

function toRecord(conn: RemoteComposioConnection): IntegrationConnectionRecord {
  const id = conn.id.trim();
  const slug = conn.toolkitSlug.trim().toLowerCase();
  return {
    connectionId: id,
    providerId: slug,
    ownerUserId: "",
    accountLabel: slug,
    accountExternalId: id,
    accountHandle: null,
    accountEmail: null,
    contextCronAutoFetchEnabled: false,
    authMode: "composio",
    grantedScopes: [],
    status: conn.status,
    secretRef: null,
    // Carry Composio's connection timestamp through so the account resolver can
    // prefer the most-recently-connected account (a reconnect must win over a
    // stale/revoked older one). Absent → "" sinks to the end of newest-first.
    createdAt: conn.createdAt ?? "",
    updatedAt: "",
  };
}

async function remoteComposioRecords(): Promise<IntegrationConnectionRecord[]> {
  const source = getRemoteComposioSource();
  if (!source) {
    return [];
  }
  try {
    const conns = await source.listConnections();
    return conns
      .filter((c) => c.id.trim() && c.toolkitSlug.trim())
      .map(toRecord);
  } catch {
    return [];
  }
}

export async function listConnectionsMerged(
  store: Pick<RuntimeStateStore, "listIntegrationConnections">,
  opts: { providerId?: string; ownerUserId?: string } = {},
): Promise<IntegrationConnectionRecord[]> {
  const local = store
    .listIntegrationConnections(opts)
    .filter((c) => c.authMode.trim().toLowerCase() !== "composio");
  let remote = await remoteComposioRecords();
  if (opts.providerId) {
    const want = opts.providerId.trim().toLowerCase();
    remote = remote.filter((c) => c.providerId === want);
  }
  return [...local, ...remote];
}

export async function resolveConnectionMerged(
  store: Pick<RuntimeStateStore, "getIntegrationConnection">,
  connectionId: string,
): Promise<IntegrationConnectionRecord | null> {
  const local = store.getIntegrationConnection(connectionId);
  if (local) {
    return local;
  }
  const trimmed = (connectionId ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const source = getRemoteComposioSource();
  if (!source) {
    return null;
  }
  try {
    const conns = await source.listConnections();
    const match = conns.find((c) => c.id.trim() === trimmed);
    return match ? toRecord(match) : null;
  } catch {
    return null;
  }
}
