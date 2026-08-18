import { setTimeout as sleep } from "node:timers/promises";
import type { OutputEventRetentionPolicy } from "@holaboss/runtime-state-store";

/**
 * Background maintenance for the runtime DB (`data.db`).
 *
 * The append-only `session_output_events` log historically had no retention, so
 * on long-lived installs it grew to multiple GB (millions of rows, runaway
 * sessions with hundreds of thousands of events). That bloat is what made launch
 * slow and drove chronic "database is locked" contention. This task enforces the
 * retention policy as a *background*, *batched*, *non-fatal* sweep — it never
 * runs on the boot hot path and never crashes the runtime — then requests a
 * one-time file compaction (VACUUM, applied at the next boot) once it has freed
 * enough space to make one worthwhile.
 */

/** Minimal structural view of RuntimeStateStore this sweep depends on. */
export interface DbMaintenanceStore {
  readonly outputEventRetentionPolicy: OutputEventRetentionPolicy;
  countRootOutputEventsOlderThan(cutoffIso: string): number;
  pruneRootOutputEventsByAge(params: { cutoffIso: string; limit: number }): number;
  listRootSessionsExceedingOutputEventCap(
    cap: number,
  ): Array<{ sessionId: string; count: number }>;
  countRootOutputEvents(): number;
  trimRootOutputEventsToTotal(params: { keep: number; limit: number }): number;
  trimSessionOutputEvents(params: {
    workspaceId: string;
    sessionId: string;
    maxEvents: number;
    limit?: number;
  }): number;
  requestRootDbCompaction(): void;
}

export type DbMaintenancePhase = "idle" | "estimating" | "pruning" | "done";

/**
 * Live snapshot of the retention sweep, polled by the desktop so a heavy
 * first-run cleanup can show a blocking "Optimizing storage…" progress screen
 * instead of dropping the user into a slow, contended app. `heavy` is decided
 * once, up front, from the estimated backlog — so the desktop knows to keep the
 * boot screen up *before* any rows are deleted.
 */
export interface DbMaintenanceProgress {
  phase: DbMaintenancePhase;
  /** Backlog big enough to warrant blocking the UI while it drains. */
  heavy: boolean;
  /** Rows deleted so far this sweep (age + cap). */
  deletedRows: number;
  /** Rows we expect to delete this sweep (the progress-bar denominator). */
  estimatedRows: number;
  done: boolean;
}

export const IDLE_DB_MAINTENANCE_PROGRESS: DbMaintenanceProgress = {
  phase: "idle",
  heavy: false,
  deletedRows: 0,
  estimatedRows: 0,
  done: false,
};

export interface DbMaintenanceLogger {
  info?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
}

export interface DbMaintenanceOptions {
  store: DbMaintenanceStore;
  logger?: DbMaintenanceLogger;
  /** Aborted on runtime shutdown; the sweep exits promptly and cleanly. */
  signal?: AbortSignal;
  /** Delay before the first sweep so it never competes with boot. */
  startDelayMs?: number;
  /** Rows deleted per batched statement (bounds lock-hold time). */
  batchSize?: number;
  /** Pause between batches so other writers always get the lock. */
  pauseMs?: number;
  /** Free at least this many rows before asking for a file compaction. */
  compactAfterDeletes?: number;
  /**
   * Backlog (estimated deletable rows) at or above which the sweep is flagged
   * `heavy` — the desktop blocks on a progress screen while it drains. Below it,
   * the sweep stays a silent background task.
   */
  heavyThreshold?: number;
  /** Notified with a fresh snapshot whenever the sweep's progress changes. */
  onProgress?: (progress: DbMaintenanceProgress) => void;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Set false in tests to skip requesting a compaction. */
  requestCompaction?: boolean;
}

const DEFAULT_START_DELAY_MS = 30_000;
/**
 * Gap between background retention sweeps. Long enough to be invisible, short
 * enough that a desktop left open for days can't accumulate an unbounded
 * backlog between sweeps.
 */
const DEFAULT_REPEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_PAUSE_MS = 250;
const DEFAULT_COMPACT_AFTER_DELETES = 50_000;
/**
 * At/above this many estimated deletable rows the first sweep is "heavy": big
 * enough that letting the user into a contended app would feel broken, so the
 * desktop blocks on a progress screen until it drains. Matches the compaction
 * threshold — a backlog worth VACUUMing is a backlog worth waiting on.
 */
const DEFAULT_HEAVY_THRESHOLD = 50_000;
/** Give up a phase after this many consecutive failed batches (never spin). */
const MAX_CONSECUTIVE_ERRORS = 10;
/** Root runtime workspace id — routes to data.db. */
const ROOT_WORKSPACE_ID = "root";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DbMaintenanceResult {
  aborted: boolean;
  deletedByAge: number;
  deletedByCap: number;
  /** Rows removed by the global ceiling, after the age + per-session phases. */
  deletedByTotalCap: number;
  compactionRequested: boolean;
}

/** True when the error looks like a transient, retryable lock contention. */
function isTransientLock(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(
    message,
  );
}

/**
 * Run one full retention sweep against the root runtime DB, then (if it freed
 * enough) request a boot-time compaction. Resolves when done or aborted. NEVER
 * throws — every store call is guarded so a transient lock or unexpected error
 * degrades to a logged retry/skip, matching the "background maintenance must not
 * crash the runtime" invariant.
 */
export async function runRuntimeDbMaintenance(
  options: DbMaintenanceOptions,
): Promise<DbMaintenanceResult> {
  const {
    store,
    logger,
    signal,
    startDelayMs = DEFAULT_START_DELAY_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    pauseMs = DEFAULT_PAUSE_MS,
    compactAfterDeletes = DEFAULT_COMPACT_AFTER_DELETES,
    heavyThreshold = DEFAULT_HEAVY_THRESHOLD,
    onProgress,
    now = () => new Date(),
    requestCompaction = true,
  } = options;

  const result: DbMaintenanceResult = {
    aborted: false,
    deletedByAge: 0,
    deletedByCap: 0,
    deletedByTotalCap: 0,
    compactionRequested: false,
  };

  const wait = async (ms: number): Promise<boolean> => {
    if (signal?.aborted) {
      return false;
    }
    try {
      await sleep(ms, undefined, { signal });
      return true;
    } catch {
      // AbortError — shutdown requested.
      return false;
    }
  };

  const policy = store.outputEventRetentionPolicy;

  const ageCutoffIso =
    policy.maxAgeDays > 0
      ? new Date(now().getTime() - policy.maxAgeDays * MS_PER_DAY).toISOString()
      : null;

  // Estimate the backlog up front so the desktop can decide — before a single
  // row is deleted — whether to keep the boot screen up. Guarded: a failed
  // estimate (transient lock) just means "not heavy", i.e. sweep silently.
  let estimatedRows = 0;
  try {
    if (ageCutoffIso) {
      estimatedRows += store.countRootOutputEventsOlderThan(ageCutoffIso);
    }
    if (policy.maxEventsPerSession > 0) {
      for (const session of store.listRootSessionsExceedingOutputEventCap(
        policy.maxEventsPerSession,
      )) {
        estimatedRows += Math.max(0, session.count - policy.maxEventsPerSession);
      }
    }
    if (policy.maxTotalEvents > 0) {
      // Counted against the post-cap total, not the raw one: the two phases
      // above delete some of the same rows, and double-counting them would
      // inflate the progress bar and could flip a light sweep to "heavy".
      const remainingAfterOtherPhases = Math.max(
        0,
        store.countRootOutputEvents() - estimatedRows,
      );
      estimatedRows += Math.max(
        0,
        remainingAfterOtherPhases - policy.maxTotalEvents,
      );
    }
  } catch (error) {
    logger?.error?.("db maintenance: backlog estimate failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const heavy = estimatedRows >= heavyThreshold;

  const emitProgress = (phase: DbMaintenancePhase, done: boolean): void => {
    onProgress?.({
      phase,
      heavy,
      deletedRows: result.deletedByAge + result.deletedByCap,
      estimatedRows,
      done,
    });
  };
  // Publish the heavy/estimate verdict immediately so the desktop sees it even
  // during the pre-sweep delay.
  emitProgress("estimating", false);

  // A heavy sweep blocks the UI anyway, so there's nothing to yield the boot hot
  // path to — start immediately instead of idling behind the boot-competition
  // delay. Light sweeps keep the delay so they never compete with a live boot.
  if (!(await wait(heavy ? 0 : startDelayMs))) {
    result.aborted = true;
    emitProgress("done", true);
    return result;
  }

  // Phase 1 — age-based pruning (oldest events first, batched).
  if (ageCutoffIso) {
    const cutoffIso = ageCutoffIso;
    emitProgress("pruning", false);
    let consecutiveErrors = 0;
    while (!signal?.aborted) {
      let deleted = 0;
      try {
        deleted = store.pruneRootOutputEventsByAge({ cutoffIso, limit: batchSize });
        consecutiveErrors = 0;
      } catch (error) {
        if (!isTransientLock(error) || ++consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
          logger?.error?.("db maintenance: age prune aborted", {
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        if (!(await wait(pauseMs * consecutiveErrors))) {
          break;
        }
        continue;
      }
      if (deleted === 0) {
        break;
      }
      result.deletedByAge += deleted;
      emitProgress("pruning", false);
      if (!(await wait(pauseMs))) {
        break;
      }
    }
  }

  // Phase 2 — per-session cap (heaviest sessions first, batched per session).
  if (policy.maxEventsPerSession > 0 && !signal?.aborted) {
    let overCap: Array<{ sessionId: string; count: number }> = [];
    try {
      overCap = store.listRootSessionsExceedingOutputEventCap(
        policy.maxEventsPerSession,
      );
    } catch (error) {
      logger?.error?.("db maintenance: over-cap scan failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const { sessionId } of overCap) {
      if (signal?.aborted) {
        break;
      }
      let consecutiveErrors = 0;
      while (!signal?.aborted) {
        let deleted = 0;
        try {
          deleted = store.trimSessionOutputEvents({
            workspaceId: ROOT_WORKSPACE_ID,
            sessionId,
            maxEvents: policy.maxEventsPerSession,
            limit: batchSize,
          });
          consecutiveErrors = 0;
        } catch (error) {
          if (!isTransientLock(error) || ++consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
            logger?.error?.("db maintenance: session cap trim aborted", {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            break;
          }
          if (!(await wait(pauseMs * consecutiveErrors))) {
            break;
          }
          continue;
        }
        if (deleted === 0) {
          break;
        }
        result.deletedByCap += deleted;
        emitProgress("pruning", false);
        if (!(await wait(pauseMs))) {
          break;
        }
      }
    }
  }

  // Phase 3 — global ceiling. The backstop the other two cannot provide: neither
  // bounds the number of SESSIONS, so N sessions each sitting exactly at the
  // per-session cap is "within policy" and still unbounded. That is precisely
  // what happened — 162 scheduled sessions at 25k each, 1.9GB, nothing prunable
  // — and boot cost scales with the file, so it bricked the app.
  //
  // Runs last so it only ever trims what the cheaper, more targeted phases left
  // behind.
  if (policy.maxTotalEvents > 0 && !signal?.aborted) {
    let consecutiveErrors = 0;
    while (!signal?.aborted) {
      let deleted = 0;
      try {
        deleted = store.trimRootOutputEventsToTotal({
          keep: policy.maxTotalEvents,
          limit: batchSize,
        });
        consecutiveErrors = 0;
      } catch (error) {
        if (!isTransientLock(error) || ++consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
          logger?.error?.("db maintenance: global cap trim aborted", {
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        if (!(await wait(pauseMs * consecutiveErrors))) {
          break;
        }
        continue;
      }
      if (deleted === 0) {
        break;
      }
      result.deletedByTotalCap += deleted;
      emitProgress("pruning", false);
      if (!(await wait(pauseMs))) {
        break;
      }
    }
  }

  result.aborted = Boolean(signal?.aborted);

  const totalDeleted =
    result.deletedByAge + result.deletedByCap + result.deletedByTotalCap;
  if (totalDeleted > 0) {
    logger?.info?.("db maintenance: output-event retention sweep complete", {
      deletedByAge: result.deletedByAge,
      deletedByCap: result.deletedByCap,
      deletedByTotalCap: result.deletedByTotalCap,
      aborted: result.aborted,
    });
  }

  // Deleted rows go to the freelist — the file only shrinks after a VACUUM,
  // which we defer to the next boot (see RuntimeStateStore.requestRootDbCompaction).
  if (requestCompaction && !result.aborted && totalDeleted >= compactAfterDeletes) {
    try {
      store.requestRootDbCompaction();
      result.compactionRequested = true;
      logger?.info?.("db maintenance: requested data.db compaction on next boot", {
        totalDeleted,
      });
    } catch (error) {
      logger?.error?.("db maintenance: failed to request compaction", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Terminal snapshot: unblocks the desktop boot screen. Always `done: true`,
  // even on abort/partial — a shutdown mid-sweep must not strand the UI.
  emitProgress("done", true);

  return result;
}

/**
 * Run {@link runRuntimeDbMaintenance} on a repeating schedule until `signal`
 * aborts. Resolves only on shutdown.
 *
 * One sweep enforces retention at the instant it runs, so a single boot-time
 * call bounds nothing for an app that then stays open for days — which is how
 * `data.db` reached multiple GB in the field *despite* the policy being
 * enforced: the age cutoff only becomes eligible while the runtime is up, and
 * nothing was re-checking it. Repeating the sweep is what actually bounds the
 * table for a long-lived desktop.
 *
 * Sweeps after the first can never be flagged `heavy`. The blocking
 * "Optimizing storage…" screen is a boot affordance keyed on
 * `heavy && !done` (see BootGate), and a mid-session background sweep must not
 * be able to raise it.
 */
export async function startRuntimeDbMaintenanceLoop(
  options: DbMaintenanceOptions & {
    /** Gap between sweeps. Defaults to 6h. */
    intervalMs?: number;
  },
): Promise<void> {
  const { intervalMs = DEFAULT_REPEAT_INTERVAL_MS, ...sweepOptions } = options;
  const { signal } = sweepOptions;

  // runRuntimeDbMaintenance never throws, so the loop needs no guard of its own.
  await runRuntimeDbMaintenance(sweepOptions);

  while (!signal?.aborted) {
    try {
      await sleep(intervalMs, undefined, { signal });
    } catch {
      return; // AbortError — shutdown requested.
    }
    if (signal?.aborted) {
      return;
    }
    await runRuntimeDbMaintenance({
      ...sweepOptions,
      // The interval is already the boot-competition delay.
      startDelayMs: 0,
      heavyThreshold: Number.POSITIVE_INFINITY,
    });
  }
}
