import type { MemoryRetrievalIntent } from "./memory-retrieval-intent.js";
import {
  queryMemoryModelJson,
  type MemoryModelClientConfig,
} from "./memory-model-client.js";

export type MemoryRerankerCategory = "interaction" | "integration";
export type MemoryRerankerFreshnessState = "stable" | "fresh" | "stale";
export type MemoryRerankerFreshnessBias = "low" | "medium" | "high";

export interface MemoryRerankerPolicy {
  freshness_bias: MemoryRerankerFreshnessBias;
  include_neighbors: boolean;
  prefer_high_signal: boolean;
}

export interface BaseMemoryRerankerEvidence {
  id: string;
  category: MemoryRerankerCategory;
  kind: string;
  title: string;
  summary: string;
  freshness_state: MemoryRerankerFreshnessState;
  score: number;
  reasons: string[];
  observed_at?: string | null;
  updated_at?: string | null;
  provider?: string | null;
  entity_type?: string | null;
  llm_bucket?: "known_fact" | "high_signal" | "constraint" | "blocker" | "open_question" | "other" | null;
  llm_reason?: string | null;
  needs_live_verification?: boolean | null;
}

export interface MemoryRerankerCandidate<TEvidence extends BaseMemoryRerankerEvidence = BaseMemoryRerankerEvidence> {
  evidence: TEvidence;
  baseScore: number;
  tokenKey: string;
  relationKey: string;
  signalScore: number;
}

export interface MemoryRerankerResult<TEvidence extends BaseMemoryRerankerEvidence = BaseMemoryRerankerEvidence> {
  rankedEvidence: TEvidence[];
  recommendedNextSource: string | null;
  needsLiveVerification: boolean | null;
  verificationReason: string | null;
  usedLlm: boolean;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  const matches = compactWhitespace(value).toLowerCase().match(/[a-z0-9]{2,}/g);
  return matches ? [...new Set(matches)] : [];
}

function parseTimestamp(...values: Array<string | null | undefined>): number | null {
  for (const value of values) {
    const parsed = Date.parse(value ?? "");
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function ageDays(...values: Array<string | null | undefined>): number | null {
  const timestamp = parseTimestamp(...values);
  if (timestamp == null) {
    return null;
  }
  return (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
}

function queryOverlapScore(queryTokens: string[], tokenKey: string, fallbackText: string): number {
  const candidateTokens = tokenKey
    ? tokenKey.split("|").filter(Boolean)
    : tokenize(fallbackText);
  if (queryTokens.length === 0 || candidateTokens.length === 0) {
    return 0;
  }
  const candidateSet = new Set(candidateTokens);
  let matches = 0;
  for (const token of queryTokens) {
    if (candidateSet.has(token)) {
      matches += 1;
    }
  }
  if (matches === 0) {
    return 0;
  }
  return Math.min(1.2, matches * 0.22);
}

function hasPattern(pattern: RegExp, evidence: BaseMemoryRerankerEvidence): boolean {
  return pattern.test(`${evidence.title}\n${evidence.summary}`);
}

export function highSignalScore(value: string): number {
  const haystack = value.toLowerCase();
  let score = 0;
  if (/(urgent|important|escalat|incident|blocked|blocker|denied|approval|waiting|reply|deadline|risk)/.test(haystack)) {
    score += 1.5;
  }
  if (/(owner|approver|policy|permission|review|release|customer|investor)/.test(haystack)) {
    score += 0.8;
  }
  return score;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? compactWhitespace(value) : "";
}

function normalizeBucket(value: unknown): BaseMemoryRerankerEvidence["llm_bucket"] {
  const normalized = nonEmptyString(value).toLowerCase();
  switch (normalized) {
    case "known_fact":
    case "high_signal":
    case "constraint":
    case "blocker":
    case "open_question":
    case "other":
      return normalized;
    default:
      return null;
  }
}

function normalizeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function urgencyScore(evidence: BaseMemoryRerankerEvidence): number {
  let score = 0;
  if (hasPattern(/(urgent|incident|sev|outage|blocked|blocker|deadline|escalat|critical|denied|risk)/i, evidence)) {
    score += 1.2;
  }
  if (hasPattern(/(waiting|reply|approval|review|triage|follow[- ]?up)/i, evidence)) {
    score += 0.7;
  }
  return score;
}

function recencyScore(evidence: BaseMemoryRerankerEvidence): number {
  const days = ageDays(evidence.updated_at, evidence.observed_at);
  if (days == null) {
    return 0;
  }
  if (days <= 1) {
    return 1.1;
  }
  if (days <= 3) {
    return 0.85;
  }
  if (days <= 7) {
    return 0.55;
  }
  if (days <= 30) {
    return 0.25;
  }
  if (days <= 90) {
    return 0;
  }
  return -0.25;
}

function noveltyScore(evidence: BaseMemoryRerankerEvidence): number {
  let score = 0;
  const recency = recencyScore(evidence);
  if (recency >= 0.85) {
    score += 0.8;
  } else if (recency >= 0.55) {
    score += 0.45;
  } else if (recency >= 0.25) {
    score += 0.15;
  }
  if (hasPattern(/(new|changed|change|updated|latest|reopened|moved|rescheduled|escalat|reassigned)/i, evidence)) {
    score += 0.9;
  }
  return score;
}

function actionabilityScore(evidence: BaseMemoryRerankerEvidence): number {
  let score = 0;
  if (hasPattern(/(reply|respond|owner|approv|review|triage|verify|fix|resolve|unblock|follow[- ]?up)/i, evidence)) {
    score += 0.9;
  }
  if (hasPattern(/(must|need to|needs|should|required|action)/i, evidence)) {
    score += 0.55;
  }
  if (hasPattern(/(command|procedure|steps|workflow|runbook|checklist)/i, evidence)) {
    score += 0.35;
  }
  return score;
}

function contradictionRiskScore(evidence: BaseMemoryRerankerEvidence): number {
  let score = 0;
  if (hasPattern(/(contradict|conflict|mismatch|reversed?|override|exception|dispute|denied|reopened)/i, evidence)) {
    score += 0.85;
  }
  if (hasPattern(/(changed owner|owner changed|approval changed|reassigned)/i, evidence)) {
    score += 0.4;
  }
  return score;
}

function directUserImpactScore(evidence: BaseMemoryRerankerEvidence): number {
  let score = 0;
  if (hasPattern(/(customer|client|investor|finance|invoice|billing|payment|incident|security|release|production)/i, evidence)) {
    score += 1;
  }
  if (hasPattern(/(team|teammate|ops|manager|lead|approval)/i, evidence)) {
    score += 0.45;
  }
  return score;
}

function intentSpecificScore(params: {
  intent: MemoryRetrievalIntent;
  evidence: BaseMemoryRerankerEvidence;
  queryTokens: string[];
  tokenKey: string;
  signalScore: number;
}): { score: number; reasons: string[] } {
  const { evidence, intent, queryTokens, tokenKey, signalScore } = params;
  const reasons: string[] = [];
  let score = 0;
  const overlap = queryOverlapScore(queryTokens, tokenKey, `${evidence.title} ${evidence.summary}`);
  if (overlap > 0) {
    score += overlap;
    reasons.push("query_overlap");
  }

  const recency = recencyScore(evidence);
  const novelty = noveltyScore(evidence);
  const urgency = urgencyScore(evidence);
  const actionability = actionabilityScore(evidence);
  const contradiction = contradictionRiskScore(evidence);
  const impact = directUserImpactScore(evidence);

  switch (intent) {
    case "procedure_lookup":
      if (hasPattern(/(procedure|steps|workflow|runbook|how|command|verify|checklist)/i, evidence)) {
        score += 1.1;
        reasons.push("intent_procedure");
      }
      score += actionability * 0.35;
      if (evidence.kind === "leaf") {
        score += 0.25;
        reasons.push("leaf_specificity");
      }
      break;
    case "briefing":
      score += signalScore;
      score += urgency * 0.75;
      score += novelty * 0.6;
      score += actionability * 0.55;
      score += impact * 0.65;
      score += contradiction * 0.55;
      if (evidence.category === "integration") {
        score += 0.6;
      }
      reasons.push("intent_briefing");
      if (urgency > 0) {
        reasons.push("urgency");
      }
      if (impact > 0) {
        reasons.push("direct_user_impact");
      }
      break;
    case "planning":
      if (hasPattern(/(owner|approver|dependency|block|permission|policy|deadline|review)/i, evidence)) {
        score += 1;
        reasons.push("intent_planning");
      }
      score += actionability * 0.65;
      score += impact * 0.35;
      score += contradiction * 0.5;
      score += Math.max(recency, 0) * 0.2;
      break;
    case "delta":
      score += novelty * 1.2;
      score += urgency * 0.4;
      score += impact * 0.35;
      score += contradiction * 0.7;
      if (evidence.category === "integration") {
        score += 0.35;
      }
      reasons.push("intent_delta");
      if (novelty > 0) {
        reasons.push("novelty");
      }
      break;
    case "fact_lookup":
    default:
      if (evidence.kind === "leaf") {
        score += 0.25;
        reasons.push("leaf_specificity");
      }
      score += Math.max(recency, 0) * 0.1;
      break;
  }

  return {
    score,
    reasons,
  };
}

function freshnessAdjustment(
  freshnessState: MemoryRerankerFreshnessState,
  bias: MemoryRerankerFreshnessBias,
): number {
  if (bias === "high") {
    return freshnessState === "fresh" ? 0.5 : freshnessState === "stable" ? 0.25 : -0.5;
  }
  if (bias === "medium") {
    return freshnessState === "fresh" ? 0.25 : freshnessState === "stale" ? -0.25 : 0.1;
  }
  return freshnessState === "stale" ? -0.1 : 0;
}

function categoryPenalty(intent: MemoryRetrievalIntent, count: number): number {
  if (count <= 0) {
    return 0;
  }
  if (intent === "briefing") {
    return 0.8 * count;
  }
  if (intent === "delta") {
    return 0.95 * count;
  }
  if (intent === "planning") {
    return 0.35 * count;
  }
  return 0;
}

function relationPenalty(intent: MemoryRetrievalIntent, count: number): number {
  if (count <= 0) {
    return 0;
  }
  if (intent === "briefing" || intent === "delta") {
    return 0.5 * count;
  }
  if (intent === "planning") {
    return 0.2 * count;
  }
  return 0;
}

function categoryBonus(
  intent: MemoryRetrievalIntent,
  availableCategories: Set<MemoryRerankerCategory>,
  seenCategories: Set<MemoryRerankerCategory>,
  candidateCategory: MemoryRerankerCategory,
): number {
  if (availableCategories.size < 2 || seenCategories.has(candidateCategory)) {
    return 0;
  }
  if (intent === "delta") {
    return 0.55;
  }
  if (intent === "briefing") {
    return 0.45;
  }
  if (intent === "planning") {
    return 0.2;
  }
  return 0;
}

export function rerankMemoryCandidates<TEvidence extends BaseMemoryRerankerEvidence>(params: {
  query: string;
  intent: MemoryRetrievalIntent;
  candidates: Array<MemoryRerankerCandidate<TEvidence>>;
  policy: MemoryRerankerPolicy;
}): TEvidence[] {
  const queryTokens = tokenize(params.query);
  const availableCategories = new Set<MemoryRerankerCategory>(
    params.candidates.map((candidate) => candidate.evidence.category),
  );
  const anchorCandidates = [...params.candidates]
    .sort((left, right) => right.baseScore - left.baseScore || left.evidence.title.localeCompare(right.evidence.title))
    .slice(0, Math.min(3, params.candidates.length));

  const prepared = params.candidates.map((candidate) => {
    const evidence = {
      ...candidate.evidence,
      reasons: [...candidate.evidence.reasons],
    };
    const reasons = new Set(evidence.reasons);
    let score = candidate.baseScore;

    const intentScore = intentSpecificScore({
      intent: params.intent,
      evidence,
      queryTokens,
      tokenKey: candidate.tokenKey,
      signalScore: candidate.signalScore,
    });
    score += intentScore.score;
    for (const reason of intentScore.reasons) {
      reasons.add(reason);
    }

    if (params.policy.prefer_high_signal && candidate.signalScore > 0) {
      score += candidate.signalScore * 0.35;
      reasons.add("high_signal");
    }

    score += freshnessAdjustment(evidence.freshness_state, params.policy.freshness_bias);
    if (evidence.freshness_state === "stale") {
      reasons.add("freshness_risk");
    }

    if (params.policy.include_neighbors) {
      const relatedAnchor = anchorCandidates.find((anchor) =>
        anchor.evidence.id !== evidence.id
        && (
          anchor.relationKey === candidate.relationKey
          || anchor.tokenKey === candidate.tokenKey
          || anchor.evidence.title === evidence.title
        ),
      );
      if (relatedAnchor) {
        score += 0.4;
        reasons.add("neighbor_context");
      }
    }

    evidence.score = Number(score.toFixed(3));
    evidence.reasons = [...reasons];
    return {
      evidence,
      relationKey: candidate.relationKey,
    };
  });

  const selected: TEvidence[] = [];
  const remaining = [...prepared];
  const seenCategories = new Set<MemoryRerankerCategory>();
  const categoryCounts = new Map<MemoryRerankerCategory, number>();
  const relationCounts = new Map<string, number>();

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestAdjustedScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      const categoryCount = categoryCounts.get(candidate.evidence.category) ?? 0;
      const relationCount = relationCounts.get(candidate.relationKey) ?? 0;
      const adjustedScore =
        candidate.evidence.score
        + categoryBonus(params.intent, availableCategories, seenCategories, candidate.evidence.category)
        - categoryPenalty(params.intent, categoryCount)
        - relationPenalty(params.intent, relationCount);
      if (
        adjustedScore > bestAdjustedScore
        || (
          adjustedScore === bestAdjustedScore
          && candidate.evidence.score > remaining[bestIndex].evidence.score
        )
      ) {
        bestAdjustedScore = adjustedScore;
        bestIndex = index;
      }
    }

    const [best] = remaining.splice(bestIndex, 1);
    selected.push(best.evidence);
    seenCategories.add(best.evidence.category);
    categoryCounts.set(best.evidence.category, (categoryCounts.get(best.evidence.category) ?? 0) + 1);
    relationCounts.set(best.relationKey, (relationCounts.get(best.relationKey) ?? 0) + 1);
  }

  return selected;
}

export async function rerankMemoryCandidatesWithLlm<TEvidence extends BaseMemoryRerankerEvidence>(params: {
  query: string;
  intent: MemoryRetrievalIntent;
  candidates: Array<MemoryRerankerCandidate<TEvidence>>;
  policy: MemoryRerankerPolicy;
  modelClient: MemoryModelClientConfig | null;
}): Promise<MemoryRerankerResult<TEvidence>> {
  const deterministicRanked = rerankMemoryCandidates({
    query: params.query,
    intent: params.intent,
    candidates: params.candidates,
    policy: params.policy,
  });
  if (!params.modelClient || deterministicRanked.length === 0) {
    return {
      rankedEvidence: deterministicRanked,
      recommendedNextSource: null,
      needsLiveVerification: null,
      verificationReason: null,
      usedLlm: false,
    };
  }

  const deterministicMap = new Map(
    deterministicRanked.map((evidence) => [evidence.id, evidence]),
  );
  const shortlist = deterministicRanked.slice(0, Math.min(12, deterministicRanked.length));
  const payload = await queryMemoryModelJson(params.modelClient, {
    systemPrompt: [
      "You rerank durable memory retrieval candidates for an autonomous agent.",
      "Return strict JSON only with this shape:",
      '{"ranked_ids":["string"],"assessments":[{"id":"string","bucket":"known_fact|high_signal|constraint|blocker|open_question|other","requires_live_verification":true,"reason":"string"}],"recommended_next_source":"string|null","needs_live_verification":true,"verification_reason":"string"}',
      "Rank candidates from most useful to least useful for the query intent.",
      "Prefer the most decision-relevant context, not the most similar wording.",
      "For briefing intents, prioritize urgency, novelty, direct user impact, blockers, and unresolved loops.",
      "For delta intents, prioritize changed or newly observed items over old static facts.",
      "For planning intents, prioritize owners, dependencies, blockers, permissions, deadlines, and constraints.",
      "Use all ranked_ids at most once and only from the provided shortlist.",
      "Be diversity-aware: do not let near-duplicate candidates from one source crowd out distinct important context.",
      "Set recommended_next_source to memory only when recalled memory is enough to answer without live verification.",
    ].join(" "),
    userPrompt: [
      `Query: ${params.query}`,
      `Intent: ${params.intent}`,
      "",
      "Candidates:",
      ...shortlist.map((candidate, index) => [
        `${index + 1}. id: ${candidate.id}`,
        `   category: ${candidate.category}`,
        `   kind: ${candidate.kind}`,
        `   freshness_state: ${candidate.freshness_state}`,
        candidate.provider ? `   provider: ${candidate.provider}` : null,
        candidate.entity_type ? `   entity_type: ${candidate.entity_type}` : null,
        `   title: ${candidate.title}`,
        `   summary: ${candidate.summary}`,
      ].filter(Boolean).join("\n")),
    ].join("\n"),
    timeoutMs: 8000,
  });

  const rankedIds = Array.isArray(payload?.ranked_ids)
    ? payload.ranked_ids
        .map((value) => nonEmptyString(value))
        .filter((value) => value && deterministicMap.has(value))
    : [];
  if (rankedIds.length === 0) {
    return {
      rankedEvidence: deterministicRanked,
      recommendedNextSource: null,
      needsLiveVerification: null,
      verificationReason: null,
      usedLlm: false,
    };
  }

  const seen = new Set<string>();
  const llmHead: TEvidence[] = [];
  for (const id of rankedIds) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const candidate = deterministicMap.get(id);
    if (candidate) {
      llmHead.push(candidate);
    }
  }
  for (const candidate of shortlist) {
    if (!seen.has(candidate.id)) {
      llmHead.push(candidate);
    }
  }
  const tail = deterministicRanked.filter((candidate) => !shortlist.some((shortlisted) => shortlisted.id === candidate.id));

  const assessments = new Map<string, {
    bucket: BaseMemoryRerankerEvidence["llm_bucket"];
    reason: string | null;
    requiresLiveVerification: boolean | null;
  }>();
  if (Array.isArray(payload?.assessments)) {
    for (const item of payload.assessments) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const id = nonEmptyString((item as { id?: unknown }).id);
      if (!id || !deterministicMap.has(id)) {
        continue;
      }
      assessments.set(id, {
        bucket: normalizeBucket((item as { bucket?: unknown }).bucket),
        reason: nonEmptyString((item as { reason?: unknown }).reason) || null,
        requiresLiveVerification: normalizeBoolean((item as { requires_live_verification?: unknown }).requires_live_verification),
      });
    }
  }

  const rankedEvidence = [...llmHead, ...tail].map((candidate) => {
    const assessment = assessments.get(candidate.id);
    const reasons = new Set(candidate.reasons);
    reasons.add("llm_rerank");
    if (assessment?.bucket) {
      reasons.add(`llm_bucket:${assessment.bucket}`);
    }
    if (assessment?.requiresLiveVerification === true) {
      reasons.add("llm_requires_live_verification");
    }
    return {
      ...candidate,
      reasons: [...reasons],
      llm_bucket: assessment?.bucket ?? candidate.llm_bucket ?? null,
      llm_reason: assessment?.reason ?? candidate.llm_reason ?? null,
      needs_live_verification:
        assessment?.requiresLiveVerification ?? candidate.needs_live_verification ?? null,
    };
  });

  return {
    rankedEvidence,
    recommendedNextSource: nonEmptyString(payload?.recommended_next_source) || null,
    needsLiveVerification: normalizeBoolean(payload?.needs_live_verification),
    verificationReason: nonEmptyString(payload?.verification_reason) || null,
    usedLlm: true,
  };
}
