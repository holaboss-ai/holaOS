import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type IntegrationConnectionRecord,
  type IntegrationLeafRecord,
  type IntegrationSummaryNodeRecord,
  type IntegrationTreeRecord,
  type InteractionTreeChildKind,
  type RuntimeStateStore,
  utcNowIso,
} from "@holaboss/runtime-state-store";

import type { AgentRecalledMemoryContext } from "./agent-runtime-prompt.js";
import { createBackgroundTaskMemoryModelClient } from "./background-task-model.js";
import { queryMemoryModelEmbedding, queryMemoryModelJson, type MemoryModelClientConfig } from "./memory-model-client.js";
import { createRecallEmbeddingModelClient } from "./recall-embedding-model.js";
import { globalMemoryDirForWorkspaceRoot } from "./workspace-bundle-paths.js";

const INTEGRATION_BRANCH_FACTOR = 8;
const MAX_RETRIEVE_RESULTS = 12;
const EMBEDDING_EXCERPT_CHARS = 480;

export interface IntegrationLeafCandidate {
  provider: string;
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  subjectKey: string;
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
  node_kind: InteractionTreeChildKind;
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
  kind: InteractionTreeChildKind;
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
  return path.join(integrationMemoryRootDir(workspaceRoot), "accounts", slug);
}

function integrationLeafRelativePath(treeSlug: string, leafId: string): string {
  return path.posix.join(
    "integration",
    "accounts",
    treeSlug,
    "leaves",
    `${leafId}.md`,
  );
}

function integrationSummaryRelativePath(
  treeSlug: string,
  level: number,
  nodeId: string,
): string {
  return path.posix.join(
    "integration",
    "accounts",
    treeSlug,
    "summaries",
    `L${level}`,
    `${nodeId}.md`,
  );
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

function stableIntegrationAccountKey(connection: IntegrationConnectionRecord): string {
  const normalized = (value: string | null | undefined): string | null => {
    const token = typeof value === "string" ? value.trim() : "";
    return token || null;
  };
  return normalized(connection.accountHandle)
    ?? normalized(connection.accountEmail)
    ?? normalized(connection.accountExternalId)
    ?? connection.connectionId;
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
  tree: IntegrationTreeRecord;
  childCount: number;
  childTitles: string[];
}): string {
  return clipText(
    `${params.tree.accountLabel} ${params.tree.provider} memory slice covering ${params.childCount} nodes: ${params.childTitles.slice(0, 4).join(", ")}`,
    240,
  );
}

async function generateSummaryText(params: {
  tree: IntegrationTreeRecord;
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
  const fallback = deterministicSummaryText({
    tree: params.tree,
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

async function buildTempSummaryNode(params: {
  tree: IntegrationTreeRecord;
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
}): Promise<TempSummaryNode> {
  const summary = await generateSummaryText({
    tree: params.tree,
    children: params.children,
    depthFromLeaves: params.depthFromLeaves,
    ordinal: params.ordinal,
    modelClient: params.modelClient,
  });
  const title = params.depthFromLeaves === 1 && params.children.length > 1
    ? `${params.tree.accountLabel} root summary`
    : `${params.tree.accountLabel} branch ${params.ordinal}`;
  const body = summaryNodeBody({
    tree: params.tree,
    title,
    summary,
    children: params.children.map((child) => ({
      title: child.title,
      summary: child.summary,
    })),
  });
  return {
    tempId: sha256(JSON.stringify({
      treeId: params.tree.treeId,
      depthFromLeaves: params.depthFromLeaves,
      ordinal: params.ordinal,
      children: params.children.map((child) => `${child.kind}:${child.id}`),
    })).slice(0, 24),
    title,
    summary,
    body,
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

  const leafChildren: TempSummaryChild[] = params.leaves.map((leaf) => ({
    kind: "leaf" as const,
    id: leaf.leafId,
    title: leaf.title,
    summary: leaf.summary,
    excerpt: null,
  }));

  const layers: TempSummaryNode[][] = [];
  let current: TempSummaryChild[] = leafChildren;
  let depthFromLeaves = 1;
  while (current.length > 1 || layers.length === 0) {
    const layer = await Promise.all(
      chunkArray(current, INTEGRATION_BRANCH_FACTOR).map((group, index) =>
        buildTempSummaryNode({
          tree: params.tree,
          children: group,
          depthFromLeaves,
          ordinal: index + 1,
          modelClient: params.modelClient,
        }),
      ),
    );
    layers.push(layer);
    current = layer.map((node) => ({
      kind: "summary" as const,
      id: node.tempId,
      title: node.title,
      summary: node.summary,
      excerpt: markdownExcerpt(node.body),
    }));
    depthFromLeaves += 1;
    if (current.length === 1) {
      break;
    }
  }

  const totalLayers = layers.length;
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

  for (let layerIndex = layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const layer = layers[layerIndex];
    const level = totalLayers - layerIndex;
    for (let index = 0; index < layer.length; index += 1) {
      const node = layer[index];
      const childIdentity = node.children.map((child) => `${child.kind}:${child.id}`).join("|");
      const nodeId = `summary-${sha256(`${params.tree.treeId}|L${level}|${childIdentity}`).slice(0, 24)}`;
      nodeIdByTempId.set(node.tempId, { nodeId, level });
        nodes.push({
          nodeId,
          level,
          ordinal: index + 1,
          path: integrationSummaryRelativePath(params.tree.slug, level, nodeId),
          title: node.title,
          summary: node.summary,
          body: node.body,
        bodySha256: sha256(node.body),
        childCount: node.children.length,
        sealedAt,
      });
    }
  }

  const edges: Array<{
    parentNodeId: string;
    childKind: InteractionTreeChildKind;
    childId: string;
    position: number;
  }> = [];
  for (let layerIndex = layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const layer = layers[layerIndex];
    for (const tempNode of layer) {
      const parent = nodeIdByTempId.get(tempNode.tempId);
      if (!parent) {
        continue;
      }
      tempNode.children.forEach((child, childIndex) => {
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
  const existingDuplicate = params.store.getIntegrationLeafByFingerprint({
    treeId: tree.treeId,
    fingerprint: contentFingerprint,
  });
  if (existingDuplicate) {
    return {
      outcome: "noop_duplicate",
      tree,
      leaf: existingDuplicate,
    };
  }

  const leafId = `leaf-${sha256(`${tree.treeId}|${params.candidate.subjectKey}|${contentFingerprint}`).slice(0, 24)}`;
  const relativePath = integrationLeafRelativePath(tree.slug, leafId);
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
  workspaceId: string;
  treeId: string;
  summaryModelClient?: MemoryModelClientConfig | null;
  embeddingClient?: MemoryModelClientConfig | null;
}): Promise<void> {
  const tree = params.store.getIntegrationTree({ treeId: params.treeId });
  if (!tree) {
    return;
  }
  const treeDir = integrationTreeDir(params.store.workspaceRoot, tree.slug);
  const summariesDir = path.join(treeDir, "summaries");
  fs.rmSync(summariesDir, { recursive: true, force: true });
  fs.mkdirSync(summariesDir, { recursive: true });

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

  const plan = await buildSummaryTreePlan({
    workspaceId: params.workspaceId,
    tree,
    leaves: activeLeaves,
    modelClient: params.summaryModelClient ?? null,
  });
  for (const node of plan.nodes) {
    writeFileIfChanged(absolutePathForRelative(params.store.workspaceRoot, node.path), node.body);
  }
  params.store.replaceIntegrationSummaryTree({
    treeId: params.treeId,
    nodes: plan.nodes.map((node) => ({
      nodeId: node.nodeId,
      level: node.level,
      ordinal: node.ordinal,
      path: node.path,
      title: node.title,
      summary: node.summary,
      bodySha256: node.bodySha256,
      childCount: node.childCount,
      sealedAt: node.sealedAt,
    })),
    edges: plan.edges,
  });
  for (const node of plan.nodes) {
    await syncNodeEmbedding({
      store: params.store,
      tree,
      nodeKind: "summary",
      nodeId: node.nodeId,
      title: node.title,
      summary: node.summary,
      body: node.body,
      embeddingClient: params.embeddingClient ?? null,
    });
  }
}

export async function rebuildAllIntegrationTrees(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
}): Promise<{ trees: number; summaries: number }> {
  const summaryModelClient = createBackgroundTaskMemoryModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId ?? `integration-memory-sync:${params.workspaceId}`,
    inputId: params.inputId ?? `integration-memory-sync:${params.workspaceId}`,
    selectedModel: params.selectedModel ?? null,
  });
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
      workspaceId: params.workspaceId,
      treeId: tree.treeId,
      summaryModelClient,
      embeddingClient,
    });
    summaryCount += params.store.listIntegrationSummaryNodes({
      treeId: tree.treeId,
      status: "active",
      limit: 10_000,
      offset: 0,
    }).length;
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

function accessibleIntegrationTreesForWorkspace(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
}): IntegrationTreeRecord[] {
  const targetTreeId = (params.treeId ?? "").trim();
  const byTreeId = new Map<string, IntegrationTreeRecord>();
  for (const binding of params.store.listIntegrationBindings({ workspaceId: params.workspaceId })) {
    const connection = params.store.getIntegrationConnection(binding.connectionId);
    if (!connection || connection.status.trim().toLowerCase() !== "active") {
      continue;
    }
    const tree = params.store.getIntegrationTreeByAccountIdentity({
      provider: connection.providerId,
      ownerUserId: connection.ownerUserId,
      accountKey: stableIntegrationAccountKey(connection),
    });
    if (!tree || tree.status !== "active") {
      continue;
    }
    if (targetTreeId && tree.treeId !== targetTreeId) {
      continue;
    }
    byTreeId.set(tree.treeId, tree);
  }
  return [...byTreeId.values()];
}

function buildLeafCandidate(params: {
  store: RuntimeStateStore;
  tree: IntegrationTreeRecord;
  leaf: IntegrationLeafRecord;
}): NodeCandidate {
  const filePath = absolutePathForRelative(
    params.store.workspaceRoot,
    params.leaf.path,
  );
  const body = readFileIfExists(filePath);
  return {
    kind: "leaf",
    id: params.leaf.leafId,
    tree: params.tree,
    title: params.leaf.title,
    summary: params.leaf.summary,
    excerpt: body ? markdownExcerpt(body, 320) : null,
    path: params.leaf.path,
    level: null,
    childCount: null,
    observedAt: params.leaf.observedAt,
    updatedAt: params.leaf.updatedAt,
  };
}

function buildSummaryCandidate(params: {
  store: RuntimeStateStore;
  tree: IntegrationTreeRecord;
  node: IntegrationSummaryNodeRecord;
}): NodeCandidate {
  const filePath = absolutePathForRelative(
    params.store.workspaceRoot,
    params.node.path,
  );
  const body = readFileIfExists(filePath);
  return {
    kind: "summary",
    id: params.node.nodeId,
    tree: params.tree,
    title: params.node.title,
    summary: params.node.summary,
    excerpt: body ? markdownExcerpt(body, 320) : null,
    path: params.node.path,
    level: params.node.level,
    childCount: params.node.childCount,
    observedAt: params.node.sealedAt,
    updatedAt: params.node.updatedAt,
  };
}

function nodeScore(params: {
  query: string;
  candidate: NodeCandidate;
  embeddingModelId: string | null;
  queryVector: number[] | null;
  embeddingByKey: Map<string, number[]>;
  mode: "mixed" | "summaries" | "leaves";
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
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
  parentNodeId: string;
  query: string;
  mode: "mixed" | "summaries" | "leaves";
  embeddingModelId: string | null;
  queryVector: number[] | null;
  embeddingByKey: Map<string, number[]>;
}): Promise<IntegrationMemoryRetrieveHit[]> {
  const parent = params.store.getIntegrationSummaryNode({ nodeId: params.parentNodeId });
  if (!parent) {
    return [];
  }
  const tree = params.store.getIntegrationTree({ treeId: parent.treeId });
  if (!tree) {
    return [];
  }
  const children = params.store.listIntegrationTreeChildren({ parentNodeId: params.parentNodeId });
  const candidates: NodeCandidate[] = [];
  for (const child of children) {
    if (child.childKind === "summary") {
      const node = params.store.getIntegrationSummaryNode({ nodeId: child.childId });
      if (node && node.status === "active") {
        candidates.push(buildSummaryCandidate({
          store: params.store,
          tree,
          node,
        }));
      }
      continue;
    }
    const leaf = params.store.getIntegrationLeaf({ leafId: child.childId });
    if (leaf && leaf.status === "active") {
      candidates.push(buildLeafCandidate({
        store: params.store,
        tree,
        leaf,
      }));
    }
  }
  return candidates
    .map((candidate) => {
      const scored = nodeScore({
        query: params.query,
        candidate,
        embeddingModelId: params.embeddingModelId,
        queryVector: params.queryVector,
        embeddingByKey: params.embeddingByKey,
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

export async function retrieveIntegrationMemory(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  mode?: "mixed" | "summaries" | "leaves";
  treeId?: string | null;
  nodeId?: string | null;
  maxResults?: number;
  selectedModel?: string | null;
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

  const embeddingQuery = await queryEmbeddingVector({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId ?? null,
    inputId: params.inputId ?? null,
    selectedModel: params.selectedModel ?? null,
    query: params.query,
  });
  const embeddingByKey = new Map<string, number[]>();
  if (embeddingQuery) {
    for (const record of params.store.listIntegrationNodeEmbeddings({
      embeddingModel: embeddingQuery.modelId,
    })) {
      embeddingByKey.set(`${record.nodeKind}:${record.nodeId}:${record.embeddingModel}`, record.vector);
    }
  }

  if (params.nodeId) {
    return {
      query: params.query,
      mode,
      tree_id: params.treeId ?? null,
      node_id: params.nodeId,
      hits: [],
      children: await childHitsForNode({
        store: params.store,
        parentNodeId: params.nodeId,
        query: params.query,
        mode,
        embeddingModelId: embeddingQuery?.modelId ?? null,
        queryVector: embeddingQuery?.vector ?? null,
        embeddingByKey,
      }),
    };
  }

  const candidates: NodeCandidate[] = [];
  for (const tree of trees) {
    const activeSummaries = mode === "leaves"
      ? []
      : params.store.listIntegrationSummaryNodes({
          treeId: tree.treeId,
          status: "active",
          limit: 10_000,
          offset: 0,
        });
    const activeLeaves = mode === "summaries"
      ? []
      : params.store.listIntegrationLeaves({
          treeId: tree.treeId,
          status: "active",
          limit: 10_000,
          offset: 0,
        });
    for (const node of activeSummaries) {
      candidates.push(buildSummaryCandidate({
        store: params.store,
        tree,
        node,
      }));
    }
    for (const leaf of activeLeaves) {
      candidates.push(buildLeafCandidate({
        store: params.store,
        tree,
        leaf,
      }));
    }
  }

  const hits = candidates
    .map((candidate) => {
      const scored = nodeScore({
        query: params.query,
        candidate,
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
      memory_type: hit.node_kind === "summary" ? "summary" : "leaf",
      title: hit.title,
      summary: hit.summary,
      path: hit.path,
      verification_policy: "none",
      staleness_policy: "workspace_sensitive",
      freshness_state: "fresh",
      freshness_note: hit.node_kind === "summary"
        ? `Tree summary from ${hit.provider} account ${hit.account_label}.`
        : `Leaf memory from ${hit.provider} account ${hit.account_label}.`,
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
