import type { MemoryRetrievalIntent } from "./memory-retrieval-intent.js";

export type MemoryRetrievalCategory = "interaction" | "integration";
export type MemoryRetrievalFreshnessState = "stable" | "fresh" | "stale";
export type MemoryRetrievalLlmBucket =
  | "known_fact"
  | "high_signal"
  | "constraint"
  | "blocker"
  | "open_question"
  | "other";

export interface MemoryRetrievalSectionItem {
  evidence_id: string;
  category: MemoryRetrievalCategory;
  kind: string;
  title: string;
  summary: string;
  freshness_state: MemoryRetrievalFreshnessState;
  score: number;
  reason?: string | null;
}

export interface MemoryRetrievalGap {
  question: string;
  best_source: string;
  reason?: string | null;
}

export interface MemoryRetrievalPack {
  known_facts: MemoryRetrievalSectionItem[];
  recent_high_signal_items: MemoryRetrievalSectionItem[];
  constraints: MemoryRetrievalSectionItem[];
  blockers: MemoryRetrievalSectionItem[];
  open_questions: MemoryRetrievalGap[];
  recommended_next_source: string | null;
  recommended_next_step: {
    type: "answer_from_memory" | "verify_live_state";
    source: string | null;
    reason: string;
  } | null;
}

export interface MemoryRetrievalEvidence {
  id: string;
  category: MemoryRetrievalCategory;
  kind: string;
  tree_id: string;
  title: string;
  summary: string;
  excerpt?: string | null;
  freshness_state: MemoryRetrievalFreshnessState;
  freshness_note: string;
  score: number;
  reasons: string[];
  observed_at?: string | null;
  updated_at?: string | null;
  source_label?: string | null;
  entity_name?: string | null;
  entity_type?: string | null;
  provider?: string | null;
  account_label?: string | null;
  llm_bucket?: MemoryRetrievalLlmBucket | null;
  llm_reason?: string | null;
  needs_live_verification?: boolean | null;
}

export interface MemoryRetrievalPromptEvidence extends MemoryRetrievalEvidence {
  summary_for_prompt?: string | null;
}

export interface MemoryRetrievalCoverage {
  used_lexical: boolean;
  used_vector: boolean;
  used_neighbors: boolean;
  confidence: "low" | "medium" | "high";
}

export interface AgentRecalledMemoryContext {
  intent?: MemoryRetrievalIntent | string | null;
  retrieval_pack?: MemoryRetrievalPack | null;
  evidence?: MemoryRetrievalPromptEvidence[] | null;
  gaps?: MemoryRetrievalGap[] | null;
  coverage?: MemoryRetrievalCoverage | null;
  entries?: Array<{
    scope: string;
    memory_type: string;
    title: string;
    summary: string;
    path: string;
    verification_policy: string;
    staleness_policy?: string | null;
    freshness_state?: string | null;
    freshness_note?: string | null;
    source_type?: string | null;
    observed_at?: string | null;
    last_verified_at?: string | null;
    confidence?: number | null;
    updated_at?: string | null;
    excerpt?: string | null;
  }> | null;
  selection_trace?: Array<{
    memory_id: string;
    score: number;
    freshness_state: string;
    matched_tokens: string[];
    reasons: string[];
    source_type?: string | null;
  }> | null;
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

export function summarizeEvidenceForPrompt(
  evidence: Pick<MemoryRetrievalEvidence, "title" | "summary">,
): string {
  return clipText(`${evidence.title}: ${evidence.summary}`, 220);
}

export function buildAgentRecalledMemoryContext(params: {
  intent: MemoryRetrievalIntent | string | null;
  retrievalPack: MemoryRetrievalPack;
  evidence: MemoryRetrievalEvidence[];
  gaps: MemoryRetrievalGap[];
  coverage: MemoryRetrievalCoverage;
}): AgentRecalledMemoryContext {
  return {
    intent: params.intent ?? null,
    retrieval_pack: params.retrievalPack,
    evidence: params.evidence.map((evidence) => ({
      ...evidence,
      summary_for_prompt: summarizeEvidenceForPrompt(evidence),
    })),
    gaps: params.gaps,
    coverage: params.coverage,
  };
}
