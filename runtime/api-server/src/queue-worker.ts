import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type RuntimeStateStore,
  type SessionInputRecord,
  type SessionRuntimeStateRecord,
  utcNowIso,
} from "@holaboss/runtime-state-store";

import { processClaimedInput } from "./claimed-input-executor.js";
import {
  ensureCodexTokensFresh,
  hasCodexProviderConfigured,
} from "./codex-token-refresh.js";
import type { MemoryServiceLike } from "./memory.js";
import { buildRunCompletedEvent, buildRunFailedEvent } from "./runner-worker.js";
import { captureRuntimeException } from "./runtime-sentry.js";

const DEFAULT_CLAIMED_BY = "sandbox-agent-ts-worker";
const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_CONCURRENCY = 5;
const DEFAULT_CLAIM_STALE_HEARTBEAT_MS = 20_000;
const TERMINAL_EVENT_TYPES = new Set(["run_completed", "run_failed"]);
const SESSION_CHECKPOINT_JOB_TYPE = "session_checkpoint";

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
  captureRuntimeException?: typeof captureRuntimeException;
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

export function runtimeQueueWorkerClaimedBy(prefix = DEFAULT_CLAIMED_BY): string {
  const normalized = prefix.trim() || DEFAULT_CLAIMED_BY;
  return `${normalized}:${process.pid}:${randomUUID()}`;
}

export class RuntimeQueueWorker implements QueueWorkerLike {
  readonly #store: RuntimeStateStore;
  readonly #logger: RuntimeQueueWorkerOptions["logger"];
  readonly #executeClaimedInput: (record: SessionInputRecord, options?: { signal?: AbortSignal }) => Promise<void>;
  readonly #captureRuntimeException: typeof captureRuntimeException;
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
    this.#captureRuntimeException =
      options.captureRuntimeException ?? captureRuntimeException;
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
    const codexConfigured = hasCodexProviderConfigured();
    const promise = (async () => {
      try {
        if (codexConfigured) {
          await ensureCodexTokensFresh().catch(() => undefined);
        }
        await this.#executeClaimedInput(record, { signal: controller.signal });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#captureRuntimeException({
          error,
          level: "error",
          fingerprint: ["runtime", "queue_worker", "claimed_input_exception"],
          tags: {
            surface: "queue_worker",
            failure_kind: "claimed_input_exception",
          },
          contexts: {
            claimed_input: {
              workspace_id: record.workspaceId,
              session_id: record.sessionId,
              input_id: record.inputId,
            },
          },
          extras: {
            claimed_by: this.#claimedBy,
          },
        });
        this.#logger?.error?.("TS queue worker failed to process claimed input", {
          inputId: record.inputId,
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          error: message
        });
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
      } finally {
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
      const waitingForSessionCheckpoint =
        recovery.failureKind === "claim_expired" &&
        Boolean(activeRun) &&
        this.#store.listPostRunJobs({
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          jobType: SESSION_CHECKPOINT_JOB_TYPE,
          statuses: ["QUEUED", "CLAIMED"],
          limit: 1,
          offset: 0,
        }).length > 0;
      if (waitingForSessionCheckpoint) {
        const renewedClaim = this.#store.renewInputClaim({
          workspaceId: record.workspaceId,
          inputId: record.inputId,
          claimedBy: record.claimedBy ?? this.#claimedBy,
          leaseSeconds: this.#leaseSeconds,
        });
        if (renewedClaim) {
          const runtimeState = this.#store.getRuntimeState({
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
          });
          if (runtimeState?.currentInputId === record.inputId) {
            this.#store.updateRuntimeState({
              workspaceId: record.workspaceId,
              sessionId: record.sessionId,
              status: runtimeState.status,
              leaseUntil: renewedClaim.claimedUntil,
              lastError: null,
            });
          }
          this.#logger?.info?.(
            "Extended claimed runtime input lease while waiting for session checkpoint",
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
        this.#logger?.info?.("Requeued stale claimed input before execution started", {
          inputId: record.inputId,
          workspaceId: record.workspaceId,
          sessionId: record.sessionId,
          failureKind: recovery.failureKind,
          eventCount: events.length,
        });
        continue;
      }
      if (!hasTerminal) {
        this.#captureRuntimeException({
          error: new Error(recovery.message),
          level: recovery.failureKind === "claim_expired" ? "error" : "warning",
          fingerprint: ["runtime", "queue_worker", recovery.failureKind],
          tags: {
            surface: "queue_worker",
            failure_kind: recovery.failureKind,
          },
          contexts: {
            claimed_input: {
              workspace_id: record.workspaceId,
              session_id: record.sessionId,
              input_id: record.inputId,
            },
          },
          extras: {
            active_run_present: Boolean(activeRun),
            output_event_count: events.length,
            claimed_by: record.claimedBy,
            claimed_until: record.claimedUntil,
            runtime_state: runtimeState
              ? {
                  status: runtimeState.status,
                  current_input_id: runtimeState.currentInputId,
                  current_worker_id: runtimeState.currentWorkerId,
                  lease_until: runtimeState.leaseUntil,
                  heartbeat_at: runtimeState.heartbeatAt,
                }
              : null,
          },
        });
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
      return false;
    }
    return events.every((event) => event.eventType === "run_claimed");
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
