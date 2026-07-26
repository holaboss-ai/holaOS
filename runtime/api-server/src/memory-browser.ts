import fs from "node:fs";
import path from "node:path";

import {
  type RuntimeStateStore,
} from "@holaboss/runtime-state-store";

import {
  ensureWorkspaceInteractionSemanticTreesMigrated,
} from "./interaction-memory.js";
import {
  globalMemoryDirForWorkspaceRoot,
  workspaceMemoryDir,
} from "./workspace-bundle-paths.js";
import {
  ensureWorkspaceIntegrationRootsMigrated,
  visibleIntegrationTreesForWorkspace,
} from "./workspace-integration-visibility.js";
import {
  ATTACHMENT_DOCUMENT_NODE_KIND,
  IMAGE_URL_DOCUMENT_NODE_KIND,
  OUTPUT_DOCUMENT_NODE_KIND,
  TOOL_RESULT_DOCUMENT_NODE_KIND,
  listWorkspaceAttachmentDocumentTrees,
  listWorkspaceImageUrlDocumentTrees,
  listWorkspaceOutputDocumentTrees,
  listWorkspaceToolResultDocumentTrees,
} from "./workspace-attachment-memory.js";
import { ensureWorkspaceMemoryReadModelRepaired } from "./workspace-memory-repair.js";

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

export interface MemoryBrowserNodeEvidenceRef {
  ref_id: string;
  provider: string | null;
  account_namespace: string | null;
  connection_id: string | null;
  external_object_id: string | null;
  external_object_type: string | null;
  source_type: string | null;
  source_event_id: string | null;
  source_message_id: string | null;
  source_turn_input_id: string | null;
  observed_at: string | null;
  metadata: Record<string, unknown>;
}

export interface MemoryBrowserNodeRelation {
  relation_type: string;
  source_node_id: string;
  source_label: string | null;
  source_tree_id: string | null;
  target_node_id: string;
  target_label: string | null;
  target_tree_id: string | null;
  target_entity_key: string | null;
  target_resolution_kind: "resolved" | "synthetic" | "missing";
  metadata: Record<string, unknown>;
}

export interface MemoryBrowserNodeDetailResponse {
  workspace_id: string;
  node_id: string;
  tree_id: string | null;
  category: "workspace";
  kind: MemoryBrowserGraphNodeKind | null;
  label: string | null;
  subtitle: string | null;
  path: string | null;
  evidence_refs: MemoryBrowserNodeEvidenceRef[];
  outgoing_relations: MemoryBrowserNodeRelation[];
  incoming_relations: MemoryBrowserNodeRelation[];
}

export type MemoryBrowserGraphForest = "workspace";
export type MemoryBrowserGraphNodeKind = "root" | "section" | "tree" | "node" | "summary" | "leaf";

export interface MemoryBrowserGraphNode {
  id: string;
  kind: MemoryBrowserGraphNodeKind;
  category: "workspace";
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

export interface MemoryBrowserGraphLimits {
  max_layers: number;
  max_nodes: number;
  total_nodes: number;
  total_edges: number;
  displayed_nodes: number;
  displayed_edges: number;
  truncated_by_layers: boolean;
  truncated_by_nodes: boolean;
}

export interface MemoryBrowserGraphResponse {
  workspace_id: string;
  forest: MemoryBrowserGraphForest;
  focus_tree_id: string | null;
  nodes: MemoryBrowserGraphNode[];
  edges: MemoryBrowserGraphEdge[];
  limits: MemoryBrowserGraphLimits;
}

type WorkspaceMemorySectionKey =
  | "goals"
  | "projects"
  | "tasks"
  | "decisions"
  | "people"
  | "organizations"
  | "systems"
  | "artifacts"
  | "knowledge"
  | "processes"
  | "issues_risks"
  | "preferences_rules";

const WORKSPACE_MEMORY_SECTION_LABELS: Record<WorkspaceMemorySectionKey, string> = {
  goals: "Goals",
  projects: "Projects",
  tasks: "Tasks",
  decisions: "Decisions",
  people: "People",
  organizations: "Organizations",
  systems: "Systems",
  artifacts: "Artifacts",
  knowledge: "Knowledge",
  processes: "Processes",
  issues_risks: "Issues & Risks",
  preferences_rules: "Preferences & Rules",
};

const WORKSPACE_MEMORY_SECTION_DIRS: Record<WorkspaceMemorySectionKey, string> = {
  goals: "goals",
  projects: "projects",
  tasks: "tasks",
  decisions: "decisions",
  people: "people",
  organizations: "organizations",
  systems: "systems",
  artifacts: "artifacts",
  knowledge: "knowledge",
  processes: "processes",
  issues_risks: "issues-risks",
  preferences_rules: "preferences-rules",
};

const DEFAULT_MEMORY_BROWSER_GRAPH_MAX_LAYERS = 6;
const DEFAULT_MEMORY_BROWSER_GRAPH_MAX_NODES = 320;
const MAX_MEMORY_BROWSER_GRAPH_MAX_LAYERS = 12;
const MAX_MEMORY_BROWSER_GRAPH_MAX_NODES = 1000;

function accessibleIntegrationTreesForWorkspace(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}) {
  ensureWorkspaceIntegrationRootsMigrated({
    store: params.store,
    workspaceId: params.workspaceId,
    existingTreeIds: new Set(
      visibleIntegrationTreesForWorkspace({
        store: params.store,
        workspaceId: params.workspaceId,
      }).map((tree) => tree.treeId),
    ),
  });
  return visibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
  }).sort((left, right) => left.slug.localeCompare(right.slug));
}

function browserTreeDescriptors(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): Array<{
  treeId: string;
  sourceKind: "interaction" | "integration" | "attachment" | "image_url" | "tool_result" | "output_artifact";
}> {
  ensureWorkspaceInteractionSemanticTreesMigrated({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  return [
    ...params.store.listInteractionEntities({
      workspaceId: params.workspaceId,
      status: "active",
      includeSystem: true,
      limit: 10_000,
      offset: 0,
    }).map((entity) => ({
      treeId: entity.entityId,
      sourceKind: "interaction" as const,
    })),
    ...accessibleIntegrationTreesForWorkspace(params).map((tree) => ({
      treeId: tree.treeId,
      sourceKind: "integration" as const,
    })),
    ...listWorkspaceAttachmentDocumentTrees(params).map((attachment) => ({
      treeId: attachment.treeId,
      sourceKind: "attachment" as const,
    })),
    ...listWorkspaceImageUrlDocumentTrees(params).map((imageUrlArtifact) => ({
      treeId: imageUrlArtifact.treeId,
      sourceKind: "image_url" as const,
    })),
    ...listWorkspaceToolResultDocumentTrees(params).map((toolResult) => ({
      treeId: toolResult.treeId,
      sourceKind: "tool_result" as const,
    })),
    ...listWorkspaceOutputDocumentTrees(params).map((outputArtifact) => ({
      treeId: outputArtifact.treeId,
      sourceKind: "output_artifact" as const,
    })),
  ];
}

function interactionRootNodeId(workspaceId: string): string {
  return `root:workspace:${workspaceId}`;
}

function workspaceSectionNodeId(workspaceId: string, section: WorkspaceMemorySectionKey): string {
  return `section:workspace:${workspaceId}:${section}`;
}

function interactionTreeNodeId(entityId: string): string {
  return `tree:interaction:${entityId}`;
}

function integrationTreeNodeId(treeId: string): string {
  return `tree:workspace:${treeId}`;
}

function integrationEntityNodeId(treeId: string, entityKey: string): string {
  return `entity:workspace:${treeId}:${entityKey}`;
}

function integrationBranchNodeId(treeId: string, entityKey: string | null, branchKey: string): string {
  return `branch:workspace:${treeId}:${entityKey ?? "account"}:${branchKey}`;
}

function integrationEntityKeyFromNodeId(treeId: string, nodeId: string): string | null {
  const prefix = `entity:workspace:${treeId}:`;
  return nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : null;
}

function interactionSummaryGraphNodeId(nodeId: string): string {
  return `summary:interaction:${nodeId}`;
}

function integrationSummaryGraphNodeId(nodeId: string): string {
  return `summary:workspace:${nodeId}`;
}

function interactionLeafGraphNodeId(leafId: string): string {
  return `leaf:interaction:${leafId}`;
}

function integrationLeafGraphNodeId(leafId: string): string {
  return `leaf:workspace:${leafId}`;
}

function semanticBrowserNodeKind(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): MemoryBrowserGraphNodeKind {
  if (node.nodeClass === "leaf") {
    return "leaf";
  }
  if (
    node.nodeKind === "tree"
    || node.nodeKind === "connection"
    || node.nodeKind === ATTACHMENT_DOCUMENT_NODE_KIND
    || node.nodeKind === IMAGE_URL_DOCUMENT_NODE_KIND
    || node.nodeKind === OUTPUT_DOCUMENT_NODE_KIND
    || node.nodeKind === TOOL_RESULT_DOCUMENT_NODE_KIND
  ) {
    return "tree";
  }
  if (node.nodeKind === "partition") {
    return "summary";
  }
  return "node";
}

function semanticNodeDepth(pathValue: string): number | null {
  const normalized = pathValue.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const patterns = [
    ["semantic", "workspace", "systems", "integrations"],
    ["semantic", "integration", "trees"],
  ];
  for (const pattern of patterns) {
    const markerIndex = segments.findIndex((_, index) =>
      pattern.every((segment, offset) => segments[index + offset] === segment)
    );
    if (markerIndex < 0 || segments[segments.length - 1] !== "content.md") {
      continue;
    }
    const treeSlugIndex = markerIndex + pattern.length;
    if (!segments[treeSlugIndex]) {
      continue;
    }
    return Math.max(0, segments.length - (treeSlugIndex + 2));
  }
  return null;
}

const INTERACTION_WORKSPACE_SECTION_DIRS = [
  "projects",
  "processes",
  "preferences-rules",
  "people",
  "organizations",
  "systems",
  "artifacts",
  "knowledge",
] as const;

function semanticInteractionNodeDepth(pathValue: string): number | null {
  const normalized = pathValue.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const patterns = [
    ...INTERACTION_WORKSPACE_SECTION_DIRS.map((sectionDir) => ["semantic", "workspace", sectionDir] as const),
    ["semantic", "interaction", "trees"] as const,
  ];
  for (const pattern of patterns) {
    const markerIndex = segments.findIndex(
      (_, index) => pattern.every((segment, offset) => segments[index + offset] === segment),
    );
    if (markerIndex < 0 || segments[segments.length - 1] !== "content.md") {
      continue;
    }
    const treeSlugIndex = markerIndex + pattern.length;
    if (!segments[treeSlugIndex]) {
      continue;
    }
    return Math.max(0, segments.length - (treeSlugIndex + 2));
  }
  return null;
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
  const patterns = [
    ["workspace", "systems", "integrations", params.treeSlug],
    ["integration", "trees", params.treeSlug],
  ];
  const baseIndex = patterns
    .map((pattern) =>
      segments.findIndex((_, index) =>
        pattern.every((segment, offset) => segments[index + offset] === segment)
      ))
    .find((index) => index >= 0) ?? -1;
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
  const isWorkspacePath = segments[baseIndex] === "workspace";
  const scope = segments.slice(baseIndex + (isWorkspacePath ? 4 : 3));
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

function metadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function relationLabelFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  return metadataString(metadata, "entity_label") ?? metadataString(metadata, "entity_key");
}

function relationResolutionKind(params: {
  metadata: Record<string, unknown> | null | undefined;
  resolvedNodeExists: boolean;
  targetTreeId: string | null;
  targetNodeId: string | null;
}): "resolved" | "synthetic" | "missing" {
  const metadataKind = metadataString(params.metadata, "resolved_target_kind");
  if (params.resolvedNodeExists) {
    return "resolved";
  }
  if (params.targetTreeId || params.targetNodeId) {
    return "missing";
  }
  if (metadataKind === "resolved" || metadataKind === "synthetic") {
    return metadataKind;
  }
  return "synthetic";
}

function syntheticRelatedNodeDetailDescriptor(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  nodeId: string;
}): {
  kind: MemoryBrowserGraphNodeKind;
  label: string;
  subtitle: string | null;
  resolutionKind: "resolved" | "synthetic" | "missing";
} | null {
  const relationKinds: Array<"resolved" | "synthetic" | "missing"> = [];
  let label: string | null = null;
  let entityType: string | null = null;
  for (const descriptor of browserTreeDescriptors({
    store: params.store,
    workspaceId: params.workspaceId,
  })) {
    for (const relation of params.store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: descriptor.treeId,
      limit: 10_000,
      offset: 0,
    })) {
      if (relation.toNodeId !== params.nodeId) {
        continue;
      }
      const entityKey = metadataString(relation.metadata, "entity_key") ?? relation.toNodeId;
      const entityLabel = metadataString(relation.metadata, "entity_label") ?? shortLabel(entityKey, relation.toNodeId);
      const relationEntityType = metadataString(relation.metadata, "entity_type");
      const targetTreeId = metadataString(relation.metadata, "target_tree_id");
      const targetNodeId = metadataString(relation.metadata, "target_node_id");
      const resolutionKind = relationResolutionKind({
        metadata: relation.metadata,
        resolvedNodeExists: false,
        targetTreeId: targetTreeId || null,
        targetNodeId: targetNodeId || null,
      });
      relationKinds.push(resolutionKind);
      if (!label) {
        label = entityLabel;
      }
      if (!entityType) {
        entityType = relationEntityType;
      }
    }
  }
  if (relationKinds.length === 0 || !label) {
    return null;
  }
  const resolutionKind = relationKinds.includes("synthetic")
    ? "synthetic"
    : relationKinds.includes("missing")
      ? "missing"
      : relationKinds[0]!;
  const subtitleBase = entityType ? `related ${entityType}` : "related entity";
  return {
    kind: "node",
    label,
    subtitle: resolutionKind === "missing"
      ? `missing ${subtitleBase}`
      : resolutionKind === "synthetic"
        ? `synthetic ${subtitleBase}`
        : subtitleBase,
    resolutionKind,
  };
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
  accountNamespace: string;
}): string {
  return `${params.provider} · ${params.accountNamespace}`;
}

function workspaceSectionForInteractionEntityType(entityType: string): WorkspaceMemorySectionKey {
  switch (entityType) {
    case "project":
      return "projects";
    case "workflow":
      return "processes";
    case "preference":
      return "preferences_rules";
    case "identity":
    case "person":
      return "people";
    case "customer":
      return "organizations";
    case "system":
      return "systems";
    case "topic":
      return "knowledge";
    default:
      return "knowledge";
  }
}

function ensureWorkspaceSectionGraphNode(params: {
  workspaceId: string;
  section: WorkspaceMemorySectionKey;
  rootNodeId: string;
  nodes: MemoryBrowserGraphNode[];
  nodeIds: Set<string>;
  edges: MemoryBrowserGraphEdge[];
  edgeIds: Set<string>;
}): string {
  const nodeId = workspaceSectionNodeId(params.workspaceId, params.section);
  appendUniqueGraphNode(params.nodes, params.nodeIds, {
    id: nodeId,
    kind: "section",
    category: "workspace",
    tree_id: null,
    label: WORKSPACE_MEMORY_SECTION_LABELS[params.section],
    subtitle: "top-level section",
    status: null,
    level: 1,
    child_count: null,
    path: null,
  });
  appendUniqueGraphEdge(params.edges, params.edgeIds, {
    from: params.rootNodeId,
    to: nodeId,
    kind: "contains",
  });
  return nodeId;
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

function graphNodeKindRank(kind: MemoryBrowserGraphNodeKind): number {
  switch (kind) {
    case "root":
      return 0;
    case "section":
      return 1;
    case "tree":
      return 2;
    case "node":
      return 3;
    case "summary":
      return 4;
    case "leaf":
      return 5;
    default:
      return 6;
  }
}

function compareGraphNodes(
  left: MemoryBrowserGraphNode,
  right: MemoryBrowserGraphNode,
): number {
  const leftLevel = left.level ?? Number.MAX_SAFE_INTEGER;
  const rightLevel = right.level ?? Number.MAX_SAFE_INTEGER;
  if (leftLevel !== rightLevel) {
    return leftLevel - rightLevel;
  }
  const leftKindRank = graphNodeKindRank(left.kind);
  const rightKindRank = graphNodeKindRank(right.kind);
  if (leftKindRank !== rightKindRank) {
    return leftKindRank - rightKindRank;
  }
  const labelComparison = left.label.localeCompare(right.label, undefined, {
    sensitivity: "base",
  });
  if (labelComparison !== 0) {
    return labelComparison;
  }
  return left.id.localeCompare(right.id);
}

function normalizeGraphDisplayLimit(
  value: number | null | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) {
    return fallback;
  }
  return Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));
}

function applyMemoryBrowserGraphDisplayLimits(params: {
  workspaceId: string;
  focusTreeId: string | null;
  nodes: MemoryBrowserGraphNode[];
  edges: MemoryBrowserGraphEdge[];
  maxLayers?: number | null;
  maxNodes?: number | null;
}): MemoryBrowserGraphResponse {
  const maxLayers = normalizeGraphDisplayLimit(
    params.maxLayers,
    DEFAULT_MEMORY_BROWSER_GRAPH_MAX_LAYERS,
    MAX_MEMORY_BROWSER_GRAPH_MAX_LAYERS,
  );
  const maxNodes = normalizeGraphDisplayLimit(
    params.maxNodes,
    DEFAULT_MEMORY_BROWSER_GRAPH_MAX_NODES,
    MAX_MEMORY_BROWSER_GRAPH_MAX_NODES,
  );
  const allowedNodeIds = new Set(
    params.nodes
      .filter((node) => node.level == null || node.level < maxLayers)
      .map((node) => node.id),
  );
  const nodeById = new Map(params.nodes.map((node) => [node.id, node]));
  const outgoingEdgesByFrom = new Map<string, MemoryBrowserGraphEdge[]>();
  for (const edge of params.edges) {
    if (!allowedNodeIds.has(edge.from) || !allowedNodeIds.has(edge.to)) {
      continue;
    }
    const siblings = outgoingEdgesByFrom.get(edge.from) ?? [];
    siblings.push(edge);
    outgoingEdgesByFrom.set(edge.from, siblings);
  }
  for (const siblings of outgoingEdgesByFrom.values()) {
    siblings.sort((left, right) => {
      const leftNode = nodeById.get(left.to);
      const rightNode = nodeById.get(right.to);
      if (!leftNode || !rightNode) {
        return left.to.localeCompare(right.to);
      }
      return compareGraphNodes(leftNode, rightNode);
    });
  }
  const queue = params.nodes
    .filter((node) => node.kind === "root" && allowedNodeIds.has(node.id))
    .sort(compareGraphNodes)
    .map((node) => node.id);
  const visitedNodeIds = new Set<string>();
  const layerLimitedNodes: MemoryBrowserGraphNode[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index];
    if (!nodeId || visitedNodeIds.has(nodeId)) {
      continue;
    }
    const node = nodeById.get(nodeId);
    if (!node || !allowedNodeIds.has(nodeId)) {
      continue;
    }
    visitedNodeIds.add(nodeId);
    layerLimitedNodes.push(node);
    for (const edge of outgoingEdgesByFrom.get(nodeId) ?? []) {
      if (!visitedNodeIds.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }
  const remainingNodes = params.nodes
    .filter((node) => allowedNodeIds.has(node.id) && !visitedNodeIds.has(node.id))
    .sort(compareGraphNodes);
  layerLimitedNodes.push(...remainingNodes);
  const visibleNodes = layerLimitedNodes.slice(0, maxNodes);
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = params.edges.filter(
    (edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to),
  );

  return {
    workspace_id: params.workspaceId,
    forest: "workspace",
    focus_tree_id: params.focusTreeId,
    nodes: visibleNodes,
    edges: visibleEdges,
    limits: {
      max_layers: maxLayers,
      max_nodes: maxNodes,
      total_nodes: params.nodes.length,
      total_edges: params.edges.length,
      displayed_nodes: visibleNodes.length,
      displayed_edges: visibleEdges.length,
      truncated_by_layers: layerLimitedNodes.length < params.nodes.length,
      truncated_by_nodes: visibleNodes.length < layerLimitedNodes.length,
    },
  };
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
  const candidatePaths: string[] = [];
  const workspacePrefix = `workspace/${params.workspaceId}/`;
  if (normalized.startsWith("integration/")) {
    candidatePaths.push(path.join(globalMemoryDirForWorkspaceRoot(params.store.workspaceRoot), normalized));
  } else if (normalized.startsWith("semantic/")) {
    candidatePaths.push(
      path.join(
        workspaceMemoryDir(params.store.workspaceDir(params.workspaceId)),
        normalized,
      ),
    );
    candidatePaths.push(
      path.join(
        globalMemoryDirForWorkspaceRoot(params.store.workspaceRoot),
        normalized,
      ),
    );
  } else if (normalized.startsWith(workspacePrefix)) {
    candidatePaths.push(path.join(
      workspaceMemoryDir(params.store.workspaceDir(params.workspaceId)),
      normalized.slice(workspacePrefix.length),
    ));
  } else {
    candidatePaths.push(path.join(
      workspaceMemoryDir(params.store.workspaceDir(params.workspaceId)),
      normalized,
    ));
  }
  let absolutePath: string | null = null;
  let stat: fs.Stats | undefined;
  for (const candidatePath of candidatePaths) {
    const candidateStat = fs.statSync(candidatePath, { throwIfNoEntry: false });
    if (candidateStat?.isFile()) {
      absolutePath = candidatePath;
      stat = candidateStat;
      break;
    }
  }
  if (!absolutePath || !stat) {
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
  if (relative.startsWith("semantic/workspace/")) {
    return relative.slice("semantic/".length);
  }
  if (relative.startsWith("semantic/interaction/trees/")) {
    return relative.slice("semantic/".length);
  }
  if (relative.startsWith("semantic/integration/trees/")) {
    return `workspace/systems/integrations/${relative.slice("semantic/integration/trees/".length)}`;
  }
  return relative;
}

function interactionBrowserPathForStoredPath(params: {
  workspaceId: string;
  entityType: string;
  entitySlug: string;
  targetPath: string;
}): string {
  const normalized = normalizeBrowserPath(params.targetPath);
  const workspacePrefix = `workspace/${params.workspaceId}/`;
  const relative = normalized.startsWith(workspacePrefix)
    ? normalized.slice(workspacePrefix.length)
    : normalized;
  if (relative.startsWith("semantic/workspace/")) {
    return browserPathForStoredPath(params.workspaceId, relative);
  }
  const segments = relative.split("/").filter(Boolean);
  const markerIndex = segments.findIndex(
    (segment, index) =>
      segment === "semantic"
      && segments[index + 1] === "interaction"
      && segments[index + 2] === "trees",
  );
  const section = workspaceSectionForInteractionEntityType(params.entityType);
  const baseSegments = [
    "workspace",
    WORKSPACE_MEMORY_SECTION_DIRS[section],
    params.entitySlug,
  ];
  if (markerIndex < 0) {
    return path.posix.join(...baseSegments, path.posix.basename(relative));
  }
  const rest = segments.slice(markerIndex + 4);
  return path.posix.join(...baseSegments, ...(rest.length > 0 ? rest : ["content.md"]));
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

  ensureWorkspaceInteractionSemanticTreesMigrated({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const interactionTrees = params.store.listInteractionEntities({
    workspaceId: params.workspaceId,
    status: "active",
    includeSystem: true,
    limit: 10_000,
  });
  for (const entity of interactionTrees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
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
        const browserPath = interactionBrowserPathForStoredPath({
          workspaceId: params.workspaceId,
          entityType: entity.entityType,
          entitySlug: entity.slug,
          targetPath: node.path,
        });
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
  ensureVirtualDirectory(rootBuilder, ["workspace", "systems", "integrations"]);
  for (const tree of integrationTrees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: params.workspaceId,
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

  const attachmentTrees = listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  for (const attachment of attachmentTrees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: attachment.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length === 0) {
      continue;
    }
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

  const imageUrlTrees = listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  for (const imageUrlArtifact of imageUrlTrees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: imageUrlArtifact.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length === 0) {
      continue;
    }
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

  const toolResultTrees = listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  for (const toolResult of toolResultTrees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: toolResult.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length === 0) {
      continue;
    }
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

  const outputArtifactTrees = listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  for (const outputArtifact of outputArtifactTrees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: outputArtifact.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length === 0) {
      continue;
    }
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

function appendIntegrationGraphContent(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
  graphNodePaths: Map<string, string>;
  rootNodeId: string;
  nodes: MemoryBrowserGraphNode[];
  nodeIds: Set<string>;
  edges: MemoryBrowserGraphEdge[];
  edgeIds: Set<string>;
}): void {
  const focusTreeId = (params.treeId ?? "").trim() || null;
  const visibleTrees = accessibleIntegrationTreesForWorkspace(params);
  const trees = focusTreeId
    ? visibleTrees.filter((tree) => tree.treeId === focusTreeId)
    : visibleTrees;
  if (focusTreeId && trees.length === 0) {
    throw new Error("integration tree not found");
  }
  if (trees.length === 0) {
    return;
  }

  const systemsSectionNodeId = ensureWorkspaceSectionGraphNode({
    workspaceId: params.workspaceId,
    section: "systems",
    rootNodeId: params.rootNodeId,
    nodes: params.nodes,
    nodeIds: params.nodeIds,
    edges: params.edges,
    edgeIds: params.edgeIds,
  });

  for (const tree of trees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: tree.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length === 0) {
      continue;
    }
    const rootSemanticNode = semanticNodes.find((node) => node.nodeKind === "connection")
      ?? semanticNodes.find((node) => semanticBrowserNodeKind(node) === "tree")
      ?? semanticNodes[0]!;
    for (const node of semanticNodes) {
      const kind = semanticBrowserNodeKind(node);
      const depth = semanticNodeDepth(node.path);
      appendUniqueGraphNode(params.nodes, params.nodeIds, {
        id: node.nodeId,
        kind,
        category: "workspace",
        tree_id: tree.treeId,
        label: shortLabel(node.title, node.nodeId),
        subtitle: kind === "tree"
          ? integrationTreeSubtitle({
              provider: tree.provider,
              accountNamespace: tree.accountNamespace,
            })
          : null,
        status: node.status,
        level: kind === "tree" ? 2 : depth === null ? null : depth + 2,
        child_count: node.childCount,
        path: params.graphNodePaths.get(node.nodeId) ?? browserPathForStoredPath(params.workspaceId, node.path),
      });
    }
    appendUniqueGraphEdge(params.edges, params.edgeIds, {
      from: systemsSectionNodeId,
      to: rootSemanticNode.nodeId,
      kind: "contains",
    });
    for (const node of semanticNodes.filter((candidate) => candidate.nodeClass === "semantic")) {
      const parentKind = semanticBrowserNodeKind(node);
      for (const edge of params.store.listSemanticMemoryChildren({
        category: "workspace",
        workspaceId: params.workspaceId,
        treeId: tree.treeId,
        parentNodeId: node.nodeId,
      })) {
        appendUniqueGraphEdge(params.edges, params.edgeIds, {
          from: edge.parentNodeId,
          to: edge.childNodeId,
          kind: parentKind === "tree" ? "contains" : "parent_child",
        });
      }
    }
    for (const relation of params.store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: tree.treeId,
      limit: 10_000,
    })) {
      if (!params.nodeIds.has(relation.fromNodeId) || !params.nodeIds.has(relation.toNodeId)) {
        continue;
      }
      appendUniqueGraphEdge(params.edges, params.edgeIds, {
        from: relation.fromNodeId,
        to: relation.toNodeId,
        kind: "reference",
      });
    }
  }
}

function appendAttachmentGraphContent(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
  graphNodePaths: Map<string, string>;
  rootNodeId: string;
  nodes: MemoryBrowserGraphNode[];
  nodeIds: Set<string>;
  edges: MemoryBrowserGraphEdge[];
  edgeIds: Set<string>;
}): void {
  const focusTreeId = (params.treeId ?? "").trim() || null;
  const visibleTrees = listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const trees = focusTreeId
    ? visibleTrees.filter((tree) => tree.treeId === focusTreeId)
    : visibleTrees;
  if (trees.length === 0) {
    return;
  }

  const artifactsSectionNodeId = ensureWorkspaceSectionGraphNode({
    workspaceId: params.workspaceId,
    section: "artifacts",
    rootNodeId: params.rootNodeId,
    nodes: params.nodes,
    nodeIds: params.nodeIds,
    edges: params.edges,
    edgeIds: params.edgeIds,
  });

  for (const attachment of trees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: attachment.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length === 0) {
      continue;
    }
    const rootSemanticNode = semanticNodes.find((node) => node.nodeKind === ATTACHMENT_DOCUMENT_NODE_KIND)
      ?? semanticNodes.find((node) => semanticBrowserNodeKind(node) === "tree")
      ?? semanticNodes[0]!;
    for (const node of semanticNodes) {
      const kind = semanticBrowserNodeKind(node);
      const depth = semanticInteractionNodeDepth(node.path);
      appendUniqueGraphNode(params.nodes, params.nodeIds, {
        id: node.nodeId,
        kind,
        category: "workspace",
        tree_id: attachment.treeId,
        label: shortLabel(node.title, node.nodeId),
        subtitle: kind === "tree" ? attachment.mimeType : null,
        status: node.status,
        level: kind === "tree" ? 2 : depth === null ? null : depth + 2,
        child_count: node.childCount,
        path: params.graphNodePaths.get(node.nodeId) ?? browserPathForStoredPath(params.workspaceId, node.path),
      });
    }
    appendUniqueGraphEdge(params.edges, params.edgeIds, {
      from: artifactsSectionNodeId,
      to: rootSemanticNode.nodeId,
      kind: "contains",
    });
    for (const node of semanticNodes.filter((candidate) => candidate.nodeClass === "semantic")) {
      const parentKind = semanticBrowserNodeKind(node);
      for (const edge of params.store.listSemanticMemoryChildren({
        category: "workspace",
        workspaceId: params.workspaceId,
        treeId: attachment.treeId,
        parentNodeId: node.nodeId,
      })) {
        appendUniqueGraphEdge(params.edges, params.edgeIds, {
          from: edge.parentNodeId,
          to: edge.childNodeId,
          kind: parentKind === "tree" ? "contains" : "parent_child",
        });
      }
    }
  }
}

function appendImageUrlGraphContent(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
  graphNodePaths: Map<string, string>;
  rootNodeId: string;
  nodes: MemoryBrowserGraphNode[];
  nodeIds: Set<string>;
  edges: MemoryBrowserGraphEdge[];
  edgeIds: Set<string>;
}): void {
  const focusTreeId = (params.treeId ?? "").trim() || null;
  const visibleTrees = listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const trees = focusTreeId
    ? visibleTrees.filter((tree) => tree.treeId === focusTreeId)
    : visibleTrees;
  if (trees.length === 0) {
    return;
  }

  const artifactsSectionNodeId = ensureWorkspaceSectionGraphNode({
    workspaceId: params.workspaceId,
    section: "artifacts",
    rootNodeId: params.rootNodeId,
    nodes: params.nodes,
    nodeIds: params.nodeIds,
    edges: params.edges,
    edgeIds: params.edgeIds,
  });

  for (const imageUrlArtifact of trees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: imageUrlArtifact.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length === 0) {
      continue;
    }
    const rootSemanticNode = semanticNodes.find((node) => node.nodeKind === IMAGE_URL_DOCUMENT_NODE_KIND)
      ?? semanticNodes.find((node) => semanticBrowserNodeKind(node) === "tree")
      ?? semanticNodes[0]!;
    for (const node of semanticNodes) {
      const kind = semanticBrowserNodeKind(node);
      const depth = semanticInteractionNodeDepth(node.path);
      appendUniqueGraphNode(params.nodes, params.nodeIds, {
        id: node.nodeId,
        kind,
        category: "workspace",
        tree_id: imageUrlArtifact.treeId,
        label: shortLabel(node.title, node.nodeId),
        subtitle: kind === "tree" ? (imageUrlArtifact.mimeType ?? "referenced image") : null,
        status: node.status,
        level: kind === "tree" ? 2 : depth === null ? null : depth + 2,
        child_count: node.childCount,
        path: params.graphNodePaths.get(node.nodeId) ?? browserPathForStoredPath(params.workspaceId, node.path),
      });
    }
    appendUniqueGraphEdge(params.edges, params.edgeIds, {
      from: artifactsSectionNodeId,
      to: rootSemanticNode.nodeId,
      kind: "contains",
    });
    for (const node of semanticNodes.filter((candidate) => candidate.nodeClass === "semantic")) {
      const parentKind = semanticBrowserNodeKind(node);
      for (const edge of params.store.listSemanticMemoryChildren({
        category: "workspace",
        workspaceId: params.workspaceId,
        treeId: imageUrlArtifact.treeId,
        parentNodeId: node.nodeId,
      })) {
        appendUniqueGraphEdge(params.edges, params.edgeIds, {
          from: edge.parentNodeId,
          to: edge.childNodeId,
          kind: parentKind === "tree" ? "contains" : "parent_child",
        });
      }
    }
  }
}

function appendToolResultGraphContent(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
  graphNodePaths: Map<string, string>;
  rootNodeId: string;
  nodes: MemoryBrowserGraphNode[];
  nodeIds: Set<string>;
  edges: MemoryBrowserGraphEdge[];
  edgeIds: Set<string>;
}): void {
  const focusTreeId = (params.treeId ?? "").trim() || null;
  const visibleTrees = listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const trees = focusTreeId
    ? visibleTrees.filter((tree) => tree.treeId === focusTreeId)
    : visibleTrees;
  if (trees.length === 0) {
    return;
  }

  const artifactsSectionNodeId = ensureWorkspaceSectionGraphNode({
    workspaceId: params.workspaceId,
    section: "artifacts",
    rootNodeId: params.rootNodeId,
    nodes: params.nodes,
    nodeIds: params.nodeIds,
    edges: params.edges,
    edgeIds: params.edgeIds,
  });

  for (const toolResult of trees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: toolResult.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length === 0) {
      continue;
    }
    const rootSemanticNode = semanticNodes.find((node) => node.nodeKind === TOOL_RESULT_DOCUMENT_NODE_KIND)
      ?? semanticNodes.find((node) => semanticBrowserNodeKind(node) === "tree")
      ?? semanticNodes[0]!;
    for (const node of semanticNodes) {
      const kind = semanticBrowserNodeKind(node);
      const depth = semanticInteractionNodeDepth(node.path);
      appendUniqueGraphNode(params.nodes, params.nodeIds, {
        id: node.nodeId,
        kind,
        category: "workspace",
        tree_id: toolResult.treeId,
        label: shortLabel(node.title, node.nodeId),
        subtitle: kind === "tree"
          ? `${toolResult.providerId} ${toolResult.accountNamespace}`
          : null,
        status: node.status,
        level: kind === "tree" ? 2 : depth === null ? null : depth + 2,
        child_count: node.childCount,
        path: params.graphNodePaths.get(node.nodeId) ?? browserPathForStoredPath(params.workspaceId, node.path),
      });
    }
    appendUniqueGraphEdge(params.edges, params.edgeIds, {
      from: artifactsSectionNodeId,
      to: rootSemanticNode.nodeId,
      kind: "contains",
    });
    for (const node of semanticNodes.filter((candidate) => candidate.nodeClass === "semantic")) {
      const parentKind = semanticBrowserNodeKind(node);
      for (const edge of params.store.listSemanticMemoryChildren({
        category: "workspace",
        workspaceId: params.workspaceId,
        treeId: toolResult.treeId,
        parentNodeId: node.nodeId,
      })) {
        appendUniqueGraphEdge(params.edges, params.edgeIds, {
          from: edge.parentNodeId,
          to: edge.childNodeId,
          kind: parentKind === "tree" ? "contains" : "parent_child",
        });
      }
    }
  }
}

function appendOutputArtifactGraphContent(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
  graphNodePaths: Map<string, string>;
  rootNodeId: string;
  nodes: MemoryBrowserGraphNode[];
  nodeIds: Set<string>;
  edges: MemoryBrowserGraphEdge[];
  edgeIds: Set<string>;
}): void {
  const focusTreeId = (params.treeId ?? "").trim() || null;
  const visibleTrees = listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const trees = focusTreeId
    ? visibleTrees.filter((tree) => tree.treeId === focusTreeId)
    : visibleTrees;
  if (trees.length === 0) {
    return;
  }

  const artifactsSectionNodeId = ensureWorkspaceSectionGraphNode({
    workspaceId: params.workspaceId,
    section: "artifacts",
    rootNodeId: params.rootNodeId,
    nodes: params.nodes,
    nodeIds: params.nodeIds,
    edges: params.edges,
    edgeIds: params.edgeIds,
  });

  for (const outputArtifact of trees) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: outputArtifact.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    });
    if (semanticNodes.length === 0) {
      continue;
    }
    const rootSemanticNode = semanticNodes.find((node) => node.nodeKind === OUTPUT_DOCUMENT_NODE_KIND)
      ?? semanticNodes.find((node) => semanticBrowserNodeKind(node) === "tree")
      ?? semanticNodes[0]!;
    for (const node of semanticNodes) {
      const kind = semanticBrowserNodeKind(node);
      const depth = semanticInteractionNodeDepth(node.path);
      appendUniqueGraphNode(params.nodes, params.nodeIds, {
        id: node.nodeId,
        kind,
        category: "workspace",
        tree_id: outputArtifact.treeId,
        label: shortLabel(node.title, node.nodeId),
        subtitle: kind === "tree"
          ? outputArtifact.outputType
          : null,
        status: node.status,
        level: kind === "tree" ? 2 : depth === null ? null : depth + 2,
        child_count: node.childCount,
        path: params.graphNodePaths.get(node.nodeId) ?? browserPathForStoredPath(params.workspaceId, node.path),
      });
    }
    appendUniqueGraphEdge(params.edges, params.edgeIds, {
      from: artifactsSectionNodeId,
      to: rootSemanticNode.nodeId,
      kind: "contains",
    });
    for (const node of semanticNodes.filter((candidate) => candidate.nodeClass === "semantic")) {
      const parentKind = semanticBrowserNodeKind(node);
      for (const edge of params.store.listSemanticMemoryChildren({
        category: "workspace",
        workspaceId: params.workspaceId,
        treeId: outputArtifact.treeId,
        parentNodeId: node.nodeId,
      })) {
        appendUniqueGraphEdge(params.edges, params.edgeIds, {
          from: edge.parentNodeId,
          to: edge.childNodeId,
          kind: parentKind === "tree" ? "contains" : "parent_child",
        });
      }
    }
  }
}

function appendWorkspaceRelationGraphContent(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  nodes: MemoryBrowserGraphNode[];
  nodeIds: Set<string>;
  edges: MemoryBrowserGraphEdge[];
  edgeIds: Set<string>;
}): void {
  for (const relation of params.store.listSemanticMemoryRelations({
    category: "workspace",
    workspaceId: params.workspaceId,
    treeId: params.treeId,
    limit: 10_000,
  })) {
    if (!params.nodeIds.has(relation.fromNodeId)) {
      continue;
    }
    let targetNodeId = relation.toNodeId;
    if (!params.nodeIds.has(targetNodeId)) {
      const entityKey = metadataString(relation.metadata, "entity_key") ?? relation.toNodeId;
      const entityLabel = metadataString(relation.metadata, "entity_label") ?? shortLabel(entityKey, relation.toNodeId);
      const entityType = metadataString(relation.metadata, "entity_type");
      targetNodeId = relation.toNodeId;
      appendUniqueGraphNode(params.nodes, params.nodeIds, {
        id: targetNodeId,
        kind: "node",
        category: "workspace",
        tree_id: null,
        label: entityLabel,
        subtitle: entityType ? `related ${entityType}` : "related entity",
        status: null,
        level: null,
        child_count: null,
        path: null,
      });
    }
    appendUniqueGraphEdge(params.edges, params.edgeIds, {
      from: relation.fromNodeId,
      to: targetNodeId,
      kind: "reference",
    });
  }
}

function buildWorkspaceGraph(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
  graphNodePaths: Map<string, string>;
  maxLayers?: number | null;
  maxNodes?: number | null;
}): MemoryBrowserGraphResponse {
  const workspace = params.store.getWorkspace(params.workspaceId);
  if (!workspace) {
    throw new Error("workspace not found");
  }
  const focusTreeId = (params.treeId ?? "").trim() || null;
  const focusInteractionTreeId = focusTreeId?.startsWith("interaction:")
    ? focusTreeId
    : null;
  const focusWorkspaceTreeId = focusTreeId && !focusInteractionTreeId
    ? focusTreeId
    : null;
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
    category: "workspace",
    tree_id: null,
    label: rootLabel,
    subtitle: "workspace graph",
    status: null,
    level: 0,
    child_count: null,
    path: null,
  });

  const entities = focusInteractionTreeId
    ? [params.store.getInteractionEntity({ workspaceId: params.workspaceId, entityId: focusInteractionTreeId })]
        .filter((value): value is NonNullable<typeof value> => Boolean(value))
    : params.store.listInteractionEntities({
        workspaceId: params.workspaceId,
        status: "active",
        includeSystem: true,
        limit: 1000,
      });
  if (focusInteractionTreeId && entities.length === 0) {
    throw new Error("interaction tree not found");
  }

  ensureWorkspaceInteractionSemanticTreesMigrated({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  for (const entity of entities) {
    const semanticNodes = params.store.listSemanticMemoryNodes({
      category: "workspace",
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
    const sectionNodeId = ensureWorkspaceSectionGraphNode({
      workspaceId: params.workspaceId,
      section: workspaceSectionForInteractionEntityType(entity.entityType),
      rootNodeId,
      nodes,
      nodeIds,
      edges,
      edgeIds,
    });
    for (const node of semanticNodes) {
      const kind = semanticBrowserNodeKind(node);
      const depth = semanticInteractionNodeDepth(node.path);
      appendUniqueGraphNode(nodes, nodeIds, {
        id: node.nodeId,
        kind,
        category: "workspace",
        tree_id: entity.entityId,
        label: shortLabel(node.title, node.nodeId),
        subtitle: kind === "tree"
          ? interactionTreeSubtitle(entity.entityType)
          : kind === "summary" && node.nodeKind === "partition"
            ? "materialized"
            : null,
        status: node.status,
        level: kind === "tree" ? 2 : depth === null ? null : depth + 2,
        child_count: node.childCount,
        path: params.graphNodePaths.get(node.nodeId) ?? browserPathForStoredPath(params.workspaceId, node.path),
      });
    }
    appendUniqueGraphEdge(edges, edgeIds, {
      from: sectionNodeId,
      to: rootSemanticNode.nodeId,
      kind: "contains",
    });
    for (const node of semanticNodes.filter((candidate) => candidate.nodeClass === "semantic")) {
      for (const edge of params.store.listSemanticMemoryChildren({
        category: "workspace",
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
  const relationTreeIds = new Set<string>();
  for (const entity of entities) {
    relationTreeIds.add(entity.entityId);
  }

  if (!focusInteractionTreeId) {
    if (!focusWorkspaceTreeId || focusWorkspaceTreeId.startsWith("integration:")) {
      appendIntegrationGraphContent({
        ...params,
        treeId: focusWorkspaceTreeId,
        rootNodeId,
        nodes,
        nodeIds,
        edges,
        edgeIds,
      });
    }
    if (!focusWorkspaceTreeId || focusWorkspaceTreeId.startsWith("attachment:")) {
      const attachmentTrees = listWorkspaceAttachmentDocumentTrees({
        store: params.store,
        workspaceId: params.workspaceId,
      }).filter((descriptor) => !focusWorkspaceTreeId || descriptor.treeId === focusWorkspaceTreeId);
      appendAttachmentGraphContent({
        ...params,
        treeId: focusWorkspaceTreeId,
        graphNodePaths: params.graphNodePaths,
        rootNodeId,
        nodes,
        nodeIds,
        edges,
        edgeIds,
      });
      for (const descriptor of attachmentTrees) {
        relationTreeIds.add(descriptor.treeId);
      }
    }
    if (!focusWorkspaceTreeId || focusWorkspaceTreeId.startsWith("image-url:")) {
      const imageUrlTrees = listWorkspaceImageUrlDocumentTrees({
        store: params.store,
        workspaceId: params.workspaceId,
      }).filter((descriptor) => !focusWorkspaceTreeId || descriptor.treeId === focusWorkspaceTreeId);
      appendImageUrlGraphContent({
        ...params,
        treeId: focusWorkspaceTreeId,
        graphNodePaths: params.graphNodePaths,
        rootNodeId,
        nodes,
        nodeIds,
        edges,
        edgeIds,
      });
      for (const descriptor of imageUrlTrees) {
        relationTreeIds.add(descriptor.treeId);
      }
    }
    if (!focusWorkspaceTreeId || focusWorkspaceTreeId.startsWith("tool-result:")) {
      const toolResultTrees = listWorkspaceToolResultDocumentTrees({
        store: params.store,
        workspaceId: params.workspaceId,
      }).filter((descriptor) => !focusWorkspaceTreeId || descriptor.treeId === focusWorkspaceTreeId);
      appendToolResultGraphContent({
        ...params,
        treeId: focusWorkspaceTreeId,
        graphNodePaths: params.graphNodePaths,
        rootNodeId,
        nodes,
        nodeIds,
        edges,
        edgeIds,
      });
      for (const descriptor of toolResultTrees) {
        relationTreeIds.add(descriptor.treeId);
      }
    }
    if (!focusWorkspaceTreeId || focusWorkspaceTreeId.startsWith("output-artifact:")) {
      const outputArtifactTrees = listWorkspaceOutputDocumentTrees({
        store: params.store,
        workspaceId: params.workspaceId,
      }).filter((descriptor) => !focusWorkspaceTreeId || descriptor.treeId === focusWorkspaceTreeId);
      appendOutputArtifactGraphContent({
        ...params,
        treeId: focusWorkspaceTreeId,
        graphNodePaths: params.graphNodePaths,
        rootNodeId,
        nodes,
        nodeIds,
        edges,
        edgeIds,
      });
      for (const descriptor of outputArtifactTrees) {
        relationTreeIds.add(descriptor.treeId);
      }
    }
  }

  for (const treeId of relationTreeIds) {
    appendWorkspaceRelationGraphContent({
      store: params.store,
      workspaceId: params.workspaceId,
      treeId,
      nodes,
      nodeIds,
      edges,
      edgeIds,
    });
    }

  return applyMemoryBrowserGraphDisplayLimits({
    workspaceId: params.workspaceId,
    focusTreeId,
    nodes,
    edges,
    maxLayers: params.maxLayers,
    maxNodes: params.maxNodes,
  });
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

export async function buildMemoryBrowserTree(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): Promise<MemoryBrowserTreeResponse> {
  const workspace = params.store.getWorkspace(params.workspaceId);
  if (!workspace) {
    throw new Error("workspace not found");
  }
  await ensureWorkspaceMemoryReadModelRepaired({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const model = buildVirtualMemoryBrowserModel(params);
  return {
    workspace_id: params.workspaceId,
    root: model.root,
    counts: model.counts,
  };
}

export async function readMemoryBrowserFile(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  targetPath: string;
}): Promise<MemoryBrowserFileResponse> {
  await ensureWorkspaceMemoryReadModelRepaired({
    store: params.store,
    workspaceId: params.workspaceId,
  });
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

export async function readMemoryBrowserNodeDetail(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  nodeId: string;
  treeId?: string | null;
}): Promise<MemoryBrowserNodeDetailResponse> {
  const workspace = params.store.getWorkspace(params.workspaceId);
  if (!workspace) {
    throw new Error("workspace not found");
  }

  await ensureWorkspaceMemoryReadModelRepaired({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  ensureWorkspaceInteractionSemanticTreesMigrated({
    store: params.store,
    workspaceId: params.workspaceId,
  });

  const requestedTreeId = params.treeId?.trim() || null;
  let matchedNode: ReturnType<RuntimeStateStore["getSemanticMemoryNode"]> | null = null;
  let matchedTreeId = requestedTreeId;

  if (requestedTreeId) {
    matchedNode = params.store.getSemanticMemoryNode({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: requestedTreeId,
      nodeId: params.nodeId,
    });
  } else {
    for (const descriptor of browserTreeDescriptors({
      store: params.store,
      workspaceId: params.workspaceId,
    })) {
      const node = params.store.getSemanticMemoryNode({
        category: "workspace",
        workspaceId: params.workspaceId,
        treeId: descriptor.treeId,
        nodeId: params.nodeId,
      });
      if (node) {
        matchedNode = node;
        matchedTreeId = descriptor.treeId;
        break;
      }
    }
  }

  const syntheticDescriptor = matchedNode
    ? null
    : syntheticRelatedNodeDetailDescriptor({
      store: params.store,
      workspaceId: params.workspaceId,
      nodeId: params.nodeId,
    });

  const evidenceRefs = matchedTreeId
    ? params.store.listSemanticMemoryEvidenceRefs({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: matchedTreeId,
      nodeId: params.nodeId,
      limit: 100,
      offset: 0,
    }).map((ref) => ({
      ref_id: ref.refId,
      provider: ref.provider,
      account_namespace: ref.accountNamespace,
      connection_id: ref.connectionId,
      external_object_id: ref.externalObjectId,
      external_object_type: ref.externalObjectType,
      source_type: ref.sourceType,
      source_event_id: ref.sourceEventId,
      source_message_id: ref.sourceMessageId,
      source_turn_input_id: ref.sourceTurnInputId,
      observed_at: ref.observedAt,
      metadata: ref.metadata ?? {},
    }))
    : [];

  const outgoingRelations: MemoryBrowserNodeRelation[] = [];
  const incomingRelations: MemoryBrowserNodeRelation[] = [];
  for (const descriptor of browserTreeDescriptors({
    store: params.store,
    workspaceId: params.workspaceId,
  })) {
    for (const relation of params.store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: params.workspaceId,
      treeId: descriptor.treeId,
      limit: 10_000,
      offset: 0,
    })) {
      if (relation.fromNodeId === params.nodeId) {
        const targetTreeId = metadataString(relation.metadata, "target_tree_id");
        const targetNodeId = metadataString(relation.metadata, "target_node_id");
        const targetNode = targetTreeId && targetNodeId
          ? params.store.getSemanticMemoryNode({
            category: "workspace",
            workspaceId: params.workspaceId,
            treeId: targetTreeId,
            nodeId: targetNodeId,
          })
          : null;
        outgoingRelations.push({
          relation_type: relation.relationType,
          source_node_id: relation.fromNodeId,
          source_label: matchedNode?.title ?? null,
          source_tree_id: matchedTreeId,
          target_node_id: relation.toNodeId,
          target_label: targetNode?.title ?? relationLabelFromMetadata(relation.metadata),
          target_tree_id: targetTreeId,
          target_entity_key: metadataString(relation.metadata, "entity_key"),
          target_resolution_kind: relationResolutionKind({
            metadata: relation.metadata,
            resolvedNodeExists: Boolean(targetNode),
            targetTreeId,
            targetNodeId,
          }),
          metadata: relation.metadata ?? {},
        });
      }
      if (relation.toNodeId === params.nodeId) {
        const targetTreeId = metadataString(relation.metadata, "target_tree_id");
        const targetNodeId = metadataString(relation.metadata, "target_node_id");
        const sourceNode = params.store.getSemanticMemoryNode({
          category: "workspace",
          workspaceId: params.workspaceId,
          treeId: descriptor.treeId,
          nodeId: relation.fromNodeId,
        });
        incomingRelations.push({
          relation_type: relation.relationType,
          source_node_id: relation.fromNodeId,
          source_label: sourceNode?.title ?? null,
          source_tree_id: descriptor.treeId,
          target_node_id: relation.toNodeId,
          target_label: matchedNode?.title ?? syntheticDescriptor?.label ?? relationLabelFromMetadata(relation.metadata),
          target_tree_id: matchedTreeId,
          target_entity_key: metadataString(relation.metadata, "entity_key"),
          target_resolution_kind: relationResolutionKind({
            metadata: relation.metadata,
            resolvedNodeExists: Boolean(matchedNode),
            targetTreeId: targetTreeId || null,
            targetNodeId: targetNodeId || null,
          }),
          metadata: relation.metadata ?? {},
        });
      }
    }
  }

  return {
    workspace_id: params.workspaceId,
    node_id: params.nodeId,
    tree_id: matchedTreeId,
    category: "workspace",
    kind: matchedNode ? semanticBrowserNodeKind(matchedNode) : syntheticDescriptor?.kind ?? null,
    label: matchedNode?.title ?? syntheticDescriptor?.label ?? null,
    subtitle: syntheticDescriptor?.subtitle ?? null,
    path: matchedNode ? browserPathForStoredPath(params.workspaceId, matchedNode.path) : null,
    evidence_refs: evidenceRefs,
    outgoing_relations: outgoingRelations,
    incoming_relations: incomingRelations,
  };
}

export async function buildMemoryBrowserGraph(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  forest: MemoryBrowserGraphForest;
  treeId?: string | null;
  maxLayers?: number | null;
  maxNodes?: number | null;
}): Promise<MemoryBrowserGraphResponse> {
  await ensureWorkspaceMemoryReadModelRepaired({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const model = buildVirtualMemoryBrowserModel({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  return buildWorkspaceGraph({
    ...params,
    graphNodePaths: model.graphNodePaths,
  });
}
