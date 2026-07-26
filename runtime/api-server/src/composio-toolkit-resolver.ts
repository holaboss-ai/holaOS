import type {
  IntegrationConnectionRecord,
  RuntimeStateStore,
} from "@holaboss/runtime-state-store";

import {
  WORKSPACE_DEFAULT_TARGET_TYPE,
} from "./active-account-resolver.js";
import { isInStoreCatalog } from "./integration-store-catalog.js";

type ResolverStore = Pick<
  RuntimeStateStore,
  | "listIntegrationConnections"
  | "getIntegrationBindingByTarget"
>;

export interface ResolvedToolkitConnection {
  toolkit_slug: string;
  connection_id: string;
  connected_account_id: string;
}

export function resolveActiveToolkitConnections(
  store: ResolverStore,
  workspaceId: string,
): ResolvedToolkitConnection[] {
  const all = store.listIntegrationConnections({});
  const byToolkit = new Map<string, IntegrationConnectionRecord[]>();
  for (const connection of all) {
    if (connection.status.trim().toLowerCase() !== "active") continue;
    const slug = connection.providerId.trim().toLowerCase();
    if (!isInStoreCatalog(slug)) continue;
    if (!(connection.accountExternalId ?? "").trim()) continue;
    const list = byToolkit.get(slug) ?? [];
    list.push(connection);
    byToolkit.set(slug, list);
  }
  const resolved: ResolvedToolkitConnection[] = [];
  for (const [slug, candidates] of byToolkit) {
    if (candidates.length === 1) {
      resolved.push(toResolved(candidates[0]!));
      continue;
    }
    const defaultBinding = workspaceDefaultBindingConnectionId(
      store,
      workspaceId,
      slug,
    );
    const match = defaultBinding
      ? candidates.find((entry) => entry.connectionId === defaultBinding)
      : null;
    resolved.push(toResolved(match ?? candidates[candidates.length - 1]!));
  }
  return resolved;
}

function toResolved(
  connection: IntegrationConnectionRecord,
): ResolvedToolkitConnection {
  return {
    toolkit_slug: connection.providerId.trim().toLowerCase(),
    connection_id: connection.connectionId,
    connected_account_id: (connection.accountExternalId ?? "").trim(),
  };
}

function workspaceDefaultBindingConnectionId(
  store: ResolverStore,
  workspaceId: string,
  providerId: string,
): string | null {
  try {
    const binding = store.getIntegrationBindingByTarget({
      workspaceId,
      targetType: WORKSPACE_DEFAULT_TARGET_TYPE,
      targetId: workspaceId,
      integrationKey: providerId,
    });
    return binding?.connectionId ?? null;
  } catch {
    return null;
  }
}

export interface RemoteComposioConnection {
  /** Composio connected_account_id (ca_xxx) — doubles as the connection id. */
  id: string;
  toolkitSlug: string;
  /** Legacy status string (e.g. "ACTIVE"). */
  status: string;
  /** ISO creation time, used to pick the newest account when several are
   *  active for one toolkit (reconnect churn). Optional / may be empty. */
  createdAt?: string;
}

/** Newest-first by createdAt; entries without a timestamp sink to the end so a
 *  timestamped account always wins over an unknown one. */
function newestFirst(
  a: RemoteComposioConnection,
  b: RemoteComposioConnection,
): number {
  const ta = Date.parse(a.createdAt ?? "");
  const tb = Date.parse(b.createdAt ?? "");
  const va = Number.isNaN(ta) ? -Infinity : ta;
  const vb = Number.isNaN(tb) ? -Infinity : tb;
  return vb - va;
}

export interface RemoteComposioSource {
  listConnections(): Promise<RemoteComposioConnection[]>;
}

type ResolveLogger = {
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  info?: (msg: string, meta?: Record<string, unknown>) => void;
};

/**
 * Remote-primary, local-fallback resolution of a workspace's active Composio
 * toolkit connections. The remote Hono API is the single source of truth for
 * WHICH accounts exist (so the agent sees the same set as the web UI, incl.
 * accounts connected elsewhere); the local store is used only (a) as a
 * fallback when the remote is unreachable, and (b) to honour the workspace
 * default-account binding, a local selection layer with no remote equivalent.
 *
 * On a successful remote read the remote set is authoritative — even when
 * empty (the user genuinely has no Composio accounts). Only a remote ERROR
 * falls back to the legacy local set.
 */
export async function resolveActiveToolkitConnectionsRemoteFirst(params: {
  store: ResolverStore;
  workspaceId: string;
  remote: RemoteComposioSource | null;
  logger?: ResolveLogger;
}): Promise<ResolvedToolkitConnection[]> {
  const local = resolveActiveToolkitConnections(
    params.store,
    params.workspaceId,
  );
  if (!params.remote) {
    params.logger?.warn(
      "composio toolkit resolve: no remote source (bearer token missing?), using local only",
      {
        event: "composio_resolve.no_remote_source",
        workspaceId: params.workspaceId,
        local_slugs: local.map((t) => t.toolkit_slug),
      },
    );
    return local;
  }
  let remoteConnections: RemoteComposioConnection[];
  try {
    remoteConnections = await params.remote.listConnections();
  } catch (error) {
    params.logger?.warn(
      "composio toolkit resolve: remote enumeration failed, using local fallback",
      {
        event: "composio_resolve.remote_failed",
        workspaceId: params.workspaceId,
        err: error instanceof Error ? error.message : String(error),
      },
    );
    return local;
  }
  const resolved = resolveRemoteToolkitConnections(
    remoteConnections,
    params.store,
    params.workspaceId,
  );
  // Grey-rollout observability: surface any divergence between the remote
  // (new, authoritative) toolkit set and the local (legacy) one, so we can
  // confirm the agent's tool surface doesn't silently shrink before cutover.
  const localSlugs = new Set(local.map((t) => t.toolkit_slug));
  const remoteSlugs = new Set(resolved.map((t) => t.toolkit_slug));
  const onlyLocal = [...localSlugs].filter((s) => !remoteSlugs.has(s));
  const onlyRemote = [...remoteSlugs].filter((s) => !localSlugs.has(s));
  if (onlyLocal.length > 0 || onlyRemote.length > 0) {
    params.logger?.info?.(
      "composio toolkit resolve: remote/local toolkit set diverged",
      {
        event: "composio_resolve.diverged",
        workspaceId: params.workspaceId,
        only_local: onlyLocal,
        only_remote: onlyRemote,
      },
    );
  }
  params.logger?.info?.("composio toolkit resolve: resolved from remote", {
    event: "composio_resolve.result",
    workspaceId: params.workspaceId,
    remote_count: remoteConnections.length,
    resolved_slugs: resolved.map((t) => t.toolkit_slug),
  });
  return resolved;
}

function resolveRemoteToolkitConnections(
  remoteConnections: RemoteComposioConnection[],
  store: ResolverStore,
  workspaceId: string,
): ResolvedToolkitConnection[] {
  const byToolkit = new Map<string, RemoteComposioConnection[]>();
  for (const conn of remoteConnections) {
    if (conn.status.trim().toLowerCase() !== "active") continue;
    const slug = conn.toolkitSlug.trim().toLowerCase();
    if (!isInStoreCatalog(slug)) continue;
    if (!conn.id.trim()) continue;
    const list = byToolkit.get(slug) ?? [];
    list.push(conn);
    byToolkit.set(slug, list);
  }
  const resolved: ResolvedToolkitConnection[] = [];
  for (const [slug, candidates] of byToolkit) {
    if (candidates.length === 1) {
      resolved.push(toResolvedRemote(candidates[0]!));
      continue;
    }
    // Multiple active accounts for one toolkit. Honour the workspace default
    // binding if it still matches an active account; otherwise fall back to
    // the NEWEST active account (by createdAt) — not an arbitrary list
    // position, which reconnect churn made unreliable.
    const defaultAccountId = workspaceDefaultAccountExternalId(
      store,
      workspaceId,
      slug,
    );
    const match = defaultAccountId
      ? candidates.find((entry) => entry.id === defaultAccountId)
      : null;
    const newest = [...candidates].sort(newestFirst)[0]!;
    resolved.push(toResolvedRemote(match ?? newest));
  }
  return resolved;
}

function toResolvedRemote(
  conn: RemoteComposioConnection,
): ResolvedToolkitConnection {
  const id = conn.id.trim();
  return {
    toolkit_slug: conn.toolkitSlug.trim().toLowerCase(),
    connection_id: id,
    connected_account_id: id,
  };
}

// The workspace default binding stores a LOCAL connection id; translate it to
// the Composio account id so it can be matched against the remote set. Falls
// back to treating the binding id AS the account id (older rows keyed by the
// Composio account id directly).
function workspaceDefaultAccountExternalId(
  store: ResolverStore,
  workspaceId: string,
  providerId: string,
): string | null {
  const bindingConnectionId = workspaceDefaultBindingConnectionId(
    store,
    workspaceId,
    providerId,
  );
  if (!bindingConnectionId) {
    return null;
  }
  try {
    const localMatch = store
      .listIntegrationConnections({})
      .find((c) => c.connectionId === bindingConnectionId);
    const external = (localMatch?.accountExternalId ?? "").trim();
    return external || bindingConnectionId;
  } catch {
    return bindingConnectionId;
  }
}

// (Removed: `resolveComposioInlineToolRefs` + its `ComposioInlineToolRef` /
// `ComposioInlineSchemaLookup` types — dead code with no live callers, and a
// second resolver that still read the local store. The active agent path is
// the `/api/v1/capabilities/composio-inline-tools` handler, now remote-first.)
