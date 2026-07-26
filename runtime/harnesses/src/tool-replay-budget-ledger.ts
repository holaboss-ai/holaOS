const DEFAULT_MAX_REPLAY_CHARS = 24_000;
const DEFAULT_MAX_REPLAY_ITEMS = 8;
const LEDGER_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TRACKED_LEDGERS = 512;

export interface ToolReplayBudgetLedgerLimits {
  maxReplayChars?: number;
  maxReplayItems?: number;
}

export interface ToolReplayBudgetDecision {
  mode: "preview" | "reference_only";
  trimmed: boolean;
  trimReason: "max_replay_chars" | "max_replay_items" | null;
  replayChars: number;
  totalReplayChars: number;
  maxReplayChars: number;
  totalReplayItems: number;
  maxReplayItems: number;
}

interface InternalLedgerState {
  maxReplayChars: number;
  maxReplayItems: number;
  totalReplayChars: number;
  totalReplayItems: number;
  touchedAt: number;
}

const ledgers = new Map<string, InternalLedgerState>();

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

function pruneExpiredLedgers(now: number): void {
  for (const [key, state] of ledgers.entries()) {
    if (now - state.touchedAt > LEDGER_TTL_MS) {
      ledgers.delete(key);
    }
  }
  if (ledgers.size <= MAX_TRACKED_LEDGERS) {
    return;
  }
  const entries = [...ledgers.entries()].sort(
    (left, right) => left[1].touchedAt - right[1].touchedAt,
  );
  for (const [key] of entries.slice(0, ledgers.size - MAX_TRACKED_LEDGERS)) {
    ledgers.delete(key);
  }
}

function getOrCreateLedgerState(
  ledgerKey: string,
  limits: ToolReplayBudgetLedgerLimits | undefined,
): InternalLedgerState {
  const now = Date.now();
  pruneExpiredLedgers(now);
  const existing = ledgers.get(ledgerKey);
  if (existing) {
    existing.touchedAt = now;
    return existing;
  }
  const created: InternalLedgerState = {
    maxReplayChars: normalizePositiveInteger(
      limits?.maxReplayChars,
      DEFAULT_MAX_REPLAY_CHARS,
    ),
    maxReplayItems: normalizePositiveInteger(
      limits?.maxReplayItems,
      DEFAULT_MAX_REPLAY_ITEMS,
    ),
    totalReplayChars: 0,
    totalReplayItems: 0,
    touchedAt: now,
  };
  ledgers.set(ledgerKey, created);
  return created;
}

export function consumeToolReplayBudget(params: {
  ledgerKey: string;
  replayChars: number;
  limits?: ToolReplayBudgetLedgerLimits;
}): ToolReplayBudgetDecision {
  const state = getOrCreateLedgerState(params.ledgerKey, params.limits);
  const replayChars = Math.max(0, Math.trunc(params.replayChars));
  const nextReplayItems = state.totalReplayItems + 1;
  const nextReplayChars = state.totalReplayChars + replayChars;
  const overItems = nextReplayItems > state.maxReplayItems;
  const overChars = nextReplayChars > state.maxReplayChars;

  if (overItems || overChars) {
    if (overChars) {
      state.totalReplayChars = state.maxReplayChars;
    }
    if (overItems) {
      state.totalReplayItems = state.maxReplayItems;
    } else {
      state.totalReplayItems = nextReplayItems;
    }
    state.touchedAt = Date.now();
    return {
      mode: "reference_only",
      trimmed: true,
      trimReason: overChars ? "max_replay_chars" : "max_replay_items",
      replayChars,
      totalReplayChars: state.totalReplayChars,
      maxReplayChars: state.maxReplayChars,
      totalReplayItems: state.totalReplayItems,
      maxReplayItems: state.maxReplayItems,
    };
  }

  state.totalReplayChars = nextReplayChars;
  state.totalReplayItems = nextReplayItems;
  state.touchedAt = Date.now();
  return {
    mode: "preview",
    trimmed: false,
    trimReason: null,
    replayChars,
    totalReplayChars: state.totalReplayChars,
    maxReplayChars: state.maxReplayChars,
    totalReplayItems: state.totalReplayItems,
    maxReplayItems: state.maxReplayItems,
  };
}

export function resetToolReplayBudgetLedger(ledgerKey?: string | null): void {
  if (typeof ledgerKey === "string" && ledgerKey.trim()) {
    ledgers.delete(ledgerKey.trim());
    return;
  }
  ledgers.clear();
}
