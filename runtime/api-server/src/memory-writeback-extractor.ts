import type { MemoryEntryType } from "@holaboss/runtime-state-store";

import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { queryMemoryModelJson } from "./memory-model-client.js";

export interface DurableMemoryExtractionContext {
  modelClient: MemoryModelClientConfig | null;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  instruction: string;
  assistantText: string;
  recentUserMessages: string[];
  recentTurnSummaries: string[];
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

export async function extractDurableMemoryCandidatesFromModel(
  context: DurableMemoryExtractionContext
): Promise<ExtractedDurableMemoryCandidate[]> {
  if (!context.modelClient) {
    return [];
  }
  const payload = await queryMemoryModelJson(context.modelClient, {
    systemPrompt:
      "Extract contextual durable memory from this turn. Return strict JSON only with this shape: " +
      '{"memories":[{"scope":"workspace","memory_type":"fact|procedure|blocker|reference","subject_key":"string","title":"string","summary":"string","tags":["string"],"evidence":"string","confidence":0.0}]}. ' +
      "Only include contextual memories worth retrieving later when the relevant subject comes up again. " +
      "Include customer, project, person, vendor, or system facts; subject-specific procedures tied to a concrete customer, project, workflow, or operating context; and durable decisions, outcomes, blockers, or references likely to matter later. " +
      "Do not include workspace-wide defaults, rules, conventions, response-style preferences, recurring commands, default verification/build/test commands, default release or verification procedures, or general operating instructions that should instead live in AGENTS.md. " +
      "Do not include temporary runtime details, one-off requests, transient execution state, or near-paraphrases of the same memory from this turn. " +
      "Prefer memories about a concrete subject, not generic workspace behavior. " +
      "Only include memories that were explicitly stated or strongly implied by the user or assistant in the current turn. " +
      "Use recent context only to disambiguate or corroborate what changed in the current turn. " +
      "Do not re-emit unchanged memories solely because they appear in recent context. " +
      "If a candidate sounds like something the agent should obey by default on nearly every future run, exclude it.",
    userPrompt: [
      `Workspace ID: ${context.workspaceId}`,
      `Session ID: ${context.sessionId}`,
      `Input ID: ${context.inputId}`,
      "",
      `Current user instruction: ${context.instruction}`,
      "",
      "Recent user messages:",
      ...(context.recentUserMessages.length > 0 ? context.recentUserMessages.map((line) => `- ${line}`) : ["- none"]),
      "",
      "Recent turn summaries:",
      ...(context.recentTurnSummaries.length > 0 ? context.recentTurnSummaries.map((line) => `- ${line}`) : ["- none"]),
      "",
      "Latest assistant response:",
      context.assistantText || "none",
    ].join("\n"),
    timeoutMs: 8000,
  });
  if (!payload || !Array.isArray(payload.memories)) {
    return [];
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
  return candidates;
}
