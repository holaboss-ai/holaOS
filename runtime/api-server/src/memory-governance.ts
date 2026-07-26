import type {
  MemoryEntryRecord,
  MemoryEntryType,
  MemoryStalenessPolicy,
  MemoryVerificationPolicy,
} from "@holaboss/runtime-state-store";

export interface MemoryGovernanceRule {
  memoryType: MemoryEntryType;
  verificationPolicy: MemoryVerificationPolicy;
  stalenessPolicy: MemoryStalenessPolicy;
  staleAfterSeconds: number | null;
  recallBoost: number;
}

export type MemoryFreshnessState = "stable" | "fresh" | "stale";

export interface MemoryFreshnessAssessment {
  state: MemoryFreshnessState;
  note: string | null;
}

const DAY_IN_SECONDS = 24 * 60 * 60;

const MEMORY_GOVERNANCE_RULES: Record<MemoryEntryType, MemoryGovernanceRule> = {
  preference: {
    memoryType: "preference",
    verificationPolicy: "none",
    stalenessPolicy: "stable",
    staleAfterSeconds: null,
    recallBoost: 4,
  },
  identity: {
    memoryType: "identity",
    verificationPolicy: "none",
    stalenessPolicy: "stable",
    staleAfterSeconds: null,
    recallBoost: 3,
  },
  fact: {
    memoryType: "fact",
    verificationPolicy: "check_before_use",
    stalenessPolicy: "workspace_sensitive",
    staleAfterSeconds: 30 * DAY_IN_SECONDS,
    recallBoost: 2,
  },
  procedure: {
    memoryType: "procedure",
    verificationPolicy: "check_before_use",
    stalenessPolicy: "workspace_sensitive",
    staleAfterSeconds: 14 * DAY_IN_SECONDS,
    recallBoost: 2,
  },
  blocker: {
    memoryType: "blocker",
    verificationPolicy: "check_before_use",
    stalenessPolicy: "workspace_sensitive",
    staleAfterSeconds: 14 * DAY_IN_SECONDS,
    recallBoost: 3,
  },
  reference: {
    memoryType: "reference",
    verificationPolicy: "must_reconfirm",
    stalenessPolicy: "time_sensitive",
    staleAfterSeconds: 7 * DAY_IN_SECONDS,
    recallBoost: 1,
  },
};

function parseIsoMs(value: string | null | undefined): number | null {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function governanceRuleForMemoryType(memoryType: MemoryEntryType): MemoryGovernanceRule {
  return MEMORY_GOVERNANCE_RULES[memoryType];
}

export function assessMemoryFreshness(
  entry: Pick<MemoryEntryRecord, "memoryType" | "verificationPolicy" | "stalenessPolicy" | "staleAfterSeconds" | "updatedAt">,
  nowIso?: string | null
): MemoryFreshnessAssessment {
  if (entry.stalenessPolicy === "stable") {
    return {
      state: "stable",
      note: "This memory is treated as stable unless explicitly changed.",
    };
  }

  const updatedAtMs = parseIsoMs(entry.updatedAt);
  const nowMs = parseIsoMs(nowIso ?? null) ?? Date.now();
  const staleAfterSeconds = typeof entry.staleAfterSeconds === "number" && entry.staleAfterSeconds > 0
    ? entry.staleAfterSeconds
    : null;
  if (updatedAtMs == null || staleAfterSeconds == null) {
    return {
      state: "fresh",
      note: freshnessNote(entry.stalenessPolicy, entry.verificationPolicy),
    };
  }

  const ageMs = nowMs - updatedAtMs;
  if (ageMs >= staleAfterSeconds * 1000) {
    return {
      state: "stale",
      note: staleNote(entry.stalenessPolicy, entry.verificationPolicy),
    };
  }

  return {
    state: "fresh",
    note: freshnessNote(entry.stalenessPolicy, entry.verificationPolicy),
  };
}

function freshnessNote(
  stalenessPolicy: MemoryStalenessPolicy,
  verificationPolicy: MemoryVerificationPolicy
): string {
  if (verificationPolicy === "none") {
    return "This memory does not require re-verification before use.";
  }
  if (stalenessPolicy === "workspace_sensitive") {
    return "Verify this memory against the current workspace state before acting on it.";
  }
  return "Verify this memory before acting on it.";
}

function staleNote(
  stalenessPolicy: MemoryStalenessPolicy,
  verificationPolicy: MemoryVerificationPolicy
): string {
  if (verificationPolicy === "must_reconfirm") {
    return "This memory is stale and must be reconfirmed before use.";
  }
  if (stalenessPolicy === "workspace_sensitive") {
    return "This memory may be stale relative to the current workspace state. Recheck it before use.";
  }
  return "This memory may be stale. Recheck it before use.";
}
