import type { MemoryEntryRecord } from "@holaboss/runtime-state-store";

import type { AgentRecalledMemoryContext } from "./memory-retrieval-pack.js";
import {
  defaultMemoryRecallIndex,
  type MemoryRecallIndex,
  type RankedMemoryRecallEntry,
} from "./memory-recall-index.js";

function normalizedToken(value: string): string {
  return value.trim().toLowerCase();
}

function semanticDedupKey(entry: MemoryEntryRecord): string {
  const subject = normalizedToken(entry.subjectKey);
  if (subject) {
    return `${entry.scope}:${entry.memoryType}:${subject}`;
  }
  const path = normalizedToken(entry.path);
  return `${entry.scope}:${entry.memoryType}:${path}`;
}

function selectRankedEntriesWithBudgets(params: {
  ranked: RankedMemoryRecallEntry[];
  maxEntries: number;
}): RankedMemoryRecallEntry[] {
  const maxEntries = Math.max(1, Math.trunc(params.maxEntries));
  const ranked = params.ranked;
  if (ranked.length === 0) {
    return [];
  }

  const hasNonUserCandidates = ranked.some((item) => item.entry.scope !== "user");
  const maxUserEntries = hasNonUserCandidates ? Math.min(2, Math.max(1, maxEntries - 1)) : maxEntries;
  const distinctTypes = new Set(ranked.map((item) => item.entry.memoryType));
  const enforceTypeBudget = distinctTypes.size > 1;
  const maxPerType = enforceTypeBudget ? Math.max(1, Math.ceil(maxEntries / 2)) : maxEntries;

  const selected: RankedMemoryRecallEntry[] = [];
  const selectedMemoryIds = new Set<string>();
  const selectedPaths = new Set<string>();
  const selectedSemanticKeys = new Set<string>();
  const scopeCounts = new Map<MemoryEntryRecord["scope"], number>();
  const typeCounts = new Map<MemoryEntryRecord["memoryType"], number>();

  const trySelect = (item: RankedMemoryRecallEntry, enforceBudgets: boolean): boolean => {
    if (selected.length >= maxEntries) {
      return false;
    }
    const entry = item.entry;
    if (selectedMemoryIds.has(entry.memoryId)) {
      return false;
    }
    const pathKey = normalizedToken(entry.path);
    if (pathKey && selectedPaths.has(pathKey)) {
      return false;
    }
    const semanticKey = semanticDedupKey(entry);
    if (selectedSemanticKeys.has(semanticKey)) {
      return false;
    }
    if (enforceBudgets) {
      if (entry.scope === "user" && (scopeCounts.get("user") ?? 0) >= maxUserEntries) {
        return false;
      }
      if (enforceTypeBudget && (typeCounts.get(entry.memoryType) ?? 0) >= maxPerType) {
        return false;
      }
    }
    selected.push(item);
    selectedMemoryIds.add(entry.memoryId);
    if (pathKey) {
      selectedPaths.add(pathKey);
    }
    selectedSemanticKeys.add(semanticKey);
    scopeCounts.set(entry.scope, (scopeCounts.get(entry.scope) ?? 0) + 1);
    typeCounts.set(entry.memoryType, (typeCounts.get(entry.memoryType) ?? 0) + 1);
    return true;
  };

  for (const item of ranked) {
    trySelect(item, true);
  }
  if (selected.length < maxEntries) {
    for (const item of ranked) {
      trySelect(item, false);
      if (selected.length >= maxEntries) {
        break;
      }
    }
  }
  return selected;
}

export function recalledMemoryContextFromEntries(params: {
  query: string;
  entries: MemoryEntryRecord[];
  maxEntries?: number;
  nowIso?: string | null;
  recallIndex?: MemoryRecallIndex | null;
}): AgentRecalledMemoryContext | null {
  const activeEntries = params.entries.filter((entry) => entry.status === "active");
  if (activeEntries.length === 0) {
    return null;
  }

  const ranked = (params.recallIndex ?? defaultMemoryRecallIndex()).rank({
    query: params.query,
    entries: activeEntries,
    nowIso: params.nowIso ?? null,
  });

  const selectedRankedEntries = selectRankedEntriesWithBudgets({
    ranked,
    maxEntries: Math.max(1, params.maxEntries ?? 5),
  });
  const selectedEntries = selectedRankedEntries.map(({ entry, freshness }) => ({
      scope: entry.scope,
      memory_type: entry.memoryType,
      title: entry.title,
      summary: entry.summary,
      path: entry.path,
      verification_policy: entry.verificationPolicy,
      staleness_policy: entry.stalenessPolicy,
      freshness_state: freshness.state,
      freshness_note: freshness.note,
      source_type: entry.sourceType,
      observed_at: entry.observedAt,
      last_verified_at: entry.lastVerifiedAt,
      confidence: entry.confidence,
      updated_at: entry.updatedAt,
    }));

  if (selectedEntries.length === 0) {
    return null;
  }

  return {
    entries: selectedEntries,
    selection_trace: selectedRankedEntries.map(({ entry, score, freshness, trace }) => ({
      memory_id: entry.memoryId,
      score,
      freshness_state: freshness.state,
      matched_tokens: trace.matchedTokens,
      reasons: trace.reasons,
      source_type: entry.sourceType,
    })),
  };
}
