import type { MemoryRetrievalIntent } from "./memory-retrieval-intent.js";

export type MemoryRetrievalCategory = "workspace";
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
  account_namespace?: string | null;
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

function nonEmptyText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function linesSection(lines: string[]): string {
  return lines.filter((line) => line.trim().length > 0).join("\n").trim();
}

/**
 * Renders a recalled-memory pack into the prompt fragment the agent sees. Lives
 * with the Memory cluster (not prompt assembly) so the prompt layer receives an
 * opaque, pre-rendered string and never depends on the recall shape — the
 * caller invokes recall and passes the result through here (migration.md
 * Phase 1 forward-incompat #2). Returns "" when there is nothing to show.
 */
export function renderRecalledMemoryPromptSection(
  context: AgentRecalledMemoryContext | null | undefined,
): string {
  const retrievalPack = context?.retrieval_pack ?? null;
  const evidence = Array.isArray(context?.evidence) ? context.evidence : [];
  const gaps = Array.isArray(context?.gaps)
    ? context.gaps
    : Array.isArray(retrievalPack?.open_questions)
      ? retrievalPack.open_questions
      : [];
  const coverage = context?.coverage ?? null;
  const hasPack =
    retrievalPack
    && (
      (Array.isArray(retrievalPack.known_facts) && retrievalPack.known_facts.length > 0)
      || (Array.isArray(retrievalPack.recent_high_signal_items) && retrievalPack.recent_high_signal_items.length > 0)
      || (Array.isArray(retrievalPack.constraints) && retrievalPack.constraints.length > 0)
      || (Array.isArray(retrievalPack.blockers) && retrievalPack.blockers.length > 0)
      || gaps.length > 0
      || nonEmptyText(retrievalPack.recommended_next_source)
    );
  if (evidence.length === 0 && !hasPack) {
    return "";
  }

  const lines = [
    "Recalled durable memory:",
    "Use this as recalled context, not as guaranteed current truth. Rely on freshness state, coverage, and live-verification hints before acting on workspace-sensitive details.",
  ];

  const intent = nonEmptyText(context?.intent);
  if (intent) {
    lines.push(`Retrieval intent: \`${intent}\`.`);
  }

  if (hasPack && retrievalPack) {
    const renderSectionItems = (
      heading: string,
      items: Array<{
        category: string;
        kind: string;
        title: string;
        summary: string;
        freshness_state: string;
        score: number;
      }> | null | undefined,
    ) => {
      if (!Array.isArray(items) || items.length === 0) {
        return;
      }
      lines.push(`${heading}:`);
      for (const item of items.slice(0, 4)) {
        lines.push(
          `- [${item.category}/${item.kind}] ${item.title}: ${item.summary} Freshness: \`${item.freshness_state}\`. Score: ${item.score.toFixed(2)}.`,
        );
      }
    };

    renderSectionItems("Known facts", retrievalPack.known_facts);
    renderSectionItems("Recent high-signal items", retrievalPack.recent_high_signal_items);
    renderSectionItems("Constraints", retrievalPack.constraints);
    renderSectionItems("Blockers", retrievalPack.blockers);

    if (gaps.length > 0) {
      lines.push("Open questions:");
      for (const gap of gaps.slice(0, 4)) {
        lines.push(`- ${gap.question} Best source: \`${gap.best_source}\`.`);
      }
    }
    const recommendedNextSource = nonEmptyText(retrievalPack.recommended_next_source);
    if (recommendedNextSource) {
      lines.push(`Recommended next source: \`${recommendedNextSource}\`.`);
    }
    if (retrievalPack.recommended_next_step) {
      lines.push(
        `Recommended next step: \`${retrievalPack.recommended_next_step.type}\` via \`${retrievalPack.recommended_next_step.source ?? "memory"}\` - ${retrievalPack.recommended_next_step.reason}`,
      );
    }
  }

  if (coverage) {
    lines.push(
      `Coverage: confidence=\`${nonEmptyText(coverage.confidence) || "unknown"}\`, vector=${coverage.used_vector === true ? "yes" : "no"}, lexical=${coverage.used_lexical === true ? "yes" : "no"}, neighbors=${coverage.used_neighbors === true ? "yes" : "no"}.`,
    );
  }

  if (evidence.length > 0) {
    lines.push("Evidence:");
    for (const item of evidence.slice(0, 5)) {
      const summary = nonEmptyText(item.summary_for_prompt) || nonEmptyText(item.summary) || "No summary available.";
      const freshnessNote = nonEmptyText(item.freshness_note);
      const sourceLabel = nonEmptyText(item.source_label);
      const sourceSuffix = sourceLabel ? ` Source: ${sourceLabel}.` : "";
      const freshnessSuffix = freshnessNote ? ` ${freshnessNote}` : "";
      lines.push(
        `- [${item.category}/${item.kind}] ${summary} Freshness: \`${item.freshness_state}\`. Score: ${item.score.toFixed(2)}. Reasons: ${item.reasons.join(", ") || "none"}.${sourceSuffix}${freshnessSuffix}`,
      );
    }
  }

  return linesSection(lines);
}
