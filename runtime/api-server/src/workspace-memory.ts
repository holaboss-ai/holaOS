import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

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
} from "./memory-hybrid-retrieval.js";
import {
  retrieveIntegrationMemory,
  type IntegrationMemoryRetrieveHit,
} from "./integration-memory.js";
import {
  retrieveInteractionMemory,
  type InteractionMemoryRetrieveHit,
} from "./interaction-memory.js";
import {
  visibleIntegrationConnectionsForWorkspace,
  visibleIntegrationTreesForWorkspace,
} from "./workspace-integration-visibility.js";

export type WorkspaceMemoryCategory = MemoryRetrievalCategory;
export type WorkspaceMemoryRetrieveResult = MemoryHybridRetrieveResult;

export interface WorkspaceMemoryExecutionProfile {
  useEmbeddings?: boolean | null;
  useLlmRerank?: boolean | null;
}

const VECTOR_FIRST_PASS_LIMIT_FLOOR = 8;
const VECTOR_FIRST_PASS_LIMIT_CEILING = 60;
const LEXICAL_SUPPORT_LIMIT_FLOOR = 4;
const LEXICAL_SUPPORT_LIMIT_CEILING = 12;
const SUPPORT_SCOPE_LIMIT = 3;

function normalizeRequestedCategories(value: unknown): WorkspaceMemoryCategory[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const out: WorkspaceMemoryCategory[] = [];
  for (const item of rawItems) {
    const normalized = typeof item === "string" ? item.trim().toLowerCase() : "";
    if ((normalized === "interaction" || normalized === "integration") && !out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

function allowedTreeIdSet(treeIds?: string[] | null): Set<string> {
  return new Set(
    (treeIds ?? [])
      .map((item) => compactWhitespace(item))
      .filter(Boolean),
  );
}

export async function buildWorkspaceVectorFirstPassHits(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  categories: WorkspaceMemoryCategory[];
  treeIds?: string[] | null;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  maxCandidates: number;
}): Promise<{
  modelId: string | null;
  interactionHits: InteractionMemoryRetrieveHit[];
  integrationHits: IntegrationMemoryRetrieveHit[];
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
    };
  }

  const categories = new Set(params.categories);
  const allowedTreeIds = allowedTreeIdSet(params.treeIds ?? null);
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
  const integrationTrees = categories.has("integration")
    ? new Map(
        visibleIntegrationTreesForWorkspace({
          store: params.store,
          workspaceId: params.workspaceId,
        }).map((tree) => [tree.treeId, tree]),
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
          category: "interaction",
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
  if (categories.has("integration")) {
    const scored = params.store
      .listIntegrationNodeEmbeddings({
        embeddingModel: embeddingQuery.modelId,
      })
      .map((record) => {
        if (allowedTreeIds.size > 0 && !allowedTreeIds.has(record.treeId)) {
          return null;
        }
        const tree = integrationTrees.get(record.treeId);
        if (!tree) {
          return null;
        }
        const node = params.store.getSemanticMemoryNode({
          category: "integration",
          treeId: record.treeId,
          nodeId: record.nodeId,
        });
        if (!node || node.status !== "active") {
          return null;
        }
        const kind = integrationVectorNodeKind(node);
        if (kind === "tree") {
          return null;
        }
        const similarity = cosineSimilarity(record.vector, embeddingQuery.vector);
        if (similarity <= 0) {
          return null;
        }
        return {
          similarity,
          hit: {
            category: "integration",
            node_kind: kind,
            node_id: node.nodeId,
            tree_id: tree.treeId,
            provider: tree.provider,
            owner_user_id: tree.ownerUserId,
            account_key: tree.accountKey,
            account_label: tree.accountLabel,
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
    integrationHits.push(...scored.map((entry) => entry.hit));
  }

  return {
    modelId: embeddingQuery.modelId,
    interactionHits,
    integrationHits,
  };
}

function distinctTreeIds<T extends { tree_id: string }>(hits: T[], allowedTreeIds: string[] | null | undefined, prefix: "interaction:" | "integration:"): Array<string | null> {
  const preferred = hits.map((hit) => hit.tree_id);
  const fallback = (allowedTreeIds ?? []).filter((treeId) => treeId.startsWith(prefix));
  const seen = new Set<string>();
  const ordered = [...preferred, ...fallback].filter((treeId) => {
    if (!treeId || seen.has(treeId)) {
      return false;
    }
    seen.add(treeId);
    return true;
  });
  if (ordered.length === 0) {
    return [null];
  }
  return ordered.slice(0, SUPPORT_SCOPE_LIMIT);
}

export function planWorkspaceMemoryCategories(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  requestedCategories?: unknown;
  treeId?: string | null;
}): WorkspaceMemoryCategory[] {
  const explicit = normalizeRequestedCategories(params.requestedCategories);
  if (explicit.length > 0) {
    return explicit;
  }
  const treeId = (params.treeId ?? "").trim().toLowerCase();
  if (treeId.startsWith("interaction:")) {
    return ["interaction"];
  }
  if (treeId.startsWith("integration:")) {
    return ["integration"];
  }
  const hasInteraction = params.store.listInteractionEntities({
    workspaceId: params.workspaceId,
    status: "active",
    includeSystem: true,
    limit: 1,
    offset: 0,
  }).length > 0;
  const hasIntegration = visibleIntegrationConnectionsForWorkspace({
    store: params.store,
    workspaceId: params.workspaceId,
  }).length > 0;
  if (hasInteraction && hasIntegration) {
    return ["interaction", "integration"];
  }
  if (hasIntegration) {
    return ["integration"];
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
      };
  const lexicalSupportLimit = Math.max(
    LEXICAL_SUPPORT_LIMIT_FLOOR,
    Math.min(params.retrievalPolicy?.max_evidence ?? 8, LEXICAL_SUPPORT_LIMIT_CEILING),
  );
  const interactionSupportScopes = categories.includes("interaction")
    ? distinctTreeIds(vectorFirstPass.interactionHits, params.treeIds ?? null, "interaction:")
    : [];
  const integrationSupportScopes = categories.includes("integration")
    ? distinctTreeIds(vectorFirstPass.integrationHits, params.treeIds ?? null, "integration:")
    : [];
  const interactionSupportResults = categories.includes("interaction")
    ? await Promise.all(interactionSupportScopes.map(async (treeId) =>
      retrieveInteractionMemory({
        store: params.store,
        workspaceId: params.workspaceId,
        query: params.query,
        mode: "mixed",
        treeId,
        nodeId: null,
        maxResults: lexicalSupportLimit,
        selectedModel: null,
        useEmbeddings: false,
        sessionId: params.sessionId ?? null,
        inputId: params.inputId ?? null,
      }),
    ))
    : [];
  const integrationSupportResults = categories.includes("integration")
    ? await Promise.all(integrationSupportScopes.map(async (treeId) =>
      retrieveIntegrationMemory({
        store: params.store,
        workspaceId: params.workspaceId,
        query: params.query,
        mode: "mixed",
        treeId,
        nodeId: null,
        maxResults: lexicalSupportLimit,
        selectedModel: null,
        useEmbeddings: false,
        sessionId: params.sessionId ?? null,
        inputId: params.inputId ?? null,
      }),
    ))
    : [];

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
    categories,
    interactionHits: [
      ...vectorFirstPass.interactionHits,
      ...interactionSupportResults.flatMap((result) => result.hits),
    ],
    integrationHits: [
      ...vectorFirstPass.integrationHits,
      ...integrationSupportResults.flatMap((result) => result.hits),
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
