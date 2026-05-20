import { createHash } from "node:crypto";

import type {
  MemoryEntryScope,
  MemoryEntrySourceType,
  MemoryEntryType,
  MemoryStalenessPolicy,
  MemoryVerificationPolicy,
  RuntimeStateStore,
  SessionMessageRecord,
  TurnResultRecord,
} from "@holaboss/runtime-state-store";

import type { MemoryServiceLike } from "./memory.js";
import {
  persistInteractionCandidate,
  rebuildAllInteractionTrees,
  rebuildInteractionEntityTree,
} from "./interaction-memory.js";
import { governanceRuleForMemoryType } from "./memory-governance.js";
import {
  assistantTextFromTurnArtifacts,
  recentUserMessagesForTurn,
} from "./turn-semantic-artifacts.js";
import {
  extractDurableMemoryCandidatesFromModel,
  type DurableMemoryExtractionContext,
  type ExtractedDurableMemoryCandidate,
} from "./memory-writeback-extractor.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { createRecallEmbeddingModelClient } from "./recall-embedding-model.js";

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
}

interface ModelDurableCandidate {
  extractedCandidate: ExtractedDurableMemoryCandidate;
  durableCandidate: DurableMemoryCandidate;
}

interface TurnWritebackContext {
  assistantText: string;
  recentTurnSummaries: string[];
  turnResult: TurnResultRecord;
  recentUserMessages: SessionMessageRecord[];
}

export interface TurnMemoryWritebackModelContext {
  modelClient?: MemoryModelClientConfig | null;
  instruction?: string | null;
}

const RECENT_TURNS_LIMIT = 5;
const RECENT_USER_MESSAGES_LIMIT = 6;
const MODEL_EXTRACTION_MIN_CONFIDENCE = 0.82;
const MODEL_EXTRACTION_MIN_EVIDENCE_CHARS = 36;

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

function extractedMemoryContent(params: {
  turnResult: TurnResultRecord;
  candidate: ExtractedDurableMemoryCandidate;
}): string {
  const lines = [
    `# ${params.candidate.title}`,
    "",
    `- Scope: \`${params.candidate.scope}\``,
    `- Type: \`${params.candidate.memoryType}\``,
    `- Subject: \`${params.candidate.subjectKey}\``,
    `- Workspace ID: \`${params.turnResult.workspaceId}\``,
    `- Session ID: \`${params.turnResult.sessionId}\``,
    `- Updated at: ${params.turnResult.completedAt ?? params.turnResult.updatedAt}`,
    "",
    "## Summary",
    "",
    params.candidate.summary,
  ];
  if (params.candidate.evidence) {
    lines.push("", "## Evidence", "", params.candidate.evidence);
  }
  return `${lines.join("\n").trim()}\n`;
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
    content: extractedMemoryContent({
      turnResult: params.turnResult,
      candidate: params.extracted,
    }),
    tags: params.extracted.tags,
    verificationPolicy: governance.verificationPolicy,
    stalenessPolicy: governance.stalenessPolicy,
    staleAfterSeconds: governance.staleAfterSeconds,
    sourceType: "assistant_turn",
    observedAt,
    lastVerifiedAt: observedAt,
    confidence: params.extracted.confidence,
  };
}

async function extractedDurableMemoryCandidates(params: {
  turnResult: TurnResultRecord;
  assistantText: string;
  recentUserMessages: SessionMessageRecord[];
  recentTurnSummaries: string[];
  modelContext?: TurnMemoryWritebackModelContext | null;
}): Promise<ModelDurableCandidate[]> {
  if (!params.modelContext?.modelClient) {
    return [];
  }
  const recentUserMessages = params.recentUserMessages
    .slice(-4)
    .map((message) => clippedText(message.text, 220));
  const extractionContext: DurableMemoryExtractionContext = {
    modelClient: params.modelContext.modelClient,
    workspaceId: params.turnResult.workspaceId,
    sessionId: params.turnResult.sessionId,
    inputId: params.turnResult.inputId,
    instruction: params.modelContext.instruction?.trim() || recentUserMessages[recentUserMessages.length - 1] || "",
    assistantText: clippedText(params.assistantText, 1400),
    recentUserMessages,
    recentTurnSummaries: params.recentTurnSummaries.slice(0, 4),
  };
  const extracted = await extractDurableMemoryCandidatesFromModel(extractionContext);
  return extracted.map((candidate) => ({
    extractedCandidate: candidate,
    durableCandidate: durableCandidateFromExtracted({
      turnResult: params.turnResult,
      extracted: candidate,
    }),
  }));
}

function acceptedModelDurableCandidates(params: {
  modelCandidates: ModelDurableCandidate[];
}): DurableMemoryCandidate[] {
  const accepted: DurableMemoryCandidate[] = [];
  for (const modelCandidate of params.modelCandidates) {
    const confidence = modelCandidate.extractedCandidate.confidence ?? -1;
    const evidenceChars = compactWhitespace(modelCandidate.extractedCandidate.evidence).length;
    if (confidence < MODEL_EXTRACTION_MIN_CONFIDENCE || evidenceChars < MODEL_EXTRACTION_MIN_EVIDENCE_CHARS) {
      continue;
    }
    if (modelCandidate.durableCandidate.scope === "user") {
      continue;
    }
    accepted.push(modelCandidate.durableCandidate);
  }
  return accepted;
}

function loadTurnWritebackContext(store: RuntimeStateStore, turnResult: TurnResultRecord): TurnWritebackContext {
  // Keep turn_results as a deterministic execution ledger. Any short summary
  // used by background writeback is ephemeral evidence, not persisted state.
  const assistantText = assistantTextFromTurnArtifacts(store, turnResult);
  const recentTurns = store.listTurnResults({
    workspaceId: turnResult.workspaceId,
    sessionId: turnResult.sessionId,
    limit: RECENT_TURNS_LIMIT,
    offset: 0,
  });
  const recentUserMessages = recentUserMessagesForTurn(store, turnResult, RECENT_USER_MESSAGES_LIMIT);
  return {
    assistantText,
    recentTurnSummaries: recentTurns
      .slice(0, 4)
      .map((item) => item.assistantText)
      .map((item) => clippedText(item, 220))
      .filter((summary): summary is string => Boolean(summary)),
    turnResult,
    recentUserMessages,
  };
}

export async function persistDurableMemoryCandidate(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  candidate: DurableMemoryCandidate;
}): Promise<string> {
  void params.memoryService;
  const embeddingClient = createRecallEmbeddingModelClient({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
  });
  const result = await persistInteractionCandidate({
    store: params.store,
    workspaceId: params.workspaceId,
    candidate: {
      subjectKey: params.candidate.subjectKey,
      title: params.candidate.title,
      summary: params.candidate.summary,
      content: params.candidate.content,
      tags: params.candidate.tags,
      memoryType: params.candidate.memoryType,
      sourceType: params.candidate.sourceType,
      sourceEventId: params.inputId,
      sourceMessageId: params.candidate.sourceMessageId ?? null,
      sourceTurnInputId: params.inputId,
      observedAt: params.candidate.observedAt ?? null,
      confidence: params.candidate.confidence ?? null,
    },
    modelClient: null,
    embeddingClient,
  });
  await rebuildInteractionEntityTree({
    store: params.store,
    workspaceId: params.workspaceId,
    entityId: result.entity.entityId,
    summaryModelClient: null,
    embeddingClient,
  });
  return result.leaf.path;
}

export async function refreshMemoryIndexes(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  workspaceId: string;
}): Promise<string[]> {
  void params.memoryService;
  await rebuildAllInteractionTrees({
    store: params.store,
    workspaceId: params.workspaceId,
  });
  return params.store
    .listInteractionSummaryNodes({
      workspaceId: params.workspaceId,
      status: "active",
      limit: 10_000,
      offset: 0,
    })
    .map((node) => node.path);
}

export async function writeTurnDurableMemory(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  turnResult: TurnResultRecord;
  modelContext?: TurnMemoryWritebackModelContext | null;
}): Promise<TurnResultRecord> {
  void params.memoryService;
  const context = loadTurnWritebackContext(params.store, params.turnResult);
  const extractedCandidates = await extractedDurableMemoryCandidates({
    turnResult: context.turnResult,
    assistantText: context.assistantText,
    recentUserMessages: context.recentUserMessages,
    recentTurnSummaries: context.recentTurnSummaries,
    modelContext: params.modelContext ?? null,
  });
  const durableCandidates = acceptedModelDurableCandidates({
    modelCandidates: extractedCandidates,
  });
  if (durableCandidates.length === 0) {
    return (
      params.store.getTurnResult({
        workspaceId: context.turnResult.workspaceId,
        inputId: context.turnResult.inputId,
      }) ?? context.turnResult
    );
  }
  const embeddingClient = createRecallEmbeddingModelClient({
    workspaceId: context.turnResult.workspaceId,
    sessionId: context.turnResult.sessionId,
    inputId: context.turnResult.inputId,
  });
  const summaryModelClient = params.modelContext?.modelClient ?? null;
  const touchedEntityIds = new Set<string>();

  for (const candidate of durableCandidates) {
    const persisted = await persistInteractionCandidate({
      store: params.store,
      workspaceId: context.turnResult.workspaceId,
      candidate: {
        subjectKey: candidate.subjectKey,
        title: candidate.title,
        summary: candidate.summary,
        content: candidate.content,
        tags: candidate.tags,
        memoryType: candidate.memoryType,
        sourceType: candidate.sourceType,
        sourceEventId: context.turnResult.inputId,
        sourceMessageId: candidate.sourceMessageId ?? null,
        sourceTurnInputId: context.turnResult.inputId,
        observedAt: candidate.observedAt ?? null,
        confidence: candidate.confidence ?? null,
      },
      modelClient: params.modelContext?.modelClient ?? null,
      embeddingClient,
    });
    if (persisted.outcome !== "noop_duplicate") {
      touchedEntityIds.add(persisted.entity.entityId);
    }
  }
  for (const entityId of touchedEntityIds) {
    await rebuildInteractionEntityTree({
      store: params.store,
      workspaceId: context.turnResult.workspaceId,
      entityId,
      summaryModelClient,
      embeddingClient,
    });
  }
  return (
    params.store.getTurnResult({
      workspaceId: context.turnResult.workspaceId,
      inputId: context.turnResult.inputId,
    }) ?? context.turnResult
  );
}

export async function writeTurnMemory(params: {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
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
