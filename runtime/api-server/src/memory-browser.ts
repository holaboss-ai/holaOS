import fs from "node:fs";
import path from "node:path";

import {
  type RuntimeStateStore,
} from "@holaboss/runtime-state-store";

import {
  globalMemoryDirForWorkspaceRoot,
  workspaceMemoryDir,
} from "./workspace-bundle-paths.js";
import { visibleIntegrationTreesForWorkspace } from "./workspace-integration-visibility.js";

export interface MemoryBrowserTreeNode {
  name: string;
  path: string;
  kind: "directory" | "file";
  size_bytes: number | null;
  modified_at: string | null;
  children?: MemoryBrowserTreeNode[];
}

export interface MemoryBrowserTreeResponse {
  workspace_id: string;
  root: MemoryBrowserTreeNode;
  counts: {
    directories: number;
    files: number;
  };
}

export interface MemoryBrowserFileResponse {
  workspace_id: string;
  path: string;
  name: string;
  size_bytes: number;
  modified_at: string;
  content: string;
}

export type MemoryBrowserGraphForest = "workspace" | "integrations";
export type MemoryBrowserGraphNodeKind = "root" | "tree" | "summary" | "leaf";

export interface MemoryBrowserGraphNode {
  id: string;
  kind: MemoryBrowserGraphNodeKind;
  category: "interaction" | "integration";
  tree_id: string | null;
  label: string;
  subtitle: string | null;
  status: string | null;
  level: number | null;
  child_count: number | null;
  path: string | null;
}

export interface MemoryBrowserGraphEdge {
  from: string;
  to: string;
  kind: "contains" | "parent_child";
}

export interface MemoryBrowserGraphResponse {
  workspace_id: string;
  forest: MemoryBrowserGraphForest;
  focus_tree_id: string | null;
  nodes: MemoryBrowserGraphNode[];
  edges: MemoryBrowserGraphEdge[];
}

function accessibleIntegrationTreesForWorkspace(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}) {
  return visibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
  }).sort((left, right) => left.slug.localeCompare(right.slug));
}

function interactionRootNodeId(workspaceId: string): string {
  return `root:workspace:${workspaceId}`;
}

function integrationRootNodeId(): string {
  return "root:integrations";
}

function interactionTreeNodeId(entityId: string): string {
  return `tree:interaction:${entityId}`;
}

function integrationTreeNodeId(treeId: string): string {
  return `tree:integration:${treeId}`;
}

function interactionSummaryGraphNodeId(nodeId: string): string {
  return `summary:interaction:${nodeId}`;
}

function integrationSummaryGraphNodeId(nodeId: string): string {
  return `summary:integration:${nodeId}`;
}

function interactionLeafGraphNodeId(leafId: string): string {
  return `leaf:interaction:${leafId}`;
}

function integrationLeafGraphNodeId(leafId: string): string {
  return `leaf:integration:${leafId}`;
}

function shortLabel(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized || fallback;
}

function interactionTreeSubtitle(entityType: string): string {
  return entityType.replaceAll("_", " ");
}

function integrationTreeSubtitle(params: {
  provider: string;
  ownerUserId: string;
}): string {
  return `${params.provider} · ${params.ownerUserId}`;
}

function appendUniqueGraphNode(
  bucket: MemoryBrowserGraphNode[],
  index: Set<string>,
  node: MemoryBrowserGraphNode,
): void {
  if (index.has(node.id)) {
    return;
  }
  index.add(node.id);
  bucket.push(node);
}

function appendUniqueGraphEdge(
  bucket: MemoryBrowserGraphEdge[],
  index: Set<string>,
  edge: MemoryBrowserGraphEdge,
): void {
  const key = `${edge.from}->${edge.to}:${edge.kind}`;
  if (index.has(key)) {
    return;
  }
  index.add(key);
  bucket.push(edge);
}

function buildInteractionGraph(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
}): MemoryBrowserGraphResponse {
  const workspace = params.store.getWorkspace(params.workspaceId);
  if (!workspace) {
    throw new Error("workspace not found");
  }
  const focusTreeId = (params.treeId ?? "").trim() || null;
  const rootNodeId = interactionRootNodeId(params.workspaceId);
  const rootLabel =
    shortLabel(workspace.name ?? "", params.workspaceId);
  const nodes: MemoryBrowserGraphNode[] = [];
  const nodeIds = new Set<string>();
  const edges: MemoryBrowserGraphEdge[] = [];
  const edgeIds = new Set<string>();

  appendUniqueGraphNode(nodes, nodeIds, {
    id: rootNodeId,
    kind: "root",
    category: "interaction",
    tree_id: null,
    label: rootLabel,
    subtitle: "workspace forest",
    status: null,
    level: 0,
    child_count: null,
    path: null,
  });

  const entities = focusTreeId
    ? [params.store.getInteractionEntity({ workspaceId: params.workspaceId, entityId: focusTreeId })]
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
    : params.store.listInteractionEntities({
        workspaceId: params.workspaceId,
        status: "active",
        includeSystem: true,
        limit: 1000,
      });
  if (focusTreeId && entities.length === 0) {
    throw new Error("interaction tree not found");
  }

  for (const entity of entities) {
    const treeNodeId = interactionTreeNodeId(entity.entityId);
    appendUniqueGraphNode(nodes, nodeIds, {
      id: treeNodeId,
      kind: "tree",
      category: "interaction",
      tree_id: entity.entityId,
      label: shortLabel(entity.canonicalName, entity.slug),
      subtitle: interactionTreeSubtitle(entity.entityType),
      status: entity.status,
      level: 1,
      child_count: null,
      path: null,
    });
    appendUniqueGraphEdge(edges, edgeIds, {
      from: rootNodeId,
      to: treeNodeId,
      kind: "contains",
    });

    const summaries = params.store.listInteractionSummaryNodes({
      workspaceId: params.workspaceId,
      entityId: entity.entityId,
      status: "active",
      limit: 5000,
    });
    const leaves = params.store.listInteractionLeaves({
      workspaceId: params.workspaceId,
      entityId: entity.entityId,
      status: "active",
      limit: 5000,
    });
    const childSummaryIds = new Set<string>();
    const connectedLeafIds = new Set<string>();

    for (const summary of summaries) {
      appendUniqueGraphNode(nodes, nodeIds, {
        id: interactionSummaryGraphNodeId(summary.nodeId),
        kind: "summary",
        category: "interaction",
        tree_id: entity.entityId,
        label: shortLabel(summary.title, `L${summary.level}`),
        subtitle: `L${summary.level}`,
        status: summary.status,
        level: summary.level,
        child_count: summary.childCount,
        path: summary.path,
      });
    }
    for (const leaf of leaves) {
      appendUniqueGraphNode(nodes, nodeIds, {
        id: interactionLeafGraphNodeId(leaf.leafId),
        kind: "leaf",
        category: "interaction",
        tree_id: entity.entityId,
        label: shortLabel(leaf.title, leaf.subjectKey),
        subtitle: leaf.subjectKey,
        status: leaf.status,
        level: null,
        child_count: null,
        path: leaf.path,
      });
    }

    for (const summary of summaries) {
      const children = params.store.listInteractionTreeChildren({
        workspaceId: params.workspaceId,
        parentNodeId: summary.nodeId,
      });
      for (const child of children) {
        if (child.childKind === "summary") {
          childSummaryIds.add(child.childId);
          appendUniqueGraphEdge(edges, edgeIds, {
            from: interactionSummaryGraphNodeId(summary.nodeId),
            to: interactionSummaryGraphNodeId(child.childId),
            kind: "parent_child",
          });
        } else {
          connectedLeafIds.add(child.childId);
          appendUniqueGraphEdge(edges, edgeIds, {
            from: interactionSummaryGraphNodeId(summary.nodeId),
            to: interactionLeafGraphNodeId(child.childId),
            kind: "parent_child",
          });
        }
      }
    }

    const rootSummaries = summaries.filter(
      (summary) => !childSummaryIds.has(summary.nodeId),
    );
    for (const summary of rootSummaries) {
      appendUniqueGraphEdge(edges, edgeIds, {
        from: treeNodeId,
        to: interactionSummaryGraphNodeId(summary.nodeId),
        kind: "contains",
      });
    }
    if (summaries.length === 0) {
      for (const leaf of leaves) {
        appendUniqueGraphEdge(edges, edgeIds, {
          from: treeNodeId,
          to: interactionLeafGraphNodeId(leaf.leafId),
          kind: "contains",
        });
      }
    } else {
      for (const leaf of leaves) {
        if (connectedLeafIds.has(leaf.leafId)) {
          continue;
        }
        appendUniqueGraphEdge(edges, edgeIds, {
          from: treeNodeId,
          to: interactionLeafGraphNodeId(leaf.leafId),
          kind: "contains",
        });
      }
    }
  }

  return {
    workspace_id: params.workspaceId,
    forest: "workspace",
    focus_tree_id: focusTreeId,
    nodes,
    edges,
  };
}

function buildIntegrationGraph(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
}): MemoryBrowserGraphResponse {
  const focusTreeId = (params.treeId ?? "").trim() || null;
  const visibleTrees = accessibleIntegrationTreesForWorkspace(params);
  const trees = focusTreeId
    ? visibleTrees.filter((tree) => tree.treeId === focusTreeId)
    : visibleTrees;
  if (focusTreeId && trees.length === 0) {
    throw new Error("integration tree not found");
  }

  const rootNodeId = integrationRootNodeId();
  const nodes: MemoryBrowserGraphNode[] = [];
  const nodeIds = new Set<string>();
  const edges: MemoryBrowserGraphEdge[] = [];
  const edgeIds = new Set<string>();

  appendUniqueGraphNode(nodes, nodeIds, {
    id: rootNodeId,
    kind: "root",
    category: "integration",
    tree_id: null,
    label: "Integrations",
    subtitle: "global account forest",
    status: null,
    level: 0,
    child_count: null,
    path: null,
  });

  for (const tree of trees) {
    const treeNodeId = integrationTreeNodeId(tree.treeId);
    appendUniqueGraphNode(nodes, nodeIds, {
      id: treeNodeId,
      kind: "tree",
      category: "integration",
      tree_id: tree.treeId,
      label: shortLabel(tree.accountLabel, tree.accountKey),
      subtitle: integrationTreeSubtitle({
        provider: tree.provider,
        ownerUserId: tree.ownerUserId,
      }),
      status: tree.status,
      level: 1,
      child_count: null,
      path: null,
    });
    appendUniqueGraphEdge(edges, edgeIds, {
      from: rootNodeId,
      to: treeNodeId,
      kind: "contains",
    });

    const summaries = params.store.listIntegrationSummaryNodes({
      treeId: tree.treeId,
      status: "active",
      limit: 5000,
    });
    const leaves = params.store.listIntegrationLeaves({
      treeId: tree.treeId,
      status: "active",
      limit: 5000,
    });
    const childSummaryIds = new Set<string>();
    const connectedLeafIds = new Set<string>();

    for (const summary of summaries) {
      appendUniqueGraphNode(nodes, nodeIds, {
        id: integrationSummaryGraphNodeId(summary.nodeId),
        kind: "summary",
        category: "integration",
        tree_id: tree.treeId,
        label: shortLabel(summary.title, `L${summary.level}`),
        subtitle: `L${summary.level}`,
        status: summary.status,
        level: summary.level,
        child_count: summary.childCount,
        path: summary.path,
      });
    }
    for (const leaf of leaves) {
      appendUniqueGraphNode(nodes, nodeIds, {
        id: integrationLeafGraphNodeId(leaf.leafId),
        kind: "leaf",
        category: "integration",
        tree_id: tree.treeId,
        label: shortLabel(leaf.title, leaf.subjectKey),
        subtitle: leaf.externalObjectType ?? leaf.subjectKey,
        status: leaf.status,
        level: null,
        child_count: null,
        path: leaf.path,
      });
    }

    for (const summary of summaries) {
      const children = params.store.listIntegrationTreeChildren({
        parentNodeId: summary.nodeId,
      });
      for (const child of children) {
        if (child.childKind === "summary") {
          childSummaryIds.add(child.childId);
          appendUniqueGraphEdge(edges, edgeIds, {
            from: integrationSummaryGraphNodeId(summary.nodeId),
            to: integrationSummaryGraphNodeId(child.childId),
            kind: "parent_child",
          });
        } else {
          connectedLeafIds.add(child.childId);
          appendUniqueGraphEdge(edges, edgeIds, {
            from: integrationSummaryGraphNodeId(summary.nodeId),
            to: integrationLeafGraphNodeId(child.childId),
            kind: "parent_child",
          });
        }
      }
    }

    const rootSummaries = summaries.filter(
      (summary) => !childSummaryIds.has(summary.nodeId),
    );
    for (const summary of rootSummaries) {
      appendUniqueGraphEdge(edges, edgeIds, {
        from: treeNodeId,
        to: integrationSummaryGraphNodeId(summary.nodeId),
        kind: "contains",
      });
    }
    if (summaries.length === 0) {
      for (const leaf of leaves) {
        appendUniqueGraphEdge(edges, edgeIds, {
          from: treeNodeId,
          to: integrationLeafGraphNodeId(leaf.leafId),
          kind: "contains",
        });
      }
    } else {
      for (const leaf of leaves) {
        if (connectedLeafIds.has(leaf.leafId)) {
          continue;
        }
        appendUniqueGraphEdge(edges, edgeIds, {
          from: treeNodeId,
          to: integrationLeafGraphNodeId(leaf.leafId),
          kind: "contains",
        });
      }
    }
  }

  return {
    workspace_id: params.workspaceId,
    forest: "integrations",
    focus_tree_id: focusTreeId,
    nodes,
    edges,
  };
}

function visibleEntries(currentDir: string): fs.Dirent[] {
  return fs.readdirSync(currentDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
}

function buildTreeFromDirectory(params: {
  absolutePath: string;
  relativePath: string;
  displayName: string;
}): MemoryBrowserTreeNode | null {
  if (!fs.existsSync(params.absolutePath) || !fs.statSync(params.absolutePath).isDirectory()) {
    return null;
  }
  const children: MemoryBrowserTreeNode[] = [];
  for (const entry of visibleEntries(params.absolutePath)) {
    const childAbsolutePath = path.join(params.absolutePath, entry.name);
    const childRelativePath = params.relativePath
      ? path.posix.join(params.relativePath, entry.name)
      : entry.name;
    const stat = fs.statSync(childAbsolutePath);
    if (entry.isDirectory()) {
      const child = buildTreeFromDirectory({
        absolutePath: childAbsolutePath,
        relativePath: childRelativePath,
        displayName: entry.name,
      });
      if (child) {
        children.push(child);
      }
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    children.push({
      name: entry.name,
      path: childRelativePath,
      kind: "file",
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    });
  }
  return {
    name: params.displayName,
    path: params.relativePath,
    kind: "directory",
    size_bytes: null,
    modified_at: null,
    children,
  };
}

function countTree(node: MemoryBrowserTreeNode): { directories: number; files: number } {
  if (node.kind === "file") {
    return { directories: 0, files: 1 };
  }
  let directories = 1;
  let files = 0;
  for (const child of node.children ?? []) {
    const counts = countTree(child);
    directories += counts.directories;
    files += counts.files;
  }
  return { directories, files };
}

function normalizeBrowserPath(targetPath: string): string {
  const normalized = targetPath
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    throw new Error("path is required");
  }
  const segments = normalized.split("/").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("invalid memory path");
  }
  return segments.join("/");
}

function resolveMemoryBrowserFilePath(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  targetPath: string;
}): string {
  const normalized = normalizeBrowserPath(params.targetPath);
  const segments = normalized.split("/");
  const workspace = params.store.getWorkspace(params.workspaceId);
  if (!workspace) {
    throw new Error("workspace not found");
  }
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const workspaceMemoryRoot = workspaceMemoryDir(workspaceDir);
  if (segments[0] === "interaction") {
    return path.join(workspaceMemoryRoot, ...segments);
  }
  if (segments[0] === "integration") {
    if (segments.length < 3 || segments[1] !== "accounts") {
      throw new Error("invalid integration memory path");
    }
    const visibleSlugs = new Set(
      accessibleIntegrationTreesForWorkspace({
        store: params.store,
        workspaceId: params.workspaceId,
      }).map((tree) => tree.slug),
    );
    if (!visibleSlugs.has(segments[2] ?? "")) {
      throw new Error("integration tree is not visible to this workspace");
    }
    return path.join(globalMemoryDirForWorkspaceRoot(params.store.workspaceRoot), ...segments);
  }
  throw new Error("memory path must start with interaction or integration");
}

export function buildMemoryBrowserTree(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): MemoryBrowserTreeResponse {
  const workspace = params.store.getWorkspace(params.workspaceId);
  if (!workspace) {
    throw new Error("workspace not found");
  }
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const interactionRoot = path.join(workspaceMemoryDir(workspaceDir), "interaction");
  const interactionNode = buildTreeFromDirectory({
    absolutePath: interactionRoot,
    relativePath: "interaction",
    displayName: "interaction",
  });

  const integrationAccountsChildren: MemoryBrowserTreeNode[] = [];
  const globalMemoryRoot = globalMemoryDirForWorkspaceRoot(params.store.workspaceRoot);
  for (const tree of accessibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
  })) {
    const absolutePath = path.join(globalMemoryRoot, "integration", "accounts", tree.slug);
    const node = buildTreeFromDirectory({
      absolutePath,
      relativePath: path.posix.join("integration", "accounts", tree.slug),
      displayName: tree.slug,
    });
    if (node) {
      integrationAccountsChildren.push(node);
    }
  }

  const integrationNode: MemoryBrowserTreeNode = {
    name: "integration",
    path: "integration",
    kind: "directory",
    size_bytes: null,
    modified_at: null,
    children: [
      {
        name: "accounts",
        path: path.posix.join("integration", "accounts"),
        kind: "directory",
        size_bytes: null,
        modified_at: null,
        children: integrationAccountsChildren,
      },
    ],
  };

  const root: MemoryBrowserTreeNode = {
    name: "memory",
    path: "",
    kind: "directory",
    size_bytes: null,
    modified_at: null,
    children: [
      ...(interactionNode ? [interactionNode] : []),
      integrationNode,
    ],
  };
  const counts = countTree(root);
  return {
    workspace_id: params.workspaceId,
    root,
    counts: {
      directories: Math.max(0, counts.directories - 1),
      files: counts.files,
    },
  };
}

export function readMemoryBrowserFile(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  targetPath: string;
}): MemoryBrowserFileResponse {
  const absolutePath = resolveMemoryBrowserFilePath(params);
  const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    throw new Error("memory file not found");
  }
  return {
    workspace_id: params.workspaceId,
    path: normalizeBrowserPath(params.targetPath),
    name: path.basename(absolutePath),
    size_bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
    content: fs.readFileSync(absolutePath, "utf8"),
  };
}

export function buildMemoryBrowserGraph(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  forest: MemoryBrowserGraphForest;
  treeId?: string | null;
}): MemoryBrowserGraphResponse {
  if (params.forest === "workspace") {
    return buildInteractionGraph(params);
  }
  return buildIntegrationGraph(params);
}
