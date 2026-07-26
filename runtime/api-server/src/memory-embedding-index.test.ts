import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore, type MemoryEntryRecord } from "@holaboss/runtime-state-store";

import { syncDurableMemoryEmbedding } from "./memory-embedding-index.js";
import { FilesystemMemoryService } from "./memory.js";

const ORIGINAL_FETCH = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeMemoryEntry(
  overrides: Partial<MemoryEntryRecord> &
    Pick<MemoryEntryRecord, "memoryId" | "scope" | "memoryType" | "path" | "title" | "summary">
): MemoryEntryRecord {
  return {
    memoryId: overrides.memoryId,
    workspaceId: overrides.workspaceId === undefined ? "workspace-1" : overrides.workspaceId,
    sessionId: overrides.sessionId ?? "session-1",
    scope: overrides.scope,
    memoryType: overrides.memoryType,
    subjectKey: overrides.subjectKey ?? overrides.memoryId,
    path: overrides.path,
    title: overrides.title,
    summary: overrides.summary,
    tags: overrides.tags ?? [],
    verificationPolicy: overrides.verificationPolicy ?? "check_before_use",
    stalenessPolicy: overrides.stalenessPolicy ?? "workspace_sensitive",
    staleAfterSeconds: overrides.staleAfterSeconds ?? 14 * 24 * 60 * 60,
    sourceTurnInputId: overrides.sourceTurnInputId ?? null,
    sourceMessageId: overrides.sourceMessageId ?? null,
    sourceType: overrides.sourceType ?? "turn_result",
    observedAt: overrides.observedAt ?? overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
    lastVerifiedAt: overrides.lastVerifiedAt ?? overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
    confidence: overrides.confidence ?? 0.9,
    fingerprint: overrides.fingerprint ?? "f".repeat(64),
    status: overrides.status ?? "active",
    supersededAt: overrides.supersededAt ?? null,
    createdAt: overrides.createdAt ?? "2026-04-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-01T00:00:00.000Z",
  };
}

test("syncDurableMemoryEmbedding indexes markdown leaves and skips unchanged content", async () => {
  const root = makeTempDir("hb-memory-embedding-");
  const workspaceRoot = path.join(root, "workspace");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot,
  });
  assert.equal(store.supportsVectorIndex(), true);

  const memoryService = new FilesystemMemoryService({ workspaceRoot });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/knowledge/facts/vendor.md",
    content: [
      "# Vendor escalation contact",
      "",
      "Primary vendor escalation contact is Alicia Park.",
    ].join("\n"),
  });

  const entry = makeMemoryEntry({
    memoryId: "workspace-fact:workspace-1:vendor-contact",
    scope: "workspace",
    memoryType: "fact",
    path: "workspace/workspace-1/knowledge/facts/vendor.md",
    title: "Vendor escalation contact",
    summary: "Primary vendor escalation contact is Alicia Park.",
    tags: ["vendor", "escalation"],
  });
  store.upsertMemoryEntry(entry);

  const embedding = new Array<number>(1536).fill(0);
  embedding[0] = 1;
  let embeddingCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    embeddingCalls += 1;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    assert.equal(body?.model, "text-embedding-3-small");
    return new Response(
      JSON.stringify({
        data: [{ embedding }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }) as typeof fetch;

  const first = await syncDurableMemoryEmbedding({
    store,
    memoryService,
    workspaceId: "workspace-1",
    entry,
    embeddingClient: {
      baseUrl: "http://127.0.0.1:4999/openai/v1",
      apiKey: "test-token",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    },
  });

  const indexed = store.getMemoryEmbeddingIndexByMemoryId({
    memoryId: entry.memoryId,
    workspaceId: entry.workspaceId,
  });
  assert.equal(first, "indexed");
  assert.ok(indexed);
  assert.equal(indexed?.path, entry.path);
  assert.equal(embeddingCalls, 1);
  assert.equal(
    store.searchWorkspaceMemoryRecallVectors({
      workspaceId: "workspace-1",
      embedding: new Float32Array(embedding),
      limit: 5,
    })[0]?.path,
    entry.path,
  );

  const second = await syncDurableMemoryEmbedding({
    store,
    memoryService,
    workspaceId: "workspace-1",
    entry,
    embeddingClient: {
      baseUrl: "http://127.0.0.1:4999/openai/v1",
      apiKey: "test-token",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    },
  });

  assert.equal(second, "skipped_unchanged");
  assert.equal(embeddingCalls, 1);

  store.close();
});
