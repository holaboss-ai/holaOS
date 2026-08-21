import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type InteractionEntityRecord,
  type InteractionEntityType,
  type InteractionLeafRecord,
  type InteractionTreeChildKind,
  type RuntimeStateStore,
  type SemanticMemoryCategory,
  utcNowIso,
} from "@holaboss/runtime-state-store";

import { createBackgroundTaskMemoryModelClient } from "./background-task-model.js";
import {
  artifactContextEvidenceLines,
  type DurableMemoryArtifactContext,
} from "./memory-artifact-context.js";
import {
  buildInteractionLeafArtifactRelatedInfo,
  ensureMinimumSemanticOwnerRelatedInfo,
  interactionLeafNeedsQualityRepair,
  isRequestShapedInteractionLeaf,
  relatedInfoNeedsCanonicalRewrite,
  restoreInteractionLeafContentFromSourceEvidence,
  shouldForceModelInteractionLeafRelationRepair,
  type InteractionLeafArtifactDescriptor,
} from "./interaction-memory-quality.js";
import {
  appendDurableMemoryRelatedSections,
  canonicalizeDurableMemoryRelatedInfo,
  extractDurableMemoryRelatedInfo,
  hasDurableMemoryRelatedProcessedMarker,
  markDurableMemoryRelatedProcessed,
  mergeArtifactDerivedRelations,
  mergeDurableMemoryRelatedInfo,
  parseDurableMemoryRelatedInfo,
  stableRelatedEntityKey,
  stripDurableMemoryRelatedSections,
  type DurableMemoryRelatedEntity,
  type DurableMemoryRelatedEntityType,
} from "./memory-related-entities.js";
import type { AgentRecalledMemoryContext } from "./memory-retrieval-pack.js";
import { queryMemoryModelEmbedding, queryMemoryModelJson, type MemoryModelClientConfig } from "./memory-model-client.js";
import { createRecallEmbeddingModelClient } from "./recall-embedding-model.js";
import {
  assistantTextFromTurnArtifacts,
  attachmentEvidenceFromTurnInput,
  integrationToolEvidenceEntriesFromTurnArtifacts,
  integrationToolEvidenceFromTurnArtifacts,
} from "./turn-semantic-artifacts.js";
import {
  artifactContextsForSourceTurnInput,
  ensureWorkspaceArtifactRelationsBackfilled,
  listWorkspaceAttachmentDocumentTrees,
  listWorkspaceImageUrlDocumentTrees,
  listWorkspaceOutputDocumentTrees,
  listWorkspaceToolResultDocumentTrees,
  workspaceArtifactBackfillStateToken,
} from "./workspace-attachment-memory.js";
import { workspaceMemoryDir } from "./workspace-bundle-paths.js";
import { createWorkspaceRelatedEntityResolverFromStore } from "./workspace-related-entity-resolver-store.js";
import {
  canonicalAttachmentArtifactEntityKey,
  canonicalImageUrlArtifactEntityKey,
  canonicalOutputArtifactEntityKey,
  canonicalToolResultArtifactEntityKey,
} from "./workspace-related-entity-keys.js";

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
const SEMANTIC_SUMMARY_CHUNK_NODE_KIND = "summary_chunk";
const SEMANTIC_SUMMARY_CHUNK_TRIGGER_CHARS = 320;
const SEMANTIC_SUMMARY_CHUNK_MAX_CHARS = 800;
const WORKSPACE_INTERACTION_UNCATEGORIZED_RECLASSIFY_METADATA_KEY =
  "interaction_uncategorized_reclassification_v1_last_processed_at";
const WORKSPACE_INTERACTION_LEAF_QUALITY_REPAIR_METADATA_KEY =
  "workspace_related_entity_repair_v3";
const ENTITY_CREATE_CONFIDENCE_THRESHOLD = 0.68;
const ENTITY_MATCH_CONFIDENCE_THRESHOLD = 0.6;
const SEMANTIC_DEDUPE_SHORTLIST_LIMIT = 6;
const SEMANTIC_DEDUPE_SIMILARITY_THRESHOLD = 0.52;
const INTERACTION_SUMMARY_INPUT_FINGERPRINT_VERSION = 1;
const INTERACTION_WORKSPACE_SECTION_DIR_BY_ENTITY_TYPE: Record<InteractionEntityType, string> = {
  project: "projects",
  workflow: "processes",
  preference: "preferences-rules",
  identity: "people",
  person: "people",
  customer: "organizations",
  system: "systems",
  topic: "knowledge",
  misc: "knowledge",
};
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
const PREFERENCE_SUBJECT_TOKENS = new Set([
  "approval",
  "approvals",
  "cadence",
  "guideline",
  "guidelines",
  "limit",
  "limits",
  "policy",
  "policies",
  "preference",
  "preferences",
  "rule",
  "rules",
  "threshold",
  "thresholds",
  "window",
  "windows",
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
type InteractionSemanticCategory = Extract<SemanticMemoryCategory, "interaction" | "workspace">;
const ACTIVE_WORKSPACE_INTERACTION_CATEGORY: InteractionSemanticCategory = "workspace";

function normalizeInteractionSemanticWorkspaceId(workspaceId?: string | null): string | null {
  return typeof workspaceId === "string" && workspaceId.trim().length > 0
    ? workspaceId.trim()
    : null;
}

export function writableInteractionSemanticCategory(
  workspaceId?: string | null,
): InteractionSemanticCategory {
  return normalizeInteractionSemanticWorkspaceId(workspaceId) ? "workspace" : "interaction";
}

export function readableInteractionSemanticCategory(params: {
  store: RuntimeStateStore;
  workspaceId?: string | null;
  treeId: string;
  cache?: Map<string, InteractionSemanticCategory>;
}): InteractionSemanticCategory {
  const workspaceId = normalizeInteractionSemanticWorkspaceId(params.workspaceId);
  if (!workspaceId) {
    return "interaction";
  }
  const treeId = params.treeId.trim();
  if (!treeId) {
    return "workspace";
  }
  const cacheKey = `${workspaceId}:${treeId}`;
  const cached = params.cache?.get(cacheKey);
  if (cached) {
    return cached;
  }
  const hasWorkspaceSemanticState = () => {
    if (params.store.listSemanticMemoryNodes({
      category: "workspace",
      workspaceId,
      treeId,
      limit: 1,
      offset: 0,
    }).length > 0) {
      return true;
    }
    if (
      typeof (params.store as { listSemanticMemorySearchDocs?: unknown }).listSemanticMemorySearchDocs === "function"
      && params.store.listSemanticMemorySearchDocs({
        category: "workspace",
        workspaceId,
        treeId,
        limit: 1,
        offset: 0,
      }).length > 0
    ) {
      return true;
    }
    if (
      typeof (params.store as { listSemanticMemoryEvidenceRefs?: unknown }).listSemanticMemoryEvidenceRefs === "function"
      && params.store.listSemanticMemoryEvidenceRefs({
        category: "workspace",
        workspaceId,
        treeId,
        limit: 1,
        offset: 0,
      }).length > 0
    ) {
      return true;
    }
    return false;
  };
  const canMigrate = typeof (params.store as { migrateSemanticMemoryTreeCategory?: unknown }).migrateSemanticMemoryTreeCategory
    === "function";
  const category: InteractionSemanticCategory = hasWorkspaceSemanticState()
    ? "workspace"
    : canMigrate && params.store.migrateSemanticMemoryTreeCategory({
      workspaceId,
      treeId,
      fromCategory: "interaction",
      toCategory: "workspace",
    })
      ? "workspace"
      : "interaction";
  params.cache?.set(cacheKey, category);
  return category;
}

export function ensureWorkspaceInteractionSemanticTreesMigrated(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId?: string | null;
}): void {
  if (
    typeof (params.store as { migrateSemanticMemoryTreeCategory?: unknown }).migrateSemanticMemoryTreeCategory
    !== "function"
  ) {
    return;
  }
  const requestedTreeId = (params.treeId ?? "").trim();
  const treeIds = requestedTreeId
    ? [requestedTreeId]
    : params.store.listInteractionEntities({
      workspaceId: params.workspaceId,
      status: "active",
      includeSystem: true,
      limit: 10_000,
      offset: 0,
    }).map((entity) => entity.entityId);
  for (const treeId of treeIds) {
    if (!treeId.trim()) {
      continue;
    }
    params.store.migrateSemanticMemoryTreeCategory({
      workspaceId: params.workspaceId,
      treeId,
      fromCategory: "interaction",
      toCategory: "workspace",
    });
  }
}

function latestActiveUncategorizedInteractionLeafMarker(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): string | null {
  if (typeof (params.store as { listInteractionLeaves?: unknown }).listInteractionLeaves !== "function") {
    return null;
  }
  const leaves = params.store.listInteractionLeaves({
    workspaceId: params.workspaceId,
    entityId: INTERACTION_UNCATEGORIZED_ENTITY_ID,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  let latest: string | null = null;
  for (const leaf of leaves) {
    const candidate = (leaf.updatedAt ?? leaf.observedAt ?? leaf.createdAt ?? "").trim();
    if (!candidate) {
      continue;
    }
    if (!latest || candidate > latest) {
      latest = candidate;
    }
  }
  return latest;
}

function latestActiveInteractionLeafMarker(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): string | null {
  if (typeof (params.store as { listInteractionLeaves?: unknown }).listInteractionLeaves !== "function") {
    return null;
  }
  const leaves = params.store.listInteractionLeaves({
    workspaceId: params.workspaceId,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  let latest: string | null = null;
  for (const leaf of leaves) {
    const candidate = (leaf.updatedAt ?? leaf.observedAt ?? leaf.createdAt ?? "").trim();
    if (!candidate) {
      continue;
    }
    if (!latest || candidate > latest) {
      latest = candidate;
    }
  }
  return latest;
}

export async function ensureWorkspaceInteractionUncategorizedLeavesReclassified(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): Promise<void> {
  if (
    typeof (params.store as { getWorkspaceRuntimeMetadata?: unknown }).getWorkspaceRuntimeMetadata !== "function"
    || typeof (params.store as { setWorkspaceRuntimeMetadata?: unknown }).setWorkspaceRuntimeMetadata !== "function"
  ) {
    return;
  }
  const latestBefore = latestActiveUncategorizedInteractionLeafMarker(params);
  if (!latestBefore) {
    return;
  }
  const processedAt = params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_INTERACTION_UNCATEGORIZED_RECLASSIFY_METADATA_KEY,
  });
  if (processedAt && processedAt >= latestBefore) {
    return;
  }
  await rebuildInteractionEntityTree({
    store: params.store,
    workspaceId: params.workspaceId,
    entityId: INTERACTION_UNCATEGORIZED_ENTITY_ID,
    summaryModelClient: null,
    embeddingClient: null,
  });
  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_INTERACTION_UNCATEGORIZED_RECLASSIFY_METADATA_KEY,
    value: latestActiveUncategorizedInteractionLeafMarker(params) ?? latestBefore,
  });
}

function interactionLeafArtifactDescriptors(params: {
  sourceTurnInputId: string | null;
  attachmentDescriptors: ReturnType<typeof listWorkspaceAttachmentDocumentTrees>;
  imageUrlDescriptors: ReturnType<typeof listWorkspaceImageUrlDocumentTrees>;
  toolResultDescriptors: ReturnType<typeof listWorkspaceToolResultDocumentTrees>;
  outputDescriptors: ReturnType<typeof listWorkspaceOutputDocumentTrees>;
}): InteractionLeafArtifactDescriptor[] {
  const sourceTurnInputId = params.sourceTurnInputId?.trim() ?? "";
  if (!sourceTurnInputId) {
    return [];
  }
  return [
    ...params.attachmentDescriptors.map((descriptor) => ({
      entityKey: canonicalAttachmentArtifactEntityKey(descriptor.attachmentId),
      title: descriptor.title,
      sourceTurnInputId: descriptor.sourceTurnInputId,
    })),
    ...params.imageUrlDescriptors.map((descriptor) => ({
      entityKey: canonicalImageUrlArtifactEntityKey(descriptor.imageUrl),
      title: descriptor.title,
      sourceTurnInputId: descriptor.sourceTurnInputId,
    })),
    ...params.toolResultDescriptors.map((descriptor) => ({
      entityKey: canonicalToolResultArtifactEntityKey({
        providerId: descriptor.providerId,
        callId: descriptor.callId,
        outputEventId: descriptor.outputEventId,
      }),
      title: descriptor.title,
      sourceTurnInputId: descriptor.sourceTurnInputId,
    })),
    ...params.outputDescriptors.map((descriptor) => ({
      entityKey: canonicalOutputArtifactEntityKey(descriptor.outputId),
      title: descriptor.title,
      sourceTurnInputId: descriptor.sourceTurnInputId,
    })),
  ].filter((descriptor) => (descriptor.sourceTurnInputId?.trim() ?? "") === sourceTurnInputId);
}

function interactionLeafRecoveredSourceEvidence(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  leaf: InteractionLeafRecord;
}): { assistantText: string | null; evidenceLines: string[] } | null {
  const sourceTurnInputId = params.leaf.sourceTurnInputId?.trim() ?? "";
  if (!sourceTurnInputId) {
    return null;
  }
  const turnResult = params.store.getTurnResult({
    workspaceId: params.workspaceId,
    inputId: sourceTurnInputId,
  });
  const assistantText = turnResult
    ? compactWhitespace(assistantTextFromTurnArtifacts(params.store, turnResult))
    : "";
  const artifactContexts = artifactContextsForSourceTurnInput({
    store: params.store,
    workspaceId: params.workspaceId,
    sourceTurnInputId,
    maxDocumentsPerKind: 6,
    maxChunksPerDocument: 4,
    maxCharsPerChunk: 1_600,
  });
  const evidenceLines = [
    ...(turnResult ? integrationToolEvidenceFromTurnArtifacts(params.store, turnResult) : []),
    ...artifactContextEvidenceLines({
      artifactContexts,
      maxExcerptsPerArtifact: 4,
      maxCharsPerExcerpt: 1_600,
    }),
    ...(turnResult ? attachmentEvidenceFromTurnInput(params.store, turnResult) : []),
  ]
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
  if (!assistantText && evidenceLines.length === 0) {
    return null;
  }
  return {
    assistantText: assistantText || null,
    evidenceLines,
  };
}

function interactionLeafArtifactContextsFromSourceTurn(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  leaf: InteractionLeafRecord;
}): DurableMemoryArtifactContext[] {
  const sourceTurnInputId = params.leaf.sourceTurnInputId?.trim() ?? "";
  if (!sourceTurnInputId) {
    return [];
  }
  return artifactContextsForSourceTurnInput({
    store: params.store,
    workspaceId: params.workspaceId,
    sourceTurnInputId,
    maxDocumentsPerKind: 6,
    maxChunksPerDocument: 4,
    maxCharsPerChunk: 1_600,
  });
}

async function repairInteractionLeafQuality(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entity: InteractionEntityRecord;
  leaf: InteractionLeafRecord;
  body: string;
  artifactDescriptors: InteractionLeafArtifactDescriptor[];
  relatedInfoModelClient: MemoryModelClientConfig | null;
  embeddingClient: MemoryModelClientConfig | null;
}): Promise<{ leaf: InteractionLeafRecord | null; body: string | null; changed: boolean; deleted: boolean }> {
  if (isRequestShapedInteractionLeaf({
    title: params.leaf.title,
    summary: params.leaf.summary,
    body: params.body,
    subjectKey: params.leaf.subjectKey,
  })) {
    params.store.updateInteractionLeafStatus({
      workspaceId: params.workspaceId,
      leafId: params.leaf.leafId,
      status: "archived",
    });
    const absolutePath = absolutePathForRelative(params.store.workspaceDir(params.workspaceId), params.leaf.path);
    if (fs.existsSync(absolutePath)) {
      fs.rmSync(absolutePath, { force: true });
    }
    return {
      leaf: null,
      body: null,
      changed: true,
      deleted: true,
    };
  }
  const recoveredSourceEvidence = interactionLeafRecoveredSourceEvidence({
    store: params.store,
    workspaceId: params.workspaceId,
    leaf: params.leaf,
  });
  const restoredFromSource = restoreInteractionLeafContentFromSourceEvidence({
    title: params.leaf.title,
    memoryType: memoryTypeFromLeafBody(params.body),
    body: params.body,
    summary: params.leaf.summary,
    assistantText: recoveredSourceEvidence?.assistantText ?? null,
    evidenceLines: recoveredSourceEvidence?.evidenceLines ?? [],
  });
  const repairedBodyBase = restoredFromSource.changed ? restoredFromSource.content : params.body;
  const repairedSummary = restoredFromSource.changed ? restoredFromSource.summary : params.leaf.summary;
  const resolver = createWorkspaceRelatedEntityResolverFromStore({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const parsedStoredRelatedInfo = parseDurableMemoryRelatedInfo(repairedBodyBase);
  const hadStoredRelatedInfo = parsedStoredRelatedInfo.relatedEntities.length > 0
    || parsedStoredRelatedInfo.relations.length > 0;
  const hadProcessedMarker = hasDurableMemoryRelatedProcessedMarker(repairedBodyBase);
  const existingRelatedInfo = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: parsedStoredRelatedInfo,
    resolver,
    sourceTurnInputId: params.leaf.sourceTurnInputId ?? null,
    artifactContexts: interactionLeafArtifactContextsFromSourceTurn({
      store: params.store,
      workspaceId: params.workspaceId,
      leaf: params.leaf,
    }),
  });
  const artifactRelatedInfo = buildInteractionLeafArtifactRelatedInfo({
    sourceTurnInputId: params.leaf.sourceTurnInputId ?? null,
    artifactDescriptors: params.artifactDescriptors,
  });
  const mergedRelatedInfo = ensureMinimumSemanticOwnerRelatedInfo({
    relatedInfo: mergeDurableMemoryRelatedInfo(existingRelatedInfo, artifactRelatedInfo),
    ownerEntityType: params.entity.entityType,
    ownerEntityId: params.entity.entityId,
    ownerLabel: params.entity.canonicalName,
  });
  const cleanedBodyBase = stripDurableMemoryRelatedSections(repairedBodyBase);
  const strippedStaleRelatedInfo = mergedRelatedInfo.relatedEntities.length === 0
    && mergedRelatedInfo.relations.length === 0
    && hadStoredRelatedInfo;
  const nextBody = mergedRelatedInfo.relatedEntities.length > 0 || mergedRelatedInfo.relations.length > 0
    ? appendDurableMemoryRelatedSections(cleanedBodyBase, mergedRelatedInfo)
    : strippedStaleRelatedInfo
      ? `${cleanedBodyBase.trimEnd()}\n`
      : hadProcessedMarker
        ? markDurableMemoryRelatedProcessed(cleanedBodyBase)
        : `${cleanedBodyBase.trimEnd()}\n`;
  let currentLeaf = params.leaf;
  let currentBody = nextBody;
  let changed = false;
  if (nextBody !== params.body || repairedSummary !== params.leaf.summary) {
    currentLeaf = await refreshInteractionLeafRecordFromCandidate({
      store: params.store,
      workspaceId: params.workspaceId,
      leaf: params.leaf,
      entity: params.entity,
      candidate: {
        subjectKey: params.leaf.subjectKey,
        title: params.leaf.title,
        summary: repairedSummary,
        content: nextBody,
        tags: params.leaf.tags,
        memoryType: memoryTypeFromLeafBody(repairedBodyBase),
        sourceType: params.leaf.sourceType,
        sourceEventId: params.leaf.sourceEventId,
        sourceMessageId: params.leaf.sourceMessageId,
        sourceTurnInputId: params.leaf.sourceTurnInputId,
        observedAt: params.leaf.observedAt,
        confidence: params.leaf.admissionConfidence,
      },
      entityConfidence: params.leaf.entityConfidence,
      secondaryEntityIds: params.leaf.secondaryEntityIds,
      embeddingClient: params.embeddingClient,
    });
    changed = true;
  }
  const currentRelatedInfo = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: parseDurableMemoryRelatedInfo(currentBody),
    resolver,
    sourceTurnInputId: currentLeaf.sourceTurnInputId ?? null,
    artifactContexts: interactionLeafArtifactContextsFromSourceTurn({
      store: params.store,
      workspaceId: params.workspaceId,
      leaf: currentLeaf,
    }),
  });
  if (
    params.relatedInfoModelClient
    && shouldForceModelInteractionLeafRelationRepair({
      relatedInfo: currentRelatedInfo,
      // Use the marker state from the leaf before this repair cycle. The
      // deterministic repair rewrite always writes the processed marker when it
      // appends related sections, but that should not suppress the first
      // model-enrichment pass for weak graphs in the same repair run.
      hasProcessedMarker: hadProcessedMarker,
      strippedStaleRelatedInfo,
    })
  ) {
    const enriched = await enrichInteractionLeafRelatedInfo({
      store: params.store,
      workspaceId: params.workspaceId,
      entity: params.entity,
      leaf: currentLeaf,
      body: currentBody,
      modelClient: params.relatedInfoModelClient,
      embeddingClient: params.embeddingClient,
      forceModel: true,
    });
    if (enriched.changed) {
      currentLeaf = enriched.leaf;
      currentBody = enriched.body;
      changed = true;
    }
  }
  return {
    leaf: currentLeaf,
    body: currentBody,
    changed,
    deleted: false,
  };
}

export async function ensureWorkspaceInteractionLeafQualityRepaired(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  selectedModel?: string | null;
}): Promise<void> {
  if (
    typeof (params.store as { getWorkspaceRuntimeMetadata?: unknown }).getWorkspaceRuntimeMetadata !== "function"
    || typeof (params.store as { setWorkspaceRuntimeMetadata?: unknown }).setWorkspaceRuntimeMetadata !== "function"
    || typeof (params.store as { listInteractionLeaves?: unknown }).listInteractionLeaves !== "function"
  ) {
    return;
  }
  const latestBefore = latestActiveInteractionLeafMarker(params);
  if (!latestBefore) {
    return;
  }
  ensureWorkspaceArtifactRelationsBackfilled({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const artifactBackfillState = workspaceArtifactBackfillStateToken({
    store: params.store,
    workspaceId: params.workspaceId,
  }) ?? "artifacts:unknown";
  const currentRepairState = `${latestBefore}|${artifactBackfillState}`;
  const processedState = params.store.getWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_INTERACTION_LEAF_QUALITY_REPAIR_METADATA_KEY,
  });
  if (processedState === currentRepairState) {
    return;
  }
  const attachmentDescriptors = listWorkspaceAttachmentDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const imageUrlDescriptors = listWorkspaceImageUrlDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const toolResultDescriptors = listWorkspaceToolResultDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const outputDescriptors = listWorkspaceOutputDocumentTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const activeLeaves = params.store.listInteractionLeaves({
    workspaceId: params.workspaceId,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  const resolver = createWorkspaceRelatedEntityResolverFromStore({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const selectedLeaves: Array<{
    leaf: InteractionLeafRecord;
    entity: InteractionEntityRecord;
    body: string;
    artifactDescriptors: InteractionLeafArtifactDescriptor[];
  }> = [];
  for (const leaf of activeLeaves) {
    const entity = params.store.getInteractionEntity({
      workspaceId: params.workspaceId,
      entityId: leaf.entityId,
    });
    if (!entity) {
      continue;
    }
    const body =
      readFileIfExists(absolutePathForRelative(params.store.workspaceDir(params.workspaceId), leaf.path))
      ?? interactionFallbackLeafBody(leaf);
    const artifactDescriptors = interactionLeafArtifactDescriptors({
      sourceTurnInputId: leaf.sourceTurnInputId ?? null,
      attachmentDescriptors,
      imageUrlDescriptors,
      toolResultDescriptors,
      outputDescriptors,
    });
    const relatedInfo = canonicalizeDurableMemoryRelatedInfo({
      relatedInfo: parseDurableMemoryRelatedInfo(body),
      resolver,
      sourceTurnInputId: leaf.sourceTurnInputId ?? null,
    });
    const parsedStoredRelatedInfo = parseDurableMemoryRelatedInfo(body);
    const needsCanonicalRewrite = relatedInfoNeedsCanonicalRewrite({
      original: parsedStoredRelatedInfo,
      canonical: relatedInfo,
    });
    if (!interactionLeafNeedsQualityRepair({
      title: leaf.title,
      summary: leaf.summary,
      body,
      subjectKey: leaf.subjectKey,
      relatedInfo,
      artifactDescriptors,
    }) && !needsCanonicalRewrite) {
      continue;
    }
    selectedLeaves.push({
      leaf,
      entity,
      body,
      artifactDescriptors,
    });
  }
  if (selectedLeaves.length === 0) {
    params.store.setWorkspaceRuntimeMetadata({
      workspaceId: params.workspaceId,
      key: WORKSPACE_INTERACTION_LEAF_QUALITY_REPAIR_METADATA_KEY,
      value: currentRepairState,
    });
    return;
  }
  const relatedInfoModelClient = createBackgroundTaskMemoryModelClient({
    workspaceId: params.workspaceId,
    sessionId: `memory-repair:${params.workspaceId}`,
    inputId: `memory-repair:${params.workspaceId}`,
    selectedModel: params.selectedModel ?? null,
  });
  const touchedEntityIds = new Set<string>();
  for (const selectedLeaf of selectedLeaves) {
    const repaired = await repairInteractionLeafQuality({
      store: params.store,
      workspaceId: params.workspaceId,
      entity: selectedLeaf.entity,
      leaf: selectedLeaf.leaf,
      body: selectedLeaf.body,
      artifactDescriptors: selectedLeaf.artifactDescriptors,
      relatedInfoModelClient,
      embeddingClient: null,
    });
    if (repaired.changed) {
      touchedEntityIds.add(selectedLeaf.entity.entityId);
    }
  }
  for (const entityId of touchedEntityIds) {
    await rebuildInteractionEntityTree({
      store: params.store,
      workspaceId: params.workspaceId,
      entityId,
      summaryModelClient: null,
      embeddingClient: null,
    });
  }
  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: WORKSPACE_INTERACTION_LEAF_QUALITY_REPAIR_METADATA_KEY,
    value: `${latestActiveInteractionLeafMarker(params) ?? latestBefore}|${artifactBackfillState}`,
  });
}

const INTERACTION_ENTITY_TYPES = new Set<InteractionEntityType>([
  "project",
  "workflow",
  "preference",
  "identity",
  "person",
  "customer",
  "system",
  "topic",
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
  changed: boolean;
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
type SemanticInteractionEvidenceRef = ReturnType<RuntimeStateStore["listSemanticMemoryEvidenceRefs"]>[number];
type SemanticInteractionRelation = ReturnType<RuntimeStateStore["listSemanticMemoryRelations"]>[number];

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
  nodeKind: "tree" | "partition" | "leaf" | typeof SEMANTIC_SUMMARY_CHUNK_NODE_KIND;
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

type SemanticSearchHit = ReturnType<RuntimeStateStore["searchSemanticMemorySearchDocs"]>[number];

function sortSemanticSearchHits(
  hits: SemanticSearchHit[],
): SemanticSearchHit[] {
  return hits.sort((left, right) =>
    (left.bm25Score ?? 0) - (right.bm25Score ?? 0)
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.path.localeCompare(right.path)
    || left.nodeId.localeCompare(right.nodeId));
}

function sortSemanticSearchDocsByRecency(
  docs: SemanticSearchDoc[],
): SemanticSearchDoc[] {
  return docs.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
    || left.path.localeCompare(right.path)
    || left.nodeId.localeCompare(right.nodeId));
}

function resolvedInteractionSemanticCategory(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  treeCategoryByTreeId?: ReadonlyMap<string, InteractionSemanticCategory>;
  cache?: Map<string, InteractionSemanticCategory>;
}): InteractionSemanticCategory {
  return params.treeCategoryByTreeId?.get(params.treeId)
    ?? readableInteractionSemanticCategory({
      store: params.store,
      workspaceId: params.workspaceId,
      treeId: params.treeId,
      cache: params.cache,
    });
}

function interactionSemanticTreeGroups(params: {
  treeCategoryByTreeId: ReadonlyMap<string, InteractionSemanticCategory>;
  treeIds?: Iterable<string>;
}): Array<{
  category: InteractionSemanticCategory;
  treeIds: string[];
}> {
  const interactionTreeIds: string[] = [];
  const workspaceTreeIds: string[] = [];
  const sourceTreeIds = params.treeIds
    ? [...params.treeIds]
    : [...params.treeCategoryByTreeId.keys()];
  for (const treeId of sourceTreeIds) {
    if (params.treeCategoryByTreeId.get(treeId) === "workspace") {
      workspaceTreeIds.push(treeId);
      continue;
    }
    interactionTreeIds.push(treeId);
  }
  return [
    interactionTreeIds.length > 0
      ? { category: "interaction", treeIds: interactionTreeIds }
      : null,
    workspaceTreeIds.length > 0
      ? { category: "workspace", treeIds: workspaceTreeIds }
      : null,
  ].filter((group): group is { category: InteractionSemanticCategory; treeIds: string[] } => Boolean(group));
}

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

function hasClippedEllipsis(value: string | null | undefined): boolean {
  return typeof value === "string" && /\.\.\./.test(compactWhitespace(value));
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
  const compactValue = compactWhitespace(value).toLowerCase();
  const normalized = compactValue.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized) {
    return normalized;
  }
  if (!compactValue) {
    return fallback;
  }
  return `label-${createHash("sha256").update(compactValue).digest("hex").slice(0, 12)}`;
}

function interactionMemoryRootDir(workspaceDir: string): string {
  return path.join(workspaceMemoryDir(workspaceDir), "interaction");
}

function interactionEntityDir(workspaceDir: string, slug: string): string {
  return path.join(interactionMemoryRootDir(workspaceDir), "entities", slug);
}

function workspaceSectionDirForInteractionEntityType(entityType: InteractionEntityType): string {
  return INTERACTION_WORKSPACE_SECTION_DIR_BY_ENTITY_TYPE[entityType];
}

function semanticInteractionTreeDir(workspaceDir: string, entityType: InteractionEntityType, slug: string): string {
  return path.join(
    workspaceMemoryDir(workspaceDir),
    "semantic",
    "workspace",
    workspaceSectionDirForInteractionEntityType(entityType),
    slug,
  );
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

function semanticInteractionSummaryChunkNodeId(parentNodeId: string, index: number): string {
  return `${parentNodeId}:${SEMANTIC_SUMMARY_CHUNK_NODE_KIND}:${index + 1}`;
}

function semanticRelatedEntityNodeId(entityKey: string): string {
  return `semantic:related:${entityKey}`;
}

function semanticInteractionTreeBaseSegments(entityType: InteractionEntityType, entitySlug: string): string[] {
  return [
    "semantic",
    "workspace",
    workspaceSectionDirForInteractionEntityType(entityType),
    entitySlug,
  ];
}

function semanticInteractionTreeRelativePath(entityType: InteractionEntityType, entitySlug: string): string {
  return path.posix.join(...semanticInteractionTreeBaseSegments(entityType, entitySlug), "content.md");
}

function semanticInteractionChildRelativePath(parentRelativePath: string, childSlug: string): string {
  return path.posix.join(path.posix.dirname(parentRelativePath), childSlug, "content.md");
}

function semanticInteractionSummaryChunkRelativePath(parentRelativePath: string, index: number): string {
  return path.posix.join(
    path.posix.dirname(parentRelativePath),
    "chunks",
    `chunk-${String(index + 1).padStart(3, "0")}`,
    "content.md",
  );
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

function semanticTreePathDepth(pathValue: string, markerSegments: string[]): number | null {
  const normalized = pathValue.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const markerIndex = segments.findIndex(
    (_, index) => markerSegments.every((segment, offset) => segments[index + offset] === segment),
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

function semanticInteractionPathDepth(pathValue: string): number | null {
  for (const sectionDir of Object.values(INTERACTION_WORKSPACE_SECTION_DIR_BY_ENTITY_TYPE)) {
    const depth = semanticTreePathDepth(pathValue, ["semantic", "workspace", sectionDir]);
    if (depth !== null) {
      return depth;
    }
  }
  return semanticTreePathDepth(pathValue, ["semantic", "interaction", "trees"]);
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

function normalizeInteractionLeafCandidateForEntity(params: {
  candidate: InteractionLeafCandidate;
  entity: InteractionEntityRecord;
  resolver?: ReturnType<typeof createWorkspaceRelatedEntityResolverFromStore> | null;
  sourceTurnInputId?: string | null;
  artifactContexts?: DurableMemoryArtifactContext[] | null;
}): InteractionLeafCandidate {
  const canonicalRelatedInfo = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: parseDurableMemoryRelatedInfo(params.candidate.content),
    resolver: params.resolver ?? null,
    sourceTurnInputId: params.sourceTurnInputId ?? params.candidate.sourceTurnInputId ?? null,
    artifactContexts: params.artifactContexts ?? null,
  });
  const relatedInfo = ensureMinimumSemanticOwnerRelatedInfo({
    relatedInfo: canonicalRelatedInfo,
    ownerEntityType: params.entity.entityType,
    ownerEntityId: params.entity.entityId,
    ownerLabel: params.entity.canonicalName,
  });
  const baseContent = stripDurableMemoryRelatedSections(params.candidate.content);
  const nextContent = relatedInfo.relatedEntities.length > 0 || relatedInfo.relations.length > 0
    ? appendDurableMemoryRelatedSections(baseContent, relatedInfo)
    : `${baseContent.trimEnd()}\n`;
  if (nextContent === params.candidate.content) {
    return params.candidate;
  }
  return {
    ...params.candidate,
    content: nextContent,
  };
}

function memoryTypeFromLeafBody(body: string): string {
  const match = body.match(/^- Type: `([^`]+)`$/m);
  return typeof match?.[1] === "string" ? match[1].trim() : "reference";
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

function splitSemanticSummaryIntoChunks(value: string): Array<{
  index: number;
  content: string;
}> {
  const normalized = compactWhitespace(value);
  if (normalized.length <= SEMANTIC_SUMMARY_CHUNK_TRIGGER_CHARS) {
    return [];
  }
  const chunks: Array<{ index: number; content: string }> = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + SEMANTIC_SUMMARY_CHUNK_MAX_CHARS);
    if (end < normalized.length) {
      let splitIndex = normalized.lastIndexOf(" ", end);
      if (splitIndex <= start + Math.floor(SEMANTIC_SUMMARY_CHUNK_MAX_CHARS * 0.6)) {
        splitIndex = normalized.indexOf(" ", end);
      }
      if (splitIndex > start) {
        end = splitIndex;
      }
    }
    const content = normalized.slice(start, end).trim();
    if (content) {
      chunks.push({
        index: chunks.length,
        content,
      });
    }
    if (end >= normalized.length) {
      break;
    }
    start = end;
    while (normalized[start] === " ") {
      start += 1;
    }
  }
  return chunks;
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
  if (hasClippedEllipsis(existing.node.summary)) {
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
  semanticCategoryCache?: Map<string, InteractionSemanticCategory>;
}): Map<string, ExistingInteractionSummaryNode> {
  const semanticCategory = readableInteractionSemanticCategory({
    store: params.store,
    workspaceId: params.workspaceId,
    treeId: params.entity.entityId,
    cache: params.semanticCategoryCache,
  });
  const docsByNodeId = new Map(
    params.store.listSemanticMemorySearchDocs({
      category: semanticCategory,
      workspaceId: params.workspaceId,
      treeId: params.entity.entityId,
      status: "active",
      limit: 10_000,
      offset: 0,
    }).map((doc) => [doc.nodeId, doc]),
  );
  const existing = new Map<string, ExistingInteractionSummaryNode>();
  for (const node of params.store.listSemanticMemoryNodes({
    category: semanticCategory,
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

function containsNonAsciiText(value: string): boolean {
  return /[^\x00-\x7F]/u.test(value);
}

function semanticCharacterTokens(value: string): string[] {
  return compactWhitespace(value).toLowerCase().match(/[\p{L}\p{N}]/gu) ?? [];
}

function nonAsciiBigramTokens(value: string): string[] {
  const chars = semanticCharacterTokens(value);
  if (chars.length < 2) {
    return [];
  }
  const tokens: string[] = [];
  for (let index = 0; index <= chars.length - 2; index += 1) {
    tokens.push(chars[index] + chars[index + 1]);
  }
  return [...new Set(tokens)];
}

function hasStructuredNonAsciiLabel(value: string, minChars: number, maxChars: number): boolean {
  const normalized = compactWhitespace(value);
  if (!normalized || !containsNonAsciiText(normalized)) {
    return false;
  }
  const semanticChars = semanticCharacterTokens(normalized).length;
  return semanticChars >= minChars && semanticChars <= maxChars;
}

function tokenize(value: string): string[] {
  const matches = value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu);
  return matches ?? [];
}

function normalizeKeyToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeNameKey(value: string): string {
  return tokenize(value).join(" ");
}

function titleWords(value: string): string[] {
  const matches = value.match(/[\p{L}\p{N}#._-]+/gu);
  return matches ?? [];
}

function uniqueTokens(value: string): string[] {
  return [...new Set(tokenize(value))];
}

function tokenJaccard(left: string, right: string): number {
  const leftTokens = uniqueTokens(left);
  const rightTokens = uniqueTokens(right);
  let tokenScore = 0;
  if (leftTokens.length > 0 && rightTokens.length > 0) {
    const rightSet = new Set(rightTokens);
    let shared = 0;
    for (const token of leftTokens) {
      if (rightSet.has(token)) {
        shared += 1;
      }
    }
    tokenScore = shared / Math.max(leftTokens.length, rightTokens.length);
  }

  if (!containsNonAsciiText(left) && !containsNonAsciiText(right)) {
    return tokenScore;
  }

  const leftBigrams = nonAsciiBigramTokens(left);
  const rightBigrams = nonAsciiBigramTokens(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return tokenScore;
  }
  const rightBigramSet = new Set(rightBigrams);
  let sharedBigrams = 0;
  for (const token of leftBigrams) {
    if (rightBigramSet.has(token)) {
      sharedBigrams += 1;
    }
  }
  const bigramScore = sharedBigrams / Math.max(leftBigrams.length, rightBigrams.length);
  return Math.max(tokenScore, bigramScore);
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
    case "reference":
      return "topic";
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

function isSpecificKnowledgeTopicTitle(title: string): boolean {
  const normalized = compactWhitespace(title);
  if (!normalized) {
    return false;
  }
  if (hasStructuredNonAsciiLabel(normalized, 4, 48)) {
    return true;
  }
  const tokenCount = tokenize(normalized).length;
  if (tokenCount < 4) {
    return false;
  }
  if (tokenCount > 18) {
    return false;
  }
  const uniqueTokenCount = uniqueTokens(normalized).length;
  return uniqueTokenCount >= 4;
}

function topicCanonicalNameFromCandidate(candidate: InteractionLeafCandidate): string | null {
  const title = compactWhitespace(candidate.title);
  if (!title || !isSpecificKnowledgeTopicTitle(title)) {
    return null;
  }
  return clipText(title, 96);
}

function preferenceCanonicalNameFromCandidate(candidate: InteractionLeafCandidate): string | null {
  const title = compactWhitespace(candidate.title);
  const summary = compactWhitespace(candidate.summary);
  const subjectKey = compactWhitespace(candidate.subjectKey);
  const combinedTokens = new Set(tokenize([title, summary, subjectKey, candidate.tags.join(" ")].join(" ")));
  const hasPreferenceSignal = [...combinedTokens].some((token) => PREFERENCE_SUBJECT_TOKENS.has(token));
  if (!hasPreferenceSignal) {
    return null;
  }
  if (title && (tokenize(title).length >= 2 || hasStructuredNonAsciiLabel(title, 4, 48))) {
    return clipText(title, 96);
  }
  if (summary && (tokenize(summary).length >= 4 || hasStructuredNonAsciiLabel(summary, 8, 120))) {
    return clipText(summary, 96);
  }
  if (subjectKey) {
    return clipText(subjectKey.replaceAll(/[_:]+/g, " "), 96);
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
    subjectTokens.push(token.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}._-]+$/gu, ""));
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
    agentRole: "memory-recall",
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
  const preferenceName = preferenceCanonicalNameFromCandidate(candidate);
  if (typeHint === "preference" || (!typeHint && preferenceName)) {
    return {
      entityType: "preference",
      canonicalName: clipText(preferenceName || candidate.title || candidate.subjectKey, 80),
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
  if (typeHint === "topic") {
    const topicName = topicCanonicalNameFromCandidate(candidate);
    if (topicName) {
      return {
        entityType: "topic",
        canonicalName: topicName,
        fallback: false,
      };
    }
  }
  if ((candidate.memoryType ?? "").trim().toLowerCase() === "procedure") {
    return {
      entityType: "workflow",
      canonicalName: clipText(candidate.title || candidate.subjectKey, 80),
      fallback: false,
    };
  }
  const fallbackTopicName = topicCanonicalNameFromCandidate(candidate);
  if (fallbackTopicName) {
    return {
      entityType: "topic",
      canonicalName: fallbackTopicName,
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

function reassignInteractionLeafRecord(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  leaf: InteractionLeafRecord;
  entity: InteractionEntityRecord;
  body: string;
  entityConfidence: number | null;
  secondaryEntityIds: string[];
}): InteractionLeafRecord {
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const nextPath = interactionLeafRelativePath(
    params.workspaceId,
    params.entity.slug,
    params.leaf.leafId,
  );
  if (nextPath !== params.leaf.path) {
    writeFileIfChanged(
      absolutePathForRelative(workspaceDir, nextPath),
      params.body,
    );
    if (fs.existsSync(absolutePathForRelative(workspaceDir, params.leaf.path))) {
      fs.rmSync(absolutePathForRelative(workspaceDir, params.leaf.path), {
        force: true,
      });
    }
  }
  const updatedLeaf = params.store.upsertInteractionLeaf({
    workspaceId: params.workspaceId,
    leafId: params.leaf.leafId,
    entityId: params.entity.entityId,
    subjectKey: params.leaf.subjectKey,
    path: nextPath,
    title: params.leaf.title,
    summary: params.leaf.summary,
    fingerprint: params.leaf.fingerprint,
    bodySha256: params.leaf.bodySha256,
    tags: params.leaf.tags,
    secondaryEntityIds: params.secondaryEntityIds,
    sourceType: params.leaf.sourceType,
    sourceEventId: params.leaf.sourceEventId,
    sourceMessageId: params.leaf.sourceMessageId,
    sourceTurnInputId: params.leaf.sourceTurnInputId,
    admissionConfidence: params.leaf.admissionConfidence,
    entityConfidence: params.entityConfidence,
    observedAt: params.leaf.observedAt,
    supersedesLeafId: params.leaf.supersedesLeafId,
    supersededAt: params.leaf.supersededAt,
    status: params.leaf.status,
    createdAt: params.leaf.createdAt,
  });
  for (const embedding of params.store.listInteractionNodeEmbeddings({
    workspaceId: params.workspaceId,
    nodeIds: [params.leaf.leafId],
  })) {
    params.store.upsertInteractionNodeEmbedding({
      workspaceId: params.workspaceId,
      nodeKind: embedding.nodeKind,
      nodeId: embedding.nodeId,
      entityId: params.entity.entityId,
      embeddingModel: embedding.embeddingModel,
      contentFingerprint: embedding.contentFingerprint,
      dimensions: embedding.dimensions,
      vector: embedding.vector,
      createdAt: embedding.createdAt,
    });
  }
  return updatedLeaf;
}

async function refreshInteractionLeafRecordFromCandidate(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  leaf: InteractionLeafRecord;
  entity: InteractionEntityRecord;
  candidate: InteractionLeafCandidate;
  entityConfidence: number | null;
  secondaryEntityIds: string[];
  embeddingClient: MemoryModelClientConfig | null;
}): Promise<InteractionLeafRecord> {
  const resolver = createWorkspaceRelatedEntityResolverFromStore({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const candidate = normalizeInteractionLeafCandidateForEntity({
    candidate: params.candidate,
    entity: params.entity,
    resolver,
    sourceTurnInputId: params.candidate.sourceTurnInputId ?? params.leaf.sourceTurnInputId ?? null,
    artifactContexts: interactionLeafArtifactContextsFromSourceTurn({
      store: params.store,
      workspaceId: params.workspaceId,
      leaf: params.leaf,
    }),
  });
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const nextPath = interactionLeafRelativePath(
    params.workspaceId,
    params.entity.slug,
    params.leaf.leafId,
  );
  writeFileIfChanged(
    absolutePathForRelative(workspaceDir, nextPath),
    candidate.content,
  );
  if (nextPath !== params.leaf.path && fs.existsSync(absolutePathForRelative(workspaceDir, params.leaf.path))) {
    fs.rmSync(absolutePathForRelative(workspaceDir, params.leaf.path), { force: true });
  }
  const fingerprint = sha256(candidate.content);
  const updatedLeaf = params.store.upsertInteractionLeaf({
    workspaceId: params.workspaceId,
    leafId: params.leaf.leafId,
    entityId: params.entity.entityId,
    subjectKey: candidate.subjectKey,
    path: nextPath,
    title: candidate.title,
    summary: candidate.summary,
    fingerprint,
    bodySha256: sha256(candidate.content),
    tags: candidate.tags,
    secondaryEntityIds: params.secondaryEntityIds,
    sourceType: candidate.sourceType ?? params.leaf.sourceType,
    sourceEventId: candidate.sourceEventId ?? params.leaf.sourceEventId,
    sourceMessageId: candidate.sourceMessageId ?? params.leaf.sourceMessageId,
    sourceTurnInputId: candidate.sourceTurnInputId ?? params.leaf.sourceTurnInputId,
    admissionConfidence: candidate.confidence ?? params.leaf.admissionConfidence,
    entityConfidence: params.entityConfidence,
    observedAt: candidate.observedAt ?? params.leaf.observedAt,
    supersedesLeafId: params.leaf.supersedesLeafId,
    supersededAt: params.leaf.supersededAt,
    status: params.leaf.status,
    createdAt: params.leaf.createdAt,
  });
  await syncNodeEmbedding({
    store: params.store,
    workspaceId: params.workspaceId,
    entity: params.entity,
    nodeKind: "leaf",
    nodeId: updatedLeaf.leafId,
    title: updatedLeaf.title,
    summary: updatedLeaf.summary,
    body: candidate.content,
    embeddingClient: params.embeddingClient,
  });
  return updatedLeaf;
}

function shouldRefreshInteractionLeafFromCandidate(params: {
  leaf: InteractionLeafRecord;
  existingBody: string;
  candidate: InteractionLeafCandidate;
}): boolean {
  const existingRelatedInfo = parseDurableMemoryRelatedInfo(params.existingBody);
  const candidateRelatedInfo = parseDurableMemoryRelatedInfo(params.candidate.content);
  const mergedRelatedInfo = mergeDurableMemoryRelatedInfo(existingRelatedInfo, candidateRelatedInfo);
  const addsRelations = mergedRelatedInfo.relatedEntities.length > existingRelatedInfo.relatedEntities.length
    || mergedRelatedInfo.relations.length > existingRelatedInfo.relations.length;
  if (addsRelations) {
    return true;
  }
  const candidateSpecificity = specificityScoreForInteractionLeafCandidate(params.candidate);
  const recordSpecificity = specificityScoreForInteractionLeafRecord(params.leaf);
  if (candidateSpecificity > recordSpecificity) {
    return true;
  }
  return params.candidate.title !== params.leaf.title
    || params.candidate.summary !== params.leaf.summary
    || params.candidate.subjectKey !== params.leaf.subjectKey
    || params.candidate.tags.join("|") !== params.leaf.tags.join("|");
}

function mergedInteractionLeafCandidate(params: {
  leaf: InteractionLeafRecord;
  existingBody: string;
  candidate: InteractionLeafCandidate;
}): InteractionLeafCandidate {
  const existingRelatedInfo = parseDurableMemoryRelatedInfo(params.existingBody);
  const candidateRelatedInfo = parseDurableMemoryRelatedInfo(params.candidate.content);
  const mergedRelatedInfo = mergeDurableMemoryRelatedInfo(existingRelatedInfo, candidateRelatedInfo);
  const candidateSpecificity = specificityScoreForInteractionLeafCandidate(params.candidate);
  const recordSpecificity = specificityScoreForInteractionLeafRecord(params.leaf);
  const candidatePreferred = candidateSpecificity >= recordSpecificity;
  const baseBody = candidatePreferred ? params.candidate.content : params.existingBody;
  const baseWithoutRelations = stripDurableMemoryRelatedSections(baseBody);
  return {
    subjectKey: candidatePreferred ? params.candidate.subjectKey : params.leaf.subjectKey,
    title: candidatePreferred ? params.candidate.title : params.leaf.title,
    summary: candidatePreferred ? params.candidate.summary : params.leaf.summary,
    content: mergedRelatedInfo.relatedEntities.length > 0 || mergedRelatedInfo.relations.length > 0
      ? appendDurableMemoryRelatedSections(baseWithoutRelations, mergedRelatedInfo)
      : baseWithoutRelations.trimEnd() + "\n",
    tags: [...new Set([...params.leaf.tags, ...params.candidate.tags])],
    memoryType: params.candidate.memoryType ?? memoryTypeFromLeafBody(params.existingBody),
    sourceType: params.candidate.sourceType ?? params.leaf.sourceType,
    sourceEventId: params.candidate.sourceEventId ?? params.leaf.sourceEventId,
    sourceMessageId: params.candidate.sourceMessageId ?? params.leaf.sourceMessageId,
    sourceTurnInputId: params.candidate.sourceTurnInputId ?? params.leaf.sourceTurnInputId,
    observedAt: params.candidate.observedAt ?? params.leaf.observedAt,
    confidence: params.candidate.confidence ?? params.leaf.admissionConfidence,
  };
}

async function enrichInteractionLeafRelatedInfo(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entity: InteractionEntityRecord;
  leaf: InteractionLeafRecord;
  body: string;
  modelClient: MemoryModelClientConfig | null;
  embeddingClient: MemoryModelClientConfig | null;
  forceModel?: boolean;
}): Promise<{ leaf: InteractionLeafRecord; body: string; changed: boolean }> {
  if (!params.forceModel && hasDurableMemoryRelatedProcessedMarker(params.body)) {
    return {
      leaf: params.leaf,
      body: params.body,
      changed: false,
    };
  }
  const resolver = createWorkspaceRelatedEntityResolverFromStore({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const artifactContexts = interactionLeafArtifactContextsFromSourceTurn({
    store: params.store,
    workspaceId: params.workspaceId,
    leaf: params.leaf,
  });
  const existingRelatedInfo = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: parseDurableMemoryRelatedInfo(params.body),
    resolver,
    sourceTurnInputId: params.leaf.sourceTurnInputId ?? null,
    artifactContexts,
  });
  const minimumExistingRelatedInfo = ensureMinimumSemanticOwnerRelatedInfo({
    relatedInfo: existingRelatedInfo,
    ownerEntityType: params.entity.entityType,
    ownerEntityId: params.entity.entityId,
    ownerLabel: params.entity.canonicalName,
  });
  if (!params.forceModel && (minimumExistingRelatedInfo.relatedEntities.length > 0 || minimumExistingRelatedInfo.relations.length > 0)) {
    const nextBody = appendDurableMemoryRelatedSections(
      stripDurableMemoryRelatedSections(params.body),
      minimumExistingRelatedInfo,
    );
    if (nextBody === params.body) {
      return {
        leaf: params.leaf,
        body: params.body,
        changed: false,
      };
    }
    const refreshed = await refreshInteractionLeafRecordFromCandidate({
      store: params.store,
      workspaceId: params.workspaceId,
      leaf: params.leaf,
      entity: params.entity,
      candidate: {
        subjectKey: params.leaf.subjectKey,
        title: params.leaf.title,
        summary: params.leaf.summary,
        content: nextBody,
        tags: params.leaf.tags,
        memoryType: memoryTypeFromLeafBody(params.body),
        sourceType: params.leaf.sourceType,
        sourceEventId: params.leaf.sourceEventId,
        sourceMessageId: params.leaf.sourceMessageId,
        sourceTurnInputId: params.leaf.sourceTurnInputId,
        observedAt: params.leaf.observedAt,
        confidence: params.leaf.admissionConfidence,
      },
      entityConfidence: params.leaf.entityConfidence,
      secondaryEntityIds: params.leaf.secondaryEntityIds,
      embeddingClient: params.embeddingClient,
    });
    return {
      leaf: refreshed,
      body: nextBody,
      changed: true,
    };
  }
  const extractedRelatedInfo = await extractDurableMemoryRelatedInfo({
    modelClient: params.modelClient,
    memoryType: memoryTypeFromLeafBody(params.body),
    subjectKey: params.leaf.subjectKey,
    title: params.leaf.title,
    summary: params.leaf.summary,
    content: stripDurableMemoryRelatedSections(params.body),
    tags: params.leaf.tags,
    artifactContexts,
    resolver,
    sourceTurnInputId: params.leaf.sourceTurnInputId ?? null,
  });
  const cleanedBody = stripDurableMemoryRelatedSections(params.body);
  const mergedRelatedInfo = mergeArtifactDerivedRelations({
    relatedInfo: mergeDurableMemoryRelatedInfo(existingRelatedInfo, extractedRelatedInfo),
    artifactContexts,
  });
  const minimumExtractedRelatedInfo = ensureMinimumSemanticOwnerRelatedInfo({
    relatedInfo: mergedRelatedInfo,
    ownerEntityType: params.entity.entityType,
    ownerEntityId: params.entity.entityId,
    ownerLabel: params.entity.canonicalName,
  });
  const nextBody = minimumExtractedRelatedInfo.relatedEntities.length > 0 || minimumExtractedRelatedInfo.relations.length > 0
    ? appendDurableMemoryRelatedSections(
      cleanedBody,
      minimumExtractedRelatedInfo,
    )
    : markDurableMemoryRelatedProcessed(cleanedBody);
  if (nextBody === params.body) {
    return {
      leaf: params.leaf,
      body: params.body,
      changed: false,
    };
  }
  const refreshed = await refreshInteractionLeafRecordFromCandidate({
    store: params.store,
    workspaceId: params.workspaceId,
    leaf: params.leaf,
    entity: params.entity,
    candidate: {
      subjectKey: params.leaf.subjectKey,
      title: params.leaf.title,
      summary: params.leaf.summary,
      content: nextBody,
      tags: params.leaf.tags,
      memoryType: memoryTypeFromLeafBody(params.body),
      sourceType: params.leaf.sourceType,
      sourceEventId: params.leaf.sourceEventId,
      sourceMessageId: params.leaf.sourceMessageId,
      sourceTurnInputId: params.leaf.sourceTurnInputId,
      observedAt: params.leaf.observedAt,
      confidence: params.leaf.admissionConfidence,
    },
    entityConfidence: params.leaf.entityConfidence,
    secondaryEntityIds: params.leaf.secondaryEntityIds,
    embeddingClient: params.embeddingClient,
  });
  return {
    leaf: refreshed,
    body: nextBody,
    changed: true,
  };
}

async function reclassifyUncategorizedInteractionLeaves(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  summaryModelClient: MemoryModelClientConfig | null;
}): Promise<Set<string>> {
  const movedEntityIds = new Set<string>();
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const uncategorizedLeaves = params.store.listInteractionLeaves({
    workspaceId: params.workspaceId,
    entityId: INTERACTION_UNCATEGORIZED_ENTITY_ID,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  for (const leaf of uncategorizedLeaves) {
    const body =
      readFileIfExists(absolutePathForRelative(workspaceDir, leaf.path)) ??
      interactionFallbackLeafBody(leaf);
    const assignment = await assignEntityWithModel({
      store: params.store,
      workspaceId: params.workspaceId,
      candidate: {
        subjectKey: leaf.subjectKey,
        title: leaf.title,
        summary: leaf.summary,
        content: body,
        tags: leaf.tags,
        confidence: leaf.admissionConfidence,
      },
      modelClient: params.summaryModelClient,
    });
    if (assignment.entity.entityId === INTERACTION_UNCATEGORIZED_ENTITY_ID) {
      continue;
    }
    reassignInteractionLeafRecord({
      store: params.store,
      workspaceId: params.workspaceId,
      leaf,
      entity: assignment.entity,
      body,
      entityConfidence: assignment.confidence,
      secondaryEntityIds: assignment.secondaryEntityIds,
    });
    movedEntityIds.add(assignment.entity.entityId);
  }
  return movedEntityIds;
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
      '{"action":"match_existing|create_new|fallback","existing_entity_id":"string|null","new_entity_type":"project|workflow|preference|identity|person|customer|system|topic|null","new_entity_name":"string|null","secondary_entity_ids":["string"],"confidence":0.0,"rationale":"string"}',
      "Choose the owner tree based on the stable primary subject the memory is about.",
      "A memory being a procedure, contact, threshold, channel, dashboard, or owner fact does not by itself imply workflow ownership.",
      "Use workflow ownership only when the workflow or runbook itself is the enduring named subject, rather than some larger customer, project, or system.",
      "Use topic for durable knowledge clusters or named reference topics that are not best modeled as one specific system, project, person, or customer.",
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
    agentRole: "memory-recall",
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
    newEntityType !== "misc" &&
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
    `- Category: workspace`,
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
  return compactWhitespace(
    `${params.entity.canonicalName} memory slice covering ${params.childCount} nodes: ${params.childTitles.slice(0, 4).join(", ")}`,
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
    agentRole: "memory-recall",
  });

  const summary = typeof payload?.summary === "string" ? compactWhitespace(payload.summary) : "";
  return summary || fallback;
}

function semanticInteractionSummaryChunkBody(params: {
  entity: InteractionEntityRecord;
  parentNodeId: string;
  parentNodeKind: "tree" | "partition";
  parentTitle: string;
  chunkIndex: number;
  chunkCount: number;
  content: string;
}): string {
  return [
    `# ${params.parentTitle} summary chunk ${params.chunkIndex + 1}`,
    "",
    "- Category: workspace",
    `- Entity: \`${params.entity.entityId}\``,
    `- Entity name: ${params.entity.canonicalName}`,
    `- Entity type: ${params.entity.entityType}`,
    `- Parent node: \`${params.parentNodeId}\``,
    `- Parent node kind: ${params.parentNodeKind}`,
    `- Chunk index: ${params.chunkIndex + 1}`,
    `- Chunk count: ${params.chunkCount}`,
    "",
    "## Summary",
    "",
    params.content,
    "",
  ].join("\n");
}

function appendSemanticSummaryChunks(params: {
  entity: InteractionEntityRecord;
  parentNode: SemanticInteractionDraftNode;
  nodes: SemanticInteractionDraftNode[];
  edges: Array<{
    parentNodeId: string;
    childNodeId: string;
    position: number;
  }>;
  bodiesByPath: Map<string, string>;
}): void {
  if (params.parentNode.nodeClass !== "semantic") {
    return;
  }
  if (params.parentNode.nodeKind !== "tree" && params.parentNode.nodeKind !== "partition") {
    return;
  }
  const chunks = splitSemanticSummaryIntoChunks(params.parentNode.summary);
  if (chunks.length === 0) {
    return;
  }
  const basePosition = params.parentNode.childCount;
  for (const chunk of chunks) {
    const nodeId = semanticInteractionSummaryChunkNodeId(params.parentNode.nodeId, chunk.index);
    const chunkPath = semanticInteractionSummaryChunkRelativePath(params.parentNode.path, chunk.index);
    const body = semanticInteractionSummaryChunkBody({
      entity: params.entity,
      parentNodeId: params.parentNode.nodeId,
      parentNodeKind: params.parentNode.nodeKind,
      parentTitle: params.parentNode.title,
      chunkIndex: chunk.index,
      chunkCount: chunks.length,
      content: chunk.content,
    });
    params.nodes.push({
      nodeId,
      nodeClass: "leaf",
      nodeKind: SEMANTIC_SUMMARY_CHUNK_NODE_KIND,
      sourceLeafId: null,
      path: chunkPath,
      title: `${params.parentNode.title} summary chunk ${chunk.index + 1}`,
      summary: chunk.content,
      bodySha256: sha256(body),
      childCount: 0,
      observedAt: params.parentNode.observedAt,
      isMaterialized: false,
      metadata: {
        parent_node_id: params.parentNode.nodeId,
        parent_node_kind: params.parentNode.nodeKind,
        chunk_index: chunk.index + 1,
        chunk_count: chunks.length,
      },
    });
    params.edges.push({
      parentNodeId: params.parentNode.nodeId,
      childNodeId: nodeId,
      position: basePosition + chunk.index + 1,
    });
    params.bodiesByPath.set(chunkPath, body);
  }
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
  const rootPath = semanticInteractionTreeRelativePath(params.entity.entityType, params.entity.slug);
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
    const leafBody = params.leafBodies.get(leaf.leafId) ?? interactionFallbackLeafBody(leaf);
    const relatedInfo = parseDurableMemoryRelatedInfo(leafBody);
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
        related_entity_keys: relatedInfo.relatedEntities.map((entity) => entity.entityKey),
        relation_types: [...new Set(relatedInfo.relations.map((relation) => relation.relationType))],
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
      appendSemanticSummaryChunks({
        entity: params.entity,
        parentNode: partition.node,
        nodes,
        edges,
        bodiesByPath,
      });
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
  const rootNode: SemanticInteractionDraftNode = {
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
  };
  appendSemanticSummaryChunks({
    entity: params.entity,
    parentNode: rootNode,
    nodes,
    edges,
    bodiesByPath,
  });
  nodes.push(rootNode);
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

function semanticEvidenceRefsForInteractionTree(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entity: InteractionEntityRecord;
  semantic: Awaited<ReturnType<typeof buildSemanticInteractionTree>>;
  leaves: InteractionLeafRecord[];
}): SemanticInteractionEvidenceRef[] {
  const leafById = new Map(
    params.leaves.map((leaf) => [leaf.leafId, leaf] as const),
  );
  const integrationEvidenceByTurnInputId = new Map<string, ReturnType<typeof integrationToolEvidenceEntriesFromTurnArtifacts>>();
  const refs: SemanticInteractionEvidenceRef[] = [];

  for (const node of params.semantic.nodes) {
    if (!node.sourceLeafId) {
      continue;
    }
    const leaf = leafById.get(node.sourceLeafId);
    if (!leaf) {
      continue;
    }

    refs.push({
      workspaceId: params.workspaceId,
      category: ACTIVE_WORKSPACE_INTERACTION_CATEGORY,
      treeId: params.entity.entityId,
      nodeId: node.nodeId,
      refId: leaf.leafId,
      provider: null,
      accountNamespace: null,
      connectionId: null,
      externalObjectId: null,
      externalObjectType: null,
      sourceType: leaf.sourceType ?? null,
      sourceEventId: leaf.sourceEventId ?? null,
      sourceMessageId: leaf.sourceMessageId ?? null,
      sourceTurnInputId: leaf.sourceTurnInputId ?? null,
      observedAt: leaf.observedAt ?? node.observedAt ?? null,
      metadata: {
        evidence_kind: "interaction_leaf",
        path: leaf.path,
        title: leaf.title,
        subject_key: leaf.subjectKey,
        fingerprint: leaf.fingerprint,
        body_sha256: leaf.bodySha256,
        tags: leaf.tags,
        secondary_entity_ids: leaf.secondaryEntityIds,
        entity_id: params.entity.entityId,
        entity_type: params.entity.entityType,
      },
      createdAt: leaf.createdAt,
      updatedAt: leaf.updatedAt,
    });

    const sourceTurnInputId = leaf.sourceTurnInputId?.trim() ?? "";
    if (!sourceTurnInputId) {
      continue;
    }
    let integrationEvidence = integrationEvidenceByTurnInputId.get(sourceTurnInputId);
    if (!integrationEvidence) {
      const turnResult = params.store.getTurnResult({
        workspaceId: params.workspaceId,
        inputId: sourceTurnInputId,
      });
      integrationEvidence = turnResult
        ? integrationToolEvidenceEntriesFromTurnArtifacts(params.store, turnResult)
        : [];
      integrationEvidenceByTurnInputId.set(sourceTurnInputId, integrationEvidence);
    }
    for (const entry of integrationEvidence) {
      refs.push({
        workspaceId: params.workspaceId,
        category: ACTIVE_WORKSPACE_INTERACTION_CATEGORY,
        treeId: params.entity.entityId,
        nodeId: node.nodeId,
        refId: `${leaf.leafId}:integration:${entry.callId ?? `event-${entry.outputEventId}`}`,
        provider: entry.providerId,
        accountNamespace: entry.accountNamespace,
        connectionId: entry.connectionId,
        externalObjectId: null,
        externalObjectType: null,
        sourceType: "tool_call",
        sourceEventId: entry.callId ?? `output-event:${entry.outputEventId}`,
        sourceMessageId: leaf.sourceMessageId ?? null,
        sourceTurnInputId,
        observedAt: entry.observedAt,
        metadata: {
          evidence_kind: "integration_tool_call",
          path: leaf.path,
          title: leaf.title,
          subject_key: leaf.subjectKey,
          tool_name: entry.toolName,
          tool_id: entry.toolId,
          result_summary: entry.resultSummary,
          output_event_id: entry.outputEventId,
          entity_id: params.entity.entityId,
          entity_type: params.entity.entityType,
        },
        createdAt: leaf.createdAt,
        updatedAt: entry.observedAt,
      });
    }
  }

  return refs;
}

function interactionEntityTypeForRelatedEntityType(
  entityType: DurableMemoryRelatedEntityType,
): InteractionEntityType | null {
  switch (entityType) {
    case "person":
    case "customer":
    case "system":
    case "project":
    case "workflow":
    case "topic":
      return entityType;
    case "issue":
      return "topic";
    default:
      return null;
  }
}

type ArtifactSemanticTarget = {
  sourceTurnInputId: string | null;
  entityKey: string;
  label: string;
  treeId: string;
  nodeId: string;
  sourceKind: DurableMemoryArtifactContext["sourceKind"];
  provider: string | null;
  accountNamespace: string | null;
};

function workspaceArtifactSemanticTargets(params: {
  store: RuntimeStateStore;
  workspaceId: string;
}): ArtifactSemanticTarget[] {
  const targets: ArtifactSemanticTarget[] = [];
  for (const attachment of listWorkspaceAttachmentDocumentTrees(params)) {
    targets.push({
      sourceTurnInputId: attachment.sourceTurnInputId,
      entityKey: canonicalAttachmentArtifactEntityKey(attachment.attachmentId),
      label: attachment.title,
      treeId: attachment.treeId,
      nodeId: attachment.rootNodeId,
      sourceKind: "attachment",
      provider: null,
      accountNamespace: null,
    });
  }
  for (const imageUrlArtifact of listWorkspaceImageUrlDocumentTrees(params)) {
    targets.push({
      sourceTurnInputId: imageUrlArtifact.sourceTurnInputId,
      entityKey: canonicalImageUrlArtifactEntityKey(imageUrlArtifact.imageUrl),
      label: imageUrlArtifact.title,
      treeId: imageUrlArtifact.treeId,
      nodeId: imageUrlArtifact.rootNodeId,
      sourceKind: "image_url",
      provider: null,
      accountNamespace: null,
    });
  }
  for (const outputArtifact of listWorkspaceOutputDocumentTrees(params)) {
    targets.push({
      sourceTurnInputId: outputArtifact.sourceTurnInputId,
      entityKey: canonicalOutputArtifactEntityKey(outputArtifact.outputId),
      label: outputArtifact.title,
      treeId: outputArtifact.treeId,
      nodeId: outputArtifact.rootNodeId,
      sourceKind: "output_artifact",
      provider: null,
      accountNamespace: null,
    });
  }
  for (const toolResult of listWorkspaceToolResultDocumentTrees(params)) {
    targets.push({
      sourceTurnInputId: toolResult.sourceTurnInputId,
      entityKey: canonicalToolResultArtifactEntityKey({
        providerId: toolResult.providerId,
        callId: toolResult.callId,
        outputEventId: toolResult.outputEventId,
        treeId: toolResult.treeId,
      }),
      label: toolResult.title,
      treeId: toolResult.treeId,
      nodeId: toolResult.rootNodeId,
      sourceKind: "tool_result",
      provider: toolResult.providerId,
      accountNamespace: toolResult.accountNamespace,
    });
  }
  return targets;
}

function resolvedSemanticTargetForRelatedEntity(params: {
  currentEntityId: string;
  relatedEntity: DurableMemoryRelatedEntity;
  resolver: ReturnType<typeof createWorkspaceRelatedEntityResolverFromStore>;
}): {
  entityKey: string;
  entityLabel: string;
  entityType: DurableMemoryRelatedEntityType;
  nodeId: string;
  targetTreeId: string | null;
  targetNodeId: string | null;
  resolvedTargetKind: "resolved" | "synthetic";
} | null {
  const resolved = params.resolver.resolve({
    entityType: params.relatedEntity.entityType,
    entityKey: params.relatedEntity.entityKey,
    label: params.relatedEntity.label,
  });
  if (resolved) {
    if (resolved.targetTreeId === params.currentEntityId && resolved.targetNodeId) {
      return {
        entityKey: resolved.entityKey,
        entityLabel: resolved.label,
        entityType: resolved.entityType,
        nodeId: semanticInteractionRootNodeId(params.currentEntityId),
        targetTreeId: params.currentEntityId,
        targetNodeId: semanticInteractionRootNodeId(params.currentEntityId),
        resolvedTargetKind: "resolved",
      };
    }
    if (resolved.targetTreeId && resolved.targetNodeId) {
      return {
        entityKey: resolved.entityKey,
        entityLabel: resolved.label,
        entityType: resolved.entityType,
        nodeId: resolved.targetNodeId,
        targetTreeId: resolved.targetTreeId,
        targetNodeId: resolved.targetNodeId,
        resolvedTargetKind: "resolved",
      };
    }
    return {
      entityKey: resolved.entityKey,
      entityLabel: resolved.label,
      entityType: resolved.entityType,
      nodeId: semanticRelatedEntityNodeId(resolved.entityKey),
      targetTreeId: null,
      targetNodeId: null,
      resolvedTargetKind: "synthetic",
    };
  }
  return {
    entityKey: params.relatedEntity.entityKey,
    entityLabel: params.relatedEntity.label,
    entityType: params.relatedEntity.entityType,
    nodeId: semanticRelatedEntityNodeId(params.relatedEntity.entityKey),
    targetTreeId: null,
    targetNodeId: null,
    resolvedTargetKind: "synthetic",
  };
}

function semanticRelationsForInteractionTree(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entity: InteractionEntityRecord;
  semantic: Awaited<ReturnType<typeof buildSemanticInteractionTree>>;
  leaves: InteractionLeafRecord[];
  leafBodies: Map<string, string>;
}): SemanticInteractionRelation[] {
  const leafById = new Map(params.leaves.map((leaf) => [leaf.leafId, leaf] as const));
  const relationsByKey = new Map<string, SemanticInteractionRelation>();
  const artifactTargets = workspaceArtifactSemanticTargets({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const resolver = createWorkspaceRelatedEntityResolverFromStore({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const artifactTargetsByTurnInputId = new Map<string, ArtifactSemanticTarget[]>();
  for (const target of artifactTargets) {
    if (!target.sourceTurnInputId) {
      continue;
    }
    const existing = artifactTargetsByTurnInputId.get(target.sourceTurnInputId);
    if (existing) {
      existing.push(target);
    } else {
      artifactTargetsByTurnInputId.set(target.sourceTurnInputId, [target]);
    }
  }
  for (const node of params.semantic.nodes) {
    if (!node.sourceLeafId) {
      continue;
    }
    const leaf = leafById.get(node.sourceLeafId);
    if (!leaf) {
      continue;
    }
    const leafBody = params.leafBodies.get(leaf.leafId) ?? interactionFallbackLeafBody(leaf);
    const sourceArtifacts = leaf.sourceTurnInputId
      ? artifactTargetsByTurnInputId.get(leaf.sourceTurnInputId) ?? []
      : [];
    const relatedInfo = canonicalizeDurableMemoryRelatedInfo({
      relatedInfo: parseDurableMemoryRelatedInfo(leafBody),
      resolver,
      sourceTurnInputId: leaf.sourceTurnInputId ?? null,
      artifactContexts: sourceArtifacts.map((artifactTarget) => ({
        sourceKind: artifactTarget.sourceKind,
        treeId: artifactTarget.treeId,
        title: artifactTarget.label,
        provider: artifactTarget.provider,
        accountNamespace: artifactTarget.accountNamespace,
        canonicalEntityKey: artifactTarget.entityKey,
        excerpts: [],
      })),
    });
    const entityByKey = new Map(
      relatedInfo.relatedEntities.map((entity) => [entity.entityKey, entity] as const),
    );
    for (const relation of relatedInfo.relations) {
      const relatedEntity = entityByKey.get(relation.entityKey);
      if (!relatedEntity) {
        continue;
      }
      const target = resolvedSemanticTargetForRelatedEntity({
        currentEntityId: params.entity.entityId,
        relatedEntity,
        resolver,
      });
      if (!target) {
        continue;
      }
      const relationKey = `${node.nodeId}|${target.nodeId}|${relation.relationType}`;
      if (!relationsByKey.has(relationKey)) {
        relationsByKey.set(relationKey, {
          workspaceId: params.workspaceId,
          category: ACTIVE_WORKSPACE_INTERACTION_CATEGORY,
          treeId: params.entity.entityId,
          fromNodeId: node.nodeId,
          toNodeId: target.nodeId,
          relationType: relation.relationType,
          metadata: {
            entity_key: relatedEntity.entityKey,
            entity_label: relatedEntity.label,
            entity_type: relatedEntity.entityType,
            target_tree_id: target.targetTreeId,
            target_node_id: target.targetNodeId,
            resolved_target_kind: target.resolvedTargetKind,
          },
          createdAt: leaf.createdAt,
          updatedAt: leaf.updatedAt,
        });
      }
    }
    for (const artifactTarget of sourceArtifacts) {
      const relationKey = `${node.nodeId}|${artifactTarget.nodeId}|derived_from`;
      if (!relationsByKey.has(relationKey)) {
        relationsByKey.set(relationKey, {
          workspaceId: params.workspaceId,
          category: ACTIVE_WORKSPACE_INTERACTION_CATEGORY,
          treeId: params.entity.entityId,
          fromNodeId: node.nodeId,
          toNodeId: artifactTarget.nodeId,
          relationType: "derived_from",
          metadata: {
            entity_key: artifactTarget.entityKey,
            entity_label: artifactTarget.label,
            entity_type: "artifact",
            target_tree_id: artifactTarget.treeId,
            target_node_id: artifactTarget.nodeId,
            resolved_target_kind: "resolved",
            source_turn_input_id: leaf.sourceTurnInputId,
          },
          createdAt: leaf.createdAt,
          updatedAt: leaf.updatedAt,
        });
      }
    }
  }
  return [...relationsByKey.values()].sort((left, right) =>
    left.relationType.localeCompare(right.relationType)
    || left.fromNodeId.localeCompare(right.fromNodeId)
    || left.toNodeId.localeCompare(right.toNodeId)
  );
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
    purpose: "document",
    input: embeddingText,
    timeoutMs: 7000,
    agentRole: "memory-embedding",
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
  const resolver = createWorkspaceRelatedEntityResolverFromStore({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  const candidate = normalizeInteractionLeafCandidateForEntity({
    candidate: params.candidate,
    entity,
    resolver,
    sourceTurnInputId: params.candidate.sourceTurnInputId ?? null,
    artifactContexts: (params.candidate.sourceTurnInputId?.trim() ?? "")
      ? artifactContextsForSourceTurnInput({
        store: params.store,
        workspaceId: params.workspaceId,
        sourceTurnInputId: params.candidate.sourceTurnInputId!.trim(),
        maxDocumentsPerKind: 6,
        maxChunksPerDocument: 4,
        maxCharsPerChunk: 1_600,
      })
      : [],
  });
  const contentFingerprint = sha256(candidate.content);
  const existingDuplicate = params.store.getInteractionLeafByFingerprint({
    workspaceId: params.workspaceId,
    entityId: entity.entityId,
    fingerprint: contentFingerprint,
  });
  if (existingDuplicate) {
    const existingBody =
      readFileIfExists(absolutePathForRelative(params.store.workspaceDir(params.workspaceId), existingDuplicate.path))
      ?? interactionFallbackLeafBody(existingDuplicate);
    if (shouldRefreshInteractionLeafFromCandidate({
      leaf: existingDuplicate,
      existingBody,
      candidate,
    })) {
      const mergedCandidate = mergedInteractionLeafCandidate({
        leaf: existingDuplicate,
        existingBody,
        candidate,
      });
      const refreshedLeaf = await refreshInteractionLeafRecordFromCandidate({
        store: params.store,
        workspaceId: params.workspaceId,
        leaf: existingDuplicate,
        entity,
        candidate: mergedCandidate,
        entityConfidence: entityAssignment.confidence,
        secondaryEntityIds: [...new Set([...existingDuplicate.secondaryEntityIds, ...entityAssignment.secondaryEntityIds])],
        embeddingClient: params.embeddingClient ?? null,
      });
      return {
        outcome: "noop_duplicate",
        entity,
        leaf: refreshedLeaf,
        changed: true,
      };
    }
    return {
      outcome: "noop_duplicate",
      entity,
      leaf: existingDuplicate,
      changed: false,
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
    candidate,
    leaves: activeLeaves,
  });
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const semanticDecision = await semanticDuplicateDecision({
    workspaceId: params.workspaceId,
    candidate,
    shortlist: semanticShortlist,
    modelClient: params.modelClient ?? null,
    workspaceDir,
  });
  const semanticMatch = semanticDecision.leafId
    ? semanticShortlist.find((entry) => entry.leaf.leafId === semanticDecision.leafId)?.leaf ?? null
    : null;
  if (semanticDecision.action === "same_memory" && semanticMatch) {
    const existingBody =
      readFileIfExists(absolutePathForRelative(workspaceDir, semanticMatch.path))
      ?? interactionFallbackLeafBody(semanticMatch);
    if (shouldRefreshInteractionLeafFromCandidate({
      leaf: semanticMatch,
      existingBody,
      candidate,
    })) {
      const mergedCandidate = mergedInteractionLeafCandidate({
        leaf: semanticMatch,
        existingBody,
        candidate,
      });
      const refreshedLeaf = await refreshInteractionLeafRecordFromCandidate({
        store: params.store,
        workspaceId: params.workspaceId,
        leaf: semanticMatch,
        entity,
        candidate: mergedCandidate,
        entityConfidence: entityAssignment.confidence,
        secondaryEntityIds: [...new Set([...semanticMatch.secondaryEntityIds, ...entityAssignment.secondaryEntityIds])],
        embeddingClient: params.embeddingClient ?? null,
      });
      return {
        outcome: "noop_duplicate",
        entity,
        leaf: refreshedLeaf,
        changed: true,
      };
    }
    return {
      outcome: "noop_duplicate",
      entity,
      leaf: semanticMatch,
      changed: false,
    };
  }

  const leafId = `leaf-${sha256(`${params.workspaceId}|${entity.entityId}|${candidate.subjectKey}|${contentFingerprint}`).slice(0, 24)}`;
  const relativePath = interactionLeafRelativePath(params.workspaceId, entity.slug, leafId);
  const existingActive = activeLeaves.find((leaf) => leaf.subjectKey === candidate.subjectKey) ?? null;
  const leafToSupersede =
    semanticDecision.action === "supersedes_existing" && semanticMatch
      ? semanticMatch
      : existingActive;
  const absolutePath = absolutePathForRelative(workspaceDir, relativePath);
  writeFileIfChanged(absolutePath, candidate.content);

  let outcome: PersistedInteractionLeafResult["outcome"] = "created";
  if (leafToSupersede && leafToSupersede.fingerprint !== contentFingerprint) {
    const newSpecificity = specificityScoreForInteractionLeafCandidate(candidate);
    const supersededSpecificity = specificityScoreForInteractionLeafRecord(leafToSupersede);
    if (
      semanticDecision.action === "supersedes_existing"
      || newSpecificity >= supersededSpecificity
    ) {
      params.store.updateInteractionLeafStatus({
        workspaceId: params.workspaceId,
        leafId: leafToSupersede.leafId,
        status: "superseded",
        supersededAt: candidate.observedAt ?? utcNowIso(),
      });
      outcome = "superseding";
    } else {
      return {
        outcome: "noop_duplicate",
        entity,
        leaf: leafToSupersede,
        changed: false,
      };
    }
  }

  const leaf = params.store.upsertInteractionLeaf({
    workspaceId: params.workspaceId,
    leafId,
    entityId: entity.entityId,
    subjectKey: candidate.subjectKey,
    path: relativePath,
    title: candidate.title,
    summary: candidate.summary,
    fingerprint: contentFingerprint,
    bodySha256: sha256(candidate.content),
    tags: candidate.tags,
    secondaryEntityIds: entityAssignment.secondaryEntityIds,
    sourceType: candidate.sourceType ?? null,
    sourceEventId: candidate.sourceEventId ?? null,
    sourceMessageId: candidate.sourceMessageId ?? null,
    sourceTurnInputId: candidate.sourceTurnInputId ?? null,
    admissionConfidence: candidate.confidence ?? null,
    entityConfidence: entityAssignment.confidence ?? null,
    observedAt: candidate.observedAt ?? null,
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
    body: candidate.content,
    embeddingClient: params.embeddingClient ?? null,
  });

  return {
    outcome,
    entity,
    leaf,
    changed: true,
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
  const semanticCategoryCache = new Map<string, InteractionSemanticCategory>();
  const workspaceDir = params.store.workspaceDir(params.workspaceId);
  const entityDir = interactionEntityDir(workspaceDir, entity.slug);
  const semanticTreeDir = semanticInteractionTreeDir(workspaceDir, entity.entityType, entity.slug);
  const summariesDir = path.join(entityDir, "summaries");
  const existingSummaryByNodeId = loadExistingInteractionSummaryNodes({
    store: params.store,
    workspaceId: params.workspaceId,
    entity,
    semanticCategoryCache,
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

  const reclassifiedEntityIds =
    params.entityId === INTERACTION_UNCATEGORIZED_ENTITY_ID
      ? await reclassifyUncategorizedInteractionLeaves({
          store: params.store,
          workspaceId: params.workspaceId,
          summaryModelClient: params.summaryModelClient ?? null,
        })
      : new Set<string>();

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
  if (params.summaryModelClient && activeLeaves.length > 0) {
    for (let index = 0; index < activeLeaves.length; index += 1) {
      const leaf = activeLeaves[index];
      if (!leaf) {
        continue;
      }
      const body = leafBodies.get(leaf.leafId) ?? interactionFallbackLeafBody(leaf);
      const enriched = await enrichInteractionLeafRelatedInfo({
        store: params.store,
        workspaceId: params.workspaceId,
        entity,
        leaf,
        body,
        modelClient: params.summaryModelClient,
        embeddingClient: params.embeddingClient ?? null,
      });
      if (enriched.changed) {
        activeLeaves[index] = enriched.leaf;
        leafBodies.set(enriched.leaf.leafId, enriched.body);
      }
    }
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
    category: ACTIVE_WORKSPACE_INTERACTION_CATEGORY,
    workspaceId: params.workspaceId,
    treeId: params.entityId,
    nodes: semantic.nodes,
    edges: semantic.edges,
  });
  params.store.syncSemanticMemoryRelations({
    category: ACTIVE_WORKSPACE_INTERACTION_CATEGORY,
    workspaceId: params.workspaceId,
    treeId: params.entityId,
    relations: semanticRelationsForInteractionTree({
      store: params.store,
      workspaceId: params.workspaceId,
      entity,
      semantic,
      leaves: activeLeaves,
      leafBodies,
    }),
  });
  params.store.replaceSemanticMemoryEvidenceRefs({
    category: ACTIVE_WORKSPACE_INTERACTION_CATEGORY,
    workspaceId: params.workspaceId,
    treeId: params.entityId,
    refs: semanticEvidenceRefsForInteractionTree({
      store: params.store,
      workspaceId: params.workspaceId,
      entity,
      semantic,
      leaves: activeLeaves,
    }),
  });
  params.store.syncSemanticMemorySearchDocs({
    category: ACTIVE_WORKSPACE_INTERACTION_CATEGORY,
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
  for (const reclassifiedEntityId of reclassifiedEntityIds) {
    await rebuildInteractionEntityTree({
      store: params.store,
      workspaceId: params.workspaceId,
      entityId: reclassifiedEntityId,
      summaryModelClient: params.summaryModelClient ?? null,
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
      category: ACTIVE_WORKSPACE_INTERACTION_CATEGORY,
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

function semanticSearchDocsByNodeId(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  treeId: string;
  treeCategoryByTreeId?: ReadonlyMap<string, InteractionSemanticCategory>;
  semanticCategoryCache?: Map<string, InteractionSemanticCategory>;
}): Map<string, ReturnType<RuntimeStateStore["listSemanticMemorySearchDocs"]>[number]> {
  const semanticCategory = resolvedInteractionSemanticCategory({
    store: params.store,
    workspaceId: params.workspaceId,
    treeId: params.treeId,
    treeCategoryByTreeId: params.treeCategoryByTreeId,
    cache: params.semanticCategoryCache,
  });
  return new Map(
    params.store.listSemanticMemorySearchDocs({
      category: semanticCategory,
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
  treeCategoryByTreeId?: ReadonlyMap<string, InteractionSemanticCategory>;
  semanticCategoryCache?: Map<string, InteractionSemanticCategory>;
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
  const docsByNodeId = new Map<string, SemanticSearchDoc>();
  const nodeClass = retrievalNodeClassForMode(params.mode);
  if (params.treeId) {
    const semanticCategory = resolvedInteractionSemanticCategory({
      store: params.store,
      workspaceId: params.workspaceId,
      treeId: params.treeId,
      treeCategoryByTreeId: params.treeCategoryByTreeId,
      cache: params.semanticCategoryCache,
    });
    for (const doc of params.store.listSemanticMemorySearchDocs({
      category: semanticCategory,
      workspaceId: params.workspaceId,
      treeId: params.treeId,
      nodeIds: vectorHits.map((hit) => hit.nodeId),
      nodeClass,
      status: "active",
      limit: vectorHits.length,
      offset: 0,
    })) {
      docsByNodeId.set(doc.nodeId, doc);
    }
  } else {
    const docsByGroup = new Map<string, string[]>();
    for (const hit of vectorHits) {
      const semanticCategory = resolvedInteractionSemanticCategory({
        store: params.store,
        workspaceId: params.workspaceId,
        treeId: hit.entityId,
        treeCategoryByTreeId: params.treeCategoryByTreeId,
        cache: params.semanticCategoryCache,
      });
      const key = `${semanticCategory}|${hit.entityId}`;
      const existing = docsByGroup.get(key) ?? [];
      existing.push(hit.nodeId);
      docsByGroup.set(key, existing);
    }
    for (const [key, nodeIds] of docsByGroup) {
      const [semanticCategory, treeId] = key.split("|", 2) as [InteractionSemanticCategory, string];
      for (const doc of params.store.listSemanticMemorySearchDocs({
        category: semanticCategory,
        workspaceId: params.workspaceId,
        treeId,
        nodeIds,
        nodeClass,
        status: "active",
        limit: nodeIds.length,
        offset: 0,
      })) {
        docsByNodeId.set(doc.nodeId, doc);
      }
    }
  }
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
  treeCategoryByTreeId?: ReadonlyMap<string, InteractionSemanticCategory>;
  semanticCategoryCache?: Map<string, InteractionSemanticCategory>;
}): Map<string, number> {
  const matchQuery = buildRetrievalFtsMatchQuery(params.query);
  if (!matchQuery) {
    return new Map();
  }
  const nodeClass = retrievalNodeClassForMode(params.mode);
  const hits = params.treeId
    ? params.store.searchSemanticMemorySearchDocs({
      category: resolvedInteractionSemanticCategory({
        store: params.store,
        workspaceId: params.workspaceId,
        treeId: params.treeId,
        treeCategoryByTreeId: params.treeCategoryByTreeId,
        cache: params.semanticCategoryCache,
      }),
      workspaceId: params.workspaceId,
      treeId: params.treeId,
      nodeClass,
      status: "active",
      matchQuery,
      limit: 500,
      offset: 0,
    })
    : sortSemanticSearchHits(
      interactionSemanticTreeGroups({
        treeCategoryByTreeId: params.treeCategoryByTreeId ?? new Map(),
      }).flatMap((group) =>
        params.store.searchSemanticMemorySearchDocs({
          category: group.category,
          workspaceId: params.workspaceId,
          treeIds: group.treeIds,
          nodeClass,
          status: "active",
          matchQuery,
          limit: 500,
          offset: 0,
        })),
    ).slice(0, 500);
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
  treeCategoryByTreeId?: ReadonlyMap<string, InteractionSemanticCategory>;
  semanticCategoryCache?: Map<string, InteractionSemanticCategory>;
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
    const lexicalDocs = params.treeId
      ? params.store.searchSemanticMemorySearchDocs({
        category: resolvedInteractionSemanticCategory({
          store: params.store,
          workspaceId: params.workspaceId,
          treeId: params.treeId,
          treeCategoryByTreeId: params.treeCategoryByTreeId,
          cache: params.semanticCategoryCache,
        }),
        workspaceId: params.workspaceId,
        treeId: params.treeId,
        nodeClass,
        status: "active",
        matchQuery,
        limit: ftsLimit,
        offset: 0,
      })
      : sortSemanticSearchHits(
        interactionSemanticTreeGroups({
          treeCategoryByTreeId: params.treeCategoryByTreeId ?? new Map(),
        }).flatMap((group) =>
          params.store.searchSemanticMemorySearchDocs({
            category: group.category,
            workspaceId: params.workspaceId,
            treeIds: group.treeIds,
            nodeClass,
            status: "active",
            matchQuery,
            limit: ftsLimit,
            offset: 0,
          })),
      );
    addDocs(lexicalDocs);
  }
  addDocs(params.vectorDocs ?? []);
  const recentDocs = params.treeId
    ? params.store.listSemanticMemorySearchDocs({
      category: resolvedInteractionSemanticCategory({
        store: params.store,
        workspaceId: params.workspaceId,
        treeId: params.treeId,
        treeCategoryByTreeId: params.treeCategoryByTreeId,
        cache: params.semanticCategoryCache,
      }),
      workspaceId: params.workspaceId,
      treeId: params.treeId,
      nodeClass,
      status: "active",
      limit: matchQuery ? recentLimit : poolLimit,
      offset: 0,
    })
    : sortSemanticSearchDocsByRecency(
      interactionSemanticTreeGroups({
        treeCategoryByTreeId: params.treeCategoryByTreeId ?? new Map(),
      }).flatMap((group) =>
        params.store.listSemanticMemorySearchDocs({
          category: group.category,
          workspaceId: params.workspaceId,
          treeIds: group.treeIds,
          nodeClass,
          status: "active",
          limit: matchQuery ? recentLimit : poolLimit,
          offset: 0,
        })),
    );
  addDocs(recentDocs);
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
  const nodesDepth = semanticInteractionPathDepth(node.path);
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
  const nodesDepth = semanticInteractionPathDepth(doc.path);
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
  entities?: InteractionEntityRecord[];
  treeCategoryByTreeId?: ReadonlyMap<string, InteractionSemanticCategory>;
  semanticCategoryCache?: Map<string, InteractionSemanticCategory>;
}): Promise<InteractionMemoryRetrieveHit[]> {
  const semanticEntity = (params.entities ?? params.store.listInteractionEntities({
    workspaceId: params.workspaceId,
    status: "active",
    includeSystem: true,
    limit: 10_000,
    offset: 0,
  })).map((entity) => ({
    entity,
    semanticCategory: resolvedInteractionSemanticCategory({
      store: params.store,
      workspaceId: params.workspaceId,
      treeId: entity.entityId,
      treeCategoryByTreeId: params.treeCategoryByTreeId,
      cache: params.semanticCategoryCache,
    }),
  })).find(({ entity, semanticCategory }) =>
    Boolean(
      params.store.getSemanticMemoryNode({
        category: semanticCategory,
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
      treeId: semanticEntity.entity.entityId,
      treeCategoryByTreeId: params.treeCategoryByTreeId,
      semanticCategoryCache: params.semanticCategoryCache,
    });
    const lexicalRanksByNodeId = semanticLexicalRanksByNodeId({
      store: params.store,
      workspaceId: params.workspaceId,
      query: params.query,
      mode: params.mode,
      treeId: semanticEntity.entity.entityId,
      treeCategoryByTreeId: params.treeCategoryByTreeId,
      semanticCategoryCache: params.semanticCategoryCache,
    });
    const candidates = params.store
      .listSemanticMemoryChildren({
        category: semanticEntity.semanticCategory,
        workspaceId: params.workspaceId,
        treeId: semanticEntity.entity.entityId,
        parentNodeId: params.parentNodeId,
      })
      .map((child) =>
        params.store.getSemanticMemoryNode({
          category: semanticEntity.semanticCategory,
          workspaceId: params.workspaceId,
          treeId: semanticEntity.entity.entityId,
          nodeId: child.childNodeId,
        }))
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .map((node) =>
        buildSemanticCandidate({
          entity: semanticEntity.entity,
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

  const semanticCategoryCache = new Map<string, InteractionSemanticCategory>();
  const treeCategoryByTreeId = new Map(
    entities.map((entity) => [
      entity.entityId,
      readableInteractionSemanticCategory({
        store: params.store,
        workspaceId: params.workspaceId,
        treeId: entity.entityId,
        cache: semanticCategoryCache,
      }),
    ]),
  );
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
    treeCategoryByTreeId,
    semanticCategoryCache,
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
        entities,
        treeCategoryByTreeId,
        semanticCategoryCache,
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
        treeCategoryByTreeId,
        semanticCategoryCache,
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
    treeCategoryByTreeId,
    semanticCategoryCache,
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
