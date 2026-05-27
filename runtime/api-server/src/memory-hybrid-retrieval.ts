import type { IntegrationMemoryRetrieveHit } from "./integration-memory.js";
import type { InteractionMemoryRetrieveHit } from "./interaction-memory.js";
import type {
  MemoryRetrievalCategory,
  MemoryRetrievalCoverage,
  MemoryRetrievalEvidence,
  MemoryRetrievalGap,
  MemoryRetrievalPack,
  MemoryRetrievalSectionItem,
} from "./memory-retrieval-pack.js";
import {
  inferMemoryRetrievalIntent,
  normalizeMemoryRetrievalIntent,
  type MemoryRetrievalIntent,
} from "./memory-retrieval-intent.js";
import {
  highSignalScore,
  rerankMemoryCandidatesWithLlm,
} from "./memory-reranker.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";

export type MemoryRetrievalFreshnessBias = "low" | "medium" | "high";

export interface MemoryRetrievalPolicy {
  hybrid?: boolean | null;
  include_neighbors?: boolean | null;
  freshness_bias?: MemoryRetrievalFreshnessBias | null;
  prefer_high_signal?: boolean | null;
  max_evidence?: number | null;
}

export interface MemoryHybridRetrieveResult {
  query: string;
  intent: MemoryRetrievalIntent;
  answer_goal: string | null;
  categories: MemoryRetrievalCategory[];
  retrieval_pack: MemoryRetrievalPack;
  evidence: MemoryRetrievalEvidence[];
  gaps: MemoryRetrievalGap[];
  coverage: MemoryRetrievalCoverage;
}

interface NormalizedMemoryRetrievalPolicy {
  hybrid: boolean;
  include_neighbors: boolean;
  freshness_bias: MemoryRetrievalFreshnessBias;
  prefer_high_signal: boolean;
  max_evidence: number;
}

type HybridCandidate =
  | ({ category: "interaction" } & InteractionMemoryRetrieveHit)
  | IntegrationMemoryRetrieveHit;

interface NormalizedCandidate {
  candidate: HybridCandidate;
  evidence: MemoryRetrievalEvidence;
  baseScore: number;
  tokenKey: string;
  relationKey: string;
  signalScore: number;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  const matches = compactWhitespace(value).toLowerCase().match(/[a-z0-9]{2,}/g);
  return matches ? [...new Set(matches)] : [];
}

function inferFreshnessState(params: {
  category: MemoryRetrievalCategory;
  updatedAt?: string | null;
  entityType?: string | null;
}): "stable" | "fresh" | "stale" {
  if (params.category === "interaction" && (params.entityType === "preference" || params.entityType === "identity")) {
    return "stable";
  }
  const updatedAt = Date.parse(params.updatedAt ?? "");
  if (!Number.isFinite(updatedAt)) {
    return "fresh";
  }
  const ageDays = (Date.now() - updatedAt) / (1000 * 60 * 60 * 24);
  if (ageDays > 45) {
    return "stale";
  }
  return "fresh";
}

function freshnessNote(evidence: MemoryRetrievalEvidence): string {
  if (evidence.category === "interaction") {
    if (evidence.entity_name) {
      return `${evidence.kind} memory from ${evidence.entity_name}.`;
    }
    return `${evidence.kind} interaction memory.`;
  }
  if (evidence.provider && evidence.account_label) {
    return `${evidence.kind} memory from ${evidence.provider} account ${evidence.account_label}.`;
  }
  return `${evidence.kind} integration memory.`;
}

function candidateToEvidence(candidate: HybridCandidate): MemoryRetrievalEvidence {
  if (candidate.category === "interaction") {
    const freshnessState = inferFreshnessState({
      category: "interaction",
      updatedAt: candidate.updated_at,
      entityType: candidate.entity_type,
    });
    const evidence: MemoryRetrievalEvidence = {
      id: candidate.node_id,
      category: "interaction",
      kind: candidate.node_kind,
      tree_id: candidate.tree_id,
      title: candidate.title,
      summary: candidate.summary,
      excerpt: candidate.excerpt,
      freshness_state: freshnessState,
      freshness_note: "",
      score: candidate.score,
      reasons: [...candidate.reasons],
      observed_at: candidate.observed_at,
      updated_at: candidate.updated_at,
      source_label: candidate.entity_name,
      entity_name: candidate.entity_name,
      entity_type: candidate.entity_type,
      provider: null,
      account_label: null,
    };
    evidence.freshness_note = freshnessNote(evidence);
    return evidence;
  }
  const freshnessState = inferFreshnessState({
    category: "integration",
    updatedAt: candidate.updated_at,
  });
  const evidence: MemoryRetrievalEvidence = {
    id: candidate.node_id,
    category: "integration",
    kind: candidate.node_kind,
    tree_id: candidate.tree_id,
    title: candidate.title,
    summary: candidate.summary,
    excerpt: candidate.excerpt,
    freshness_state: freshnessState,
    freshness_note: "",
    score: candidate.score,
    reasons: [...candidate.reasons],
    observed_at: candidate.observed_at,
    updated_at: candidate.updated_at,
    source_label: candidate.account_label,
    entity_name: null,
    entity_type: null,
    provider: candidate.provider,
    account_label: candidate.account_label,
  };
  evidence.freshness_note = freshnessNote(evidence);
  return evidence;
}

function normalizePolicy(
  policy: MemoryRetrievalPolicy | null | undefined,
): NormalizedMemoryRetrievalPolicy {
  const freshnessBias = policy?.freshness_bias;
  return {
    hybrid: policy?.hybrid !== false,
    include_neighbors: policy?.include_neighbors !== false,
    freshness_bias:
      freshnessBias === "low" || freshnessBias === "medium" || freshnessBias === "high"
        ? freshnessBias
        : "medium",
    prefer_high_signal: policy?.prefer_high_signal !== false,
    max_evidence: Math.max(1, Math.min(policy?.max_evidence ?? 8, 20)),
  };
}

function mergeHybridCandidates(candidates: HybridCandidate[]): HybridCandidate[] {
  const merged = new Map<string, HybridCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.category}:${candidate.node_id}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    const existingReasons = new Set(existing.reasons);
    for (const reason of candidate.reasons) {
      existingReasons.add(reason);
    }
    const preferred = candidate.score > existing.score ? candidate : existing;
    merged.set(key, {
      ...preferred,
      excerpt: preferred.excerpt ?? existing.excerpt ?? candidate.excerpt ?? null,
      score: Math.max(existing.score, candidate.score),
      reasons: [...existingReasons],
    });
  }
  return [...merged.values()];
}

function candidateSectionItem(evidence: MemoryRetrievalEvidence, reason?: string | null): MemoryRetrievalSectionItem {
  return {
    evidence_id: evidence.id,
    category: evidence.category,
    kind: evidence.kind,
    title: evidence.title,
    summary: evidence.summary,
    freshness_state: evidence.freshness_state,
    score: evidence.score,
    reason: reason ?? null,
  };
}

function buildRecommendedNextSource(
  intent: MemoryRetrievalIntent,
  evidence: MemoryRetrievalEvidence[],
  llmRecommendedNextSource?: string | null,
): string | null {
  if (llmRecommendedNextSource) {
    return llmRecommendedNextSource;
  }
  const topIntegration = evidence.find((item) => item.category === "integration" && item.provider);
  if (topIntegration?.provider) {
    return topIntegration.provider;
  }
  if (intent === "briefing" || intent === "delta") {
    return evidence.some((item) => item.category === "interaction") ? "memory" : null;
  }
  return evidence.length > 0 ? "memory" : null;
}

function uniqueById<T extends { evidence_id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.evidence_id)) {
      continue;
    }
    seen.add(item.evidence_id);
    out.push(item);
  }
  return out;
}

function buildGaps(params: {
  intent: MemoryRetrievalIntent;
  evidence: MemoryRetrievalEvidence[];
  recommendedNextSource: string | null;
  llmNeedsLiveVerification?: boolean | null;
}): MemoryRetrievalGap[] {
  if (!params.recommendedNextSource || params.recommendedNextSource === "memory") {
    return [];
  }
  if (params.llmNeedsLiveVerification === false) {
    return [];
  }
  if (params.intent === "fact_lookup" || params.intent === "procedure_lookup") {
    const top = params.evidence[0];
    if (!top || top.score >= 5 || top.freshness_state === "stable") {
      return [];
    }
  }
  const prioritized = params.evidence
    .filter((item) => item.needs_live_verification !== false)
    .slice(0, 3);
  return prioritized.map((item) => ({
    question:
      params.intent === "delta"
        ? `What changed recently around "${item.title}"?`
        : params.intent === "briefing"
          ? `Does "${item.title}" still require attention right now?`
          : `Should "${item.title}" be verified before acting?`,
    best_source: params.recommendedNextSource ?? "memory",
    reason: item.category === "integration"
      ? `Top recalled evidence is integration-specific and may have changed since ${item.updated_at ?? "the last sync"}.`
      : "Top recalled evidence may need a direct check before action.",
  }));
}

function buildPack(params: {
  intent: MemoryRetrievalIntent;
  evidence: MemoryRetrievalEvidence[];
  recommendedNextSource: string | null;
  gaps: MemoryRetrievalGap[];
}): MemoryRetrievalPack {
  const sortedEvidence = params.evidence;
  const highSignal = sortedEvidence
    .filter((item) => item.llm_bucket === "high_signal" || highSignalScore(`${item.title}\n${item.summary}`) > 0 || item.category === "integration")
    .map((item) => candidateSectionItem(item, "high_signal"))
    .slice(0, 5);
  const blockers = sortedEvidence
    .filter((item) => item.llm_bucket === "blocker" || /(block|blocked|blocker|denied|approval|waiting|escalat|incident|risk)/i.test(`${item.title}\n${item.summary}`))
    .map((item) => candidateSectionItem(item, "blocker_or_risk"))
    .slice(0, 4);
  const constraints = sortedEvidence
    .filter((item) => item.llm_bucket === "constraint" || /(policy|permission|owner|approver|threshold|deadline|review|contact|channel|url|link|requires|must)/i.test(`${item.title}\n${item.summary}`))
    .map((item) => candidateSectionItem(item, "constraint_or_dependency"))
    .slice(0, 4);

  const knownFactsSource =
    params.intent === "briefing" || params.intent === "delta"
      ? sortedEvidence.filter((item) => item.llm_bucket === "known_fact" || item.category === "interaction")
      : sortedEvidence;
  const knownFacts = uniqueById(
    knownFactsSource
      .slice(0, 4)
      .map((item) => candidateSectionItem(item, params.intent === "procedure_lookup" ? "procedure_context" : "recalled_fact")),
  );

  const recentHighSignalItems = uniqueById(
    (params.intent === "briefing" || params.intent === "delta" ? highSignal : sortedEvidence.map((item) => candidateSectionItem(item)))
      .slice(0, 5),
  );

  return {
    known_facts: knownFacts,
    recent_high_signal_items: recentHighSignalItems,
    constraints: uniqueById(constraints),
    blockers: uniqueById(blockers),
    open_questions: params.gaps,
    recommended_next_source: params.recommendedNextSource,
    recommended_next_step: {
      type: params.gaps.length > 0 ? "verify_live_state" : "answer_from_memory",
      source: params.gaps.length > 0 ? params.recommendedNextSource : "memory",
      reason: params.gaps.length > 0
        ? "Top recalled items still have live-state uncertainty that should be narrowed through a direct source."
        : "Recalled memory is coherent enough to answer before broadening to another source.",
    },
  };
}

export async function buildMemoryHybridRetrievalResult(params: {
  query: string;
  requestedIntent?: unknown;
  answerGoal?: string | null;
  categories: MemoryRetrievalCategory[];
  interactionHits: InteractionMemoryRetrieveHit[];
  integrationHits: IntegrationMemoryRetrieveHit[];
  retrievalPolicy?: MemoryRetrievalPolicy | null;
  allowedTreeIds?: string[] | null;
  modelClient?: MemoryModelClientConfig | null;
}): Promise<MemoryHybridRetrieveResult> {
  const policy = normalizePolicy(params.retrievalPolicy);
  const intent = normalizeMemoryRetrievalIntent(params.requestedIntent) ?? inferMemoryRetrievalIntent(params.query);
  const allowedTreeIds = Array.isArray(params.allowedTreeIds)
    ? params.allowedTreeIds.map((item) => compactWhitespace(item)).filter(Boolean)
    : [];
  const allCandidates = mergeHybridCandidates([
    ...params.interactionHits.map((hit) => ({ category: "interaction", ...hit }) as const),
    ...params.integrationHits,
  ]).filter((candidate) =>
    allowedTreeIds.length === 0 ? true : allowedTreeIds.includes(candidate.tree_id),
  );

  const normalized = allCandidates.map((candidate) => {
    const evidence = candidateToEvidence(candidate);
    const tokenKey = tokenize(`${candidate.title} ${candidate.summary}`).join("|");
    const relationKey =
      candidate.category === "interaction"
        ? `${candidate.entity_id}:${candidate.tree_id}`
        : `${candidate.tree_id}:${candidate.provider}:${candidate.account_key}`;
    return {
      candidate,
      evidence,
      baseScore: candidate.score,
      tokenKey,
      relationKey,
      signalScore: highSignalScore(`${candidate.title}\n${candidate.summary}`),
    } satisfies NormalizedCandidate;
  });

  const rerankResult = await rerankMemoryCandidatesWithLlm({
    query: params.query,
    intent,
    candidates: normalized,
    policy: {
      freshness_bias: policy.freshness_bias,
      include_neighbors: policy.include_neighbors,
      prefer_high_signal: policy.prefer_high_signal,
    },
    modelClient: params.modelClient ?? null,
  });
  const reranked = rerankResult.rankedEvidence;

  const evidenceById = new Map<string, MemoryRetrievalEvidence>();
  for (const item of reranked) {
    const key = `${item.category}:${item.id}`;
    if (!evidenceById.has(key)) {
      evidenceById.set(key, item);
    }
  }
  const evidence = [...evidenceById.values()].slice(0, policy.max_evidence);
  const recommendedNextSource = buildRecommendedNextSource(
    intent,
    evidence,
    rerankResult.recommendedNextSource,
  );
  const gaps = buildGaps({
    intent,
    evidence,
    recommendedNextSource,
    llmNeedsLiveVerification: rerankResult.needsLiveVerification,
  });
  const retrievalPack = buildPack({
    intent,
    evidence,
    recommendedNextSource,
    gaps,
  });

  return {
    query: params.query,
    intent,
    answer_goal: params.answerGoal ?? null,
    categories: params.categories,
    retrieval_pack: retrievalPack,
    evidence,
    gaps,
    coverage: {
      used_lexical: evidence.some((item) => item.reasons.includes("lexical_match")),
      used_vector: evidence.some((item) => item.reasons.includes("embedding_similarity")),
      used_neighbors: evidence.some((item) => item.reasons.includes("neighbor_context")),
      confidence: evidence.length === 0
        ? "low"
        : evidence[0].score >= 5
          ? "high"
          : evidence[0].score >= 2.5
            ? "medium"
            : "low",
    },
  };
}
