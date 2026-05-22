import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
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
import { visibleIntegrationTreesForWorkspace } from "./workspace-integration-visibility.js";
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

function integrationEntitySlug(key: string | null | undefined, label: string | null | undefined): string | null {
  const source = compactWhitespace(key ?? "") || compactWhitespace(label ?? "");
  return source ? safePathSegment(source, "entity") : null;
}

function integrationBranchSlug(key: string | null | undefined, label: string | null | undefined): string | null {
  const source = compactWhitespace(key ?? "") || compactWhitespace(label ?? "");
  return source ? safePathSegment(source, "branch") : null;
}

function integrationLeafRelativePath(params: {
  treeSlug: string;
  leafId: string;
  entityKey?: string | null;
  entityLabel?: string | null;
  branchKey?: string | null;
  branchLabel?: string | null;
}): string {
  const entitySlug = integrationEntitySlug(params.entityKey, params.entityLabel);
  const branchSlug = integrationBranchSlug(params.branchKey, params.branchLabel);
  const segments = [
    "integration",
    "accounts",
    params.treeSlug,
    entitySlug ? "entities" : "account",
    ...(entitySlug ? [entitySlug] : []),
    ...(branchSlug ? [branchSlug] : []),
    "leaves",
    `${params.leafId}.md`,
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
  const segments = [
    "integration",
    "accounts",
    params.treeSlug,
    "summaries",
  ];
  if (params.root) {
    segments.push("root");
  } else if (params.entitySlug) {
    segments.push("entities", params.entitySlug);
    if (params.branchSlug) {
      segments.push(params.branchSlug);
    }
  } else {
    segments.push("account");
    if (params.branchSlug) {
      segments.push(params.branchSlug);
    }
  }
  segments.push(`L${params.level}`, `${params.nodeId}.md`);
  return path.posix.join(...segments);
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
  return visibleIntegrationTreesForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
    treeId: params.treeId ?? null,
  });
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
