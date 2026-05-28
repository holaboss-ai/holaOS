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
  type DurableMemoryExtractionResult,
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

interface TurnWritebackBatchContext {
  batchTurns: Array<{
    userInstruction: string;
    assistantText: string;
  }>;
  batchTurnResults: TurnResultRecord[];
  recentTurnSummaries: string[];
  recentUserMessages: SessionMessageRecord[];
  excludedRecallTurnCount: number;
}

type InteractionMemoryBatchStatus =
  | "running"
  | "completed"
  | "completed_no_candidates"
  | "failed";

interface InteractionMemoryBatchState {
  batchId: string;
  sessionId: string;
  turnStartIndex: number;
  turnEndIndex: number;
  turnInputIds: string[];
  status: InteractionMemoryBatchStatus;
  attemptCount: number;
  extractionAttemptCount: number;
  usedSubBatchFallback: boolean;
  estimatedPromptChars: number;
  candidateCount: number;
  persistedLeafCount: number;
  touchedEntities: string[];
  extractionMs: number | null;
  persistMs: number | null;
  rebuildMs: number | null;
  failureReason: string | null;
}

interface InteractionMemoryBatchLeaseState {
  sessionId: string;
  ownerId: string;
  active: boolean;
  acquiredAt: string;
  releasedAt: string | null;
}

interface ModelDurableCandidateExtractionSuccess {
  ok: true;
  modelCandidates: ModelDurableCandidate[];
  extraction: DurableMemoryExtractionResult & { ok: true };
}

interface ModelDurableCandidateExtractionFailure {
  ok: false;
  extraction: DurableMemoryExtractionResult & { ok: false };
}

type ModelDurableCandidateExtractionOutcome =
  | ModelDurableCandidateExtractionSuccess
  | ModelDurableCandidateExtractionFailure;

export interface TurnMemoryWritebackModelContext {
  modelClient?: MemoryModelClientConfig | null;
  instruction?: string | null;
}

const INTERACTION_REBUILD_DEBOUNCE_MS = 75;

interface PendingInteractionEntityRebuild {
  key: string;
  store: RuntimeStateStore;
  workspaceId: string;
  entityId: string;
  summaryModelClient: MemoryModelClientConfig | null;
  embeddingClient: MemoryModelClientConfig | null;
  debounceMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  dirty: boolean;
  settled: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const pendingInteractionEntityRebuilds = new Map<string, PendingInteractionEntityRebuild>();

function interactionEntityRebuildKey(workspaceId: string, entityId: string): string {
  return `${workspaceId}::${entityId}`;
}

function queueInteractionEntityRebuild(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  entityId: string;
  summaryModelClient?: MemoryModelClientConfig | null;
  embeddingClient?: MemoryModelClientConfig | null;
  debounceMs?: number;
}): Promise<void> {
  const key = interactionEntityRebuildKey(params.workspaceId, params.entityId);
  let pending = pendingInteractionEntityRebuilds.get(key) ?? null;
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
      workspaceId: params.workspaceId,
      entityId: params.entityId,
      summaryModelClient: params.summaryModelClient ?? null,
      embeddingClient: params.embeddingClient ?? null,
      debounceMs: Math.max(0, params.debounceMs ?? INTERACTION_REBUILD_DEBOUNCE_MS),
      timer: null,
      running: false,
      dirty: true,
      settled,
      resolve,
      reject,
    };
    // Swallow unhandled rejections for fire-and-forget background callers while
    // still allowing explicit awaiters to observe the same rejection.
    void settled.catch(() => undefined);
    pendingInteractionEntityRebuilds.set(key, pending);
  } else {
    pending.store = params.store;
    pending.summaryModelClient = params.summaryModelClient ?? pending.summaryModelClient ?? null;
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
      void runQueuedInteractionEntityRebuild(pending!);
    }, pending.debounceMs);
  }
  return pending.settled;
}

async function runQueuedInteractionEntityRebuild(pending: PendingInteractionEntityRebuild): Promise<void> {
  if (pending.running) {
    return;
  }
  pending.running = true;
  try {
    while (pending.dirty) {
      pending.dirty = false;
      await rebuildInteractionEntityTree({
        store: pending.store,
        workspaceId: pending.workspaceId,
        entityId: pending.entityId,
        summaryModelClient: pending.summaryModelClient,
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
    pendingInteractionEntityRebuilds.delete(pending.key);
  }
}

export async function waitForPendingInteractionEntityRebuilds(params?: {
  workspaceId?: string | null;
  entityIds?: string[] | null;
}): Promise<void> {
  const normalizedEntityIds = params?.entityIds
    ? new Set(params.entityIds.map((value) => value.trim()).filter(Boolean))
    : null;
  while (true) {
    const pending = [...pendingInteractionEntityRebuilds.values()].filter((candidate) => {
      if (params?.workspaceId && candidate.workspaceId !== params.workspaceId) {
        return false;
      }
      if (normalizedEntityIds && !normalizedEntityIds.has(candidate.entityId)) {
        return false;
      }
      return true;
    });
    if (pending.length === 0) {
      return;
    }
    await Promise.all(pending.map((candidate) => candidate.settled));
  }
}

const TURN_BATCH_SIZE = 3;
const BATCH_CURSOR_KEY_PREFIX = "interaction_memory_batch_processed_count:";
const BATCH_STATE_KEY_PREFIX = "interaction_memory_batch_state:";
const BATCH_LATEST_STATE_KEY_PREFIX = "interaction_memory_batch_latest:";
const BATCH_LEASE_KEY_PREFIX = "interaction_memory_batch_lease:";
const RECENT_TURNS_LIMIT = 5;
const RECENT_USER_MESSAGES_LIMIT = 6;
const MODEL_EXTRACTION_MIN_CONFIDENCE = 0.82;
const MODEL_EXTRACTION_MIN_EVIDENCE_CHARS = 36;

const activeInteractionBatchLeases = new Map<string, string>();

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

function tokenizeSubject(value: string): string[] {
  const matches = value.match(/[a-z0-9]{2,}/gi);
  return matches ? matches.map((token) => token.toLowerCase()) : [];
}

function tokenJaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size === 0 || rightSet.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? intersection / union : 0;
}

function titleTokens(value: string): string[] {
  return tokenizeSubject(
    compactWhitespace(value)
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/[^\w#@.-]+/g, " "),
  );
}

function candidateSimilarity(left: DurableMemoryCandidate, right: DurableMemoryCandidate): number {
  const subjectSimilarity = tokenJaccard(
    tokenizeSubject(left.subjectKey),
    tokenizeSubject(right.subjectKey),
  );
  const titleSimilarity = tokenJaccard(titleTokens(left.title), titleTokens(right.title));
  const summarySimilarity = tokenJaccard(titleTokens(left.summary), titleTokens(right.summary));
  return Math.max(
    subjectSimilarity,
    titleSimilarity * 0.7 + summarySimilarity * 0.3,
  );
}

function candidateSpecificityScore(candidate: DurableMemoryCandidate): number {
  return (
    compactWhitespace(candidate.content).length * 1.5
    + compactWhitespace(candidate.summary).length
    + compactWhitespace(candidate.title).length * 0.5
    + candidate.tags.length * 12
  );
}

function consolidateDurableCandidates(candidates: DurableMemoryCandidate[]): DurableMemoryCandidate[] {
  const groups: Array<{ anchor: DurableMemoryCandidate; members: DurableMemoryCandidate[] }> = [];
  for (const candidate of candidates) {
    const group = groups.find((entry) =>
      entry.anchor.scope === candidate.scope
      && entry.anchor.memoryType === candidate.memoryType
      && candidateSimilarity(entry.anchor, candidate) >= 0.58,
    );
    if (group) {
      group.members.push(candidate);
      if (candidateSpecificityScore(candidate) > candidateSpecificityScore(group.anchor)) {
        group.anchor = candidate;
      }
      continue;
    }
    groups.push({
      anchor: candidate,
      members: [candidate],
    });
  }
  return groups.map((group) => {
    const mergedTags = Array.from(
      new Set(group.members.flatMap((candidate) => candidate.tags)),
    ).sort((left, right) => left.localeCompare(right));
    const richest = [...group.members].sort(
      (left, right) => candidateSpecificityScore(right) - candidateSpecificityScore(left),
    )[0] ?? group.anchor;
    return {
      ...group.anchor,
      tags: mergedTags,
      content: richest.content,
      summary: richest.summary,
      title: group.anchor.title,
      confidence: Math.max(...group.members.map((candidate) => candidate.confidence ?? 0)),
    };
  });
}

function refinedExtractedSubjectKey(candidate: ExtractedDurableMemoryCandidate): string {
  const base = candidate.subjectKey.trim();
  if (!base) {
    return base;
  }
  const baseTokens = new Set(tokenizeSubject(base));
  if (baseTokens.size === 0) {
    return base;
  }
  const suffixTokens: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenizeSubject(candidate.title)) {
    if (baseTokens.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    suffixTokens.push(token);
    if (suffixTokens.length >= 6) {
      break;
    }
  }
  if (suffixTokens.length === 0) {
    return base;
  }
  return `${base}:${suffixTokens.join("-")}`;
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

function sessionBatchCursorKey(sessionId: string): string {
  return `${BATCH_CURSOR_KEY_PREFIX}${sessionId}`;
}

function interactionBatchStateKey(params: {
  sessionId: string;
  turnStartIndex: number;
  turnEndIndex: number;
}): string {
  return `${BATCH_STATE_KEY_PREFIX}${params.sessionId}:${params.turnStartIndex}-${params.turnEndIndex}`;
}

function latestInteractionBatchStateKey(sessionId: string): string {
  return `${BATCH_LATEST_STATE_KEY_PREFIX}${sessionId}`;
}

function interactionBatchLeaseKey(sessionId: string): string {
  return `${BATCH_LEASE_KEY_PREFIX}${sessionId}`;
}

function processedTurnBatchCount(value: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseInteractionBatchState(value: string | null): InteractionMemoryBatchState | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<InteractionMemoryBatchState>;
    if (
      !parsed ||
      typeof parsed.batchId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.turnStartIndex !== "number" ||
      typeof parsed.turnEndIndex !== "number" ||
      typeof parsed.status !== "string"
    ) {
      return null;
    }
    return {
      batchId: parsed.batchId,
      sessionId: parsed.sessionId,
      turnStartIndex: parsed.turnStartIndex,
      turnEndIndex: parsed.turnEndIndex,
      turnInputIds: Array.isArray(parsed.turnInputIds)
        ? parsed.turnInputIds.filter((value): value is string => typeof value === "string")
        : [],
      status:
        parsed.status === "running" ||
        parsed.status === "completed" ||
        parsed.status === "completed_no_candidates" ||
        parsed.status === "failed"
          ? parsed.status
          : "failed",
      attemptCount: typeof parsed.attemptCount === "number" ? parsed.attemptCount : 0,
      extractionAttemptCount: typeof parsed.extractionAttemptCount === "number" ? parsed.extractionAttemptCount : 0,
      usedSubBatchFallback: parsed.usedSubBatchFallback === true,
      estimatedPromptChars: typeof parsed.estimatedPromptChars === "number" ? parsed.estimatedPromptChars : 0,
      candidateCount: typeof parsed.candidateCount === "number" ? parsed.candidateCount : 0,
      persistedLeafCount: typeof parsed.persistedLeafCount === "number" ? parsed.persistedLeafCount : 0,
      touchedEntities: Array.isArray(parsed.touchedEntities)
        ? parsed.touchedEntities.filter((value): value is string => typeof value === "string")
        : [],
      extractionMs: typeof parsed.extractionMs === "number" ? parsed.extractionMs : null,
      persistMs: typeof parsed.persistMs === "number" ? parsed.persistMs : null,
      rebuildMs: typeof parsed.rebuildMs === "number" ? parsed.rebuildMs : null,
      failureReason: typeof parsed.failureReason === "string" ? parsed.failureReason : null,
    };
  } catch {
    return null;
  }
}

function writeInteractionBatchState(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  state: InteractionMemoryBatchState;
}): void {
  const key = interactionBatchStateKey({
    sessionId: params.state.sessionId,
    turnStartIndex: params.state.turnStartIndex,
    turnEndIndex: params.state.turnEndIndex,
  });
  const value = JSON.stringify(params.state);
  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key,
    value,
  });
  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: latestInteractionBatchStateKey(params.state.sessionId),
    value,
  });
}

function writeInteractionBatchLeaseState(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  state: InteractionMemoryBatchLeaseState;
}): void {
  params.store.setWorkspaceRuntimeMetadata({
    workspaceId: params.workspaceId,
    key: interactionBatchLeaseKey(params.state.sessionId),
    value: JSON.stringify(params.state),
  });
}

function tryAcquireInteractionBatchLease(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
}): boolean {
  const leaseKey = `${params.workspaceId}:${params.sessionId}`;
  const currentOwner = activeInteractionBatchLeases.get(leaseKey);
  if (currentOwner && currentOwner !== params.ownerId) {
    return false;
  }
  activeInteractionBatchLeases.set(leaseKey, params.ownerId);
  writeInteractionBatchLeaseState({
    store: params.store,
    workspaceId: params.workspaceId,
    state: {
      sessionId: params.sessionId,
      ownerId: params.ownerId,
      active: true,
      acquiredAt: new Date().toISOString(),
      releasedAt: null,
    },
  });
  return true;
}

function releaseInteractionBatchLease(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
}): void {
  const leaseKey = `${params.workspaceId}:${params.sessionId}`;
  const currentOwner = activeInteractionBatchLeases.get(leaseKey);
  if (currentOwner !== params.ownerId) {
    return;
  }
  activeInteractionBatchLeases.delete(leaseKey);
  writeInteractionBatchLeaseState({
    store: params.store,
    workspaceId: params.workspaceId,
    state: {
      sessionId: params.sessionId,
      ownerId: params.ownerId,
      active: false,
      acquiredAt: new Date().toISOString(),
      releasedAt: new Date().toISOString(),
    },
  });
}

function toolNamesFromTurnResult(turnResult: TurnResultRecord): string[] {
  const rawToolNames = turnResult.toolUsageSummary?.tool_names;
  if (!Array.isArray(rawToolNames)) {
    return [];
  }
  const seen = new Set<string>();
  const toolNames: string[] = [];
  for (const value of rawToolNames) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    toolNames.push(normalized);
  }
  return toolNames;
}

function isLikelyRecallQuestion(messageText: string): boolean {
  const normalized = compactWhitespace(messageText).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.endsWith("?")) {
    return true;
  }
  if (/\bwhat do we know\b/.test(normalized)) {
    return true;
  }
  return /^(who|what|when|where|why|how|which|whose|whom|is|are|was|were|do|does|did|can|could|would|will|should|have|has|had)\b/.test(
    normalized,
  );
}

function shouldExcludeTurnFromMemoryExtraction(params: {
  turnResult: TurnResultRecord;
  userInstruction: string;
}): boolean {
  const toolNames = toolNamesFromTurnResult(params.turnResult);
  const usedMemoryRetrieve = toolNames.some((toolName) => toolName === "memory_retrieve" || toolName === "memory.retrieve");
  if (!usedMemoryRetrieve) {
    return false;
  }
  return isLikelyRecallQuestion(params.userInstruction);
}

async function extractedDurableMemoryCandidates(params: {
  batchTurnResults: TurnResultRecord[];
  batchTurns: Array<{
    userInstruction: string;
    assistantText: string;
  }>;
  recentUserMessages: SessionMessageRecord[];
  recentTurnSummaries: string[];
  excludedRecallTurnCount: number;
  modelContext?: TurnMemoryWritebackModelContext | null;
}): Promise<ModelDurableCandidateExtractionOutcome> {
  if (!params.modelContext?.modelClient) {
    return {
      ok: false,
      extraction: {
        ok: false,
        failureReason: "no_model_client",
        estimatedPromptChars: 0,
        extractionAttemptCount: 0,
        usedSubBatchFallback: false,
        subBatchCount: 0,
      },
    };
  }
  const batchLastTurn = params.batchTurnResults[params.batchTurnResults.length - 1];
  if (!batchLastTurn) {
    return {
      ok: true,
      modelCandidates: [],
      extraction: {
        ok: true,
        candidates: [],
        estimatedPromptChars: 0,
        extractionAttemptCount: 0,
        usedSubBatchFallback: false,
        subBatchCount: 0,
      },
    };
  }
  const batchTurns = params.batchTurns
    .map((turn) => ({
      userInstruction: clippedText(turn.userInstruction, 220),
      assistantResponse: clippedText(turn.assistantText, 600),
    }))
    .filter((turn) => Boolean(turn.userInstruction || turn.assistantResponse));
  if (batchTurns.length === 0) {
    return {
      ok: true,
      modelCandidates: [],
      extraction: {
        ok: true,
        candidates: [],
        estimatedPromptChars: 0,
        extractionAttemptCount: 0,
        usedSubBatchFallback: false,
        subBatchCount: 0,
      },
    };
  }
  const recentUserMessages = params.recentUserMessages
    .slice(-Math.max(4, params.batchTurnResults.length))
    .map((message) => clippedText(message.text, 220));
  const extractionContext: DurableMemoryExtractionContext = {
    modelClient: params.modelContext.modelClient,
    workspaceId: batchLastTurn.workspaceId,
    sessionId: batchLastTurn.sessionId,
    inputId: batchLastTurn.inputId,
    batchTurnCount: batchTurns.length,
    batchTurns,
    recentUserMessages,
    recentTurnSummaries: params.recentTurnSummaries.slice(0, 4),
    excludedRecallTurnCount: params.excludedRecallTurnCount,
  };
  const extracted = await extractDurableMemoryCandidatesFromModel(extractionContext);
  if (!extracted.ok) {
    return {
      ok: false,
      extraction: extracted,
    };
  }
  return {
    ok: true,
    extraction: extracted,
    modelCandidates: extracted.candidates.map((candidate) => ({
      extractedCandidate: candidate,
      durableCandidate: durableCandidateFromExtracted({
        turnResult: batchLastTurn,
        extracted: {
          ...candidate,
          subjectKey: refinedExtractedSubjectKey(candidate),
        },
      }),
    })),
  };
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
  return consolidateDurableCandidates(accepted);
}

function loadTurnWritebackBatchContext(params: {
  store: RuntimeStateStore;
  batchTurnResults: TurnResultRecord[];
  processedTurnCount: number;
}): TurnWritebackBatchContext {
  const batchLastTurn = params.batchTurnResults[params.batchTurnResults.length - 1];
  if (!batchLastTurn) {
    return {
      batchTurns: [],
      batchTurnResults: [],
      recentTurnSummaries: [],
      recentUserMessages: [],
      excludedRecallTurnCount: 0,
    };
  }
  const recentUserMessages = recentUserMessagesForTurn(params.store, batchLastTurn, RECENT_USER_MESSAGES_LIMIT);
  const batchUserMessages = recentUserMessages.slice(-params.batchTurnResults.length);
  const priorUserMessages = recentUserMessages.slice(0, Math.max(0, recentUserMessages.length - batchUserMessages.length));
  const recentTurns = params.processedTurnCount > 0
    ? params.store.listTurnResults({
        workspaceId: batchLastTurn.workspaceId,
        sessionId: batchLastTurn.sessionId,
        status: "completed",
        order: "asc",
        limit: Math.min(RECENT_TURNS_LIMIT, params.processedTurnCount),
        offset: Math.max(0, params.processedTurnCount - RECENT_TURNS_LIMIT),
      })
    : [];
  const batchTurns: Array<{
    userInstruction: string;
    assistantText: string;
  }> = [];
  let excludedRecallTurnCount = 0;
  for (let index = 0; index < params.batchTurnResults.length; index += 1) {
    const turnResult = params.batchTurnResults[index];
    const userInstruction = compactWhitespace(batchUserMessages[index]?.text ?? "");
    const assistantText = compactWhitespace(assistantTextFromTurnArtifacts(params.store, turnResult));
    if (shouldExcludeTurnFromMemoryExtraction({ turnResult, userInstruction })) {
      excludedRecallTurnCount += 1;
      continue;
    }
    if (userInstruction || assistantText) {
      batchTurns.push({
        userInstruction,
        assistantText,
      });
    }
  }
  return {
    batchTurns,
    batchTurnResults: params.batchTurnResults,
    recentTurnSummaries: recentTurns
      .map((item) => item.assistantText)
      .map((item) => clippedText(item, 220))
      .filter((summary): summary is string => Boolean(summary)),
    recentUserMessages: priorUserMessages,
    excludedRecallTurnCount,
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
  void queueInteractionEntityRebuild({
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
  entityIds?: string[] | null;
}): Promise<string[]> {
  void params.memoryService;
  const requestedEntityIds = params.entityIds
    ? [...new Set(params.entityIds.map((value) => value.trim()).filter(Boolean))]
    : [];
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
      void queueInteractionEntityRebuild({
        store: params.store,
        workspaceId: params.workspaceId,
        entityId: entity.entityId,
        debounceMs: 0,
      });
    }
    await waitForPendingInteractionEntityRebuilds({
      workspaceId: params.workspaceId,
      entityIds: targetEntities.map((entity) => entity.entityId),
    });
  } else {
    await rebuildAllInteractionTrees({
      store: params.store,
      workspaceId: params.workspaceId,
    });
  }
  const semanticPaths = targetEntities
    .flatMap((entity) =>
      params.store.listSemanticMemoryNodes({
        category: "interaction",
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
  memoryService: MemoryServiceLike;
  turnResult: TurnResultRecord;
  modelContext?: TurnMemoryWritebackModelContext | null;
}): Promise<TurnResultRecord> {
  void params.memoryService;
  if (!params.modelContext?.modelClient) {
    return (
      params.store.getTurnResult({
        workspaceId: params.turnResult.workspaceId,
        inputId: params.turnResult.inputId,
      }) ?? params.turnResult
    );
  }

  const leaseOwnerId = `${params.turnResult.inputId}:${Date.now()}`;
  if (
    !tryAcquireInteractionBatchLease({
      store: params.store,
      workspaceId: params.turnResult.workspaceId,
      sessionId: params.turnResult.sessionId,
      ownerId: leaseOwnerId,
    })
  ) {
    return (
      params.store.getTurnResult({
        workspaceId: params.turnResult.workspaceId,
        inputId: params.turnResult.inputId,
      }) ?? params.turnResult
    );
  }

  try {
  const cursorKey = sessionBatchCursorKey(params.turnResult.sessionId);
  let processedTurnCount = processedTurnBatchCount(
    params.store.getWorkspaceRuntimeMetadata({
      workspaceId: params.turnResult.workspaceId,
      key: cursorKey,
    }),
  );
  const completedTurns = params.store.listTurnResults({
    workspaceId: params.turnResult.workspaceId,
    sessionId: params.turnResult.sessionId,
    status: "completed",
    order: "asc",
    limit: 10_000,
    offset: 0,
  });
  const currentTurnIndex = completedTurns.findIndex((turn) => turn.inputId === params.turnResult.inputId);
  if (currentTurnIndex < 0) {
    return (
      params.store.getTurnResult({
        workspaceId: params.turnResult.workspaceId,
        inputId: params.turnResult.inputId,
      }) ?? params.turnResult
    );
  }
  const completedTurnsThroughCurrent = completedTurns.slice(0, currentTurnIndex + 1);

  while (true) {
    const batchTurnResults = completedTurnsThroughCurrent.slice(
      processedTurnCount,
      processedTurnCount + TURN_BATCH_SIZE,
    );
    if (batchTurnResults.length < TURN_BATCH_SIZE) {
      break;
    }
    const turnStartIndex = processedTurnCount + 1;
    const turnEndIndex = processedTurnCount + batchTurnResults.length;
    const batchStateKey = interactionBatchStateKey({
      sessionId: params.turnResult.sessionId,
      turnStartIndex,
      turnEndIndex,
    });
    const priorBatchState = parseInteractionBatchState(
      params.store.getWorkspaceRuntimeMetadata({
        workspaceId: params.turnResult.workspaceId,
        key: batchStateKey,
      }),
    );
    const runningBatchState: InteractionMemoryBatchState = {
      batchId: `${params.turnResult.sessionId}:${turnStartIndex}-${turnEndIndex}`,
      sessionId: params.turnResult.sessionId,
      turnStartIndex,
      turnEndIndex,
      turnInputIds: batchTurnResults.map((turn) => turn.inputId),
      status: "running",
      attemptCount: (priorBatchState?.attemptCount ?? 0) + 1,
      extractionAttemptCount: 0,
      usedSubBatchFallback: false,
      estimatedPromptChars: 0,
      candidateCount: 0,
      persistedLeafCount: 0,
      touchedEntities: [],
      extractionMs: null,
      persistMs: null,
      rebuildMs: null,
      failureReason: null,
    };
    writeInteractionBatchState({
      store: params.store,
      workspaceId: params.turnResult.workspaceId,
      state: runningBatchState,
    });

    const context = loadTurnWritebackBatchContext({
      store: params.store,
      batchTurnResults,
      processedTurnCount,
    });
    const batchLastTurn = context.batchTurnResults[context.batchTurnResults.length - 1];
    if (!batchLastTurn) {
      break;
    }
    try {
      const extractionStartedAt = Date.now();
      const extractedCandidates = await extractedDurableMemoryCandidates({
        batchTurnResults: context.batchTurnResults,
        batchTurns: context.batchTurns,
        recentUserMessages: context.recentUserMessages,
        recentTurnSummaries: context.recentTurnSummaries,
        excludedRecallTurnCount: context.excludedRecallTurnCount,
        modelContext: params.modelContext ?? null,
      });
      const extractionMs = Date.now() - extractionStartedAt;
      if (!extractedCandidates.ok) {
        writeInteractionBatchState({
          store: params.store,
          workspaceId: params.turnResult.workspaceId,
          state: {
            ...runningBatchState,
            status: "failed",
            extractionAttemptCount: extractedCandidates.extraction.extractionAttemptCount,
            usedSubBatchFallback: extractedCandidates.extraction.usedSubBatchFallback,
            estimatedPromptChars: extractedCandidates.extraction.estimatedPromptChars,
            extractionMs,
            failureReason: extractedCandidates.extraction.failureReason,
          },
        });
        break;
      }
      const durableCandidates = acceptedModelDurableCandidates({
        modelCandidates: extractedCandidates.modelCandidates,
      });
      let persistedLeafCount = 0;
      let persistMs = 0;
      let rebuildMs = 0;
      let rebuildFailureReason: string | null = null;
      const touchedEntityIds = new Set<string>();
      if (durableCandidates.length > 0) {
        const embeddingClient = createRecallEmbeddingModelClient({
          workspaceId: batchLastTurn.workspaceId,
          sessionId: batchLastTurn.sessionId,
          inputId: batchLastTurn.inputId,
        });
        const summaryModelClient = params.modelContext.modelClient ?? null;
        const persistStartedAt = Date.now();
        for (const candidate of durableCandidates) {
          const persisted = await persistInteractionCandidate({
            store: params.store,
            workspaceId: batchLastTurn.workspaceId,
            candidate: {
              subjectKey: candidate.subjectKey,
              title: candidate.title,
              summary: candidate.summary,
              content: candidate.content,
              tags: candidate.tags,
              memoryType: candidate.memoryType,
              sourceType: candidate.sourceType,
              sourceEventId: batchLastTurn.inputId,
              sourceMessageId: candidate.sourceMessageId ?? null,
              sourceTurnInputId: batchLastTurn.inputId,
            observedAt: candidate.observedAt ?? null,
            confidence: candidate.confidence ?? null,
          },
            modelClient: null,
            embeddingClient,
          });
          if (persisted.outcome !== "noop_duplicate") {
            persistedLeafCount += 1;
            touchedEntityIds.add(persisted.entity.entityId);
          }
        }
        persistMs = Date.now() - persistStartedAt;
        processedTurnCount += TURN_BATCH_SIZE;
        params.store.setWorkspaceRuntimeMetadata({
          workspaceId: params.turnResult.workspaceId,
          key: cursorKey,
          value: String(processedTurnCount),
        });
        const rebuildStartedAt = Date.now();
        for (const entityId of touchedEntityIds) {
          void queueInteractionEntityRebuild({
            store: params.store,
            workspaceId: batchLastTurn.workspaceId,
            entityId,
            summaryModelClient,
            embeddingClient,
          });
        }
        rebuildMs = Date.now() - rebuildStartedAt;
      } else {
        processedTurnCount += TURN_BATCH_SIZE;
        params.store.setWorkspaceRuntimeMetadata({
          workspaceId: params.turnResult.workspaceId,
          key: cursorKey,
          value: String(processedTurnCount),
        });
      }
      writeInteractionBatchState({
        store: params.store,
        workspaceId: params.turnResult.workspaceId,
        state: {
          ...runningBatchState,
          status: durableCandidates.length > 0 ? "completed" : "completed_no_candidates",
          extractionAttemptCount: extractedCandidates.extraction.extractionAttemptCount,
          usedSubBatchFallback: extractedCandidates.extraction.usedSubBatchFallback,
          estimatedPromptChars: extractedCandidates.extraction.estimatedPromptChars,
          candidateCount: extractedCandidates.modelCandidates.length,
          persistedLeafCount,
          touchedEntities: [...touchedEntityIds].sort((left, right) => left.localeCompare(right)),
          extractionMs,
          persistMs,
          rebuildMs,
          failureReason: rebuildFailureReason,
        },
      });
    } catch (error) {
      writeInteractionBatchState({
        store: params.store,
        workspaceId: params.turnResult.workspaceId,
        state: {
          ...runningBatchState,
          status: "failed",
          failureReason: error instanceof Error && error.message ? error.message : "batch_processing_failed",
        },
      });
      throw error;
    }
  }

  return (
    params.store.getTurnResult({
      workspaceId: params.turnResult.workspaceId,
      inputId: params.turnResult.inputId,
    }) ?? params.turnResult
  );
  } finally {
    releaseInteractionBatchLease({
      store: params.store,
      workspaceId: params.turnResult.workspaceId,
      sessionId: params.turnResult.sessionId,
      ownerId: leaseOwnerId,
    });
  }
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
