import { type RuntimeStateStore } from "@holaboss/runtime-state-store";

import { supportsIntegrationContextFetchProvider } from "./integration-context-fetch.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_SCHEDULE_INTERVAL_MS = 30 * 60_000;

type LoggerLike = {
  warn: (meta: Record<string, unknown>, message: string) => void;
};

type FetchManagerLike = {
  start: (params: { connectionId: string }) => Promise<{
    ok: true;
    started: boolean;
    deduped: boolean;
  }>;
};

export interface IntegrationContextAutofetchWorkerLike {
  start(): Promise<void>;
  wake(): void;
  close(): Promise<void>;
  processDueConnectionsOnce(now?: Date): Promise<string[]>;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldAutofetchConnection(params: {
  connection: {
    connectionId: string;
    providerId: string;
    status: string;
    contextCronAutoFetchEnabled: boolean;
    lastContextFetchAttemptedAt: string | null;
    createdAt: string;
  };
  nowMs: number;
  scheduleIntervalMs: number;
}): boolean {
  const providerId = params.connection.providerId.trim().toLowerCase();
  if (!supportsIntegrationContextFetchProvider(providerId)) {
    return false;
  }
  if (!params.connection.contextCronAutoFetchEnabled) {
    return false;
  }
  if (params.connection.status.trim().toLowerCase() !== "active") {
    return false;
  }
  const baselineMs =
    parseIsoMs(params.connection.lastContextFetchAttemptedAt)
    ?? parseIsoMs(params.connection.createdAt);
  if (baselineMs == null) {
    return true;
  }
  return params.nowMs - baselineMs >= params.scheduleIntervalMs;
}

export class RuntimeIntegrationContextAutofetchWorker
  implements IntegrationContextAutofetchWorkerLike
{
  private readonly store: RuntimeStateStore;
  private readonly fetchManager: FetchManagerLike;
  private readonly logger: LoggerLike | null;
  private readonly pollIntervalMs: number;
  private readonly scheduleIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private closed = false;
  private running = false;
  private rerunRequested = false;

  constructor(params: {
    store: RuntimeStateStore;
    fetchManager: FetchManagerLike;
    logger?: LoggerLike | null;
    pollIntervalMs?: number;
    scheduleIntervalMs?: number;
  }) {
    this.store = params.store;
    this.fetchManager = params.fetchManager;
    this.logger = params.logger ?? null;
    this.pollIntervalMs = params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.scheduleIntervalMs =
      params.scheduleIntervalMs ?? DEFAULT_SCHEDULE_INTERVAL_MS;
  }

  async start(): Promise<void> {
    if (this.started || this.closed) {
      return;
    }
    this.started = true;
    this.scheduleRun(0);
  }

  wake(): void {
    if (!this.started || this.closed) {
      return;
    }
    this.scheduleRun(0);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async processDueConnectionsOnce(now = new Date()): Promise<string[]> {
    const nowMs = now.getTime();
    const dueConnectionIds = this.store
      .listIntegrationConnections()
      .filter((connection) =>
        shouldAutofetchConnection({
          connection,
          nowMs,
          scheduleIntervalMs: this.scheduleIntervalMs,
        }),
      )
      .map((connection) => connection.connectionId);
    if (dueConnectionIds.length === 0) {
      return [];
    }
    await Promise.all(
      dueConnectionIds.map(async (connectionId) => {
        try {
          await this.fetchManager.start({ connectionId });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger?.warn(
            { connectionId, error: message },
            "integration context autofetch start failed",
          );
        }
      }),
    );
    return dueConnectionIds;
  }

  private scheduleRun(delayMs: number): void {
    if (this.closed) {
      return;
    }
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce();
    }, Math.max(0, delayMs));
  }

  private async runOnce(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      await this.processDueConnectionsOnce();
    } finally {
      this.running = false;
      if (this.closed) {
        return;
      }
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.scheduleRun(0);
        return;
      }
      this.scheduleRun(this.pollIntervalMs);
    }
  }
}

