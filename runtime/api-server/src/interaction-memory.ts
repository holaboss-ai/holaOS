import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type InteractionEntityRecord,
  type InteractionEntityType,
  type InteractionLeafRecord,
  type InteractionTreeChildKind,
  type RuntimeStateStore,
  utcNowIso,
} from "@holaboss/runtime-state-store";

import { createBackgroundTaskMemoryModelClient } from "./background-task-model.js";
import type { AgentRecalledMemoryContext } from "./memory-retrieval-pack.js";
import { queryMemoryModelEmbedding, queryMemoryModelJson, type MemoryModelClientConfig } from "./memory-model-client.js";
import { createRecallEmbeddingModelClient } from "./recall-embedding-model.js";
import { workspaceMemoryDir } from "./workspace-bundle-paths.js";

const INTERACTION_BRANCH_FACTOR = 8;
const MAX_ENTITY_SHORTLIST = 24;
const MAX_RETRIEVE_RESULTS = 12;
const EMBEDDING_EXCERPT_CHARS = 480;
const RETRIEVAL_CANDIDATE_POOL_LIMIT = 320;
const RETRIEVAL_FTS_CANDIDATE_LIMIT = 240;
const RETRIEVAL_RECENT_CANDIDATE_LIMIT = 160;
const RETRIEVAL_VECTOR_CANDIDATE_LIMIT = 120;
const INTERACTION_UNCATEGORIZED_ENTITY_ID = "interaction:uncategorized";
const INTERACTION_UNCATEGORIZED_SLUG = "uncategorized";
const INTERACTION_UNCATEGORIZED_NAME = "Uncategorized";
const ENTITY_CREATE_CONFIDENCE_THRESHOLD = 0.68;
const ENTITY_MATCH_CONFIDENCE_THRESHOLD = 0.6;
const SEMANTIC_DEDUPE_SHORTLIST_LIMIT = 6;
const SEMANTIC_DEDUPE_SIMILARITY_THRESHOLD = 0.52;
const INTERACTION_SUMMARY_INPUT_FINGERPRINT_VERSION = 1;
const PROJECT_SUBJECT_TOKENS = new Set([
  "api",
  "app",
  "service",
  "services",
  "console",
  "portal",
  "platform",
  "gateway",
  "engine",
  "system",
  "sdk",
  "site",
  "dashboard",
  "worker",
]);
const SYSTEM_SUBJECT_TOKENS = new Set([
  "runtime",
  "broker",
  "database",
  "cache",
  "queue",
  "scheduler",
  "warehouse",
  "pipeline",
  "cluster",
]);
const OWNER_SLOT_TOKENS = new Set([
  "accountmanager",
  "agenda",
  "aging",
  "approval",
  "approvals",
  "approver",
  "bridge",
  "billing",
  "blocking",
  "cadence",
  "canary",
  "captain",
  "channel",
  "checklist",
  "claim",
  "command",
  "commands",
  "contact",
  "contract",
  "cooling",
  "credit",
  "dashboard",
  "deploy",
  "dispute",
  "endpoint",
  "escalation",
  "exception",
  "exceptions",
  "finance",
  "forecast",
  "hold",
  "incident",
  "invoice",
  "leader",
  "lead",
  "ledger",
  "legal",
  "manager",
  "meeting",
  "message",
  "messages",
  "metrics",
  "owner",
  "ops",
  "payment",
  "payer",
  "policy",
  "postrelease",
  "post-release",
  "preference",
  "procedure",
  "query",
  "refund",
  "release",
  "renewal",
  "reserve",
  "review",
  "reviewer",
  "rollback",
  "rollout",
  "runbook",
  "settlement",
  "shipment",
  "signoff",
  "slo",
  "smoke",
  "staging",
  "summary",
  "support",
  "threshold",
  "timer",
  "tool",
  "tools",
  "notification",
  "notifications",
  "verification",
  "warranty",
  "workflow",
]);
const GENERIC_SUBJECT_LEAD_TOKENS = new Set([
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "every",
  "weekly",
  "daily",
  "monthly",
  "quarterly",
  "annual",
  "use",
  "run",
  "remember",
  "keep",
  "start",
  "stop",
  "review",
  "follow",
  "send",
  "open",
  "confirm",
  "draft",
]);
const CUSTOMER_SIGNAL_TOKENS = new Set([
  "accountmanager",
  "billing",
  "claim",
  "contract",
  "credit",
  "customer",
  "dispute",
  "finance",
  "invoice",
  "payer",
  "payment",
  "refund",
  "renewal",
  "settlement",
  "shipment",
  "warranty",
]);
const PROJECT_SIGNAL_TOKENS = new Set([
  "canary",
  "dashboard",
  "deploy",
  "endpoint",
  "grafana",
  "incident",
  "launch",
  "platform",
  "postrelease",
  "post-release",
  "release",
  "rollback",
  "rollout",
  "service",
  "slo",
  "smoke",
  "staging",
  "verification",
]);
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

const INTERACTION_ENTITY_TYPES = new Set<InteractionEntityType>([
  "project",
  "workflow",
  "preference",
  "identity",
  "person",
  "customer",
  "system",
  "misc",
]);

export interface InteractionLeafCandidate {
  subjectKey: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  memoryType?: string | null;
  sourceType?: string | null;
  sourceEventId?: string | null;
  sourceMessageId?: string | null;
  sourceTurnInputId?: string | null;
  observedAt?: string | null;
  confidence?: number | null;
}

export interface PersistedInteractionLeafResult {
  outcome: "noop_duplicate" | "created" | "superseding";
  entity: InteractionEntityRecord;
  leaf: InteractionLeafRecord;
}

export interface InteractionMemoryRetrieveHit {
  node_kind: InteractionTreeChildKind;
  node_id: string;
  tree_id: string;
  entity_id: string;
  entity_name: string;
  entity_type: string;
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

export interface InteractionMemoryRetrieveResult {
  query: string;
  mode: "mixed" | "summaries" | "leaves";
  tree_id: string | null;
  node_id: string | null;
  hits: InteractionMemoryRetrieveHit[];
  children?: InteractionMemoryRetrieveHit[];
}

type EntityAssignmentAction = "matched" | "created" | "fallback";

interface AssignedInteractionEntity {
  entity: InteractionEntityRecord;
  confidence: number | null;
  secondaryEntityIds: string[];
  action: EntityAssignmentAction;
}

interface NodeCandidate {
  kind: InteractionTreeChildKind;
  id: string;
  entity: InteractionEntityRecord;
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
  children: Array<{
    kind: InteractionTreeChildKind;
    id: string;
    title: string;
    summary: string;
    excerpt: string | null;
  }>;
}

type TempSummaryChild = TempSummaryNode["children"][number];

type SemanticInteractionDraftChild = {
  kind: InteractionTreeChildKind;
  id: string;
  title: string;
  summary: string;
  excerpt: string | null;
  observedAt: string | null;
};

type SemanticInteractionDraftNode = {
  nodeId: string;
  nodeClass: "semantic" | "leaf";
  nodeKind: "tree" | "partition" | "leaf";
  sourceLeafId: string | null;
  path: string;
  title: string;
  summary: string;
  bodySha256: string;
  childCount: number;
  observedAt: string | null;
  isMaterialized: boolean;
  metadata: Record<string, unknown>;
};

type ExistingInteractionSummaryNode = {
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number];
  body: string;
};

interface SemanticDuplicateCandidate {
  leaf: InteractionLeafRecord;
  similarity: number;
  exactSubject: boolean;
}

interface StableSubjectHint {
  canonicalName: string;
  entityType: InteractionEntityType;
  confidence: "medium" | "high";
}

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

function normalizeEntityType(value: unknown): InteractionEntityType | null {
  if (typeof value !== "string") {
    return null;
  }
  const token = value.trim().toLowerCase();
  return INTERACTION_ENTITY_TYPES.has(token as InteractionEntityType)
    ? token as InteractionEntityType
    : null;
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return null;
}

function normalizeEntityIdList(value: unknown, allowedIds: Set<string>): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim();
    if (!normalized || !allowedIds.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ids.push(normalized);
  }
  return ids;
}

function safePathSegment(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function interactionMemoryRootDir(workspaceDir: string): string {
  return path.join(workspaceMemoryDir(workspaceDir), "interaction");
}

function interactionEntityDir(workspaceDir: string, slug: string): string {
  return path.join(interactionMemoryRootDir(workspaceDir), "entities", slug);
}

function semanticInteractionTreeDir(workspaceDir: string, slug: string): string {
  return path.join(workspaceMemoryDir(workspaceDir), "semantic", "interaction", "trees", slug);
}

function interactionLeafRelativePath(workspaceId: string, entitySlug: string, leafId: string): string {
  return path.posix.join(
    "workspace",
    workspaceId,
    "interaction",
    "entities",
    entitySlug,
    "leaves",
    `${leafId}.md`,
  );
}

function interactionSummaryRelativePath(
  workspaceId: string,
  entitySlug: string,
  level: number,
  nodeId: string,
): string {
  return path.posix.join(
    "workspace",
    workspaceId,
    "interaction",
    "entities",
    entitySlug,
    "summaries",
    `L${level}`,
    `${nodeId}.md`,
  );
}

function interactionCanonicalTreeBaseSegments(workspaceId: string, entitySlug: string): string[] {
  return ["workspace", workspaceId, "interaction", "trees", entitySlug];
}

function interactionCanonicalContentPath(baseSegments: string[]): string {
  return path.posix.join(...baseSegments, "content.md");
}

function interactionCanonicalSummaryFolderName(level: number, nodeId: string): string {
  return `L${level}-${nodeId.slice(-6)}`;
}

function semanticInteractionRootNodeId(entityId: string): string {
  return `semantic:interaction:${entityId}:tree`;
}

function semanticInteractionLeafNodeId(entityId: string, leafId: string): string {
  return `semantic:interaction:${entityId}:leaf:${leafId}`;
}

function semanticInteractionTreeBaseSegments(workspaceId: string, entitySlug: string): string[] {
  return ["workspace", workspaceId, "semantic", "interaction", "trees", entitySlug];
}

function semanticInteractionTreeRelativePath(workspaceId: string, entitySlug: string): string {
  return path.posix.join(...semanticInteractionTreeBaseSegments(workspaceId, entitySlug), "content.md");
}

function semanticInteractionChildRelativePath(parentRelativePath: string, childSlug: string): string {
  return path.posix.join(path.posix.dirname(parentRelativePath), childSlug, "content.md");
}

function semanticInteractionLeafRelativePath(
  parentRelativePath: string,
  leaf: Pick<InteractionLeafRecord, "leafId" | "subjectKey" | "title">,
): string {
  return semanticInteractionChildRelativePath(
    parentRelativePath,
    interactionCanonicalLeafFolderName({
      leafId: leaf.leafId,
      subjectKey: leaf.subjectKey,
      title: leaf.title,
    }),
  );
}

function semanticTreePathDepth(pathValue: string, markerSegments: [string, string, string]): number | null {
  const normalized = pathValue.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const markerIndex = segments.findIndex(
    (segment, index) =>
      segment === markerSegments[0]
      && segments[index + 1] === markerSegments[1]
      && segments[index + 2] === markerSegments[2],
  );
  if (markerIndex < 0 || segments[segments.length - 1] !== "content.md") {
    return null;
  }
  const treeSlugIndex = markerIndex + markerSegments.length;
  if (!segments[treeSlugIndex]) {
    return null;
  }
  return Math.max(0, segments.length - (treeSlugIndex + 2));
}

function interactionCanonicalLeafFolderName(params: {
  leafId: string;
  subjectKey: string;
  title: string;
}): string {
  const source = compactWhitespace(params.subjectKey) || compactWhitespace(params.title) || params.leafId;
  return `${safePathSegment(source, "leaf")}-${params.leafId.slice(-6)}`;
}

function interactionTreeBody(params: {
  entity: InteractionEntityRecord;
  leafCount: number;
  summaryCount: number;
}): string {
  const lines = [
    `# ${params.entity.canonicalName}`,
    "",
    `- Entity ID: \`${params.entity.entityId}\``,
    `- Entity type: ${params.entity.entityType}`,
    `- Active leaves: ${params.leafCount}`,
    `- Active summaries: ${params.summaryCount}`,
    "",
    "## Summary",
    "",
    params.entity.summary ?? `${params.entity.canonicalName} interaction memory tree.`,
    "",
  ];
  return `${lines.join("\n").trim()}\n`;
}

function interactionFallbackLeafBody(leaf: InteractionLeafRecord): string {
  return `# ${leaf.title}\n\n${leaf.summary}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function absolutePathForRelative(workspaceDir: string, relativePath: string): string {
  const prefix = "workspace/";
  const normalized = relativePath.replaceAll("\\", "/");
  const trimmed = normalized.startsWith(prefix)
    ? normalized.split("/").slice(2).join("/")
    : normalized;
  return path.join(workspaceMemoryDir(workspaceDir), trimmed);
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

function metadataString(metadata: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function interactionSummaryInputFingerprint(params: {
  entity: InteractionEntityRecord;
  nodeKind: "tree" | "partition";
  title: string;
  depthFromLeaves: number;
  ordinal: number;
  children: Array<{
    kind: InteractionTreeChildKind;
    id: string;
    title: string;
    summary: string;
    excerpt: string | null;
  }>;
}): string {
  return sha256(JSON.stringify({
    version: INTERACTION_SUMMARY_INPUT_FINGERPRINT_VERSION,
    entityId: params.entity.entityId,
    entityName: params.entity.canonicalName,
    entityType: params.entity.entityType,
    entitySummary: params.entity.summary ?? null,
    nodeKind: params.nodeKind,
    title: params.title,
    depthFromLeaves: params.depthFromLeaves,
    ordinal: params.ordinal,
    children: params.children.map((child) => ({
      kind: child.kind,
      id: child.id,
      title: child.title,
      summary: child.summary,
      excerpt: child.excerpt ? clipText(child.excerpt, 280) : null,
    })),
  }));
}

function existingInteractionSummaryNode(params: {
  cache: Map<string, ExistingInteractionSummaryNode>;
  nodeId: string;
  inputFingerprint: string;
}): ExistingInteractionSummaryNode | null {
  const existing = params.cache.get(params.nodeId);
  if (!existing) {
    return null;
  }
  return metadataString(existing.node.metadata, "summary_input_fingerprint") === params.inputFingerprint
    ? existing
    : null;
}

function loadExistingInteractionSummaryNodes(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entity: InteractionEntityRecord;
}): Map<string, ExistingInteractionSummaryNode> {
  const docsByNodeId = new Map(
    params.store.listSemanticMemorySearchDocs({
      category: "interaction",
      workspaceId: params.workspaceId,
      treeId: params.entity.entityId,
      status: "active",
      limit: 10_000,
      offset: 0,
    }).map((doc) => [doc.nodeId, doc]),
  );
  const existing = new Map<string, ExistingInteractionSummaryNode>();
  for (const node of params.store.listSemanticMemoryNodes({
    category: "interaction",
    workspaceId: params.workspaceId,
    treeId: params.entity.entityId,
    nodeClass: "semantic",
    status: "active",
    limit: 10_000,
    offset: 0,
  })) {
    const body = docsByNodeId.get(node.nodeId)?.bodyText
      ?? readFileIfExists(absolutePathForRelative(params.store.workspaceDir(params.workspaceId), node.path));
    if (!body) {
      continue;
    }
    existing.set(node.nodeId, { node, body });
  }
  return existing;
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

function tokenize(value: string): string[] {
  const matches = value.match(/[a-z0-9]{2,}/gi);
  return matches ? matches.map((item) => item.toLowerCase()) : [];
}

function normalizeKeyToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeNameKey(value: string): string {
  return tokenize(value).join(" ");
}

function titleWords(value: string): string[] {
  const matches = value.match(/[A-Za-z0-9#._-]+/g);
  return matches ?? [];
}

function uniqueTokens(value: string): string[] {
  return [...new Set(tokenize(value))];
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = uniqueTokens(left);
  const rightTokens = uniqueTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }
  const rightSet = new Set(rightTokens);
  let shared = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.max(leftTokens.length, rightTokens.length);
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

function buildEmbeddingText(params: {
  entityName: string;
  title: string;
  summary: string;
  excerpt: string;
  nodeKind: InteractionTreeChildKind;
}): string {
  return [
    `Entity: ${params.entityName}`,
    `Node kind: ${params.nodeKind}`,
    `Title: ${params.title}`,
    `Summary: ${params.summary}`,
    `Excerpt: ${params.excerpt || "none"}`,
  ].join("\n");
}

function interactionEntityTypeHint(memoryType: string | null | undefined): InteractionEntityType | null {
  switch ((memoryType ?? "").trim().toLowerCase()) {
    case "preference":
      return "preference";
    case "identity":
      return "identity";
    case "blocker":
      return "system";
    default:
      return null;
  }
}

function candidateTokenSet(candidate: InteractionLeafCandidate): Set<string> {
  return new Set(
    tokenize([
      candidate.subjectKey,
      candidate.title,
      candidate.summary,
      candidate.tags.join(" "),
      candidate.memoryType ?? "",
    ].join(" "))
  );
}

function classifyStableSubjectEntityType(params: {
  canonicalName: string;
  candidate: InteractionLeafCandidate;
}): InteractionEntityType | null {
  const nameTokens = new Set(tokenize(params.canonicalName));
  const contextTokens = candidateTokenSet(params.candidate);
  const hasProjectNameToken = [...nameTokens].some((token) => PROJECT_SUBJECT_TOKENS.has(token));
  const hasSystemNameToken = [...nameTokens].some((token) => SYSTEM_SUBJECT_TOKENS.has(token));
  const hasProjectSignal = [...contextTokens].some((token) => PROJECT_SIGNAL_TOKENS.has(token));
  const hasCustomerSignal = [...contextTokens].some((token) => CUSTOMER_SIGNAL_TOKENS.has(token));

  if (hasProjectNameToken || (hasProjectSignal && !hasCustomerSignal)) {
    return "project";
  }
  if (hasSystemNameToken && !hasProjectNameToken) {
    return "system";
  }
  if (hasCustomerSignal) {
    return "customer";
  }
  return null;
}

function extractStableSubjectFromText(text: string): string | null {
  const tokens = titleWords(text);
  if (tokens.length < 2) {
    return null;
  }
  const subjectTokens: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeKeyToken(token);
    if (!normalized) {
      continue;
    }
    if (OWNER_SLOT_TOKENS.has(normalized)) {
      break;
    }
    subjectTokens.push(token.replace(/^[^A-Za-z0-9#]+|[^A-Za-z0-9._-]+$/g, ""));
    if (subjectTokens.length >= 5) {
      break;
    }
  }
  if (subjectTokens.length === 0 || subjectTokens.length === tokens.length) {
    return null;
  }
  const firstToken = normalizeKeyToken(subjectTokens[0] ?? "");
  if (GENERIC_SUBJECT_LEAD_TOKENS.has(firstToken)) {
    return null;
  }
  const uppercaseTokenCount = subjectTokens.filter((token) => /[A-Z]/.test(token)).length;
  const hasStrongSingleTokenSignal =
    subjectTokens.length === 1
    && (
      /[A-Z].*[A-Z]/.test(subjectTokens[0] ?? "")
      || /\d/.test(subjectTokens[0] ?? "")
    );
  if (subjectTokens.length > 1 && uppercaseTokenCount < 2) {
    return null;
  }
  if (subjectTokens.length === 1 && !hasStrongSingleTokenSignal) {
    return null;
  }
  const candidate = subjectTokens.join(" ").trim();
  if (!candidate || tokenize(candidate).length === 0) {
    return null;
  }
  return candidate;
}

function inferStableSubjectHint(candidate: InteractionLeafCandidate): StableSubjectHint | null {
  const titleCandidate = extractStableSubjectFromText(candidate.title);
  const summaryCandidate = extractStableSubjectFromText(
    candidate.summary.replace(/^for\s+/i, "").replace(/^[Tt]he\s+/, "")
  );
  const canonicalName = clipText(titleCandidate || summaryCandidate || "", 96);
  if (!canonicalName) {
    return null;
  }
  const entityType = classifyStableSubjectEntityType({
    canonicalName,
    candidate,
  });
  if (!entityType) {
    return null;
  }
  return {
    canonicalName,
    entityType,
    confidence: titleCandidate ? "high" : "medium",
  };
}

function findExistingEntityBySubjectHint(params: {
  shortlist: InteractionEntityRecord[];
  hint: StableSubjectHint | null;
}): InteractionEntityRecord | null {
  if (!params.hint) {
    return null;
  }
  const hintedName = normalizeNameKey(params.hint.canonicalName);
  for (const entity of params.shortlist) {
    if (entity.entityType !== params.hint.entityType) {
      continue;
    }
    if (normalizeNameKey(entity.canonicalName) === hintedName) {
      return entity;
    }
    for (const alias of entity.aliases ?? []) {
      if (normalizeNameKey(alias) === hintedName) {
        return entity;
      }
    }
  }
  return null;
}

function semanticSubjectBase(subjectKey: string): string {
  const normalized = compactWhitespace(subjectKey).toLowerCase();
  if (!normalized) {
    return "";
  }
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon <= 0) {
    return normalized;
  }
  return normalized.slice(0, lastColon);
}

function semanticSimilarityForLeaf(params: {
  candidate: InteractionLeafCandidate;
  leaf: InteractionLeafRecord;
}): number {
  const candidateSubject = compactWhitespace(params.candidate.subjectKey).toLowerCase();
  const leafSubject = compactWhitespace(params.leaf.subjectKey).toLowerCase();
  if (candidateSubject && leafSubject && candidateSubject === leafSubject) {
    return 1;
  }
  const candidateSubjectBase = semanticSubjectBase(params.candidate.subjectKey);
  const leafSubjectBase = semanticSubjectBase(params.leaf.subjectKey);
  const subjectScore = tokenJaccard(candidateSubjectBase || candidateSubject, leafSubjectBase || leafSubject);
  const titleScore = tokenJaccard(params.candidate.title, params.leaf.title);
  const summaryScore = tokenJaccard(params.candidate.summary, params.leaf.summary);
  const tagScore = tokenJaccard(params.candidate.tags.join(" "), params.leaf.tags.join(" "));
  return Math.max(subjectScore, (subjectScore * 0.35) + (titleScore * 0.35) + (summaryScore * 0.2) + (tagScore * 0.1));
}

function specificityScoreForInteractionLeafCandidate(candidate: InteractionLeafCandidate): number {
  const subjectBonus = candidate.subjectKey.includes(":") ? 18 : 0;
  const titleWeight = uniqueTokens(candidate.title).length * 2.2;
  const summaryWeight = uniqueTokens(candidate.summary).length * 1.4;
  const tagWeight = candidate.tags.length * 1.5;
  const contentWeight = Math.min(42, compactWhitespace(candidate.content).length / 18);
  return subjectBonus + titleWeight + summaryWeight + tagWeight + contentWeight;
}

function specificityScoreForInteractionLeafRecord(leaf: InteractionLeafRecord): number {
  const subjectBonus = leaf.subjectKey.includes(":") ? 18 : 0;
  const titleWeight = uniqueTokens(leaf.title).length * 2.2;
  const summaryWeight = uniqueTokens(leaf.summary).length * 1.4;
  const tagWeight = leaf.tags.length * 1.5;
  return subjectBonus + titleWeight + summaryWeight + tagWeight;
}

function semanticDuplicateShortlist(params: {
  candidate: InteractionLeafCandidate;
  leaves: InteractionLeafRecord[];
}): SemanticDuplicateCandidate[] {
  const shortlist = params.leaves
    .map((leaf) => {
      const similarity = semanticSimilarityForLeaf({
        candidate: params.candidate,
        leaf,
      });
      const exactSubject = compactWhitespace(leaf.subjectKey).toLowerCase() === compactWhitespace(params.candidate.subjectKey).toLowerCase();
      return { leaf, similarity, exactSubject };
    })
    .filter((entry) => entry.exactSubject || entry.similarity >= SEMANTIC_DEDUPE_SIMILARITY_THRESHOLD)
    .sort((left, right) => {
      if (left.exactSubject !== right.exactSubject) {
        return left.exactSubject ? -1 : 1;
      }
      if (left.similarity !== right.similarity) {
        return right.similarity - left.similarity;
      }
      const leftTime = Date.parse(left.leaf.observedAt ?? left.leaf.updatedAt);
      const rightTime = Date.parse(right.leaf.observedAt ?? right.leaf.updatedAt);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return right.leaf.createdAt.localeCompare(left.leaf.createdAt);
    });
  return shortlist.slice(0, SEMANTIC_DEDUPE_SHORTLIST_LIMIT);
}

async function semanticDuplicateDecision(params: {
  workspaceId: string;
  candidate: InteractionLeafCandidate;
  shortlist: SemanticDuplicateCandidate[];
  modelClient: MemoryModelClientConfig | null;
  workspaceDir: string;
}): Promise<{
  action: "same_memory" | "supersedes_existing" | "different_memory" | "unsure";
  leafId: string | null;
}> {
  if (!params.modelClient || params.shortlist.length === 0) {
    return {
      action: "unsure",
      leafId: null,
    };
  }

  const payload = await queryMemoryModelJson(params.modelClient, {
    systemPrompt: [
      "You arbitrate semantic deduplication for durable interaction memory leaves within a single entity.",
      "Return strict JSON only with this shape:",
      '{"action":"same_memory|supersedes_existing|different_memory|unsure","existing_leaf_id":"string|null","rationale":"string"}',
      "Choose same_memory when the candidate and an existing leaf capture the same durable fact or procedure and both should not coexist.",
      "Choose supersedes_existing when the candidate is the same memory but is more complete, more specific, or clearly better phrased.",
      "Choose different_memory when both memories should remain active.",
      "Choose unsure when you cannot safely decide.",
      "Be conservative. Only choose an existing_leaf_id from the shortlist.",
    ].join(" "),
    userPrompt: [
      `Workspace ID: ${params.workspaceId}`,
      "",
      "Candidate memory:",
      `- Subject key: ${params.candidate.subjectKey}`,
      `- Title: ${params.candidate.title}`,
      `- Summary: ${params.candidate.summary}`,
      `- Tags: ${params.candidate.tags.join(", ") || "none"}`,
      `- Content excerpt: ${clipText(params.candidate.content, 320)}`,
      "",
      "Existing active leaves in the same entity:",
      ...params.shortlist.map((entry, index) => {
        const existingBody = readFileIfExists(absolutePathForRelative(params.workspaceDir, entry.leaf.path)) ?? "";
        return [
          `${index + 1}. leaf_id: ${entry.leaf.leafId}`,
          `   Subject key: ${entry.leaf.subjectKey}`,
          `   Title: ${entry.leaf.title}`,
          `   Summary: ${entry.leaf.summary}`,
          `   Tags: ${entry.leaf.tags.join(", ") || "none"}`,
          `   Similarity: ${entry.similarity.toFixed(2)}`,
          `   Content excerpt: ${clipText(existingBody || entry.leaf.summary, 260)}`,
        ].join("\n");
      }),
    ].join("\n"),
    timeoutMs: 8000,
  });

  const actionToken = typeof payload?.action === "string" ? payload.action.trim().toLowerCase() : "";
  const existingLeafId = typeof payload?.existing_leaf_id === "string" ? payload.existing_leaf_id.trim() : "";
  const shortlistIds = new Set(params.shortlist.map((entry) => entry.leaf.leafId));
  const validLeafId = existingLeafId && shortlistIds.has(existingLeafId) ? existingLeafId : null;
  switch (actionToken) {
    case "same_memory":
    case "supersedes_existing":
    case "different_memory":
    case "unsure":
      return {
        action: actionToken,
        leafId: validLeafId,
      };
    default:
      return {
        action: "unsure",
        leafId: null,
      };
  }
}

function deterministicEntitySpec(candidate: InteractionLeafCandidate): {
  entityType: InteractionEntityType;
  canonicalName: string;
  fallback: boolean;
} {
  const typeHint = interactionEntityTypeHint(candidate.memoryType);
  if (typeHint === "preference") {
    return {
      entityType: "preference",
      canonicalName: clipText(candidate.title || candidate.subjectKey, 80),
      fallback: false,
    };
  }
  if (typeHint === "identity") {
    return {
      entityType: "identity",
      canonicalName: clipText(candidate.title || candidate.subjectKey, 80),
      fallback: false,
    };
  }
  const stableSubject = inferStableSubjectHint(candidate);
  if (stableSubject) {
    return {
      entityType: stableSubject.entityType,
      canonicalName: stableSubject.canonicalName,
      fallback: false,
    };
  }
  if (typeHint === "system") {
    return {
      entityType: "system",
      canonicalName: clipText(candidate.title || candidate.subjectKey, 80),
      fallback: false,
    };
  }
  if ((candidate.memoryType ?? "").trim().toLowerCase() === "procedure") {
    return {
      entityType: "workflow",
      canonicalName: clipText(candidate.title || candidate.subjectKey, 80),
      fallback: false,
    };
  }
  return {
    entityType: "misc",
    canonicalName: INTERACTION_UNCATEGORIZED_NAME,
    fallback: true,
  };
}

function entityIdForSpec(entityType: InteractionEntityType, canonicalName: string): {
  entityId: string;
  slug: string;
} {
  const slugBase = safePathSegment(canonicalName, entityType);
  if (slugBase === INTERACTION_UNCATEGORIZED_SLUG || canonicalName === INTERACTION_UNCATEGORIZED_NAME) {
    return {
      entityId: INTERACTION_UNCATEGORIZED_ENTITY_ID,
      slug: INTERACTION_UNCATEGORIZED_SLUG,
    };
  }
  return {
    entityId: `interaction:${entityType}:${slugBase}`,
    slug: `${entityType}-${slugBase}`,
  };
}

function ensureInteractionEntity(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entityType: InteractionEntityType;
  canonicalName: string;
  summary?: string | null;
  aliases?: string[];
  isSystem?: boolean;
}): InteractionEntityRecord {
  const identity = entityIdForSpec(params.entityType, params.canonicalName);
  const existing = params.store.getInteractionEntity({
    workspaceId: params.workspaceId,
    entityId: identity.entityId,
  }) ?? params.store.getInteractionEntityBySlug({
    workspaceId: params.workspaceId,
    slug: identity.slug,
  });
  if (existing) {
    return params.store.upsertInteractionEntity({
      workspaceId: params.workspaceId,
      entityId: existing.entityId,
      entityType: params.entityType,
      canonicalName: params.canonicalName,
      slug: existing.slug,
      summary: params.summary ?? existing.summary,
      aliases: Array.from(new Set([...(existing.aliases ?? []), ...(params.aliases ?? [])])),
      isSystem: params.isSystem ?? existing.isSystem,
      status: existing.status,
    });
  }
  return params.store.upsertInteractionEntity({
    workspaceId: params.workspaceId,
    entityId: identity.entityId,
    entityType: params.entityType,
    canonicalName: params.canonicalName,
    slug: identity.slug,
    summary: params.summary ?? null,
    aliases: params.aliases ?? [],
    isSystem: params.isSystem ?? identity.entityId === INTERACTION_UNCATEGORIZED_ENTITY_ID,
    status: "active",
  });
}

function ensureUncategorizedEntity(store: RuntimeStateStore, workspaceId: string): InteractionEntityRecord {
  return ensureInteractionEntity({
    store,
    workspaceId,
    entityType: "misc",
    canonicalName: INTERACTION_UNCATEGORIZED_NAME,
    summary: "Fallback interaction tree for durable leaves that could not yet be confidently assigned to a more specific entity.",
    isSystem: true,
  });
}

async function assignEntityWithModel(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  candidate: InteractionLeafCandidate;
  modelClient: MemoryModelClientConfig | null;
}): Promise<AssignedInteractionEntity> {
  const shortlist = params.store.listInteractionEntities({
    workspaceId: params.workspaceId,
    status: "active",
    includeSystem: false,
    limit: MAX_ENTITY_SHORTLIST,
    offset: 0,
  });
  const stableSubject = inferStableSubjectHint(params.candidate);
  const existingByHint = findExistingEntityBySubjectHint({
    shortlist,
    hint: stableSubject,
  });
  if (existingByHint) {
    return {
      entity: existingByHint,
      confidence: stableSubject?.confidence === "high" ? 0.9 : 0.75,
      secondaryEntityIds: [],
      action: "matched",
    };
  }
  const existingIds = new Set(shortlist.map((entity) => entity.entityId));
  if (!params.modelClient) {
    const fallbackSpec = deterministicEntitySpec(params.candidate);
    if (fallbackSpec.fallback) {
      return {
        entity: ensureUncategorizedEntity(params.store, params.workspaceId),
        confidence: null,
        secondaryEntityIds: [],
        action: "fallback",
      };
    }
    return {
      entity: ensureInteractionEntity({
        store: params.store,
        workspaceId: params.workspaceId,
        entityType: fallbackSpec.entityType,
        canonicalName: fallbackSpec.canonicalName,
      }),
      confidence: 0.5,
      secondaryEntityIds: [],
      action: "created",
    };
  }

  const payload = await queryMemoryModelJson(params.modelClient, {
    systemPrompt: [
      "You assign one durable interaction memory chunk to exactly one interaction entity tree.",
      "Return strict JSON only with this shape:",
      '{"action":"match_existing|create_new|fallback","existing_entity_id":"string|null","new_entity_type":"project|workflow|preference|identity|person|customer|system|misc|null","new_entity_name":"string|null","secondary_entity_ids":["string"],"confidence":0.0,"rationale":"string"}',
      "Choose the owner tree based on the stable primary subject the memory is about.",
      "A memory being a procedure, contact, threshold, channel, dashboard, or owner fact does not by itself imply workflow ownership.",
      "Use workflow ownership only when the workflow or runbook itself is the enduring named subject, rather than some larger customer, project, or system.",
      "Use match_existing only when the chunk clearly belongs under one existing entity.",
      "Use create_new only when there is a clear, reusable subject that deserves its own entity.",
      "Use fallback when neither is confident.",
      "Exactly one primary action only.",
    ].join(" "),
    userPrompt: [
      `Workspace ID: ${params.workspaceId}`,
      `Chunk title: ${params.candidate.title}`,
      `Chunk summary: ${params.candidate.summary}`,
      `Chunk subject key: ${params.candidate.subjectKey}`,
      `Chunk tags: ${params.candidate.tags.join(", ") || "none"}`,
      `Memory type hint: ${params.candidate.memoryType ?? "none"}`,
      `Stable subject hint: ${stableSubject ? `${stableSubject.canonicalName} (${stableSubject.entityType})` : "none"}`,
      "",
      "Chunk content:",
      clipText(params.candidate.content, 2000),
      "",
      "Existing entities:",
      ...(shortlist.length > 0
        ? shortlist.map((entity) => `- ${entity.entityId} | ${entity.entityType} | ${entity.canonicalName}`)
        : ["- none"]),
    ].join("\n"),
    timeoutMs: 8000,
  });

  if (!payload) {
    return {
      entity: ensureUncategorizedEntity(params.store, params.workspaceId),
      confidence: null,
      secondaryEntityIds: [],
      action: "fallback",
    };
  }

  const actionToken = typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "";
  const confidence = normalizeConfidence(payload.confidence);
  const secondaryEntityIds = normalizeEntityIdList(payload.secondary_entity_ids, existingIds);

  if (
    actionToken === "match_existing" &&
    typeof payload.existing_entity_id === "string" &&
    existingIds.has(payload.existing_entity_id.trim()) &&
    (confidence ?? 0) >= ENTITY_MATCH_CONFIDENCE_THRESHOLD
  ) {
    const entity = params.store.getInteractionEntity({
      workspaceId: params.workspaceId,
      entityId: payload.existing_entity_id.trim(),
    });
    if (entity) {
      return {
        entity,
        confidence,
        secondaryEntityIds: secondaryEntityIds.filter((entityId) => entityId !== entity.entityId),
        action: "matched",
      };
    }
  }

  const newEntityType = normalizeEntityType(payload.new_entity_type);
  const newEntityName = typeof payload.new_entity_name === "string" ? clipText(payload.new_entity_name, 96) : "";
  if (
    actionToken === "create_new" &&
    newEntityType &&
    newEntityName &&
    (confidence ?? 0) >= ENTITY_CREATE_CONFIDENCE_THRESHOLD
  ) {
    if (
      stableSubject
      && stableSubject.entityType !== "workflow"
      && newEntityType === "workflow"
    ) {
      const entity = ensureInteractionEntity({
        store: params.store,
        workspaceId: params.workspaceId,
        entityType: stableSubject.entityType,
        canonicalName: stableSubject.canonicalName,
        aliases: [stableSubject.canonicalName],
      });
      return {
        entity,
        confidence,
        secondaryEntityIds: secondaryEntityIds.filter((entityId) => entityId !== entity.entityId),
        action: "created",
      };
    }
    const entity = ensureInteractionEntity({
      store: params.store,
      workspaceId: params.workspaceId,
      entityType: newEntityType,
      canonicalName: newEntityName,
      aliases: [newEntityName],
    });
    return {
      entity,
      confidence,
      secondaryEntityIds: secondaryEntityIds.filter((entityId) => entityId !== entity.entityId),
      action: "created",
    };
  }

  const fallbackSpec = deterministicEntitySpec(params.candidate);
  if (!fallbackSpec.fallback) {
    return {
      entity: ensureInteractionEntity({
        store: params.store,
        workspaceId: params.workspaceId,
        entityType: fallbackSpec.entityType,
        canonicalName: fallbackSpec.canonicalName,
      }),
      confidence,
      secondaryEntityIds,
      action: "created",
    };
  }

  return {
    entity: ensureUncategorizedEntity(params.store, params.workspaceId),
    confidence,
    secondaryEntityIds,
    action: "fallback",
  };
}

function summaryNodeBody(params: {
  entity: InteractionEntityRecord;
  title: string;
  summary: string;
  children: Array<{ title: string; summary: string }>;
}): string {
  const lines = [
    `# ${params.title}`,
    "",
    `- Entity: \`${params.entity.entityId}\``,
    `- Entity name: ${params.entity.canonicalName}`,
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

function semanticInteractionNodeBody(params: {
  entity: InteractionEntityRecord;
  nodeKind: "tree" | "partition";
  title: string;
  summary: string;
  childCount: number;
  isMaterialized: boolean;
  children: Array<{ title: string; summary: string }>;
}): string {
  const lines = [
    `# ${params.title}`,
    "",
    `- Category: interaction`,
    `- Entity: \`${params.entity.entityId}\``,
    `- Entity name: ${params.entity.canonicalName}`,
    `- Entity type: ${params.entity.entityType}`,
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

function deterministicSummaryText(params: {
  entity: InteractionEntityRecord;
  childCount: number;
  childTitles: string[];
}): string {
  return clipText(
    `${params.entity.canonicalName} memory slice covering ${params.childCount} nodes: ${params.childTitles.slice(0, 4).join(", ")}`,
    240,
  );
}

async function generateSummaryText(params: {
  entity: InteractionEntityRecord;
  children: Array<{
    kind: InteractionTreeChildKind;
    id: string;
    title: string;
    summary: string;
    excerpt: string | null;
  }>;
  depthFromLeaves: number;
  ordinal: number;
  modelClient: MemoryModelClientConfig | null;
}): Promise<string> {
  const childTitles = params.children.map((child) => child.title);
  const fallback = deterministicSummaryText({
    entity: params.entity,
    childCount: params.children.length,
    childTitles,
  });
  if (!params.modelClient) {
    return fallback;
  }

  const payload = await queryMemoryModelJson(params.modelClient, {
    systemPrompt: [
      "You write concise markdown-tree summary sentences for durable memory nodes.",
      "Return strict JSON only with this shape:",
      '{"summary":"string"}',
      "Write a faithful 1-3 sentence summary of the child nodes.",
      "Do not invent facts not present in the child summaries.",
      "Prefer concrete reusable knowledge over generic phrasing.",
    ].join(" "),
    userPrompt: [
      `Entity ID: ${params.entity.entityId}`,
      `Entity name: ${params.entity.canonicalName}`,
      `Tree depth from leaves: ${params.depthFromLeaves}`,
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

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function buildSemanticInteractionPartitionNode(params: {
  entity: InteractionEntityRecord;
  rootPath: string;
  children: SemanticInteractionDraftChild[];
  depthFromLeaves: number;
  ordinal: number;
  modelClient: MemoryModelClientConfig | null;
  existingSummaryByNodeId: Map<string, ExistingInteractionSummaryNode>;
}): Promise<{
  node: SemanticInteractionDraftNode;
  body: string;
  child: SemanticInteractionDraftChild;
}> {
  const childIdentity = params.children.map((child) => `${child.kind}:${child.id}`).join("|");
  const nodeId = `semantic:interaction:${params.entity.entityId}:partition:L${params.depthFromLeaves}:${sha256(childIdentity).slice(0, 16)}`;
  const title = `Slice ${params.ordinal}`;
  const inputFingerprint = interactionSummaryInputFingerprint({
    entity: params.entity,
    nodeKind: "partition",
    title,
    depthFromLeaves: params.depthFromLeaves,
    ordinal: params.ordinal,
    children: params.children.map((child) => ({
      kind: child.kind,
      id: child.id,
      title: child.title,
      summary: child.summary,
      excerpt: child.excerpt,
    })),
  });
  const reused = existingInteractionSummaryNode({
    cache: params.existingSummaryByNodeId,
    nodeId,
    inputFingerprint,
  });
  const summary = reused?.node.summary ?? await generateSummaryText({
    entity: params.entity,
    children: params.children.map((child) => ({
      kind: child.kind,
      id: child.id,
      title: child.title,
      summary: child.summary,
      excerpt: child.excerpt,
    })),
    depthFromLeaves: params.depthFromLeaves,
    ordinal: params.ordinal,
    modelClient: params.modelClient,
  });
  const path = semanticInteractionChildRelativePath(
    params.rootPath,
    `slice-l${params.depthFromLeaves}-${String(params.ordinal).padStart(2, "0")}-${nodeId.slice(-6)}`,
  );
  const body = reused?.body ?? semanticInteractionNodeBody({
    entity: params.entity,
    nodeKind: "partition",
    title,
    summary,
    childCount: params.children.length,
    isMaterialized: true,
    children: params.children.map((child) => ({
      title: child.title,
      summary: child.summary,
    })),
  });
  const observedAt = params.children
    .map((child) => child.observedAt)
    .find((value) => Boolean(value)) ?? null;
  return {
    node: {
      nodeId,
      nodeClass: "semantic",
      nodeKind: "partition",
      sourceLeafId: null,
      path,
      title,
      summary,
      bodySha256: sha256(body),
      childCount: params.children.length,
      observedAt,
      isMaterialized: true,
      metadata: {
        depth_from_leaves: params.depthFromLeaves,
        ordinal: params.ordinal,
        source: "interaction_summary",
        summary_input_fingerprint: inputFingerprint,
      },
    },
    body,
    child: {
      kind: "summary",
      id: nodeId,
      title,
      summary,
      excerpt: markdownExcerpt(body),
      observedAt,
    },
  };
}

async function buildSemanticInteractionTree(params: {
  workspaceId: string;
  entity: InteractionEntityRecord;
  leaves: InteractionLeafRecord[];
  leafBodies: Map<string, string>;
  modelClient: MemoryModelClientConfig | null;
  existingSummaryByNodeId: Map<string, ExistingInteractionSummaryNode>;
}): Promise<{
  nodes: SemanticInteractionDraftNode[];
  edges: Array<{
    parentNodeId: string;
    childNodeId: string;
    position: number;
  }>;
  bodiesByPath: Map<string, string>;
}> {
  const rootNodeId = semanticInteractionRootNodeId(params.entity.entityId);
  const rootPath = semanticInteractionTreeRelativePath(params.workspaceId, params.entity.slug);
  const nodes: SemanticInteractionDraftNode[] = [];
  const leafNodesById = new Map<string, SemanticInteractionDraftNode>();
  const leavesByNodeId = new Map<string, InteractionLeafRecord>();
  const edges: Array<{
    parentNodeId: string;
    childNodeId: string;
    position: number;
  }> = [];
  const bodiesByPath = new Map<string, string>();

  for (const leaf of params.leaves) {
    const leafNodeId = semanticInteractionLeafNodeId(params.entity.entityId, leaf.leafId);
    const node: SemanticInteractionDraftNode = {
      nodeId: leafNodeId,
      nodeClass: "leaf",
      nodeKind: "leaf",
      sourceLeafId: leaf.leafId,
      path: leaf.path,
      title: leaf.title,
      summary: leaf.summary,
      bodySha256: leaf.bodySha256,
      childCount: 0,
      observedAt: leaf.observedAt ?? leaf.updatedAt,
      isMaterialized: false,
      metadata: {
        subject_key: leaf.subjectKey,
        tags: leaf.tags,
        secondary_entity_ids: leaf.secondaryEntityIds,
        source_type: leaf.sourceType,
        evidence_path: leaf.path,
        source_event_id: leaf.sourceEventId,
        source_message_id: leaf.sourceMessageId,
        source_turn_input_id: leaf.sourceTurnInputId,
      },
    };
    nodes.push(node);
    leafNodesById.set(leafNodeId, node);
    leavesByNodeId.set(leafNodeId, leaf);
  }

  let currentChildren: SemanticInteractionDraftChild[] = params.leaves.map((leaf) => ({
    kind: "leaf",
    id: semanticInteractionLeafNodeId(params.entity.entityId, leaf.leafId),
    title: leaf.title,
    summary: leaf.summary,
    excerpt: markdownExcerpt(
      params.leafBodies.get(leaf.leafId) ?? interactionFallbackLeafBody(leaf),
    ),
    observedAt: leaf.observedAt ?? leaf.updatedAt,
  }));
  let depthFromLeaves = 1;
  while (currentChildren.length > INTERACTION_BRANCH_FACTOR) {
    const nextChildren: SemanticInteractionDraftChild[] = [];
    const groups = chunkArray(currentChildren, INTERACTION_BRANCH_FACTOR);
    const layer = await Promise.all(
      groups.map((group, index) =>
        buildSemanticInteractionPartitionNode({
          entity: params.entity,
          rootPath,
          children: group,
          depthFromLeaves,
          ordinal: index + 1,
          modelClient: params.modelClient,
          existingSummaryByNodeId: params.existingSummaryByNodeId,
        })),
    );
    for (const [index, partition] of layer.entries()) {
      nodes.push(partition.node);
      bodiesByPath.set(partition.node.path, partition.body);
      nextChildren.push(partition.child);
      for (const [childIndex, child] of (groups[index] ?? []).entries()) {
        if (child.kind === "leaf") {
          const leaf = leavesByNodeId.get(child.id);
          const leafNode = leafNodesById.get(child.id);
          if (leaf && leafNode) {
            leafNode.path = semanticInteractionLeafRelativePath(partition.node.path, leaf);
            bodiesByPath.set(
              leafNode.path,
              params.leafBodies.get(leaf.leafId) ?? interactionFallbackLeafBody(leaf),
            );
          }
        }
        edges.push({
          parentNodeId: partition.node.nodeId,
          childNodeId: child.id,
          position: childIndex + 1,
        });
      }
    }
    currentChildren = nextChildren;
    depthFromLeaves += 1;
  }

  const rootInputFingerprint = interactionSummaryInputFingerprint({
    entity: params.entity,
    nodeKind: "tree",
    title: params.entity.canonicalName,
    depthFromLeaves,
    ordinal: 1,
    children: currentChildren.map((child) => ({
      kind: child.kind,
      id: child.id,
      title: child.title,
      summary: child.summary,
      excerpt: child.excerpt,
    })),
  });
  const reusedRoot = existingInteractionSummaryNode({
    cache: params.existingSummaryByNodeId,
    nodeId: rootNodeId,
    inputFingerprint: rootInputFingerprint,
  });
  const rootSummary = reusedRoot?.node.summary ?? (currentChildren.length > 0
    ? await generateSummaryText({
        entity: params.entity,
        children: currentChildren.map((child) => ({
          kind: child.kind,
          id: child.id,
          title: child.title,
          summary: child.summary,
          excerpt: child.excerpt,
        })),
        depthFromLeaves,
        ordinal: 1,
        modelClient: params.modelClient,
      })
    : (params.entity.summary?.trim() || `${params.entity.canonicalName} interaction memory.`));
  const rootBody = reusedRoot?.body ?? semanticInteractionNodeBody({
    entity: params.entity,
    nodeKind: "tree",
    title: params.entity.canonicalName,
    summary: rootSummary,
    childCount: currentChildren.length,
    isMaterialized: false,
    children: currentChildren.map((child) => ({
      title: child.title,
      summary: child.summary,
    })),
  });
  bodiesByPath.set(rootPath, rootBody);
  nodes.push({
    nodeId: rootNodeId,
    nodeClass: "semantic",
    nodeKind: "tree",
    sourceLeafId: null,
    path: rootPath,
    title: params.entity.canonicalName,
    summary: rootSummary,
    bodySha256: sha256(rootBody),
    childCount: currentChildren.length,
    observedAt: params.entity.updatedAt,
    isMaterialized: false,
    metadata: {
      entity_id: params.entity.entityId,
      entity_type: params.entity.entityType,
      entity_slug: params.entity.slug,
      source: "interaction_summary",
      summary_input_fingerprint: rootInputFingerprint,
    },
  });
  currentChildren.forEach((child, index) => {
    if (child.kind === "leaf") {
      const leaf = leavesByNodeId.get(child.id);
      const leafNode = leafNodesById.get(child.id);
      if (leaf && leafNode) {
        leafNode.path = semanticInteractionLeafRelativePath(rootPath, leaf);
        bodiesByPath.set(
          leafNode.path,
          params.leafBodies.get(leaf.leafId) ?? interactionFallbackLeafBody(leaf),
        );
      }
    }
    edges.push({
      parentNodeId: rootNodeId,
      childNodeId: child.id,
      position: index + 1,
    });
  });

  return {
    nodes,
    edges,
    bodiesByPath,
  };
}

function semanticSearchDocsForInteractionTree(params: {
  nodes: Awaited<ReturnType<typeof buildSemanticInteractionTree>>["nodes"];
  bodiesByPath: Awaited<ReturnType<typeof buildSemanticInteractionTree>>["bodiesByPath"];
}) {
  return params.nodes.map((node) => {
    const bodyText = params.bodiesByPath.get(node.path) ?? "";
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

async function syncNodeEmbedding(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entity: InteractionEntityRecord;
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
    entityName: params.entity.canonicalName,
    title: params.title,
    summary: params.summary,
    excerpt,
    nodeKind: params.nodeKind,
  });
  const contentFingerprint = sha256(embeddingText);
  const existing = params.store.getInteractionNodeEmbedding({
    workspaceId: params.workspaceId,
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    embeddingModel: params.embeddingClient.modelId,
  });
  if (existing && existing.contentFingerprint === contentFingerprint) {
    return;
  }
  const embedding = await queryMemoryModelEmbedding(params.embeddingClient, {
    input: embeddingText,
    timeoutMs: 7000,
  });
  if (!embedding) {
    return;
  }
  params.store.upsertInteractionNodeEmbedding({
    workspaceId: params.workspaceId,
    nodeKind: params.nodeKind,
    nodeId: params.nodeId,
    entityId: params.entity.entityId,
    embeddingModel: params.embeddingClient.modelId,
    contentFingerprint,
    dimensions: embedding.length,
    vector: Array.from(embedding),
  });
}

export async function persistInteractionCandidate(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  candidate: InteractionLeafCandidate;
  modelClient?: MemoryModelClientConfig | null;
  embeddingClient?: MemoryModelClientConfig | null;
}): Promise<PersistedInteractionLeafResult> {
  const entityAssignment = await assignEntityWithModel({
    store: params.store,
    workspaceId: params.workspaceId,
    candidate: params.candidate,
    modelClient: params.modelClient ?? null,
  });
  const entity = entityAssignment.entity;
  const contentFingerprint = sha256(params.candidate.content);
  const existingDuplicate = params.store.getInteractionLeafByFingerprint({
    workspaceId: params.workspaceId,
    entityId: entity.entityId,
    fingerprint: contentFingerprint,
  });
  if (existingDuplicate) {
    return {
      outcome: "noop_duplicate",
      entity,
      leaf: existingDuplicate,
    };
  }

  const activeLeaves = params.store.listInteractionLeaves({
    workspaceId: params.workspaceId,
    entityId: entity.entityId,
    status: "active",
    limit: 200,
    offset: 0,
  });
  const semanticShortlist = semanticDuplicateShortlist({
    candidate: params.candidate,
    leaves: activeLeaves,
  });
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const semanticDecision = await semanticDuplicateDecision({
    workspaceId: params.workspaceId,
    candidate: params.candidate,
    shortlist: semanticShortlist,
    modelClient: params.modelClient ?? null,
    workspaceDir,
  });
  const semanticMatch = semanticDecision.leafId
    ? semanticShortlist.find((entry) => entry.leaf.leafId === semanticDecision.leafId)?.leaf ?? null
    : null;
  if (semanticDecision.action === "same_memory" && semanticMatch) {
    return {
      outcome: "noop_duplicate",
      entity,
      leaf: semanticMatch,
    };
  }

  const leafId = `leaf-${sha256(`${params.workspaceId}|${entity.entityId}|${params.candidate.subjectKey}|${contentFingerprint}`).slice(0, 24)}`;
  const relativePath = interactionLeafRelativePath(params.workspaceId, entity.slug, leafId);
  const existingActive = activeLeaves.find((leaf) => leaf.subjectKey === params.candidate.subjectKey) ?? null;
  const leafToSupersede =
    semanticDecision.action === "supersedes_existing" && semanticMatch
      ? semanticMatch
      : existingActive;
  const absolutePath = absolutePathForRelative(workspaceDir, relativePath);
  writeFileIfChanged(absolutePath, params.candidate.content);

  let outcome: PersistedInteractionLeafResult["outcome"] = "created";
  if (leafToSupersede && leafToSupersede.fingerprint !== contentFingerprint) {
    const newSpecificity = specificityScoreForInteractionLeafCandidate(params.candidate);
    const supersededSpecificity = specificityScoreForInteractionLeafRecord(leafToSupersede);
    if (
      semanticDecision.action === "supersedes_existing"
      || newSpecificity >= supersededSpecificity
    ) {
      params.store.updateInteractionLeafStatus({
        workspaceId: params.workspaceId,
        leafId: leafToSupersede.leafId,
        status: "superseded",
        supersededAt: params.candidate.observedAt ?? utcNowIso(),
      });
      outcome = "superseding";
    } else {
      return {
        outcome: "noop_duplicate",
        entity,
        leaf: leafToSupersede,
      };
    }
  }

  const leaf = params.store.upsertInteractionLeaf({
    workspaceId: params.workspaceId,
    leafId,
    entityId: entity.entityId,
    subjectKey: params.candidate.subjectKey,
    path: relativePath,
    title: params.candidate.title,
    summary: params.candidate.summary,
    fingerprint: contentFingerprint,
    bodySha256: sha256(params.candidate.content),
    tags: params.candidate.tags,
    secondaryEntityIds: entityAssignment.secondaryEntityIds,
    sourceType: params.candidate.sourceType ?? null,
    sourceEventId: params.candidate.sourceEventId ?? null,
    sourceMessageId: params.candidate.sourceMessageId ?? null,
    sourceTurnInputId: params.candidate.sourceTurnInputId ?? null,
    admissionConfidence: params.candidate.confidence ?? null,
    entityConfidence: entityAssignment.confidence ?? null,
    observedAt: params.candidate.observedAt ?? null,
    supersedesLeafId:
      leafToSupersede && leafToSupersede.fingerprint !== contentFingerprint && outcome === "superseding"
        ? leafToSupersede.leafId
        : null,
    status: "active",
  });

  await syncNodeEmbedding({
    store: params.store,
    workspaceId: params.workspaceId,
    entity,
    nodeKind: "leaf",
    nodeId: leaf.leafId,
    title: leaf.title,
    summary: leaf.summary,
    body: params.candidate.content,
    embeddingClient: params.embeddingClient ?? null,
  });

  return {
    outcome,
    entity,
    leaf,
  };
}

export async function rebuildInteractionEntityTree(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entityId: string;
  summaryModelClient?: MemoryModelClientConfig | null;
  embeddingClient?: MemoryModelClientConfig | null;
}): Promise<void> {
  const entity = params.store.getInteractionEntity({
    workspaceId: params.workspaceId,
    entityId: params.entityId,
  });
  if (!entity) {
    return;
  }
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const entityDir = interactionEntityDir(workspaceDir, entity.slug);
  const semanticTreeDir = semanticInteractionTreeDir(workspaceDir, entity.slug);
  const summariesDir = path.join(entityDir, "summaries");
  const existingSummaryByNodeId = loadExistingInteractionSummaryNodes({
    store: params.store,
    workspaceId: params.workspaceId,
    entity,
  });
  fs.rmSync(summariesDir, { recursive: true, force: true });
  fs.rmSync(
    absolutePathForRelative(
      workspaceDir,
      interactionCanonicalContentPath(
        interactionCanonicalTreeBaseSegments(params.workspaceId, entity.slug),
      ),
    ).replace(/\/content\.md$/, ""),
    { recursive: true, force: true },
  );

  const activeLeaves = params.store
    .listInteractionLeaves({
      workspaceId: params.workspaceId,
      entityId: params.entityId,
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
      absolutePathForRelative(workspaceDir, leaf.path),
    ) ?? interactionFallbackLeafBody(leaf);
    leafBodies.set(leaf.leafId, body);
  }

  const semantic = await buildSemanticInteractionTree({
    workspaceId: params.workspaceId,
    entity,
    leaves: activeLeaves,
    leafBodies,
    modelClient: params.summaryModelClient ?? null,
    existingSummaryByNodeId,
  });
  for (const [relativePath, body] of semantic.bodiesByPath) {
    writeFileIfChanged(absolutePathForRelative(workspaceDir, relativePath), body);
  }
  removeObsoleteFiles(
    semanticTreeDir,
    new Set(
      [...semantic.bodiesByPath.keys()].map((relativePath) =>
        path.resolve(absolutePathForRelative(workspaceDir, relativePath))
      ),
    ),
  );
  params.store.syncSemanticMemoryTree({
    category: "interaction",
    workspaceId: params.workspaceId,
    treeId: params.entityId,
    nodes: semantic.nodes,
    edges: semantic.edges,
  });
  params.store.syncSemanticMemoryRelations({
    category: "interaction",
    workspaceId: params.workspaceId,
    treeId: params.entityId,
    relations: [],
  });
  params.store.syncSemanticMemorySearchDocs({
    category: "interaction",
    workspaceId: params.workspaceId,
    treeId: params.entityId,
    docs: semanticSearchDocsForInteractionTree({
      nodes: semantic.nodes,
      bodiesByPath: semantic.bodiesByPath,
    }),
  });
  for (const node of semantic.nodes) {
    if (node.nodeClass !== "semantic") {
      continue;
    }
    const body = semantic.bodiesByPath.get(node.path);
    if (!body) {
      continue;
    }
    await syncNodeEmbedding({
      store: params.store,
      workspaceId: params.workspaceId,
      entity,
      nodeKind: "summary",
      nodeId: node.nodeId,
      title: node.title,
      summary: node.summary,
      body,
      embeddingClient: params.embeddingClient ?? null,
    });
  }
}

export async function rebuildAllInteractionTrees(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
}): Promise<{ entities: number; summaries: number }> {
  const summaryModelClient = createBackgroundTaskMemoryModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId ?? `memory-sync:${params.workspaceId}`,
    inputId: params.inputId ?? `memory-sync:${params.workspaceId}`,
    selectedModel: params.selectedModel ?? null,
  });
  const embeddingClient = createRecallEmbeddingModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId ?? `memory-sync:${params.workspaceId}`,
    inputId: params.inputId ?? `memory-sync:${params.workspaceId}`,
    selectedModel: params.selectedModel ?? null,
  });
  const entities = params.store.listInteractionEntities({
    workspaceId: params.workspaceId,
    status: "active",
    includeSystem: true,
    limit: 10_000,
    offset: 0,
  });
  let summaryCount = 0;
  for (const entity of entities) {
    await rebuildInteractionEntityTree({
      store: params.store,
      workspaceId: params.workspaceId,
      entityId: entity.entityId,
      summaryModelClient,
      embeddingClient,
    });
    summaryCount += params.store.listSemanticMemoryNodes({
      category: "interaction",
      workspaceId: params.workspaceId,
      treeId: entity.entityId,
      nodeClass: "semantic",
      status: "active",
      limit: 10_000,
      offset: 0,
    }).filter((node) => isSummaryLikeSemanticInteractionNode(node)).length;
  }
  return {
    entities: entities.length,
    summaries: summaryCount,
  };
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
    sessionId: params.sessionId ?? `memory-retrieve:${params.workspaceId}`,
    inputId: params.inputId ?? `memory-retrieve:${params.workspaceId}`,
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
  workspaceId: string;
  treeId: string;
}): Map<string, ReturnType<RuntimeStateStore["listSemanticMemorySearchDocs"]>[number]> {
  return new Map(
    params.store.listSemanticMemorySearchDocs({
      category: "interaction",
      workspaceId: params.workspaceId,
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

function listInteractionVectorCandidateSearchDocs(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  mode: "mixed" | "summaries" | "leaves";
  treeId?: string | null;
  embeddingModelId: string;
  queryVector: number[];
  maxResults: number;
}): SemanticSearchDoc[] {
  const vectorHits = params.store.searchInteractionNodeEmbeddingsByVector({
    workspaceId: params.workspaceId,
    embedding: new Float32Array(params.queryVector),
    embeddingModel: params.embeddingModelId,
    limit: Math.max(RETRIEVAL_VECTOR_CANDIDATE_LIMIT, params.maxResults * 16),
    entityIds: params.treeId ? [params.treeId] : undefined,
    nodeKinds: retrievalVectorNodeKindsForMode(params.mode),
  });
  if (vectorHits.length === 0) {
    return [];
  }
  const docsByNodeId = new Map(
    params.store.listSemanticMemorySearchDocs({
      category: "interaction",
      workspaceId: params.workspaceId,
      treeId: params.treeId ?? undefined,
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
  workspaceId: string;
  query: string;
  mode: "mixed" | "summaries" | "leaves";
  treeId?: string | null;
}): Map<string, number> {
  const matchQuery = buildRetrievalFtsMatchQuery(params.query);
  if (!matchQuery) {
    return new Map();
  }
  const hits = params.store.searchSemanticMemorySearchDocs({
    category: "interaction",
    workspaceId: params.workspaceId,
    treeId: params.treeId ?? undefined,
    nodeClass: retrievalNodeClassForMode(params.mode),
    status: "active",
    matchQuery,
    limit: 500,
    offset: 0,
  });
  return new Map(hits.map((hit, index) => [hit.nodeId, index + 1]));
}

function listInteractionCandidateSearchDocs(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  mode: "mixed" | "summaries" | "leaves";
  treeId?: string | null;
  maxResults: number;
  vectorDocs?: SemanticSearchDoc[];
}): SemanticSearchDoc[] {
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
      category: "interaction",
      workspaceId: params.workspaceId,
      treeId: params.treeId ?? undefined,
      nodeClass,
      status: "active",
      matchQuery,
      limit: ftsLimit,
      offset: 0,
    }));
  }
  addDocs(params.vectorDocs ?? []);
  addDocs(params.store.listSemanticMemorySearchDocs({
    category: "interaction",
    workspaceId: params.workspaceId,
    treeId: params.treeId ?? undefined,
    nodeClass,
    status: "active",
    limit: matchQuery ? recentLimit : poolLimit,
    offset: 0,
  }));
  return [...docsByNodeId.values()];
}

function buildLeafCandidate(params: {
  entity: InteractionEntityRecord;
  leaf: InteractionLeafRecord;
}): NodeCandidate {
  return {
    kind: "leaf",
    id: params.leaf.leafId,
    entity: params.entity,
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

function semanticInteractionCandidateKind(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): InteractionTreeChildKind {
  return node.nodeClass === "leaf" ? "leaf" : "summary";
}

function semanticInteractionCandidateKindForDoc(
  doc: Pick<SemanticSearchDoc, "nodeClass">,
): InteractionTreeChildKind {
  return doc.nodeClass === "leaf" ? "leaf" : "summary";
}

function isSummaryLikeSemanticInteractionNode(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): boolean {
  return node.nodeClass === "semantic" && (node.nodeKind !== "tree" || node.childCount > 1);
}

function semanticInteractionNodeLevel(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): number | null {
  if (node.nodeClass === "leaf") {
    return null;
  }
  const nodesDepth = semanticTreePathDepth(node.path, ["semantic", "interaction", "trees"]);
  if (nodesDepth === null) {
    return null;
  }
  return node.nodeKind === "tree" ? 1 : nodesDepth + 1;
}

function semanticInteractionNodeLevelForDoc(
  doc: Pick<SemanticSearchDoc, "nodeClass" | "nodeKind" | "path">,
): number | null {
  if (doc.nodeClass === "leaf") {
    return null;
  }
  const nodesDepth = semanticTreePathDepth(doc.path, ["semantic", "interaction", "trees"]);
  if (nodesDepth === null) {
    return null;
  }
  return doc.nodeKind === "tree" ? 1 : nodesDepth + 1;
}

function buildSemanticCandidate(params: {
  entity: InteractionEntityRecord;
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number];
  searchDoc?: ReturnType<RuntimeStateStore["getSemanticMemorySearchDoc"]> | null;
}): NodeCandidate {
  const excerpt = params.searchDoc?.excerpt ?? (params.node.summary ? clipText(params.node.summary, 320) : null);
  return {
    kind: semanticInteractionCandidateKind(params.node),
    id: params.node.nodeId,
    entity: params.entity,
    title: params.node.title,
    summary: params.node.summary,
    excerpt,
    path: params.node.path,
    level: semanticInteractionNodeLevel(params.node),
    childCount: params.node.childCount,
    observedAt: params.node.observedAt,
    updatedAt: params.node.updatedAt,
  };
}

function buildSemanticCandidateFromSearchDoc(params: {
  entity: InteractionEntityRecord;
  doc: SemanticSearchDoc;
}): NodeCandidate {
  return {
    kind: semanticInteractionCandidateKindForDoc(params.doc),
    id: params.doc.nodeId,
    entity: params.entity,
    title: params.doc.title,
    summary: params.doc.summary,
    excerpt: params.doc.excerpt,
    path: params.doc.path,
    level: semanticInteractionNodeLevelForDoc(params.doc),
    childCount: params.doc.childCount,
    observedAt: params.doc.observedAt,
    updatedAt: params.doc.updatedAt,
  };
}

function loadInteractionEmbeddingsByCandidateKey(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  embeddingModelId: string | null;
  candidateIds: string[];
}): Map<string, number[]> {
  const normalizedCandidateIds = [...new Set(params.candidateIds.map((value) => value.trim()).filter(Boolean))];
  if (!params.embeddingModelId || normalizedCandidateIds.length === 0) {
    return new Map();
  }
  const embeddingByKey = new Map<string, number[]>();
  for (const record of params.store.listInteractionNodeEmbeddings({
    workspaceId: params.workspaceId,
    embeddingModel: params.embeddingModelId,
    nodeIds: normalizedCandidateIds,
  })) {
    embeddingByKey.set(`${record.nodeKind}:${record.nodeId}:${record.embeddingModel}`, record.vector);
  }
  return embeddingByKey;
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
    params.candidate.entity.canonicalName,
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
    const embeddingKey = `${params.candidate.kind}:${params.candidate.id}:${params.embeddingModelId}`;
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
    if (params.mode === "summaries" && params.candidate.kind === "summary") {
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
}): InteractionMemoryRetrieveHit {
  return {
    node_kind: params.candidate.kind,
    node_id: params.candidate.id,
    tree_id: params.candidate.entity.entityId,
    entity_id: params.candidate.entity.entityId,
    entity_name: params.candidate.entity.canonicalName,
    entity_type: params.candidate.entity.entityType,
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
}): Promise<InteractionMemoryRetrieveHit[]> {
  const semanticEntity = params.store.listInteractionEntities({
    workspaceId: params.workspaceId,
    status: "active",
    includeSystem: true,
    limit: 10_000,
    offset: 0,
  }).find((entity) =>
    Boolean(
      params.store.getSemanticMemoryNode({
        category: "interaction",
        workspaceId: params.workspaceId,
        treeId: entity.entityId,
        nodeId: params.parentNodeId,
      }),
    ),
  ) ?? null;
  if (semanticEntity) {
    const searchDocsByNodeId = semanticSearchDocsByNodeId({
      store: params.store,
      workspaceId: params.workspaceId,
      treeId: semanticEntity.entityId,
    });
    const lexicalRanksByNodeId = semanticLexicalRanksByNodeId({
      store: params.store,
      workspaceId: params.workspaceId,
      query: params.query,
      mode: params.mode,
      treeId: semanticEntity.entityId,
    });
    const candidates = params.store
      .listSemanticMemoryChildren({
        category: "interaction",
        workspaceId: params.workspaceId,
        treeId: semanticEntity.entityId,
        parentNodeId: params.parentNodeId,
      })
      .map((child) =>
        params.store.getSemanticMemoryNode({
          category: "interaction",
          workspaceId: params.workspaceId,
          treeId: semanticEntity.entityId,
          nodeId: child.childNodeId,
        }))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .map((node) =>
        buildSemanticCandidate({
          entity: semanticEntity,
          node,
          searchDoc: searchDocsByNodeId.get(node.nodeId) ?? null,
        }))
      .filter((candidate) => params.mode === "mixed"
        || (params.mode === "leaves" ? candidate.kind === "leaf" : candidate.kind === "summary"));
    const embeddingByKey = loadInteractionEmbeddingsByCandidateKey({
      store: params.store,
      workspaceId: params.workspaceId,
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
          reasons: scored.reasons.length > 0 ? scored.reasons : ["child_traversal"],
        });
      })
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  }
  return [];
}

export async function retrieveInteractionMemory(params: {
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
}): Promise<InteractionMemoryRetrieveResult> {
  const mode = params.mode ?? "mixed";
  const maxResults = Math.max(1, Math.min(params.maxResults ?? MAX_RETRIEVE_RESULTS, 50));
  const entities = params.treeId
    ? (() => {
        const entity = params.store.getInteractionEntity({
          workspaceId: params.workspaceId,
          entityId: params.treeId,
        });
        return entity ? [entity] : [];
      })()
    : params.store.listInteractionEntities({
        workspaceId: params.workspaceId,
        status: "active",
        includeSystem: true,
        limit: 10_000,
        offset: 0,
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
    workspaceId: params.workspaceId,
    query: params.query,
    mode,
    treeId: params.treeId ?? null,
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

  const entityById = new Map(entities.map((entity) => [entity.entityId, entity]));
  const vectorCandidateDocs = embeddingQuery
    ? listInteractionVectorCandidateSearchDocs({
        store: params.store,
        workspaceId: params.workspaceId,
        mode,
        treeId: params.treeId ?? null,
        embeddingModelId: embeddingQuery.modelId,
        queryVector: embeddingQuery.vector,
        maxResults,
      })
    : [];
  const candidateDocs = listInteractionCandidateSearchDocs({
    store: params.store,
    workspaceId: params.workspaceId,
    query: params.query,
    mode,
    treeId: params.treeId ?? null,
    maxResults,
    vectorDocs: vectorCandidateDocs,
  });
  let candidates = candidateDocs
    .map((doc) => {
      const entity = entityById.get(doc.treeId);
      if (!entity) {
        return null;
      }
      return buildSemanticCandidateFromSearchDoc({
        entity,
        doc,
      });
    })
    .filter((candidate): candidate is NodeCandidate => Boolean(candidate));
  if (candidates.length === 0 && mode !== "summaries") {
    candidates = params.store
      .listInteractionLeaves({
        workspaceId: params.workspaceId,
        entityId: params.treeId ?? undefined,
        status: "active",
        limit: Math.max(RETRIEVAL_RECENT_CANDIDATE_LIMIT, maxResults * 12),
        offset: 0,
      })
      .map((leaf) => {
        const entity = entityById.get(leaf.entityId);
        if (!entity) {
          return null;
        }
        return buildLeafCandidate({
          entity,
          leaf,
        });
      })
      .filter((candidate): candidate is NodeCandidate => Boolean(candidate))
      .filter((candidate) => mode === "mixed" || candidate.kind === "leaf");
  }
  const embeddingByKey = loadInteractionEmbeddingsByCandidateKey({
    store: params.store,
    workspaceId: params.workspaceId,
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

export async function buildRecalledInteractionMemoryContext(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  maxResults?: number;
}): Promise<AgentRecalledMemoryContext | null> {
  const result = await retrieveInteractionMemory({
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
      scope: "interaction",
      memory_type: hit.node_kind === "summary" ? "summary" : "leaf",
      title: hit.title,
      summary: hit.summary,
      path: hit.path,
      verification_policy: "none",
      staleness_policy: "workspace_sensitive",
      freshness_state: "fresh",
      freshness_note: hit.node_kind === "summary"
        ? `Tree summary from ${hit.entity_name}.`
        : `Leaf memory from ${hit.entity_name}.`,
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
