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
export type MemoryBrowserGraphNodeKind = "root" | "tree" | "entity" | "branch" | "summary" | "leaf";

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
  kind: "contains" | "parent_child" | "reference";
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

function integrationEntityNodeId(treeId: string, entityKey: string): string {
  return `entity:integration:${treeId}:${entityKey}`;
}

function integrationBranchNodeId(treeId: string, entityKey: string | null, branchKey: string): string {
  return `branch:integration:${treeId}:${entityKey ?? "account"}:${branchKey}`;
}

function integrationEntityKeyFromNodeId(treeId: string, nodeId: string): string | null {
  const prefix = `entity:integration:${treeId}:`;
  return nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : null;
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

function semanticBrowserNodeKind(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): MemoryBrowserGraphNodeKind {
  if (node.nodeClass === "leaf") {
    return "leaf";
  }
  if (node.nodeKind === "tree" || node.nodeKind === "connection") {
    return "tree";
  }
  if (node.nodeKind === "partition") {
    return "summary";
  }
  if (new Set(["workspace", "repo", "thread", "page", "database", "contact", "file", "folder", "post", "calendar"]).has(node.nodeKind)) {
    return "entity";
  }
  return "branch";
}

function semanticNodeDepth(pathValue: string): number | null {
  const normalized = pathValue.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const markerIndex = segments.findIndex(
    (segment, index) =>
      segment === "semantic"
      && segments[index + 1] === "integration"
      && segments[index + 2] === "trees",
  );
  if (markerIndex < 0 || segments[segments.length - 1] !== "content.md") {
    return null;
  }
  const treeSlugIndex = markerIndex + 3;
  if (!segments[treeSlugIndex]) {
    return null;
  }
  return Math.max(0, segments.length - (treeSlugIndex + 2));
}

function semanticInteractionNodeDepth(pathValue: string): number | null {
  const normalized = pathValue.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const markerIndex = segments.findIndex(
    (segment, index) =>
      segment === "semantic"
      && segments[index + 1] === "interaction"
      && segments[index + 2] === "trees",
  );
  if (markerIndex < 0 || segments[segments.length - 1] !== "content.md") {
    return null;
  }
  const treeSlugIndex = markerIndex + 3;
  if (!segments[treeSlugIndex]) {
    return null;
  }
  return Math.max(0, segments.length - (treeSlugIndex + 2));
}

function parseIntegrationSummaryScope(params: {
  treeSlug: string;
  path: string;
}): {
  root: boolean;
  entitySlug: string | null;
  branchSlug: string | null;
} {
  const segments = params.path.split("/").filter(Boolean);
  const baseIndex = segments.findIndex(
    (segment, index) =>
      segment === "integration"
      && segments[index + 1] === "trees"
      && segments[index + 2] === params.treeSlug,
  );
  if (baseIndex < 0) {
    const legacyBaseIndex = segments.findIndex(
      (segment, index) =>
        segment === "integration"
        && segments[index + 1] === "accounts"
        && segments[index + 2] === params.treeSlug
        && segments[index + 3] === "summaries",
    );
    if (legacyBaseIndex < 0) {
      return { root: false, entitySlug: null, branchSlug: null };
    }
    const scope = segments.slice(legacyBaseIndex + 4);
    if (scope[0] === "root") {
      return { root: true, entitySlug: null, branchSlug: null };
    }
    if (scope[0] === "account") {
      return {
        root: false,
        entitySlug: null,
        branchSlug: scope[1] && !/^L\d+$/i.test(scope[1]) ? scope[1] : null,
      };
    }
    if (scope[0] === "entities") {
      const entitySlug = scope[1] ?? null;
      const maybeBranch = scope[2] ?? null;
      return {
        root: false,
        entitySlug,
        branchSlug: maybeBranch && !/^L\d+$/i.test(maybeBranch) ? maybeBranch : null,
      };
    }
    return { root: false, entitySlug: null, branchSlug: null };
  }
  const scope = segments.slice(baseIndex + 3);
  if (
    scope.length === 3
    && scope[0] === "branches"
    && /^L\d+-/i.test(scope[1] ?? "")
    && scope[2] === "content.md"
  ) {
    return { root: true, entitySlug: null, branchSlug: null };
  }
  if (
    scope.length === 5
    && scope[0] === "branches"
    && scope[2] === "branches"
    && /^L\d+-/i.test(scope[3] ?? "")
    && scope[4] === "content.md"
  ) {
    return {
      root: false,
      entitySlug: null,
      branchSlug: scope[1] ?? null,
    };
  }
  if (
    scope.length === 5
    && scope[0] === "branches"
    && scope[2] === "content.md"
  ) {
    return {
      root: false,
      entitySlug: scope[1] ?? null,
      branchSlug: null,
    };
  }
  if (
    scope.length === 7
    && scope[0] === "branches"
    && scope[2] === "branches"
    && scope[4] === "branches"
    && /^L\d+-/i.test(scope[5] ?? "")
    && scope[6] === "content.md"
  ) {
    return {
      root: false,
      entitySlug: scope[1] ?? null,
      branchSlug: scope[3] ?? null,
    };
  }
  return { root: false, entitySlug: null, branchSlug: null };
}

function buildIntegrationLabelIndex(leaves: Array<ReturnType<RuntimeStateStore["listIntegrationLeaves"]>[number]>) {
  const entityLabelByKey = new Map<string, string>();
  const entitySlugByKey = new Map<string, string>();
  const entityKeyBySlug = new Map<string, string>();
  const branchLabelByKey = new Map<string, string>();
  const branchSlugByIdentity = new Map<string, string>();
  const branchIdentityBySlug = new Map<string, { entityKey: string | null; branchKey: string }>();

  for (const leaf of leaves) {
    if (leaf.entityKey) {
      if (leaf.entityLabel) {
        entityLabelByKey.set(leaf.entityKey, leaf.entityLabel);
      }
      const entitySlug = integrationEntitySlug(leaf.entityKey, leaf.entityLabel);
      if (entitySlug) {
        entitySlugByKey.set(leaf.entityKey, entitySlug);
        entityKeyBySlug.set(entitySlug, leaf.entityKey);
      }
    }
    if (leaf.branchKey) {
      if (leaf.branchLabel) {
        branchLabelByKey.set(`${leaf.entityKey ?? "account"}::${leaf.branchKey}`, leaf.branchLabel);
      }
      const branchSlug = integrationBranchSlug(leaf.branchKey, leaf.branchLabel);
      if (branchSlug) {
        const identityKey = `${leaf.entityKey ?? "account"}::${leaf.branchKey}`;
        branchSlugByIdentity.set(identityKey, branchSlug);
        branchIdentityBySlug.set(branchSlug, {
          entityKey: leaf.entityKey ?? null,
          branchKey: leaf.branchKey,
        });
      }
    }
  }

  return {
    entityLabelByKey,
    entitySlugByKey,
    entityKeyBySlug,
    branchLabelByKey,
    branchSlugByIdentity,
    branchIdentityBySlug,
  };
}

function shortLabel(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized || fallback;
}

function safePathSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function integrationEntitySlug(
  key: string | null | undefined,
  label: string | null | undefined,
): string | null {
  const source = key?.trim() || label?.trim() || "";
  return source ? safePathSegment(source, "entity") : null;
}

function integrationBranchSlug(
  key: string | null | undefined,
  label: string | null | undefined,
): string | null {
  const source = key?.trim() || label?.trim() || "";
  return source ? safePathSegment(source, "branch") : null;
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

interface VirtualMemoryFileEntry {
  kind: "file";
  path: string;
  name: string;
  modifiedAt: string;
  sizeBytes: number;
  content: string;
}

interface VirtualMemoryDirectoryBuilder {
  kind: "directory";
  name: string;
  path: string;
  children: Map<string, VirtualMemoryDirectoryBuilder | VirtualMemoryFileEntry>;
}

interface VirtualMemoryBrowserModel {
  root: MemoryBrowserTreeNode;
  counts: {
    directories: number;
    files: number;
  };
  files: Map<string, VirtualMemoryFileEntry>;
  graphNodePaths: Map<string, string>;
}

function createVirtualDirectory(
  name: string,
  targetPath: string,
): VirtualMemoryDirectoryBuilder {
  return {
    kind: "directory",
    name,
    path: targetPath,
    children: new Map(),
  };
}

function ensureVirtualDirectory(
  root: VirtualMemoryDirectoryBuilder,
  segments: string[],
): VirtualMemoryDirectoryBuilder {
  let current = root;
  let currentPath = "";
  for (const segment of segments) {
    currentPath = currentPath ? path.posix.join(currentPath, segment) : segment;
    const existing = current.children.get(segment);
    if (existing?.kind === "directory") {
      current = existing;
      continue;
    }
    const next = createVirtualDirectory(segment, currentPath);
    current.children.set(segment, next);
    current = next;
  }
  return current;
}

function addVirtualFile(
  root: VirtualMemoryDirectoryBuilder,
  entry: VirtualMemoryFileEntry,
): void {
  const normalized = normalizeBrowserPath(entry.path);
  const segments = normalized.split("/");
  const name = segments.pop();
  if (!name) {
    throw new Error("virtual memory file path is missing a file name");
  }
  const directory = ensureVirtualDirectory(root, segments);
  directory.children.set(name, {
    ...entry,
    path: normalized,
    name,
  });
}

function finalizeVirtualTree(
  builder: VirtualMemoryDirectoryBuilder,
): MemoryBrowserTreeNode {
  const children = Array.from(builder.children.values())
    .sort((left, right) => {
      const leftIsDirectory = left.kind === "directory";
      const rightIsDirectory = right.kind === "directory";
      if (leftIsDirectory !== rightIsDirectory) {
        return leftIsDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, {
        sensitivity: "base",
      });
    })
    .map((child) =>
      child.kind === "directory"
        ? finalizeVirtualTree(child)
        : {
            name: child.name,
            path: child.path,
            kind: "file" as const,
            size_bytes: child.sizeBytes,
            modified_at: child.modifiedAt,
          },
    );
  return {
    name: builder.name,
    path: builder.path,
    kind: "directory",
    size_bytes: null,
    modified_at: null,
    children,
  };
}

function countVirtualTree(node: MemoryBrowserTreeNode): {
  directories: number;
  files: number;
} {
  if (node.kind === "file") {
    return { directories: 0, files: 1 };
  }
  let directories = 1;
  let files = 0;
  for (const child of node.children ?? []) {
    const counts = countVirtualTree(child);
    directories += counts.directories;
    files += counts.files;
  }
  return { directories, files };
}

function readStoredMemoryFile(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  relativePath: string;
}): VirtualMemoryFileEntry | null {
  const normalized = params.relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  let absolutePath: string;
  const workspacePrefix = `workspace/${params.workspaceId}/`;
  if (normalized.startsWith("integration/") || normalized.startsWith("semantic/")) {
    absolutePath = path.join(
      globalMemoryDirForWorkspaceRoot(params.store.workspaceRoot),
      normalized,
    );
  } else if (normalized.startsWith(workspacePrefix)) {
    absolutePath = path.join(
      workspaceMemoryDir(params.store.workspaceDir(params.workspaceId)),
      normalized.slice(workspacePrefix.length),
    );
  } else {
    absolutePath = path.join(
      workspaceMemoryDir(params.store.workspaceDir(params.workspaceId)),
      normalized,
    );
  }
  const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    return null;
  }
  const content = fs.readFileSync(absolutePath, "utf8");
  return {
    kind: "file",
    path: normalizeBrowserPath(normalized),
    name: path.basename(normalized),
    modifiedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    content,
  };
}

function browserPathForStoredPath(workspaceId: string, targetPath: string): string {
  const normalized = normalizeBrowserPath(targetPath);
  const workspacePrefix = `workspace/${workspaceId}/`;
  const relative = normalized.startsWith(workspacePrefix)
    ? normalized.slice(workspacePrefix.length)
    : normalized;
  if (relative.startsWith("semantic/interaction/trees/")) {
    return relative.slice("semantic/".length);
  }
  if (relative.startsWith("semantic/integration/trees/")) {
    return relative.slice("semantic/".length);
  }
  return relative;
}

function canonicalNodeFallbackContent(params: {
  title: string;
  summary: string;
}): string {
  return `# ${params.title}\n\n${params.summary}\n`;
}

function buildVirtualMemoryBrowserModel(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): VirtualMemoryBrowserModel {
  const rootBuilder = createVirtualDirectory("memory", "");
  const files = new Map<string, VirtualMemoryFileEntry>();
  const graphNodePaths = new Map<string, string>();

  const addContentFile = (
    filePath: string,
    content: string,
    modifiedAt: string,
  ): void => {
    const normalized = normalizeBrowserPath(filePath);
    const entry: VirtualMemoryFileEntry = {
      kind: "file",
      path: normalized,
      name: path.posix.basename(normalized),
      modifiedAt,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      content,
    };
    addVirtualFile(rootBuilder, entry);
    files.set(normalized, entry);
  };

  const interactionTrees = params.store.listInteractionEntities({
    workspaceId: params.workspaceId,
    status: "active",
    includeSystem: true,
    limit: 10_000,
  });
  ensureVirtualDirectory(rootBuilder, ["interaction", "trees"]);
  for (const entity of interactionTrees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "interaction",
      workspaceId: params.workspaceId,
      treeId: entity.entityId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length > 0) {
      for (const node of semanticNodes) {
        const stored = readStoredMemoryFile({
          store: params.store,
          workspaceId: params.workspaceId,
          relativePath: node.path,
        });
        const browserPath = browserPathForStoredPath(params.workspaceId, node.path);
        addContentFile(
          browserPath,
          stored?.content ?? canonicalNodeFallbackContent({
            title: node.title,
            summary: node.summary,
          }),
          stored?.modifiedAt ?? node.updatedAt,
        );
        graphNodePaths.set(node.nodeId, browserPath);
      }
    }
  }

  const integrationTrees = accessibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  ensureVirtualDirectory(rootBuilder, ["integration", "trees"]);
  for (const tree of integrationTrees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "integration",
      treeId: tree.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length > 0) {
      for (const node of semanticNodes) {
        const stored = readStoredMemoryFile({
          store: params.store,
          workspaceId: params.workspaceId,
          relativePath: node.path,
        });
        const browserPath = browserPathForStoredPath(params.workspaceId, node.path);
        addContentFile(
          browserPath,
          stored?.content ?? canonicalNodeFallbackContent({
            title: node.title,
            summary: node.summary,
          }),
          stored?.modifiedAt ?? node.updatedAt,
        );
        graphNodePaths.set(node.nodeId, browserPath);
      }
    }
  }

  const root = finalizeVirtualTree(rootBuilder);
  const counts = countVirtualTree(root);
  return {
    root,
    counts: {
      directories: Math.max(0, counts.directories - 1),
      files: counts.files,
    },
    files,
    graphNodePaths,
  };
}

function buildInteractionGraph(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
  graphNodePaths: Map<string, string>;
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
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "interaction",
      workspaceId: params.workspaceId,
      treeId: entity.entityId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length === 0) {
      continue;
    }
    const rootSemanticNode = semanticNodes.find((node) => node.nodeKind === "tree")
      ?? semanticNodes.find((node) => semanticBrowserNodeKind(node) === "tree")
      ?? semanticNodes[0]!;
    for (const node of semanticNodes) {
      const kind = semanticBrowserNodeKind(node);
      const depth = semanticInteractionNodeDepth(node.path);
      appendUniqueGraphNode(nodes, nodeIds, {
        id: node.nodeId,
        kind,
        category: "interaction",
        tree_id: entity.entityId,
        label: shortLabel(node.title, node.nodeId),
        subtitle: kind === "tree"
          ? interactionTreeSubtitle(entity.entityType)
          : kind === "summary" && node.nodeKind === "partition"
            ? "materialized"
            : null,
        status: node.status,
        level: kind === "tree" ? 1 : depth === null ? null : depth + 1,
        child_count: node.childCount,
        path: params.graphNodePaths.get(node.nodeId) ?? browserPathForStoredPath(params.workspaceId, node.path),
      });
    }
    appendUniqueGraphEdge(edges, edgeIds, {
      from: rootNodeId,
      to: rootSemanticNode.nodeId,
      kind: "contains",
    });
    for (const node of semanticNodes.filter((candidate) => candidate.nodeClass === "semantic")) {
      for (const edge of params.store.listSemanticMemoryChildren({
        category: "interaction",
        workspaceId: params.workspaceId,
        treeId: entity.entityId,
        parentNodeId: node.nodeId,
      })) {
        appendUniqueGraphEdge(edges, edgeIds, {
          from: edge.parentNodeId,
          to: edge.childNodeId,
          kind: node.nodeKind === "tree" ? "contains" : "parent_child",
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
  graphNodePaths: Map<string, string>;
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
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "integration",
      treeId: tree.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length > 0) {
      const rootSemanticNode = semanticNodes.find((node) => node.nodeKind === "connection")
        ?? semanticNodes.find((node) => semanticBrowserNodeKind(node) === "tree")
        ?? semanticNodes[0]!;
      for (const node of semanticNodes) {
        const kind = semanticBrowserNodeKind(node);
        const depth = semanticNodeDepth(node.path);
        appendUniqueGraphNode(nodes, nodeIds, {
          id: node.nodeId,
          kind,
          category: "integration",
          tree_id: tree.treeId,
          label: shortLabel(node.title, node.nodeId),
          subtitle: kind === "tree"
            ? integrationTreeSubtitle({
                provider: tree.provider,
                ownerUserId: tree.ownerUserId,
              })
            : null,
          status: node.status,
          level: depth === null ? null : depth + 1,
          child_count: node.childCount,
          path: params.graphNodePaths.get(node.nodeId) ?? browserPathForStoredPath(params.workspaceId, node.path),
        });
      }
      appendUniqueGraphEdge(edges, edgeIds, {
        from: rootNodeId,
        to: rootSemanticNode.nodeId,
        kind: "contains",
      });
      for (const node of semanticNodes.filter((candidate) => candidate.nodeClass === "semantic")) {
        const parentKind = semanticBrowserNodeKind(node);
        for (const edge of params.store.listSemanticMemoryChildren({
          category: "integration",
          treeId: tree.treeId,
          parentNodeId: node.nodeId,
        })) {
          appendUniqueGraphEdge(edges, edgeIds, {
            from: edge.parentNodeId,
            to: edge.childNodeId,
            kind: parentKind === "tree" ? "contains" : "parent_child",
          });
        }
      }
      for (const relation of params.store.listSemanticMemoryRelations({
        category: "integration",
        treeId: tree.treeId,
        limit: 10_000,
      })) {
        if (!nodeIds.has(relation.fromNodeId) || !nodeIds.has(relation.toNodeId)) {
          continue;
        }
        appendUniqueGraphEdge(edges, edgeIds, {
          from: relation.fromNodeId,
          to: relation.toNodeId,
          kind: "reference",
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

export function buildMemoryBrowserTree(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): MemoryBrowserTreeResponse {
  const workspace = params.store.getWorkspace(params.workspaceId);
  if (!workspace) {
    throw new Error("workspace not found");
  }
  const model = buildVirtualMemoryBrowserModel(params);
  return {
    workspace_id: params.workspaceId,
    root: model.root,
    counts: model.counts,
  };
}

export function readMemoryBrowserFile(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  targetPath: string;
}): MemoryBrowserFileResponse {
  const normalizedPath = normalizeBrowserPath(params.targetPath);
  const model = buildVirtualMemoryBrowserModel(params);
  const entry = model.files.get(normalizedPath);
  if (!entry) {
    throw new Error("memory file not found");
  }
  return {
    workspace_id: params.workspaceId,
    path: normalizedPath,
    name: entry.name,
    size_bytes: entry.sizeBytes,
    modified_at: entry.modifiedAt,
    content: entry.content,
  };
}

export function buildMemoryBrowserGraph(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  forest: MemoryBrowserGraphForest;
  treeId?: string | null;
}): MemoryBrowserGraphResponse {
  const model = buildVirtualMemoryBrowserModel({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  if (params.forest === "workspace") {
    return buildInteractionGraph({
      ...params,
      graphNodePaths: model.graphNodePaths,
    });
  }
  return buildIntegrationGraph({
    ...params,
    graphNodePaths: model.graphNodePaths,
  });
}
