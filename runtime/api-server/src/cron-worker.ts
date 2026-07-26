import { setTimeout as sleep } from "node:timers/promises";

import { CronExpressionParser } from "cron-parser";

import {
  type CronjobRecord,
  type RuntimeStateStore,
} from "@holaboss/runtime-state-store";

import type { QueueWorkerLike } from "./queue-worker.js";
import { processDueCronjobs } from "./cronjob-runtime.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;

type LoggerLike = {
  info: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
};

/**
 * The state-store throws `workspace_folder_missing` when assertWorkspace
 * FolderHealthy fails. Detecting it lets the worker skip an orphaned
 * workspace row without crashing the runtime. Match by structured
 * `code` (preferred) and fall back to message text since older state-
 * store builds may not set the code consistently.
 */
function isWorkspaceFolderMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "workspace_folder_missing") return true;
  if (error instanceof Error) {
    return /workspace folder is missing/i.test(error.message);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedTimezone(value: unknown): string | null {
  const timezone = normalizedString(value);
  if (!timezone) {
    return null;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return null;
  }
}

export function resolveProcessTimezone(): string | null {
  try {
    return normalizedTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

export function runtimeUserTimezone(
  store: Pick<RuntimeStateStore, "getRuntimeUserProfile">,
): string | null {
  return (
    normalizedTimezone(store.getRuntimeUserProfile()?.timezone) ??
    resolveProcessTimezone()
  );
}

function cronjobPinnedTimezone(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  return isRecord(metadata) ? normalizedTimezone(metadata.timezone) : null;
}

export function cronjobResolvedTimezone(
  metadata: Record<string, unknown> | null | undefined,
  fallbackTimezone?: string | null,
): string | null {
  return (
    cronjobPinnedTimezone(metadata) ??
    normalizedTimezone(fallbackTimezone) ??
    resolveProcessTimezone()
  );
}

export function cronjobMetadataWithResolvedTimezone(
  metadata: Record<string, unknown> | null | undefined,
  fallbackTimezone?: string | null,
): Record<string, unknown> {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const timezone = cronjobResolvedTimezone(nextMetadata, fallbackTimezone);
  if (timezone) {
    nextMetadata.timezone = timezone;
  }
  return nextMetadata;
}

export function cronjobCheckIntervalMs(): number {
  const raw = (process.env.CRONJOB_RUNNER_CHECK_INTERVAL_SECONDS ?? "").trim();
  const parsed = Number.parseInt(raw || "60", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  return Math.max(5, parsed) * 1000;
}

export function cronjobNextRunAt(
  cronExpression: string,
  now: Date,
  timezone?: string | null,
): string | null {
  try {
    const interval = CronExpressionParser.parse(cronExpression, {
      currentDate: now,
      ...(normalizedTimezone(timezone) ? { tz: normalizedTimezone(timezone)! } : {}),
    });
    return interval.next().toISOString();
  } catch {
    return null;
  }
}

export function cronjobIsDue(
  job: CronjobRecord,
  now: Date,
  fallbackTimezone?: string | null,
): boolean {
  if (!job.enabled) {
    return false;
  }
  const pinnedTimezone = cronjobPinnedTimezone(job.metadata);
  const effectiveTimezone =
    pinnedTimezone ?? cronjobResolvedTimezone(job.metadata, fallbackTimezone);
  const nextRunAtRaw = normalizedString(job.nextRunAt);
  if (nextRunAtRaw && pinnedTimezone) {
    const nextRunAt = new Date(nextRunAtRaw);
    if (!Number.isNaN(nextRunAt.getTime())) {
      return now >= nextRunAt;
    }
  }
  let lastScheduled: Date;
  try {
    lastScheduled = CronExpressionParser.parse(job.cron, {
      currentDate: now,
      ...(effectiveTimezone ? { tz: effectiveTimezone } : {}),
    }).prev().toDate();
  } catch {
    return false;
  }
  if (!job.lastRunAt) {
    return true;
  }
  const lastRunAt = new Date(job.lastRunAt);
  if (Number.isNaN(lastRunAt.getTime())) {
    return true;
  }
  return lastRunAt < lastScheduled;
}

export function cronjobInstruction(description: string, metadata: Record<string, unknown>): string {
  const cleanedDescription = description.trim();
  const executionMetadata = Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) =>
        ![
          "model",
          "session_id",
          "source_session_id",
          "priority",
          "idempotency_key"
        ].includes(key)
    )
  );
  if (Object.keys(executionMetadata).length === 0) {
    return cleanedDescription;
  }
  return `${cleanedDescription}\n\n[Cronjob Metadata]\n${JSON.stringify(executionMetadata)}`;
}

export interface CronWorkerLike {
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeCronWorkerOptions {
  store: RuntimeStateStore;
  logger?: LoggerLike;
  queueWorker?: QueueWorkerLike | null;
  pollIntervalMs?: number;
}

export class RuntimeCronWorker implements CronWorkerLike {
  readonly #store: RuntimeStateStore;
  readonly #logger: LoggerLike | undefined;
  readonly #pollIntervalMs: number;
  #stopped = false;
  #task: Promise<void> | null = null;
  #wakeResolver: (() => void) | null = null;

  constructor(options: RuntimeCronWorkerOptions) {
    this.#store = options.store;
    this.#logger = options.logger;
    this.#pollIntervalMs = options.pollIntervalMs ?? cronjobCheckIntervalMs();
  }

  async start(): Promise<void> {
    if (this.#task) {
      return;
    }
    this.#stopped = false;
    this.#task = this.#runLoop();
  }

  async close(): Promise<void> {
    this.#stopped = true;
    const resolve = this.#wakeResolver;
    this.#wakeResolver = null;
    resolve?.();
    const task = this.#task;
    this.#task = null;
    await task;
  }

  async processDueCronjobsOnce(now = new Date()): Promise<number> {
    const nowIso = now.toISOString();
    let processed = 0;
    for (const workspace of this.#store.listWorkspaces({ includeDeleted: false })) {
      if (workspace.deletedAtUtc) {
        continue;
      }
      try {
        processed += processDueCronjobs({
          store: this.#store,
          workspace,
          now: nowIso,
          logger: this.#logger,
        });
      } catch (error) {
        // Workspace folder missing / DB unreachable / similar per-
        // workspace failure. Without this guard, ONE broken workspace
        // kills the whole runtime at boot (the worker bubbles the
        // error up to the entrypoint and the process exits 1). Skip
        // the offender, log loud, keep the rest healthy.
        if (isWorkspaceFolderMissingError(error)) {
          this.#logger?.warn?.(
            "Cron worker: workspace folder missing, skipping",
            {
              event: "cronjob.scheduler.workspace_folder_missing",
              workspace_id: workspace.id,
              workspace_path: (error as { workspacePath?: unknown })
                .workspacePath,
            },
          );
          continue;
        }
        this.#logger?.error?.(
          "Cron worker: per-workspace processing failed, skipping",
          {
            event: "cronjob.scheduler.workspace_failed",
            workspace_id: workspace.id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    return processed;
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopped) {
      await this.processDueCronjobsOnce();
      if (this.#stopped) {
        return;
      }
      await Promise.race([
        sleep(this.#pollIntervalMs),
        new Promise<void>((resolve) => {
      this.#wakeResolver = resolve;
        })
      ]);
      this.#wakeResolver = null;
    }
  }

}
