import { createHash } from "node:crypto";

import type {
  MemoryEntryScope,
  MemoryEntrySourceType,
  MemoryEntryType,
  MemoryStalenessPolicy,
  MemoryVerificationPolicy,
  RuntimeStateStore,
  TurnResultRecord,
} from "@holaboss/runtime-state-store";

import type { MemoryServiceLike } from "./memory.js";
import {
  ensureWorkspaceInteractionSemanticTreesMigrated,
} from "./interaction-memory.js";
import { governanceRuleForMemoryType } from "./memory-governance.js";
import {
  persistWorkspaceMemoryCandidate,
  queueWorkspaceMemoryTreeRebuild,
  waitForPendingWorkspaceMemoryTreeRebuilds,
} from "./workspace-memory-writer.js";
import {
  createBackgroundTaskMemoryModelClient,
} from "./background-task-model.js";
import type { DurableMemoryArtifactContext } from "./memory-artifact-context.js";
import {
  appendDurableMemoryRelatedSections,
  extractDurableMemoryRelatedInfo,
  mergeArtifactDerivedRelations,
  type DurableMemoryRelatedInfo,
} from "./memory-related-entities.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { createRecallEmbeddingModelClient } from "./recall-embedding-model.js";
import {
  artifactContextsForSourceTurnInput,
  persistTurnInputAttachmentsAsDocuments,
  persistTurnReferencedImageUrlsAsDocuments,
  persistTurnOutputArtifactsAsDocuments,
} from "./workspace-attachment-memory.js";
import { createWorkspaceRelatedEntityResolverFromStore } from "./workspace-related-entity-resolver-store.js";
import { rebuildWorkspaceMemoryGraph } from "./workspace-memory-graph.js";

export { waitForPendingWorkspaceMemoryTreeRebuilds };

/**
 * The candidate shape supplied by the agent-invoked `remember` tool (and
 * formerly produced by the retired background extractor). It is the input to
 * `durableCandidateFromExtracted` → `persistDurableMemoryCandidate`.
 */
export interface ExtractedDurableMemoryCandidate {
  scope: "workspace" | "user";
  memoryType: MemoryEntryType;
  subjectKey: string;
  title: string;
  summary: string;
  tags: string[];
  evidence: string;
  confidence: number | null;
}

export interface DurableMemoryCandidate {
  memoryId: string;
  scope: Extract<MemoryEntryScope, "workspace" | "user">;
  memoryType: MemoryEntryType;
  subjectKey: string;
  path: string;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  verificationPolicy: MemoryVerificationPolicy;
  stalenessPolicy: MemoryStalenessPolicy;
  staleAfterSeconds: number | null;
  sourceMessageId?: string | null;
  sourceType: MemoryEntrySourceType;
  observedAt: string | null;
  lastVerifiedAt: string | null;
  confidence: number | null;
  evidence?: string | null;
  relatedInfo?: DurableMemoryRelatedInfo | null;
}

export interface TurnMemoryWritebackModelContext {
  modelClient?: MemoryModelClientConfig | null;
  instruction?: string | null;
}

// Durable memory is captured by the agent-invoked `remember` tool
// (recordDurableMemoryFromInput) — the brain records a fact the moment it learns
// it. The old post-hoc, per-turn model EXTRACTION pass (a gpt-5.4 call every turn,
// and one that could not run for external non-pi harnesses at all) was removed
// 2026-07-14. writeTurnDurableMemory now only indexes turn artifacts/documents
// (the recall substrate). Design: docs/plans/2026-07-14-agent-invoked-durable-memory.md.

function structuredArtifactContextsForTurn(
  store: RuntimeStateStore,
  turnResult: TurnResultRecord,
): DurableMemoryArtifactContext[] {
  return artifactContextsForSourceTurnInput({
    store,
    workspaceId: turnResult.workspaceId,
    sourceTurnInputId: turnResult.inputId,
  });
}

function isSummaryLikeSemanticInteractionNode(
  node: ReturnType<RuntimeStateStore["listSemanticMemoryNodes"]>[number],
): boolean {
  return node.nodeClass === "semantic" && (node.nodeKind !== "tree" || node.childCount > 1);
}

function safePathSegment(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clippedText(value: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export interface ResponseStylePreference {
  style: "concise" | "detailed";
  evidence: string;
};

export function detectExplicitResponseStylePreference(messageText: string): ResponseStylePreference | null {
  const normalized = compactWhitespace(messageText);
  if (!normalized) {
    return null;
  }

  const concisePatterns = [
    /\bprefer\s+(?:responses?|answers?|replies)\s+(?:to be\s+)?(?:concise|brief|short)\b/i,
    /\b(?:keep|make)\s+(?:your\s+)?(?:responses?|answers?|replies)\s+(?:concise|brief|short)\b/i,
    /\b(?:be|stay)\s+(?:concise|brief|short)\b/i,
  ];
  for (const pattern of concisePatterns) {
    if (pattern.test(normalized)) {
      return {
        style: "concise",
        evidence: clippedText(normalized, 220),
      };
    }
  }

  const detailedPatterns = [
    /\bprefer\s+(?:responses?|answers?|replies)\s+(?:to be\s+)?(?:detailed|thorough|comprehensive|in-depth)\b/i,
    /\b(?:keep|make)\s+(?:your\s+)?(?:responses?|answers?|replies)\s+(?:detailed|thorough|comprehensive|in-depth)\b/i,
    /\b(?:be|stay)\s+(?:detailed|thorough|comprehensive)\b/i,
  ];
  for (const pattern of detailedPatterns) {
    if (pattern.test(normalized)) {
      return {
        style: "detailed",
        evidence: clippedText(normalized, 220),
      };
    }
  }

  return null;
}

function extractedMemoryPath(turnResult: TurnResultRecord, candidate: ExtractedDurableMemoryCandidate): string {
  const subjectToken = safePathSegment(candidate.subjectKey, "memory");
  if (candidate.scope === "user") {
    if (candidate.memoryType === "identity") {
      return `identity/${subjectToken}.md`;
    }
    return `preference/${subjectToken}.md`;
  }
  switch (candidate.memoryType) {
    case "procedure":
      return `workspace/${turnResult.workspaceId}/knowledge/procedures/${subjectToken}-procedure.md`;
    case "blocker":
      return `workspace/${turnResult.workspaceId}/knowledge/blockers/${subjectToken}.md`;
    case "reference":
      return `workspace/${turnResult.workspaceId}/knowledge/reference/${subjectToken}.md`;
    default:
      return `workspace/${turnResult.workspaceId}/knowledge/facts/${subjectToken}.md`;
  }
}

function durableMemoryContent(params: {
  workspaceId: string;
  sessionId: string;
  updatedAt: string;
  scope: MemoryEntryScope;
  memoryType: MemoryEntryType;
  subjectKey: string;
  title: string;
  summary: string;
  evidence?: string | null;
  relatedInfo?: DurableMemoryRelatedInfo | null;
}): string {
  const lines = [
    `# ${params.title}`,
    "",
    `- Scope: \`${params.scope}\``,
    `- Type: \`${params.memoryType}\``,
    `- Subject: \`${params.subjectKey}\``,
    `- Workspace ID: \`${params.workspaceId}\``,
    `- Session ID: \`${params.sessionId}\``,
    `- Updated at: ${params.updatedAt}`,
    "",
    "## Summary",
    "",
    params.summary,
  ];
  if (params.evidence) {
    lines.push("", "## Evidence", "", params.evidence);
  }
  return appendDurableMemoryRelatedSections(
    `${lines.join("\n").trim()}\n`,
    params.relatedInfo ?? {
      relatedEntities: [],
      relations: [],
    },
  );
}

function durableCandidateFromExtracted(params: {
  turnResult: TurnResultRecord;
  extracted: ExtractedDurableMemoryCandidate;
}): DurableMemoryCandidate {
  const governance = governanceRuleForMemoryType(params.extracted.memoryType);
  const pathValue = extractedMemoryPath(params.turnResult, params.extracted);
  const memoryId = `extracted:${createHash("sha256")
    .update(`${params.extracted.scope}:${params.extracted.memoryType}:${params.extracted.subjectKey}:${pathValue}`)
    .digest("hex")
    .slice(0, 24)}`;
  const observedAt = params.turnResult.completedAt ?? params.turnResult.updatedAt;
  return {
    memoryId,
    scope: params.extracted.scope,
    memoryType: params.extracted.memoryType,
    subjectKey: params.extracted.subjectKey,
    path: pathValue,
    title: params.extracted.title,
    summary: params.extracted.summary,
    content: durableMemoryContent({
      workspaceId: params.turnResult.workspaceId,
      sessionId: params.turnResult.sessionId,
      updatedAt: observedAt,
      scope: params.extracted.scope,
      memoryType: params.extracted.memoryType,
      subjectKey: params.extracted.subjectKey,
      title: params.extracted.title,
      summary: params.extracted.summary,
      evidence: params.extracted.evidence,
    }),
    tags: params.extracted.tags,
    verificationPolicy: governance.verificationPolicy,
    stalenessPolicy: governance.stalenessPolicy,
    staleAfterSeconds: governance.staleAfterSeconds,
    sourceType: "assistant_turn",
    observedAt,
    lastVerifiedAt: observedAt,
    confidence: params.extracted.confidence,
    evidence: params.extracted.evidence,
    relatedInfo: null,
  };
}

async function enrichDurableCandidateWithRelatedInfo(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  updatedAt: string;
  sourceTurnInputId: string;
  candidate: DurableMemoryCandidate;
  modelClient: MemoryModelClientConfig | null;
}): Promise<DurableMemoryCandidate> {
  if (params.candidate.scope !== "workspace") {
    return params.candidate;
  }
  const sourceTurnResult = params.store.getTurnResult({
    workspaceId: params.workspaceId,
    inputId: params.sourceTurnInputId,
  });
  const artifactContexts = sourceTurnResult
    ? structuredArtifactContextsForTurn(params.store, sourceTurnResult)
    : [];
  const resolver = createWorkspaceRelatedEntityResolverFromStore({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const extractedRelatedInfo = await extractDurableMemoryRelatedInfo({
    modelClient: params.modelClient,
    memoryType: params.candidate.memoryType,
    subjectKey: params.candidate.subjectKey,
    title: params.candidate.title,
    summary: params.candidate.summary,
    content: params.candidate.content,
    tags: params.candidate.tags,
    artifactContexts,
    resolver,
    sourceTurnInputId: params.sourceTurnInputId,
  });
  const relatedInfo = mergeArtifactDerivedRelations({
    relatedInfo: extractedRelatedInfo,
    artifactContexts,
  });
  if (relatedInfo.relatedEntities.length === 0 && relatedInfo.relations.length === 0) {
    return params.candidate;
  }
  return {
    ...params.candidate,
    relatedInfo,
    content: durableMemoryContent({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      updatedAt: params.updatedAt,
      scope: params.candidate.scope,
      memoryType: params.candidate.memoryType,
      subjectKey: params.candidate.subjectKey,
      title: params.candidate.title,
      summary: params.candidate.summary,
      evidence: params.candidate.evidence ?? null,
      relatedInfo,
    }),
  };
}

export async function persistDurableMemoryCandidate(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  candidate: DurableMemoryCandidate;
  modelContext?: TurnMemoryWritebackModelContext | null;
}): Promise<string> {
  void params.memoryService;
  const enrichedCandidate = await enrichDurableCandidateWithRelatedInfo({
    store: params.store,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    updatedAt: params.candidate.observedAt ?? params.candidate.lastVerifiedAt ?? new Date().toISOString(),
    sourceTurnInputId: params.inputId,
    candidate: params.candidate,
    modelClient: params.modelContext?.modelClient ?? null,
  });
  const embeddingClient = createRecallEmbeddingModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
  });
  const result = await persistWorkspaceMemoryCandidate({
    store: params.store,
    workspaceId: params.workspaceId,
    candidate: {
      subjectKey: enrichedCandidate.subjectKey,
      title: enrichedCandidate.title,
      summary: enrichedCandidate.summary,
      content: enrichedCandidate.content,
      tags: enrichedCandidate.tags,
      memoryType: enrichedCandidate.memoryType,
      sourceType: enrichedCandidate.sourceType,
      sourceEventId: params.inputId,
      sourceMessageId: enrichedCandidate.sourceMessageId ?? null,
      sourceTurnInputId: params.inputId,
      observedAt: enrichedCandidate.observedAt ?? null,
      confidence: enrichedCandidate.confidence ?? null,
    },
    modelClient: params.modelContext?.modelClient ?? null,
    embeddingClient,
  });
  void queueWorkspaceMemoryTreeRebuild({
    store: params.store,
    workspaceId: params.workspaceId,
    treeId: result.treeId,
    summaryModelClient: null,
    embeddingClient,
  });
  return result.path;
}

/**
 * Record ONE durable-memory candidate supplied directly by the agent (the
 * `remember` tool) instead of extracted post-hoc by the background model.
 *
 * This is the agent-invoked write path (design:
 * docs/plans/2026-07-14-agent-invoked-durable-memory.md). It reuses the exact
 * candidate-shaping (`durableCandidateFromExtracted`) and persistence
 * (`persistDurableMemoryCandidate` → dedup/upsert + index rebuild) as the
 * extraction path, but runs with NO model client (`modelContext: null`) — so
 * the write itself makes no LLM call. The brain already decided what is worth
 * remembering; the server keeps the deterministic quality.
 */
export async function recordDurableMemoryFromInput(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  extracted: ExtractedDurableMemoryCandidate;
}): Promise<{ path: string; subjectKey: string; memoryType: MemoryEntryType; scope: "workspace" | "user" }> {
  // `durableCandidateFromExtracted` only reads workspaceId/sessionId/completedAt/
  // updatedAt from the turn result. Mid-turn the record exists (created at turn
  // start); fall back to a minimal stand-in if it hasn't been written yet.
  const turnResult =
    params.store.getTurnResult({ workspaceId: params.workspaceId, inputId: params.inputId }) ??
    ({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
      completedAt: null,
      updatedAt: new Date().toISOString(),
    } as unknown as TurnResultRecord);
  const candidate = durableCandidateFromExtracted({ turnResult, extracted: params.extracted });
  const path = await persistDurableMemoryCandidate({
    store: params.store,
    memoryService: params.memoryService,
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
    candidate,
    modelContext: null,
  });
  return {
    path,
    subjectKey: candidate.subjectKey,
    memoryType: candidate.memoryType,
    scope: candidate.scope,
  };
}

export async function refreshMemoryIndexes(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  workspaceId: string;
  entityIds?: string[] | null;
}): Promise<string[]> {
  void params.memoryService;
  const requestedEntityIds = params.entityIds
    ? [...new Set(params.entityIds.map((value) => value.trim()).filter(Boolean))]
    : [];
  const summaryModelClient = createBackgroundTaskMemoryModelClient({
    workspaceId: params.workspaceId,
    sessionId: `memory-refresh:${params.workspaceId}`,
    inputId: `memory-refresh:${params.workspaceId}`,
  });
  const embeddingClient = createRecallEmbeddingModelClient({
    workspaceId: params.workspaceId,
    sessionId: `memory-refresh:${params.workspaceId}`,
    inputId: `memory-refresh:${params.workspaceId}`,
  });
  const targetEntities = requestedEntityIds.length > 0
    ? requestedEntityIds
      .map((entityId) =>
        params.store.getInteractionEntity({
          workspaceId: params.workspaceId,
          entityId,
        }))
      .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity))
    : params.store.listInteractionEntities({
      workspaceId: params.workspaceId,
      status: "active",
      includeSystem: true,
      limit: 10_000,
      offset: 0,
    });
  if (requestedEntityIds.length > 0) {
    for (const entity of targetEntities) {
      void queueWorkspaceMemoryTreeRebuild({
        store: params.store,
        workspaceId: params.workspaceId,
        treeId: entity.entityId,
        summaryModelClient,
        embeddingClient,
        debounceMs: 0,
      });
    }
    await waitForPendingWorkspaceMemoryTreeRebuilds({
      workspaceId: params.workspaceId,
      treeIds: targetEntities.map((entity) => entity.entityId),
    });
  } else {
    await rebuildWorkspaceMemoryGraph({
      store: params.store,
      workspaceId: params.workspaceId,
      sessionId: `memory-refresh:${params.workspaceId}`,
      inputId: `memory-refresh:${params.workspaceId}`,
    });
  }
  ensureWorkspaceInteractionSemanticTreesMigrated({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const semanticPaths = targetEntities
    .flatMap((entity) =>
      params.store.listSemanticMemoryNodes({
        category: "workspace",
        workspaceId: params.workspaceId,
        treeId: entity.entityId,
        nodeClass: "semantic",
        status: "active",
        limit: 10_000,
        offset: 0,
      }))
    .filter((node) => isSummaryLikeSemanticInteractionNode(node))
    .map((node) => node.path);
  return semanticPaths;
}

export async function writeTurnDurableMemory(params: {
  store: RuntimeStateStore;
  // Vestigial (see `void params.memoryService` below) — accepted nullable so the
  // executor's optional memoryService can be threaded through without a cast.
  memoryService?: MemoryServiceLike | null;
  turnResult: TurnResultRecord;
  modelContext?: TurnMemoryWritebackModelContext | null;
}): Promise<TurnResultRecord> {
  void params.memoryService;
  const artifactVisionModelClient = params.modelContext?.modelClient ?? null;
  await persistTurnInputAttachmentsAsDocuments({
    store: params.store,
    turnResult: params.turnResult,
    embeddingClient: createRecallEmbeddingModelClient({
      workspaceId: params.turnResult.workspaceId,
      sessionId: params.turnResult.sessionId,
      inputId: params.turnResult.inputId,
    }),
    visionModelClient: artifactVisionModelClient,
    relatedInfoModelClient: params.modelContext?.modelClient ?? null,
  });
  await persistTurnReferencedImageUrlsAsDocuments({
    store: params.store,
    turnResult: params.turnResult,
    embeddingClient: createRecallEmbeddingModelClient({
      workspaceId: params.turnResult.workspaceId,
      sessionId: params.turnResult.sessionId,
      inputId: params.turnResult.inputId,
    }),
    visionModelClient: artifactVisionModelClient,
    relatedInfoModelClient: params.modelContext?.modelClient ?? null,
  });
  // Integration tool results are intentionally NOT indexed as durable memory.
  // They are transcript/evidence, not durable semantic knowledge: high-volume,
  // machine-fetched, and stale-prone (the live integration is the source of
  // truth — re-query it rather than recall a snapshot). Indexing every result
  // floods the single global graph that all contexts recall from. The durable
  // signal from a turn is still captured by the gated candidate extraction below
  // (which can cite the tool result via evidence refs). If searchable recall over
  // read integration content is ever needed, build it as a scoped, TTL'd, opt-in
  // store — not the always-on global durable path.
  await persistTurnOutputArtifactsAsDocuments({
    store: params.store,
    turnResult: params.turnResult,
    embeddingClient: createRecallEmbeddingModelClient({
      workspaceId: params.turnResult.workspaceId,
      sessionId: params.turnResult.sessionId,
      inputId: params.turnResult.inputId,
    }),
    visionModelClient: artifactVisionModelClient,
    relatedInfoModelClient: params.modelContext?.modelClient ?? null,
  });
  // Durable fact capture is the agent-invoked `remember` tool
  // (recordDurableMemoryFromInput). This function now only indexes turn
  // artifacts/documents (the recall substrate); the former per-turn model
  // extraction pass was retired 2026-07-14 (docs/plans/2026-07-14-agent-invoked-durable-memory.md).
  return (
    params.store.getTurnResult({
      workspaceId: params.turnResult.workspaceId,
      inputId: params.turnResult.inputId,
    }) ?? params.turnResult
  );
}

export async function writeTurnMemory(params: {
  store: RuntimeStateStore;
  memoryService?: MemoryServiceLike | null;
  turnResult: TurnResultRecord;
  modelContext?: TurnMemoryWritebackModelContext | null;
}): Promise<TurnResultRecord> {
  try {
    return await writeTurnDurableMemory({
      store: params.store,
      memoryService: params.memoryService,
      turnResult: params.turnResult,
      modelContext: params.modelContext ?? null,
    });
  } catch {
    return (
      params.store.getTurnResult({
        workspaceId: params.turnResult.workspaceId,
        inputId: params.turnResult.inputId,
      }) ?? params.turnResult
    );
  }
}
