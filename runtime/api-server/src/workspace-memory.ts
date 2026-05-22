import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import type { AgentRecalledMemoryContext } from "./agent-runtime-prompt.js";
import {
  buildRecalledIntegrationMemoryContext,
  retrieveIntegrationMemory,
  type IntegrationMemoryRetrieveHit,
} from "./integration-memory.js";
import {
  buildRecalledInteractionMemoryContext,
  retrieveInteractionMemory,
  type InteractionMemoryRetrieveHit,
} from "./interaction-memory.js";
import { visibleIntegrationConnectionsForWorkspace } from "./workspace-integration-visibility.js";

export type WorkspaceMemoryCategory = "interaction" | "integration";

export type WorkspaceMemoryRetrieveHit =
  | (InteractionMemoryRetrieveHit & { category: "interaction" })
  | IntegrationMemoryRetrieveHit;

export interface WorkspaceMemoryRetrieveResult {
  query: string;
  mode: "mixed" | "summaries" | "leaves";
  categories: WorkspaceMemoryCategory[];
  tree_id: string | null;
  node_id: string | null;
  hits: WorkspaceMemoryRetrieveHit[];
  children?: WorkspaceMemoryRetrieveHit[];
}

function tokenize(value: string): string[] {
  const matches = value.match(/[a-z0-9]{2,}/gi);
  return matches ? matches.map((item) => item.toLowerCase()) : [];
}

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

function normalizeInteractionHit(hit: InteractionMemoryRetrieveHit): InteractionMemoryRetrieveHit & { category: "interaction" } {
  return {
    category: "interaction",
    ...hit,
  };
}

function sortHits<T extends { score: number; path: string }>(hits: T[]): T[] {
  return [...hits].sort((left, right) => {
    const scoreDiff = right.score - left.score;
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return left.path.localeCompare(right.path);
  });
}

export async function retrieveWorkspaceMemory(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  categories?: WorkspaceMemoryCategory[] | null;
  mode?: "mixed" | "summaries" | "leaves";
  treeId?: string | null;
  nodeId?: string | null;
  maxResults?: number;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
}): Promise<WorkspaceMemoryRetrieveResult> {
  const categories = planWorkspaceMemoryCategories({
    store: params.store,
    workspaceId: params.workspaceId,
    requestedCategories: params.categories ?? undefined,
    treeId: params.treeId ?? null,
  });
  const mode = params.mode ?? "mixed";
  const maxResults = Math.max(1, Math.min(params.maxResults ?? 8, 50));
  const hitBuckets = await Promise.all(categories.map(async (category) => {
    if (category === "interaction") {
      const result = await retrieveInteractionMemory({
        store: params.store,
        workspaceId: params.workspaceId,
        query: params.query,
        mode,
        treeId: params.treeId ?? null,
        nodeId: params.nodeId ?? null,
        maxResults,
        selectedModel: params.selectedModel ?? null,
        sessionId: params.sessionId ?? null,
        inputId: params.inputId ?? null,
      });
      return {
        category,
        result,
        hits: result.hits.map((hit) => normalizeInteractionHit(hit)) as WorkspaceMemoryRetrieveHit[],
        children: (result.children ?? []).map((hit) => normalizeInteractionHit(hit)) as WorkspaceMemoryRetrieveHit[],
      };
    }
    const result = await retrieveIntegrationMemory({
      store: params.store,
      workspaceId: params.workspaceId,
      query: params.query,
      mode,
      treeId: params.treeId ?? null,
      nodeId: params.nodeId ?? null,
      maxResults,
      selectedModel: params.selectedModel ?? null,
      sessionId: params.sessionId ?? null,
      inputId: params.inputId ?? null,
    });
    return {
      category,
      result,
      hits: result.hits as WorkspaceMemoryRetrieveHit[],
      children: (result.children ?? []) as WorkspaceMemoryRetrieveHit[],
    };
  }));

  if (params.nodeId) {
    const children = sortHits(hitBuckets.flatMap((bucket) => bucket.children)).slice(0, maxResults);
    return {
      query: params.query,
      mode,
      categories,
      tree_id: params.treeId ?? null,
      node_id: params.nodeId,
      hits: [],
      children,
    };
  }

  const hits = sortHits(hitBuckets.flatMap((bucket) => bucket.hits)).slice(0, maxResults);
  return {
    query: params.query,
    mode,
    categories,
    tree_id: params.treeId ?? null,
    node_id: null,
    hits,
  };
}

export async function buildRecalledWorkspaceMemoryContext(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  maxResults?: number;
}): Promise<AgentRecalledMemoryContext | null> {
  const result = await retrieveWorkspaceMemory({
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
      scope: hit.category,
      memory_type: hit.node_kind === "leaf" ? "leaf" : "summary",
      title: hit.title,
      summary: hit.summary,
      path: hit.path,
      verification_policy: "none",
      staleness_policy: "workspace_sensitive",
      freshness_state: "fresh",
      freshness_note: hit.category === "interaction"
        ? (hit.node_kind === "summary"
          ? `Tree summary from ${hit.entity_name}.`
          : `Leaf memory from ${hit.entity_name}.`)
        : (hit.node_kind === "leaf"
          ? `Leaf memory from ${hit.provider} account ${hit.account_label}.`
          : `Structured memory node from ${hit.provider} account ${hit.account_label}.`),
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

export async function buildRecalledWorkspaceMemoryContextByCategory(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  query: string;
  categories: WorkspaceMemoryCategory[];
  selectedModel?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  maxResults?: number;
}): Promise<AgentRecalledMemoryContext | null> {
  if (params.categories.length === 1 && params.categories[0] === "interaction") {
    return await buildRecalledInteractionMemoryContext({
      store: params.store,
      workspaceId: params.workspaceId,
      query: params.query,
      selectedModel: params.selectedModel ?? null,
      sessionId: params.sessionId ?? null,
      inputId: params.inputId ?? null,
      maxResults: params.maxResults ?? 5,
    });
  }
  if (params.categories.length === 1 && params.categories[0] === "integration") {
    return await buildRecalledIntegrationMemoryContext({
      store: params.store,
      workspaceId: params.workspaceId,
      query: params.query,
      selectedModel: params.selectedModel ?? null,
      sessionId: params.sessionId ?? null,
      inputId: params.inputId ?? null,
      maxResults: params.maxResults ?? 5,
    });
  }
  return await buildRecalledWorkspaceMemoryContext(params);
}
