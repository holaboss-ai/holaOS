import type {
  IntegrationTreeRecord,
  InteractionEntityRecord,
  RuntimeStateStore,
  SemanticMemoryCategory,
} from "@holaboss/runtime-state-store";

import { createBackgroundTaskMemoryModelClient } from "./background-task-model.js";
import { queryMemoryModelEmbedding } from "./memory-model-client.js";
import { createRecallEmbeddingModelClient } from "./recall-embedding-model.js";
import {
  buildAgentRecalledMemoryContext,
  type AgentRecalledMemoryContext,
  type MemoryRetrievalCategory,
} from "./memory-retrieval-pack.js";
import {
  buildMemoryHybridRetrievalResult,
  type MemoryHybridRetrieveResult,
  type MemoryRetrievalPolicy,
  type WorkspaceMemoryHybridHit,
} from "./memory-hybrid-retrieval.js";
import {
  type IntegrationMemoryRetrieveHit,
} from "./integration-memory.js";
import {
  ensureWorkspaceInteractionSemanticTreesMigrated,
  type InteractionMemoryRetrieveHit,
} from "./interaction-memory.js";
import type { DurableMemoryRelatedEntityType } from "./memory-related-entities.js";
import {
  ensureWorkspaceIntegrationRootsMigrated,
  visibleIntegrationTreesForWorkspace,
} from "./workspace-integration-visibility.js";
import {
  ATTACHMENT_CHUNK_NODE_KIND,
  ensureWorkspaceArtifactRelationsBackfilled,
  IMAGE_URL_CHUNK_NODE_KIND,
  OUTPUT_CHUNK_NODE_KIND,
  TOOL_RESULT_CHUNK_NODE_KIND,
  type WorkspaceAttachmentDocumentTreeDescriptor,
  type WorkspaceImageUrlDocumentTreeDescriptor,
  type WorkspaceOutputDocumentTreeDescriptor,
  type WorkspaceToolResultDocumentTreeDescriptor,
  listWorkspaceAttachmentDocumentTrees,
  listWorkspaceImageUrlDocumentTrees,
  listWorkspaceOutputDocumentTrees,
  listWorkspaceToolResultDocumentTrees,
} from "./workspace-attachment-memory.js";
import { ensureWorkspaceMemoryReadModelRepaired } from "./workspace-memory-repair.js";
import { parseCanonicalWorkspaceEntityKey } from "./workspace-related-entity-keys.js";
import { createWorkspaceRelatedEntityResolverFromStore } from "./workspace-related-entity-resolver-store.js";

export type WorkspaceMemoryCategory = MemoryRetrievalCategory;
export type WorkspaceMemoryRetrieveResult = MemoryHybridRetrieveResult;
type WorkspaceMemorySource = "interaction" | "workspace";
type WorkspaceSemanticCategory = Extract<SemanticMemoryCategory, "interaction" | "integration" | "workspace">;

type WorkspaceInteractionTreeDescriptor = {
  sourceKind: "interaction";
  treeId: string;
  semanticCategory: "workspace";
  entity: InteractionEntityRecord;
};

type WorkspaceIntegrationTreeDescriptor = {
  sourceKind: "integration";
  treeId: string;
  semanticCategory: "workspace";
  tree: IntegrationTreeRecord;
};

type WorkspaceAttachmentTreeDescriptor = {
  sourceKind: "attachment";
  treeId: string;
  semanticCategory: "workspace";
  attachment: WorkspaceAttachmentDocumentTreeDescriptor;
};

type WorkspaceImageUrlTreeDescriptor = {
  sourceKind: "image_url";
  treeId: string;
  semanticCategory: "workspace";
  imageUrlArtifact: WorkspaceImageUrlDocumentTreeDescriptor;
};

type WorkspaceToolResultTreeDescriptor = {
  sourceKind: "tool_result";
  treeId: string;
  semanticCategory: "workspace";
  toolResult: WorkspaceToolResultDocumentTreeDescriptor;
};

type WorkspaceOutputArtifactTreeDescriptor = {
  sourceKind: "output_artifact";
  treeId: string;
  semanticCategory: "workspace";
  outputArtifact: WorkspaceOutputDocumentTreeDescriptor;
};

type WorkspaceTreeDescriptor =
  | WorkspaceInteractionTreeDescriptor
  | WorkspaceIntegrationTreeDescriptor
  | WorkspaceAttachmentTreeDescriptor
  | WorkspaceImageUrlTreeDescriptor
  | WorkspaceToolResultTreeDescriptor
  | WorkspaceOutputArtifactTreeDescriptor;
type WorkspaceSemanticSearchDoc = ReturnType<RuntimeStateStore["listSemanticMemorySearchDocs"]>[number];
type WorkspaceSemanticSearchHit = ReturnType<RuntimeStateStore["searchSemanticMemorySearchDocs"]>[number];
type WorkspaceSemanticNode = NonNullable<ReturnType<RuntimeStateStore["getSemanticMemoryNode"]>>;

export interface WorkspaceMemoryExecutionProfile {
  useEmbeddings?: boolean | null;
  useLlmRerank?: boolean | null;
}

const VECTOR_FIRST_PASS_LIMIT_FLOOR = 8;
const VECTOR_FIRST_PASS_LIMIT_CEILING = 60;
const LEXICAL_SUPPORT_LIMIT_FLOOR = 4;
const LEXICAL_SUPPORT_LIMIT_CEILING = 12;
const LEXICAL_CANDIDATE_POOL_LIMIT = 48;
const DIRECT_LEXICAL_SCAN_PAGE_SIZE = 200;
const DIRECT_LEXICAL_SCAN_MAX_DOCS = 5000;
const RETRIEVAL_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);
const RELATED_ENTITY_TYPES = new Set<DurableMemoryRelatedEntityType>([
  "person",
  "organization",
  "project",
  "workflow",
  "system",
  "topic",
  "issue",
  "artifact",
  "customer",
]);

function normalizeRequestedCategories(value: unknown): WorkspaceMemoryCategory[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const hasExplicitWorkspaceRequest = rawItems.some((item) => {
    const normalized = typeof item === "string" ? item.trim().toLowerCase() : "";
    return normalized === "workspace";
  });
  if (hasExplicitWorkspaceRequest) {
    return ["workspace"];
  }
  return [];
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
}

function textScore(query: string, ...texts: Array<string | null | undefined>): number {
  const normalizedQuery = compactWhitespace(query).toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const haystack = texts.map((item) => compactWhitespace(item ?? "")).join("\n").toLowerCase();
  if (!haystack) {
    return 0;
  }
  let score = 0;
  if (haystack.includes(normalizedQuery)) {
    score += 2;
  }
  const tokens = [...new Set(tokenize(normalizedQuery))];
  if (tokens.length === 0) {
    return score;
  }
  let hitCount = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      hitCount += 1;
    }
  }
  return score + hitCount / Math.max(1, tokens.length);
}

function buildRetrievalFtsMatchQuery(query: string): string | null {
  const rawTokens = [...new Set(tokenize(query))];
  if (rawTokens.length === 0) {
    return null;
  }
  const filteredTokens = rawTokens.filter((token) => !RETRIEVAL_QUERY_STOPWORDS.has(token));
  const tokens = filteredTokens.length > 0 ? filteredTokens : rawTokens;
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `${token}*`).join(" OR ");
}

function directLexicalQueryMatches(params: {
  query: string;
  doc: Pick<WorkspaceSemanticSearchDoc, "title" | "summary" | "bodyText" | "excerpt">;
}): boolean {
  return textScore(
    params.query,
    params.doc.title,
    params.doc.summary,
    params.doc.bodyText,
    params.doc.excerpt ?? "",
  ) > 0;
}

function sortDirectLexicalHits<T extends {
  title: string;
  summary: string;
  excerpt: string | null;
  bodyText: string;
  updatedAt: string;
  path: string;
  nodeId: string;
}>(query: string, docs: T[]): T[] {
  const normalizedQuery = compactWhitespace(query).toLowerCase();
  const directFieldScore = (doc: T): number => {
    const title = compactWhitespace(doc.title).toLowerCase();
    const summary = compactWhitespace(doc.summary).toLowerCase();
    const excerpt = compactWhitespace(doc.excerpt ?? "").toLowerCase();
    const bodyText = compactWhitespace(doc.bodyText).toLowerCase();
    if (title === normalizedQuery) {
      return 6;
    }
    if (summary === normalizedQuery) {
      return 5;
    }
    if (excerpt === normalizedQuery) {
      return 4;
    }
    if (bodyText === normalizedQuery) {
      return 3;
    }
    if (title.includes(normalizedQuery)) {
      return 2;
    }
    if (summary.includes(normalizedQuery)) {
      return 1.5;
    }
    if (excerpt.includes(normalizedQuery)) {
      return 1.25;
    }
    if (bodyText.includes(normalizedQuery)) {
      return 1;
    }
    return 0;
  };
  return [...docs].sort((left, right) =>
    directFieldScore(right) - directFieldScore(left)
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.path.localeCompare(right.path)
    || left.nodeId.localeCompare(right.nodeId)
  );
}

function lexicalRankBoost(rank: number | null | undefined): number {
  if (!rank || !Number.isFinite(rank) || rank < 1) {
    return 0;
  }
  return 1.4 / Math.sqrt(rank);
}

function providerHintText(provider: string | null | undefined): string {
  switch ((provider ?? "").trim().toLowerCase()) {
    case "gmail":
    case "outlook":
      return "email emails inbox mail mailbox thread threads message messages";
    case "github":
      return "repository repositories repo repos issue issues pull request requests pr prs code";
    case "notion":
      return "document documents docs page pages database databases notes workspace";
    case "slack":
      return "chat chats message messages channel channels workspace thread threads";
    case "googlecalendar":
    case "calendar":
      return "calendar calendars event events meeting meetings schedule";
    case "googledrive":
    case "drive":
      return "drive file files folder folders document documents";
    default:
      return "";
  }
}

function retrievalNodeClassForMode(mode: "mixed" | "summaries" | "leaves"): "leaf" | "semantic" | undefined {
  if (mode === "leaves") {
    return "leaf";
  }
  if (mode === "summaries") {
    return "semantic";
  }
  return undefined;
}

function sortWorkspaceSemanticSearchHits<T extends {
  bm25Score: number;
  updatedAt: string;
  path: string;
  nodeId: string;
}>(hits: T[]): T[] {
  return [...hits].sort((left, right) =>
    left.bm25Score - right.bm25Score
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.path.localeCompare(right.path)
    || left.nodeId.localeCompare(right.nodeId)
  );
}

function sortWorkspaceSemanticDocsByRecency<T extends {
  updatedAt: string;
  path: string;
  nodeId: string;
}>(docs: T[]): T[] {
  return [...docs].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
    || left.path.localeCompare(right.path)
    || left.nodeId.localeCompare(right.nodeId)
  );
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function integrationVectorNodeKind(node: NonNullable<ReturnType<RuntimeStateStore["getSemanticMemoryNode"]>>):
  "tree" | "entity" | "branch" | "summary" | "leaf" {
  if (node.nodeClass === "leaf") {
    return "leaf";
  }
  if (node.nodeKind === "connection") {
    return "tree";
  }
  if (new Set(["workspace", "repo", "thread", "page", "database", "contact", "file", "folder", "post", "calendar"]).has(node.nodeKind)) {
    return "entity";
  }
  return "branch";
}

function integrationDocNodeKind(doc: {
  nodeClass: string;
  nodeKind: string;
}): "tree" | "entity" | "branch" | "summary" | "leaf" {
  if (doc.nodeClass === "leaf") {
    return "leaf";
  }
  if (doc.nodeKind === "connection") {
    return "tree";
  }
  if (new Set(["workspace", "repo", "thread", "page", "database", "contact", "file", "folder", "post", "calendar"]).has(doc.nodeKind)) {
    return "entity";
  }
  return "branch";
}

function artifactDocNodeKind(doc: {
  nodeClass: string;
  nodeKind: string;
}): "entity" | "leaf" {
  if (
    doc.nodeClass === "leaf"
    || doc.nodeKind === ATTACHMENT_CHUNK_NODE_KIND
    || doc.nodeKind === IMAGE_URL_CHUNK_NODE_KIND
    || doc.nodeKind === OUTPUT_CHUNK_NODE_KIND
    || doc.nodeKind === TOOL_RESULT_CHUNK_NODE_KIND
  ) {
    return "leaf";
  }
  return "entity";
}

function workspaceTreeKey(category: WorkspaceSemanticCategory, treeId: string): string {
  return `${category}:${treeId}`;
}

function workspaceNodeKey(category: WorkspaceSemanticCategory, treeId: string, nodeId: string): string {
  return `${category}:${treeId}:${nodeId}`;
}

function listWorkspaceInteractionTreeDescriptors(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  allowedTreeIds: ReadonlySet<string>;
}): WorkspaceInteractionTreeDescriptor[] {
  ensureWorkspaceInteractionSemanticTreesMigrated({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  return params.store.listInteractionEntities({
    workspaceId: params.workspaceId,
    status: "active",
    includeSystem: true,
    limit: 10_000,
    offset: 0,
  })
    .filter((entity) => params.allowedTreeIds.size === 0 || params.allowedTreeIds.has(entity.entityId))
    .map((entity) => ({
      sourceKind: "interaction" as const,
      treeId: entity.entityId,
      semanticCategory: "workspace" as const,
      entity,
    }));
}

function listWorkspaceIntegrationTreeDescriptors(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  allowedTreeIds: ReadonlySet<string>;
}): WorkspaceIntegrationTreeDescriptor[] {
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
  })
    .filter((tree) => params.allowedTreeIds.size === 0 || params.allowedTreeIds.has(tree.treeId))
    .map((tree) => ({
      sourceKind: "integration" as const,
      treeId: tree.treeId,
      semanticCategory: "workspace" as const,
      tree,
    }));
}

function listWorkspaceAttachmentTreeDescriptors(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  allowedTreeIds: ReadonlySet<string>;
}): WorkspaceAttachmentTreeDescriptor[] {
  return listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
    allowedTreeIds: params.allowedTreeIds,
  }).map((attachment) => ({
    sourceKind: "attachment" as const,
    treeId: attachment.treeId,
    semanticCategory: "workspace" as const,
    attachment,
  }));
}

function listWorkspaceImageUrlTreeDescriptors(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  allowedTreeIds: ReadonlySet<string>;
}): WorkspaceImageUrlTreeDescriptor[] {
  return listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
    allowedTreeIds: params.allowedTreeIds,
  }).map((imageUrlArtifact) => ({
    sourceKind: "image_url" as const,
    treeId: imageUrlArtifact.treeId,
    semanticCategory: "workspace" as const,
    imageUrlArtifact,
  }));
}

function listWorkspaceToolResultTreeDescriptors(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  allowedTreeIds: ReadonlySet<string>;
}): WorkspaceToolResultTreeDescriptor[] {
  return listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
    allowedTreeIds: params.allowedTreeIds,
  }).map((toolResult) => ({
    sourceKind: "tool_result" as const,
    treeId: toolResult.treeId,
    semanticCategory: "workspace" as const,
    toolResult,
  }));
}

function listWorkspaceOutputArtifactTreeDescriptors(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  allowedTreeIds: ReadonlySet<string>;
}): WorkspaceOutputArtifactTreeDescriptor[] {
  return listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
    allowedTreeIds: params.allowedTreeIds,
  }).map((outputArtifact) => ({
    sourceKind: "output_artifact" as const,
    treeId: outputArtifact.treeId,
    semanticCategory: "workspace" as const,
    outputArtifact,
  }));
}

function descriptorProviderAccountNamespace(
  descriptor: WorkspaceTreeDescriptor,
): { provider: string | null; accountNamespace: string | null } {
  if (descriptor.sourceKind === "integration") {
    return {
      provider: descriptor.tree.provider,
      accountNamespace: descriptor.tree.accountNamespace,
    };
  }
  if (descriptor.sourceKind === "tool_result") {
    return {
      provider: descriptor.toolResult.providerId,
      accountNamespace: descriptor.toolResult.accountNamespace,
    };
  }
  return {
    provider: null,
    accountNamespace: null,
  };
}

function descriptorEntityInfo(
  descriptor: WorkspaceTreeDescriptor,
): { entityName: string | null; entityType: string | null } {
  if (descriptor.sourceKind === "interaction") {
    return {
      entityName: descriptor.entity.canonicalName,
      entityType: descriptor.entity.entityType,
    };
  }
  if (descriptor.sourceKind === "attachment") {
    return {
      entityName: descriptor.attachment.title,
      entityType: "artifact",
    };
  }
  if (descriptor.sourceKind === "image_url") {
    return {
      entityName: descriptor.imageUrlArtifact.title,
      entityType: "artifact",
    };
  }
  if (descriptor.sourceKind === "tool_result") {
    return {
      entityName: descriptor.toolResult.title,
      entityType: "artifact",
    };
  }
  if (descriptor.sourceKind === "output_artifact") {
    return {
      entityName: descriptor.outputArtifact.title,
      entityType: "artifact",
    };
  }
  return {
    entityName: null,
    entityType: null,
  };
}

function providerBackedProvenanceForSemanticNode(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  category: WorkspaceSemanticCategory;
  treeId: string;
  nodeId: string;
}): { provider: string | null; accountNamespace: string | null } {
  const node = params.store.getSemanticMemoryNode({
    category: params.category,
    workspaceId: params.workspaceId,
    treeId: params.treeId,
    nodeId: params.nodeId,
  });
  const nodeMetadata = node?.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)
    ? node.metadata as Record<string, unknown>
    : null;
  if (typeof (params.store as { listSemanticMemoryEvidenceRefs?: unknown }).listSemanticMemoryEvidenceRefs !== "function") {
    return {
      provider: metadataTextValue(nodeMetadata?.provider) || metadataTextValue(nodeMetadata?.provider_id) || null,
      accountNamespace: metadataTextValue(nodeMetadata?.account_namespace) || null,
    };
  }
  const ref = params.store.listSemanticMemoryEvidenceRefs({
    category: params.category,
    workspaceId: params.workspaceId,
    treeId: params.treeId,
    nodeId: params.nodeId,
    limit: 12,
    offset: 0,
  }).find((candidate) =>
    typeof candidate.provider === "string"
    && candidate.provider.trim().length > 0
    && typeof candidate.accountNamespace === "string"
    && candidate.accountNamespace.trim().length > 0,
  ) ?? null;
  const provider = ref?.provider
    ?? metadataTextValue(nodeMetadata?.provider)
    ?? metadataTextValue(nodeMetadata?.provider_id);
  const accountNamespace = ref?.accountNamespace
    ?? metadataTextValue(nodeMetadata?.account_namespace);
  return {
    provider: provider || null,
    accountNamespace: accountNamespace || null,
  };
}

function metadataTextValue(value: unknown): string {
  return typeof value === "string" ? compactWhitespace(value) : "";
}

function relationEntityTypeFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): DurableMemoryRelatedEntityType | null {
  const explicitType = metadataTextValue(metadata?.entity_type);
  if (explicitType && RELATED_ENTITY_TYPES.has(explicitType as DurableMemoryRelatedEntityType)) {
    return explicitType as DurableMemoryRelatedEntityType;
  }
  const entityKey = metadataTextValue(metadata?.entity_key);
  const parsedCanonical = entityKey ? parseCanonicalWorkspaceEntityKey(entityKey) : null;
  if (parsedCanonical) {
    return parsedCanonical.entityType;
  }
  const token = entityKey.split(":", 1)[0]?.trim() ?? "";
  return token && RELATED_ENTITY_TYPES.has(token as DurableMemoryRelatedEntityType)
    ? token as DurableMemoryRelatedEntityType
    : null;
}

function relationResolutionStateForRetrieval(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  category: WorkspaceSemanticCategory;
  metadata: Record<string, unknown> | null | undefined;
  resolvedTargetTreeId?: string | null;
  resolvedTargetNodeId?: string | null;
}): "resolved" | "synthetic" | "missing" | null {
  const metadataKind = metadataTextValue(params.metadata?.resolved_target_kind);
  const metadataTreeId = metadataTextValue(params.metadata?.target_tree_id);
  const metadataNodeId = metadataTextValue(params.metadata?.target_node_id);
  const targetTreeId = metadataTreeId || (params.resolvedTargetTreeId ?? "").trim();
  const targetNodeId = metadataNodeId || (params.resolvedTargetNodeId ?? "").trim();
  if (targetTreeId && targetNodeId) {
    const targetNode = params.store.getSemanticMemoryNode({
      category: params.category,
      workspaceId: params.workspaceId,
      treeId: targetTreeId,
      nodeId: targetNodeId,
    });
    if (targetNode) {
      return "resolved";
    }
  }
  if (
    metadataKind === "resolved"
    || metadataKind === "synthetic"
    || metadataKind === "missing"
  ) {
    return metadataKind;
  }
  if (metadataTreeId || metadataNodeId) {
    return "missing";
  }
  if (params.resolvedTargetTreeId || params.resolvedTargetNodeId) {
    return "synthetic";
  }
  return null;
}

function semanticRelationContext(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  category: WorkspaceSemanticCategory;
  treeId: string;
  nodeId: string;
  maxDepth?: number;
  resolver?: ReturnType<typeof createWorkspaceRelatedEntityResolverFromStore> | null;
}): {
  texts: string[];
  provider: string | null;
  accountNamespace: string | null;
  resolvedRelationCount: number;
  recoverableSyntheticRelationCount: number;
  missingRelationCount: number;
} {
  if (typeof (params.store as { listSemanticMemoryRelations?: unknown }).listSemanticMemoryRelations !== "function") {
    return {
      texts: [],
      ...providerBackedProvenanceForSemanticNode(params),
      resolvedRelationCount: 0,
      recoverableSyntheticRelationCount: 0,
      missingRelationCount: 0,
    };
  }
  const texts = new Set<string>();
  const visited = new Set<string>();
  let provider: string | null = null;
  let accountNamespace: string | null = null;
  let resolvedRelationCount = 0;
  let recoverableSyntheticRelationCount = 0;
  let missingRelationCount = 0;
  const maxDepth = Math.max(0, Math.min(params.maxDepth ?? 3, 4));

  const visit = (treeId: string, nodeId: string, depth: number): void => {
    const key = `${treeId}|${nodeId}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);

    const directProvenance = providerBackedProvenanceForSemanticNode({
      store: params.store,
      workspaceId: params.workspaceId,
      category: params.category,
      treeId,
      nodeId,
    });
    if (!provider && directProvenance.provider) {
      provider = directProvenance.provider;
    }
    if (!accountNamespace && directProvenance.accountNamespace) {
      accountNamespace = directProvenance.accountNamespace;
    }
    if (directProvenance.provider) {
      texts.add(directProvenance.provider);
    }
    if (directProvenance.accountNamespace) {
      texts.add(directProvenance.accountNamespace);
    }

    const node = params.store.getSemanticMemoryNode({
      category: params.category,
      workspaceId: params.workspaceId,
      treeId,
      nodeId,
    });
    if (node?.title) {
      texts.add(compactWhitespace(node.title));
    }

    for (const relation of params.store.listSemanticMemoryRelations({
      category: params.category,
      workspaceId: params.workspaceId,
      treeId,
      fromNodeId: nodeId,
      limit: 32,
      offset: 0,
    })) {
      texts.add(relation.relationType.replaceAll("_", " "));
      const entityLabel = metadataTextValue(relation.metadata?.entity_label);
      const entityKey = metadataTextValue(relation.metadata?.entity_key);
      const entityType = metadataTextValue(relation.metadata?.entity_type);
      if (entityLabel) {
        texts.add(entityLabel);
      }
      if (entityKey) {
        texts.add(entityKey);
      }
      if (entityType) {
        texts.add(entityType);
      }
      const relationEntityType = relationEntityTypeFromMetadata(relation.metadata);
      const resolverLabel = entityLabel || entityKey;
      const resolved = params.resolver && relationEntityType && resolverLabel
        ? params.resolver.resolve({
          entityType: relationEntityType,
          label: resolverLabel,
          entityKey: entityKey || null,
        })
        : null;
      if (resolved) {
        for (const aliasText of resolved.aliasTexts) {
          texts.add(aliasText);
        }
      }
      const resolvedTargetKind = relationResolutionStateForRetrieval({
        store: params.store,
        workspaceId: params.workspaceId,
        category: params.category,
        metadata: relation.metadata,
        resolvedTargetTreeId: resolved?.targetTreeId ?? null,
        resolvedTargetNodeId: resolved?.targetNodeId ?? null,
      });
      if (resolvedTargetKind === "resolved") {
        resolvedRelationCount += 1;
      } else if (resolvedTargetKind === "missing") {
        missingRelationCount += 1;
      } else if (resolvedTargetKind === "synthetic" && resolved) {
        recoverableSyntheticRelationCount += 1;
      }
      if (depth >= maxDepth) {
        continue;
      }
      const targetTreeId = metadataTextValue(relation.metadata?.target_tree_id)
        || resolved?.targetTreeId
        || "";
      const targetNodeId = metadataTextValue(relation.metadata?.target_node_id)
        || resolved?.targetNodeId
        || "";
      if (targetTreeId && targetNodeId) {
        visit(targetTreeId, targetNodeId, depth + 1);
      }
    }
  };

  visit(params.treeId, params.nodeId, 0);
  return {
    texts: [...texts],
    provider,
    accountNamespace,
    resolvedRelationCount,
    recoverableSyntheticRelationCount,
    missingRelationCount,
  };
}

function relationTextsForSemanticNode(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  category: WorkspaceSemanticCategory;
  treeId: string;
  nodeId: string;
}): string[] {
  return semanticRelationContext(params).texts;
}

function interactionHitToWorkspaceHybridHit(
  hit: InteractionMemoryRetrieveHit,
): WorkspaceMemoryHybridHit {
  return {
    node_kind: hit.node_kind,
    node_id: hit.node_id,
    tree_id: hit.tree_id,
    title: hit.title,
    summary: hit.summary,
    excerpt: hit.excerpt,
    observed_at: hit.observed_at,
    updated_at: hit.updated_at,
    score: hit.score,
    reasons: [...hit.reasons],
    entity_name: hit.entity_name,
    entity_type: hit.entity_type,
    provider: null,
    account_namespace: null,
  };
}

function integrationHitToWorkspaceHybridHit(
  hit: IntegrationMemoryRetrieveHit,
): WorkspaceMemoryHybridHit {
  return {
    node_kind: hit.node_kind,
    node_id: hit.node_id,
    tree_id: hit.tree_id,
    title: hit.title,
    summary: hit.summary,
    excerpt: hit.excerpt,
    observed_at: hit.observed_at,
    updated_at: hit.updated_at,
    score: hit.score,
    reasons: [...hit.reasons],
    entity_name: null,
    entity_type: null,
    provider: hit.provider,
    account_namespace: hit.account_namespace,
  };
}

function workspaceHitFromSearchDoc(params: {
  descriptor: WorkspaceTreeDescriptor;
  doc: ReturnType<RuntimeStateStore["listSemanticMemorySearchDocs"]>[number];
  provider: string | null;
  accountNamespace: string | null;
  score: number;
  reasons: string[];
}): WorkspaceMemoryHybridHit {
  const entity = descriptorEntityInfo(params.descriptor);
  const providerAccount = descriptorProviderAccountNamespace(params.descriptor);
  return {
    node_kind: params.descriptor.sourceKind === "interaction"
      ? (params.doc.nodeClass === "leaf" ? "leaf" : "summary")
      : params.descriptor.sourceKind === "attachment"
        || params.descriptor.sourceKind === "image_url"
        || params.descriptor.sourceKind === "tool_result"
        || params.descriptor.sourceKind === "output_artifact"
        ? artifactDocNodeKind(params.doc)
        : integrationDocNodeKind(params.doc),
    node_id: params.doc.nodeId,
    tree_id: params.descriptor.treeId,
    title: params.doc.title,
    summary: params.doc.summary,
    excerpt: params.doc.excerpt,
    path: params.doc.path,
    level: null,
    child_count: params.doc.childCount,
    observed_at: params.doc.observedAt,
    updated_at: params.doc.updatedAt,
    score: Number(params.score.toFixed(3)),
    reasons: [...params.reasons],
    entity_name: entity.entityName,
    entity_type: entity.entityType,
    provider: providerAccount.provider ?? params.provider,
    account_namespace: providerAccount.accountNamespace ?? params.accountNamespace,
  };
}

function workspaceHitFromSemanticNode(params: {
  descriptor: WorkspaceTreeDescriptor;
  node: NonNullable<ReturnType<RuntimeStateStore["getSemanticMemoryNode"]>>;
  provider: string | null;
  accountNamespace: string | null;
  score: number;
  reasons: string[];
}): WorkspaceMemoryHybridHit {
  const entity = descriptorEntityInfo(params.descriptor);
  const providerAccount = descriptorProviderAccountNamespace(params.descriptor);
  return {
    node_kind: params.descriptor.sourceKind === "interaction"
      ? (params.node.nodeClass === "leaf" ? "leaf" : "summary")
      : params.descriptor.sourceKind === "attachment"
        || params.descriptor.sourceKind === "image_url"
        || params.descriptor.sourceKind === "tool_result"
        || params.descriptor.sourceKind === "output_artifact"
        ? artifactDocNodeKind(params.node)
        : integrationVectorNodeKind(params.node),
    node_id: params.node.nodeId,
    tree_id: params.descriptor.treeId,
    title: params.node.title,
    summary: params.node.summary,
    excerpt: null,
    path: params.node.path,
    level: null,
    child_count: params.node.childCount,
    observed_at: params.node.observedAt,
    updated_at: params.node.updatedAt,
    score: Number(params.score.toFixed(3)),
    reasons: [...params.reasons],
    entity_name: entity.entityName,
    entity_type: entity.entityType,
    provider: providerAccount.provider ?? params.provider,
    account_namespace: providerAccount.accountNamespace ?? params.accountNamespace,
  };
}

async function queryWorkspaceEmbeddingVector(params: {
  workspaceId: string;
  query: string;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
}): Promise<{ modelId: string; vector: number[] } | null> {
  const client = createRecallEmbeddingModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId ?? `workspace-memory-retrieve:${params.workspaceId}`,
    inputId: params.inputId ?? `workspace-memory-retrieve:${params.workspaceId}`,
    selectedModel: params.selectedModel ?? null,
  });
  if (!client) {
    return null;
  }
  const embedding = await queryMemoryModelEmbedding(client, {
    purpose: "query",
    input: params.query,
    timeoutMs: 7000,
    agentRole: "memory-embedding",
  });
  if (!embedding) {
    return null;
  }
  return {
    modelId: client.modelId,
    vector: Array.from(embedding),
  };
}

function allowedTreeIdSet(treeIds?: string[] | null): Set<string> {
  return new Set(
    (treeIds ?? [])
      .map((item) => compactWhitespace(item))
      .filter(Boolean),
  );
}

function isArtifactSourceKind(
  sourceKind: WorkspaceTreeDescriptor["sourceKind"],
): sourceKind is "attachment" | "image_url" | "tool_result" | "output_artifact" {
  return sourceKind === "attachment"
    || sourceKind === "image_url"
    || sourceKind === "tool_result"
    || sourceKind === "output_artifact";
}

function artifactOrientedQuery(query: string): boolean {
  const normalized = compactWhitespace(query).toLowerCase();
  if (!normalized) {
    return false;
  }
  const withoutEmails = normalized.replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, " ");
  const looksLikeEmailHandle = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
  const looksLikeFileName = /(?:^|[\s(])[^\\/\s]+\.[\p{L}\p{N}]{2,8}(?=$|[\s),])/u.test(withoutEmails);
  return /[\\/]/.test(normalized)
    || (!looksLikeEmailHandle && looksLikeFileName)
    || /\b(file|attachment|artifact|deliverable|report|document|chunk|tool result|output)\b/.test(normalized);
}

function artifactTitleMatchStrength(params: {
  query: string;
  title: string;
}): 0 | 1 | 2 {
  const normalizedQuery = compactWhitespace(params.query).toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const normalizedTitle = compactWhitespace(params.title).toLowerCase();
  if (!normalizedTitle) {
    return 0;
  }
  if (normalizedTitle === normalizedQuery) {
    return 2;
  }
  if (normalizedQuery.length >= 2 && normalizedTitle.includes(normalizedQuery)) {
    return 1;
  }
  return 0;
}

function collectWorkspaceTreeDescriptors(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  categories: WorkspaceMemorySource[];
  treeIds?: string[] | null;
}): WorkspaceTreeDescriptor[] {
  ensureWorkspaceArtifactRelationsBackfilled({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const categories = new Set(params.categories);
  const allowedTreeIds = allowedTreeIdSet(params.treeIds ?? null);
  const descriptors: WorkspaceTreeDescriptor[] = [];
  if (categories.has("interaction")) {
    descriptors.push(...listWorkspaceInteractionTreeDescriptors({
      store: params.store,
      workspaceId: params.workspaceId,
      allowedTreeIds,
    }));
  }
  if (categories.has("workspace")) {
    descriptors.push(...listWorkspaceIntegrationTreeDescriptors({
      store: params.store,
      workspaceId: params.workspaceId,
      allowedTreeIds,
    }));
    descriptors.push(...listWorkspaceAttachmentTreeDescriptors({
      store: params.store,
      workspaceId: params.workspaceId,
      allowedTreeIds,
    }));
    descriptors.push(...listWorkspaceImageUrlTreeDescriptors({
      store: params.store,
      workspaceId: params.workspaceId,
      allowedTreeIds,
    }));
    descriptors.push(...listWorkspaceToolResultTreeDescriptors({
      store: params.store,
      workspaceId: params.workspaceId,
      allowedTreeIds,
    }));
    descriptors.push(...listWorkspaceOutputArtifactTreeDescriptors({
      store: params.store,
      workspaceId: params.workspaceId,
      allowedTreeIds,
    }));
  }
  return descriptors;
}

function scoreWorkspaceLexicalHit(params: {
  sourceKind: WorkspaceTreeDescriptor["sourceKind"];
  query: string;
  nodeKind: WorkspaceMemoryHybridHit["node_kind"];
  title: string;
  summary: string;
  excerpt: string | null;
  relationTexts?: string[] | null;
  updatedAt: string | null;
  entityName?: string | null;
  provider?: string | null;
  accountNamespace?: string | null;
  lexicalRank: number | null;
  resolvedRelationCount?: number | null;
  recoverableSyntheticRelationCount?: number | null;
  missingRelationCount?: number | null;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const hasQuery = params.query.trim().length > 0;
  const providerMatchScore = textScore(
    params.query,
    params.provider ?? null,
    params.accountNamespace ?? null,
    providerHintText(params.provider ?? null),
  );
  let score = textScore(
    params.query,
    params.entityName ?? null,
    params.provider ?? null,
    params.accountNamespace ?? null,
    providerHintText(params.provider ?? null),
    params.title,
    params.summary,
    params.excerpt,
  );
  if (score > 0) {
    reasons.push("lexical_match");
  }
  if (
    params.sourceKind === "interaction"
    && !artifactOrientedQuery(params.query)
    && providerMatchScore > 0
  ) {
    score += Math.max(0.9, providerMatchScore * 0.65);
    reasons.push("provenance_match_boost");
  }
  const relationScore = textScore(params.query, ...(params.relationTexts ?? []));
  if (relationScore > 0) {
    score += relationScore * 0.8;
    reasons.push("relation_match");
    if (params.sourceKind === "interaction" && !artifactOrientedQuery(params.query)) {
      score += 0.85;
      reasons.push("relation_entity_boost");
      score += Math.min(1.1, relationScore * 0.35);
      reasons.push("relation_memory_priority_boost");
    }
    if (
      params.sourceKind === "interaction"
      && !artifactOrientedQuery(params.query)
      && providerMatchScore > 0
    ) {
      score += 1.15;
      reasons.push("provenance_relation_priority_boost");
    }
    if (
      params.sourceKind === "interaction"
      && !artifactOrientedQuery(params.query)
      && (params.resolvedRelationCount ?? 0) > 0
    ) {
      score += Math.min(0.24, (params.resolvedRelationCount ?? 0) * 0.12);
      reasons.push("resolved_relation_boost");
    }
    if (
      params.sourceKind === "interaction"
      && (params.recoverableSyntheticRelationCount ?? 0) > 0
    ) {
      score -= Math.min(0.45, (params.recoverableSyntheticRelationCount ?? 0) * 0.18);
      reasons.push("synthetic_relation_penalty");
    }
    if (
      params.sourceKind === "interaction"
      && (params.missingRelationCount ?? 0) > 0
    ) {
      score -= Math.min(0.24, (params.missingRelationCount ?? 0) * 0.12);
      reasons.push("missing_relation_penalty");
    }
  }
  const lexicalBoost = lexicalRankBoost(params.lexicalRank);
  if (lexicalBoost > 0) {
    score += lexicalBoost;
    reasons.push("fts_bm25");
  }
  const artifactTitleMatch = isArtifactSourceKind(params.sourceKind)
    ? artifactTitleMatchStrength({
        query: params.query,
        title: params.title,
      })
    : 0;
  if (
    isArtifactSourceKind(params.sourceKind)
    && !artifactOrientedQuery(params.query)
    && artifactTitleMatch > 0
  ) {
    score += artifactTitleMatch === 2 ? 5.4 : 1.35;
    reasons.push("artifact_title_match_boost");
  }
  if (isArtifactSourceKind(params.sourceKind) && artifactOrientedQuery(params.query)) {
    score += 1.75;
    reasons.push("artifact_query_boost");
  }
  if (!isArtifactSourceKind(params.sourceKind) && artifactOrientedQuery(params.query)) {
    score -= 0.42;
    reasons.push("artifact_query_penalty");
  }
  if (isArtifactSourceKind(params.sourceKind) && !artifactOrientedQuery(params.query)) {
    score -= 0.22;
  }
  if (params.sourceKind === "tool_result" && !artifactOrientedQuery(params.query)) {
    score -= params.nodeKind === "tool_result_chunk" ? 1.45 : 1.05;
    reasons.push("raw_tool_result_penalty");
  }
  if (params.sourceKind === "interaction" && params.nodeKind === "summary_chunk") {
    score -= 0.28;
    reasons.push("summary_chunk_penalty");
  }
  if (!hasQuery || score > 0) {
    if (params.nodeKind === "leaf") {
      score += 0.08;
    }
    const updatedAt = Date.parse(params.updatedAt ?? "");
    if (Number.isFinite(updatedAt)) {
      score += Math.max(0, 0.15 - ((Date.now() - updatedAt) / (1000 * 60 * 60 * 24 * 30)) * 0.01);
    }
    if (!hasQuery && reasons.length === 0) {
      reasons.push("recent_memory");
    }
  }
  return {
    score: Number(score.toFixed(3)),
    reasons,
  };
}

function listWorkspaceLexicalSupportHits(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  categories: WorkspaceMemorySource[];
  treeIds?: string[] | null;
  maxResults: number;
}): WorkspaceMemoryHybridHit[] {
  const descriptors = collectWorkspaceTreeDescriptors({
    store: params.store,
    workspaceId: params.workspaceId,
    categories: params.categories,
    treeIds: params.treeIds ?? null,
  });
  if (descriptors.length === 0) {
    return [];
  }

  const descriptorByTreeKey = new Map(
    descriptors.map((descriptor) => [
      workspaceTreeKey(descriptor.semanticCategory, descriptor.treeId),
      descriptor,
    ]),
  );
  const descriptorsByCategory = new Map<WorkspaceSemanticCategory, WorkspaceTreeDescriptor[]>();
  for (const descriptor of descriptors) {
    const existing = descriptorsByCategory.get(descriptor.semanticCategory);
    if (existing) {
      existing.push(descriptor);
    } else {
      descriptorsByCategory.set(descriptor.semanticCategory, [descriptor]);
    }
  }

  const nodeClass = retrievalNodeClassForMode("mixed");
  const matchQuery = buildRetrievalFtsMatchQuery(params.query);
  const needsDirectLexicalScan = !matchQuery && compactWhitespace(params.query).length > 0;
  const poolLimit = Math.max(LEXICAL_CANDIDATE_POOL_LIMIT, params.maxResults * 8);
  const recentLimit = Math.max(LEXICAL_CANDIDATE_POOL_LIMIT, params.maxResults * 6);
  const ftsLimit = Math.max(LEXICAL_CANDIDATE_POOL_LIMIT, params.maxResults * 10);
  const lexicalRanksByNodeKey = new Map<string, number>();

  if (matchQuery) {
    const lexicalHits: Array<WorkspaceSemanticSearchHit & { semanticCategory: WorkspaceSemanticCategory }> = [];
    for (const [semanticCategory, categoryDescriptors] of descriptorsByCategory) {
      const treeIds = categoryDescriptors.map((descriptor) => descriptor.treeId);
      for (const hit of params.store.searchSemanticMemorySearchDocs({
        category: semanticCategory,
        workspaceId: params.workspaceId,
        treeIds,
        nodeClass,
        status: "active",
        matchQuery,
        limit: ftsLimit,
        offset: 0,
      })) {
        lexicalHits.push({
          ...hit,
          semanticCategory,
        });
      }
    }
    for (const hit of sortWorkspaceSemanticSearchHits(lexicalHits)) {
      const key = workspaceNodeKey(hit.semanticCategory, hit.treeId, hit.nodeId);
      if (!lexicalRanksByNodeKey.has(key)) {
        lexicalRanksByNodeKey.set(key, lexicalRanksByNodeKey.size + 1);
      }
    }
  }

  const directLexicalHitsByCategory = new Map<WorkspaceSemanticCategory, WorkspaceSemanticSearchDoc[]>();
  if (needsDirectLexicalScan) {
    for (const [semanticCategory, categoryDescriptors] of descriptorsByCategory) {
      const treeIds = categoryDescriptors.map((descriptor) => descriptor.treeId);
      const directHits: WorkspaceSemanticSearchDoc[] = [];
      let offset = 0;
      let scanned = 0;
      while (scanned < DIRECT_LEXICAL_SCAN_MAX_DOCS) {
        const docs = params.store.listSemanticMemorySearchDocs({
          category: semanticCategory,
          workspaceId: params.workspaceId,
          treeIds,
          nodeClass,
          status: "active",
          limit: DIRECT_LEXICAL_SCAN_PAGE_SIZE,
          offset,
        });
        if (docs.length === 0) {
          break;
        }
        scanned += docs.length;
        for (const doc of docs) {
          if (directLexicalQueryMatches({
            query: params.query,
            doc,
          })) {
            directHits.push(doc);
          }
        }
        if (docs.length < DIRECT_LEXICAL_SCAN_PAGE_SIZE) {
          break;
        }
        offset += DIRECT_LEXICAL_SCAN_PAGE_SIZE;
      }
      const sortedDirectHits = sortDirectLexicalHits(params.query, directHits);
      directLexicalHitsByCategory.set(semanticCategory, sortedDirectHits);
      for (const doc of sortedDirectHits) {
        const key = workspaceNodeKey(semanticCategory, doc.treeId, doc.nodeId);
        if (!lexicalRanksByNodeKey.has(key)) {
          lexicalRanksByNodeKey.set(key, lexicalRanksByNodeKey.size + 1);
        }
      }
    }
  }

  const docsByNodeKey = new Map<string, {
    descriptor: WorkspaceTreeDescriptor;
    semanticCategory: WorkspaceSemanticCategory;
    doc: WorkspaceSemanticSearchDoc;
  }>();
  const treesWithDocs = new Set<string>();
  const addDocs = (semanticCategory: WorkspaceSemanticCategory, docs: WorkspaceSemanticSearchDoc[]) => {
    for (const doc of docs) {
      const descriptor = descriptorByTreeKey.get(workspaceTreeKey(semanticCategory, doc.treeId));
      if (!descriptor) {
        continue;
      }
      const key = workspaceNodeKey(semanticCategory, doc.treeId, doc.nodeId);
      if (!docsByNodeKey.has(key)) {
        docsByNodeKey.set(key, {
          descriptor,
          semanticCategory,
          doc,
        });
      }
      treesWithDocs.add(workspaceTreeKey(semanticCategory, doc.treeId));
      if (docsByNodeKey.size >= poolLimit) {
        break;
      }
    }
  };

  if (matchQuery) {
    for (const [semanticCategory, categoryDescriptors] of descriptorsByCategory) {
      const treeIds = categoryDescriptors.map((descriptor) => descriptor.treeId);
      addDocs(
        semanticCategory,
        sortWorkspaceSemanticSearchHits(params.store.searchSemanticMemorySearchDocs({
          category: semanticCategory,
          workspaceId: params.workspaceId,
          treeIds,
          nodeClass,
          status: "active",
          matchQuery,
          limit: ftsLimit,
          offset: 0,
        })),
      );
    }
  }
  if (needsDirectLexicalScan) {
    for (const [semanticCategory, docs] of directLexicalHitsByCategory) {
      addDocs(semanticCategory, docs);
    }
  }

  for (const [semanticCategory, categoryDescriptors] of descriptorsByCategory) {
    const treeIds = categoryDescriptors.map((descriptor) => descriptor.treeId);
    addDocs(
      semanticCategory,
      sortWorkspaceSemanticDocsByRecency(params.store.listSemanticMemorySearchDocs({
        category: semanticCategory,
        workspaceId: params.workspaceId,
        treeIds,
        nodeClass,
        status: "active",
        limit: matchQuery ? recentLimit : poolLimit,
        offset: 0,
      })),
    );
  }

  const relationContextByNodeKey = new Map<string, {
    provider: string | null;
    accountNamespace: string | null;
    texts: string[];
    resolvedRelationCount: number;
    recoverableSyntheticRelationCount: number;
    missingRelationCount: number;
  }>();
  const relatedEntityResolver = createWorkspaceRelatedEntityResolverFromStore({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const relationContextFor = (
    descriptor: WorkspaceInteractionTreeDescriptor,
    nodeId: string,
  ) => {
    const key = workspaceNodeKey(descriptor.semanticCategory, descriptor.treeId, nodeId);
    const cached = relationContextByNodeKey.get(key);
    if (cached) {
      return cached;
    }
    const context = semanticRelationContext({
      store: params.store,
      workspaceId: params.workspaceId,
      category: descriptor.semanticCategory,
      treeId: descriptor.treeId,
      nodeId,
      resolver: relatedEntityResolver,
    });
    relationContextByNodeKey.set(key, context);
    return context;
  };

  const hits: WorkspaceMemoryHybridHit[] = [];
  for (const entry of docsByNodeKey.values()) {
    if (entry.descriptor.sourceKind === "integration" && integrationDocNodeKind(entry.doc) === "tree") {
      continue;
    }
    const entity = descriptorEntityInfo(entry.descriptor);
    const interactionContext = entry.descriptor.sourceKind === "interaction"
      ? relationContextFor(entry.descriptor, entry.doc.nodeId)
      : null;
    const provenance = interactionContext
      ? {
          provider: interactionContext.provider,
          accountNamespace: interactionContext.accountNamespace,
        }
      : descriptorProviderAccountNamespace(entry.descriptor);
    const scored = scoreWorkspaceLexicalHit({
      sourceKind: entry.descriptor.sourceKind,
      query: params.query,
      nodeKind: entry.descriptor.sourceKind === "interaction"
        ? (entry.doc.nodeClass === "leaf" ? "leaf" : "summary")
        : entry.descriptor.sourceKind === "attachment"
          || entry.descriptor.sourceKind === "image_url"
          || entry.descriptor.sourceKind === "tool_result"
          || entry.descriptor.sourceKind === "output_artifact"
          ? artifactDocNodeKind(entry.doc)
          : integrationDocNodeKind(entry.doc),
      title: entry.doc.title,
      summary: entry.doc.summary,
      excerpt: entry.doc.excerpt,
      relationTexts: entry.descriptor.sourceKind === "interaction"
        ? interactionContext?.texts ?? []
        : null,
      updatedAt: entry.doc.updatedAt,
      entityName: entity.entityName,
      provider: provenance.provider,
      accountNamespace: provenance.accountNamespace,
      lexicalRank: lexicalRanksByNodeKey.get(
        workspaceNodeKey(entry.semanticCategory, entry.doc.treeId, entry.doc.nodeId),
      ) ?? null,
      resolvedRelationCount: interactionContext?.resolvedRelationCount ?? null,
      recoverableSyntheticRelationCount: interactionContext?.recoverableSyntheticRelationCount ?? null,
      missingRelationCount: interactionContext?.missingRelationCount ?? null,
    });
    hits.push(workspaceHitFromSearchDoc({
      descriptor: entry.descriptor,
      doc: entry.doc,
      provider: provenance.provider,
      accountNamespace: provenance.accountNamespace,
      score: scored.score,
      reasons: scored.reasons,
    }));
  }

  for (const descriptor of descriptors) {
    const treeKey = workspaceTreeKey(descriptor.semanticCategory, descriptor.treeId);
    if (treesWithDocs.has(treeKey)) {
      continue;
    }
    const nodes = params.store.listSemanticMemoryNodes({
      category: descriptor.semanticCategory,
      workspaceId: params.workspaceId,
      treeId: descriptor.treeId,
      nodeClass,
      status: "active",
      limit: poolLimit,
      offset: 0,
    });
    for (const node of nodes) {
      if (descriptor.sourceKind === "integration" && integrationVectorNodeKind(node) === "tree") {
        continue;
      }
      const entity = descriptorEntityInfo(descriptor);
      const interactionContext = descriptor.sourceKind === "interaction"
        ? relationContextFor(descriptor, node.nodeId)
        : null;
      const provenance = interactionContext
        ? {
            provider: interactionContext.provider,
            accountNamespace: interactionContext.accountNamespace,
          }
        : descriptorProviderAccountNamespace(descriptor);
      const scored = scoreWorkspaceLexicalHit({
        sourceKind: descriptor.sourceKind,
        query: params.query,
        nodeKind: descriptor.sourceKind === "interaction"
          ? (node.nodeClass === "leaf" ? "leaf" : "summary")
          : descriptor.sourceKind === "attachment"
            || descriptor.sourceKind === "image_url"
            || descriptor.sourceKind === "tool_result"
            || descriptor.sourceKind === "output_artifact"
            ? artifactDocNodeKind(node)
            : integrationVectorNodeKind(node),
        title: node.title,
        summary: node.summary,
        excerpt: node.summary,
        relationTexts: descriptor.sourceKind === "interaction"
          ? interactionContext?.texts ?? []
          : null,
        updatedAt: node.updatedAt,
        entityName: entity.entityName,
        provider: provenance.provider,
        accountNamespace: provenance.accountNamespace,
        lexicalRank: lexicalRanksByNodeKey.get(
          workspaceNodeKey(descriptor.semanticCategory, descriptor.treeId, node.nodeId),
        ) ?? null,
        resolvedRelationCount: interactionContext?.resolvedRelationCount ?? null,
        recoverableSyntheticRelationCount: interactionContext?.recoverableSyntheticRelationCount ?? null,
        missingRelationCount: interactionContext?.missingRelationCount ?? null,
      });
      hits.push(workspaceHitFromSemanticNode({
        descriptor,
        node,
        provider: provenance.provider,
        accountNamespace: provenance.accountNamespace,
        score: scored.score,
        reasons: scored.reasons,
      }));
    }
  }

  return hits
    .sort((left, right) =>
      right.score - left.score
      || (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
      || left.title.localeCompare(right.title)
      || left.node_id.localeCompare(right.node_id)
    )
    .slice(0, Math.max(params.maxResults * 4, 16));
}

export async function buildWorkspaceVectorFirstPassHits(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  categories: WorkspaceMemorySource[];
  treeIds?: string[] | null;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  maxCandidates: number;
}): Promise<{
  modelId: string | null;
  interactionHits: InteractionMemoryRetrieveHit[];
  integrationHits: IntegrationMemoryRetrieveHit[];
  attachmentHits: WorkspaceMemoryHybridHit[];
}> {
  const embeddingQuery = await queryWorkspaceEmbeddingVector({
    workspaceId: params.workspaceId,
    query: params.query,
    selectedModel: params.selectedModel ?? null,
    sessionId: params.sessionId ?? null,
    inputId: params.inputId ?? null,
  });
  if (!embeddingQuery) {
    return {
      modelId: null,
      interactionHits: [],
      integrationHits: [],
      attachmentHits: [],
    };
  }

  const categories = new Set(params.categories);
  const allowedTreeIds = allowedTreeIdSet(params.treeIds ?? null);
  if (categories.has("interaction")) {
    ensureWorkspaceInteractionSemanticTreesMigrated({
      store: params.store,
      workspaceId: params.workspaceId,
    });
  }
  const interactionEntities = categories.has("interaction")
    ? new Map(
        params.store.listInteractionEntities({
          workspaceId: params.workspaceId,
          status: "active",
          includeSystem: true,
          limit: 10_000,
          offset: 0,
        }).map((entity) => [entity.entityId, entity]),
      )
    : new Map();
  if (categories.has("workspace")) {
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
  }
  const integrationTrees = categories.has("workspace")
    ? new Map(
        visibleIntegrationTreesForWorkspace({
          store: params.store,
          workspaceId: params.workspaceId,
        }).map((tree) => [tree.treeId, tree]),
      )
    : new Map();
  const attachmentTrees = categories.has("workspace")
    ? new Map(
        listWorkspaceAttachmentDocumentTrees({
          store: params.store,
          workspaceId: params.workspaceId,
          allowedTreeIds,
        }).map((attachment) => [attachment.treeId, attachment]),
      )
    : new Map();
  const imageUrlTrees = categories.has("workspace")
    ? new Map(
        listWorkspaceImageUrlDocumentTrees({
          store: params.store,
          workspaceId: params.workspaceId,
          allowedTreeIds,
        }).map((imageUrlArtifact) => [imageUrlArtifact.treeId, imageUrlArtifact]),
      )
    : new Map();
  const toolResultTrees = categories.has("workspace")
    ? new Map(
        listWorkspaceToolResultDocumentTrees({
          store: params.store,
          workspaceId: params.workspaceId,
          allowedTreeIds,
        }).map((toolResult) => [toolResult.treeId, toolResult]),
      )
    : new Map();
  const outputArtifactTrees = categories.has("workspace")
    ? new Map(
        listWorkspaceOutputDocumentTrees({
          store: params.store,
          workspaceId: params.workspaceId,
          allowedTreeIds,
        }).map((outputArtifact) => [outputArtifact.treeId, outputArtifact]),
      )
    : new Map();

  const interactionHits: InteractionMemoryRetrieveHit[] = [];
  if (categories.has("interaction")) {
    const scored = params.store
      .listInteractionNodeEmbeddings({
        workspaceId: params.workspaceId,
        embeddingModel: embeddingQuery.modelId,
      })
      .map((record) => {
        if (allowedTreeIds.size > 0 && !allowedTreeIds.has(record.entityId)) {
          return null;
        }
        const entity = interactionEntities.get(record.entityId);
        if (!entity) {
          return null;
        }
        const node = params.store.getSemanticMemoryNode({
          category: "workspace",
          workspaceId: params.workspaceId,
          treeId: record.entityId,
          nodeId: record.nodeId,
        });
        if (!node || node.status !== "active") {
          return null;
        }
        const similarity = cosineSimilarity(record.vector, embeddingQuery.vector);
        if (similarity <= 0) {
          return null;
        }
        return {
          similarity,
          hit: {
            node_kind: node.nodeClass === "leaf" ? "leaf" : "summary",
            node_id: node.nodeId,
            tree_id: entity.entityId,
            entity_id: entity.entityId,
            entity_name: entity.canonicalName,
            entity_type: entity.entityType,
            path: node.path,
            title: node.title,
            summary: node.summary,
            excerpt: null,
            level: null,
            child_count: node.childCount,
            observed_at: node.observedAt,
            updated_at: node.updatedAt,
            score: Number((similarity * 4).toFixed(3)),
            reasons: ["embedding_similarity", "vector_first_pass"],
          } satisfies InteractionMemoryRetrieveHit,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => right.similarity - left.similarity || left.hit.title.localeCompare(right.hit.title))
      .slice(0, params.maxCandidates);
    interactionHits.push(...scored.map((entry) => entry.hit));
  }

  const integrationHits: IntegrationMemoryRetrieveHit[] = [];
  const attachmentHits: WorkspaceMemoryHybridHit[] = [];
  if (categories.has("workspace")) {
    const scored = params.store
      // workspace-removal Piece 5.7: integration embeddings are control-plane-only;
      // the store ignores any workspaceId, so it is not threaded.
      .listIntegrationNodeEmbeddings({
        embeddingModel: embeddingQuery.modelId,
      })
      .map((record) => {
        if (allowedTreeIds.size > 0 && !allowedTreeIds.has(record.treeId)) {
          return null;
        }
        const tree = integrationTrees.get(record.treeId);
        const attachment = attachmentTrees.get(record.treeId);
        const imageUrlArtifact = imageUrlTrees.get(record.treeId);
        const toolResult = toolResultTrees.get(record.treeId);
        const outputArtifact = outputArtifactTrees.get(record.treeId);
        if (!tree && !attachment && !imageUrlArtifact && !toolResult && !outputArtifact) {
          return null;
        }
        const node = params.store.getSemanticMemoryNode({
          category: "workspace",
          workspaceId: params.workspaceId,
          treeId: record.treeId,
          nodeId: record.nodeId,
        });
        if (!node || node.status !== "active") {
          return null;
        }
        const kind = attachment || imageUrlArtifact || toolResult || outputArtifact
          ? artifactDocNodeKind(node)
          : integrationVectorNodeKind(node);
        if (kind === "tree") {
          return null;
        }
        const similarity = cosineSimilarity(record.vector, embeddingQuery.vector);
        if (similarity <= 0) {
          return null;
        }
        if (attachment) {
          return {
            similarity,
            sourceKind: "attachment" as const,
            hit: {
              node_kind: kind,
              node_id: node.nodeId,
              tree_id: attachment.treeId,
              title: node.title,
              summary: node.summary,
              excerpt: null,
              path: node.path,
              level: null,
              child_count: node.childCount,
              observed_at: node.observedAt,
              updated_at: node.updatedAt,
              score: Number((similarity * 4).toFixed(3)),
              reasons: ["embedding_similarity", "vector_first_pass"],
              entity_name: null,
              entity_type: null,
              provider: null,
              account_namespace: null,
            } satisfies WorkspaceMemoryHybridHit,
          };
        }
        if (imageUrlArtifact) {
          return {
            similarity,
            sourceKind: "image_url" as const,
            hit: {
              node_kind: kind,
              node_id: node.nodeId,
              tree_id: imageUrlArtifact.treeId,
              title: node.title,
              summary: node.summary,
              excerpt: null,
              path: node.path,
              level: null,
              child_count: node.childCount,
              observed_at: node.observedAt,
              updated_at: node.updatedAt,
              score: Number((similarity * 4).toFixed(3)),
              reasons: ["embedding_similarity", "vector_first_pass"],
              entity_name: null,
              entity_type: null,
              provider: null,
              account_namespace: null,
            } satisfies WorkspaceMemoryHybridHit,
          };
        }
        if (toolResult) {
          return {
            similarity,
            sourceKind: "tool_result" as const,
            hit: {
              node_kind: kind,
              node_id: node.nodeId,
              tree_id: toolResult.treeId,
              title: node.title,
              summary: node.summary,
              excerpt: null,
              path: node.path,
              level: null,
              child_count: node.childCount,
              observed_at: node.observedAt,
              updated_at: node.updatedAt,
              score: Number((similarity * 4).toFixed(3)),
              reasons: ["embedding_similarity", "vector_first_pass"],
              entity_name: null,
              entity_type: null,
              provider: toolResult.providerId,
              account_namespace: toolResult.accountNamespace,
            } satisfies WorkspaceMemoryHybridHit,
          };
        }
        if (outputArtifact) {
          return {
            similarity,
            sourceKind: "output_artifact" as const,
            hit: {
              node_kind: kind,
              node_id: node.nodeId,
              tree_id: outputArtifact.treeId,
              title: node.title,
              summary: node.summary,
              excerpt: null,
              path: node.path,
              level: null,
              child_count: node.childCount,
              observed_at: node.observedAt,
              updated_at: node.updatedAt,
              score: Number((similarity * 4).toFixed(3)),
              reasons: ["embedding_similarity", "vector_first_pass"],
              entity_name: null,
              entity_type: null,
              provider: null,
              account_namespace: null,
            } satisfies WorkspaceMemoryHybridHit,
          };
        }
        return {
          similarity,
          sourceKind: "integration" as const,
          hit: {
            category: "workspace",
            node_kind: kind,
            node_id: node.nodeId,
            tree_id: tree.treeId,
            provider: tree.provider,
            account_namespace: tree.accountNamespace,
            path: node.path,
            title: node.title,
            summary: node.summary,
            excerpt: null,
            level: null,
            child_count: node.childCount,
            observed_at: node.observedAt,
            updated_at: node.updatedAt,
            score: Number((similarity * 4).toFixed(3)),
            reasons: ["embedding_similarity", "vector_first_pass"],
          } satisfies IntegrationMemoryRetrieveHit,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((left, right) => right.similarity - left.similarity || left.hit.title.localeCompare(right.hit.title))
      .slice(0, params.maxCandidates);
    for (const entry of scored) {
      if (entry.sourceKind === "integration") {
        integrationHits.push(entry.hit);
      } else {
        attachmentHits.push(entry.hit);
      }
    }
  }

  return {
    modelId: embeddingQuery.modelId,
    interactionHits,
    integrationHits,
    attachmentHits,
  };
}

export function planWorkspaceMemoryCategories(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  requestedCategories?: unknown;
  treeId?: string | null;
}): WorkspaceMemorySource[] {
  const explicit = normalizeRequestedCategories(params.requestedCategories);
  if (explicit.length > 0) {
    const treeId = (params.treeId ?? "").trim().toLowerCase();
    if (treeId.startsWith("interaction:")) {
      return ["interaction"];
    }
    if (
      treeId.startsWith("integration:")
      || treeId.startsWith("attachment:")
      || treeId.startsWith("image-url:")
      || treeId.startsWith("tool-result:")
      || treeId.startsWith("output-artifact:")
    ) {
      return ["workspace"];
    }
    return ["interaction", "workspace"];
  }
  const treeId = (params.treeId ?? "").trim().toLowerCase();
  if (treeId.startsWith("interaction:")) {
    return ["interaction"];
  }
  if (
    treeId.startsWith("integration:")
    || treeId.startsWith("attachment:")
    || treeId.startsWith("image-url:")
    || treeId.startsWith("tool-result:")
    || treeId.startsWith("output-artifact:")
  ) {
    return ["workspace"];
  }
  const hasInteraction = params.store.listInteractionEntities({
    workspaceId: params.workspaceId,
    status: "active",
    includeSystem: true,
    limit: 1,
    offset: 0,
  }).length > 0;
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
  const hasIntegration = visibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
  }).length > 0;
  const hasAttachments = listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  }).length > 0;
  const hasImageUrls = listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  }).length > 0;
  const hasToolResults = listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  }).length > 0;
  const hasOutputArtifacts = listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  }).length > 0;
  if (hasInteraction && (hasIntegration || hasAttachments || hasImageUrls || hasToolResults || hasOutputArtifacts)) {
    return ["interaction", "workspace"];
  }
  if (hasIntegration || hasAttachments || hasImageUrls || hasToolResults || hasOutputArtifacts) {
    return ["workspace"];
  }
  return ["interaction"];
}

export async function retrieveWorkspaceMemory(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  intent?: string | null;
  categories?: WorkspaceMemoryCategory[] | null;
  treeIds?: string[] | null;
  retrievalPolicy?: MemoryRetrievalPolicy | null;
  answerGoal?: string | null;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  executionProfile?: WorkspaceMemoryExecutionProfile | null;
}): Promise<WorkspaceMemoryRetrieveResult> {
  const useEmbeddings = params.executionProfile?.useEmbeddings !== false;
  const useLlmRerank = params.executionProfile?.useLlmRerank !== false;
  await ensureWorkspaceMemoryReadModelRepaired({
    store: params.store,
    workspaceId: params.workspaceId,
    selectedModel: params.selectedModel ?? null,
  });
  const categories = planWorkspaceMemoryCategories({
    store: params.store,
    workspaceId: params.workspaceId,
    requestedCategories: params.categories ?? undefined,
    treeId: Array.isArray(params.treeIds) && params.treeIds[0] ? params.treeIds[0] : null,
  });
  const candidateLimit = Math.max(
    VECTOR_FIRST_PASS_LIMIT_FLOOR,
    Math.min((params.retrievalPolicy?.max_evidence ?? 8) * 3, VECTOR_FIRST_PASS_LIMIT_CEILING),
  );
  const vectorFirstPass = useEmbeddings
    ? await buildWorkspaceVectorFirstPassHits({
        store: params.store,
        workspaceId: params.workspaceId,
        query: params.query,
        categories,
        treeIds: params.treeIds ?? null,
        selectedModel: params.selectedModel ?? null,
        sessionId: params.sessionId ?? null,
        inputId: params.inputId ?? null,
        maxCandidates: candidateLimit,
      })
    : {
        modelId: null,
        interactionHits: [],
        integrationHits: [],
        attachmentHits: [],
      };
  const lexicalSupportLimit = Math.max(
    LEXICAL_SUPPORT_LIMIT_FLOOR,
    Math.min(params.retrievalPolicy?.max_evidence ?? 8, LEXICAL_SUPPORT_LIMIT_CEILING),
  );
  const lexicalSupportHits = listWorkspaceLexicalSupportHits({
    store: params.store,
    workspaceId: params.workspaceId,
    query: params.query,
    categories,
    treeIds: params.treeIds ?? null,
    maxResults: lexicalSupportLimit,
  });

  const modelClient = useLlmRerank
    ? createBackgroundTaskMemoryModelClient({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId ?? `workspace-memory-rerank:${params.workspaceId}`,
        inputId: params.inputId ?? `workspace-memory-rerank:${params.workspaceId}`,
        selectedModel: params.selectedModel ?? null,
      })
    : null;

  return await buildMemoryHybridRetrievalResult({
    query: params.query,
    requestedIntent: params.intent ?? null,
    answerGoal: params.answerGoal ?? null,
    hits: [
      ...vectorFirstPass.interactionHits.map(interactionHitToWorkspaceHybridHit),
      ...vectorFirstPass.integrationHits.map(integrationHitToWorkspaceHybridHit),
      ...vectorFirstPass.attachmentHits,
      ...lexicalSupportHits,
    ],
    retrievalPolicy: params.retrievalPolicy ?? null,
    allowedTreeIds: params.treeIds ?? null,
    modelClient,
  });
}

export async function buildRecalledWorkspaceMemoryContext(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  intent?: string | null;
  categories?: WorkspaceMemoryCategory[] | null;
  treeIds?: string[] | null;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  maxResults?: number;
  executionProfile?: WorkspaceMemoryExecutionProfile | null;
}): Promise<AgentRecalledMemoryContext | null> {
  const result = await retrieveWorkspaceMemory({
    store: params.store,
    workspaceId: params.workspaceId,
    query: params.query,
    intent: params.intent ?? null,
    categories: params.categories ?? null,
    treeIds: params.treeIds ?? null,
    retrievalPolicy: {
      max_evidence: params.maxResults ?? 5,
      hybrid: true,
      include_neighbors: true,
      freshness_bias: "high",
      prefer_high_signal: true,
    },
    selectedModel: params.selectedModel ?? null,
    sessionId: params.sessionId ?? null,
    inputId: params.inputId ?? null,
    executionProfile: params.executionProfile ?? null,
  });
  if (result.evidence.length === 0) {
    return null;
  }
  return buildAgentRecalledMemoryContext({
    intent: result.intent,
    retrievalPack: result.retrieval_pack,
    evidence: result.evidence,
    gaps: result.gaps,
    coverage: result.coverage,
  });
}

export async function buildRecalledWorkspaceMemoryContextByCategory(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  categories: WorkspaceMemoryCategory[];
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  maxResults?: number;
  executionProfile?: WorkspaceMemoryExecutionProfile | null;
}): Promise<AgentRecalledMemoryContext | null> {
  return await buildRecalledWorkspaceMemoryContext({
    categories: params.categories,
    store: params.store,
    workspaceId: params.workspaceId,
    query: params.query,
    selectedModel: params.selectedModel ?? null,
    sessionId: params.sessionId ?? null,
    inputId: params.inputId ?? null,
    maxResults: params.maxResults ?? 5,
    executionProfile: params.executionProfile ?? null,
  });
}
