import fs from "node:fs";
import path from "node:path";

import {
  type IntegrationLeafRecord,
  type IntegrationSummaryNodeRecord,
  type IntegrationTreeRecord,
  type InteractionEntityRecord,
  type InteractionLeafRecord,
  type InteractionSummaryNodeRecord,
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
  if (normalized.startsWith("integration/")) {
    absolutePath = path.join(
      globalMemoryDirForWorkspaceRoot(params.store.workspaceRoot),
      normalized,
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
  return normalized.startsWith(workspacePrefix)
    ? normalized.slice(workspacePrefix.length)
    : normalized;
}

function canonicalNodeFallbackContent(params: {
  title: string;
  summary: string;
}): string {
  return `# ${params.title}\n\n${params.summary}\n`;
}

function virtualInteractionTreeContent(params: {
  entity: InteractionEntityRecord;
  leaves: InteractionLeafRecord[];
  summaries: InteractionSummaryNodeRecord[];
}): string {
  const lines = [
    `# ${params.entity.canonicalName}`,
    "",
    `- Entity ID: \`${params.entity.entityId}\``,
    `- Type: ${params.entity.entityType}`,
    params.entity.aliases.length > 0
      ? `- Aliases: ${params.entity.aliases.join(", ")}`
      : null,
    `- Active leaves: ${params.leaves.length}`,
    `- Active summaries: ${params.summaries.length}`,
    "",
    "## Summary",
    "",
    params.entity.summary
      ?? `${params.entity.canonicalName} interaction memory tree.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return `${lines.join("\n").trim()}\n`;
}

function virtualIntegrationTreeContent(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  summaries: IntegrationSummaryNodeRecord[];
  rootSummaryContent: string | null;
}): string {
  if (params.rootSummaryContent) {
    return params.rootSummaryContent;
  }
  const lines = [
    `# ${params.tree.accountLabel}`,
    "",
    `- Tree ID: \`${params.tree.treeId}\``,
    `- Provider: ${params.tree.provider}`,
    `- Owner user: ${params.tree.ownerUserId}`,
    `- Account key: ${params.tree.accountKey}`,
    `- Active leaves: ${params.leaves.length}`,
    `- Active summaries: ${params.summaries.length}`,
    "",
    "## Summary",
    "",
    params.tree.summary
      ?? `${params.tree.accountLabel} integration memory tree.`,
    "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

function virtualIntegrationEntityContent(params: {
  tree: IntegrationTreeRecord;
  entityKey: string;
  entityLabel: string;
  leafCount: number;
  branchCount: number;
  summaryContent: string | null;
}): string {
  if (params.summaryContent) {
    return params.summaryContent;
  }
  const lines = [
    `# ${params.entityLabel}`,
    "",
    `- Tree: ${params.tree.accountLabel}`,
    `- Provider: ${params.tree.provider}`,
    `- Entity key: ${params.entityKey}`,
    `- Branch count: ${params.branchCount}`,
    `- Leaf count: ${params.leafCount}`,
    "",
    "## Summary",
    "",
    `${params.entityLabel} in ${params.tree.accountLabel}.`,
    "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

function virtualIntegrationBranchContent(params: {
  tree: IntegrationTreeRecord;
  entityLabel: string | null;
  branchKey: string;
  branchLabel: string;
  leafCount: number;
  summaryContent: string | null;
}): string {
  if (params.summaryContent) {
    return params.summaryContent;
  }
  const lines = [
    `# ${params.branchLabel}`,
    "",
    `- Tree: ${params.tree.accountLabel}`,
    `- Provider: ${params.tree.provider}`,
    params.entityLabel ? `- Parent: ${params.entityLabel}` : null,
    `- Branch key: ${params.branchKey}`,
    `- Leaf count: ${params.leafCount}`,
    "",
    "## Summary",
    "",
    `${params.branchLabel} in ${params.tree.accountLabel}.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return `${lines.join("\n").trim()}\n`;
}

function summaryFolderName(level: number, ordinal: number): string {
  return `L${level}-${String(ordinal).padStart(3, "0")}`;
}

function integrationSummaryFolderName(node: IntegrationSummaryNodeRecord): string {
  return `L${node.level}-${node.nodeId.slice(-6)}`;
}

function interactionLeafFolderName(leaf: InteractionLeafRecord): string {
  const titleSlug = safePathSegment(leaf.title || leaf.subjectKey, "leaf");
  return `${titleSlug}-${leaf.leafId.slice(-6)}`;
}

function integrationLeafFolderName(leaf: IntegrationLeafRecord): string {
  const source = leaf.externalObjectId
    ?? leaf.subjectKey
    ?? leaf.title
    ?? leaf.leafId;
  const slug = safePathSegment(source, "leaf");
  return `${slug}-${leaf.leafId.slice(-6)}`;
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
    const canonicalNodes = params.store.listInteractionMemoryNodes({
      workspaceId: params.workspaceId,
      treeId: entity.entityId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (canonicalNodes.length > 0) {
      for (const node of canonicalNodes) {
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
      continue;
    }
    const summaries = params.store.listInteractionSummaryNodes({
      workspaceId: params.workspaceId,
      entityId: entity.entityId,
      status: "active",
      limit: 10_000,
    });
    const leaves = params.store.listInteractionLeaves({
      workspaceId: params.workspaceId,
      entityId: entity.entityId,
      status: "active",
      limit: 10_000,
    });
    const treeSegments = ["interaction", "trees", entity.slug];
    const treeContentPath = path.posix.join(...treeSegments, "content.md");
    addContentFile(
      treeContentPath,
      virtualInteractionTreeContent({
        entity,
        leaves,
        summaries,
      }),
      entity.updatedAt,
    );
    graphNodePaths.set(interactionTreeNodeId(entity.entityId), treeContentPath);

    const summaryById = new Map(summaries.map((summary) => [summary.nodeId, summary]));
    const leafById = new Map(leaves.map((leaf) => [leaf.leafId, leaf]));
    const childSummaryIds = new Set<string>();
    const childEdgesByParent = new Map<string, ReturnType<RuntimeStateStore["listInteractionTreeChildren"]>>();
    for (const summary of summaries) {
      const children = params.store.listInteractionTreeChildren({
        workspaceId: params.workspaceId,
        parentNodeId: summary.nodeId,
      });
      childEdgesByParent.set(summary.nodeId, children);
      for (const child of children) {
        if (child.childKind === "summary") {
          childSummaryIds.add(child.childId);
        }
      }
    }

    const attachInteractionLeaf = (
      parentSegments: string[],
      leaf: typeof leaves[number],
    ): void => {
      const stored = readStoredMemoryFile({
        store: params.store,
        workspaceId: params.workspaceId,
        relativePath: leaf.path,
      });
      const leafSegments = [
        ...parentSegments,
        "branches",
        interactionLeafFolderName(leaf),
      ];
      const contentPath = path.posix.join(...leafSegments, "content.md");
      addContentFile(
        contentPath,
        stored?.content
          ?? `# ${leaf.title}\n\n${leaf.summary}\n`,
        stored?.modifiedAt ?? leaf.updatedAt,
      );
      graphNodePaths.set(interactionLeafGraphNodeId(leaf.leafId), contentPath);
    };

    const attachInteractionSummary = (
      parentSegments: string[],
      summary: typeof summaries[number],
      depth: number,
    ): void => {
      const stored = readStoredMemoryFile({
        store: params.store,
        workspaceId: params.workspaceId,
        relativePath: summary.path,
      });
      const summarySegments = [
        ...parentSegments,
        "branches",
        summaryFolderName(depth, summary.ordinal),
      ];
      const contentPath = path.posix.join(...summarySegments, "content.md");
      addContentFile(
        contentPath,
        stored?.content
          ?? `# ${summary.title}\n\n${summary.summary}\n`,
        stored?.modifiedAt ?? summary.updatedAt,
      );
      graphNodePaths.set(interactionSummaryGraphNodeId(summary.nodeId), contentPath);
      for (const child of childEdgesByParent.get(summary.nodeId) ?? []) {
        if (child.childKind === "summary") {
          const childSummary = summaryById.get(child.childId);
          if (childSummary) {
            attachInteractionSummary(summarySegments, childSummary, depth + 1);
          }
          continue;
        }
        const childLeaf = leafById.get(child.childId);
        if (childLeaf) {
          attachInteractionLeaf(summarySegments, childLeaf);
        }
      }
    };

    const rootSummaries = summaries.filter((summary) => !childSummaryIds.has(summary.nodeId));
    if (rootSummaries.length > 0) {
      for (const summary of rootSummaries) {
        attachInteractionSummary(treeSegments, summary, 1);
      }
    } else {
      for (const leaf of leaves) {
        attachInteractionLeaf(treeSegments, leaf);
      }
    }
  }

  const integrationTrees = accessibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  ensureVirtualDirectory(rootBuilder, ["integration", "trees"]);
  for (const tree of integrationTrees) {
    const canonicalNodes = params.store.listIntegrationMemoryNodes({
      treeId: tree.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (canonicalNodes.length > 0) {
      for (const node of canonicalNodes) {
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
      continue;
    }
    const summaries = params.store.listIntegrationSummaryNodes({
      treeId: tree.treeId,
      status: "active",
      limit: 10_000,
    });
    const leaves = params.store.listIntegrationLeaves({
      treeId: tree.treeId,
      status: "active",
      limit: 10_000,
    });
    const labelIndex = buildIntegrationLabelIndex(leaves);
    const treeSegments = ["integration", "trees", tree.slug];

    const summaryById = new Map(summaries.map((summary) => [summary.nodeId, summary]));
    const leafById = new Map(leaves.map((leaf) => [leaf.leafId, leaf]));
    const childEdgesByParent = new Map<string, ReturnType<RuntimeStateStore["listIntegrationTreeChildren"]>>();
    const childSummaryIds = new Set<string>();
    for (const summary of summaries) {
      const children = params.store.listIntegrationTreeChildren({
        parentNodeId: summary.nodeId,
      });
      childEdgesByParent.set(summary.nodeId, children);
      for (const child of children) {
        if (child.childKind === "summary") {
          childSummaryIds.add(child.childId);
        }
      }
    }

    type ScopeIdentity = {
      entityKey: string | null;
      entityLabel: string | null;
      entitySlug: string | null;
      branchKey: string | null;
      branchLabel: string | null;
      branchSlug: string | null;
    };
    const scopeKeyFor = (scope: ScopeIdentity): string =>
      `${scope.entityKey ?? "__account__"}::${scope.branchKey ?? "__none__"}`;
    const scopeByKey = new Map<string, ScopeIdentity>();
    for (const leaf of leaves) {
      const key = scopeKeyFor({
        entityKey: leaf.entityKey ?? null,
        entityLabel: leaf.entityLabel ?? null,
        entitySlug: integrationEntitySlug(leaf.entityKey, leaf.entityLabel),
        branchKey: leaf.branchKey ?? null,
        branchLabel: leaf.branchLabel ?? null,
        branchSlug: integrationBranchSlug(leaf.branchKey, leaf.branchLabel),
      });
      if (!scopeByKey.has(key)) {
        scopeByKey.set(key, {
          entityKey: leaf.entityKey ?? null,
          entityLabel: leaf.entityLabel ?? null,
          entitySlug: integrationEntitySlug(leaf.entityKey, leaf.entityLabel),
          branchKey: leaf.branchKey ?? null,
          branchLabel: leaf.branchLabel ?? null,
          branchSlug: integrationBranchSlug(leaf.branchKey, leaf.branchLabel),
        });
      }
    }

    const rootSummary = summaries.find((summary) => {
      if (childSummaryIds.has(summary.nodeId)) {
        return false;
      }
      const scope = parseIntegrationSummaryScope({
        treeSlug: tree.slug,
        path: summary.path,
      });
      return scope.root;
    }) ?? null;

    const rootSummaryContent = rootSummary
      ? readStoredMemoryFile({
          store: params.store,
          workspaceId: params.workspaceId,
          relativePath: rootSummary.path,
        })?.content ?? null
      : null;

    const treeContentPath = path.posix.join(...treeSegments, "content.md");
    addContentFile(
      treeContentPath,
      virtualIntegrationTreeContent({
        tree,
        leaves,
        summaries,
        rootSummaryContent,
      }),
      tree.updatedAt,
    );
    graphNodePaths.set(integrationTreeNodeId(tree.treeId), treeContentPath);

    const rootSummaryByScope = new Map<string, typeof summaries[number]>();
    for (const summary of summaries) {
      if (childSummaryIds.has(summary.nodeId)) {
        continue;
      }
      const scope = parseIntegrationSummaryScope({
        treeSlug: tree.slug,
        path: summary.path,
      });
      if (scope.root) {
        continue;
      }
      const inferredEntitySlug =
        !scope.entitySlug
        && scope.branchSlug
        && labelIndex.entityKeyBySlug.has(scope.branchSlug)
        && !labelIndex.branchIdentityBySlug.has(scope.branchSlug)
          ? scope.branchSlug
          : scope.entitySlug;
      const entityKey = inferredEntitySlug
        ? labelIndex.entityKeyBySlug.get(inferredEntitySlug) ?? null
        : null;
      let branchKey: string | null = null;
      let branchLabel: string | null = null;
      if (scope.branchSlug && scope.branchSlug !== inferredEntitySlug) {
        const identity = labelIndex.branchIdentityBySlug.get(scope.branchSlug);
        branchKey = identity?.branchKey ?? scope.branchSlug;
        branchLabel = labelIndex.branchLabelByKey.get(
          `${identity?.entityKey ?? entityKey ?? "account"}::${branchKey}`,
        ) ?? scope.branchSlug;
      }
      const key = scopeKeyFor({
        entityKey,
        entityLabel: entityKey ? (labelIndex.entityLabelByKey.get(entityKey) ?? entityKey) : null,
        entitySlug: inferredEntitySlug,
        branchKey,
        branchLabel,
        branchSlug: scope.branchSlug && scope.branchSlug !== inferredEntitySlug ? scope.branchSlug : null,
      });
      rootSummaryByScope.set(key, summary);
    }

    const leavesByScope = new Map<string, typeof leaves>();
    for (const leaf of leaves) {
      const key = scopeKeyFor({
        entityKey: leaf.entityKey ?? null,
        entityLabel: leaf.entityLabel ?? null,
        entitySlug: integrationEntitySlug(leaf.entityKey, leaf.entityLabel),
        branchKey: leaf.branchKey ?? null,
        branchLabel: leaf.branchLabel ?? null,
        branchSlug: integrationBranchSlug(leaf.branchKey, leaf.branchLabel),
      });
      const bucket = leavesByScope.get(key);
      if (bucket) {
        bucket.push(leaf);
      } else {
        leavesByScope.set(key, [leaf]);
      }
    }

    const attachIntegrationLeaf = (
      parentSegments: string[],
      leaf: typeof leaves[number],
    ): void => {
      const stored = readStoredMemoryFile({
        store: params.store,
        workspaceId: params.workspaceId,
        relativePath: leaf.path,
      });
      const leafSegments = [
        ...parentSegments,
        "branches",
        integrationLeafFolderName(leaf),
      ];
      const contentPath = path.posix.join(...leafSegments, "content.md");
      addContentFile(
        contentPath,
        stored?.content
          ?? `# ${leaf.title}\n\n${leaf.summary}\n`,
        stored?.modifiedAt ?? leaf.updatedAt,
      );
      graphNodePaths.set(integrationLeafGraphNodeId(leaf.leafId), contentPath);
    };

    const attachIntegrationSummaryChildren = (
      parentSegments: string[],
      parentSummaryId: string,
    ): void => {
      for (const child of childEdgesByParent.get(parentSummaryId) ?? []) {
        if (child.childKind === "summary") {
          const childSummary = summaryById.get(child.childId);
          if (!childSummary) {
            continue;
          }
          const stored = readStoredMemoryFile({
            store: params.store,
            workspaceId: params.workspaceId,
            relativePath: childSummary.path,
          });
          const childSegments = [
            ...parentSegments,
            "branches",
            integrationSummaryFolderName(childSummary),
          ];
          const contentPath = path.posix.join(...childSegments, "content.md");
          addContentFile(
            contentPath,
            stored?.content
              ?? `# ${childSummary.title}\n\n${childSummary.summary}\n`,
            stored?.modifiedAt ?? childSummary.updatedAt,
          );
          graphNodePaths.set(integrationSummaryGraphNodeId(childSummary.nodeId), contentPath);
          attachIntegrationSummaryChildren(childSegments, childSummary.nodeId);
          continue;
        }
        const childLeaf = leafById.get(child.childId);
        if (childLeaf) {
          attachIntegrationLeaf(parentSegments, childLeaf);
        }
      }
    };

    const entityScopes = Array.from(scopeByKey.values())
      .filter((scope) => scope.entityKey)
      .reduce<Map<string, ScopeIdentity[]>>((acc, scope) => {
        const bucket = acc.get(scope.entityKey!) ?? [];
        bucket.push(scope);
        acc.set(scope.entityKey!, bucket);
        return acc;
      }, new Map());

    const accountScopes = Array.from(scopeByKey.values()).filter((scope) => !scope.entityKey);

    for (const scope of accountScopes) {
      if (!scope.branchKey || !scope.branchSlug) {
        continue;
      }
      const scopeKey = scopeKeyFor(scope);
      const branchSegments = [
        ...treeSegments,
        "branches",
        scope.branchSlug,
      ];
      const branchSummary = rootSummaryByScope.get(scopeKey) ?? null;
      const branchSummaryContent = branchSummary
        ? readStoredMemoryFile({
            store: params.store,
            workspaceId: params.workspaceId,
            relativePath: branchSummary.path,
          })?.content ?? null
        : null;
      const branchContentPath = path.posix.join(...branchSegments, "content.md");
      addContentFile(
        branchContentPath,
        virtualIntegrationBranchContent({
          tree,
          entityLabel: null,
          branchKey: scope.branchKey,
          branchLabel: scope.branchLabel ?? scope.branchKey,
          leafCount: leavesByScope.get(scopeKey)?.length ?? 0,
          summaryContent: branchSummaryContent,
        }),
        branchSummary?.updatedAt ?? tree.updatedAt,
      );
      graphNodePaths.set(
        integrationBranchNodeId(tree.treeId, null, scope.branchKey),
        branchContentPath,
      );
      if (branchSummary) {
        attachIntegrationSummaryChildren(branchSegments, branchSummary.nodeId);
      } else {
        for (const leaf of leavesByScope.get(scopeKey) ?? []) {
          attachIntegrationLeaf(branchSegments, leaf);
        }
      }
    }

    for (const [entityKey, scopes] of entityScopes.entries()) {
      const entityLabel = scopes[0]?.entityLabel
        ?? labelIndex.entityLabelByKey.get(entityKey)
        ?? entityKey.replace(/^[^:]+:/, "");
      const entitySlug = scopes[0]?.entitySlug
        ?? integrationEntitySlug(entityKey, entityLabel)
        ?? safePathSegment(entityKey, "entity");
      const entityScopeKey = scopeKeyFor({
        entityKey,
        entityLabel,
        entitySlug,
        branchKey: null,
        branchLabel: null,
        branchSlug: null,
      });
      const entitySummary = rootSummaryByScope.get(entityScopeKey) ?? null;
      const entitySummaryContent = entitySummary
        ? readStoredMemoryFile({
            store: params.store,
            workspaceId: params.workspaceId,
            relativePath: entitySummary.path,
          })?.content ?? null
        : null;
      const entitySegments = [
        ...treeSegments,
        "branches",
        entitySlug,
      ];
      const entityContentPath = path.posix.join(...entitySegments, "content.md");
      addContentFile(
        entityContentPath,
        virtualIntegrationEntityContent({
          tree,
          entityKey,
          entityLabel,
          leafCount: scopes.reduce(
            (total, scope) => total + (leavesByScope.get(scopeKeyFor(scope))?.length ?? 0),
            0,
          ),
          branchCount: scopes.filter((scope) => scope.branchKey).length,
          summaryContent: entitySummaryContent,
        }),
        entitySummary?.updatedAt ?? tree.updatedAt,
      );
      graphNodePaths.set(
        integrationEntityNodeId(tree.treeId, entityKey),
        entityContentPath,
      );

      for (const scope of scopes) {
        if (!scope.branchKey || !scope.branchSlug) {
          continue;
        }
        const scopeKey = scopeKeyFor(scope);
        const branchSegments = [
          ...entitySegments,
          "branches",
          scope.branchSlug,
        ];
        const branchSummary = rootSummaryByScope.get(scopeKey) ?? null;
        const branchSummaryContent = branchSummary
          ? readStoredMemoryFile({
              store: params.store,
              workspaceId: params.workspaceId,
              relativePath: branchSummary.path,
            })?.content ?? null
          : null;
        const branchContentPath = path.posix.join(...branchSegments, "content.md");
        addContentFile(
          branchContentPath,
          virtualIntegrationBranchContent({
            tree,
            entityLabel,
            branchKey: scope.branchKey,
            branchLabel: scope.branchLabel ?? scope.branchKey,
            leafCount: leavesByScope.get(scopeKey)?.length ?? 0,
            summaryContent: branchSummaryContent,
          }),
          branchSummary?.updatedAt ?? tree.updatedAt,
        );
        graphNodePaths.set(
          integrationBranchNodeId(tree.treeId, entityKey, scope.branchKey),
          branchContentPath,
        );
        if (branchSummary) {
          attachIntegrationSummaryChildren(branchSegments, branchSummary.nodeId);
        } else {
          for (const leaf of leavesByScope.get(scopeKey) ?? []) {
            attachIntegrationLeaf(branchSegments, leaf);
          }
        }
      }
    }

    const relations = params.store.listIntegrationNodeRelations({
      treeId: tree.treeId,
      limit: 10_000,
    });
    const contactBranchSegments = [
      ...treeSegments,
      "branches",
      "contacts",
    ];
    const contactBranchNodeId = integrationBranchNodeId(tree.treeId, null, "contacts");
    const contactEntries = new Map<string, {
      entityKey: string;
      email: string;
      label: string;
      relatedThreadIds: string[];
    }>();
    for (const relation of relations) {
      if (relation.relationType !== "participant" || relation.fromNodeKind !== "entity") {
        continue;
      }
      const entityKey = integrationEntityKeyFromNodeId(tree.treeId, relation.fromNodeId);
      if (!entityKey?.startsWith("contact:")) {
        continue;
      }
      const email = String(relation.metadata.contact_email ?? entityKey.replace(/^contact:/, ""));
      const label = String(relation.metadata.contact_label ?? email);
      const existing = contactEntries.get(entityKey);
      if (existing) {
        if (!existing.relatedThreadIds.includes(relation.toNodeId)) {
          existing.relatedThreadIds.push(relation.toNodeId);
        }
        continue;
      }
      contactEntries.set(entityKey, {
        entityKey,
        email,
        label,
        relatedThreadIds: [relation.toNodeId],
      });
    }
    if (contactEntries.size > 0) {
      addContentFile(
        path.posix.join(...contactBranchSegments, "content.md"),
        `# Contacts\n\n- Tree: ${tree.accountLabel}\n- Provider: ${tree.provider}\n- Contact count: ${contactEntries.size}\n\n## Summary\n\nDerived Gmail contacts for ${tree.accountLabel}.\n`,
        tree.updatedAt,
      );
      graphNodePaths.set(contactBranchNodeId, path.posix.join(...contactBranchSegments, "content.md"));
      for (const entry of contactEntries.values()) {
        const contactSlug = safePathSegment(entry.email, "contact");
        const contactSegments = [
          ...contactBranchSegments,
          "branches",
          contactSlug,
        ];
        const contentPath = path.posix.join(...contactSegments, "content.md");
        addContentFile(
          contentPath,
          [
            `# ${entry.label}`,
            "",
            `- Email: ${entry.email}`,
            `- Related threads: ${entry.relatedThreadIds.length}`,
            "",
            "## Summary",
            "",
            `${entry.label} appears in ${entry.relatedThreadIds.length} thread${entry.relatedThreadIds.length === 1 ? "" : "s"} in this mailbox.`,
            "",
          ].join("\n"),
          tree.updatedAt,
        );
        graphNodePaths.set(
          integrationEntityNodeId(tree.treeId, entry.entityKey),
          contentPath,
        );
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
    const canonicalNodes = params.store.listInteractionMemoryNodes({
      workspaceId: params.workspaceId,
      treeId: entity.entityId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (canonicalNodes.length > 0) {
      const nodeById = new Map(canonicalNodes.map((node) => [node.nodeId, node]));
      for (const node of canonicalNodes) {
        appendUniqueGraphNode(nodes, nodeIds, {
          id: node.nodeId,
          kind: node.nodeKind,
          category: "interaction",
          tree_id: entity.entityId,
          label: shortLabel(node.title, node.nodeId),
          subtitle: node.nodeKind === "tree"
            ? interactionTreeSubtitle(entity.entityType)
            : node.nodeKind === "summary" && node.level != null
              ? `L${node.level}`
              : null,
          status: node.status,
          level: node.level ?? (node.nodeKind === "tree" ? 1 : null),
          child_count: node.childCount,
          path: params.graphNodePaths.get(node.nodeId) ?? browserPathForStoredPath(params.workspaceId, node.path),
        });
      }
      appendUniqueGraphEdge(edges, edgeIds, {
        from: rootNodeId,
        to: `tree:interaction:${entity.entityId}`,
        kind: "contains",
      });
      for (const edge of params.store.listInteractionMemoryChildren({
        workspaceId: params.workspaceId,
        parentNodeId: `tree:interaction:${entity.entityId}`,
      })) {
        appendUniqueGraphEdge(edges, edgeIds, {
          from: edge.parentNodeId,
          to: edge.childNodeId,
          kind: "contains",
        });
      }
      for (const node of canonicalNodes.filter((candidate) => candidate.nodeKind !== "tree")) {
        for (const edge of params.store.listInteractionMemoryChildren({
          workspaceId: params.workspaceId,
          parentNodeId: node.nodeId,
        })) {
          appendUniqueGraphEdge(edges, edgeIds, {
            from: edge.parentNodeId,
            to: edge.childNodeId,
            kind: "parent_child",
          });
        }
      }
      continue;
    }

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
      path: params.graphNodePaths.get(treeNodeId) ?? null,
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
        path: params.graphNodePaths.get(interactionSummaryGraphNodeId(summary.nodeId)) ?? summary.path,
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
        path: params.graphNodePaths.get(interactionLeafGraphNodeId(leaf.leafId)) ?? leaf.path,
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
    const canonicalNodes = params.store.listIntegrationMemoryNodes({
      treeId: tree.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (canonicalNodes.length > 0) {
      for (const node of canonicalNodes) {
        appendUniqueGraphNode(nodes, nodeIds, {
          id: node.nodeId,
          kind: node.nodeKind,
          category: "integration",
          tree_id: tree.treeId,
          label: shortLabel(node.title, node.nodeId),
          subtitle: node.nodeKind === "tree"
            ? integrationTreeSubtitle({
                provider: tree.provider,
                ownerUserId: tree.ownerUserId,
              })
            : node.nodeKind === "summary" && node.level != null
              ? `L${node.level}`
              : null,
          status: node.status,
          level: node.level ?? (node.nodeKind === "tree" ? 1 : null),
          child_count: node.childCount,
          path: params.graphNodePaths.get(node.nodeId) ?? browserPathForStoredPath(params.workspaceId, node.path),
        });
      }
      appendUniqueGraphEdge(edges, edgeIds, {
        from: rootNodeId,
        to: `tree:integration:${tree.treeId}`,
        kind: "contains",
      });
      for (const edge of params.store.listIntegrationMemoryChildren({
        treeId: tree.treeId,
        parentNodeId: `tree:integration:${tree.treeId}`,
      })) {
        appendUniqueGraphEdge(edges, edgeIds, {
          from: edge.parentNodeId,
          to: edge.childNodeId,
          kind: "contains",
        });
      }
      for (const node of canonicalNodes.filter((candidate) => candidate.nodeKind !== "tree")) {
        for (const edge of params.store.listIntegrationMemoryChildren({
          treeId: tree.treeId,
          parentNodeId: node.nodeId,
        })) {
          appendUniqueGraphEdge(edges, edgeIds, {
            from: edge.parentNodeId,
            to: edge.childNodeId,
            kind: "parent_child",
          });
        }
      }
      for (const relation of params.store.listIntegrationNodeRelations({
        treeId: tree.treeId,
        limit: 10_000,
      })) {
        appendUniqueGraphEdge(edges, edgeIds, {
          from: relation.fromNodeId,
          to: relation.toNodeId,
          kind: "reference",
        });
      }
      continue;
    }

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
      path: params.graphNodePaths.get(treeNodeId) ?? null,
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
    const labelIndex = buildIntegrationLabelIndex(leaves);
    const relations = params.store.listIntegrationNodeRelations({
      treeId: tree.treeId,
      limit: 10_000,
    });
    const childSummaryIds = new Set<string>();
    const connectedLeafIds = new Set<string>();
    const entityNodeIds = new Map<string, string>();
    const branchNodeIds = new Map<string, string>();

    for (const leaf of leaves) {
      if (leaf.entityKey) {
        const entityNodeId = integrationEntityNodeId(tree.treeId, leaf.entityKey);
        if (!entityNodeIds.has(leaf.entityKey)) {
          entityNodeIds.set(leaf.entityKey, entityNodeId);
          appendUniqueGraphNode(nodes, nodeIds, {
            id: entityNodeId,
            kind: "entity",
            category: "integration",
            tree_id: tree.treeId,
            label: shortLabel(
              leaf.entityLabel ?? leaf.entityKey.replace(/^[^:]+:/, ""),
              leaf.entityKey,
            ),
            subtitle: leaf.entityKey.split(":")[0] ?? "entity",
            status: null,
            level: 2,
            child_count: null,
            path: params.graphNodePaths.get(entityNodeId) ?? null,
          });
          appendUniqueGraphEdge(edges, edgeIds, {
            from: treeNodeId,
            to: entityNodeId,
            kind: "contains",
          });
        }
      }
      if (leaf.branchKey) {
        const identityKey = `${leaf.entityKey ?? "account"}::${leaf.branchKey}`;
        if (!branchNodeIds.has(identityKey)) {
          const branchNodeId = integrationBranchNodeId(tree.treeId, leaf.entityKey ?? null, leaf.branchKey);
          branchNodeIds.set(identityKey, branchNodeId);
          appendUniqueGraphNode(nodes, nodeIds, {
            id: branchNodeId,
            kind: "branch",
            category: "integration",
            tree_id: tree.treeId,
            label: shortLabel(leaf.branchLabel ?? leaf.branchKey.replaceAll("_", " "), leaf.branchKey),
            subtitle: leaf.entityKey ? "branch" : "account branch",
            status: null,
            level: 3,
            child_count: null,
            path: params.graphNodePaths.get(branchNodeId) ?? null,
          });
          appendUniqueGraphEdge(edges, edgeIds, {
            from: leaf.entityKey ? (entityNodeIds.get(leaf.entityKey) ?? treeNodeId) : treeNodeId,
            to: branchNodeId,
            kind: "contains",
          });
        }
      }
    }

    for (const summary of summaries) {
      const scope = parseIntegrationSummaryScope({
        treeSlug: tree.slug,
        path: summary.path,
      });
      const inferredEntitySlug =
        !scope.entitySlug
        && scope.branchSlug
        && labelIndex.entityKeyBySlug.has(scope.branchSlug)
        && !labelIndex.branchIdentityBySlug.has(scope.branchSlug)
          ? scope.branchSlug
          : scope.entitySlug;
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
        path: params.graphNodePaths.get(integrationSummaryGraphNodeId(summary.nodeId)) ?? summary.path,
      });
      if (inferredEntitySlug) {
        const entityKey = labelIndex.entityKeyBySlug.get(inferredEntitySlug);
        if (entityKey && !entityNodeIds.has(entityKey)) {
          const entityNodeId = integrationEntityNodeId(tree.treeId, entityKey);
          entityNodeIds.set(entityKey, entityNodeId);
          appendUniqueGraphNode(nodes, nodeIds, {
            id: entityNodeId,
            kind: "entity",
            category: "integration",
            tree_id: tree.treeId,
            label: shortLabel(
              labelIndex.entityLabelByKey.get(entityKey) ?? entityKey.replace(/^[^:]+:/, ""),
              entityKey,
            ),
            subtitle: entityKey.split(":")[0] ?? "entity",
            status: null,
            level: 2,
            child_count: null,
            path: params.graphNodePaths.get(entityNodeId) ?? null,
          });
          appendUniqueGraphEdge(edges, edgeIds, {
            from: treeNodeId,
            to: entityNodeId,
            kind: "contains",
          });
        }
      }
      if (scope.branchSlug && scope.branchSlug !== inferredEntitySlug) {
        const branchIdentity =
          labelIndex.branchIdentityBySlug.get(scope.branchSlug)
          ?? (inferredEntitySlug
            ? (() => {
                const entityKey = labelIndex.entityKeyBySlug.get(inferredEntitySlug);
                return entityKey ? { entityKey, branchKey: scope.branchSlug } : null;
              })()
            : { entityKey: null, branchKey: scope.branchSlug });
        if (branchIdentity) {
          const identityKey = `${branchIdentity.entityKey ?? "account"}::${branchIdentity.branchKey}`;
          if (!branchNodeIds.has(identityKey)) {
            const branchNodeId = integrationBranchNodeId(
              tree.treeId,
              branchIdentity.entityKey ?? null,
              branchIdentity.branchKey,
            );
            branchNodeIds.set(identityKey, branchNodeId);
            appendUniqueGraphNode(nodes, nodeIds, {
              id: branchNodeId,
              kind: "branch",
              category: "integration",
              tree_id: tree.treeId,
              label: shortLabel(
                labelIndex.branchLabelByKey.get(identityKey) ?? branchIdentity.branchKey.replaceAll("_", " "),
                branchIdentity.branchKey,
              ),
              subtitle: branchIdentity.entityKey ? "branch" : "account branch",
              status: null,
              level: 3,
              child_count: null,
              path: params.graphNodePaths.get(branchNodeId) ?? null,
            });
            appendUniqueGraphEdge(edges, edgeIds, {
              from: branchIdentity.entityKey
                ? (entityNodeIds.get(branchIdentity.entityKey) ?? treeNodeId)
                : treeNodeId,
              to: branchNodeId,
              kind: "contains",
            });
          }
        }
      }
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
        path: params.graphNodePaths.get(integrationLeafGraphNodeId(leaf.leafId)) ?? leaf.path,
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
      const scope = parseIntegrationSummaryScope({
        treeSlug: tree.slug,
        path: summary.path,
      });
      const inferredEntitySlug =
        !scope.entitySlug
        && scope.branchSlug
        && labelIndex.entityKeyBySlug.has(scope.branchSlug)
        && !labelIndex.branchIdentityBySlug.has(scope.branchSlug)
          ? scope.branchSlug
          : scope.entitySlug;
      const branchIdentity = scope.branchSlug
        && scope.branchSlug !== inferredEntitySlug
        ? labelIndex.branchIdentityBySlug.get(scope.branchSlug)
          ?? (inferredEntitySlug
            ? (() => {
                const entityKey = labelIndex.entityKeyBySlug.get(inferredEntitySlug);
                return entityKey ? { entityKey, branchKey: scope.branchSlug! } : null;
              })()
            : { entityKey: null, branchKey: scope.branchSlug })
        : null;
      const branchNodeId = branchIdentity
        ? branchNodeIds.get(`${branchIdentity.entityKey ?? "account"}::${branchIdentity.branchKey}`) ?? null
        : null;
      const entityNodeId = inferredEntitySlug
        ? (() => {
            const entityKey = labelIndex.entityKeyBySlug.get(inferredEntitySlug);
            return entityKey ? (entityNodeIds.get(entityKey) ?? null) : null;
          })()
        : null;
      appendUniqueGraphEdge(edges, edgeIds, {
        from: branchNodeId ?? entityNodeId ?? treeNodeId,
        to: integrationSummaryGraphNodeId(summary.nodeId),
        kind: "contains",
      });
    }
    if (summaries.length === 0) {
      for (const leaf of leaves) {
        const branchNodeId = leaf.branchKey
          ? branchNodeIds.get(`${leaf.entityKey ?? "account"}::${leaf.branchKey}`) ?? null
          : null;
        const entityNodeId = leaf.entityKey ? entityNodeIds.get(leaf.entityKey) ?? null : null;
        appendUniqueGraphEdge(edges, edgeIds, {
          from: branchNodeId ?? entityNodeId ?? treeNodeId,
          to: integrationLeafGraphNodeId(leaf.leafId),
          kind: "contains",
        });
      }
    } else {
      for (const leaf of leaves) {
        if (connectedLeafIds.has(leaf.leafId)) {
          continue;
        }
        const branchNodeId = leaf.branchKey
          ? branchNodeIds.get(`${leaf.entityKey ?? "account"}::${leaf.branchKey}`) ?? null
          : null;
        const entityNodeId = leaf.entityKey ? entityNodeIds.get(leaf.entityKey) ?? null : null;
        appendUniqueGraphEdge(edges, edgeIds, {
          from: branchNodeId ?? entityNodeId ?? treeNodeId,
          to: integrationLeafGraphNodeId(leaf.leafId),
          kind: "contains",
        });
      }
    }

    const contactBranchNodeId = integrationBranchNodeId(tree.treeId, null, "contacts");
    const contactBranchPath = params.graphNodePaths.get(contactBranchNodeId) ?? null;
    let contactBranchAttached = false;
    for (const relation of relations) {
      if (relation.relationType !== "participant" || relation.fromNodeKind !== "entity" || relation.toNodeKind !== "entity") {
        continue;
      }
      const contactEntityKey = integrationEntityKeyFromNodeId(tree.treeId, relation.fromNodeId);
      const threadEntityKey = integrationEntityKeyFromNodeId(tree.treeId, relation.toNodeId);
      if (!contactEntityKey?.startsWith("contact:") || !threadEntityKey) {
        continue;
      }
      if (!contactBranchAttached) {
        appendUniqueGraphNode(nodes, nodeIds, {
          id: contactBranchNodeId,
          kind: "branch",
          category: "integration",
          tree_id: tree.treeId,
          label: "Contacts",
          subtitle: "derived branch",
          status: null,
          level: 2,
          child_count: null,
          path: contactBranchPath,
        });
        appendUniqueGraphEdge(edges, edgeIds, {
          from: treeNodeId,
          to: contactBranchNodeId,
          kind: "contains",
        });
        contactBranchAttached = true;
      }

      const contactNodeId = integrationEntityNodeId(tree.treeId, contactEntityKey);
      appendUniqueGraphNode(nodes, nodeIds, {
        id: contactNodeId,
        kind: "entity",
        category: "integration",
        tree_id: tree.treeId,
        label: String(relation.metadata.contact_label ?? relation.metadata.contact_email ?? contactEntityKey.replace(/^contact:/, "")),
        subtitle: "contact",
        status: null,
        level: 3,
        child_count: null,
        path: params.graphNodePaths.get(contactNodeId) ?? null,
      });
      appendUniqueGraphEdge(edges, edgeIds, {
        from: contactBranchNodeId,
        to: contactNodeId,
        kind: "contains",
      });

      appendUniqueGraphEdge(edges, edgeIds, {
        from: contactNodeId,
        to: relation.toNodeId,
        kind: "reference",
      });
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
