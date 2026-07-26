import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore, type MemoryEntryRecord } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import { FilesystemMemoryService } from "./memory.js";
import { RECALL_EMBEDDING_DIM } from "./memory-embedding-index.js";
import { RuntimeRecallEmbeddingBackfillWorker } from "./recall-embedding-backfill-worker.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(prefix: string) {
  const root = makeTempDir(prefix);
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const memoryService = new FilesystemMemoryService({ workspaceRoot: store.workspaceRoot });
  return { root, store, memoryService };
}

function upsertWorkspaceMemoryEntry(store: RuntimeStateStore, params: {
  memoryId: string;
  workspaceId: string;
  title: string;
  updatedAt?: string;
}): MemoryEntryRecord {
  return store.upsertMemoryEntry({
    memoryId: params.memoryId,
    workspaceId: params.workspaceId,
    sessionId: "session-main",
    scope: "workspace",
    memoryType: "fact",
    subjectKey: params.memoryId,
    path: `workspace/${params.workspaceId}/knowledge/facts/${params.memoryId}.md`,
    title: params.title,
    summary: `${params.title} summary`,
    tags: ["fact"],
    verificationPolicy: "none",
    stalenessPolicy: "workspace_sensitive",
    staleAfterSeconds: null,
    sourceTurnInputId: "input-1",
    sourceMessageId: "user-1",
    sourceType: "session_message",
    observedAt: params.updatedAt ?? "2026-04-11T00:00:00.000Z",
    lastVerifiedAt: params.updatedAt ?? "2026-04-11T00:00:00.000Z",
    confidence: 0.95,
    fingerprint: `${params.memoryId}`.padEnd(64, "f").slice(0, 64),
    updatedAt: params.updatedAt,
  });
}

function upsertUserMemoryEntry(store: RuntimeStateStore, params: {
  memoryId: string;
  memoryType: "preference" | "identity";
  title: string;
  updatedAt?: string;
}): MemoryEntryRecord {
  return store.upsertMemoryEntry({
    memoryId: params.memoryId,
    workspaceId: null,
    sessionId: "session-main",
    scope: "user",
    memoryType: params.memoryType,
    subjectKey: params.memoryId,
    path: `${params.memoryType}/${params.memoryId}.md`,
    title: params.title,
    summary: `${params.title} summary`,
    tags: [params.memoryType],
    verificationPolicy: "none",
    stalenessPolicy: "stable",
    staleAfterSeconds: null,
    sourceTurnInputId: "input-1",
    sourceMessageId: "user-1",
    sourceType: "session_message",
    observedAt: params.updatedAt ?? "2026-04-11T00:00:00.000Z",
    lastVerifiedAt: params.updatedAt ?? "2026-04-11T00:00:00.000Z",
    confidence: 0.99,
    fingerprint: `${params.memoryId}`.padEnd(64, "u").slice(0, 64),
    updatedAt: params.updatedAt,
  });
}

test("recall embedding backfill prioritizes shared user memories before workspace batches", async () => {
  const { store, memoryService } = makeStore("hb-recall-embedding-backfill-");
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const userEntry = upsertUserMemoryEntry(store, {
    memoryId: "user-preference:response-style",
    memoryType: "preference",
    title: "User response style",
  });
  // Single-tenant: workspace memories live under the canonical root workspace,
  // which is the only id the backfill worker enumerates via listWorkspaces().
  const workspaceEntry = upsertWorkspaceMemoryEntry(store, {
    memoryId: "workspace-fact:workspace-1:deploy-command",
    workspaceId: "root",
    title: "Deploy command",
  });

  const seen: Array<{ workspaceId: string; memoryIds: string[] }> = [];
  const worker = new RuntimeRecallEmbeddingBackfillWorker({
    store,
    memoryService,
    batchSize: 1,
    initialDelayMs: 0,
    pollIntervalMs: 60_000,
    createEmbeddingClient: () => ({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    }),
    syncEntries: async (params) => {
      seen.push({
        workspaceId: params.workspaceId,
        memoryIds: params.entries.map((entry) => entry.memoryId),
      });
      for (const entry of params.entries) {
        store.upsertMemoryEmbeddingIndex({
          memoryId: entry.memoryId,
          path: entry.path,
          workspaceId: entry.workspaceId,
          scopeBucket:
            entry.scope === "workspace"
              ? "workspace"
              : entry.memoryType === "identity"
                ? "identity"
                : "preference",
          memoryType: entry.memoryType,
          contentFingerprint: `${entry.memoryId}-fp`,
          embeddingModel: params.embeddingClient?.modelId ?? "text-embedding-3-small",
          embeddingDim: RECALL_EMBEDDING_DIM,
        });
      }
      return { indexed: params.entries.length, skipped: 0, deleted: 0, disabled: 0 };
    },
  });

  const firstProcessed = await worker.processAvailableBackfillOnce();
  const secondProcessed = await worker.processAvailableBackfillOnce();

  assert.equal(firstProcessed, 1);
  assert.equal(secondProcessed, 1);
  // Both batches are attributed to the canonical root: the user batch uses the
  // anchor workspace (root) and the workspace batch iterates the single root.
  assert.deepEqual(seen, [
    { workspaceId: "root", memoryIds: [userEntry.memoryId] },
    { workspaceId: "root", memoryIds: [workspaceEntry.memoryId] },
  ]);

  store.close();
});

test("recall embedding backfill skips processing while any workspace has a queued or active input", async () => {
  const { store, memoryService } = makeStore("hb-recall-embedding-backfill-busy-");
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  upsertWorkspaceMemoryEntry(store, {
    memoryId: "workspace-fact:workspace-1:deploy-command",
    workspaceId: "workspace-1",
    title: "Deploy command",
  });
  store.ensureRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "QUEUED",
    currentInputId: "input-queued",
  });

  const worker = new RuntimeRecallEmbeddingBackfillWorker({
    store,
    memoryService,
    batchSize: 1,
    initialDelayMs: 0,
    pollIntervalMs: 60_000,
    createEmbeddingClient: () => ({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    }),
    syncEntries: async () => {
      assert.fail("embedding sync should not run while a workspace has a queued or active input");
    },
  });

  const processed = await worker.processAvailableBackfillOnce();
  assert.equal(processed, 0);

  store.close();
});

// Single-tenant: the runtime hosts one synthetic root workspace, so the former
// "prioritize the most recently active among many workspaces" behavior has
// collapsed — every workspace memory resolves under the single root, which is
// the only id the worker enumerates via listWorkspaces(). This asserts that the
// canonical root's workspace memories are processed and attributed to "root"
// (the multi-tenant prioritization ordering it previously covered is obsolete).
test("recall embedding backfill processes the canonical root workspace's memories", async () => {
  const { store, memoryService } = makeStore("hb-recall-embedding-backfill-priority-");
  upsertWorkspaceMemoryEntry(store, {
    memoryId: "workspace-fact:deploy-command-a",
    workspaceId: "root",
    title: "Deploy command A",
  });
  upsertWorkspaceMemoryEntry(store, {
    memoryId: "workspace-fact:deploy-command-b",
    workspaceId: "root",
    title: "Deploy command B",
  });

  const seen: string[] = [];
  const worker = new RuntimeRecallEmbeddingBackfillWorker({
    store,
    memoryService,
    batchSize: 1,
    initialDelayMs: 0,
    pollIntervalMs: 60_000,
    createEmbeddingClient: ({ workspaceId }) => ({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      modelId: `text-embedding-3-small:${workspaceId}`,
      apiStyle: "openai_compatible",
    }),
    syncEntries: async (params) => {
      seen.push(params.workspaceId);
      for (const entry of params.entries) {
        store.upsertMemoryEmbeddingIndex({
          memoryId: entry.memoryId,
          path: entry.path,
          workspaceId: entry.workspaceId,
          scopeBucket: "workspace",
          memoryType: entry.memoryType,
          contentFingerprint: `${entry.memoryId}-fp`,
          embeddingModel: params.embeddingClient?.modelId ?? "text-embedding-3-small",
          embeddingDim: RECALL_EMBEDDING_DIM,
        });
      }
      return { indexed: params.entries.length, skipped: 0, deleted: 0, disabled: 0 };
    },
  });

  const processed = await worker.processAvailableBackfillOnce();

  assert.equal(processed, 1);
  assert.deepEqual(seen, ["root"]);

  store.close();
});

test("recall embedding backfill logs cycle summaries for skipped and processed runs", async () => {
  const { store, memoryService } = makeStore("hb-recall-embedding-backfill-telemetry-");
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  // Single-tenant: workspace memories live under the canonical root workspace.
  upsertWorkspaceMemoryEntry(store, {
    memoryId: "workspace-fact:workspace-1:deploy-command",
    workspaceId: "root",
    title: "Deploy command",
  });

  const skippedLogs: Array<{ payload: Record<string, unknown>; message: string }> = [];
  const skippedWorker = new RuntimeRecallEmbeddingBackfillWorker({
    store,
    memoryService,
    batchSize: 1,
    initialDelayMs: 0,
    pollIntervalMs: 60_000,
    logger: {
      info(payload, message) {
        skippedLogs.push({ payload: payload as Record<string, unknown>, message: String(message) });
      },
      error() {},
    },
    createEmbeddingClient: () => ({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    }),
    syncEntries: async () => {
      assert.fail("embedding sync should not run while a workspace has a queued or active input");
    },
  });

  store.ensureRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "QUEUED",
    currentInputId: "input-queued",
  });
  const skippedProcessed = await skippedWorker.processAvailableBackfillOnce();
  assert.equal(skippedProcessed, 0);
  assert.deepEqual(skippedLogs, [
    {
      payload: {
        event: "runtime.recall_embedding_backfill.cycle",
        processed: 0,
        reason: "active_session_run",
        scope: null,
        workspace_id: null,
        batch_count: 0,
        indexed: 0,
        skipped: 0,
        deleted: 0,
        disabled: 0,
        duration_ms: skippedLogs[0]?.payload.duration_ms,
      },
      message: "Recall embedding backfill cycle",
    },
  ]);
  assert.equal(typeof skippedLogs[0]?.payload.duration_ms, "number");

  store.updateRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "IDLE",
    currentInputId: null,
  });

  const processedLogs: Array<{ payload: Record<string, unknown>; message: string }> = [];
  const processedWorker = new RuntimeRecallEmbeddingBackfillWorker({
    store,
    memoryService,
    batchSize: 1,
    initialDelayMs: 0,
    pollIntervalMs: 60_000,
    logger: {
      info(payload, message) {
        processedLogs.push({ payload: payload as Record<string, unknown>, message: String(message) });
      },
      error() {},
    },
    createEmbeddingClient: () => ({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    }),
    syncEntries: async (params) => {
      for (const entry of params.entries) {
        store.upsertMemoryEmbeddingIndex({
          memoryId: entry.memoryId,
          path: entry.path,
          workspaceId: entry.workspaceId,
          scopeBucket: "workspace",
          memoryType: entry.memoryType,
          contentFingerprint: `${entry.memoryId}-fp`,
          embeddingModel: params.embeddingClient?.modelId ?? "text-embedding-3-small",
          embeddingDim: RECALL_EMBEDDING_DIM,
        });
      }
      return { indexed: 1, skipped: 0, deleted: 0, disabled: 0 };
    },
  });

  const processedCount = await processedWorker.processAvailableBackfillOnce();
  assert.equal(processedCount, 1);
  assert.equal(processedLogs.length, 2);
  assert.deepEqual(processedLogs[0], {
    payload: {
      event: "runtime.recall_embedding_backfill.batch",
      scope: "workspace",
      workspace_id: "root",
      batch_count: 1,
      indexed: 1,
      skipped: 0,
      deleted: 0,
      disabled: 0,
    },
    message: "Recall embedding backfill processed workspace memories",
  });
  assert.deepEqual(processedLogs[1], {
    payload: {
      event: "runtime.recall_embedding_backfill.cycle",
      processed: 1,
      reason: "processed_workspace_batch",
      scope: "workspace",
      workspace_id: "root",
      batch_count: 1,
      indexed: 1,
      skipped: 0,
      deleted: 0,
      disabled: 0,
      duration_ms: processedLogs[1]?.payload.duration_ms,
    },
    message: "Recall embedding backfill cycle",
  });
  assert.equal(typeof processedLogs[1]?.payload.duration_ms, "number");

  store.close();
});
