import {
  type IntegrationConnectionRecord,
  type IntegrationTreeRecord,
  type RuntimeStateStore,
  type WorkspaceIntegrationOverrideRecord,
} from "@holaboss/runtime-state-store";

function normalizeToken(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isActiveIntegrationConnection(connection: IntegrationConnectionRecord): boolean {
  return normalizeToken(connection.status) === "active";
}

export function stableIntegrationAccountKey(connection: IntegrationConnectionRecord): string {
  const normalized = (value: string | null | undefined): string | null => {
    const token = typeof value === "string" ? value.trim() : "";
    return token || null;
  };
  return normalized(connection.accountHandle)
    ?? normalized(connection.accountEmail)
    ?? normalized(connection.accountExternalId)
    ?? connection.connectionId;
}

function workspaceOverrideByToolkit(
  store: RuntimeStateStore,
  workspaceId: string,
): Map<string, WorkspaceIntegrationOverrideRecord> {
  const byToolkit = new Map<string, WorkspaceIntegrationOverrideRecord>();
  for (const override of store.listWorkspaceIntegrationOverrides({ workspaceId })) {
    byToolkit.set(normalizeToken(override.toolkitSlug), override);
  }
  return byToolkit;
}

export function visibleIntegrationConnectionsForWorkspace(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): IntegrationConnectionRecord[] {
  const overrides = workspaceOverrideByToolkit(params.store, params.workspaceId);
  const activeConnections = params.store
    .listIntegrationConnections({})
    .filter((connection) => isActiveIntegrationConnection(connection));
  const grouped = new Map<string, IntegrationConnectionRecord[]>();
  for (const connection of activeConnections) {
    const toolkitSlug = normalizeToken(connection.providerId);
    const bucket = grouped.get(toolkitSlug);
    if (bucket) {
      bucket.push(connection);
    } else {
      grouped.set(toolkitSlug, [connection]);
    }
  }

  const visible: IntegrationConnectionRecord[] = [];
  for (const [toolkitSlug, connections] of grouped) {
    const override = overrides.get(toolkitSlug) ?? null;
    if (override?.state === "disabled") {
      continue;
    }
    if (override?.state === "pinned") {
      const pinned = connections.find(
        (connection) => connection.connectionId === override.pinnedConnectionId,
      );
      if (pinned) {
        visible.push(pinned);
      }
      continue;
    }
    visible.push(...connections);
  }
  return visible;
}

export function visibleIntegrationTreesForWorkspace(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
}): IntegrationTreeRecord[] {
  const requestedTreeId = (params.treeId ?? "").trim();
  const byTreeId = new Map<string, IntegrationTreeRecord>();
  for (const connection of visibleIntegrationConnectionsForWorkspace(params)) {
    const tree = params.store.getIntegrationTreeByAccountIdentity({
      provider: connection.providerId,
      ownerUserId: connection.ownerUserId,
      accountKey: stableIntegrationAccountKey(connection),
    });
    if (!tree || tree.status !== "active") {
      continue;
    }
    if (requestedTreeId && tree.treeId !== requestedTreeId) {
      continue;
    }
    byTreeId.set(tree.treeId, tree);
  }
  return [...byTreeId.values()];
}
