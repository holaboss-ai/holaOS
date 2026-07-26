import { setTimeout as sleep } from "node:timers/promises";

import type {
  MemoryEmbeddingIndexRecord,
  MemoryEntryRecord,
  RuntimeStateStore,
  WorkspaceRecord,
} from "@holaboss/runtime-state-store";

import { syncRecallEmbeddingsForEntries } from "./memory-embedding-index.js";
import type { MemoryServiceLike } from "./memory.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { RECALL_EMBEDDING_DIM } from "./memory-embedding-index.js";
import { createRecallEmbeddingModelClient } from "./recall-embedding-model.js";

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_INITIAL_DELAY_MS = 30_000;
const ENTRY_PAGE_SIZE = 200;

export interface RecallEmbeddingBackfillWorkerLike {
  start(): Promise<void>;
  wake(): void;
  close(): Promise<void>;
}

export interface RuntimeRecallEmbeddingBackfillWorkerOptions {
  store: RuntimeStateStore;
  memoryService: MemoryServiceLike;
  logger?: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  batchSize?: number;
  pollIntervalMs?: number;
  initialDelayMs?: number;
  createEmbeddingClient?: (params: { workspaceId: string }) => MemoryModelClientConfig | null;
  syncEntries?: (params: {
    store: RuntimeStateStore;
    memoryService: MemoryServiceLike;
    workspaceId: string;
    entries: MemoryEntryRecord[];
    embeddingClient: MemoryModelClientConfig | null;
  }) => Promise<{ indexed: number; skipped: number; deleted: number; disabled: number }>;
}

interface RecallEmbeddingBackfillCycleSummary {
  processed: number;
  reason:
    | "vector_index_unavailable"
    | "active_session_run"
    | "no_pending_entries"
    | "processed_user_batch"
    | "processed_workspace_batch";
  scope: "user" | "workspace" | null;
  workspaceId: string | null;
  batchCount: number;
  indexed: number;
  skipped: number;
  deleted: number;
  disabled: number;
  durationMs: number;
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = (value ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function listAllMemoryEntries(
  store: RuntimeStateStore,
  params: {
    workspaceId?: string | null;
    scope?: string | null;
    status?: string | null;
  },
): MemoryEntryRecord[] {
  const records: MemoryEntryRecord[] = [];
  for (let offset = 0; ; offset += ENTRY_PAGE_SIZE) {
    const page = store.listMemoryEntries({
      ...params,
      limit: ENTRY_PAGE_SIZE,
      offset,
    });
    records.push(...page);
    if (page.length < ENTRY_PAGE_SIZE) {
      return records;
    }
  }
}

function latestWorkspaceActivityAt(store: RuntimeStateStore, workspace: WorkspaceRecord): number {
  const runtimeStates = store.listRuntimeStates(workspace.id);
  const latestState = runtimeStates
    .map((state) => Date.parse(firstNonEmptyString(state.updatedAt, state.createdAt)))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0];
  if (Number.isFinite(latestState)) {
    return latestState;
  }
  const workspaceUpdatedAt = Date.parse(firstNonEmptyString(workspace.updatedAt, workspace.createdAt));
  return Number.isFinite(workspaceUpdatedAt) ? workspaceUpdatedAt : 0;
}

function hasActiveSessionRuns(store: RuntimeStateStore): boolean {
  for (const workspace of store.listWorkspaces({ includeDeleted: false })) {
    if (store.listRuntimeStates(workspace.id).some((state) => Boolean(state.currentInputId?.trim()))) {
      return true;
    }
  }
  return false;
}

function pendingEmbeddingEntries(params: {
  entries: MemoryEntryRecord[];
  indexes: MemoryEmbeddingIndexRecord[];
  embeddingModelId: string;
  workspaceId: string | null;
}): MemoryEntryRecord[] {
  const indexByMemoryId = new Map(params.indexes.map((index) => [index.memoryId, index]));
  return params.entries.filter((entry) => {
    if (entry.status !== "active") {
      return false;
    }
    const index = indexByMemoryId.get(entry.memoryId);
    if (!index) {
      return true;
    }
    if (index.embeddingModel !== params.embeddingModelId || index.embeddingDim !== RECALL_EMBEDDING_DIM) {
      return true;
    }
    const indexedAt = Date.parse(index.updatedAt);
    const entryUpdatedAt = Date.parse(entry.updatedAt);
    if (Number.isFinite(entryUpdatedAt) && Number.isFinite(indexedAt) && entryUpdatedAt > indexedAt) {
      return true;
    }
    return false;
  });
}

export class RuntimeRecallEmbeddingBackfillWorker implements RecallEmbeddingBackfillWorkerLike {
  readonly #store: RuntimeStateStore;
  readonly #memoryService: MemoryServiceLike;
  readonly #logger: RuntimeRecallEmbeddingBackfillWorkerOptions["logger"];
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #initialDelayMs: number;
  readonly #createEmbeddingClient: NonNullable<RuntimeRecallEmbeddingBackfillWorkerOptions["createEmbeddingClient"]>;
  readonly #syncEntries: NonNullable<RuntimeRecallEmbeddingBackfillWorkerOptions["syncEntries"]>;
  #stopped = false;
  #task: Promise<void> | null = null;
  #wakeResolver: (() => void) | null = null;
  #hasWaitedInitialDelay = false;

  constructor(options: RuntimeRecallEmbeddingBackfillWorkerOptions) {
    this.#store = options.store;
    this.#memoryService = options.memoryService;
    this.#logger = options.logger;
    this.#batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    this.#pollIntervalMs = Math.max(1000, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.#initialDelayMs = Math.max(0, options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
    this.#createEmbeddingClient =
      options.createEmbeddingClient ??
      ((params) =>
        createRecallEmbeddingModelClient({
          workspaceId: params.workspaceId,
          sessionId: `embedding-backfill:${params.workspaceId}`,
          inputId: `embedding-backfill:${params.workspaceId}`,
        }));
    this.#syncEntries = options.syncEntries ?? syncRecallEmbeddingsForEntries;
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

  async processAvailableBackfillOnce(): Promise<number> {
    const summary = await this.#processAvailableBackfillCycle();
    this.#logger?.info?.(
      {
        event: "runtime.recall_embedding_backfill.cycle",
        processed: summary.processed,
        reason: summary.reason,
        scope: summary.scope,
        workspace_id: summary.workspaceId,
        batch_count: summary.batchCount,
        indexed: summary.indexed,
        skipped: summary.skipped,
        deleted: summary.deleted,
        disabled: summary.disabled,
        duration_ms: summary.durationMs,
      },
      "Recall embedding backfill cycle",
    );
    return summary.processed;
  }

  async #processAvailableBackfillCycle(): Promise<RecallEmbeddingBackfillCycleSummary> {
    const startedAt = Date.now();
    if (!this.#store.supportsVectorIndex()) {
      return {
        processed: 0,
        reason: "vector_index_unavailable",
        scope: null,
        workspaceId: null,
        batchCount: 0,
        indexed: 0,
        skipped: 0,
        deleted: 0,
        disabled: 0,
        durationMs: Date.now() - startedAt,
      };
    }
    if (hasActiveSessionRuns(this.#store)) {
      return {
        processed: 0,
        reason: "active_session_run",
        scope: null,
        workspaceId: null,
        batchCount: 0,
        indexed: 0,
        skipped: 0,
        deleted: 0,
        disabled: 0,
        durationMs: Date.now() - startedAt,
      };
    }
    const workspaces = this.#store
      .listWorkspaces({ includeDeleted: false })
      .sort((left, right) => latestWorkspaceActivityAt(this.#store, right) - latestWorkspaceActivityAt(this.#store, left));
    const anchorWorkspaceId = workspaces[0]?.id ?? "";
    const userSummary = await this.#processUserBatch(anchorWorkspaceId);
    if (userSummary.processed > 0) {
      return {
        ...userSummary,
        durationMs: Date.now() - startedAt,
      };
    }
    for (const workspace of workspaces) {
      const workspaceSummary = await this.#processWorkspaceBatch(workspace.id);
      if (workspaceSummary.processed > 0) {
        return {
          ...workspaceSummary,
          durationMs: Date.now() - startedAt,
        };
      }
    }
    return {
      processed: 0,
      reason: "no_pending_entries",
      scope: null,
      workspaceId: null,
      batchCount: 0,
      indexed: 0,
      skipped: 0,
      deleted: 0,
      disabled: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  async #processUserBatch(anchorWorkspaceId: string): Promise<RecallEmbeddingBackfillCycleSummary> {
    if (!anchorWorkspaceId) {
      return {
        processed: 0,
        reason: "no_pending_entries",
        scope: null,
        workspaceId: null,
        batchCount: 0,
        indexed: 0,
        skipped: 0,
        deleted: 0,
        disabled: 0,
        durationMs: 0,
      };
    }
    const embeddingClient = this.#createEmbeddingClient({ workspaceId: anchorWorkspaceId });
    if (!embeddingClient) {
      return {
        processed: 0,
        reason: "no_pending_entries",
        scope: null,
        workspaceId: null,
        batchCount: 0,
        indexed: 0,
        skipped: 0,
        deleted: 0,
        disabled: 0,
        durationMs: 0,
      };
    }
    const entries = listAllMemoryEntries(this.#store, {
      scope: "user",
      status: "active",
    }).filter((entry) => entry.memoryType === "preference" || entry.memoryType === "identity");
    const pending = pendingEmbeddingEntries({
      entries,
      indexes: this.#store.listMemoryEmbeddingIndexes({
        memoryIds: entries.map((entry) => entry.memoryId),
        embeddingModel: embeddingClient.modelId,
        limit: entries.length + 8,
        offset: 0,
      }),
      embeddingModelId: embeddingClient.modelId,
      workspaceId: null,
    }).slice(0, this.#batchSize);
    if (pending.length === 0) {
      return {
        processed: 0,
        reason: "no_pending_entries",
        scope: null,
        workspaceId: null,
        batchCount: 0,
        indexed: 0,
        skipped: 0,
        deleted: 0,
        disabled: 0,
        durationMs: 0,
      };
    }
    const result = await this.#syncEntries({
      store: this.#store,
      memoryService: this.#memoryService,
      workspaceId: anchorWorkspaceId,
      entries: pending,
      embeddingClient,
    });
    this.#logger?.info?.(
      {
        event: "runtime.recall_embedding_backfill.batch",
        scope: "user",
        workspace_id: anchorWorkspaceId,
        batch_count: pending.length,
        indexed: result.indexed,
        skipped: result.skipped,
        deleted: result.deleted,
        disabled: result.disabled,
      },
      "Recall embedding backfill processed shared user memories",
    );
    return {
      processed: pending.length,
      reason: "processed_user_batch",
      scope: "user",
      workspaceId: anchorWorkspaceId,
      batchCount: pending.length,
      indexed: result.indexed,
      skipped: result.skipped,
      deleted: result.deleted,
      disabled: result.disabled,
      durationMs: 0,
    };
  }

  async #processWorkspaceBatch(workspaceId: string): Promise<RecallEmbeddingBackfillCycleSummary> {
    const embeddingClient = this.#createEmbeddingClient({ workspaceId });
    if (!embeddingClient) {
      return {
        processed: 0,
        reason: "no_pending_entries",
        scope: null,
        workspaceId: null,
        batchCount: 0,
        indexed: 0,
        skipped: 0,
        deleted: 0,
        disabled: 0,
        durationMs: 0,
      };
    }
    const entries = listAllMemoryEntries(this.#store, {
      workspaceId,
      scope: "workspace",
      status: "active",
    });
    const pending = pendingEmbeddingEntries({
      entries,
      indexes: this.#store.listMemoryEmbeddingIndexes({
        memoryIds: entries.map((entry) => entry.memoryId),
        embeddingModel: embeddingClient.modelId,
        limit: entries.length + 8,
        offset: 0,
      }),
      embeddingModelId: embeddingClient.modelId,
      workspaceId,
    }).slice(0, this.#batchSize);
    if (pending.length === 0) {
      return {
        processed: 0,
        reason: "no_pending_entries",
        scope: null,
        workspaceId: null,
        batchCount: 0,
        indexed: 0,
        skipped: 0,
        deleted: 0,
        disabled: 0,
        durationMs: 0,
      };
    }
    const result = await this.#syncEntries({
      store: this.#store,
      memoryService: this.#memoryService,
      workspaceId,
      entries: pending,
      embeddingClient,
    });
    this.#logger?.info?.(
      {
        event: "runtime.recall_embedding_backfill.batch",
        scope: "workspace",
        workspace_id: workspaceId,
        batch_count: pending.length,
        indexed: result.indexed,
        skipped: result.skipped,
        deleted: result.deleted,
        disabled: result.disabled,
      },
      "Recall embedding backfill processed workspace memories",
    );
    return {
      processed: pending.length,
      reason: "processed_workspace_batch",
      scope: "workspace",
      workspaceId,
      batchCount: pending.length,
      indexed: result.indexed,
      skipped: result.skipped,
      deleted: result.deleted,
      disabled: result.disabled,
      durationMs: 0,
    };
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopped) {
      if (!this.#hasWaitedInitialDelay && this.#initialDelayMs > 0) {
        this.#hasWaitedInitialDelay = true;
        await Promise.race([
          sleep(this.#initialDelayMs),
          new Promise<void>((resolve) => {
            this.#wakeResolver = resolve;
          }),
        ]);
        this.#wakeResolver = null;
        if (this.#stopped) {
          return;
        }
      }
      const processed = await this.processAvailableBackfillOnce();
      if (processed > 0) {
        continue;
      }
      await Promise.race([
        sleep(this.#pollIntervalMs),
        new Promise<void>((resolve) => {
          this.#wakeResolver = resolve;
        }),
      ]);
      this.#wakeResolver = null;
    }
  }
}
