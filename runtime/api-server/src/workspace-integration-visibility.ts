import { createHash } from "node:crypto";

import {
  type IntegrationConnectionRecord,
  type IntegrationTreeRecord,
  type RuntimeStateStore,
  type SemanticMemoryNodeRecord,
} from "@holaboss/runtime-state-store";

import { listConnectionsMerged } from "./integration-connections-merged.js";

const WORKSPACE_INTEGRATION_SEMANTIC_ROOT_BACKFILL_KEY =
  "integration_semantic_root_backfill_v1_complete";
const WORKSPACE_INTEGRATION_SEMANTIC_ROOT_TREE_BACKFILL_KEY_PREFIX =
  "integration_semantic_root_backfill_v1:";

function normalizeToken(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isActiveIntegrationConnection(connection: IntegrationConnectionRecord): boolean {
  return normalizeToken(connection.status) === "active";
}

function semanticIntegrationTreeSlug(nodePath: string, fallback: string): string {
  const segments = nodePath
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const patterns = [
    ["semantic", "workspace", "systems", "integrations"],
    ["semantic", "integration", "trees"],
    ["workspace", "systems", "integrations"],
    ["integration", "trees"],
  ];
  for (const pattern of patterns) {
    for (let index = 0; index <= segments.length - pattern.length - 1; index += 1) {
      const matches = pattern.every((segment, offset) => segments[index + offset] === segment);
      if (!matches) {
        continue;
      }
      const slug = segments[index + pattern.length] ?? "";
      if (slug) {
        return slug;
      }
    }
  }
  const normalizedFallback = fallback
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalizedFallback || "integration-tree";
}

function semanticIntegrationRootNodeId(treeId: string): string {
  return `semantic:integration:${treeId}:connection`;
}

function semanticIntegrationTreeRelativePath(treeSlug: string): string {
  return `semantic/workspace/systems/integrations/${treeSlug}/content.md`;
}

function semanticBootstrapBody(tree: IntegrationTreeRecord): string {
  return [
    `# ${tree.accountDisplayName}`,
    "",
    `- Tree ID: \`${tree.treeId}\``,
    `- Workspace: ${tree.workspaceId ?? "unknown"}`,
    `- Provider: ${tree.provider}`,
    `- Account namespace: ${tree.accountNamespace}`,
    "",
    "## Summary",
    "",
    tree.summary ?? `${tree.accountDisplayName} integration memory tree.`,
    "",
  ].join("\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function integrationSemanticRootBackfillMetadataKey(treeId: string): string {
  return `${WORKSPACE_INTEGRATION_SEMANTIC_ROOT_TREE_BACKFILL_KEY_PREFIX}${treeId}`;
}

function materializeWorkspaceSemanticRootFromLegacyTree(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  tree: IntegrationTreeRecord;
}): void {
  // workspace-removal Piece 5.7: raw integration trees are account-global now
  // (control-plane-only), so `tree.workspaceId` is null. The workspace to project
  // this tree's semantic root into comes from the caller's scope, not the tree.
  const workspaceId = (params.workspaceId ?? "").trim();
  if (!workspaceId) {
    return;
  }
  if (
    typeof (params.store as { getSemanticMemoryNode?: unknown }).getSemanticMemoryNode !== "function"
    || typeof (params.store as { upsertSemanticMemoryNode?: unknown }).upsertSemanticMemoryNode !== "function"
    || typeof (params.store as { upsertSemanticMemorySearchDoc?: unknown }).upsertSemanticMemorySearchDoc !== "function"
  ) {
    return;
  }
  const nodeId = semanticIntegrationRootNodeId(params.tree.treeId);
  const path = semanticIntegrationTreeRelativePath(params.tree.slug);
  const title = params.tree.accountDisplayName;
  const summary = params.tree.summary ?? `${params.tree.accountDisplayName} integration memory tree.`;
  const body = semanticBootstrapBody(params.tree);
  const existingNode = params.store.getSemanticMemoryNode({
    category: "workspace",
    workspaceId,
    treeId: params.tree.treeId,
    nodeId,
  });
  params.store.upsertSemanticMemoryNode({
    category: "workspace",
    workspaceId,
    treeId: params.tree.treeId,
    nodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    sourceLeafId: null,
    path,
    title,
    summary,
    bodySha256: sha256(body),
    childCount: existingNode?.childCount ?? 0,
    observedAt: params.tree.updatedAt,
    status: params.tree.status === "archived" ? "archived" : "active",
    isMaterialized: existingNode?.isMaterialized ?? false,
    metadata: {
      ...(existingNode?.metadata ?? {}),
      provider: params.tree.provider,
      account_namespace: params.tree.accountNamespace,
    },
    createdAt: existingNode?.createdAt ?? params.tree.createdAt,
    updatedAt: params.tree.updatedAt,
  });
  params.store.upsertSemanticMemorySearchDoc({
    category: "workspace",
    workspaceId,
    treeId: params.tree.treeId,
    nodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    path,
    childCount: existingNode?.childCount ?? 0,
    title,
    summary,
    bodyText: body,
    excerpt: summary,
    observedAt: params.tree.updatedAt,
    status: params.tree.status === "archived" ? "archived" : "active",
    updatedAt: params.tree.updatedAt,
  });
}

export function ensureWorkspaceIntegrationRootsMigrated(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  requestedTreeId?: string | null;
  existingTreeIds: Set<string>;
}): void {
  const requestedTreeId = (params.requestedTreeId ?? "").trim();
  if (requestedTreeId) {
    if (params.existingTreeIds.has(requestedTreeId)) {
      return;
    }
    if (
      params.store.getWorkspaceRuntimeMetadata({
        workspaceId: params.workspaceId,
        key: integrationSemanticRootBackfillMetadataKey(requestedTreeId),
      }) === "true"
    ) {
      return;
    }
    if (backfillWorkspaceSemanticRootsFromLegacySemanticRoots(params)) {
      return;
    }
    // The passed workspaceId is ignored by the store (integration trees are
    // control-plane-only now, Piece 5.7), but the getIntegrationTree /
    // listIntegrationTrees capability-detection is retained: partial mock stores in
    // tests implement only one of the two, so both code paths must stay reachable.
    const directTree = typeof (params.store as { getIntegrationTree?: unknown }).getIntegrationTree === "function"
      ? params.store.getIntegrationTree({
        workspaceId: params.workspaceId,
        treeId: requestedTreeId,
      })
      : null;
    if (directTree?.status === "active") {
      materializeWorkspaceSemanticRootFromLegacyTree({
        store: params.store,
        workspaceId: params.workspaceId,
        tree: directTree,
      });
      params.store.setWorkspaceRuntimeMetadata({
        workspaceId: params.workspaceId,
        key: integrationSemanticRootBackfillMetadataKey(directTree.treeId),
        value: "true",
      });
      return;
    }
    if (!directTree) {
      for (const tree of params.store.listIntegrationTrees({
        workspaceId: params.workspaceId,
        status: "active",
        limit: 10_000,
        offset: 0,
      })) {
        if (tree.treeId !== requestedTreeId) {
          continue;
        }
        materializeWorkspaceSemanticRootFromLegacyTree({
          store: params.store,
          workspaceId: params.workspaceId,
          tree,
        });
        params.store.setWorkspaceRuntimeMetadata({
          workspaceId: params.workspaceId,
          key: integrationSemanticRootBackfillMetadataKey(tree.treeId),
          value: "true",
        });
        return;
      }
    }
    return;
  }
  if (
    params.store.getWorkspaceRuntimeMetadata({
      workspaceId: params.workspaceId,
      key: WORKSPACE_INTEGRATION_SEMANTIC_ROOT_BACKFILL_KEY,
    }) === "true"
  ) {
    return;
  }
  backfillWorkspaceSemanticRootsFromLegacySemanticRoots(params);
  for (const tree of params.store.listIntegrationTrees({
    workspaceId: params.workspaceId,
    status: "active",
    limit: 10_000,
    offset: 0,
  })) {
    if (params.existingTreeIds.has(tree.treeId)) {
      continue;
    }
    materializeWorkspaceSemanticRootFromLegacyTree({
      store: params.store,
      workspaceId: params.workspaceId,
      tree,
    });
    params.store.setWorkspaceRuntimeMetadata({
      workspaceId: params.workspaceId,
      key: integrationSemanticRootBackfillMetadataKey(tree.treeId),
      value: "true",
    });
  }
  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_INTEGRATION_SEMANTIC_ROOT_BACKFILL_KEY,
    value: "true",
  });
}

function integrationTreeRecordFromSemanticRoot(params: {
  workspaceId: string;
  node: SemanticMemoryNodeRecord;
}): IntegrationTreeRecord | null {
  const provider = normalizeToken(
    typeof params.node.metadata.provider === "string"
      ? params.node.metadata.provider
      : null,
  );
  const accountNamespaceRaw =
    typeof params.node.metadata.account_namespace === "string"
      ? params.node.metadata.account_namespace
      : null;
  const accountNamespace = (accountNamespaceRaw ?? "").trim();
  if (!provider || !accountNamespace) {
    return null;
  }
  const accountDisplayName = params.node.title.trim() || accountNamespace;
  return {
    workspaceId: params.workspaceId,
    treeId: params.node.treeId,
    provider,
    ownerUserId: "",
    accountNamespace,
    accountDisplayName,
    accountKey: accountNamespace,
    accountLabel: accountDisplayName,
    slug: semanticIntegrationTreeSlug(
      params.node.path,
      `${provider}-${accountNamespace}`,
    ),
    summary: params.node.summary,
    status: params.node.status === "archived" ? "archived" : "active",
    createdAt: params.node.createdAt,
    updatedAt: params.node.updatedAt,
  };
}

function legacySemanticIntegrationTreesForWorkspace(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
}): IntegrationTreeRecord[] {
  const requestedTreeId = (params.treeId ?? "").trim();
  const byTreeId = new Map<string, IntegrationTreeRecord>();
  for (const node of params.store.listSemanticMemoryNodes({
    category: "integration",
    workspaceId: params.workspaceId,
    treeId: requestedTreeId || undefined,
    nodeClass: "semantic",
    nodeKind: "connection",
    status: "active",
    limit: 10_000,
    offset: 0,
  })) {
    if (byTreeId.has(node.treeId)) {
      continue;
    }
    const record = integrationTreeRecordFromSemanticRoot({
      workspaceId: params.workspaceId,
      node,
    });
    if (record) {
      byTreeId.set(record.treeId, record);
    }
  }
  return [...byTreeId.values()];
}

function backfillWorkspaceSemanticRootsFromLegacySemanticRoots(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  requestedTreeId?: string | null;
  existingTreeIds: Set<string>;
}): boolean {
  let backfilled = false;
  for (const tree of legacySemanticIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
    treeId: params.requestedTreeId ?? null,
  })) {
    if (params.existingTreeIds.has(tree.treeId)) {
      continue;
    }
    materializeWorkspaceSemanticRootFromLegacyTree({
      store: params.store,
      workspaceId: params.workspaceId,
      tree,
    });
    params.store.setWorkspaceRuntimeMetadata({
      workspaceId: params.workspaceId,
      key: integrationSemanticRootBackfillMetadataKey(tree.treeId),
      value: "true",
    });
    backfilled = true;
  }
  return backfilled;
}

function semanticIntegrationTreesForWorkspace(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
}): IntegrationTreeRecord[] {
  const requestedTreeId = (params.treeId ?? "").trim();
  const byTreeId = new Map<string, IntegrationTreeRecord>();
  for (const node of params.store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId: requestedTreeId || undefined,
    nodeClass: "semantic",
    nodeKind: "connection",
    status: "active",
    limit: 10_000,
    offset: 0,
  })) {
    if (byTreeId.has(node.treeId)) {
      continue;
    }
    const record = integrationTreeRecordFromSemanticRoot({
      workspaceId: params.workspaceId,
      node,
    });
    if (record) {
      byTreeId.set(record.treeId, record);
    }
  }
  return [...byTreeId.values()];
}

export async function visibleIntegrationConnectionsForWorkspace(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): Promise<IntegrationConnectionRecord[]> {
  // Workspaces always inherit the full account-active integration pool; there
  // is no per-workspace enable/disable or pin.
  return (await listConnectionsMerged(params.store, {})).filter((connection) =>
    isActiveIntegrationConnection(connection),
  );
}

export function visibleIntegrationTreesForWorkspace(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
}): IntegrationTreeRecord[] {
  const requestedTreeId = (params.treeId ?? "").trim();
  const records = new Map<string, IntegrationTreeRecord>();
  if (typeof (params.store as { listSemanticMemoryNodes?: unknown }).listSemanticMemoryNodes === "function") {
    for (const tree of semanticIntegrationTreesForWorkspace(params)) {
      records.set(tree.treeId, tree);
    }
  }
  return [...records.values()].filter((tree) => {
    if (requestedTreeId && tree.treeId !== requestedTreeId) {
      return false;
    }
    return true;
  });
}
