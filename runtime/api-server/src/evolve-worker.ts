import { setTimeout as sleep } from "node:timers/promises";

import type { PostRunJobRecord, RuntimeStateStore } from "@holaboss/runtime-state-store";

import type { MemoryServiceLike } from "./memory.js";
import { processEvolveJob } from "./evolve.js";

const DEFAULT_CLAIMED_BY = "evolve-worker";
const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5000;

export interface DurableMemoryWorkerLike {
  start(): Promise<void>;
  wake(): void;
  close(): Promise<void>;
}

export interface RuntimeEvolveWorkerOptions {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  logger?: {
    info: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
  executeClaimedJob?: (record: PostRunJobRecord) => Promise<void>;
  claimedBy?: string;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function workerMaxConcurrency(): number {
  const raw = (
    process.env.HB_EVOLVE_WORKER_CONCURRENCY ??
    process.env.HB_POST_RUN_DURABLE_MEMORY_WORKER_CONCURRENCY ??
    ""
  ).trim();
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_MAX_CONCURRENCY;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_CONCURRENCY;
  }
  return Math.max(1, parsed);
}

export class RuntimeEvolveWorker implements DurableMemoryWorkerLike {
  readonly #store: RuntimeStateStore;
  readonly #logger: RuntimeEvolveWorkerOptions["logger"];
  readonly #executeClaimedJob: (record: PostRunJobRecord) => Promise<void>;
  readonly #claimedBy: string;
  readonly #leaseSeconds: number;
  readonly #pollIntervalMs: number;
  readonly #maxConcurrency: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  #stopped = false;
  #task: Promise<void> | null = null;
  #wakeResolver: (() => void) | null = null;

  constructor(options: RuntimeEvolveWorkerOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#claimedBy = options.claimedBy ?? DEFAULT_CLAIMED_BY;
    this.#executeClaimedJob =
      options.executeClaimedJob ??
      ((record) =>
        processEvolveJob({
          store: this.#store,
          record,
          memoryService: options.memoryService,
        }));
    this.#leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#maxConcurrency = options.maxConcurrency ?? workerMaxConcurrency();
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
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
  }

  async processAvailableJobsOnce(): Promise<number> {
    const recovered = this.#recoverExpiredClaims();
    const claimed = this.#store.claimPostRunJobs({
      limit: this.#maxConcurrency,
      claimedBy: this.#claimedBy,
      leaseSeconds: this.#leaseSeconds,
      distinctSessions: true,
    });
    if (claimed.length === 0) {
      return recovered;
    }
    await Promise.all(
      claimed.map(async (record) => {
        try {
          await this.#executeClaimedJob(record);
          this.#store.updatePostRunJob({
            workspaceId: record.workspaceId,
            jobId: record.jobId,
            fields: {
              status: "DONE",
              claimedBy: null,
              claimedUntil: null,
              lastError: null,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.#logger?.error?.("Evolve worker failed to process claimed job", {
            jobId: record.jobId,
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            inputId: record.inputId,
            error: message,
          });
          this.#requeueOrFail(record, message);
        }
      }),
    );
    return recovered + claimed.length;
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopped) {
      const processed = await this.processAvailableJobsOnce();
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
      }),
    ]);
    this.#wakeResolver = null;
  }

  #recoverExpiredClaims(): number {
    const expired = this.#store.listExpiredClaimedPostRunJobs();
    for (const record of expired) {
      this.#requeueOrFail(record, "claimed evolve job lease expired before durable writeback completed");
    }
    if (expired.length > 0) {
      this.#logger?.error?.("Recovered expired claimed evolve jobs", {
        count: expired.length,
        jobIds: expired.map((record) => record.jobId),
      });
    }
    return expired.length;
  }

  #requeueOrFail(record: PostRunJobRecord, message: string): void {
    const nextAttempt = record.attempt + 1;
    const shouldFail = nextAttempt >= this.#maxAttempts;
    this.#store.updatePostRunJob({
      workspaceId: record.workspaceId,
      jobId: record.jobId,
      fields: {
        status: shouldFail ? "FAILED" : "QUEUED",
        attempt: nextAttempt,
        claimedBy: null,
        claimedUntil: null,
        availableAt: shouldFail ? record.availableAt : new Date(Date.now() + this.#retryDelayMs).toISOString(),
        lastError: { message },
      },
    });
  }
}
