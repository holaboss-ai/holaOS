import type { MemoryEntryRecord } from "@holaboss/runtime-state-store";

import { assessMemoryFreshness, governanceRuleForMemoryType, type MemoryFreshnessAssessment } from "./memory-governance.js";

export interface RankedMemoryRecallEntry {
  entry: MemoryEntryRecord;
  score: number;
  freshness: MemoryFreshnessAssessment;
  trace: {
    matchedTokens: string[];
    reasons: string[];
  };
}

export interface MemoryRecallIndex {
  rank(params: {
    query: string;
    entries: MemoryEntryRecord[];
    nowIso?: string | null;
  }): RankedMemoryRecallEntry[];
}

function tokenize(value: string): string[] {
  const matches = value.match(/[a-z0-9]{2,}/gi);
  if (!matches) {
    return [];
  }
  return [...new Set(matches.map((token) => token.toLowerCase()))];
}

function queryIntentBoost(tokens: string[], entry: MemoryEntryRecord): number {
  if (tokens.length === 0) {
    return 0;
  }
  const loweredTags = entry.tags.map((tag) => tag.toLowerCase());
  const loweredTitle = entry.title.toLowerCase();
  const loweredSummary = entry.summary.toLowerCase();
  const hasProcedureCue = tokens.some((token) => ["how", "steps", "procedure", "process", "workflow"].includes(token));
  const hasBlockerCue = tokens.some((token) => ["blocked", "blocker", "denied", "permission", "policy", "fix"].includes(token));
  const hasCommandCue = tokens.some((token) => ["command", "commands", "run", "verify", "verification", "test", "build", "deploy", "release"].includes(token));
  const hasBusinessFactCue = tokens.some((token) =>
    [
      "what",
      "when",
      "who",
      "owner",
      "approval",
      "approves",
      "approver",
      "schedule",
      "cadence",
      "review",
      "meeting",
      "report",
      "reporting",
      "invoice",
      "invoices",
      "finance",
      "legal",
      "follow",
      "followup",
      "follow-up",
      "handoff",
      "handover",
      "escalation",
      "sla",
      "deadline",
      "email",
    ].includes(token)
  );
  const hasApprovalCue = tokens.some((token) => ["approve", "approves", "approval", "approver"].includes(token));
  const hasScheduleCue = tokens.some((token) => ["when", "schedule", "cadence", "weekly", "daily", "monthly", "quarterly"].includes(token));
  const hasReferenceCue = tokens.some((token) => ["reference", "references", "docs", "dashboard", "url", "link"].includes(token));

  if (entry.memoryType === "procedure" && hasProcedureCue) {
    return 6;
  }
  if (entry.memoryType === "fact" && hasCommandCue) {
    return 2;
  }
  if (entry.memoryType === "fact" && hasBusinessFactCue) {
    let boost = 3;
    const approvalLike =
      loweredTags.includes("approval") ||
      loweredTags.includes("approver") ||
      loweredTitle.includes("approval") ||
      loweredSummary.includes("approval");
    const scheduleLike =
      loweredTags.includes("cadence") ||
      loweredTags.includes("schedule") ||
      loweredTitle.includes("cadence") ||
      loweredSummary.includes("weekly") ||
      loweredSummary.includes("daily") ||
      loweredSummary.includes("monthly") ||
      loweredSummary.includes("quarterly");
    if (hasApprovalCue && approvalLike) {
      boost += 2;
    }
    if (hasScheduleCue && scheduleLike) {
      boost += 2;
    }
    return boost;
  }
  if (entry.memoryType === "blocker" && hasBlockerCue) {
    return 3;
  }
  if (entry.memoryType === "reference" && hasReferenceCue) {
    return 2;
  }
  return 0;
}

function scopePriority(entry: MemoryEntryRecord): number {
  return entry.scope === "user" ? 0 : 1;
}

function queryTypePriority(tokens: string[], entry: MemoryEntryRecord): number {
  const hasProcedureCue = tokens.some((token) => ["how", "steps", "procedure", "process", "workflow"].includes(token));
  const hasCommandCue = tokens.some((token) => ["command", "commands", "run", "verify", "verification", "test", "build", "deploy", "release"].includes(token));
  const hasBusinessFactCue = tokens.some((token) =>
    [
      "what",
      "when",
      "who",
      "owner",
      "approval",
      "approves",
      "approver",
      "schedule",
      "cadence",
      "review",
      "meeting",
      "report",
      "reporting",
      "invoice",
      "invoices",
      "finance",
      "legal",
      "follow",
      "followup",
      "follow-up",
      "handoff",
      "handover",
      "escalation",
      "sla",
      "deadline",
      "email",
    ].includes(token)
  );
  const hasBlockerCue = tokens.some((token) => ["blocked", "blocker", "denied", "permission", "policy", "fix"].includes(token));
  const hasReferenceCue = tokens.some((token) => ["reference", "references", "docs", "dashboard", "url", "link"].includes(token));

  if (hasProcedureCue) {
    return entry.memoryType === "procedure" ? 0 : 1;
  }
  if (hasCommandCue) {
    return entry.memoryType === "fact" ? 0 : 1;
  }
  if (hasBusinessFactCue) {
    return entry.memoryType === "fact" ? 0 : 1;
  }
  if (hasBlockerCue) {
    return entry.memoryType === "blocker" ? 0 : 1;
  }
  if (hasReferenceCue) {
    return entry.memoryType === "reference" ? 0 : 1;
  }
  return 1;
}

export class KeywordMetadataMemoryRecallIndex implements MemoryRecallIndex {
  rank(params: {
    query: string;
    entries: MemoryEntryRecord[];
    nowIso?: string | null;
  }): RankedMemoryRecallEntry[] {
    const tokens = tokenize(params.query);
    return params.entries
      .map((entry) => {
        const freshness = assessMemoryFreshness(entry, params.nowIso);
        const governance = governanceRuleForMemoryType(entry.memoryType);
        const loweredTitle = entry.title.toLowerCase();
        const loweredSummary = entry.summary.toLowerCase();
        const loweredPath = entry.path.toLowerCase();
        const loweredSubjectKey = entry.subjectKey.toLowerCase();
        const loweredTags = entry.tags.map((tag) => tag.toLowerCase());
        const haystack = [
          loweredTitle,
          loweredSummary,
          entry.memoryType,
          loweredPath,
          loweredSubjectKey,
          ...loweredTags,
        ].join(" ");

        let score = governance.recallBoost;
        const matchedTokens = new Set<string>();
        const reasons: string[] = [`base_recall_boost:${governance.recallBoost}`];
        if (entry.scope === "user") {
          score += 6;
          reasons.push("user_scope_priority");
        }
        const intentBoost = queryIntentBoost(tokens, entry);
        if (intentBoost > 0) {
          score += intentBoost;
          reasons.push(`query_intent_boost:${intentBoost}`);
        }

        const normalizedQuery = params.query.trim().toLowerCase();
        if (normalizedQuery && (loweredTitle.includes(normalizedQuery) || loweredSummary.includes(normalizedQuery))) {
          score += 4;
          reasons.push("full_query_match");
        }

        for (const token of tokens) {
          if (loweredTitle.includes(token)) {
            score += 3;
            matchedTokens.add(token);
            reasons.push(`title_match:${token}`);
          }
          if (loweredTags.includes(token)) {
            score += 3;
            matchedTokens.add(token);
            reasons.push(`tag_match:${token}`);
          }
          if (loweredSubjectKey.includes(token)) {
            score += 2;
            matchedTokens.add(token);
            reasons.push(`subject_key_match:${token}`);
          }
          if (loweredSummary.includes(token)) {
            score += 2;
            matchedTokens.add(token);
            reasons.push(`summary_match:${token}`);
          }
          if (loweredPath.includes(token)) {
            score += 1;
            matchedTokens.add(token);
            reasons.push(`path_match:${token}`);
          }
          if (haystack.includes(token)) {
            score += 0.5;
          }
        }

        if (tokens.length === 0 && entry.scope !== "user") {
          score = 0;
        }
        if (freshness.state === "stale") {
          score -= 3;
          reasons.push("stale_penalty");
        }
        if (entry.memoryType === "reference" && freshness.state === "stale") {
          score = -1;
          reasons.push("stale_reference_filtered");
        }
        return {
          entry,
          score,
          freshness,
          trace: {
            matchedTokens: [...matchedTokens],
            reasons,
          },
          scopePriority: scopePriority(entry),
          typePriority: queryTypePriority(tokens, entry),
        };
      })
      .filter(({ entry, score }) => entry.scope === "user" || score > 0)
      .sort((left, right) => {
        if (left.scopePriority !== right.scopePriority) {
          return left.scopePriority - right.scopePriority;
        }
        if (left.typePriority !== right.typePriority) {
          return left.typePriority - right.typePriority;
        }
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        if (left.freshness.state !== right.freshness.state) {
          return freshnessRank(left.freshness.state) - freshnessRank(right.freshness.state);
        }
        return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
      });
  }
}

function freshnessRank(value: MemoryFreshnessAssessment["state"]): number {
  switch (value) {
    case "stable":
      return 0;
    case "fresh":
      return 1;
    case "stale":
      return 2;
    default:
      return 3;
  }
}

const DEFAULT_MEMORY_RECALL_INDEX = new KeywordMetadataMemoryRecallIndex();

export function defaultMemoryRecallIndex(): MemoryRecallIndex {
  return DEFAULT_MEMORY_RECALL_INDEX;
}
