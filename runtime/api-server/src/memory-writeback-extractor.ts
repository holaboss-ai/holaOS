import type { MemoryEntryType } from "@holaboss/runtime-state-store";

import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { queryMemoryModelJson } from "./memory-model-client.js";

export interface DurableMemoryExtractionContext {
  modelClient: MemoryModelClientConfig | null;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  batchTurnCount: number;
  batchTurns: Array<{
    userInstruction: string;
    assistantResponse: string;
  }>;
  recentUserMessages: string[];
  recentTurnSummaries: string[];
  excludedRecallTurnCount: number;
}

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

export interface DurableMemoryExtractionSuccess {
  ok: true;
  candidates: ExtractedDurableMemoryCandidate[];
  estimatedPromptChars: number;
  extractionAttemptCount: number;
  usedSubBatchFallback: boolean;
  subBatchCount: number;
}

export interface DurableMemoryExtractionFailure {
  ok: false;
  failureReason: string;
  estimatedPromptChars: number;
  extractionAttemptCount: number;
  usedSubBatchFallback: boolean;
  subBatchCount: number;
}

export type DurableMemoryExtractionResult =
  | DurableMemoryExtractionSuccess
  | DurableMemoryExtractionFailure;

const EXTRACTION_PROMPT_SAFE_CHAR_BUDGET = 6_000;

const EXTRACTION_SYSTEM_PROMPT =
  "Extract contextual durable memory from this batch of completed turns. Return strict JSON only with this shape: " +
  '{"memories":[{"scope":"workspace","memory_type":"fact|procedure|blocker|reference","subject_key":"string","title":"string","summary":"string","tags":["string"],"evidence":"string","confidence":0.0}]}. ' +
  "Only include contextual memories worth retrieving later when the relevant subject comes up again. " +
  "Include customer, project, person, vendor, or system facts; subject-specific procedures tied to a concrete customer, project, workflow, or operating context; and durable decisions, outcomes, blockers, or references likely to matter later. " +
  "Set subject_key to identify one durable memory item, not just the overall entity or customer name. " +
  "Do not include workspace-wide defaults, rules, conventions, response-style preferences, recurring commands, default verification/build/test commands, default release or verification procedures, or general operating instructions that should instead live in AGENTS.md. " +
  "Do not include temporary runtime details, one-off requests, transient execution state, or near-paraphrases of the same memory within this batch. " +
  "Prefer memories about a concrete subject, not generic workspace behavior. " +
  "Only include memories that were explicitly stated or strongly implied by the user or assistant within the current batch. " +
  "Treat turns whose primary purpose was recalling or answering previously stored knowledge as read-only context, not as new memory evidence. " +
  "Do not create a memory solely from an assistant answer that restates or paraphrases an already-known fact, procedure, owner, contact, threshold, or decision unless the current batch introduced a correction or new durable detail. " +
  "Use recent context only to disambiguate or corroborate what changed in the current batch. " +
  "Do not re-emit unchanged memories solely because they appear in recent context. " +
  "If a candidate sounds like something the agent should obey by default on nearly every future run, exclude it.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function normalizeSubjectKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "memory";
}

function normalizeMemoryType(value: unknown): MemoryEntryType | null {
  if (typeof value !== "string") {
    return null;
  }
  const token = value.trim().toLowerCase();
  if (
    token === "preference" ||
    token === "identity" ||
    token === "fact" ||
    token === "procedure" ||
    token === "blocker" ||
    token === "reference"
  ) {
    return token;
  }
  return null;
}

function normalizeScope(value: unknown): "workspace" | "user" | null {
  if (typeof value !== "string") {
    return null;
  }
  const token = value.trim().toLowerCase();
  if (token === "workspace" || token === "user") {
    return token;
  }
  return null;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const tag = item.trim().toLowerCase();
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    tags.push(tag);
  }
  return tags.slice(0, 10);
}

function normalizeConfidence(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return null;
}

interface BuiltDurableMemoryExtractionPrompt {
  systemPrompt: string;
  userPrompt: string;
  estimatedPromptChars: number;
}

function buildDurableMemoryExtractionPrompt(
  context: DurableMemoryExtractionContext
): BuiltDurableMemoryExtractionPrompt {
  const batchUserInstructions = context.batchTurns
    .map((turn) => clipText(turn.userInstruction, 220))
    .filter(Boolean);
  const batchAssistantResponses = context.batchTurns
    .map((turn) => clipText(turn.assistantResponse, 600))
    .filter(Boolean);
  const recentUserMessages = context.recentUserMessages.map((line) => clipText(line, 220)).filter(Boolean);
  const recentTurnSummaries = context.recentTurnSummaries.map((line) => clipText(line, 220)).filter(Boolean);
  const userPrompt = [
    `Workspace ID: ${context.workspaceId}`,
    `Session ID: ${context.sessionId}`,
    `Input ID: ${context.inputId}`,
    `Batch turn count: ${context.batchTurnCount}`,
    `Excluded recall-heavy turns: ${context.excludedRecallTurnCount}`,
    "",
    "User instructions in this batch:",
    ...(batchUserInstructions.length > 0 ? batchUserInstructions.map((line) => `- ${line}`) : ["- none"]),
    "",
    "Recent user messages:",
    ...(recentUserMessages.length > 0 ? recentUserMessages.map((line) => `- ${line}`) : ["- none"]),
    "",
    "Recent turn summaries:",
    ...(recentTurnSummaries.length > 0 ? recentTurnSummaries.map((line) => `- ${line}`) : ["- none"]),
    "",
    "Assistant responses in this batch:",
    ...(batchAssistantResponses.length > 0 ? batchAssistantResponses.map((line) => `- ${line}`) : ["- none"]),
  ].join("\n");
  return {
    systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    userPrompt,
    estimatedPromptChars: EXTRACTION_SYSTEM_PROMPT.length + userPrompt.length,
  };
}

function splitExtractionContext(
  context: DurableMemoryExtractionContext
): DurableMemoryExtractionContext[] {
  if (context.batchTurns.length <= 1) {
    return [context];
  }
  const splitIndex = Math.ceil(context.batchTurns.length / 2);
  const parts = [context.batchTurns.slice(0, splitIndex), context.batchTurns.slice(splitIndex)].filter(
    (turns) => turns.length > 0,
  );
  return parts.map((turns) => ({
    ...context,
    batchTurnCount: turns.length,
    batchTurns: turns,
    excludedRecallTurnCount: 0,
  }));
}

function mergeExtractedCandidates(
  candidates: ExtractedDurableMemoryCandidate[]
): ExtractedDurableMemoryCandidate[] {
  const merged = new Map<string, ExtractedDurableMemoryCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.scope,
      candidate.memoryType,
      candidate.subjectKey,
      candidate.title.toLowerCase(),
      candidate.summary.toLowerCase(),
    ].join("::");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    const existingConfidence = existing.confidence ?? 0;
    const nextConfidence = candidate.confidence ?? 0;
    if (nextConfidence > existingConfidence) {
      merged.set(key, candidate);
    }
  }
  return [...merged.values()];
}

async function extractDurableMemoryCandidatesSingleBatch(
  context: DurableMemoryExtractionContext
): Promise<{
  ok: boolean;
  failureReason?: string;
  estimatedPromptChars: number;
  candidates: ExtractedDurableMemoryCandidate[];
}> {
  const prompt = buildDurableMemoryExtractionPrompt(context);
  if (!context.modelClient) {
    return {
      ok: false,
      failureReason: "no_model_client",
      estimatedPromptChars: prompt.estimatedPromptChars,
      candidates: [],
    };
  }
  const payload = await queryMemoryModelJson(context.modelClient, {
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    timeoutMs: 8000,
  });
  if (!payload || !Array.isArray(payload.memories)) {
    return {
      ok: false,
      failureReason: "model_request_failed",
      estimatedPromptChars: prompt.estimatedPromptChars,
      candidates: [],
    };
  }

  const candidates: ExtractedDurableMemoryCandidate[] = [];
  for (const item of payload.memories) {
    if (!isRecord(item)) {
      continue;
    }
    const scope = normalizeScope(item.scope);
    const memoryType = normalizeMemoryType(item.memory_type);
    const title = clipText(String(item.title ?? ""), 120);
    const summary = clipText(String(item.summary ?? ""), 220);
    const evidence = clipText(String(item.evidence ?? ""), 260);
    if (!scope || !memoryType || !title || !summary) {
      continue;
    }
    const subjectKey = normalizeSubjectKey(String(item.subject_key ?? `${memoryType}:${title}`));
    candidates.push({
      scope,
      memoryType,
      subjectKey,
      title,
      summary,
      tags: normalizeTags(item.tags),
      evidence,
      confidence: normalizeConfidence(item.confidence),
    });
    if (candidates.length >= 8) {
      break;
    }
  }
  return {
    ok: true,
    estimatedPromptChars: prompt.estimatedPromptChars,
    candidates,
  };
}

export async function extractDurableMemoryCandidatesFromModel(
  context: DurableMemoryExtractionContext
): Promise<DurableMemoryExtractionResult> {
  if (!context.modelClient) {
    return {
      ok: false,
      failureReason: "no_model_client",
      estimatedPromptChars: 0,
      extractionAttemptCount: 0,
      usedSubBatchFallback: false,
      subBatchCount: 0,
    };
  }
  if (context.batchTurns.length === 0) {
    return {
      ok: true,
      candidates: [],
      estimatedPromptChars: 0,
      extractionAttemptCount: 0,
      usedSubBatchFallback: false,
      subBatchCount: 0,
    };
  }

  const prompt = buildDurableMemoryExtractionPrompt(context);
  if (prompt.estimatedPromptChars > EXTRACTION_PROMPT_SAFE_CHAR_BUDGET && context.batchTurns.length > 1) {
    const parts = splitExtractionContext(context);
    let estimatedPromptChars = prompt.estimatedPromptChars;
    let extractionAttemptCount = 0;
    const mergedCandidates: ExtractedDurableMemoryCandidate[] = [];
    for (const part of parts) {
      const result = await extractDurableMemoryCandidatesFromModel(part);
      extractionAttemptCount += result.extractionAttemptCount;
      estimatedPromptChars = Math.max(estimatedPromptChars, result.estimatedPromptChars);
      if (!result.ok) {
        return {
          ok: false,
          failureReason: result.failureReason,
          estimatedPromptChars,
          extractionAttemptCount,
          usedSubBatchFallback: true,
          subBatchCount: parts.length,
        };
      }
      mergedCandidates.push(...result.candidates);
    }
    return {
      ok: true,
      candidates: mergeExtractedCandidates(mergedCandidates),
      estimatedPromptChars,
      extractionAttemptCount,
      usedSubBatchFallback: true,
      subBatchCount: parts.length,
    };
  }

  const singleBatch = await extractDurableMemoryCandidatesSingleBatch(context);
  if (singleBatch.ok) {
    return {
      ok: true,
      candidates: singleBatch.candidates,
      estimatedPromptChars: singleBatch.estimatedPromptChars,
      extractionAttemptCount: 1,
      usedSubBatchFallback: false,
      subBatchCount: 1,
    };
  }
  if (context.batchTurns.length > 1) {
    const parts = splitExtractionContext(context);
    let estimatedPromptChars = singleBatch.estimatedPromptChars;
    let extractionAttemptCount = 1;
    const mergedCandidates: ExtractedDurableMemoryCandidate[] = [];
    for (const part of parts) {
      const result = await extractDurableMemoryCandidatesFromModel(part);
      extractionAttemptCount += result.extractionAttemptCount;
      estimatedPromptChars = Math.max(estimatedPromptChars, result.estimatedPromptChars);
      if (!result.ok) {
        return {
          ok: false,
          failureReason: result.failureReason,
          estimatedPromptChars,
          extractionAttemptCount,
          usedSubBatchFallback: true,
          subBatchCount: parts.length,
        };
      }
      mergedCandidates.push(...result.candidates);
    }
    return {
      ok: true,
      candidates: mergeExtractedCandidates(mergedCandidates),
      estimatedPromptChars,
      extractionAttemptCount,
      usedSubBatchFallback: true,
      subBatchCount: parts.length,
    };
  }
  return {
    ok: false,
    failureReason: singleBatch.failureReason ?? "model_request_failed",
    estimatedPromptChars: singleBatch.estimatedPromptChars,
    extractionAttemptCount: 1,
    usedSubBatchFallback: false,
    subBatchCount: 1,
  };
}
