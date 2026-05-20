import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type InteractionEntityRecord,
  type InteractionEntityType,
  type InteractionLeafRecord,
  type InteractionSummaryNodeRecord,
  type InteractionTreeChildKind,
  type RuntimeStateStore,
  utcNowIso,
} from "@holaboss/runtime-state-store";

import type { AgentRecalledMemoryContext } from "./agent-runtime-prompt.js";
import { queryMemoryModelEmbedding, queryMemoryModelJson, type MemoryModelClientConfig } from "./memory-model-client.js";
import { createRecallEmbeddingModelClient } from "./recall-embedding-model.js";
import { workspaceMemoryDir } from "./workspace-bundle-paths.js";

const INTERACTION_BRANCH_FACTOR = 8;
const MAX_ENTITY_SHORTLIST = 24;
const MAX_RETRIEVE_RESULTS = 12;
const EMBEDDING_EXCERPT_CHARS = 480;
const INTERACTION_UNCATEGORIZED_ENTITY_ID = "interaction:uncategorized";
const INTERACTION_UNCATEGORIZED_SLUG = "uncategorized";
const INTERACTION_UNCATEGORIZED_NAME = "Uncategorized";
const ENTITY_CREATE_CONFIDENCE_THRESHOLD = 0.68;
const ENTITY_MATCH_CONFIDENCE_THRESHOLD = 0.6;

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
    case "procedure":
      return "workflow";
    case "blocker":
      return "system";
    default:
      return null;
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
  if (typeHint === "workflow") {
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

function buildTempSummaryNode(params: {
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
}): TempSummaryNode {
  const childTitles = params.children.map((child) => child.title);
  const summary = clipText(
    `${params.entity.canonicalName} memory slice covering ${params.children.length} nodes: ${childTitles.slice(0, 4).join(", ")}`,
    240,
  );
  const title = params.depthFromLeaves === 1 && params.children.length > 1
    ? `${params.entity.canonicalName} root summary`
    : `${params.entity.canonicalName} branch ${params.ordinal}`;
  const body = summaryNodeBody({
    entity: params.entity,
    title,
    summary,
    children: params.children.map((child) => ({
      title: child.title,
      summary: child.summary,
    })),
  });
  return {
    tempId: sha256(JSON.stringify({
      entityId: params.entity.entityId,
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

function buildSummaryTreePlan(params: {
  workspaceId: string;
  entity: InteractionEntityRecord;
  leaves: InteractionLeafRecord[];
}): {
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
} {
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
    const layer = chunkArray(current, INTERACTION_BRANCH_FACTOR).map((group, index) =>
      buildTempSummaryNode({
        entity: params.entity,
        children: group,
        depthFromLeaves,
        ordinal: index + 1,
      }));
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
      const childIdentity = node.children
        .map((child) => `${child.kind}:${child.id}`)
        .join("|");
      const nodeId = `summary-${sha256(`${params.entity.entityId}|L${level}|${childIdentity}`).slice(0, 24)}`;
      nodeIdByTempId.set(node.tempId, { nodeId, level });
      nodes.push({
        nodeId,
        level,
        ordinal: index + 1,
        path: interactionSummaryRelativePath(
          params.workspaceId,
          params.entity.slug,
          level,
          nodeId,
        ),
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
        const childId =
          child.kind === "summary"
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

  const leafId = `leaf-${sha256(`${params.workspaceId}|${entity.entityId}|${params.candidate.subjectKey}|${contentFingerprint}`).slice(0, 24)}`;
  const relativePath = interactionLeafRelativePath(params.workspaceId, entity.slug, leafId);
  const existingActive = params.store.getLatestActiveInteractionLeafBySubject({
    workspaceId: params.workspaceId,
    entityId: entity.entityId,
    subjectKey: params.candidate.subjectKey,
  });
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const absolutePath = absolutePathForRelative(workspaceDir, relativePath);
  writeFileIfChanged(absolutePath, params.candidate.content);

  let outcome: PersistedInteractionLeafResult["outcome"] = "created";
  if (existingActive && existingActive.fingerprint !== contentFingerprint) {
    params.store.updateInteractionLeafStatus({
      workspaceId: params.workspaceId,
      leafId: existingActive.leafId,
      status: "superseded",
      supersededAt: params.candidate.observedAt ?? utcNowIso(),
    });
    outcome = "superseding";
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
    supersedesLeafId: existingActive && existingActive.fingerprint !== contentFingerprint ? existingActive.leafId : null,
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
  const summariesDir = path.join(entityDir, "summaries");
  fs.rmSync(summariesDir, { recursive: true, force: true });
  fs.mkdirSync(summariesDir, { recursive: true });

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

  const plan = buildSummaryTreePlan({
    workspaceId: params.workspaceId,
    entity,
    leaves: activeLeaves,
  });
  for (const node of plan.nodes) {
    writeFileIfChanged(absolutePathForRelative(workspaceDir, node.path), node.body);
  }
  params.store.replaceInteractionSummaryTree({
    workspaceId: params.workspaceId,
    entityId: params.entityId,
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
      workspaceId: params.workspaceId,
      entity,
      nodeKind: "summary",
      nodeId: node.nodeId,
      title: node.title,
      summary: node.summary,
      body: node.body,
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
      embeddingClient,
    });
    summaryCount += params.store.listInteractionSummaryNodes({
      workspaceId: params.workspaceId,
      entityId: entity.entityId,
      status: "active",
      limit: 10_000,
      offset: 0,
    }).length;
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

function buildLeafCandidate(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entity: InteractionEntityRecord;
  leaf: InteractionLeafRecord;
}): NodeCandidate {
  const filePath = absolutePathForRelative(
    params.store.workspaceDir(params.workspaceId),
    params.leaf.path,
  );
  const body = readFileIfExists(filePath);
  return {
    kind: "leaf",
    id: params.leaf.leafId,
    entity: params.entity,
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
  workspaceId: string;
  entity: InteractionEntityRecord;
  node: InteractionSummaryNodeRecord;
}): NodeCandidate {
  const filePath = absolutePathForRelative(
    params.store.workspaceDir(params.workspaceId),
    params.node.path,
  );
  const body = readFileIfExists(filePath);
  return {
    kind: "summary",
    id: params.node.nodeId,
    entity: params.entity,
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
    params.candidate.entity.canonicalName,
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
  embeddingByKey: Map<string, number[]>;
}): Promise<InteractionMemoryRetrieveHit[]> {
  const parent = params.store.getInteractionSummaryNode({
    workspaceId: params.workspaceId,
    nodeId: params.parentNodeId,
  });
  if (!parent) {
    return [];
  }
  const entity = params.store.getInteractionEntity({
    workspaceId: params.workspaceId,
    entityId: parent.entityId,
  });
  if (!entity) {
    return [];
  }
  const children = params.store.listInteractionTreeChildren({
    workspaceId: params.workspaceId,
    parentNodeId: params.parentNodeId,
  });
  const candidates: NodeCandidate[] = [];
  for (const child of children) {
    if (child.childKind === "summary") {
      const node = params.store.getInteractionSummaryNode({
        workspaceId: params.workspaceId,
        nodeId: child.childId,
      });
      if (node && node.status === "active") {
        candidates.push(buildSummaryCandidate({
          store: params.store,
          workspaceId: params.workspaceId,
          entity,
          node,
        }));
      }
      continue;
    }
    const leaf = params.store.getInteractionLeaf({
      workspaceId: params.workspaceId,
      leafId: child.childId,
    });
    if (leaf && leaf.status === "active") {
      candidates.push(buildLeafCandidate({
        store: params.store,
        workspaceId: params.workspaceId,
        entity,
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

export async function retrieveInteractionMemory(params: {
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

  const embeddingQuery = await queryEmbeddingVector({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId ?? null,
    inputId: params.inputId ?? null,
    selectedModel: params.selectedModel ?? null,
    query: params.query,
  });
  const embeddingByKey = new Map<string, number[]>();
  if (embeddingQuery) {
    for (const record of params.store.listInteractionNodeEmbeddings({
      workspaceId: params.workspaceId,
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
        workspaceId: params.workspaceId,
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
  for (const entity of entities) {
    const activeSummaries = mode === "leaves"
      ? []
      : params.store.listInteractionSummaryNodes({
          workspaceId: params.workspaceId,
          entityId: entity.entityId,
          status: "active",
          limit: 10_000,
          offset: 0,
        });
    const activeLeaves = mode === "summaries"
      ? []
      : params.store.listInteractionLeaves({
          workspaceId: params.workspaceId,
          entityId: entity.entityId,
          status: "active",
          limit: 10_000,
          offset: 0,
        });
    for (const node of activeSummaries) {
      candidates.push(buildSummaryCandidate({
        store: params.store,
        workspaceId: params.workspaceId,
        entity,
        node,
      }));
    }
    for (const leaf of activeLeaves) {
      candidates.push(buildLeafCandidate({
        store: params.store,
        workspaceId: params.workspaceId,
        entity,
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
