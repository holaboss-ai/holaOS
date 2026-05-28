import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type IntegrationLeafRecord,
  type MemoryNodeKind,
  type IntegrationTreeRecord,
  type InteractionTreeChildKind,
  type RuntimeStateStore,
  utcNowIso,
} from "@holaboss/runtime-state-store";

import type { AgentRecalledMemoryContext } from "./memory-retrieval-pack.js";
import { queryMemoryModelEmbedding, queryMemoryModelJson, type MemoryModelClientConfig } from "./memory-model-client.js";
import { createRecallEmbeddingModelClient } from "./recall-embedding-model.js";
import { visibleIntegrationTreesForWorkspace } from "./workspace-integration-visibility.js";
import { globalMemoryDirForWorkspaceRoot } from "./workspace-bundle-paths.js";

const INTEGRATION_BRANCH_FACTOR = 8;
const MAX_RETRIEVE_RESULTS = 12;
const EMBEDDING_EXCERPT_CHARS = 480;
const RETRIEVAL_CANDIDATE_POOL_LIMIT = 320;
const RETRIEVAL_FTS_CANDIDATE_LIMIT = 240;
const RETRIEVAL_RECENT_CANDIDATE_LIMIT = 160;
const RETRIEVAL_VECTOR_CANDIDATE_LIMIT = 120;
const INTEGRATION_REBUILD_DEBOUNCE_MS = 75;
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
type IntegrationRetrieveNodeKind = "tree" | "entity" | "branch" | "summary" | "leaf";

export function countSummaryLikeSemanticIntegrationNodes(params: {
  store: RuntimeStateStore;
  treeId: string;
}): number {
  return params.store.listSemanticMemoryNodes({
    category: "integration",
    treeId: params.treeId,
    nodeClass: "semantic",
    status: "active",
    limit: 10_000,
    offset: 0,
  }).filter((node) => node.nodeKind !== "connection").length;
}

export function queueIntegrationTreeRebuild(params: {
  store: RuntimeStateStore;
  treeId: string;
  embeddingClient?: MemoryModelClientConfig | null;
  debounceMs?: number;
}): Promise<void> {
  const key = params.treeId.trim();
  let pending = pendingIntegrationTreeRebuilds.get(key) ?? null;
  if (!pending) {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const settled = new Promise<void>((innerResolve, innerReject) => {
      resolve = innerResolve;
      reject = innerReject;
    });
    pending = {
      key,
      store: params.store,
      treeId: params.treeId,
      embeddingClient: params.embeddingClient ?? null,
      debounceMs: Math.max(0, params.debounceMs ?? INTEGRATION_REBUILD_DEBOUNCE_MS),
      timer: null,
      running: false,
      dirty: true,
      settled,
      resolve,
      reject,
    };
    void settled.catch(() => undefined);
    pendingIntegrationTreeRebuilds.set(key, pending);
  } else {
    pending.store = params.store;
    pending.embeddingClient = params.embeddingClient ?? pending.embeddingClient ?? null;
    pending.debounceMs = Math.max(0, params.debounceMs ?? pending.debounceMs);
    pending.dirty = true;
  }
  if (!pending.running) {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.timer = setTimeout(() => {
      pending!.timer = null;
      void runQueuedIntegrationTreeRebuild(pending!);
    }, pending.debounceMs);
  }
  return pending.settled;
}

async function runQueuedIntegrationTreeRebuild(pending: PendingIntegrationTreeRebuild): Promise<void> {
  if (pending.running) {
    return;
  }
  pending.running = true;
  try {
    while (pending.dirty) {
      pending.dirty = false;
      await rebuildIntegrationTree({
        store: pending.store,
        treeId: pending.treeId,
        embeddingClient: pending.embeddingClient,
      });
    }
    pending.resolve();
  } catch (error) {
    pending.reject(error);
  } finally {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.running = false;
    pendingIntegrationTreeRebuilds.delete(pending.key);
  }
}

export async function waitForPendingIntegrationTreeRebuilds(params?: {
  treeIds?: string[] | null;
}): Promise<void> {
  const normalizedTreeIds = params?.treeIds
    ? new Set(params.treeIds.map((value) => value.trim()).filter(Boolean))
    : null;
  while (true) {
    const pending = [...pendingIntegrationTreeRebuilds.values()].filter((candidate) =>
      !normalizedTreeIds || normalizedTreeIds.has(candidate.treeId)
    );
    if (pending.length === 0) {
      return;
    }
    await Promise.all(pending.map((candidate) => candidate.settled));
  }
}

export interface IntegrationLeafCandidate {
  provider: string;
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  subjectKey: string;
  entityKey?: string | null;
  entityLabel?: string | null;
  branchKey?: string | null;
  branchLabel?: string | null;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  sourceType?: string | null;
  sourceEventId?: string | null;
  sourceMessageId?: string | null;
  externalObjectId?: string | null;
  externalObjectType?: string | null;
  observedAt?: string | null;
  confidence?: number | null;
}

export interface PersistedIntegrationLeafResult {
  outcome: "noop_duplicate" | "created" | "superseding";
  tree: IntegrationTreeRecord;
  leaf: IntegrationLeafRecord;
}

export interface IntegrationMemoryRetrieveHit {
  category: "integration";
  node_kind: IntegrationRetrieveNodeKind;
  node_id: string;
  tree_id: string;
  provider: string;
  owner_user_id: string;
  account_key: string;
  account_label: string;
  path: string;
  title: string;
  summary: string;
  excerpt: string | null;
  level: number | null;
  child_count: number | null;
  observed_at: string | null;
  updated_at: string | null;
  score: number;
  reasons: string[];
}

export interface IntegrationMemoryRetrieveResult {
  query: string;
  mode: "mixed" | "summaries" | "leaves";
  tree_id: string | null;
  node_id: string | null;
  hits: IntegrationMemoryRetrieveHit[];
  children?: IntegrationMemoryRetrieveHit[];
}

interface NodeCandidate {
  kind: IntegrationRetrieveNodeKind;
  embeddingKind: InteractionTreeChildKind;
  id: string;
  tree: IntegrationTreeRecord;
  title: string;
  summary: string;
  excerpt: string | null;
  path: string;
  level: number | null;
  childCount: number | null;
  observedAt: string | null;
  updatedAt: string | null;
}

type SemanticSearchDoc = ReturnType<RuntimeStateStore["listSemanticMemorySearchDocs"]>[number];

interface TempSummaryNode {
  tempId: string;
  title: string;
  summary: string;
  body: string;
  root: boolean;
  entitySlug: string | null;
  branchSlug: string | null;
  children: Array<{
    kind: InteractionTreeChildKind;
    id: string;
    title: string;
    summary: string;
    excerpt: string | null;
  }>;
}

type TempSummaryChild = TempSummaryNode["children"][number];
type IntegrationRelationInput = {
  fromNodeKind: MemoryNodeKind;
  fromNodeId: string;
  toNodeKind: MemoryNodeKind;
  toNodeId: string;
  relationType: string;
  metadata: Record<string, unknown>;
};

interface PendingIntegrationTreeRebuild {
  key: string;
  store: RuntimeStateStore;
  treeId: string;
  embeddingClient: MemoryModelClientConfig | null;
  debounceMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  dirty: boolean;
  settled: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const pendingIntegrationTreeRebuilds = new Map<string, PendingIntegrationTreeRebuild>();

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function tokenize(value: string): string[] {
  const matches = value.match(/[a-z0-9]{2,}/gi);
  return matches ? matches.map((item) => item.toLowerCase()) : [];
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

function lexicalRankBoost(rank: number | null | undefined): number {
  if (!rank || !Number.isFinite(rank) || rank < 1) {
    return 0;
  }
  return 1.4 / Math.sqrt(rank);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return null;
}

function safePathSegment(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function integrationMemoryRootDir(workspaceRoot: string): string {
  return path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), "integration");
}

function integrationTreeDir(workspaceRoot: string, slug: string): string {
  return path.join(integrationMemoryRootDir(workspaceRoot), "trees", slug);
}

function legacyIntegrationTreeDir(workspaceRoot: string, slug: string): string {
  return path.join(integrationMemoryRootDir(workspaceRoot), "accounts", slug);
}

function semanticIntegrationTreeDir(workspaceRoot: string, slug: string): string {
  return path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), "semantic", "integration", "trees", slug);
}

function integrationEntitySlug(key: string | null | undefined, label: string | null | undefined): string | null {
  const source = compactWhitespace(key ?? "") || compactWhitespace(label ?? "");
  return source ? safePathSegment(source, "entity") : null;
}

function integrationBranchSlug(key: string | null | undefined, label: string | null | undefined): string | null {
  const source = compactWhitespace(key ?? "") || compactWhitespace(label ?? "");
  return source ? safePathSegment(source, "branch") : null;
}

function integrationLeafFolderName(params: {
  leafId: string;
  subjectKey: string;
  title: string;
  externalObjectId?: string | null;
}): string {
  const source = params.externalObjectId ?? params.subjectKey ?? params.title ?? params.leafId;
  const slug = safePathSegment(source, "leaf");
  return `${slug}-${params.leafId.slice(-6)}`;
}

function integrationSummaryFolderName(level: number, nodeId: string): string {
  return `L${level}-${nodeId.slice(-6)}`;
}

function integrationTreeBaseSegments(treeSlug: string): string[] {
  return ["integration", "trees", treeSlug];
}

function integrationEntitySegments(treeSlug: string, entitySlug: string): string[] {
  return [...integrationTreeBaseSegments(treeSlug), "branches", entitySlug];
}

function integrationBranchSegments(params: {
  treeSlug: string;
  entitySlug?: string | null;
  branchSlug: string;
}): string[] {
  return params.entitySlug
    ? [...integrationEntitySegments(params.treeSlug, params.entitySlug), "branches", params.branchSlug]
    : [...integrationTreeBaseSegments(params.treeSlug), "branches", params.branchSlug];
}

function integrationLeafRelativePath(params: {
  treeSlug: string;
  leafId: string;
  subjectKey: string;
  title: string;
  externalObjectId?: string | null;
  entityKey?: string | null;
  entityLabel?: string | null;
  branchKey?: string | null;
  branchLabel?: string | null;
}): string {
  const entitySlug = integrationEntitySlug(params.entityKey, params.entityLabel);
  const branchSlug = integrationBranchSlug(params.branchKey, params.branchLabel);
  const parentSegments = branchSlug
    ? integrationBranchSegments({
        treeSlug: params.treeSlug,
        entitySlug,
        branchSlug,
      })
    : entitySlug
      ? integrationEntitySegments(params.treeSlug, entitySlug)
      : integrationTreeBaseSegments(params.treeSlug);
  const segments = [
    ...parentSegments,
    "branches",
    integrationLeafFolderName({
      leafId: params.leafId,
      subjectKey: params.subjectKey,
      title: params.title,
      externalObjectId: params.externalObjectId ?? null,
    }),
    "content.md",
  ];
  return path.posix.join(...segments);
}

function integrationSummaryRelativePath(
  params: {
    treeSlug: string;
    level: number;
    nodeId: string;
    root?: boolean;
    entitySlug?: string | null;
    branchSlug?: string | null;
  },
): string {
  const parentSegments = params.root
    ? integrationTreeBaseSegments(params.treeSlug)
    : params.branchSlug
      ? integrationBranchSegments({
          treeSlug: params.treeSlug,
          entitySlug: params.entitySlug ?? null,
          branchSlug: params.branchSlug,
        })
      : params.entitySlug
        ? integrationEntitySegments(params.treeSlug, params.entitySlug)
        : integrationTreeBaseSegments(params.treeSlug);
  const segments = [
    ...parentSegments,
    "branches",
    integrationSummaryFolderName(params.level, params.nodeId),
    "content.md",
  ];
  return path.posix.join(...segments);
}

type SemanticMemoryDraftNode = {
  nodeId: string;
  nodeClass: "semantic" | "leaf";
  nodeKind: string;
  sourceLeafId?: string | null;
  path: string;
  title: string;
  summary?: string | null;
  body?: string;
  bodySha256?: string;
  observedAt?: string | null;
  isMaterialized?: boolean;
  metadata?: Record<string, unknown>;
};

type SemanticMemoryDraftEdge = {
  parentNodeId: string;
  childNodeId: string;
  position: number;
};

type SemanticMemoryDraftRelation = {
  fromNodeId: string;
  toNodeId: string;
  relationType: string;
  metadata?: Record<string, unknown>;
};

function semanticIntegrationRootNodeId(treeId: string): string {
  return `semantic:integration:${treeId}:connection`;
}

function semanticIntegrationLeafNodeId(treeId: string, leafId: string): string {
  return `semantic:integration:${treeId}:leaf:${leafId}`;
}

function semanticIntegrationTreeBaseSegments(treeSlug: string): string[] {
  return ["semantic", "integration", "trees", treeSlug];
}

function semanticIntegrationTreeRelativePath(treeSlug: string): string {
  return path.posix.join(...semanticIntegrationTreeBaseSegments(treeSlug), "content.md");
}

function semanticChildRelativePath(parentRelativePath: string, childSlug: string): string {
  return path.posix.join(path.posix.dirname(parentRelativePath), childSlug, "content.md");
}

function semanticLeafRelativePath(
  parentRelativePath: string,
  leaf: Pick<IntegrationLeafRecord, "leafId" | "subjectKey" | "title" | "externalObjectId">,
): string {
  return semanticChildRelativePath(
    parentRelativePath,
    integrationLeafFolderName({
      leafId: leaf.leafId,
      subjectKey: leaf.subjectKey,
      title: leaf.title,
      externalObjectId: leaf.externalObjectId ?? null,
    }),
  );
}

function semanticBranchTitle(branchKey: string, branchLabel?: string | null): string {
  if (compactWhitespace(branchLabel ?? "")) {
    return branchLabel!.trim();
  }
  switch (branchKey) {
    case "overview":
      return "Overview";
    case "profile":
      return "Profile";
    case "events":
      return "Events";
    case "content":
      return "Content";
    case "rows":
      return "Rows";
    case "messages":
      return "Messages";
    case "issues":
      return "Issues";
    case "pull_requests":
      return "Pull requests";
    case "notifications":
      return "Notifications";
    case "readme":
      return "README";
    default:
      return branchKey;
  }
}

function appendSemanticLeafNode(params: {
  drafts: SemanticMemoryDraftNode[];
  edges: SemanticMemoryDraftEdge[];
  treeId: string;
  parentNodeId: string;
  parentPath: string;
  position: number;
  leaf: IntegrationLeafRecord;
  body: string;
}): string {
  const leafNodeId = semanticIntegrationLeafNodeId(params.treeId, params.leaf.leafId);
  params.drafts.push({
    nodeId: leafNodeId,
    nodeClass: "leaf",
    nodeKind: "leaf",
    sourceLeafId: params.leaf.leafId,
    path: semanticLeafRelativePath(params.parentPath, params.leaf),
    title: params.leaf.title,
    summary: params.leaf.summary,
    body: params.body,
    observedAt: params.leaf.observedAt ?? params.leaf.updatedAt,
    metadata: {
      subject_key: params.leaf.subjectKey,
      source_type: params.leaf.sourceType,
      branch_key: params.leaf.branchKey,
      entity_key: params.leaf.entityKey,
      external_object_id: params.leaf.externalObjectId,
      external_object_type: params.leaf.externalObjectType,
      evidence_path: params.leaf.path,
    },
    bodySha256: params.leaf.bodySha256,
  });
  params.edges.push({
    parentNodeId: params.parentNodeId,
    childNodeId: leafNodeId,
    position: params.position,
  });
  return leafNodeId;
}

type SemanticIntegrationTreeBuildResult = {
  nodes: Array<{
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    sourceLeafId: string | null;
    path: string;
    title: string;
    summary: string;
    bodySha256: string;
    childCount: number;
    observedAt: string | null;
    isMaterialized: boolean;
    metadata: Record<string, unknown>;
  }>;
  edges: SemanticMemoryDraftEdge[];
  relations: SemanticMemoryDraftRelation[];
  bodiesByPath: Map<string, string>;
};

function semanticNodeBody(params: {
  tree: IntegrationTreeRecord;
  nodeKind: string;
  title: string;
  summary: string;
  childCount: number;
  isMaterialized: boolean;
  children: Array<{ title: string; summary: string }>;
}): string {
  const lines = [
    `# ${params.title}`,
    "",
    `- Category: integration`,
    `- Tree: \`${params.tree.treeId}\``,
    `- Provider: ${params.tree.provider}`,
    `- Account: ${params.tree.accountLabel}`,
    `- Node kind: ${params.nodeKind}`,
    `- Child count: ${params.childCount}`,
    params.isMaterialized ? "- Materialized: yes" : null,
    "",
    "## Summary",
    "",
    params.summary,
    "",
  ].filter((line): line is string => typeof line === "string");
  if (params.children.length > 0) {
    lines.push(
      "## Children",
      "",
      ...params.children.map((child) => `- **${child.title}**: ${child.summary}`),
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}

function finalizeSemanticMemoryDraft(params: {
  tree: IntegrationTreeRecord;
  nodes: SemanticMemoryDraftNode[];
  edges: SemanticMemoryDraftEdge[];
}): {
  nodes: Array<{
    nodeId: string;
    nodeClass: "semantic" | "leaf";
    nodeKind: string;
    sourceLeafId: string | null;
    path: string;
    title: string;
    summary: string;
    bodySha256: string;
    childCount: number;
    observedAt: string | null;
    isMaterialized: boolean;
    metadata: Record<string, unknown>;
  }>;
  edges: SemanticMemoryDraftEdge[];
  bodiesByPath: Map<string, string>;
} {
  const nodeById = new Map(params.nodes.map((node) => [node.nodeId, node]));
  const childBuckets = new Map<string, SemanticMemoryDraftNode[]>();
  for (const edge of [...params.edges].sort((left, right) => left.position - right.position)) {
    const child = nodeById.get(edge.childNodeId);
    if (!child) {
      continue;
    }
    const bucket = childBuckets.get(edge.parentNodeId) ?? [];
    bucket.push(child);
    childBuckets.set(edge.parentNodeId, bucket);
  }

  const bodiesByPath = new Map<string, string>();
  const nodes = params.nodes.map((node) => {
    const children = childBuckets.get(node.nodeId) ?? [];
    const childCount = children.length;
    const summary = compactWhitespace(node.summary ?? "")
      || (childCount > 0
        ? deterministicSummaryText({
            scopeLabel: `${params.tree.accountLabel} ${node.title}`.trim(),
            childCount,
            childTitles: children.map((child) => child.title),
          })
        : clipText(`${node.title} semantic memory node.`, 240));
    let bodySha256 = "";
    if (node.nodeClass === "semantic") {
      const body = semanticNodeBody({
        tree: params.tree,
        nodeKind: node.nodeKind,
        title: node.title,
        summary,
        childCount,
        isMaterialized: node.isMaterialized ?? false,
        children: children.map((child) => ({
          title: child.title,
          summary: compactWhitespace(child.summary ?? "") || clipText(`${child.title} child node.`, 240),
        })),
      });
      bodySha256 = sha256(body);
      bodiesByPath.set(node.path, body);
    } else {
      const body = node.body ?? `# ${node.title}\n\n${summary}\n`;
      bodySha256 = node.bodySha256 ?? sha256(body);
      bodiesByPath.set(node.path, body);
    }
    return {
      nodeId: node.nodeId,
      nodeClass: node.nodeClass,
      nodeKind: node.nodeKind,
      sourceLeafId: node.sourceLeafId ?? null,
      path: node.path,
      title: node.title,
      summary,
      bodySha256,
      childCount,
      observedAt: node.observedAt ?? null,
      isMaterialized: node.isMaterialized ?? false,
      metadata: node.metadata ?? {},
    };
  });

  return {
    nodes,
    edges: params.edges,
    bodiesByPath,
  };
}

function buildNotionSemanticMemoryTree(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
}): SemanticIntegrationTreeBuildResult {
  const drafts: SemanticMemoryDraftNode[] = [];
  const edges: SemanticMemoryDraftEdge[] = [];
  const rootNodeId = semanticIntegrationRootNodeId(params.tree.treeId);
  const rootPath = semanticIntegrationTreeRelativePath(params.tree.slug);
  const rootTitle = `${params.tree.accountLabel} Notion connection`;
  drafts.push({
    nodeId: rootNodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    path: rootPath,
    title: rootTitle,
    summary: params.tree.summary ?? `Notion connection memory for ${params.tree.accountLabel}.`,
    observedAt: params.tree.updatedAt,
    metadata: {
      provider: params.tree.provider,
      account_key: params.tree.accountKey,
      account_label: params.tree.accountLabel,
    },
  });

  const workspaceLeaf = params.leaves.find((leaf) => leaf.subjectKey === "workspace_snapshot")
    ?? params.leaves.find((leaf) => leaf.branchKey === "workspace" && !leaf.entityKey);
  const workspaceSlug = safePathSegment(
    String(workspaceLeaf?.externalObjectId ?? params.tree.accountKey ?? params.tree.accountLabel),
    "workspace",
  );
  const workspaceNodeId = `semantic:integration:${params.tree.treeId}:workspace:${workspaceSlug}`;
  const workspacePath = semanticChildRelativePath(rootPath, `workspace-${workspaceSlug}`);
  drafts.push({
    nodeId: workspaceNodeId,
    nodeClass: "semantic",
    nodeKind: "workspace",
    path: workspacePath,
    title: workspaceLeaf?.title ?? `Notion workspace for ${params.tree.accountLabel}`,
    summary: workspaceLeaf?.summary ?? `Notion workspace memory for ${params.tree.accountLabel}.`,
    observedAt: workspaceLeaf?.observedAt ?? params.tree.updatedAt,
    metadata: {
      source_leaf_id: workspaceLeaf?.leafId ?? null,
    },
  });
  edges.push({ parentNodeId: rootNodeId, childNodeId: workspaceNodeId, position: 1 });

  let workspaceChildPosition = 1;
  if (workspaceLeaf) {
    const workspaceOverviewNodeId = `semantic:integration:${params.tree.treeId}:workspace:${workspaceSlug}:overview`;
    const workspaceOverviewPath = semanticChildRelativePath(workspacePath, "overview");
    drafts.push({
      nodeId: workspaceOverviewNodeId,
      nodeClass: "semantic",
      nodeKind: "overview",
      path: workspaceOverviewPath,
      title: "Overview",
      summary: workspaceLeaf.summary,
      observedAt: workspaceLeaf.observedAt ?? null,
      metadata: {
        leaf_subject_key: workspaceLeaf.subjectKey,
      },
    });
    edges.push({
      parentNodeId: workspaceNodeId,
      childNodeId: workspaceOverviewNodeId,
      position: workspaceChildPosition++,
    });
    appendSemanticLeafNode({
      drafts,
      edges,
      treeId: params.tree.treeId,
      parentNodeId: workspaceOverviewNodeId,
      parentPath: workspaceOverviewPath,
      position: 1,
      leaf: workspaceLeaf,
      body: params.leafBodies.get(workspaceLeaf.leafId) ?? fallbackLeafBody(workspaceLeaf),
    });
  }

  const pageGroups = new Map<string, { title: string; leaves: IntegrationLeafRecord[] }>();
  const databaseGroups = new Map<string, { title: string; leaves: IntegrationLeafRecord[] }>();
  for (const leaf of params.leaves) {
    if (leaf.entityKey?.startsWith("page:")) {
      const pageId = leaf.entityKey.slice("page:".length);
      const group = pageGroups.get(pageId) ?? {
        title: leaf.entityLabel ?? leaf.title.replace(/\s+content$/i, ""),
        leaves: [],
      };
      group.leaves.push(leaf);
      pageGroups.set(pageId, group);
      continue;
    }
    if (leaf.entityKey?.startsWith("database:")) {
      const databaseId = leaf.entityKey.slice("database:".length);
      const group = databaseGroups.get(databaseId) ?? {
        title: leaf.entityLabel ?? leaf.title,
        leaves: [],
      };
      group.leaves.push(leaf);
      databaseGroups.set(databaseId, group);
    }
  }

  if (pageGroups.size > 0) {
    const pagesNodeId = `semantic:integration:${params.tree.treeId}:workspace:${workspaceSlug}:pages`;
    const pagesPath = semanticChildRelativePath(workspacePath, "pages");
    drafts.push({
      nodeId: pagesNodeId,
      nodeClass: "semantic",
      nodeKind: "pages",
      path: pagesPath,
      title: "Pages",
      summary: null,
      observedAt: params.tree.updatedAt,
    });
    edges.push({ parentNodeId: workspaceNodeId, childNodeId: pagesNodeId, position: workspaceChildPosition++ });

    const sortedPages = Array.from(pageGroups.entries()).sort((left, right) => left[1].title.localeCompare(right[1].title));
    let pagePosition = 1;
    for (const [pageId, group] of sortedPages) {
      const pageSlug = safePathSegment(pageId, "page");
      const pageNodeId = `semantic:integration:${params.tree.treeId}:page:${pageId}`;
      const pagePath = semanticChildRelativePath(pagesPath, `page-${pageSlug}`);
      const overviewLeaf = group.leaves.find((leaf) => leaf.branchKey === "overview") ?? null;
      drafts.push({
        nodeId: pageNodeId,
        nodeClass: "semantic",
        nodeKind: "page",
        path: pagePath,
        title: group.title,
        summary: overviewLeaf?.summary ?? null,
        observedAt: overviewLeaf?.observedAt ?? group.leaves[0]?.observedAt ?? null,
        metadata: {
          external_object_id: overviewLeaf?.externalObjectId ?? pageId,
        },
      });
      edges.push({ parentNodeId: pagesNodeId, childNodeId: pageNodeId, position: pagePosition++ });

      const branchOrder = ["overview", "content"];
      const sortedLeaves = [...group.leaves].sort((left, right) =>
        (branchOrder.indexOf(left.branchKey ?? "") === -1 ? 99 : branchOrder.indexOf(left.branchKey ?? ""))
        - (branchOrder.indexOf(right.branchKey ?? "") === -1 ? 99 : branchOrder.indexOf(right.branchKey ?? ""))
        || left.title.localeCompare(right.title),
      );
      const leavesByBranch = new Map<string, IntegrationLeafRecord[]>();
      for (const leaf of sortedLeaves) {
        const key = leaf.branchKey ?? "items";
        const bucket = leavesByBranch.get(key) ?? [];
        bucket.push(leaf);
        leavesByBranch.set(key, bucket);
      }

      let branchPosition = 1;
      const orderedBranchKeys = [
        ...branchOrder.filter((key) => leavesByBranch.has(key)),
        ...Array.from(leavesByBranch.keys())
          .filter((key) => !branchOrder.includes(key))
          .sort((left, right) => left.localeCompare(right)),
      ];
      for (const branchKey of orderedBranchKeys) {
        const branchLeaves = leavesByBranch.get(branchKey) ?? [];
        const branchNodeId = `semantic:integration:${params.tree.treeId}:page:${pageId}:${branchKey}`;
        const branchPath = semanticChildRelativePath(pagePath, safePathSegment(branchKey, "facet"));
        drafts.push({
          nodeId: branchNodeId,
          nodeClass: "semantic",
          nodeKind: branchKey,
          path: branchPath,
          title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
          summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
          observedAt: branchLeaves[0]?.observedAt ?? null,
        });
        edges.push({ parentNodeId: pageNodeId, childNodeId: branchNodeId, position: branchPosition++ });
        let leafPosition = 1;
        for (const leaf of branchLeaves) {
          appendSemanticLeafNode({
            drafts,
            edges,
            treeId: params.tree.treeId,
            parentNodeId: branchNodeId,
            parentPath: branchPath,
            position: leafPosition++,
            leaf,
            body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
          });
        }
      }
    }
  }

  if (databaseGroups.size > 0) {
    const databasesNodeId = `semantic:integration:${params.tree.treeId}:workspace:${workspaceSlug}:databases`;
    const databasesPath = semanticChildRelativePath(workspacePath, "databases");
    drafts.push({
      nodeId: databasesNodeId,
      nodeClass: "semantic",
      nodeKind: "databases",
      path: databasesPath,
      title: "Databases",
      summary: null,
      observedAt: params.tree.updatedAt,
    });
    edges.push({ parentNodeId: workspaceNodeId, childNodeId: databasesNodeId, position: workspaceChildPosition++ });

    const sortedDatabases = Array.from(databaseGroups.entries()).sort((left, right) => left[1].title.localeCompare(right[1].title));
    let databasePosition = 1;
    for (const [databaseId, group] of sortedDatabases) {
      const databaseSlug = safePathSegment(databaseId, "database");
      const databaseNodeId = `semantic:integration:${params.tree.treeId}:database:${databaseId}`;
      const databasePath = semanticChildRelativePath(databasesPath, `database-${databaseSlug}`);
      const overviewLeaf = group.leaves.find((leaf) => leaf.branchKey === "overview") ?? null;
      drafts.push({
        nodeId: databaseNodeId,
        nodeClass: "semantic",
        nodeKind: "database",
        path: databasePath,
        title: group.title,
        summary: overviewLeaf?.summary ?? null,
        observedAt: overviewLeaf?.observedAt ?? group.leaves[0]?.observedAt ?? null,
        metadata: {
          external_object_id: overviewLeaf?.externalObjectId ?? databaseId,
        },
      });
      edges.push({ parentNodeId: databasesNodeId, childNodeId: databaseNodeId, position: databasePosition++ });

      const branchOrder = ["overview", "rows"];
      const sortedLeaves = [...group.leaves].sort((left, right) =>
        (branchOrder.indexOf(left.branchKey ?? "") === -1 ? 99 : branchOrder.indexOf(left.branchKey ?? ""))
        - (branchOrder.indexOf(right.branchKey ?? "") === -1 ? 99 : branchOrder.indexOf(right.branchKey ?? ""))
        || left.title.localeCompare(right.title),
      );
      const leavesByBranch = new Map<string, IntegrationLeafRecord[]>();
      for (const leaf of sortedLeaves) {
        const key = leaf.branchKey ?? "items";
        const bucket = leavesByBranch.get(key) ?? [];
        bucket.push(leaf);
        leavesByBranch.set(key, bucket);
      }

      let branchPosition = 1;
      const orderedBranchKeys = [
        ...branchOrder.filter((key) => leavesByBranch.has(key)),
        ...Array.from(leavesByBranch.keys())
          .filter((key) => !branchOrder.includes(key))
          .sort((left, right) => left.localeCompare(right)),
      ];
      for (const branchKey of orderedBranchKeys) {
        const branchLeaves = leavesByBranch.get(branchKey) ?? [];
        const branchNodeId = `semantic:integration:${params.tree.treeId}:database:${databaseId}:${branchKey}`;
        const branchPath = semanticChildRelativePath(databasePath, safePathSegment(branchKey, "facet"));
        drafts.push({
          nodeId: branchNodeId,
          nodeClass: "semantic",
          nodeKind: branchKey,
          path: branchPath,
          title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
          summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
          observedAt: branchLeaves[0]?.observedAt ?? null,
        });
        edges.push({ parentNodeId: databaseNodeId, childNodeId: branchNodeId, position: branchPosition++ });
        let leafPosition = 1;
        for (const leaf of branchLeaves) {
          appendSemanticLeafNode({
            drafts,
            edges,
            treeId: params.tree.treeId,
            parentNodeId: branchNodeId,
            parentPath: branchPath,
            position: leafPosition++,
            leaf,
            body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
          });
        }
      }
    }
  }

  const finalized = finalizeSemanticMemoryDraft({
    tree: params.tree,
    nodes: drafts,
    edges,
  });
  return {
    ...finalized,
    relations: [],
  };
}

function buildGitHubSemanticMemoryTree(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
}): SemanticIntegrationTreeBuildResult {
  const drafts: SemanticMemoryDraftNode[] = [];
  const edges: SemanticMemoryDraftEdge[] = [];
  const rootNodeId = semanticIntegrationRootNodeId(params.tree.treeId);
  const rootPath = semanticIntegrationTreeRelativePath(params.tree.slug);
  drafts.push({
    nodeId: rootNodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    path: rootPath,
    title: `${params.tree.accountLabel} GitHub connection`,
    summary: params.tree.summary ?? `GitHub connection memory for ${params.tree.accountLabel}.`,
    observedAt: params.tree.updatedAt,
    metadata: {
      provider: params.tree.provider,
      account_key: params.tree.accountKey,
      account_label: params.tree.accountLabel,
    },
  });

  let rootChildPosition = 1;
  const profileLeaf = params.leaves.find((leaf) => leaf.branchKey === "profile" && !leaf.entityKey) ?? null;
  if (profileLeaf) {
    const profileNodeId = `semantic:integration:${params.tree.treeId}:profile`;
    const profilePath = semanticChildRelativePath(rootPath, "profile");
    drafts.push({
      nodeId: profileNodeId,
      nodeClass: "semantic",
      nodeKind: "profile",
      path: profilePath,
      title: "Profile",
      summary: profileLeaf.summary,
      observedAt: profileLeaf.observedAt ?? profileLeaf.updatedAt,
      metadata: {
        source_leaf_id: profileLeaf.leafId,
      },
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: profileNodeId, position: rootChildPosition++ });
    appendSemanticLeafNode({
      drafts,
      edges,
      treeId: params.tree.treeId,
      parentNodeId: profileNodeId,
      parentPath: profilePath,
      position: 1,
      leaf: profileLeaf,
      body: params.leafBodies.get(profileLeaf.leafId) ?? fallbackLeafBody(profileLeaf),
    });
  }

  const repoGroups = new Map<string, { title: string; leaves: IntegrationLeafRecord[] }>();
  const accountBranchGroups = new Map<string, IntegrationLeafRecord[]>();
  for (const leaf of params.leaves) {
    if (leaf.entityKey?.startsWith("repo:")) {
      const repoKey = leaf.entityKey.slice("repo:".length);
      const group = repoGroups.get(repoKey) ?? {
        title: leaf.entityLabel ?? repoKey,
        leaves: [],
      };
      group.leaves.push(leaf);
      repoGroups.set(repoKey, group);
      continue;
    }
    if (!leaf.entityKey && leaf.branchKey && leaf.branchKey !== "profile") {
      const bucket = accountBranchGroups.get(leaf.branchKey) ?? [];
      bucket.push(leaf);
      accountBranchGroups.set(leaf.branchKey, bucket);
    }
  }

  if (repoGroups.size > 0) {
    const repositoriesNodeId = `semantic:integration:${params.tree.treeId}:repositories`;
    const repositoriesPath = semanticChildRelativePath(rootPath, "repositories");
    drafts.push({
      nodeId: repositoriesNodeId,
      nodeClass: "semantic",
      nodeKind: "repositories",
      path: repositoriesPath,
      title: "Repositories",
      summary: null,
      observedAt: params.tree.updatedAt,
      isMaterialized: true,
    });
    edges.push({
      parentNodeId: rootNodeId,
      childNodeId: repositoriesNodeId,
      position: rootChildPosition++,
    });

    const branchOrder = ["overview", "readme", "issues", "pull_requests", "notifications"];
    const sortedRepos = Array.from(repoGroups.entries()).sort((left, right) => left[1].title.localeCompare(right[1].title));
    let repoPosition = 1;
    for (const [repoKey, group] of sortedRepos) {
      const repoSlug = safePathSegment(repoKey, "repo");
      const repoNodeId = `semantic:integration:${params.tree.treeId}:repo:${repoKey}`;
      const repoPath = semanticChildRelativePath(repositoriesPath, `repo-${repoSlug}`);
      const overviewLeaf = group.leaves.find((leaf) => leaf.branchKey === "overview") ?? null;
      drafts.push({
        nodeId: repoNodeId,
        nodeClass: "semantic",
        nodeKind: "repo",
        path: repoPath,
        title: group.title,
        summary: overviewLeaf?.summary ?? null,
        observedAt: overviewLeaf?.observedAt ?? group.leaves[0]?.observedAt ?? null,
        metadata: {
          entity_key: `repo:${repoKey}`,
          external_object_id: overviewLeaf?.externalObjectId ?? repoKey,
        },
      });
      edges.push({ parentNodeId: repositoriesNodeId, childNodeId: repoNodeId, position: repoPosition++ });

      const leavesByBranch = new Map<string, IntegrationLeafRecord[]>();
      for (const leaf of group.leaves) {
        const key = leaf.branchKey ?? "items";
        const bucket = leavesByBranch.get(key) ?? [];
        bucket.push(leaf);
        leavesByBranch.set(key, bucket);
      }
      const orderedBranchKeys = [
        ...branchOrder.filter((key) => leavesByBranch.has(key)),
        ...Array.from(leavesByBranch.keys())
          .filter((key) => !branchOrder.includes(key))
          .sort((left, right) => left.localeCompare(right)),
      ];
      let branchPosition = 1;
      for (const branchKey of orderedBranchKeys) {
        const branchLeaves = leavesByBranch.get(branchKey) ?? [];
        const branchNodeId = `semantic:integration:${params.tree.treeId}:repo:${repoKey}:${branchKey}`;
        const branchPath = semanticChildRelativePath(repoPath, safePathSegment(branchKey, "facet"));
        drafts.push({
          nodeId: branchNodeId,
          nodeClass: "semantic",
          nodeKind: branchKey,
          path: branchPath,
          title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
          summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
          observedAt: branchLeaves[0]?.observedAt ?? null,
        });
        edges.push({ parentNodeId: repoNodeId, childNodeId: branchNodeId, position: branchPosition++ });
        let leafPosition = 1;
        for (const leaf of branchLeaves) {
          appendSemanticLeafNode({
            drafts,
            edges,
            treeId: params.tree.treeId,
            parentNodeId: branchNodeId,
            parentPath: branchPath,
            position: leafPosition++,
            leaf,
            body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
          });
        }
      }
    }
  }

  const sortedAccountBranches = Array.from(accountBranchGroups.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  for (const [branchKey, branchLeaves] of sortedAccountBranches) {
    const branchNodeId = `semantic:integration:${params.tree.treeId}:account:${branchKey}`;
    const branchPath = semanticChildRelativePath(rootPath, safePathSegment(branchKey, "facet"));
    drafts.push({
      nodeId: branchNodeId,
      nodeClass: "semantic",
      nodeKind: branchKey,
      path: branchPath,
      title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
      summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
      observedAt: branchLeaves[0]?.observedAt ?? null,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: branchNodeId, position: rootChildPosition++ });
    let leafPosition = 1;
    for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
      appendSemanticLeafNode({
        drafts,
        edges,
        treeId: params.tree.treeId,
        parentNodeId: branchNodeId,
        parentPath: branchPath,
        position: leafPosition++,
        leaf,
        body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
      });
    }
  }

  const finalized = finalizeSemanticMemoryDraft({
    tree: params.tree,
    nodes: drafts,
    edges,
  });
  return {
    ...finalized,
    relations: [],
  };
}

function buildGmailSemanticMemoryTree(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
  relations: IntegrationRelationInput[];
}): SemanticIntegrationTreeBuildResult {
  const drafts: SemanticMemoryDraftNode[] = [];
  const edges: SemanticMemoryDraftEdge[] = [];
  const semanticRelations: SemanticMemoryDraftRelation[] = [];
  const rootNodeId = semanticIntegrationRootNodeId(params.tree.treeId);
  const rootPath = semanticIntegrationTreeRelativePath(params.tree.slug);
  drafts.push({
    nodeId: rootNodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    path: rootPath,
    title: `${params.tree.accountLabel} Gmail connection`,
    summary: params.tree.summary ?? `Gmail connection memory for ${params.tree.accountLabel}.`,
    observedAt: params.tree.updatedAt,
    metadata: {
      provider: params.tree.provider,
      account_key: params.tree.accountKey,
      account_label: params.tree.accountLabel,
    },
  });

  let rootChildPosition = 1;
  const profileLeaf = params.leaves.find((leaf) => leaf.branchKey === "profile" && !leaf.entityKey) ?? null;
  if (profileLeaf) {
    const profileNodeId = `semantic:integration:${params.tree.treeId}:profile`;
    const profilePath = semanticChildRelativePath(rootPath, "profile");
    drafts.push({
      nodeId: profileNodeId,
      nodeClass: "semantic",
      nodeKind: "profile",
      path: profilePath,
      title: "Profile",
      summary: profileLeaf.summary,
      observedAt: profileLeaf.observedAt ?? profileLeaf.updatedAt,
      metadata: {
        source_leaf_id: profileLeaf.leafId,
      },
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: profileNodeId, position: rootChildPosition++ });
    appendSemanticLeafNode({
      drafts,
      edges,
      treeId: params.tree.treeId,
      parentNodeId: profileNodeId,
      parentPath: profilePath,
      position: 1,
      leaf: profileLeaf,
      body: params.leafBodies.get(profileLeaf.leafId) ?? fallbackLeafBody(profileLeaf),
    });
  }

  const threadGroups = new Map<string, { title: string; leaves: IntegrationLeafRecord[] }>();
  const accountBranchGroups = new Map<string, IntegrationLeafRecord[]>();
  for (const leaf of params.leaves) {
    if (leaf.entityKey?.startsWith("thread:")) {
      const threadId = leaf.entityKey.slice("thread:".length);
      const group = threadGroups.get(threadId) ?? {
        title: leaf.entityLabel ?? leaf.title,
        leaves: [],
      };
      group.leaves.push(leaf);
      threadGroups.set(threadId, group);
      continue;
    }
    if (!leaf.entityKey && leaf.branchKey && leaf.branchKey !== "profile") {
      const bucket = accountBranchGroups.get(leaf.branchKey) ?? [];
      bucket.push(leaf);
      accountBranchGroups.set(leaf.branchKey, bucket);
    }
  }

  if (threadGroups.size > 0) {
    const threadsNodeId = `semantic:integration:${params.tree.treeId}:threads`;
    const threadsPath = semanticChildRelativePath(rootPath, "threads");
    drafts.push({
      nodeId: threadsNodeId,
      nodeClass: "semantic",
      nodeKind: "threads",
      path: threadsPath,
      title: "Threads",
      summary: null,
      observedAt: params.tree.updatedAt,
      isMaterialized: true,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: threadsNodeId, position: rootChildPosition++ });

    const branchOrder = ["messages"];
    const sortedThreads = Array.from(threadGroups.entries()).sort((left, right) => left[1].title.localeCompare(right[1].title));
    let threadPosition = 1;
    for (const [threadId, group] of sortedThreads) {
      const threadNodeId = `semantic:integration:${params.tree.treeId}:thread:${threadId}`;
      const threadPath = semanticChildRelativePath(threadsPath, `thread-${safePathSegment(threadId, "thread")}`);
      const firstLeaf = [...group.leaves].sort((left, right) =>
        (left.observedAt ?? left.updatedAt).localeCompare(right.observedAt ?? right.updatedAt),
      )[0] ?? null;
      drafts.push({
        nodeId: threadNodeId,
        nodeClass: "semantic",
        nodeKind: "thread",
        path: threadPath,
        title: group.title,
        summary: firstLeaf?.summary ?? null,
        observedAt: firstLeaf?.observedAt ?? null,
        metadata: {
          entity_key: `thread:${threadId}`,
          related_leaf_ids: group.leaves.map((leaf) => leaf.leafId),
        },
      });
      edges.push({ parentNodeId: threadsNodeId, childNodeId: threadNodeId, position: threadPosition++ });

      const leavesByBranch = new Map<string, IntegrationLeafRecord[]>();
      for (const leaf of group.leaves) {
        const key = leaf.branchKey ?? "items";
        const bucket = leavesByBranch.get(key) ?? [];
        bucket.push(leaf);
        leavesByBranch.set(key, bucket);
      }
      const orderedBranchKeys = [
        ...branchOrder.filter((key) => leavesByBranch.has(key)),
        ...Array.from(leavesByBranch.keys())
          .filter((key) => !branchOrder.includes(key))
          .sort((left, right) => left.localeCompare(right)),
      ];
      let branchPosition = 1;
      for (const branchKey of orderedBranchKeys) {
        const branchLeaves = leavesByBranch.get(branchKey) ?? [];
        const branchNodeId = `semantic:integration:${params.tree.treeId}:thread:${threadId}:${branchKey}`;
        const branchPath = semanticChildRelativePath(threadPath, safePathSegment(branchKey, "facet"));
        drafts.push({
          nodeId: branchNodeId,
          nodeClass: "semantic",
          nodeKind: branchKey,
          path: branchPath,
          title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
          summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
          observedAt: branchLeaves[0]?.observedAt ?? null,
        });
        edges.push({ parentNodeId: threadNodeId, childNodeId: branchNodeId, position: branchPosition++ });
        let leafPosition = 1;
        for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
          appendSemanticLeafNode({
            drafts,
            edges,
            treeId: params.tree.treeId,
            parentNodeId: branchNodeId,
            parentPath: branchPath,
            position: leafPosition++,
            leaf,
            body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
          });
        }
      }
    }
  }

  const contacts = buildIntegrationContactEntries({
    treeId: params.tree.treeId,
    relations: params.relations,
  });
  if (contacts.size > 0) {
    const contactsNodeId = `semantic:integration:${params.tree.treeId}:contacts`;
    const contactsPath = semanticChildRelativePath(rootPath, "contacts");
    drafts.push({
      nodeId: contactsNodeId,
      nodeClass: "semantic",
      nodeKind: "contacts",
      path: contactsPath,
      title: "Contacts",
      summary: `Derived Gmail contacts for ${params.tree.accountLabel}.`,
      observedAt: params.tree.updatedAt,
      isMaterialized: true,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: contactsNodeId, position: rootChildPosition++ });

    const sortedContacts = Array.from(contacts.values()).sort((left, right) => left.label.localeCompare(right.label));
    let contactPosition = 1;
    for (const contact of sortedContacts) {
      const contactNodeId = `semantic:integration:${params.tree.treeId}:contact:${contact.email}`;
      const contactPath = semanticChildRelativePath(contactsPath, `contact-${safePathSegment(contact.email, "contact")}`);
      drafts.push({
        nodeId: contactNodeId,
        nodeClass: "semantic",
        nodeKind: "contact",
        path: contactPath,
        title: contact.label,
        summary: `${contact.label} appears in ${contact.relatedThreadIds.length} thread${contact.relatedThreadIds.length === 1 ? "" : "s"} in this mailbox.`,
        observedAt: params.tree.updatedAt,
        isMaterialized: true,
        metadata: {
          contact_entity_key: contact.entityKey,
          contact_email: contact.email,
        },
      });
      edges.push({ parentNodeId: contactsNodeId, childNodeId: contactNodeId, position: contactPosition++ });
    }
  }

  for (const relation of params.relations) {
    if (relation.relationType !== "participant") {
      continue;
    }
    const contactEmail = typeof relation.metadata.contact_email === "string"
      ? relation.metadata.contact_email.trim().toLowerCase()
      : "";
    const threadEntityKey = typeof relation.metadata.thread_entity_key === "string"
      ? relation.metadata.thread_entity_key
      : "";
    const semanticThreadNodeId = semanticGmailThreadNodeId(params.tree.treeId, threadEntityKey);
    if (!contactEmail || !semanticThreadNodeId) {
      continue;
    }
    semanticRelations.push({
      fromNodeId: `semantic:integration:${params.tree.treeId}:contact:${contactEmail}`,
      toNodeId: semanticThreadNodeId,
      relationType: relation.relationType,
      metadata: relation.metadata,
    });
  }

  const sortedAccountBranches = Array.from(accountBranchGroups.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  for (const [branchKey, branchLeaves] of sortedAccountBranches) {
    const branchNodeId = `semantic:integration:${params.tree.treeId}:account:${branchKey}`;
    const branchPath = semanticChildRelativePath(rootPath, safePathSegment(branchKey, "facet"));
    drafts.push({
      nodeId: branchNodeId,
      nodeClass: "semantic",
      nodeKind: branchKey,
      path: branchPath,
      title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
      summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
      observedAt: branchLeaves[0]?.observedAt ?? null,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: branchNodeId, position: rootChildPosition++ });
    let leafPosition = 1;
    for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
      appendSemanticLeafNode({
        drafts,
        edges,
        treeId: params.tree.treeId,
        parentNodeId: branchNodeId,
        parentPath: branchPath,
        position: leafPosition++,
        leaf,
        body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
      });
    }
  }

  const finalized = finalizeSemanticMemoryDraft({
    tree: params.tree,
    nodes: drafts,
    edges,
  });
  return {
    ...finalized,
    relations: semanticRelations,
  };
}

function buildGoogleDriveSemanticMemoryTree(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
}): SemanticIntegrationTreeBuildResult {
  const drafts: SemanticMemoryDraftNode[] = [];
  const edges: SemanticMemoryDraftEdge[] = [];
  const rootNodeId = semanticIntegrationRootNodeId(params.tree.treeId);
  const rootPath = semanticIntegrationTreeRelativePath(params.tree.slug);
  drafts.push({
    nodeId: rootNodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    path: rootPath,
    title: `${params.tree.accountLabel} Google Drive connection`,
    summary: params.tree.summary ?? `Google Drive connection memory for ${params.tree.accountLabel}.`,
    observedAt: params.tree.updatedAt,
    metadata: {
      provider: params.tree.provider,
      account_key: params.tree.accountKey,
      account_label: params.tree.accountLabel,
    },
  });

  let rootChildPosition = 1;
  const profileLeaf = params.leaves.find((leaf) => leaf.branchKey === "profile" && !leaf.entityKey) ?? null;
  if (profileLeaf) {
    const profileNodeId = `semantic:integration:${params.tree.treeId}:profile`;
    const profilePath = semanticChildRelativePath(rootPath, "profile");
    drafts.push({
      nodeId: profileNodeId,
      nodeClass: "semantic",
      nodeKind: "profile",
      path: profilePath,
      title: "Profile",
      summary: profileLeaf.summary,
      observedAt: profileLeaf.observedAt ?? profileLeaf.updatedAt,
      metadata: {
        source_leaf_id: profileLeaf.leafId,
      },
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: profileNodeId, position: rootChildPosition++ });
    appendSemanticLeafNode({
      drafts,
      edges,
      treeId: params.tree.treeId,
      parentNodeId: profileNodeId,
      parentPath: profilePath,
      position: 1,
      leaf: profileLeaf,
      body: params.leafBodies.get(profileLeaf.leafId) ?? fallbackLeafBody(profileLeaf),
    });
  }

  const fileGroups = new Map<string, { title: string; nodeKind: "file" | "folder"; leaves: IntegrationLeafRecord[] }>();
  const accountBranchGroups = new Map<string, IntegrationLeafRecord[]>();
  for (const leaf of params.leaves) {
    if (leaf.entityKey?.startsWith("file:")) {
      const fileId = leaf.entityKey.slice("file:".length);
      const nodeKind = leaf.sourceType === "googledrive.folder" || leaf.externalObjectType === "google_drive_folder"
        ? "folder"
        : "file";
      const group = fileGroups.get(fileId) ?? {
        title: leaf.entityLabel ?? leaf.title,
        nodeKind,
        leaves: [],
      };
      if (nodeKind === "folder") {
        group.nodeKind = "folder";
      }
      group.leaves.push(leaf);
      fileGroups.set(fileId, group);
      continue;
    }
    if (!leaf.entityKey && leaf.branchKey && leaf.branchKey !== "profile") {
      const bucket = accountBranchGroups.get(leaf.branchKey) ?? [];
      bucket.push(leaf);
      accountBranchGroups.set(leaf.branchKey, bucket);
    }
  }

  if (fileGroups.size > 0) {
    const filesNodeId = `semantic:integration:${params.tree.treeId}:files`;
    const filesPath = semanticChildRelativePath(rootPath, "files");
    drafts.push({
      nodeId: filesNodeId,
      nodeClass: "semantic",
      nodeKind: "files",
      path: filesPath,
      title: "Files",
      summary: null,
      observedAt: params.tree.updatedAt,
      isMaterialized: true,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: filesNodeId, position: rootChildPosition++ });

    const branchOrder = ["overview"];
    const sortedFiles = Array.from(fileGroups.entries()).sort((left, right) => left[1].title.localeCompare(right[1].title));
    let filePosition = 1;
    for (const [fileId, group] of sortedFiles) {
      const fileSlug = safePathSegment(fileId, "file");
      const fileNodeId = `semantic:integration:${params.tree.treeId}:file:${fileId}`;
      const filePath = semanticChildRelativePath(filesPath, `${group.nodeKind}-${fileSlug}`);
      const overviewLeaf = group.leaves.find((leaf) => leaf.branchKey === "overview") ?? null;
      drafts.push({
        nodeId: fileNodeId,
        nodeClass: "semantic",
        nodeKind: group.nodeKind,
        path: filePath,
        title: group.title,
        summary: overviewLeaf?.summary ?? null,
        observedAt: overviewLeaf?.observedAt ?? group.leaves[0]?.observedAt ?? null,
        metadata: {
          entity_key: `file:${fileId}`,
          external_object_id: overviewLeaf?.externalObjectId ?? fileId,
        },
      });
      edges.push({ parentNodeId: filesNodeId, childNodeId: fileNodeId, position: filePosition++ });

      const leavesByBranch = new Map<string, IntegrationLeafRecord[]>();
      for (const leaf of group.leaves) {
        const key = leaf.branchKey ?? "items";
        const bucket = leavesByBranch.get(key) ?? [];
        bucket.push(leaf);
        leavesByBranch.set(key, bucket);
      }
      const orderedBranchKeys = [
        ...branchOrder.filter((key) => leavesByBranch.has(key)),
        ...Array.from(leavesByBranch.keys())
          .filter((key) => !branchOrder.includes(key))
          .sort((left, right) => left.localeCompare(right)),
      ];
      let branchPosition = 1;
      for (const branchKey of orderedBranchKeys) {
        const branchLeaves = leavesByBranch.get(branchKey) ?? [];
        const branchNodeId = `semantic:integration:${params.tree.treeId}:file:${fileId}:${branchKey}`;
        const branchPath = semanticChildRelativePath(filePath, safePathSegment(branchKey, "facet"));
        drafts.push({
          nodeId: branchNodeId,
          nodeClass: "semantic",
          nodeKind: branchKey,
          path: branchPath,
          title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
          summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
          observedAt: branchLeaves[0]?.observedAt ?? null,
        });
        edges.push({ parentNodeId: fileNodeId, childNodeId: branchNodeId, position: branchPosition++ });
        let leafPosition = 1;
        for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
          appendSemanticLeafNode({
            drafts,
            edges,
            treeId: params.tree.treeId,
            parentNodeId: branchNodeId,
            parentPath: branchPath,
            position: leafPosition++,
            leaf,
            body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
          });
        }
      }
    }
  }

  const sortedAccountBranches = Array.from(accountBranchGroups.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  for (const [branchKey, branchLeaves] of sortedAccountBranches) {
    const branchNodeId = `semantic:integration:${params.tree.treeId}:account:${branchKey}`;
    const branchPath = semanticChildRelativePath(rootPath, safePathSegment(branchKey, "facet"));
    drafts.push({
      nodeId: branchNodeId,
      nodeClass: "semantic",
      nodeKind: branchKey,
      path: branchPath,
      title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
      summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
      observedAt: branchLeaves[0]?.observedAt ?? null,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: branchNodeId, position: rootChildPosition++ });
    let leafPosition = 1;
    for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
      appendSemanticLeafNode({
        drafts,
        edges,
        treeId: params.tree.treeId,
        parentNodeId: branchNodeId,
        parentPath: branchPath,
        position: leafPosition++,
        leaf,
        body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
      });
    }
  }

  const finalized = finalizeSemanticMemoryDraft({
    tree: params.tree,
    nodes: drafts,
    edges,
  });
  return {
    ...finalized,
    relations: [],
  };
}

function buildTwitterSemanticMemoryTree(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
}): SemanticIntegrationTreeBuildResult {
  const drafts: SemanticMemoryDraftNode[] = [];
  const edges: SemanticMemoryDraftEdge[] = [];
  const rootNodeId = semanticIntegrationRootNodeId(params.tree.treeId);
  const rootPath = semanticIntegrationTreeRelativePath(params.tree.slug);
  drafts.push({
    nodeId: rootNodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    path: rootPath,
    title: `${params.tree.accountLabel} Twitter connection`,
    summary: params.tree.summary ?? `Twitter connection memory for ${params.tree.accountLabel}.`,
    observedAt: params.tree.updatedAt,
    metadata: {
      provider: params.tree.provider,
      account_key: params.tree.accountKey,
      account_label: params.tree.accountLabel,
    },
  });

  let rootChildPosition = 1;
  const profileLeaf = params.leaves.find((leaf) => leaf.branchKey === "profile" && !leaf.entityKey) ?? null;
  if (profileLeaf) {
    const profileNodeId = `semantic:integration:${params.tree.treeId}:profile`;
    const profilePath = semanticChildRelativePath(rootPath, "profile");
    drafts.push({
      nodeId: profileNodeId,
      nodeClass: "semantic",
      nodeKind: "profile",
      path: profilePath,
      title: "Profile",
      summary: profileLeaf.summary,
      observedAt: profileLeaf.observedAt ?? profileLeaf.updatedAt,
      metadata: {
        source_leaf_id: profileLeaf.leafId,
      },
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: profileNodeId, position: rootChildPosition++ });
    appendSemanticLeafNode({
      drafts,
      edges,
      treeId: params.tree.treeId,
      parentNodeId: profileNodeId,
      parentPath: profilePath,
      position: 1,
      leaf: profileLeaf,
      body: params.leafBodies.get(profileLeaf.leafId) ?? fallbackLeafBody(profileLeaf),
    });
  }

  const postGroups = new Map<string, { title: string; leaves: IntegrationLeafRecord[] }>();
  const accountBranchGroups = new Map<string, IntegrationLeafRecord[]>();
  for (const leaf of params.leaves) {
    if (leaf.entityKey?.startsWith("post:")) {
      const postId = leaf.entityKey.slice("post:".length);
      const group = postGroups.get(postId) ?? {
        title: leaf.entityLabel ?? leaf.title,
        leaves: [],
      };
      group.leaves.push(leaf);
      postGroups.set(postId, group);
      continue;
    }
    if (!leaf.entityKey && leaf.branchKey && leaf.branchKey !== "profile") {
      const bucket = accountBranchGroups.get(leaf.branchKey) ?? [];
      bucket.push(leaf);
      accountBranchGroups.set(leaf.branchKey, bucket);
    }
  }

  if (postGroups.size > 0) {
    const timelineNodeId = `semantic:integration:${params.tree.treeId}:timeline`;
    const timelinePath = semanticChildRelativePath(rootPath, "timeline");
    drafts.push({
      nodeId: timelineNodeId,
      nodeClass: "semantic",
      nodeKind: "timeline",
      path: timelinePath,
      title: "Timeline",
      summary: null,
      observedAt: params.tree.updatedAt,
      isMaterialized: true,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: timelineNodeId, position: rootChildPosition++ });

    const branchOrder = ["overview"];
    const sortedPosts = Array.from(postGroups.entries()).sort((left, right) => {
      const leftObservedAt = left[1].leaves[0]?.observedAt ?? left[1].leaves[0]?.updatedAt ?? "";
      const rightObservedAt = right[1].leaves[0]?.observedAt ?? right[1].leaves[0]?.updatedAt ?? "";
      return rightObservedAt.localeCompare(leftObservedAt) || left[1].title.localeCompare(right[1].title);
    });
    let postPosition = 1;
    for (const [postId, group] of sortedPosts) {
      const postSlug = safePathSegment(postId, "post");
      const postNodeId = `semantic:integration:${params.tree.treeId}:post:${postId}`;
      const postPath = semanticChildRelativePath(timelinePath, `post-${postSlug}`);
      const overviewLeaf = group.leaves.find((leaf) => leaf.branchKey === "overview") ?? null;
      drafts.push({
        nodeId: postNodeId,
        nodeClass: "semantic",
        nodeKind: "post",
        path: postPath,
        title: group.title,
        summary: overviewLeaf?.summary ?? null,
        observedAt: overviewLeaf?.observedAt ?? group.leaves[0]?.observedAt ?? null,
        metadata: {
          entity_key: `post:${postId}`,
          external_object_id: overviewLeaf?.externalObjectId ?? postId,
        },
      });
      edges.push({ parentNodeId: timelineNodeId, childNodeId: postNodeId, position: postPosition++ });

      const leavesByBranch = new Map<string, IntegrationLeafRecord[]>();
      for (const leaf of group.leaves) {
        const key = leaf.branchKey ?? "items";
        const bucket = leavesByBranch.get(key) ?? [];
        bucket.push(leaf);
        leavesByBranch.set(key, bucket);
      }
      const orderedBranchKeys = [
        ...branchOrder.filter((key) => leavesByBranch.has(key)),
        ...Array.from(leavesByBranch.keys())
          .filter((key) => !branchOrder.includes(key))
          .sort((left, right) => left.localeCompare(right)),
      ];
      let branchPosition = 1;
      for (const branchKey of orderedBranchKeys) {
        const branchLeaves = leavesByBranch.get(branchKey) ?? [];
        const branchNodeId = `semantic:integration:${params.tree.treeId}:post:${postId}:${branchKey}`;
        const branchPath = semanticChildRelativePath(postPath, safePathSegment(branchKey, "facet"));
        drafts.push({
          nodeId: branchNodeId,
          nodeClass: "semantic",
          nodeKind: branchKey,
          path: branchPath,
          title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
          summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
          observedAt: branchLeaves[0]?.observedAt ?? null,
        });
        edges.push({ parentNodeId: postNodeId, childNodeId: branchNodeId, position: branchPosition++ });
        let leafPosition = 1;
        for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
          appendSemanticLeafNode({
            drafts,
            edges,
            treeId: params.tree.treeId,
            parentNodeId: branchNodeId,
            parentPath: branchPath,
            position: leafPosition++,
            leaf,
            body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
          });
        }
      }
    }
  }

  const sortedAccountBranches = Array.from(accountBranchGroups.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  for (const [branchKey, branchLeaves] of sortedAccountBranches) {
    const branchNodeId = `semantic:integration:${params.tree.treeId}:account:${branchKey}`;
    const branchPath = semanticChildRelativePath(rootPath, safePathSegment(branchKey, "facet"));
    drafts.push({
      nodeId: branchNodeId,
      nodeClass: "semantic",
      nodeKind: branchKey,
      path: branchPath,
      title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
      summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
      observedAt: branchLeaves[0]?.observedAt ?? null,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: branchNodeId, position: rootChildPosition++ });
    let leafPosition = 1;
    for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
      appendSemanticLeafNode({
        drafts,
        edges,
        treeId: params.tree.treeId,
        parentNodeId: branchNodeId,
        parentPath: branchPath,
        position: leafPosition++,
        leaf,
        body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
      });
    }
  }

  const finalized = finalizeSemanticMemoryDraft({
    tree: params.tree,
    nodes: drafts,
    edges,
  });
  return {
    ...finalized,
    relations: [],
  };
}

function buildGoogleCalendarSemanticMemoryTree(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
}): SemanticIntegrationTreeBuildResult {
  const drafts: SemanticMemoryDraftNode[] = [];
  const edges: SemanticMemoryDraftEdge[] = [];
  const rootNodeId = semanticIntegrationRootNodeId(params.tree.treeId);
  const rootPath = semanticIntegrationTreeRelativePath(params.tree.slug);
  drafts.push({
    nodeId: rootNodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    path: rootPath,
    title: `${params.tree.accountLabel} Google Calendar connection`,
    summary: params.tree.summary ?? `Google Calendar connection memory for ${params.tree.accountLabel}.`,
    observedAt: params.tree.updatedAt,
    metadata: {
      provider: params.tree.provider,
      account_key: params.tree.accountKey,
      account_label: params.tree.accountLabel,
    },
  });

  let rootChildPosition = 1;
  const profileLeaf = params.leaves.find((leaf) => leaf.branchKey === "profile" && !leaf.entityKey) ?? null;
  if (profileLeaf) {
    const profileNodeId = `semantic:integration:${params.tree.treeId}:profile`;
    const profilePath = semanticChildRelativePath(rootPath, "profile");
    drafts.push({
      nodeId: profileNodeId,
      nodeClass: "semantic",
      nodeKind: "profile",
      path: profilePath,
      title: "Profile",
      summary: profileLeaf.summary,
      observedAt: profileLeaf.observedAt ?? profileLeaf.updatedAt,
      metadata: {
        source_leaf_id: profileLeaf.leafId,
      },
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: profileNodeId, position: rootChildPosition++ });
    appendSemanticLeafNode({
      drafts,
      edges,
      treeId: params.tree.treeId,
      parentNodeId: profileNodeId,
      parentPath: profilePath,
      position: 1,
      leaf: profileLeaf,
      body: params.leafBodies.get(profileLeaf.leafId) ?? fallbackLeafBody(profileLeaf),
    });
  }

  const calendarGroups = new Map<string, { title: string; leaves: IntegrationLeafRecord[] }>();
  const accountBranchGroups = new Map<string, IntegrationLeafRecord[]>();
  for (const leaf of params.leaves) {
    if (leaf.entityKey?.startsWith("calendar:")) {
      const calendarId = leaf.entityKey.slice("calendar:".length);
      const group = calendarGroups.get(calendarId) ?? {
        title: leaf.entityLabel ?? leaf.title,
        leaves: [],
      };
      group.leaves.push(leaf);
      calendarGroups.set(calendarId, group);
      continue;
    }
    if (!leaf.entityKey && leaf.branchKey && leaf.branchKey !== "profile") {
      const bucket = accountBranchGroups.get(leaf.branchKey) ?? [];
      bucket.push(leaf);
      accountBranchGroups.set(leaf.branchKey, bucket);
    }
  }

  if (calendarGroups.size > 0) {
    const calendarsNodeId = `semantic:integration:${params.tree.treeId}:calendars`;
    const calendarsPath = semanticChildRelativePath(rootPath, "calendars");
    drafts.push({
      nodeId: calendarsNodeId,
      nodeClass: "semantic",
      nodeKind: "calendars",
      path: calendarsPath,
      title: "Calendars",
      summary: null,
      observedAt: params.tree.updatedAt,
      isMaterialized: true,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: calendarsNodeId, position: rootChildPosition++ });

    const branchOrder = ["overview", "events"];
    const sortedCalendars = Array.from(calendarGroups.entries()).sort((left, right) => left[1].title.localeCompare(right[1].title));
    let calendarPosition = 1;
    for (const [calendarId, group] of sortedCalendars) {
      const calendarSlug = safePathSegment(calendarId, "calendar");
      const calendarNodeId = `semantic:integration:${params.tree.treeId}:calendar:${calendarId}`;
      const calendarPath = semanticChildRelativePath(calendarsPath, `calendar-${calendarSlug}`);
      const overviewLeaf = group.leaves.find((leaf) => leaf.branchKey === "overview") ?? null;
      drafts.push({
        nodeId: calendarNodeId,
        nodeClass: "semantic",
        nodeKind: "calendar",
        path: calendarPath,
        title: group.title,
        summary: overviewLeaf?.summary ?? null,
        observedAt: overviewLeaf?.observedAt ?? group.leaves[0]?.observedAt ?? null,
        metadata: {
          entity_key: `calendar:${calendarId}`,
          external_object_id: overviewLeaf?.externalObjectId ?? calendarId,
        },
      });
      edges.push({ parentNodeId: calendarsNodeId, childNodeId: calendarNodeId, position: calendarPosition++ });

      const leavesByBranch = new Map<string, IntegrationLeafRecord[]>();
      for (const leaf of group.leaves) {
        const key = leaf.branchKey ?? "items";
        const bucket = leavesByBranch.get(key) ?? [];
        bucket.push(leaf);
        leavesByBranch.set(key, bucket);
      }
      const orderedBranchKeys = [
        ...branchOrder.filter((key) => leavesByBranch.has(key)),
        ...Array.from(leavesByBranch.keys())
          .filter((key) => !branchOrder.includes(key))
          .sort((left, right) => left.localeCompare(right)),
      ];
      let branchPosition = 1;
      for (const branchKey of orderedBranchKeys) {
        const branchLeaves = leavesByBranch.get(branchKey) ?? [];
        const branchNodeId = `semantic:integration:${params.tree.treeId}:calendar:${calendarId}:${branchKey}`;
        const branchPath = semanticChildRelativePath(calendarPath, safePathSegment(branchKey, "facet"));
        drafts.push({
          nodeId: branchNodeId,
          nodeClass: "semantic",
          nodeKind: branchKey,
          path: branchPath,
          title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
          summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
          observedAt: branchLeaves[0]?.observedAt ?? null,
        });
        edges.push({ parentNodeId: calendarNodeId, childNodeId: branchNodeId, position: branchPosition++ });
        let leafPosition = 1;
        for (const leaf of branchLeaves.sort((left, right) =>
          (right.observedAt ?? right.updatedAt).localeCompare(left.observedAt ?? left.updatedAt)
          || left.title.localeCompare(right.title),
        )) {
          appendSemanticLeafNode({
            drafts,
            edges,
            treeId: params.tree.treeId,
            parentNodeId: branchNodeId,
            parentPath: branchPath,
            position: leafPosition++,
            leaf,
            body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
          });
        }
      }
    }
  }

  const sortedAccountBranches = Array.from(accountBranchGroups.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  for (const [branchKey, branchLeaves] of sortedAccountBranches) {
    const branchNodeId = `semantic:integration:${params.tree.treeId}:account:${branchKey}`;
    const branchPath = semanticChildRelativePath(rootPath, safePathSegment(branchKey, "facet"));
    drafts.push({
      nodeId: branchNodeId,
      nodeClass: "semantic",
      nodeKind: branchKey,
      path: branchPath,
      title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
      summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
      observedAt: branchLeaves[0]?.observedAt ?? null,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: branchNodeId, position: rootChildPosition++ });
    let leafPosition = 1;
    for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
      appendSemanticLeafNode({
        drafts,
        edges,
        treeId: params.tree.treeId,
        parentNodeId: branchNodeId,
        parentPath: branchPath,
        position: leafPosition++,
        leaf,
        body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
      });
    }
  }

  const finalized = finalizeSemanticMemoryDraft({
    tree: params.tree,
    nodes: drafts,
    edges,
  });
  return {
    ...finalized,
    relations: [],
  };
}

function buildLinkedInSemanticMemoryTree(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
}): SemanticIntegrationTreeBuildResult {
  const drafts: SemanticMemoryDraftNode[] = [];
  const edges: SemanticMemoryDraftEdge[] = [];
  const rootNodeId = semanticIntegrationRootNodeId(params.tree.treeId);
  const rootPath = semanticIntegrationTreeRelativePath(params.tree.slug);
  drafts.push({
    nodeId: rootNodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    path: rootPath,
    title: `${params.tree.accountLabel} LinkedIn connection`,
    summary: params.tree.summary ?? `LinkedIn connection memory for ${params.tree.accountLabel}.`,
    observedAt: params.tree.updatedAt,
    metadata: {
      provider: params.tree.provider,
      account_key: params.tree.accountKey,
      account_label: params.tree.accountLabel,
    },
  });

  let rootChildPosition = 1;
  const profileLeaf = params.leaves.find((leaf) => leaf.branchKey === "profile" && !leaf.entityKey) ?? null;
  if (profileLeaf) {
    const profileNodeId = `semantic:integration:${params.tree.treeId}:profile`;
    const profilePath = semanticChildRelativePath(rootPath, "profile");
    drafts.push({
      nodeId: profileNodeId,
      nodeClass: "semantic",
      nodeKind: "profile",
      path: profilePath,
      title: "Profile",
      summary: profileLeaf.summary,
      observedAt: profileLeaf.observedAt ?? profileLeaf.updatedAt,
      metadata: {
        source_leaf_id: profileLeaf.leafId,
      },
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: profileNodeId, position: rootChildPosition++ });
    appendSemanticLeafNode({
      drafts,
      edges,
      treeId: params.tree.treeId,
      parentNodeId: profileNodeId,
      parentPath: profilePath,
      position: 1,
      leaf: profileLeaf,
      body: params.leafBodies.get(profileLeaf.leafId) ?? fallbackLeafBody(profileLeaf),
    });
  }

  const postGroups = new Map<string, { title: string; leaves: IntegrationLeafRecord[] }>();
  const accountBranchGroups = new Map<string, IntegrationLeafRecord[]>();
  for (const leaf of params.leaves) {
    if (leaf.entityKey?.startsWith("post:")) {
      const postId = leaf.entityKey.slice("post:".length);
      const group = postGroups.get(postId) ?? {
        title: leaf.entityLabel ?? leaf.title,
        leaves: [],
      };
      group.leaves.push(leaf);
      postGroups.set(postId, group);
      continue;
    }
    if (!leaf.entityKey && leaf.branchKey && leaf.branchKey !== "profile") {
      const bucket = accountBranchGroups.get(leaf.branchKey) ?? [];
      bucket.push(leaf);
      accountBranchGroups.set(leaf.branchKey, bucket);
    }
  }

  if (postGroups.size > 0) {
    const postsNodeId = `semantic:integration:${params.tree.treeId}:posts`;
    const postsPath = semanticChildRelativePath(rootPath, "posts");
    drafts.push({
      nodeId: postsNodeId,
      nodeClass: "semantic",
      nodeKind: "posts",
      path: postsPath,
      title: "Posts",
      summary: null,
      observedAt: params.tree.updatedAt,
      isMaterialized: true,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: postsNodeId, position: rootChildPosition++ });

    const branchOrder = ["overview"];
    const sortedPosts = Array.from(postGroups.entries()).sort((left, right) => {
      const leftObservedAt = left[1].leaves[0]?.observedAt ?? left[1].leaves[0]?.updatedAt ?? "";
      const rightObservedAt = right[1].leaves[0]?.observedAt ?? right[1].leaves[0]?.updatedAt ?? "";
      return rightObservedAt.localeCompare(leftObservedAt) || left[1].title.localeCompare(right[1].title);
    });
    let postPosition = 1;
    for (const [postId, group] of sortedPosts) {
      const postSlug = safePathSegment(postId, "post");
      const postNodeId = `semantic:integration:${params.tree.treeId}:post:${postId}`;
      const postPath = semanticChildRelativePath(postsPath, `post-${postSlug}`);
      const overviewLeaf = group.leaves.find((leaf) => leaf.branchKey === "overview") ?? null;
      drafts.push({
        nodeId: postNodeId,
        nodeClass: "semantic",
        nodeKind: "post",
        path: postPath,
        title: group.title,
        summary: overviewLeaf?.summary ?? null,
        observedAt: overviewLeaf?.observedAt ?? group.leaves[0]?.observedAt ?? null,
        metadata: {
          entity_key: `post:${postId}`,
          external_object_id: overviewLeaf?.externalObjectId ?? postId,
        },
      });
      edges.push({ parentNodeId: postsNodeId, childNodeId: postNodeId, position: postPosition++ });

      const leavesByBranch = new Map<string, IntegrationLeafRecord[]>();
      for (const leaf of group.leaves) {
        const key = leaf.branchKey ?? "items";
        const bucket = leavesByBranch.get(key) ?? [];
        bucket.push(leaf);
        leavesByBranch.set(key, bucket);
      }
      const orderedBranchKeys = [
        ...branchOrder.filter((key) => leavesByBranch.has(key)),
        ...Array.from(leavesByBranch.keys())
          .filter((key) => !branchOrder.includes(key))
          .sort((left, right) => left.localeCompare(right)),
      ];
      let branchPosition = 1;
      for (const branchKey of orderedBranchKeys) {
        const branchLeaves = leavesByBranch.get(branchKey) ?? [];
        const branchNodeId = `semantic:integration:${params.tree.treeId}:post:${postId}:${branchKey}`;
        const branchPath = semanticChildRelativePath(postPath, safePathSegment(branchKey, "facet"));
        drafts.push({
          nodeId: branchNodeId,
          nodeClass: "semantic",
          nodeKind: branchKey,
          path: branchPath,
          title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
          summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
          observedAt: branchLeaves[0]?.observedAt ?? null,
        });
        edges.push({ parentNodeId: postNodeId, childNodeId: branchNodeId, position: branchPosition++ });
        let leafPosition = 1;
        for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
          appendSemanticLeafNode({
            drafts,
            edges,
            treeId: params.tree.treeId,
            parentNodeId: branchNodeId,
            parentPath: branchPath,
            position: leafPosition++,
            leaf,
            body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
          });
        }
      }
    }
  }

  const sortedAccountBranches = Array.from(accountBranchGroups.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  for (const [branchKey, branchLeaves] of sortedAccountBranches) {
    const branchNodeId = `semantic:integration:${params.tree.treeId}:account:${branchKey}`;
    const branchPath = semanticChildRelativePath(rootPath, safePathSegment(branchKey, "facet"));
    drafts.push({
      nodeId: branchNodeId,
      nodeClass: "semantic",
      nodeKind: branchKey,
      path: branchPath,
      title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
      summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
      observedAt: branchLeaves[0]?.observedAt ?? null,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: branchNodeId, position: rootChildPosition++ });
    let leafPosition = 1;
    for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
      appendSemanticLeafNode({
        drafts,
        edges,
        treeId: params.tree.treeId,
        parentNodeId: branchNodeId,
        parentPath: branchPath,
        position: leafPosition++,
        leaf,
        body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
      });
    }
  }

  const finalized = finalizeSemanticMemoryDraft({
    tree: params.tree,
    nodes: drafts,
    edges,
  });
  return {
    ...finalized,
    relations: [],
  };
}

function buildSlackSemanticMemoryTree(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
}): SemanticIntegrationTreeBuildResult {
  const drafts: SemanticMemoryDraftNode[] = [];
  const edges: SemanticMemoryDraftEdge[] = [];
  const rootNodeId = semanticIntegrationRootNodeId(params.tree.treeId);
  const rootPath = semanticIntegrationTreeRelativePath(params.tree.slug);
  drafts.push({
    nodeId: rootNodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    path: rootPath,
    title: `${params.tree.accountLabel} Slack connection`,
    summary: params.tree.summary ?? `Slack connection memory for ${params.tree.accountLabel}.`,
    observedAt: params.tree.updatedAt,
    metadata: {
      provider: params.tree.provider,
      account_key: params.tree.accountKey,
      account_label: params.tree.accountLabel,
    },
  });

  let rootChildPosition = 1;
  const profileLeaf = params.leaves.find((leaf) => leaf.branchKey === "profile" && !leaf.entityKey) ?? null;
  if (profileLeaf) {
    const profileNodeId = `semantic:integration:${params.tree.treeId}:profile`;
    const profilePath = semanticChildRelativePath(rootPath, "profile");
    drafts.push({
      nodeId: profileNodeId,
      nodeClass: "semantic",
      nodeKind: "profile",
      path: profilePath,
      title: "Profile",
      summary: profileLeaf.summary,
      observedAt: profileLeaf.observedAt ?? profileLeaf.updatedAt,
      metadata: {
        source_leaf_id: profileLeaf.leafId,
      },
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: profileNodeId, position: rootChildPosition++ });
    appendSemanticLeafNode({
      drafts,
      edges,
      treeId: params.tree.treeId,
      parentNodeId: profileNodeId,
      parentPath: profilePath,
      position: 1,
      leaf: profileLeaf,
      body: params.leafBodies.get(profileLeaf.leafId) ?? fallbackLeafBody(profileLeaf),
    });
  }

  const channelGroups = new Map<string, { title: string; leaves: IntegrationLeafRecord[] }>();
  const accountBranchGroups = new Map<string, IntegrationLeafRecord[]>();
  for (const leaf of params.leaves) {
    if (leaf.entityKey?.startsWith("channel:")) {
      const channelId = leaf.entityKey.slice("channel:".length);
      const group = channelGroups.get(channelId) ?? {
        title: leaf.entityLabel ?? leaf.title,
        leaves: [],
      };
      group.leaves.push(leaf);
      channelGroups.set(channelId, group);
      continue;
    }
    if (!leaf.entityKey && leaf.branchKey && leaf.branchKey !== "profile") {
      const bucket = accountBranchGroups.get(leaf.branchKey) ?? [];
      bucket.push(leaf);
      accountBranchGroups.set(leaf.branchKey, bucket);
    }
  }

  if (channelGroups.size > 0) {
    const channelsNodeId = `semantic:integration:${params.tree.treeId}:channels`;
    const channelsPath = semanticChildRelativePath(rootPath, "channels");
    drafts.push({
      nodeId: channelsNodeId,
      nodeClass: "semantic",
      nodeKind: "channels",
      path: channelsPath,
      title: "Channels",
      summary: null,
      observedAt: params.tree.updatedAt,
      isMaterialized: true,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: channelsNodeId, position: rootChildPosition++ });

    const branchOrder = ["overview", "messages", "threads"];
    const sortedChannels = Array.from(channelGroups.entries()).sort((left, right) => left[1].title.localeCompare(right[1].title));
    let channelPosition = 1;
    for (const [channelId, group] of sortedChannels) {
      const channelSlug = safePathSegment(channelId, "channel");
      const channelNodeId = `semantic:integration:${params.tree.treeId}:channel:${channelId}`;
      const channelPath = semanticChildRelativePath(channelsPath, `channel-${channelSlug}`);
      const overviewLeaf = group.leaves.find((leaf) => leaf.branchKey === "overview") ?? null;
      drafts.push({
        nodeId: channelNodeId,
        nodeClass: "semantic",
        nodeKind: "channel",
        path: channelPath,
        title: group.title,
        summary: overviewLeaf?.summary ?? null,
        observedAt: overviewLeaf?.observedAt ?? group.leaves[0]?.observedAt ?? null,
        metadata: {
          entity_key: `channel:${channelId}`,
          external_object_id: overviewLeaf?.externalObjectId ?? channelId,
        },
      });
      edges.push({ parentNodeId: channelsNodeId, childNodeId: channelNodeId, position: channelPosition++ });

      const leavesByBranch = new Map<string, IntegrationLeafRecord[]>();
      for (const leaf of group.leaves) {
        const key = leaf.branchKey ?? "items";
        const bucket = leavesByBranch.get(key) ?? [];
        bucket.push(leaf);
        leavesByBranch.set(key, bucket);
      }
      const orderedBranchKeys = [
        ...branchOrder.filter((key) => leavesByBranch.has(key)),
        ...Array.from(leavesByBranch.keys())
          .filter((key) => !branchOrder.includes(key))
          .sort((left, right) => left.localeCompare(right)),
      ];
      let branchPosition = 1;
      for (const branchKey of orderedBranchKeys) {
        const branchLeaves = leavesByBranch.get(branchKey) ?? [];
        const branchNodeId = `semantic:integration:${params.tree.treeId}:channel:${channelId}:${branchKey}`;
        const branchPath = semanticChildRelativePath(channelPath, safePathSegment(branchKey, "facet"));
        drafts.push({
          nodeId: branchNodeId,
          nodeClass: "semantic",
          nodeKind: branchKey,
          path: branchPath,
          title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
          summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
          observedAt: branchLeaves[0]?.observedAt ?? null,
        });
        edges.push({ parentNodeId: channelNodeId, childNodeId: branchNodeId, position: branchPosition++ });
        let leafPosition = 1;
        for (const leaf of branchLeaves.sort((left, right) =>
          (right.observedAt ?? right.updatedAt).localeCompare(left.observedAt ?? left.updatedAt)
          || left.title.localeCompare(right.title),
        )) {
          appendSemanticLeafNode({
            drafts,
            edges,
            treeId: params.tree.treeId,
            parentNodeId: branchNodeId,
            parentPath: branchPath,
            position: leafPosition++,
            leaf,
            body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
          });
        }
      }
    }
  }

  const sortedAccountBranches = Array.from(accountBranchGroups.entries()).sort((left, right) => left[0].localeCompare(right[0]));
  for (const [branchKey, branchLeaves] of sortedAccountBranches) {
    const branchNodeId = `semantic:integration:${params.tree.treeId}:account:${branchKey}`;
    const branchPath = semanticChildRelativePath(rootPath, safePathSegment(branchKey, "facet"));
    drafts.push({
      nodeId: branchNodeId,
      nodeClass: "semantic",
      nodeKind: branchKey,
      path: branchPath,
      title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
      summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
      observedAt: branchLeaves[0]?.observedAt ?? null,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: branchNodeId, position: rootChildPosition++ });
    let leafPosition = 1;
    for (const leaf of branchLeaves.sort((left, right) => left.title.localeCompare(right.title))) {
      appendSemanticLeafNode({
        drafts,
        edges,
        treeId: params.tree.treeId,
        parentNodeId: branchNodeId,
        parentPath: branchPath,
        position: leafPosition++,
        leaf,
        body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
      });
    }
  }

  const finalized = finalizeSemanticMemoryDraft({
    tree: params.tree,
    nodes: drafts,
    edges,
  });
  return {
    ...finalized,
    relations: [],
  };
}

function buildBranchOnlyIntegrationSemanticMemoryTree(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
  connectionTitle: string;
  defaultSummary: string;
  branchOrder?: string[];
}): SemanticIntegrationTreeBuildResult {
  const drafts: SemanticMemoryDraftNode[] = [];
  const edges: SemanticMemoryDraftEdge[] = [];
  const rootNodeId = semanticIntegrationRootNodeId(params.tree.treeId);
  const rootPath = semanticIntegrationTreeRelativePath(params.tree.slug);
  drafts.push({
    nodeId: rootNodeId,
    nodeClass: "semantic",
    nodeKind: "connection",
    path: rootPath,
    title: params.connectionTitle,
    summary: params.tree.summary ?? params.defaultSummary,
    observedAt: params.tree.updatedAt,
    metadata: {
      provider: params.tree.provider,
      account_key: params.tree.accountKey,
      account_label: params.tree.accountLabel,
    },
  });

  let rootChildPosition = 1;
  const profileLeaf = params.leaves.find((leaf) => leaf.branchKey === "profile" && !leaf.entityKey) ?? null;
  if (profileLeaf) {
    const profileNodeId = `semantic:integration:${params.tree.treeId}:profile`;
    const profilePath = semanticChildRelativePath(rootPath, "profile");
    drafts.push({
      nodeId: profileNodeId,
      nodeClass: "semantic",
      nodeKind: "profile",
      path: profilePath,
      title: "Profile",
      summary: profileLeaf.summary,
      observedAt: profileLeaf.observedAt ?? profileLeaf.updatedAt,
      metadata: {
        source_leaf_id: profileLeaf.leafId,
      },
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: profileNodeId, position: rootChildPosition++ });
    appendSemanticLeafNode({
      drafts,
      edges,
      treeId: params.tree.treeId,
      parentNodeId: profileNodeId,
      parentPath: profilePath,
      position: 1,
      leaf: profileLeaf,
      body: params.leafBodies.get(profileLeaf.leafId) ?? fallbackLeafBody(profileLeaf),
    });
  }

  const branchGroups = new Map<string, IntegrationLeafRecord[]>();
  for (const leaf of params.leaves) {
    if (!leaf.branchKey || leaf.branchKey === "profile") {
      continue;
    }
    const bucket = branchGroups.get(leaf.branchKey) ?? [];
    bucket.push(leaf);
    branchGroups.set(leaf.branchKey, bucket);
  }

  const preferredOrder = params.branchOrder ?? [];
  const orderedBranchKeys = [
    ...preferredOrder.filter((key) => branchGroups.has(key)),
    ...Array.from(branchGroups.keys())
      .filter((key) => !preferredOrder.includes(key))
      .sort((left, right) => left.localeCompare(right)),
  ];
  for (const branchKey of orderedBranchKeys) {
    const branchLeaves = branchGroups.get(branchKey) ?? [];
    const branchNodeId = `semantic:integration:${params.tree.treeId}:account:${branchKey}`;
    const branchPath = semanticChildRelativePath(rootPath, safePathSegment(branchKey, "facet"));
    drafts.push({
      nodeId: branchNodeId,
      nodeClass: "semantic",
      nodeKind: branchKey,
      path: branchPath,
      title: semanticBranchTitle(branchKey, branchLeaves[0]?.branchLabel ?? null),
      summary: branchLeaves.length === 1 ? branchLeaves[0]?.summary ?? null : null,
      observedAt: branchLeaves[0]?.observedAt ?? null,
    });
    edges.push({ parentNodeId: rootNodeId, childNodeId: branchNodeId, position: rootChildPosition++ });
    let leafPosition = 1;
    for (const leaf of branchLeaves.sort((left, right) =>
      (right.observedAt ?? right.updatedAt).localeCompare(left.observedAt ?? left.updatedAt)
      || left.title.localeCompare(right.title),
    )) {
      appendSemanticLeafNode({
        drafts,
        edges,
        treeId: params.tree.treeId,
        parentNodeId: branchNodeId,
        parentPath: branchPath,
        position: leafPosition++,
        leaf,
        body: params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf),
      });
    }
  }

  const finalized = finalizeSemanticMemoryDraft({
    tree: params.tree,
    nodes: drafts,
    edges,
  });
  return {
    ...finalized,
    relations: [],
  };
}

function buildSemanticIntegrationTree(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
  relations: IntegrationRelationInput[];
}): SemanticIntegrationTreeBuildResult | null {
  switch (params.tree.provider) {
    case "notion":
      return buildNotionSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
      });
    case "github":
      return buildGitHubSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
      });
    case "gmail":
      return buildGmailSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
        relations: params.relations,
      });
    case "googlecalendar":
      return buildGoogleCalendarSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
      });
    case "googledrive":
      return buildGoogleDriveSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
      });
    case "twitter":
      return buildTwitterSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
      });
    case "linkedin":
      return buildLinkedInSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
      });
    case "slack":
      return buildSlackSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
      });
    case "outlook":
      return buildBranchOnlyIntegrationSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
        connectionTitle: `${params.tree.accountLabel} Outlook connection`,
        defaultSummary: `Outlook connection memory for ${params.tree.accountLabel}.`,
        branchOrder: ["messages", "contacts", "events"],
      });
    case "googlesheets":
      return buildBranchOnlyIntegrationSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
        connectionTitle: `${params.tree.accountLabel} Google Sheets connection`,
        defaultSummary: `Google Sheets connection memory for ${params.tree.accountLabel}.`,
        branchOrder: ["spreadsheets", "worksheets", "values"],
      });
    case "googledocs":
      return buildBranchOnlyIntegrationSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
        connectionTitle: `${params.tree.accountLabel} Google Docs connection`,
        defaultSummary: `Google Docs connection memory for ${params.tree.accountLabel}.`,
        branchOrder: ["documents", "content"],
      });
    case "hubspot":
      return buildBranchOnlyIntegrationSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
        connectionTitle: `${params.tree.accountLabel} HubSpot connection`,
        defaultSummary: `HubSpot connection memory for ${params.tree.accountLabel}.`,
        branchOrder: ["contacts", "companies", "deals"],
      });
    case "linear":
      return buildBranchOnlyIntegrationSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
        connectionTitle: `${params.tree.accountLabel} Linear connection`,
        defaultSummary: `Linear connection memory for ${params.tree.accountLabel}.`,
        branchOrder: ["issues", "projects", "teams", "users", "issue_drafts"],
      });
    case "jira":
      return buildBranchOnlyIntegrationSemanticMemoryTree({
        tree: params.tree,
        leaves: params.leaves,
        leafBodies: params.leafBodies,
        connectionTitle: `${params.tree.accountLabel} Jira connection`,
        defaultSummary: `Jira connection memory for ${params.tree.accountLabel}.`,
        branchOrder: ["projects", "issues", "users"],
      });
    default:
      return null;
  }
}

function semanticSearchDocsForIntegrationTree(params: {
  semantic: SemanticIntegrationTreeBuildResult;
}) {
  return params.semantic.nodes.map((node) => {
    const bodyText = params.semantic.bodiesByPath.get(node.path) ?? "";
    return {
      nodeId: node.nodeId,
      nodeClass: node.nodeClass,
      nodeKind: node.nodeKind,
      path: node.path,
      childCount: node.childCount,
      title: node.title,
      summary: node.summary,
      bodyText,
      excerpt: bodyText ? markdownExcerpt(bodyText, 320) : null,
      observedAt: node.observedAt ?? null,
      status: "active" as const,
    };
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function absolutePathForRelative(workspaceRoot: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  return path.join(globalMemoryDirForWorkspaceRoot(workspaceRoot), normalized);
}

function writeFileIfChanged(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    if (existing === content) {
      return;
    }
  }
  fs.writeFileSync(filePath, content, "utf8");
}

function readFileIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return null;
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function removeObsoleteFiles(rootDir: string, keepAbsolutePaths: Set<string>): void {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  const walk = (currentPath: string): void => {
    for (const childName of fs.readdirSync(currentPath)) {
      const childPath = path.join(currentPath, childName);
      const stats = fs.lstatSync(childPath);
      if (stats.isDirectory()) {
        walk(childPath);
        if (fs.existsSync(childPath) && fs.readdirSync(childPath).length === 0) {
          fs.rmdirSync(childPath);
        }
        continue;
      }
      if (!keepAbsolutePaths.has(path.resolve(childPath))) {
        fs.rmSync(childPath, { force: true });
      }
    }
  };
  walk(rootDir);
  if (fs.existsSync(rootDir) && fs.readdirSync(rootDir).length === 0) {
    fs.rmdirSync(rootDir);
  }
}

function markdownExcerpt(text: string, maxChars = EMBEDDING_EXCERPT_CHARS): string {
  const content = text
    .replace(/^\uFEFF/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("#"))
    .join(" ");
  return clipText(content, maxChars);
}

function buildEmbeddingText(params: {
  treeLabel: string;
  provider: string;
  title: string;
  summary: string;
  excerpt: string;
  nodeKind: InteractionTreeChildKind;
}): string {
  return [
    `Integration account: ${params.treeLabel}`,
    `Provider: ${params.provider}`,
    `Node kind: ${params.nodeKind}`,
    `Title: ${params.title}`,
    `Summary: ${params.summary}`,
    `Excerpt: ${params.excerpt || "none"}`,
  ].join("\n");
}

function integrationTreeIdentity(params: {
  provider: string;
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
}): { treeId: string; slug: string } {
  const providerSlug = safePathSegment(params.provider, "provider");
  const labelSlug = safePathSegment(params.accountLabel || params.accountKey, "account");
  const accountHash = sha256(`${params.provider}|${params.ownerUserId}|${params.accountKey}`).slice(0, 12);
  return {
    treeId: `integration:${providerSlug}:${accountHash}`,
    slug: `${providerSlug}-${labelSlug}-${accountHash}`,
  };
}

function ensureIntegrationTree(params: {
  store: RuntimeStateStore;
  provider: string;
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  summary?: string | null;
}): IntegrationTreeRecord {
  const identity = integrationTreeIdentity(params);
  const existing = params.store.getIntegrationTree({ treeId: identity.treeId })
    ?? params.store.getIntegrationTreeByAccountIdentity({
      provider: params.provider,
      ownerUserId: params.ownerUserId,
      accountKey: params.accountKey,
    })
    ?? params.store.getIntegrationTreeBySlug({ slug: identity.slug });
  if (existing) {
    return params.store.upsertIntegrationTree({
      treeId: existing.treeId,
      provider: params.provider,
      ownerUserId: params.ownerUserId,
      accountKey: params.accountKey,
      accountLabel: params.accountLabel,
      slug: existing.slug,
      summary: params.summary ?? existing.summary,
      status: existing.status,
    });
  }
  return params.store.upsertIntegrationTree({
    treeId: identity.treeId,
    provider: params.provider,
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    slug: identity.slug,
    summary: params.summary ?? null,
    status: "active",
  });
}

function summaryNodeBody(params: {
  tree: IntegrationTreeRecord;
  title: string;
  summary: string;
  children: Array<{ title: string; summary: string }>;
}): string {
  const lines = [
    `# ${params.title}`,
    "",
    `- Tree: \`${params.tree.treeId}\``,
    `- Provider: ${params.tree.provider}`,
    `- Account: ${params.tree.accountLabel}`,
    `- Child count: ${params.children.length}`,
    "",
    "## Summary",
    "",
    params.summary,
    "",
    "## Covered nodes",
    "",
    ...params.children.map((child) => `- **${child.title}**: ${child.summary}`),
    "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

function deterministicSummaryText(params: {
  scopeLabel: string;
  childCount: number;
  childTitles: string[];
}): string {
  return clipText(
    `${params.scopeLabel} covering ${params.childCount} nodes: ${params.childTitles.slice(0, 4).join(", ")}`,
    240,
  );
}

async function generateSummaryText(params: {
  tree: IntegrationTreeRecord;
  title: string;
  scopeLabel: string;
  children: Array<{
    kind: InteractionTreeChildKind;
    id: string;
    title: string;
    summary: string;
    excerpt: string | null;
  }>;
  ordinal: number;
  modelClient: MemoryModelClientConfig | null;
}): Promise<string> {
  const fallback = deterministicSummaryText({
    scopeLabel: params.scopeLabel,
    childCount: params.children.length,
    childTitles: params.children.map((child) => child.title),
  });
  if (!params.modelClient) {
    return fallback;
  }
  const payload = await queryMemoryModelJson(params.modelClient, {
    systemPrompt: [
      "You write concise markdown-tree summary sentences for durable integration memory nodes.",
      "Return strict JSON only with this shape:",
      '{"summary":"string"}',
      "Write a faithful 1-3 sentence summary of the child nodes.",
      "Do not invent facts not present in the child summaries.",
      "Prefer concrete reusable knowledge over generic phrasing.",
    ].join(" "),
    userPrompt: [
      `Tree ID: ${params.tree.treeId}`,
      `Provider: ${params.tree.provider}`,
      `Account: ${params.tree.accountLabel}`,
      `Summary title: ${params.title}`,
      `Scope: ${params.scopeLabel}`,
      `Branch ordinal: ${params.ordinal}`,
      `Child count: ${params.children.length}`,
      "",
      "Child nodes:",
      ...params.children.map((child, index) => [
        `${index + 1}. Kind: ${child.kind}`,
        `   Title: ${child.title}`,
        `   Summary: ${child.summary}`,
        child.excerpt ? `   Excerpt: ${clipText(child.excerpt, 280)}` : null,
      ].filter(Boolean).join("\n")),
    ].join("\n"),
    timeoutMs: 8000,
  });
  const summary = typeof payload?.summary === "string" ? compactWhitespace(payload.summary) : "";
  return summary ? clipText(summary, 320) : fallback;
}

async function buildTempSummaryNode(params: {
  tree: IntegrationTreeRecord;
  title: string;
  scopeLabel: string;
  children: Array<{
    kind: InteractionTreeChildKind;
    id: string;
    title: string;
    summary: string;
    excerpt: string | null;
  }>;
  ordinal: number;
  modelClient: MemoryModelClientConfig | null;
  root?: boolean;
  entitySlug?: string | null;
  branchSlug?: string | null;
}): Promise<TempSummaryNode> {
  const summary = await generateSummaryText({
    tree: params.tree,
    title: params.title,
    scopeLabel: params.scopeLabel,
    children: params.children,
    ordinal: params.ordinal,
    modelClient: params.modelClient,
  });
  const body = summaryNodeBody({
    tree: params.tree,
    title: params.title,
    summary,
    children: params.children.map((child) => ({
      title: child.title,
      summary: child.summary,
    })),
  });
  return {
    tempId: sha256(JSON.stringify({
      treeId: params.tree.treeId,
      title: params.title,
      root: params.root ?? false,
      entitySlug: params.entitySlug ?? null,
      branchSlug: params.branchSlug ?? null,
      ordinal: params.ordinal,
      children: params.children.map((child) => `${child.kind}:${child.id}`),
    })).slice(0, 24),
    title: params.title,
    summary,
    body,
    root: params.root ?? false,
    entitySlug: params.entitySlug ?? null,
    branchSlug: params.branchSlug ?? null,
    children: params.children,
  };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function summaryNodeAsChild(node: TempSummaryNode): TempSummaryChild {
  return {
    kind: "summary",
    id: node.tempId,
    title: node.title,
    summary: node.summary,
    excerpt: markdownExcerpt(node.body),
  };
}

async function buildBranchSummarySubtree(params: {
  tree: IntegrationTreeRecord;
  title: string;
  scopeLabel: string;
  children: TempSummaryChild[];
  entitySlug?: string | null;
  branchSlug?: string | null;
  modelClient: MemoryModelClientConfig | null;
}): Promise<{ root: TempSummaryNode; nodes: TempSummaryNode[] }> {
  const nodes: TempSummaryNode[] = [];
  let current = params.children;
  let chunkOrdinal = 1;
  while (current.length > INTEGRATION_BRANCH_FACTOR) {
    const layer = await Promise.all(
      chunkArray(current, INTEGRATION_BRANCH_FACTOR).map((group, index) =>
        buildTempSummaryNode({
          tree: params.tree,
          title: `${params.title} slice ${chunkOrdinal + index}`,
          scopeLabel: `${params.scopeLabel} slice`,
          children: group,
          ordinal: chunkOrdinal + index,
          modelClient: params.modelClient,
          entitySlug: params.entitySlug ?? null,
          branchSlug: params.branchSlug ?? null,
        }),
      ),
    );
    nodes.push(...layer);
    current = layer.map((node) => summaryNodeAsChild(node));
    chunkOrdinal += layer.length;
  }
  const root = await buildTempSummaryNode({
    tree: params.tree,
    title: params.title,
    scopeLabel: params.scopeLabel,
    children: current,
    ordinal: chunkOrdinal,
    modelClient: params.modelClient,
    entitySlug: params.entitySlug ?? null,
    branchSlug: params.branchSlug ?? null,
  });
  nodes.push(root);
  return { root, nodes };
}

function fallbackLeafBody(leaf: IntegrationLeafRecord): string {
  return `# ${leaf.title}\n\n${leaf.summary}\n`;
}

function integrationTreeBody(params: {
  tree: IntegrationTreeRecord;
  leafCount: number;
  summaryCount: number;
}): string {
  const lines = [
    `# ${params.tree.accountLabel}`,
    "",
    `- Tree ID: \`${params.tree.treeId}\``,
    `- Provider: ${params.tree.provider}`,
    `- Owner user: ${params.tree.ownerUserId}`,
    `- Account key: ${params.tree.accountKey}`,
    `- Active leaves: ${params.leafCount}`,
    `- Active summaries: ${params.summaryCount}`,
    "",
    "## Summary",
    "",
    params.tree.summary ?? `${params.tree.accountLabel} integration memory tree.`,
    "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

function integrationEntityBody(params: {
  tree: IntegrationTreeRecord;
  entityKey: string;
  entityLabel: string;
  branchCount: number;
  leafCount: number;
}): string {
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

function integrationBranchBody(params: {
  tree: IntegrationTreeRecord;
  entityLabel: string | null;
  branchKey: string;
  branchLabel: string;
  leafCount: number;
}): string {
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

function integrationEntityNodeId(treeId: string, entityKey: string): string {
  return `entity:integration:${treeId}:${entityKey}`;
}

function integrationTreeNodeId(treeId: string): string {
  return `tree:integration:${treeId}`;
}

function integrationBranchNodeId(treeId: string, entityKey: string | null, branchKey: string): string {
  return `branch:integration:${treeId}:${entityKey ?? "account"}:${branchKey}`;
}

function parseIntegrationEntityNodeId(treeId: string, nodeId: string): string | null {
  const prefix = `entity:integration:${treeId}:`;
  return nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : null;
}

function parseIntegrationBranchNodeId(
  treeId: string,
  nodeId: string,
): { entityKey: string | null; branchKey: string } | null {
  const prefix = `branch:integration:${treeId}:`;
  if (!nodeId.startsWith(prefix)) {
    return null;
  }
  const remainder = nodeId.slice(prefix.length);
  const separator = remainder.indexOf(":");
  if (separator < 0) {
    return null;
  }
  const entityToken = remainder.slice(0, separator);
  const branchKey = remainder.slice(separator + 1);
  return {
    entityKey: entityToken === "account" ? null : entityToken,
    branchKey,
  };
}

interface IntegrationContactEntry {
  entityKey: string;
  email: string;
  label: string;
  relatedThreadIds: string[];
  relatedThreadKeys: string[];
  messageLeafIds: string[];
  roles: string[];
}

function virtualIntegrationContactContent(params: {
  tree: IntegrationTreeRecord;
  entry: IntegrationContactEntry;
  relatedThreadLabels: string[];
}): string {
  const lines = [
    `# ${params.entry.label}`,
    "",
    `- Tree: ${params.tree.accountLabel}`,
    `- Provider: ${params.tree.provider}`,
    `- Email: ${params.entry.email}`,
    `- Related threads: ${params.entry.relatedThreadIds.length}`,
    params.entry.roles.length > 0 ? `- Roles: ${params.entry.roles.join(", ")}` : null,
    "",
    "## Summary",
    "",
    `${params.entry.label} appears in ${params.entry.relatedThreadIds.length} thread${params.entry.relatedThreadIds.length === 1 ? "" : "s"} in this mailbox.`,
    "",
    params.relatedThreadLabels.length > 0 ? "## Related threads" : null,
    params.relatedThreadLabels.length > 0 ? "" : null,
    ...params.relatedThreadLabels.map((label) => `- ${label}`),
    "",
  ].filter((line): line is string => typeof line === "string");
  return `${lines.join("\n").trim()}\n`;
}

function buildIntegrationContactEntries(params: {
  treeId: string;
  relations: IntegrationRelationInput[];
}): Map<string, IntegrationContactEntry> {
  const contacts = new Map<string, IntegrationContactEntry>();
  for (const relation of params.relations) {
    if (relation.relationType !== "participant" || relation.fromNodeKind !== "entity") {
      continue;
    }
    const entityKey = parseIntegrationEntityNodeId(params.treeId, relation.fromNodeId);
    if (!entityKey?.startsWith("contact:")) {
      continue;
    }
    const email = String(relation.metadata.contact_email ?? entityKey.replace(/^contact:/, ""));
    const label = String(relation.metadata.contact_label ?? email);
    const existing = contacts.get(entityKey);
    if (existing) {
      if (!existing.relatedThreadIds.includes(relation.toNodeId)) {
        existing.relatedThreadIds.push(relation.toNodeId);
      }
      const threadKey = String(relation.metadata.thread_entity_key ?? "");
      if (threadKey && !existing.relatedThreadKeys.includes(threadKey)) {
        existing.relatedThreadKeys.push(threadKey);
      }
      for (const leafId of Array.isArray(relation.metadata.message_leaf_ids) ? relation.metadata.message_leaf_ids : []) {
        if (typeof leafId === "string" && !existing.messageLeafIds.includes(leafId)) {
          existing.messageLeafIds.push(leafId);
        }
      }
      for (const role of Array.isArray(relation.metadata.roles) ? relation.metadata.roles : []) {
        if (typeof role === "string" && !existing.roles.includes(role)) {
          existing.roles.push(role);
        }
      }
      continue;
    }
    contacts.set(entityKey, {
      entityKey,
      email,
      label,
      relatedThreadIds: [relation.toNodeId],
      relatedThreadKeys: typeof relation.metadata.thread_entity_key === "string"
        ? [relation.metadata.thread_entity_key]
        : [],
      messageLeafIds: Array.isArray(relation.metadata.message_leaf_ids)
        ? relation.metadata.message_leaf_ids.filter((value): value is string => typeof value === "string")
        : [],
      roles: Array.isArray(relation.metadata.roles)
        ? relation.metadata.roles.filter((value): value is string => typeof value === "string")
        : [],
    });
  }
  return contacts;
}

function markdownBulletValue(body: string, label: string): string | null {
  const pattern = new RegExp(`^\\-\\s+${label}:\\s*(.+)$`, "im");
  const match = body.match(pattern);
  return match?.[1]?.trim() || null;
}

function extractEmailAddresses(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const seen = new Set<string>();
  const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  for (const match of matches) {
    seen.add(match.trim().toLowerCase());
  }
  return Array.from(seen);
}

function buildGmailContactRelations(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
}): Array<{
  fromNodeKind: "entity";
  fromNodeId: string;
  toNodeKind: "entity";
  toNodeId: string;
  relationType: string;
  metadata: Record<string, unknown>;
}> {
  const relationByKey = new Map<string, {
    fromNodeKind: "entity";
    fromNodeId: string;
    toNodeKind: "entity";
    toNodeId: string;
    relationType: string;
    metadata: {
      contact_email: string;
      contact_label: string;
      thread_entity_key: string;
      thread_entity_label: string;
      roles: string[];
      message_leaf_ids: string[];
    };
  }>();

  for (const leaf of params.leaves) {
    if (leaf.branchKey !== "messages" || !leaf.entityKey?.startsWith("thread:")) {
      continue;
    }
    const body = params.leafBodies.get(leaf.leafId) ?? "";
    const threadEntityKey = leaf.entityKey;
    const threadEntityLabel = leaf.entityLabel ?? leaf.title;
    const roles: Array<{ role: string; emails: string[] }> = [
      { role: "from", emails: extractEmailAddresses(markdownBulletValue(body, "From")) },
      { role: "to", emails: extractEmailAddresses(markdownBulletValue(body, "To")) },
      { role: "cc", emails: extractEmailAddresses(markdownBulletValue(body, "Cc")) },
    ];
    for (const { role, emails } of roles) {
      for (const email of emails) {
        const contactKey = `contact:${email}`;
        const relationKey = `${contactKey}::${threadEntityKey}`;
        const existing = relationByKey.get(relationKey);
        if (existing) {
          if (!existing.metadata.roles.includes(role)) {
            existing.metadata.roles.push(role);
          }
          if (!existing.metadata.message_leaf_ids.includes(leaf.leafId)) {
            existing.metadata.message_leaf_ids.push(leaf.leafId);
          }
          continue;
        }
        relationByKey.set(relationKey, {
          fromNodeKind: "entity",
          fromNodeId: integrationEntityNodeId(params.tree.treeId, contactKey),
          toNodeKind: "entity",
          toNodeId: integrationEntityNodeId(params.tree.treeId, threadEntityKey),
          relationType: "participant",
          metadata: {
            contact_email: email,
            contact_label: email,
            thread_entity_key: threadEntityKey,
            thread_entity_label: threadEntityLabel,
            roles: [role],
            message_leaf_ids: [leaf.leafId],
          },
        });
      }
    }
  }

  return Array.from(relationByKey.values()).map((relation) => ({
    fromNodeKind: relation.fromNodeKind,
    fromNodeId: relation.fromNodeId,
    toNodeKind: relation.toNodeKind,
    toNodeId: relation.toNodeId,
    relationType: relation.relationType,
    metadata: relation.metadata,
  }));
}

function buildIntegrationRelations(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  leafBodies: Map<string, string>;
}): Array<{
  fromNodeKind: "entity";
  fromNodeId: string;
  toNodeKind: "entity";
  toNodeId: string;
  relationType: string;
  metadata: Record<string, unknown>;
}> {
  if (params.tree.provider === "gmail") {
    return buildGmailContactRelations(params);
  }
  return [];
}

function canonicalParentContentPath(nodePath: string): string | null {
  const segments = nodePath.split("/").filter(Boolean);
  if (segments.length < 4 || segments[segments.length - 1] !== "content.md") {
    return null;
  }
  if (segments[segments.length - 3] !== "branches") {
    return null;
  }
  return [...segments.slice(0, -3), "content.md"].join("/");
}

function buildIntegrationCanonicalNodesAndEdges(params: {
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  summaries: Awaited<ReturnType<typeof buildSummaryTreePlan>>["nodes"];
  leafBodies: Map<string, string>;
  relations: Array<{
    fromNodeKind: "entity";
    fromNodeId: string;
    toNodeKind: "entity";
    toNodeId: string;
    relationType: string;
    metadata: Record<string, unknown>;
  }>;
}): {
  nodes: Array<{
    nodeId: string;
    nodeKind: MemoryNodeKind;
    path: string;
    title: string;
    summary: string;
    bodySha256: string;
    level: number | null;
    ordinal: number | null;
    childCount: number;
    observedAt: string | null;
    metadata: Record<string, unknown>;
  }>;
  edges: Array<{
    parentNodeId: string;
    childNodeId: string;
    position: number;
  }>;
  bodiesByPath: Map<string, string>;
} {
  const nodes = new Map<string, {
    nodeId: string;
    nodeKind: MemoryNodeKind;
    path: string;
    title: string;
    summary: string;
    bodySha256: string;
    level: number | null;
    ordinal: number | null;
    observedAt: string | null;
    metadata: Record<string, unknown>;
  }>();
  const bodiesByPath = new Map<string, string>();
  const treePath = path.posix.join(...integrationTreeBaseSegments(params.tree.slug), "content.md");
  const treeBody = integrationTreeBody({
    tree: params.tree,
    leafCount: params.leaves.length,
    summaryCount: params.summaries.length,
  });
  nodes.set(integrationTreeNodeId(params.tree.treeId), {
    nodeId: integrationTreeNodeId(params.tree.treeId),
    nodeKind: "tree",
    path: treePath,
    title: params.tree.accountLabel,
    summary: params.tree.summary ?? `${params.tree.accountLabel} integration memory tree.`,
    bodySha256: sha256(treeBody),
    level: 0,
    ordinal: 1,
    observedAt: params.tree.updatedAt,
    metadata: {
      provider: params.tree.provider,
      owner_user_id: params.tree.ownerUserId,
      account_key: params.tree.accountKey,
      account_label: params.tree.accountLabel,
    },
  });
  bodiesByPath.set(treePath, treeBody);

  const scopeGroups = new Map<string, {
    entityKey: string | null;
    entityLabel: string | null;
    entitySlug: string | null;
    branchKey: string | null;
    branchLabel: string | null;
    branchSlug: string | null;
    leaves: IntegrationLeafRecord[];
  }>();
  for (const leaf of params.leaves) {
    const scopeKey = `${leaf.entityKey ?? "__account__"}::${leaf.branchKey ?? "__none__"}`;
    const existing = scopeGroups.get(scopeKey);
    if (existing) {
      existing.leaves.push(leaf);
      continue;
    }
    scopeGroups.set(scopeKey, {
      entityKey: leaf.entityKey ?? null,
      entityLabel: leaf.entityLabel ?? null,
      entitySlug: integrationEntitySlug(leaf.entityKey, leaf.entityLabel),
      branchKey: leaf.branchKey ?? null,
      branchLabel: leaf.branchLabel ?? null,
      branchSlug: integrationBranchSlug(leaf.branchKey, leaf.branchLabel),
      leaves: [leaf],
    });
  }

  const entityBuckets = new Map<string, Array<{
    entityKey: string;
    entityLabel: string;
    entitySlug: string;
    branchCount: number;
    leafCount: number;
  }>>();
  for (const scope of scopeGroups.values()) {
    if (!scope.entityKey || !scope.entitySlug) {
      continue;
    }
    const body = integrationEntityBody({
      tree: params.tree,
      entityKey: scope.entityKey,
      entityLabel: scope.entityLabel ?? scope.entityKey,
      branchCount: 0,
      leafCount: 0,
    });
    bodiesByPath.set(
      path.posix.join(...integrationEntitySegments(params.tree.slug, scope.entitySlug), "content.md"),
      body,
    );
  }
  const entityStats = new Map<string, { label: string; slug: string; branchCount: number; leafCount: number }>();
  for (const scope of scopeGroups.values()) {
    if (!scope.entityKey || !scope.entitySlug) {
      continue;
    }
    const stat = entityStats.get(scope.entityKey) ?? {
      label: scope.entityLabel ?? scope.entityKey,
      slug: scope.entitySlug,
      branchCount: 0,
      leafCount: 0,
    };
    if (scope.branchKey) {
      stat.branchCount += 1;
    }
    stat.leafCount += scope.leaves.length;
    entityStats.set(scope.entityKey, stat);
  }
  for (const [entityKey, stat] of entityStats) {
    const entityPath = path.posix.join(...integrationEntitySegments(params.tree.slug, stat.slug), "content.md");
    const entityBody = integrationEntityBody({
      tree: params.tree,
      entityKey,
      entityLabel: stat.label,
      branchCount: stat.branchCount,
      leafCount: stat.leafCount,
    });
    nodes.set(integrationEntityNodeId(params.tree.treeId, entityKey), {
      nodeId: integrationEntityNodeId(params.tree.treeId, entityKey),
      nodeKind: "entity",
      path: entityPath,
      title: stat.label,
      summary: `${stat.label} in ${params.tree.accountLabel}.`,
      bodySha256: sha256(entityBody),
      level: 1,
      ordinal: null,
      observedAt: params.tree.updatedAt,
      metadata: {
        entity_key: entityKey,
        entity_label: stat.label,
      },
    });
    bodiesByPath.set(entityPath, entityBody);
  }

  for (const scope of scopeGroups.values()) {
    if (!scope.branchKey || !scope.branchSlug) {
      continue;
    }
    const branchPath = path.posix.join(
      ...integrationBranchSegments({
        treeSlug: params.tree.slug,
        entitySlug: scope.entitySlug ?? null,
        branchSlug: scope.branchSlug,
      }),
      "content.md",
    );
    const branchBody = integrationBranchBody({
      tree: params.tree,
      entityLabel: scope.entityLabel ?? null,
      branchKey: scope.branchKey,
      branchLabel: scope.branchLabel ?? scope.branchKey,
      leafCount: scope.leaves.length,
    });
    nodes.set(integrationBranchNodeId(params.tree.treeId, scope.entityKey ?? null, scope.branchKey), {
      nodeId: integrationBranchNodeId(params.tree.treeId, scope.entityKey ?? null, scope.branchKey),
      nodeKind: "branch",
      path: branchPath,
      title: scope.branchLabel ?? scope.branchKey,
      summary: `${scope.branchLabel ?? scope.branchKey} in ${params.tree.accountLabel}.`,
      bodySha256: sha256(branchBody),
      level: scope.entityKey ? 2 : 1,
      ordinal: null,
      observedAt: params.tree.updatedAt,
      metadata: {
        entity_key: scope.entityKey,
        branch_key: scope.branchKey,
        branch_label: scope.branchLabel ?? scope.branchKey,
      },
    });
    bodiesByPath.set(branchPath, branchBody);
  }

  for (const summary of params.summaries) {
    nodes.set(summary.nodeId, {
      nodeId: summary.nodeId,
      nodeKind: "summary",
      path: summary.path,
      title: summary.title,
      summary: summary.summary,
      bodySha256: summary.bodySha256,
      level: summary.level,
      ordinal: summary.ordinal,
      observedAt: summary.sealedAt,
      metadata: {
        source: "integration_summary",
      },
    });
  }

  for (const leaf of params.leaves) {
    const body = params.leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf);
    nodes.set(leaf.leafId, {
      nodeId: leaf.leafId,
      nodeKind: "leaf",
      path: leaf.path,
      title: leaf.title,
      summary: leaf.summary,
      bodySha256: sha256(body),
      level: null,
      ordinal: null,
      observedAt: leaf.observedAt ?? leaf.updatedAt,
      metadata: {
        subject_key: leaf.subjectKey,
        entity_key: leaf.entityKey,
        branch_key: leaf.branchKey,
        external_object_id: leaf.externalObjectId,
        external_object_type: leaf.externalObjectType,
        source_type: leaf.sourceType,
        source_event_id: leaf.sourceEventId,
        source_message_id: leaf.sourceMessageId,
        tags: leaf.tags,
      },
    });
    bodiesByPath.set(leaf.path, body);
  }

  const contactBranchPath = path.posix.join(
    ...integrationBranchSegments({
      treeSlug: params.tree.slug,
      entitySlug: null,
      branchSlug: "contacts",
    }),
    "content.md",
  );
  const contactRelations = params.relations.filter((relation) => relation.relationType === "participant");
  if (contactRelations.length > 0) {
    const contactBranchBody = [
      "# Contacts",
      "",
      `- Tree: ${params.tree.accountLabel}`,
      `- Provider: ${params.tree.provider}`,
      `- Contact count: ${new Set(contactRelations.map((relation) => relation.fromNodeId)).size}`,
      "",
      "## Summary",
      "",
      `Derived contacts for ${params.tree.accountLabel}.`,
      "",
    ].join("\n");
    nodes.set(integrationBranchNodeId(params.tree.treeId, null, "contacts"), {
      nodeId: integrationBranchNodeId(params.tree.treeId, null, "contacts"),
      nodeKind: "branch",
      path: contactBranchPath,
      title: "Contacts",
      summary: `Derived contacts for ${params.tree.accountLabel}.`,
      bodySha256: sha256(contactBranchBody),
      level: 1,
      ordinal: null,
      observedAt: params.tree.updatedAt,
      metadata: {
        branch_key: "contacts",
        derived: true,
      },
    });
    bodiesByPath.set(contactBranchPath, `${contactBranchBody.trim()}\n`);
  }

  const contactEntryByNodeId = new Map<string, {
    email: string;
    label: string;
    relatedThreadLabels: string[];
    roles: string[];
  }>();
  for (const relation of contactRelations) {
    const existing = contactEntryByNodeId.get(relation.fromNodeId) ?? {
      email: String(relation.metadata.contact_email ?? ""),
      label: String(relation.metadata.contact_label ?? relation.metadata.contact_email ?? relation.fromNodeId),
      relatedThreadLabels: [],
      roles: [],
    };
    const threadLabel = typeof relation.metadata.thread_entity_label === "string"
      ? relation.metadata.thread_entity_label
      : null;
    if (threadLabel && !existing.relatedThreadLabels.includes(threadLabel)) {
      existing.relatedThreadLabels.push(threadLabel);
    }
    for (const role of Array.isArray(relation.metadata.roles) ? relation.metadata.roles : []) {
      if (typeof role === "string" && !existing.roles.includes(role)) {
        existing.roles.push(role);
      }
    }
    contactEntryByNodeId.set(relation.fromNodeId, existing);
  }
  for (const [nodeId, entry] of contactEntryByNodeId) {
    const contactSlug = safePathSegment(entry.label || entry.email, "contact");
    const contactPath = path.posix.join(
      ...integrationBranchSegments({
        treeSlug: params.tree.slug,
        entitySlug: null,
        branchSlug: "contacts",
      }),
      "branches",
      contactSlug,
      "content.md",
    );
    const contactBody = virtualIntegrationContactContent({
      tree: params.tree,
      entry: {
        entityKey: nodeId.replace(`entity:integration:${params.tree.treeId}:`, ""),
        email: entry.email,
        label: entry.label,
        relatedThreadIds: [],
        relatedThreadKeys: [],
        messageLeafIds: [],
        roles: entry.roles,
      },
      relatedThreadLabels: entry.relatedThreadLabels,
    });
    nodes.set(nodeId, {
      nodeId,
      nodeKind: "entity",
      path: contactPath,
      title: entry.label,
      summary: `${entry.label} appears in ${entry.relatedThreadLabels.length} thread${entry.relatedThreadLabels.length === 1 ? "" : "s"} in this mailbox.`,
      bodySha256: sha256(contactBody),
      level: 2,
      ordinal: null,
      observedAt: params.tree.updatedAt,
      metadata: {
        entity_key: nodeId.replace(`entity:integration:${params.tree.treeId}:`, ""),
        contact_email: entry.email,
        derived: true,
      },
    });
    bodiesByPath.set(contactPath, contactBody);
  }

  const kindOrder: Record<MemoryNodeKind, number> = {
    tree: 0,
    entity: 1,
    branch: 2,
    summary: 3,
    leaf: 4,
  };
  const childBuckets = new Map<string, Array<{
    nodeId: string;
    nodeKind: MemoryNodeKind;
    level: number | null;
    ordinal: number | null;
    title: string;
    path: string;
  }>>();
  for (const node of nodes.values()) {
    const parentPath = canonicalParentContentPath(node.path);
    if (!parentPath) {
      continue;
    }
    const parentNode = Array.from(nodes.values()).find((candidate) => candidate.path === parentPath);
    if (!parentNode) {
      continue;
    }
    const bucket = childBuckets.get(parentNode.nodeId) ?? [];
    bucket.push({
      nodeId: node.nodeId,
      nodeKind: node.nodeKind,
      level: node.level,
      ordinal: node.ordinal,
      title: node.title,
      path: node.path,
    });
    childBuckets.set(parentNode.nodeId, bucket);
  }

  const edges: Array<{
    parentNodeId: string;
    childNodeId: string;
    position: number;
  }> = [];
  for (const [parentNodeId, bucket] of childBuckets) {
    bucket.sort((left, right) =>
      kindOrder[left.nodeKind] - kindOrder[right.nodeKind]
      || (left.level ?? 10_000) - (right.level ?? 10_000)
      || (left.ordinal ?? 10_000) - (right.ordinal ?? 10_000)
      || left.title.localeCompare(right.title)
      || left.path.localeCompare(right.path),
    );
    bucket.forEach((child, index) => {
      edges.push({
        parentNodeId,
        childNodeId: child.nodeId,
        position: index + 1,
      });
    });
  }

  const finalizedNodes = Array.from(nodes.values()).map((node) => ({
    ...node,
    childCount: childBuckets.get(node.nodeId)?.length ?? 0,
  }));

  return {
    nodes: finalizedNodes,
    edges,
    bodiesByPath,
  };
}

async function buildSummaryTreePlan(params: {
  workspaceId: string;
  tree: IntegrationTreeRecord;
  leaves: IntegrationLeafRecord[];
  modelClient: MemoryModelClientConfig | null;
}): Promise<{
  nodes: Array<{
    nodeId: string;
    level: number;
    ordinal: number;
    path: string;
    title: string;
    summary: string;
    body: string;
    bodySha256: string;
    childCount: number;
    sealedAt: string;
  }>;
  edges: Array<{
    parentNodeId: string;
    childKind: InteractionTreeChildKind;
    childId: string;
    position: number;
  }>;
}> {
  if (params.leaves.length <= 1) {
    return { nodes: [], edges: [] };
  }

  type EntityGroup = {
    entityKey: string | null;
    entityLabel: string | null;
    entitySlug: string | null;
    leaves: IntegrationLeafRecord[];
  };
  type BranchGroup = {
    branchKey: string | null;
    branchLabel: string | null;
    branchSlug: string | null;
    leaves: IntegrationLeafRecord[];
  };

  const entityGroups = new Map<string, EntityGroup>();
  for (const leaf of params.leaves) {
    const groupKey = leaf.entityKey ?? "__account__";
    const existing = entityGroups.get(groupKey);
    if (existing) {
      existing.leaves.push(leaf);
      continue;
    }
    entityGroups.set(groupKey, {
      entityKey: leaf.entityKey,
      entityLabel: leaf.entityLabel,
      entitySlug: integrationEntitySlug(leaf.entityKey, leaf.entityLabel),
      leaves: [leaf],
    });
  }

  const tempNodes = new Map<string, TempSummaryNode>();
  const rootChildren: TempSummaryChild[] = [];

  for (const entityGroup of entityGroups.values()) {
    const branchGroups = new Map<string, BranchGroup>();
    for (const leaf of entityGroup.leaves) {
      const groupKey = leaf.branchKey ?? "__default__";
      const existing = branchGroups.get(groupKey);
      if (existing) {
        existing.leaves.push(leaf);
        continue;
      }
      branchGroups.set(groupKey, {
        branchKey: leaf.branchKey,
        branchLabel: leaf.branchLabel,
        branchSlug: integrationBranchSlug(leaf.branchKey, leaf.branchLabel),
        leaves: [leaf],
      });
    }

    const branchRoots: TempSummaryNode[] = [];
    for (const branchGroup of branchGroups.values()) {
      const branchChildren: TempSummaryChild[] = branchGroup.leaves.map((leaf) => ({
        kind: "leaf",
        id: leaf.leafId,
        title: leaf.title,
        summary: leaf.summary,
        excerpt: null,
      }));
      const branchTitle = branchGroup.branchLabel
        ?? branchGroup.branchKey
        ?? "Items";
      const branchSubtree = await buildBranchSummarySubtree({
        tree: params.tree,
        title: branchTitle,
        scopeLabel: `${params.tree.accountLabel} ${branchTitle}`.trim(),
        children: branchChildren,
        entitySlug: entityGroup.entitySlug,
        branchSlug: branchGroup.branchSlug,
        modelClient: params.modelClient,
      });
      for (const node of branchSubtree.nodes) {
        tempNodes.set(node.tempId, node);
      }
      branchRoots.push(branchSubtree.root);
    }

    if (branchRoots.length === 0) {
      continue;
    }
    if (entityGroup.entityKey) {
      const entityTitle = entityGroup.entityLabel ?? entityGroup.entityKey;
      const entityNode = await buildTempSummaryNode({
        tree: params.tree,
        title: entityTitle,
        scopeLabel: `${params.tree.accountLabel} ${entityTitle}`.trim(),
        children: branchRoots.map((node) => summaryNodeAsChild(node)),
        ordinal: rootChildren.length + 1,
        modelClient: params.modelClient,
        entitySlug: entityGroup.entitySlug,
      });
      tempNodes.set(entityNode.tempId, entityNode);
      rootChildren.push(summaryNodeAsChild(entityNode));
      continue;
    }
    if (branchRoots.length === 1) {
      rootChildren.push(summaryNodeAsChild(branchRoots[0]!));
      continue;
    }
    const accountNode = await buildTempSummaryNode({
      tree: params.tree,
      title: `${params.tree.accountLabel} account context`,
      scopeLabel: `${params.tree.accountLabel} account context`,
      children: branchRoots.map((node) => summaryNodeAsChild(node)),
      ordinal: rootChildren.length + 1,
      modelClient: params.modelClient,
    });
    tempNodes.set(accountNode.tempId, accountNode);
    rootChildren.push(summaryNodeAsChild(accountNode));
  }

  if (rootChildren.length === 0) {
    return { nodes: [], edges: [] };
  }

  let topNodes: TempSummaryNode[] = [];
  if (rootChildren.length === 1) {
    const onlyChild = rootChildren[0]!;
    if (onlyChild.kind === "summary") {
      const existing = tempNodes.get(onlyChild.id);
      if (existing) {
        topNodes = [existing];
      }
    }
  } else {
    const rootNode = await buildTempSummaryNode({
      tree: params.tree,
      title: `${params.tree.accountLabel} integration memory`,
      scopeLabel: `${params.tree.accountLabel} integration memory`,
      children: rootChildren,
      ordinal: 1,
      modelClient: params.modelClient,
      root: true,
    });
    tempNodes.set(rootNode.tempId, rootNode);
    topNodes = [rootNode];
  }

  if (topNodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodeLevels = new Map<string, number>();
  const assignLevels = (node: TempSummaryNode, level: number): void => {
    const existing = nodeLevels.get(node.tempId);
    if (existing !== undefined && existing <= level) {
      return;
    }
    nodeLevels.set(node.tempId, level);
    for (const child of node.children) {
      if (child.kind !== "summary") {
        continue;
      }
      const childNode = tempNodes.get(child.id);
      if (childNode) {
        assignLevels(childNode, level + 1);
      }
    }
  };
  for (const topNode of topNodes) {
    assignLevels(topNode, 1);
  }

  const nodeIdByTempId = new Map<string, { nodeId: string; level: number }>();
  const nodes: Array<{
    nodeId: string;
    level: number;
    ordinal: number;
    path: string;
    title: string;
    summary: string;
    body: string;
    bodySha256: string;
    childCount: number;
    sealedAt: string;
  }> = [];
  const sealedAt = utcNowIso();
  const orderedTempNodes = Array.from(tempNodes.values()).sort((left, right) => {
    const levelDiff = (nodeLevels.get(left.tempId) ?? 999) - (nodeLevels.get(right.tempId) ?? 999);
    if (levelDiff !== 0) {
      return levelDiff;
    }
    return left.title.localeCompare(right.title);
  });

  for (const node of orderedTempNodes) {
    const level = nodeLevels.get(node.tempId);
    if (!level) {
      continue;
    }
    const childIdentity = node.children.map((child) => `${child.kind}:${child.id}`).join("|");
    const nodeId = `summary-${sha256(`${params.tree.treeId}|L${level}|${childIdentity}`).slice(0, 24)}`;
    nodeIdByTempId.set(node.tempId, { nodeId, level });
    nodes.push({
      nodeId,
      level,
      ordinal: nodes.filter((entry) => entry.level === level).length + 1,
      path: integrationSummaryRelativePath({
        treeSlug: params.tree.slug,
        level,
        nodeId,
        root: node.root,
        entitySlug: node.entitySlug,
        branchSlug: node.branchSlug,
      }),
      title: node.title,
      summary: node.summary,
      body: node.body,
      bodySha256: sha256(node.body),
      childCount: node.children.length,
      sealedAt,
    });
  }

  const edges: Array<{
    parentNodeId: string;
    childKind: InteractionTreeChildKind;
    childId: string;
    position: number;
  }> = [];
  for (const node of orderedTempNodes) {
    const parent = nodeIdByTempId.get(node.tempId);
    if (!parent) {
      continue;
    }
    node.children.forEach((child, childIndex) => {
      const childId = child.kind === "summary"
        ? (nodeIdByTempId.get(child.id)?.nodeId ?? child.id)
        : child.id;
      edges.push({
        parentNodeId: parent.nodeId,
        childKind: child.kind,
        childId,
        position: childIndex + 1,
      });
    });
  }

  return { nodes, edges };
}

async function syncNodeEmbedding(params: {
  store: RuntimeStateStore;
  tree: IntegrationTreeRecord;
  nodeKind: InteractionTreeChildKind;
  nodeId: string;
  title: string;
  summary: string;
  body: string;
  embeddingClient: MemoryModelClientConfig | null;
}): Promise<void> {
  if (!params.embeddingClient) {
    return;
  }
  const excerpt = markdownExcerpt(params.body);
  const embeddingText = buildEmbeddingText({
    treeLabel: params.tree.accountLabel,
    provider: params.tree.provider,
    title: params.title,
    summary: params.summary,
    excerpt,
    nodeKind: params.nodeKind,
  });
  const contentFingerprint = sha256(embeddingText);
  const existing = params.store.getIntegrationNodeEmbedding({
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    embeddingModel: params.embeddingClient.modelId,
  });
  if (existing?.contentFingerprint === contentFingerprint) {
    return;
  }
  const embedding = await queryMemoryModelEmbedding(params.embeddingClient, {
    input: embeddingText,
    timeoutMs: 7000,
  });
  if (!embedding) {
    return;
  }
  params.store.upsertIntegrationNodeEmbedding({
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    treeId: params.tree.treeId,
    embeddingModel: params.embeddingClient.modelId,
    contentFingerprint,
    dimensions: embedding.length,
    vector: Array.from(embedding),
  });
}

export async function persistIntegrationCandidate(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  candidate: IntegrationLeafCandidate;
  embeddingClient?: MemoryModelClientConfig | null;
}): Promise<PersistedIntegrationLeafResult> {
  const tree = ensureIntegrationTree({
    store: params.store,
    provider: params.candidate.provider,
    ownerUserId: params.candidate.ownerUserId,
    accountKey: params.candidate.accountKey,
    accountLabel: params.candidate.accountLabel,
  });
  const contentFingerprint = sha256(params.candidate.content);
  const leafId = `leaf-${sha256(`${tree.treeId}|${params.candidate.subjectKey}|${contentFingerprint}`).slice(0, 24)}`;
  const relativePath = integrationLeafRelativePath({
    treeSlug: tree.slug,
    leafId,
    subjectKey: params.candidate.subjectKey,
    title: params.candidate.title,
    externalObjectId: params.candidate.externalObjectId ?? null,
    entityKey: params.candidate.entityKey ?? null,
    entityLabel: params.candidate.entityLabel ?? null,
    branchKey: params.candidate.branchKey ?? null,
    branchLabel: params.candidate.branchLabel ?? null,
  });
  const existingDuplicate = params.store.getIntegrationLeafByFingerprint({
    treeId: tree.treeId,
    fingerprint: contentFingerprint,
  });
  if (existingDuplicate) {
    const needsMetadataRefresh = existingDuplicate.subjectKey !== params.candidate.subjectKey
      || existingDuplicate.entityKey !== (params.candidate.entityKey ?? null)
      || existingDuplicate.entityLabel !== (params.candidate.entityLabel ?? null)
      || existingDuplicate.branchKey !== (params.candidate.branchKey ?? null)
      || existingDuplicate.branchLabel !== (params.candidate.branchLabel ?? null)
      || existingDuplicate.path !== relativePath
      || existingDuplicate.title !== params.candidate.title
      || existingDuplicate.summary !== params.candidate.summary;
    if (needsMetadataRefresh) {
      const absolutePath = absolutePathForRelative(params.store.workspaceRoot, relativePath);
      writeFileIfChanged(absolutePath, params.candidate.content);
      if (existingDuplicate.path !== relativePath) {
        fs.rmSync(absolutePathForRelative(params.store.workspaceRoot, existingDuplicate.path), { force: true });
      }
      const refreshed = params.store.upsertIntegrationLeaf({
        leafId: existingDuplicate.leafId,
        treeId: tree.treeId,
        subjectKey: params.candidate.subjectKey,
        entityKey: params.candidate.entityKey ?? null,
        entityLabel: params.candidate.entityLabel ?? null,
        branchKey: params.candidate.branchKey ?? null,
        branchLabel: params.candidate.branchLabel ?? null,
        path: relativePath,
        title: params.candidate.title,
        summary: params.candidate.summary,
        fingerprint: contentFingerprint,
        bodySha256: sha256(params.candidate.content),
        tags: params.candidate.tags,
        sourceType: params.candidate.sourceType ?? null,
        sourceEventId: params.candidate.sourceEventId ?? null,
        sourceMessageId: params.candidate.sourceMessageId ?? null,
        externalObjectId: params.candidate.externalObjectId ?? null,
        externalObjectType: params.candidate.externalObjectType ?? null,
        admissionConfidence: params.candidate.confidence ?? null,
        observedAt: params.candidate.observedAt ?? null,
        supersedesLeafId: existingDuplicate.supersedesLeafId ?? null,
        supersededAt: existingDuplicate.supersededAt ?? null,
        status: existingDuplicate.status,
        createdAt: existingDuplicate.createdAt,
      });
      await syncNodeEmbedding({
        store: params.store,
        tree,
        nodeKind: "leaf",
        nodeId: refreshed.leafId,
        title: refreshed.title,
        summary: refreshed.summary,
        body: params.candidate.content,
        embeddingClient: params.embeddingClient ?? null,
      });
      return {
        outcome: "noop_duplicate",
        tree,
        leaf: refreshed,
      };
    }
    return {
      outcome: "noop_duplicate",
      tree,
      leaf: existingDuplicate,
    };
  }
  const existingActive = params.store.getLatestActiveIntegrationLeafBySubject({
    treeId: tree.treeId,
    subjectKey: params.candidate.subjectKey,
  });
  const absolutePath = absolutePathForRelative(params.store.workspaceRoot, relativePath);
  writeFileIfChanged(absolutePath, params.candidate.content);

  let outcome: PersistedIntegrationLeafResult["outcome"] = "created";
  if (existingActive && existingActive.fingerprint !== contentFingerprint) {
    params.store.updateIntegrationLeafStatus({
      leafId: existingActive.leafId,
      status: "superseded",
      supersededAt: params.candidate.observedAt ?? utcNowIso(),
    });
    outcome = "superseding";
  }

  const leaf = params.store.upsertIntegrationLeaf({
    leafId,
    treeId: tree.treeId,
    subjectKey: params.candidate.subjectKey,
    entityKey: params.candidate.entityKey ?? null,
    entityLabel: params.candidate.entityLabel ?? null,
    branchKey: params.candidate.branchKey ?? null,
    branchLabel: params.candidate.branchLabel ?? null,
    path: relativePath,
    title: params.candidate.title,
    summary: params.candidate.summary,
    fingerprint: contentFingerprint,
    bodySha256: sha256(params.candidate.content),
    tags: params.candidate.tags,
    sourceType: params.candidate.sourceType ?? null,
    sourceEventId: params.candidate.sourceEventId ?? null,
    sourceMessageId: params.candidate.sourceMessageId ?? null,
    externalObjectId: params.candidate.externalObjectId ?? null,
    externalObjectType: params.candidate.externalObjectType ?? null,
    admissionConfidence: params.candidate.confidence ?? null,
    observedAt: params.candidate.observedAt ?? null,
    supersedesLeafId: existingActive && existingActive.fingerprint !== contentFingerprint ? existingActive.leafId : null,
    status: "active",
  });

  await syncNodeEmbedding({
    store: params.store,
    tree,
    nodeKind: "leaf",
    nodeId: leaf.leafId,
    title: leaf.title,
    summary: leaf.summary,
    body: params.candidate.content,
    embeddingClient: params.embeddingClient ?? null,
  });

  return {
    outcome,
    tree,
    leaf,
  };
}

export async function rebuildIntegrationTree(params: {
  store: RuntimeStateStore;
  treeId: string;
  embeddingClient?: MemoryModelClientConfig | null;
}): Promise<void> {
  const tree = params.store.getIntegrationTree({ treeId: params.treeId });
  if (!tree) {
    return;
  }
  const activeLeaves = params.store
    .listIntegrationLeaves({
      treeId: params.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.observedAt ?? left.updatedAt);
      const rightTime = Date.parse(right.observedAt ?? right.updatedAt);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.createdAt.localeCompare(right.createdAt);
    });

  const leafBodies = new Map<string, string>();
  for (const leaf of activeLeaves) {
    const body = readFileIfExists(
      absolutePathForRelative(params.store.workspaceRoot, leaf.path),
    ) ?? fallbackLeafBody(leaf);
    leafBodies.set(leaf.leafId, body);
  }

  fs.rmSync(legacyIntegrationTreeDir(params.store.workspaceRoot, tree.slug), {
    recursive: true,
    force: true,
  });

  const rewrittenLeaves: IntegrationLeafRecord[] = [];
  for (const leaf of activeLeaves) {
    const relativePath = integrationLeafRelativePath({
      treeSlug: tree.slug,
      leafId: leaf.leafId,
      subjectKey: leaf.subjectKey,
      title: leaf.title,
      externalObjectId: leaf.externalObjectId ?? null,
      entityKey: leaf.entityKey ?? null,
      entityLabel: leaf.entityLabel ?? null,
      branchKey: leaf.branchKey ?? null,
      branchLabel: leaf.branchLabel ?? null,
    });
    const body = leafBodies.get(leaf.leafId) ?? fallbackLeafBody(leaf);
    writeFileIfChanged(
      absolutePathForRelative(params.store.workspaceRoot, relativePath),
      body,
    );
    if (leaf.path !== relativePath) {
      rewrittenLeaves.push(
        params.store.upsertIntegrationLeaf({
          leafId: leaf.leafId,
          treeId: leaf.treeId,
          subjectKey: leaf.subjectKey,
          entityKey: leaf.entityKey ?? null,
          entityLabel: leaf.entityLabel ?? null,
          branchKey: leaf.branchKey ?? null,
          branchLabel: leaf.branchLabel ?? null,
          path: relativePath,
          title: leaf.title,
          summary: leaf.summary,
          fingerprint: leaf.fingerprint,
          bodySha256: leaf.bodySha256,
          tags: leaf.tags,
          sourceType: leaf.sourceType ?? null,
          sourceEventId: leaf.sourceEventId ?? null,
          sourceMessageId: leaf.sourceMessageId ?? null,
          externalObjectId: leaf.externalObjectId ?? null,
          externalObjectType: leaf.externalObjectType ?? null,
          admissionConfidence: leaf.admissionConfidence ?? null,
          observedAt: leaf.observedAt ?? null,
          supersedesLeafId: leaf.supersedesLeafId ?? null,
          supersededAt: leaf.supersededAt ?? null,
          status: leaf.status,
          createdAt: leaf.createdAt,
          updatedAt: leaf.updatedAt,
        }),
      );
      continue;
    }
    rewrittenLeaves.push(leaf);
  }

  const relations = buildIntegrationRelations({
    tree,
    leaves: rewrittenLeaves,
    leafBodies,
  });
  const semantic = buildSemanticIntegrationTree({
    tree,
    leaves: rewrittenLeaves,
    leafBodies,
    relations,
  });
  if (semantic) {
    for (const [relativePath, body] of semantic.bodiesByPath) {
      writeFileIfChanged(
        absolutePathForRelative(params.store.workspaceRoot, relativePath),
        body,
      );
    }
    removeObsoleteFiles(
      semanticIntegrationTreeDir(params.store.workspaceRoot, tree.slug),
      new Set(
        [...semantic.bodiesByPath.keys()].map((relativePath) =>
          path.resolve(absolutePathForRelative(params.store.workspaceRoot, relativePath))
        ),
      ),
    );
    params.store.syncSemanticMemoryTree({
      category: "integration",
      treeId: params.treeId,
      nodes: semantic.nodes.map((node) => ({
        nodeId: node.nodeId,
        nodeClass: node.nodeClass,
        nodeKind: node.nodeKind,
        sourceLeafId: node.sourceLeafId,
        path: node.path,
        title: node.title,
        summary: node.summary,
        bodySha256: node.bodySha256,
        childCount: node.childCount,
        observedAt: node.observedAt,
        isMaterialized: node.isMaterialized,
        metadata: node.metadata,
      })),
      edges: semantic.edges,
    });
    params.store.syncSemanticMemoryRelations({
      category: "integration",
      treeId: params.treeId,
      relations: semantic.relations.map((relation) => ({
        fromNodeId: relation.fromNodeId,
        toNodeId: relation.toNodeId,
        relationType: relation.relationType,
        metadata: relation.metadata,
      })),
    });
    params.store.syncSemanticMemorySearchDocs({
      category: "integration",
      treeId: params.treeId,
      docs: semanticSearchDocsForIntegrationTree({
        semantic,
      }),
    });
  } else {
    fs.rmSync(semanticIntegrationTreeDir(params.store.workspaceRoot, tree.slug), {
      recursive: true,
      force: true,
    });
  }
  for (const node of semantic?.nodes ?? []) {
    if (node.nodeClass !== "semantic") {
      continue;
    }
    const body = semantic?.bodiesByPath.get(node.path);
    if (!body) {
      continue;
    }
    await syncNodeEmbedding({
      store: params.store,
      tree,
      nodeKind: "summary",
      nodeId: node.nodeId,
      title: node.title,
      summary: node.summary,
      body,
      embeddingClient: params.embeddingClient ?? null,
    });
  }
}

export interface ClearedIntegrationMemoryResult {
  ok: true;
  provider_id: string;
  connection_id: string;
  cleared: boolean;
  tree_ids: string[];
  deleted_trees: number;
  deleted_leaves: number;
  deleted_semantic_nodes: number;
  deleted_semantic_edges: number;
  deleted_semantic_relations: number;
  deleted_semantic_search_docs: number;
  deleted_embeddings: number;
  deleted_files: number;
}

function countFilesRecursive(targetPath: string): number {
  if (!fs.existsSync(targetPath)) {
    return 0;
  }
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return 1;
  }
  if (!stat.isDirectory()) {
    return 0;
  }
  let total = 0;
  for (const childName of fs.readdirSync(targetPath)) {
    total += countFilesRecursive(path.join(targetPath, childName));
  }
  return total;
}

function integrationMemoryTreesForConnection(params: {
  store: RuntimeStateStore;
  connectionId: string;
}): IntegrationTreeRecord[] {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const providerId = connection.providerId.trim().toLowerCase();
  const candidateKeys = new Set(
    [
      connection.accountHandle,
      connection.accountEmail,
      connection.accountExternalId,
      connection.connectionId,
    ]
      .map((value) => compactWhitespace(value ?? ""))
      .filter((value) => value.length > 0),
  );
  return params.store.listIntegrationTrees({
    provider: providerId,
    ownerUserId: connection.ownerUserId,
    limit: 10_000,
    offset: 0,
  }).filter((tree) => candidateKeys.has(compactWhitespace(tree.accountKey)));
}

export function clearIntegrationMemoryForConnection(params: {
  store: RuntimeStateStore;
  connectionId: string;
}): ClearedIntegrationMemoryResult {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const trees = integrationMemoryTreesForConnection(params);
  let deletedTrees = 0;
  let deletedLeaves = 0;
  let deletedSemanticNodes = 0;
  let deletedSemanticEdges = 0;
  let deletedSemanticRelations = 0;
  let deletedSemanticSearchDocs = 0;
  let deletedEmbeddings = 0;
  let deletedFiles = 0;
  for (const tree of trees) {
    const canonicalDir = integrationTreeDir(params.store.workspaceRoot, tree.slug);
    const legacyDir = legacyIntegrationTreeDir(params.store.workspaceRoot, tree.slug);
    const semanticDir = semanticIntegrationTreeDir(params.store.workspaceRoot, tree.slug);
    deletedFiles += countFilesRecursive(canonicalDir);
    deletedFiles += countFilesRecursive(legacyDir);
    deletedFiles += countFilesRecursive(semanticDir);
    fs.rmSync(canonicalDir, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(semanticDir, { recursive: true, force: true });
    const deleted = params.store.deleteIntegrationTreeMemory({
      treeId: tree.treeId,
    });
    deletedTrees += deleted.deletedTree ? 1 : 0;
    deletedLeaves += deleted.deletedLeaves;
    deletedSemanticNodes += deleted.deletedSemanticNodes;
    deletedSemanticEdges += deleted.deletedSemanticEdges;
    deletedSemanticRelations += deleted.deletedSemanticRelations;
    deletedSemanticSearchDocs += deleted.deletedSemanticSearchDocs;
    deletedEmbeddings += deleted.deletedEmbeddings;
  }
  return {
    ok: true,
    provider_id: connection.providerId.trim().toLowerCase(),
    connection_id: connection.connectionId,
    cleared: trees.length > 0,
    tree_ids: trees.map((tree) => tree.treeId),
    deleted_trees: deletedTrees,
    deleted_leaves: deletedLeaves,
    deleted_semantic_nodes: deletedSemanticNodes,
    deleted_semantic_edges: deletedSemanticEdges,
    deleted_semantic_relations: deletedSemanticRelations,
    deleted_semantic_search_docs: deletedSemanticSearchDocs,
    deleted_embeddings: deletedEmbeddings,
    deleted_files: deletedFiles,
  };
}

export async function rebuildAllIntegrationTrees(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
}): Promise<{ trees: number; summaries: number }> {
  const embeddingClient = createRecallEmbeddingModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId ?? `integration-memory-sync:${params.workspaceId}`,
    inputId: params.inputId ?? `integration-memory-sync:${params.workspaceId}`,
    selectedModel: params.selectedModel ?? null,
  });
  const trees = params.store.listIntegrationTrees({
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  let summaryCount = 0;
  for (const tree of trees) {
    await rebuildIntegrationTree({
      store: params.store,
      treeId: tree.treeId,
      embeddingClient,
    });
    summaryCount += countSummaryLikeSemanticIntegrationNodes({
      store: params.store,
      treeId: tree.treeId,
    });
  }
  return { trees: trees.length, summaries: summaryCount };
}

async function queryEmbeddingVector(params: {
  workspaceId: string;
  sessionId?: string | null;
  inputId?: string | null;
  selectedModel?: string | null;
  query: string;
}): Promise<{ modelId: string; vector: number[] } | null> {
  const client = createRecallEmbeddingModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId ?? `integration-memory-retrieve:${params.workspaceId}`,
    inputId: params.inputId ?? `integration-memory-retrieve:${params.workspaceId}`,
    selectedModel: params.selectedModel ?? null,
  });
  if (!client) {
    return null;
  }
  const embedding = await queryMemoryModelEmbedding(client, {
    input: params.query,
    timeoutMs: 7000,
  });
  if (!embedding) {
    return null;
  }
  return {
    modelId: client.modelId,
    vector: Array.from(embedding),
  };
}

function semanticSearchDocsByNodeId(params: {
  store: RuntimeStateStore;
  treeId: string;
}): Map<string, ReturnType<RuntimeStateStore["listSemanticMemorySearchDocs"]>[number]> {
  return new Map(
    params.store.listSemanticMemorySearchDocs({
      category: "integration",
      treeId: params.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    }).map((doc) => [doc.nodeId, doc]),
  );
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

function retrievalVectorNodeKindsForMode(mode: "mixed" | "summaries" | "leaves"): InteractionTreeChildKind[] {
  if (mode === "leaves") {
    return ["leaf"];
  }
  if (mode === "summaries") {
    return ["summary"];
  }
  return ["leaf", "summary"];
}

function listIntegrationVectorCandidateSearchDocs(params: {
  store: RuntimeStateStore;
  mode: "mixed" | "summaries" | "leaves";
  treeIds: string[];
  embeddingModelId: string;
  queryVector: number[];
  maxResults: number;
}): SemanticSearchDoc[] {
  const dedupedTreeIds = [...new Set(params.treeIds.map((value) => value.trim()).filter(Boolean))];
  if (dedupedTreeIds.length === 0) {
    return [];
  }
  const vectorHits = params.store.searchIntegrationNodeEmbeddingsByVector({
    embedding: new Float32Array(params.queryVector),
    embeddingModel: params.embeddingModelId,
    limit: Math.max(RETRIEVAL_VECTOR_CANDIDATE_LIMIT, params.maxResults * 16),
    treeIds: dedupedTreeIds,
    nodeKinds: retrievalVectorNodeKindsForMode(params.mode),
  });
  if (vectorHits.length === 0) {
    return [];
  }
  const docsByNodeId = new Map(
    params.store.listSemanticMemorySearchDocs({
      category: "integration",
      treeIds: dedupedTreeIds,
      nodeIds: vectorHits.map((hit) => hit.nodeId),
      nodeClass: retrievalNodeClassForMode(params.mode),
      status: "active",
      limit: vectorHits.length,
      offset: 0,
    }).map((doc) => [doc.nodeId, doc]),
  );
  return vectorHits
    .map((hit) => docsByNodeId.get(hit.nodeId) ?? null)
    .filter((doc): doc is SemanticSearchDoc => Boolean(doc));
}

function semanticLexicalRanksByNodeId(params: {
  store: RuntimeStateStore;
  query: string;
  mode: "mixed" | "summaries" | "leaves";
  treeIds: string[];
}): Map<string, number> {
  const matchQuery = buildRetrievalFtsMatchQuery(params.query);
  if (!matchQuery || params.treeIds.length === 0) {
    return new Map();
  }
  const dedupedTreeIds = [...new Set(params.treeIds)];
  const hits = params.store.searchSemanticMemorySearchDocs({
    category: "integration",
    treeIds: dedupedTreeIds,
    nodeClass: retrievalNodeClassForMode(params.mode),
    status: "active",
    matchQuery,
    limit: dedupedTreeIds.length > 1 ? 240 : 500,
    offset: 0,
  });
  hits.sort((left, right) =>
    left.bm25Score - right.bm25Score
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.path.localeCompare(right.path),
  );
  const ranks = new Map<string, number>();
  for (const hit of hits) {
    if (!ranks.has(hit.nodeId)) {
      ranks.set(hit.nodeId, ranks.size + 1);
    }
  }
  return ranks;
}

function listIntegrationCandidateSearchDocs(params: {
  store: RuntimeStateStore;
  query: string;
  mode: "mixed" | "summaries" | "leaves";
  treeIds: string[];
  maxResults: number;
  vectorDocs?: SemanticSearchDoc[];
}): SemanticSearchDoc[] {
  const dedupedTreeIds = [...new Set(params.treeIds.map((value) => value.trim()).filter(Boolean))];
  if (dedupedTreeIds.length === 0) {
    return [];
  }
  const nodeClass = retrievalNodeClassForMode(params.mode);
  const poolLimit = Math.max(RETRIEVAL_CANDIDATE_POOL_LIMIT, params.maxResults * 24);
  const recentLimit = Math.max(RETRIEVAL_RECENT_CANDIDATE_LIMIT, params.maxResults * 12);
  const ftsLimit = Math.max(RETRIEVAL_FTS_CANDIDATE_LIMIT, params.maxResults * 20);
  const docsByNodeId = new Map<string, SemanticSearchDoc>();
  const addDocs = (docs: SemanticSearchDoc[]) => {
    for (const doc of docs) {
      if (!docsByNodeId.has(doc.nodeId)) {
        docsByNodeId.set(doc.nodeId, doc);
      }
      if (docsByNodeId.size >= poolLimit) {
        break;
      }
    }
  };
  const matchQuery = buildRetrievalFtsMatchQuery(params.query);
  if (matchQuery) {
    addDocs(params.store.searchSemanticMemorySearchDocs({
      category: "integration",
      treeIds: dedupedTreeIds,
      nodeClass,
      status: "active",
      matchQuery,
      limit: ftsLimit,
      offset: 0,
    }));
  }
  addDocs(params.vectorDocs ?? []);
  addDocs(params.store.listSemanticMemorySearchDocs({
    category: "integration",
    treeIds: dedupedTreeIds,
    nodeClass,
    status: "active",
    limit: matchQuery ? recentLimit : poolLimit,
    offset: 0,
  }));
  return [...docsByNodeId.values()];
}

function accessibleIntegrationTreesForWorkspace(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
}): IntegrationTreeRecord[] {
  return visibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
    treeId: params.treeId ?? null,
  });
}

function buildLeafCandidate(params: {
  tree: IntegrationTreeRecord;
  leaf: IntegrationLeafRecord;
}): NodeCandidate {
  return {
    kind: "leaf",
    embeddingKind: "leaf",
    id: params.leaf.leafId,
    tree: params.tree,
    title: params.leaf.title,
    summary: params.leaf.summary,
    excerpt: params.leaf.summary ? clipText(params.leaf.summary, 320) : null,
    path: params.leaf.path,
    level: null,
    childCount: null,
    observedAt: params.leaf.observedAt,
    updatedAt: params.leaf.updatedAt,
  };
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

function semanticCandidateKind(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): IntegrationRetrieveNodeKind {
  return semanticCandidateKindForParts(node.nodeClass, node.nodeKind);
}

function semanticCandidateKindForParts(
  nodeClass: SemanticSearchDoc["nodeClass"],
  nodeKind: SemanticSearchDoc["nodeKind"],
): IntegrationRetrieveNodeKind {
  if (nodeClass === "leaf") {
    return "leaf";
  }
  if (nodeKind === "connection") {
    return "tree";
  }
  if (new Set(["workspace", "repo", "thread", "page", "database", "contact", "file", "folder", "post", "calendar"]).has(nodeKind)) {
    return "entity";
  }
  return "branch";
}

function buildSemanticCandidateFromSearchDoc(params: {
  tree: IntegrationTreeRecord;
  doc: SemanticSearchDoc;
}): NodeCandidate {
  return {
    kind: semanticCandidateKindForParts(params.doc.nodeClass, params.doc.nodeKind),
    embeddingKind: params.doc.nodeClass === "leaf" ? "leaf" : "summary",
    id: params.doc.nodeId,
    tree: params.tree,
    title: params.doc.title,
    summary: params.doc.summary,
    excerpt: params.doc.excerpt,
    path: params.doc.path,
    level: semanticNodeDepth(params.doc.path),
    childCount: params.doc.childCount,
    observedAt: params.doc.observedAt,
    updatedAt: params.doc.updatedAt,
  };
}

function loadIntegrationEmbeddingsByCandidateKey(params: {
  store: RuntimeStateStore;
  embeddingModelId: string | null;
  candidateIds: string[];
}): Map<string, number[]> {
  const normalizedCandidateIds = [...new Set(params.candidateIds.map((value) => value.trim()).filter(Boolean))];
  if (!params.embeddingModelId || normalizedCandidateIds.length === 0) {
    return new Map();
  }
  const embeddingByKey = new Map<string, number[]>();
  for (const record of params.store.listIntegrationNodeEmbeddings({
    embeddingModel: params.embeddingModelId,
    nodeIds: normalizedCandidateIds,
  })) {
    embeddingByKey.set(`${record.nodeKind}:${record.nodeId}:${record.embeddingModel}`, record.vector);
  }
  return embeddingByKey;
}

function buildSemanticCandidate(params: {
  tree: IntegrationTreeRecord;
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number];
  searchDoc?: ReturnType<RuntimeStateStore["getSemanticMemorySearchDoc"]> | null;
}): NodeCandidate {
  const excerpt = params.searchDoc?.excerpt ?? (params.node.summary ? clipText(params.node.summary, 320) : null);
  return {
    kind: semanticCandidateKind(params.node),
    embeddingKind: params.node.nodeClass === "leaf" ? "leaf" : "summary",
    id: params.node.nodeId,
    tree: params.tree,
    title: params.node.title,
    summary: params.node.summary,
    excerpt,
    path: params.node.path,
    level: semanticNodeDepth(params.node.path),
    childCount: params.node.childCount,
    observedAt: params.node.observedAt,
    updatedAt: params.node.updatedAt,
  };
}

function semanticGmailThreadNodeId(treeId: string, threadEntityKey: string): string | null {
  return threadEntityKey.startsWith("thread:")
    ? `semantic:integration:${treeId}:thread:${threadEntityKey.slice("thread:".length)}`
    : null;
}

function nodeScore(params: {
  query: string;
  candidate: NodeCandidate;
  lexicalRank: number | null;
  embeddingModelId: string | null;
  queryVector: number[] | null;
  embeddingByKey: Map<string, number[]>;
  mode: "mixed" | "summaries" | "leaves";
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const hasQuery = params.query.trim().length > 0;
  let score = textScore(
    params.query,
    params.candidate.tree.accountLabel,
    params.candidate.tree.provider,
    params.candidate.title,
    params.candidate.summary,
    params.candidate.excerpt,
  );
  if (score > 0) {
    reasons.push("lexical_match");
  }
  const lexicalBoost = lexicalRankBoost(params.lexicalRank);
  if (lexicalBoost > 0) {
    score += lexicalBoost;
    reasons.push("fts_bm25");
  }
  if (params.embeddingModelId && params.queryVector) {
    const embeddingKey = `${params.candidate.embeddingKind}:${params.candidate.id}:${params.embeddingModelId}`;
    const candidateVector = params.embeddingByKey.get(embeddingKey);
    if (candidateVector) {
      const similarity = cosineSimilarity(candidateVector, params.queryVector);
      if (similarity > 0) {
        score += similarity * 0.8;
        reasons.push("embedding_similarity");
      }
    }
  }
  const hasTopicalSignal = score > 0;
  if (!hasQuery || hasTopicalSignal) {
    if (params.mode === "summaries" && params.candidate.kind !== "leaf") {
      score += 0.6;
      reasons.push("summary_mode_boost");
    }
    if (params.mode === "leaves" && params.candidate.kind === "leaf") {
      score += 0.6;
      reasons.push("leaf_mode_boost");
    }
    if (params.candidate.kind === "summary" && params.candidate.level === 1) {
      score += 0.15;
    }
    const updatedAt = Date.parse(params.candidate.updatedAt ?? "");
    if (Number.isFinite(updatedAt)) {
      score += Math.max(0, 0.15 - ((Date.now() - updatedAt) / (1000 * 60 * 60 * 24 * 30)) * 0.01);
    }
  }
  return { score, reasons };
}

function candidateToHit(params: {
  candidate: NodeCandidate;
  score: number;
  reasons: string[];
}): IntegrationMemoryRetrieveHit {
  return {
    category: "integration",
    node_kind: params.candidate.kind,
    node_id: params.candidate.id,
    tree_id: params.candidate.tree.treeId,
    provider: params.candidate.tree.provider,
    owner_user_id: params.candidate.tree.ownerUserId,
    account_key: params.candidate.tree.accountKey,
    account_label: params.candidate.tree.accountLabel,
    path: params.candidate.path,
    title: params.candidate.title,
    summary: params.candidate.summary,
    excerpt: params.candidate.excerpt,
    level: params.candidate.level,
    child_count: params.candidate.childCount,
    observed_at: params.candidate.observedAt,
    updated_at: params.candidate.updatedAt,
    score: params.score,
    reasons: params.reasons,
  };
}

async function childHitsForNode(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  parentNodeId: string;
  query: string;
  mode: "mixed" | "summaries" | "leaves";
  embeddingModelId: string | null;
  queryVector: number[] | null;
}): Promise<IntegrationMemoryRetrieveHit[]> {
  const visibleTrees = accessibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const scoreCandidates = (
    candidates: NodeCandidate[],
    lexicalRanksByNodeId: Map<string, number>,
    extraReason?: string,
  ): IntegrationMemoryRetrieveHit[] => {
    const embeddingByKey = loadIntegrationEmbeddingsByCandidateKey({
      store: params.store,
      embeddingModelId: params.embeddingModelId,
      candidateIds: candidates.map((candidate) => candidate.id),
    });
    return candidates
      .map((candidate) => {
        const scored = nodeScore({
          query: params.query,
          candidate,
          lexicalRank: lexicalRanksByNodeId.get(candidate.id) ?? null,
          embeddingModelId: params.embeddingModelId,
          queryVector: params.queryVector,
          embeddingByKey,
          mode: params.mode,
        });
        return candidateToHit({
          candidate,
          score: scored.score,
          reasons: scored.reasons.length > 0 ? scored.reasons : [extraReason ?? "child_traversal"],
        });
      })
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  };

  const semanticTree = visibleTrees.find((candidateTree) =>
    params.parentNodeId.startsWith(`semantic:integration:${candidateTree.treeId}:`)
    && Boolean(
      params.store.getSemanticMemoryNode({
        category: "integration",
        treeId: candidateTree.treeId,
        nodeId: params.parentNodeId,
      }),
    ),
  ) ?? null;
  if (semanticTree) {
    const searchDocsByNodeId = semanticSearchDocsByNodeId({
      store: params.store,
      treeId: semanticTree.treeId,
    });
    const lexicalRanksByNodeId = semanticLexicalRanksByNodeId({
      store: params.store,
      query: params.query,
      mode: params.mode,
      treeIds: [semanticTree.treeId],
    });
    const parentNode = params.store.getSemanticMemoryNode({
      category: "integration",
      treeId: semanticTree.treeId,
      nodeId: params.parentNodeId,
    });
    if (!parentNode) {
      return [];
    }

    const candidates = params.store
      .listSemanticMemoryChildren({
        category: "integration",
        treeId: semanticTree.treeId,
        parentNodeId: params.parentNodeId,
      })
      .map((edge) =>
        params.store.getSemanticMemoryNode({
          category: "integration",
          treeId: semanticTree.treeId,
          nodeId: edge.childNodeId,
        }))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .map((node) => buildSemanticCandidate({
        tree: semanticTree,
        node,
        searchDoc: searchDocsByNodeId.get(node.nodeId) ?? null,
      }));
    const relationCandidates = params.store
      .listSemanticMemoryRelations({
        category: "integration",
        treeId: semanticTree.treeId,
        fromNodeId: params.parentNodeId,
        limit: 10_000,
      })
      .map((relation) =>
        params.store.getSemanticMemoryNode({
          category: "integration",
          treeId: semanticTree.treeId,
          nodeId: relation.toNodeId,
        }))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .map((node) => buildSemanticCandidate({
        tree: semanticTree,
        node,
        searchDoc: searchDocsByNodeId.get(node.nodeId) ?? null,
      }));

    return scoreCandidates(
      [...candidates, ...relationCandidates].filter((candidate, index, bucket) =>
        bucket.findIndex((entry) => entry.id === candidate.id) === index,
      ),
      lexicalRanksByNodeId,
    );
  }
  return [];
}

export async function retrieveIntegrationMemory(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  mode?: "mixed" | "summaries" | "leaves";
  treeId?: string | null;
  nodeId?: string | null;
  maxResults?: number;
  selectedModel?: string | null;
  useEmbeddings?: boolean;
  sessionId?: string | null;
  inputId?: string | null;
}): Promise<IntegrationMemoryRetrieveResult> {
  const mode = params.mode ?? "mixed";
  const maxResults = Math.max(1, Math.min(params.maxResults ?? MAX_RETRIEVE_RESULTS, 50));
  const trees = accessibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
    treeId: params.treeId ?? null,
  });

  const embeddingQuery = params.useEmbeddings === false
    ? null
    : await queryEmbeddingVector({
        workspaceId: params.workspaceId,
        sessionId: params.sessionId ?? null,
        inputId: params.inputId ?? null,
        selectedModel: params.selectedModel ?? null,
        query: params.query,
      });
  const lexicalRanksByNodeId = semanticLexicalRanksByNodeId({
    store: params.store,
    query: params.query,
    mode,
    treeIds: trees.map((tree) => tree.treeId),
  });

  if (params.nodeId) {
    return {
      query: params.query,
      mode,
      tree_id: params.treeId ?? null,
      node_id: params.nodeId,
      hits: [],
      children: await childHitsForNode({
        store: params.store,
        workspaceId: params.workspaceId,
        parentNodeId: params.nodeId,
        query: params.query,
        mode,
        embeddingModelId: embeddingQuery?.modelId ?? null,
        queryVector: embeddingQuery?.vector ?? null,
      }),
    };
  }

  const treeById = new Map(trees.map((tree) => [tree.treeId, tree]));
  const vectorCandidateDocs = embeddingQuery
    ? listIntegrationVectorCandidateSearchDocs({
        store: params.store,
        mode,
        treeIds: trees.map((tree) => tree.treeId),
        embeddingModelId: embeddingQuery.modelId,
        queryVector: embeddingQuery.vector,
        maxResults,
      })
    : [];
  const candidateDocs = listIntegrationCandidateSearchDocs({
    store: params.store,
    query: params.query,
    mode,
    treeIds: trees.map((tree) => tree.treeId),
    maxResults,
    vectorDocs: vectorCandidateDocs,
  });
  let candidates = candidateDocs
    .map((doc) => {
      const tree = treeById.get(doc.treeId);
      if (!tree) {
        return null;
      }
      const candidate = buildSemanticCandidateFromSearchDoc({
        tree,
        doc,
      });
      if (candidate.kind === "tree") {
        return null;
      }
      if (mode === "leaves" && candidate.kind !== "leaf") {
        return null;
      }
      if (mode === "summaries" && candidate.kind === "leaf") {
        return null;
      }
      return candidate;
    })
    .filter((candidate): candidate is NodeCandidate => Boolean(candidate));
  if (candidates.length === 0 && mode !== "summaries") {
    candidates = params.store
      .listIntegrationLeaves({
        treeId: params.treeId ?? undefined,
        status: "active",
        limit: Math.max(RETRIEVAL_RECENT_CANDIDATE_LIMIT, maxResults * 12),
        offset: 0,
      })
      .map((leaf) => {
        const tree = treeById.get(leaf.treeId);
        if (!tree) {
          return null;
        }
        return buildLeafCandidate({
          tree,
          leaf,
        });
      })
      .filter((candidate): candidate is NodeCandidate => Boolean(candidate))
      .filter((candidate) => mode === "mixed" || candidate.kind === "leaf");
  }
  const embeddingByKey = loadIntegrationEmbeddingsByCandidateKey({
    store: params.store,
    embeddingModelId: embeddingQuery?.modelId ?? null,
    candidateIds: candidates.map((candidate) => candidate.id),
  });

  const hits = candidates
    .map((candidate) => {
      const scored = nodeScore({
        query: params.query,
        candidate,
        lexicalRank: lexicalRanksByNodeId.get(candidate.id) ?? null,
        embeddingModelId: embeddingQuery?.modelId ?? null,
        queryVector: embeddingQuery?.vector ?? null,
        embeddingByKey,
        mode,
      });
      return candidateToHit({
        candidate,
        score: scored.score,
        reasons: scored.reasons.length > 0 ? scored.reasons : ["recent_memory"],
      });
    })
    .filter((hit) => params.query.trim() ? hit.score > 0 : true)
    .sort((left, right) => {
      const scoreDiff = right.score - left.score;
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, maxResults);

  return {
    query: params.query,
    mode,
    tree_id: params.treeId ?? null,
    node_id: null,
    hits,
  };
}

export async function buildRecalledIntegrationMemoryContext(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  maxResults?: number;
}): Promise<AgentRecalledMemoryContext | null> {
  const result = await retrieveIntegrationMemory({
    store: params.store,
    workspaceId: params.workspaceId,
    query: params.query,
    mode: "mixed",
    maxResults: params.maxResults ?? 5,
    selectedModel: params.selectedModel ?? null,
    sessionId: params.sessionId ?? null,
    inputId: params.inputId ?? null,
  });
  if (result.hits.length === 0) {
    return null;
  }
  return {
    entries: result.hits.map((hit) => ({
      scope: "integration",
      memory_type: hit.node_kind === "leaf" ? "leaf" : "summary",
      title: hit.title,
      summary: hit.summary,
      path: hit.path,
      verification_policy: "none",
      staleness_policy: "workspace_sensitive",
      freshness_state: "fresh",
      freshness_note: hit.node_kind === "leaf"
        ? `Leaf memory from ${hit.provider} account ${hit.account_label}.`
        : `Structured memory node from ${hit.provider} account ${hit.account_label}.`,
      source_type: hit.node_kind,
      observed_at: hit.observed_at,
      last_verified_at: hit.updated_at,
      confidence: hit.score,
      updated_at: hit.updated_at,
      excerpt: hit.excerpt,
    })),
    selection_trace: result.hits.map((hit) => ({
      memory_id: hit.node_id,
      score: hit.score,
      freshness_state: "fresh",
      matched_tokens: tokenize(params.query),
      reasons: hit.reasons,
      source_type: hit.node_kind,
    })),
  };
}
