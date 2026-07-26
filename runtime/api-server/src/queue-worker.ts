import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type RuntimeStateStore,
  type SessionInputRecord,
  type SessionRuntimeStateRecord,
  utcNowIso,
} from "@holaboss/runtime-state-store";

import { processClaimedInput } from "./claimed-input-executor.js";
import type { MemoryServiceLike } from "./memory.js";
import { buildRunCompletedEvent, buildRunFailedEvent } from "./runner-worker.js";

const DEFAULT_CLAIMED_BY = "sandbox-agent-ts-worker";
const DEFAULT_LEASE_SECONDS = 300;
// Idle poll cadence. The interactive (desktop) enqueue path wakes the worker
// immediately (app.ts), so this only bounds pickup latency for sources that
// enqueue without a wake — channel/IM and cron/scheduled inputs. Kept low so
// those don't wait up to a full second; the per-cycle work is a small indexed
// recovery scan + claim on a local SQLite, cheap to run a few times a second.
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_CLAIM_STALE_HEARTBEAT_MS = 20_000;
// Cron/scheduled runs interrupted by a runtime restart are retried instead of
// hard-failed, bounded so a genuinely failing input cannot requeue forever.
const DEFAULT_SCHEDULED_RECOVERY_REQUEUE_ATTEMPTS = 5;
const ACTIVE_RUN_KEEPALIVE_MIN_INTERVAL_MS = 250;
const ACTIVE_RUN_KEEPALIVE_MAX_INTERVAL_MS = 1_000;
const TERMINAL_EVENT_TYPES = new Set(["run_completed", "run_failed"]);

export interface QueueWorkerLike {
  start(): Promise<void>;
  wake(): void;
  close(): Promise<void>;
  pauseSessionRun?(params: {
    workspaceId: string;
    sessionId: string;
  }): Promise<{
    inputId: string;
    sessionId: string;
    status: "PAUSED" | "PAUSING";
  } | null>;
}

export interface RuntimeQueueWorkerOptions {
  store: RuntimeStateStore;
  logger?: {
    info: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
  memoryService?: MemoryServiceLike | null;
  wakeDurableMemoryWorker?: (() => void) | null;
  executeClaimedInput?: (record: SessionInputRecord, options?: { signal?: AbortSignal }) => Promise<void>;
  claimedBy?: string;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  maxConcurrency?: number;
  claimStaleHeartbeatMs?: number;
}

function queueWorkerMaxConcurrency(): number {
  const raw = (process.env.HB_QUEUE_WORKER_CONCURRENCY ?? "").trim();
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_CONCURRENCY;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_CONCURRENCY;
  }
  return Math.max(1, parsed);
}

function queueWorkerClaimStaleHeartbeatMs(): number {
  const raw = (process.env.HB_QUEUE_CLAIM_STALE_HEARTBEAT_MS ?? "").trim();
  const parsed = raw
    ? Number.parseInt(raw, 10)
    : DEFAULT_CLAIM_STALE_HEARTBEAT_MS;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CLAIM_STALE_HEARTBEAT_MS;
  }
  return Math.max(1_000, parsed);
}

function isoTimeMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isExpiredIso(value: string | null | undefined, nowMs: number): boolean {
  const valueMs = isoTimeMs(value);
  return valueMs !== null && valueMs <= nowMs;
}

function activeRunKeepaliveIntervalMs(leaseSeconds: number): number {
  if (leaseSeconds <= 0) {
    return ACTIVE_RUN_KEEPALIVE_MIN_INTERVAL_MS;
  }
  return Math.max(
    ACTIVE_RUN_KEEPALIVE_MIN_INTERVAL_MS,
    Math.min(
      ACTIVE_RUN_KEEPALIVE_MAX_INTERVAL_MS,
      Math.trunc((leaseSeconds * 1000) / 2),
    ),
  );
}

export function runtimeQueueWorkerClaimedBy(prefix = DEFAULT_CLAIMED_BY): string {
  const normalized = prefix.trim() || DEFAULT_CLAIMED_BY;
  return `${normalized}:${process.pid}:${randomUUID()}`;
}

export class RuntimeQueueWorker implements QueueWorkerLike {
  readonly #store: RuntimeStateStore;
  readonly #logger: RuntimeQueueWorkerOptions["logger"];
  readonly #executeClaimedInput: (record: SessionInputRecord, options?: { signal?: AbortSignal }) => Promise<void>;
  readonly #claimedBy: string;
  readonly #leaseSeconds: number;
  readonly #pollIntervalMs: number;
  readonly #maxConcurrency: number;
  readonly #claimStaleHeartbeatMs: number;
  #stopped = false;
  #task: Promise<void> | null = null;
  #wakeResolver: (() => void) | null = null;
  #activeRuns = new Map<
    string,
    {
      controller: AbortController;
      record: SessionInputRecord;
      promise: Promise<void>;
    }
  >();

  constructor(options: RuntimeQueueWorkerOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#claimedBy = options.claimedBy ?? DEFAULT_CLAIMED_BY;
    this.#executeClaimedInput =
      options.executeClaimedInput ??
      ((record, executionOptions) =>
        processClaimedInput({
          store: this.#store,
          record,
          claimedBy: this.#claimedBy,
          leaseSeconds: this.#leaseSeconds,
          memoryService: options.memoryService ?? null,
          wakeDurableMemoryWorker: options.wakeDurableMemoryWorker ?? null,
          abortSignal: executionOptions?.signal,
        }));
    this.#leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#maxConcurrency = options.maxConcurrency ?? queueWorkerMaxConcurrency();
    this.#claimStaleHeartbeatMs =
      options.claimStaleHeartbeatMs ?? queueWorkerClaimStaleHeartbeatMs();
  }

  async start(): Promise<void> {
    if (this.#task) {
      return;
    }
    this.#stopped = false;
    this.#task = this.#runLoop();
  }

  wake(): void {
    const resolve = this.#wakeResolver;
    this.#wakeResolver = null;
    resolve?.();
  }

  async close(): Promise<void> {
    this.#stopped = true;
    this.wake();
    const task = this.#task;
    this.#task = null;
    await task;
    const activePromises = [...this.#activeRuns.values()].map((entry) => entry.promise);
    if (activePromises.length > 0) {
      await Promise.allSettled(activePromises);
    }
  }

  async pauseSessionRun(params: { workspaceId: string; sessionId: string }): Promise<{
    inputId: string;
    sessionId: string;
    status: "PAUSED" | "PAUSING";
  } | null> {
    const runtimeState = this.#store.getRuntimeState({
      workspaceId: params.workspaceId,
      sessionId: params.sessionId,
    });
    const inputId = runtimeState?.currentInputId?.trim() || "";
    if (!inputId) {
      return null;
    }

    const record = this.#store.getInput({
      workspaceId: params.workspaceId,
      inputId,
    });
    if (!record || record.workspaceId !== params.workspaceId || record.sessionId !== params.sessionId) {
      return null;
    }

    if (record.status === "QUEUED") {
      this.#persistPausedQueuedInput(record);
      return {
        inputId: record.inputId,
        sessionId: record.sessionId,
        status: "PAUSED",
      };
    }

    const activeRun = this.#activeRuns.get(record.inputId);
    if (record.status !== "CLAIMED" || !activeRun) {
      return null;
    }
    activeRun.controller.abort("user_requested_pause");
    return {
      inputId: record.inputId,
      sessionId: record.sessionId,
      status: "PAUSING",
    };
  }

  async processAvailableInputsOnce(): Promise<number> {
    // The store reads/writes here (recovery + claim) can hit a transient
    // "database is locked" under contention. This method is driven by the poll
    // loop, which is launched fire-and-forget, so an unguarded throw becomes an
    // unhandledRejection → process.exit(1). Swallow-and-log instead: the loop
    // simply retries on the next tick.
    try {
      const recovered = this.#recoverClaimedInputs();
      const availableSlots = Math.max(0, this.#maxConcurrency - this.#activeRuns.size);
      if (availableSlots === 0) {
        return recovered;
      }
      const blockedSessionIds = [...this.#activeRuns.values()].map((entry) => entry.record.sessionId);
      const claimed = this.#store.claimInputs({
        limit: availableSlots,
        claimedBy: this.#claimedBy,
        leaseSeconds: this.#leaseSeconds,
        distinctSessions: true,
        excludeSessionIds: blockedSessionIds,
      });
      if (claimed.length === 0) {
        return recovered;
      }
      for (const record of claimed) {
        this.#startClaimedInput(record);
      }
      return recovered + claimed.length;
    } catch (error) {
      this.#logger?.error?.("queue worker poll cycle failed (will retry)", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopped) {
      const processed = await this.processAvailableInputsOnce();
      if (processed > 0) {
        continue;
      }
      await this.#waitForWakeOrTimeout();
    }
  }

  async #waitForWakeOrTimeout(): Promise<void> {
    await Promise.race([
      sleep(this.#pollIntervalMs),
      new Promise<void>((resolve) => {
        this.#wakeResolver = resolve;
      })
    ]);
    this.#wakeResolver = null;
  }

  #startClaimedInput(record: SessionInputRecord): void {
    const controller = new AbortController();
    let keepalive: NodeJS.Timeout | null = null;
    const stopKeepalive = () => {
      if (!keepalive) {
        return;
      }
      clearInterval(keepalive);
      keepalive = null;
    };
    const renewActiveRunClaim = () => {
      const currentRecord = this.#store.getInput({
        workspaceId: record.workspaceId,
        inputId: record.inputId,
      });
      if (
        !currentRecord ||
        currentRecord.status !== "CLAIMED" ||
        currentRecord.claimedBy !== this.#claimedBy
      ) {
        return;
      }
      const renewedClaim = this.#store.renewInputClaim({
        workspaceId: record.workspaceId,
        inputId: record.inputId,
        claimedBy: this.#claimedBy,
        leaseSeconds: this.#leaseSeconds,
      });
      if (!renewedClaim?.claimedUntil) {
        return;
      }
      const runtimeState = this.#store.getRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
      });
      if (
        runtimeState?.currentInputId === record.inputId &&
        runtimeState.currentWorkerId === this.#claimedBy
      ) {
        this.#store.updateRuntimeState({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          status: runtimeState.status,
          currentInputId: record.inputId,
          currentWorkerId: this.#claimedBy,
          leaseUntil: renewedClaim.claimedUntil,
          lastError: runtimeState.lastError,
        });
      }
    };
    keepalive = setInterval(() => {
      // A transient "database is locked" (or any store error) here must NEVER
      // crash the runtime: this callback runs on a timer, so an unguarded throw
      // becomes an uncaughtException → process.exit(1), aborting the in-flight
      // run the user just queued. A missed renewal is harmless — the lease
      // renews on the next tick, and stale-claim recovery is the safety net.
      try {
        renewActiveRunClaim();
      } catch (error) {
        this.#logger?.error?.("active run claim renewal failed (will retry)", {
          inputId: record.inputId,
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, activeRunKeepaliveIntervalMs(this.#leaseSeconds));
    keepalive.unref?.();
    const promise = (async () => {
      try {
        await this.#executeClaimedInput(record, { signal: controller.signal });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#logger?.error?.("TS queue worker failed to process claimed input", {
          inputId: record.inputId,
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          error: message
        });
        // Guard the cleanup writes: this runs inside the run promise, so a
        // throw here (e.g. a transient "database is locked") would surface as an
        // unhandledRejection → process.exit(1). Stale-claim recovery re-fails
        // the input later if these writes don't land now.
        try {
          this.#store.updateInput({
            workspaceId: record.workspaceId,
            inputId: record.inputId,
            fields: {
              status: "FAILED",
              claimedBy: null,
              claimedUntil: null
            }
          });
          this.#store.updateRuntimeState({
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            status: "ERROR",
            currentInputId: null,
            currentWorkerId: null,
            leaseUntil: null,
            heartbeatAt: null,
            lastError: { message }
          });
        } catch (cleanupError) {
          this.#logger?.error?.("failed to persist claimed-input failure state", {
            inputId: record.inputId,
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      } finally {
        stopKeepalive();
        this.#activeRuns.delete(record.inputId);
        this.wake();
      }
    })();
    this.#activeRuns.set(record.inputId, { controller, record, promise });
  }

  #recoverClaimedInputs(): number {
    const claimed = this.#store.listClaimedInputs();
    const nowMs = Date.now();
    const recoveredIds: string[] = [];

    for (const record of claimed) {
      const activeRun = this.#activeRuns.get(record.inputId);
      const runtimeState = this.#store.getRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
      });
      const recovery = this.#claimRecovery(record, runtimeState, activeRun, nowMs);
      if (!recovery) {
        continue;
      }
      if (recovery.failureKind === "claim_expired" && activeRun) {
        const renewedClaim = this.#store.renewInputClaim({
          workspaceId: record.workspaceId,
          inputId: record.inputId,
          claimedBy: this.#claimedBy,
          leaseSeconds: this.#leaseSeconds,
        });
        if (renewedClaim?.claimedUntil) {
          this.#store.updateRuntimeState({
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            status: "BUSY",
            currentInputId: record.inputId,
            currentWorkerId: this.#claimedBy,
            leaseUntil: renewedClaim.claimedUntil,
            lastError: null,
          });
          this.#logger?.info?.(
            "Renewed expired claimed runtime input lease for local active run",
            {
              inputId: record.inputId,
              workspaceId: record.workspaceId,
              sessionId: record.sessionId,
            },
          );
          continue;
        }
      }

      activeRun?.controller.abort("claim_expired");
      const events = this.#store.listOutputEvents({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        inputId: record.inputId
      });
      const hasTerminal = events.some((event) => TERMINAL_EVENT_TYPES.has(event.eventType));
      const shouldRequeue =
        !activeRun &&
        !hasTerminal &&
        this.#shouldRequeueRecoveredClaim(record, events);
      if (shouldRequeue) {
        const startedBeforeInterruption = events.some(
          (event) => event.eventType !== "run_claimed",
        );
        if (startedBeforeInterruption) {
          // The interrupted attempt already emitted run_started/streaming
          // events; clear them so the retry produces a clean event stream
          // rather than duplicating sequence numbers on top of the old run.
          this.#store.deleteOutputEventsForInput({
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            inputId: record.inputId,
          });
        }
        this.#store.updateInput({
          workspaceId: record.workspaceId,
          inputId: record.inputId,
          fields: {
            status: "QUEUED",
            claimedBy: null,
            claimedUntil: null,
            availableAt: utcNowIso(),
            attempt: record.attempt + 1,
          },
        });

        const runtimeStateAfterRecovery = this.#store.getRuntimeState({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
        });
        if (runtimeStateAfterRecovery?.currentInputId === record.inputId) {
          this.#store.updateRuntimeState({
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            status: "IDLE",
            currentInputId: null,
            currentWorkerId: null,
            leaseUntil: null,
            heartbeatAt: null,
            lastError: null,
          });
        }
        recoveredIds.push(record.inputId);
        this.#logger?.info?.("Requeued stale claimed runtime input for retry", {
          inputId: record.inputId,
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          failureKind: recovery.failureKind,
          eventCount: events.length,
          startedBeforeInterruption,
          attempt: record.attempt + 1,
        });
        continue;
      }
      if (!hasTerminal) {
        const failure = buildRunFailedEvent({
          sessionId: record.sessionId,
          inputId: record.inputId,
          sequence: Math.max(0, ...events.map((event) => event.sequence)) + 1,
          message: recovery.message,
          errorType: "RuntimeError"
        });
        this.#store.appendOutputEvent({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          inputId: record.inputId,
          sequence: typeof failure.sequence === "number" ? failure.sequence : events.length + 1,
          eventType: String(failure.event_type),
          payload: failure.payload as Record<string, unknown>
        });
      }

      this.#store.updateInput({
        workspaceId: record.workspaceId,
        inputId: record.inputId,
        fields: {
          status: "FAILED",
          claimedBy: null,
          claimedUntil: null
        }
      });

      const runtimeStateAfterRecovery = this.#store.getRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId
      });
      if (runtimeStateAfterRecovery?.currentInputId === record.inputId) {
        this.#store.updateRuntimeState({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          status: "ERROR",
          currentInputId: null,
          currentWorkerId: null,
          leaseUntil: null,
          heartbeatAt: null,
          lastError: { message: recovery.message }
        });
      }
      recoveredIds.push(record.inputId);
    }
    if (recoveredIds.length > 0) {
      this.#logger?.error?.("Recovered stale claimed runtime inputs", {
        count: recoveredIds.length,
        inputIds: recoveredIds,
      });
    }
    return recoveredIds.length;
  }

  #claimRecovery(
    record: SessionInputRecord,
    runtimeState: SessionRuntimeStateRecord | null,
    activeRun: { controller: AbortController; record: SessionInputRecord; promise: Promise<void> } | undefined,
    nowMs: number,
  ): { failureKind: "claim_expired" | "claim_abandoned"; message: string } | null {
    const claimExpired = isExpiredIso(record.claimedUntil, nowMs);
    if (claimExpired) {
      const runtimeOwnsInput =
        runtimeState?.currentInputId === record.inputId;
      const runtimeOwnerId =
        typeof runtimeState?.currentWorkerId === "string"
          ? runtimeState.currentWorkerId.trim()
          : "";
      const heartbeatAtMs = isoTimeMs(runtimeState?.heartbeatAt);
      const heartbeatFresh =
        heartbeatAtMs !== null &&
        nowMs - heartbeatAtMs <= this.#claimStaleHeartbeatMs;
      if (
        !activeRun &&
        runtimeOwnsInput &&
        runtimeOwnerId &&
        runtimeOwnerId !== this.#claimedBy &&
        heartbeatFresh
      ) {
        return null;
      }
      return {
        failureKind: "claim_expired",
        message:
          "claimed input lease expired before the runner emitted a terminal event",
      };
    }

    const runtimeOwnsInput =
      runtimeState?.currentInputId === record.inputId;
    const runtimeOwnerId =
      typeof runtimeState?.currentWorkerId === "string"
        ? runtimeState.currentWorkerId.trim()
        : "";
    const heartbeatAtMs = isoTimeMs(runtimeState?.heartbeatAt);
    const heartbeatStale =
      heartbeatAtMs !== null &&
      nowMs - heartbeatAtMs > this.#claimStaleHeartbeatMs;
    if (
      !activeRun &&
      runtimeOwnsInput &&
      runtimeOwnerId &&
      runtimeOwnerId !== this.#claimedBy &&
      heartbeatStale
    ) {
      return {
        failureKind: "claim_abandoned",
        message:
          "claimed input was abandoned by a stale worker before the runner emitted a terminal event",
      };
    }

    return null;
  }

  #shouldRequeueRecoveredClaim(
    record: SessionInputRecord,
    events: Array<{ eventType: string }>,
  ): boolean {
    const turnResult = this.#store.getTurnResult({
      workspaceId: record.workspaceId,
      inputId: record.inputId,
    });
    if (turnResult) {
      // Real work was already committed for this turn — never replay it.
      return false;
    }
    // A run that was only claimed (never started) is always safe to retry.
    if (events.every((event) => event.eventType === "run_claimed")) {
      return true;
    }
    // Cron/scheduled runs are fire-and-forget retries: when a runtime restart
    // interrupts execution before any terminal event or committed turn result,
    // retry rather than surfacing a spurious "abandoned" failure — bounded so a
    // genuinely failing input cannot requeue forever.
    if (
      this.#isRetriableScheduledInput(record) &&
      record.attempt < DEFAULT_SCHEDULED_RECOVERY_REQUEUE_ATTEMPTS
    ) {
      return true;
    }
    return false;
  }

  #isRetriableScheduledInput(record: SessionInputRecord): boolean {
    if (record.sessionId.startsWith("scheduled-")) {
      return true;
    }
    const context = record.payload?.context;
    if (context && typeof context === "object" && !Array.isArray(context)) {
      const cronjobId = (context as Record<string, unknown>).cronjob_id;
      if (typeof cronjobId === "string" && cronjobId.trim().length > 0) {
        return true;
      }
    }
    return false;
  }

  #persistPausedQueuedInput(record: SessionInputRecord): void {
    const completedAt = utcNowIso();
    const events = this.#store.listOutputEvents({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      inputId: record.inputId,
    });
    const completed = buildRunCompletedEvent({
      sessionId: record.sessionId,
      inputId: record.inputId,
      sequence: Math.max(0, ...events.map((event) => event.sequence)) + 1,
      payload: {
        status: "paused",
        stop_reason: "paused",
        message: "Run paused by user request",
      },
    });
    this.#store.appendOutputEvent({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      inputId: record.inputId,
      sequence: typeof completed.sequence === "number" ? completed.sequence : events.length + 1,
      eventType: String(completed.event_type),
      payload: completed.payload as Record<string, unknown>,
      createdAt: completedAt,
    });
    this.#store.updateInput({
      workspaceId: record.workspaceId,
      inputId: record.inputId,
      fields: {
        status: "PAUSED",
        claimedBy: null,
        claimedUntil: null,
      },
    });
    this.#store.updateRuntimeState({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      status: "PAUSED",
      currentInputId: null,
      currentWorkerId: null,
      leaseUntil: null,
      heartbeatAt: null,
      lastError: null,
    });
    this.#store.upsertTurnResult({
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      inputId: record.inputId,
      startedAt: record.createdAt,
      completedAt,
      status: "paused",
      stopReason: "paused",
      assistantText: "",
      toolUsageSummary: {
        total_calls: 0,
        completed_calls: 0,
        failed_calls: 0,
        tool_names: [],
        tool_ids: [],
      },
      permissionDenials: [],
      promptSectionIds: [],
      capabilityManifestFingerprint: null,
      requestSnapshotFingerprint: null,
      promptCacheProfile: null,
      tokenUsage: null,
    });
  }
}
