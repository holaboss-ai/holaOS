/**
 * Boot timing telemetry.
 *
 * Boot phases became observable when the phase tracker and `/runtime/boot-status`
 * landed, but every phase logs at the same level: an 800ms boot and an 80s boot
 * produce identical output, and the timings die with the process. That is how a
 * 2GB `data.db` spending 80s in `PRAGMA quick_check` went unnoticed until it
 * bricked the app — the runtime was doing honest work the whole time and nothing
 * anywhere said "this is not normal".
 *
 * Two rules follow from that failure, and they shape this module:
 *
 *  1. The alarm has to fire while a phase is STILL RUNNING. The boot that
 *     motivated this never completed, so any check that only runs at the end
 *     would have stayed silent for exactly the failure it was written for.
 *     Hence `phaseBudgetMs` — a budget the caller can poll the in-flight phase
 *     against, not just compare a finished one to.
 *
 *  2. "Slow" is machine-relative. A cold spinning disk and a warm SSD differ by
 *     more than an order of magnitude, so a single absolute threshold either
 *     cries wolf on slow hardware or never fires on fast hardware. Absolute
 *     budgets catch the pathological case; the persisted baseline catches the
 *     regression that is only visible against this machine's own history.
 */

/** One completed boot, as persisted. Small and flat on purpose: it is written
 *  to a KV row as JSON and read back by a later process, so it has to survive
 *  round-tripping without a schema. */
export interface BootRecord {
  /** Wall-clock ms from app construction to `ready`. */
  total_ms: number;
  /** Per-phase timings, in the order they ran. */
  phases: Array<{ phase: string; ms: number }>;
  /** Time spent opening the root DB, when known. Attributed separately because
   *  the open is lazy: without this it is charged to whichever background
   *  worker happened to touch the store first, which reads as "durable_memory
   *  took 80s" and sends the next person to the wrong file. */
  root_db_open_ms?: number;
  /** Time inside `PRAGMA quick_check`, when it ran. The single most expensive
   *  thing a boot can do, and unbounded in the size of the DB. */
  root_db_integrity_check_ms?: number;
  /** ISO timestamp, so a stored history is readable without correlating logs. */
  at: string;
}

export interface BootAlarm {
  kind: "phase_over_budget" | "total_over_budget" | "slower_than_baseline";
  phase?: string;
  elapsed_ms: number;
  budget_ms?: number;
  baseline_ms?: number;
  message: string;
}

/**
 * Per-phase budgets.
 *
 * These are not targets — they are the point at which a phase stops looking
 * like work and starts looking like a problem worth a line in the log. Set them
 * generously: a false alarm every boot trains people to ignore the alarm, which
 * costs more than the alarm was ever worth.
 */
export const DEFAULT_PHASE_BUDGET_MS = 5_000;

export const PHASE_BUDGETS_MS: Readonly<Record<string, number>> = Object.freeze({
  // Opens the root DB on first touch, so it wears the integrity check and any
  // pending compaction. Generous, because on a large DB this is legitimately
  // slow — but not unbounded, because unbounded is what bricked the app.
  durable_memory: 30_000,
  terminal_sessions: 10_000,
  // Reaches out to configured channels; a slow network is not a broken boot.
  channel_gateway: 20_000,
  queue_worker: 10_000,
  cron_worker: 10_000,
  main_session_events: 10_000,
  recall_embeddings: 10_000,
});

/** Total boot budget. Past this the app has been showing a spinner long enough
 *  that a user would reasonably assume it is broken. */
export const TOTAL_BOOT_BUDGET_MS = 60_000;

/** How many boots to keep. Enough to form a stable median, few enough that the
 *  row stays small and a single bad boot cannot poison the baseline. */
export const BOOT_HISTORY_LIMIT = 10;

/** A boot this much slower than the baseline is a regression worth saying out
 *  loud, even when it is comfortably inside the absolute budget. */
export const BASELINE_REGRESSION_FACTOR = 3;

/** Below this, ratios are noise — a 40ms boot that becomes 130ms is 3.25x and
 *  means nothing. Keeps the regression alarm off fast, healthy machines. */
export const BASELINE_MIN_MS = 1_000;

export function phaseBudgetMs(phase: string): number {
  return PHASE_BUDGETS_MS[phase] ?? DEFAULT_PHASE_BUDGET_MS;
}

/**
 * Is the phase running right now over its budget?
 *
 * Deliberately takes the elapsed time rather than a start timestamp so the
 * caller can poll it from a watchdog on an interval, and so it is trivially
 * testable without faking a clock.
 */
export function phaseOverBudget(phase: string, elapsedMs: number): boolean {
  return elapsedMs > phaseBudgetMs(phase);
}

/** Median total, ignoring anything implausible. Median rather than mean so one
 *  pathological boot (the exact case this exists to catch) does not drag the
 *  baseline up and hide the next one. */
export function baselineTotalMs(history: readonly BootRecord[]): number | null {
  const totals = history
    .map((record) => record.total_ms)
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((left, right) => left - right);
  if (totals.length === 0) {
    return null;
  }
  const middle = Math.floor(totals.length / 2);
  return totals.length % 2 === 1
    ? totals[middle]
    : Math.round((totals[middle - 1] + totals[middle]) / 2);
}

/**
 * Every reason this boot deserves attention, in severity order.
 *
 * Returns a list rather than a boolean because the reasons are not
 * interchangeable: "one phase blew its budget" points at a subsystem, while
 * "the whole thing regressed against this machine's own history" points at the
 * data (a DB that has grown, a disk filling up). Collapsing them to `slow: true`
 * throws away the half of the signal that says where to look.
 */
export function classifyBoot(
  record: BootRecord,
  history: readonly BootRecord[] = [],
): BootAlarm[] {
  const alarms: BootAlarm[] = [];

  for (const { phase, ms } of record.phases) {
    if (phaseOverBudget(phase, ms)) {
      const budget = phaseBudgetMs(phase);
      alarms.push({
        kind: "phase_over_budget",
        phase,
        elapsed_ms: ms,
        budget_ms: budget,
        message: `boot phase ${phase} took ${ms}ms (budget ${budget}ms)`,
      });
    }
  }

  if (record.total_ms > TOTAL_BOOT_BUDGET_MS) {
    alarms.push({
      kind: "total_over_budget",
      elapsed_ms: record.total_ms,
      budget_ms: TOTAL_BOOT_BUDGET_MS,
      message: `boot took ${record.total_ms}ms (budget ${TOTAL_BOOT_BUDGET_MS}ms)`,
    });
  }

  const baseline = baselineTotalMs(history);
  if (
    baseline !== null &&
    baseline >= BASELINE_MIN_MS &&
    record.total_ms > baseline * BASELINE_REGRESSION_FACTOR
  ) {
    alarms.push({
      kind: "slower_than_baseline",
      elapsed_ms: record.total_ms,
      baseline_ms: baseline,
      message: `boot took ${record.total_ms}ms, ${(record.total_ms / baseline).toFixed(1)}x this machine's baseline of ${baseline}ms`,
    });
  }

  return alarms;
}

/** Append and trim, oldest first. Pure so the ring's bound is testable without
 *  a database. */
export function appendBootRecord(
  history: readonly BootRecord[],
  record: BootRecord,
  limit: number = BOOT_HISTORY_LIMIT,
): BootRecord[] {
  const next = [...history, record];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * Parse a persisted history, tolerating anything.
 *
 * This reads a KV row written by an older build, so it must never throw: a
 * malformed history is a reason to lose the baseline, not to fail the boot that
 * is trying to read it. That would turn a telemetry feature into an outage.
 */
export function parseBootHistory(raw: string | null | undefined): BootRecord[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is BootRecord => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }
      const candidate = entry as Partial<BootRecord>;
      return (
        typeof candidate.total_ms === "number" &&
        Number.isFinite(candidate.total_ms) &&
        Array.isArray(candidate.phases)
      );
    });
  } catch {
    return [];
  }
}
