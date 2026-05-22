import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore, type TurnResultRecord } from "@holaboss/runtime-state-store";

import { FilesystemMemoryService } from "./memory.js";
import {
  globalMemoryDirForWorkspaceRoot,
  workspaceMemoryDir,
} from "./workspace-bundle-paths.js";
import {
  refreshMemoryIndexes,
  writeTurnDurableMemory,
  type TurnMemoryWritebackModelContext,
} from "./turn-memory-writeback.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeRuntimeState(prefix: string): {
  root: string;
  workspaceRoot: string;
  store: RuntimeStateStore;
  memoryService: FilesystemMemoryService;
} {
  const root = makeTempDir(prefix);
  const workspaceRoot = path.join(root, "workspaces");
  return {
    root,
    workspaceRoot,
    store: new RuntimeStateStore({
      dbPath: path.join(root, "runtime.db"),
      workspaceRoot,
    }),
    memoryService: new FilesystemMemoryService({ workspaceRoot }),
  };
}

function listMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const stat = fs.statSync(root);
  if (stat.isFile() && path.extname(root).toLowerCase() === ".md") {
    return [root];
  }
  if (!stat.isDirectory()) {
    return [];
  }
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function snapshotMemoryFiles(workspaceRoot: string, workspaceId: string): Record<string, string> {
  const workspaceDir = path.join(workspaceRoot, workspaceId);
  const workspaceRootDir = workspaceMemoryDir(workspaceDir);
  const globalRootDir = globalMemoryDirForWorkspaceRoot(workspaceRoot);
  const files: Record<string, string> = {};

  for (const filePath of listMarkdownFiles(workspaceRootDir)) {
    const relativePath = path.relative(workspaceRootDir, filePath).split(path.sep).join("/");
    files[`workspace/${workspaceId}/${relativePath}`] = fs.readFileSync(filePath, "utf8");
  }

  const rootIndexPath = path.join(globalRootDir, "MEMORY.md");
  if (fs.existsSync(rootIndexPath) && fs.statSync(rootIndexPath).isFile()) {
    files["MEMORY.md"] = fs.readFileSync(rootIndexPath, "utf8");
  }
  if (fs.existsSync(globalRootDir) && fs.statSync(globalRootDir).isDirectory()) {
    for (const entry of fs.readdirSync(globalRootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === "workspace") {
        continue;
      }
      for (const filePath of listMarkdownFiles(path.join(globalRootDir, entry.name))) {
        const relativePath = path.relative(globalRootDir, filePath).split(path.sep).join("/");
        files[relativePath] = fs.readFileSync(filePath, "utf8");
      }
    }
  }

  return files;
}

function listActiveInteractionLeaves(store: RuntimeStateStore, workspaceId: string) {
  return store.listInteractionLeaves({
    workspaceId,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
}

function listActiveInteractionSummaries(store: RuntimeStateStore, workspaceId: string, entityId?: string) {
  return store.listInteractionSummaryNodes({
    workspaceId,
    entityId: entityId ?? null,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
}

function listActiveInteractionEntities(store: RuntimeStateStore, workspaceId: string) {
  return store.listInteractionEntities({
    workspaceId,
    status: "active",
    includeSystem: true,
    limit: 10_000,
    offset: 0,
  });
}

async function withModelExtractionResponse(params: {
  memories: Array<Record<string, unknown>>;
  onRequest?: (body: string) => void;
  run: (modelContext: TurnMemoryWritebackModelContext) => Promise<void>;
}): Promise<void> {
  await withModelExtractionResponses({
    responses: [
      {
        statusCode: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: params.memories,
                }),
              },
            },
          ],
        },
      },
    ],
    onRequest: params.onRequest,
    run: params.run,
  });
}

async function withModelExtractionResponses(params: {
  responses: Array<{
    statusCode: number;
    body?: Record<string, unknown>;
    delayMs?: number;
  }>;
  onRequest?: (body: string, index: number) => void;
  run: (modelContext: TurnMemoryWritebackModelContext) => Promise<void>;
}): Promise<void> {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/openai/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const requestIndex = requestCount;
      requestCount += 1;
      params.onRequest?.(Buffer.concat(chunks).toString("utf8"), requestIndex);
      const configuredResponse = params.responses[Math.min(requestIndex, params.responses.length - 1)] ?? {
        statusCode: 500,
      };
      setTimeout(() => {
        response.statusCode = configuredResponse.statusCode;
        if (configuredResponse.body) {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(configuredResponse.body));
          return;
        }
        response.end();
      }, Math.max(0, configuredResponse.delayMs ?? 0));
    });
  });
  let requestCount = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const modelContext: TurnMemoryWritebackModelContext = {
      modelClient: {
        baseUrl: `http://127.0.0.1:${address.port}/openai/v1`,
        apiKey: "test-key",
        modelId: "openai/gpt-4.1-mini",
      },
      instruction: "extract durable memory candidates",
    };
    await params.run(modelContext);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

function seedWorkspace(store: RuntimeStateStore): void {
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
}

function seedCompletedTurns(params: {
  store: RuntimeStateStore;
  sessionId?: string;
  turns: Array<{
    inputId?: string;
    userText: string;
    assistantText: string;
    toolUsageSummary?: Record<string, unknown> | null;
  }>;
}): TurnResultRecord[] {
  const sessionId = params.sessionId ?? "session-main";
  return params.turns.map((turn, index) => {
    const minuteToken = String(index).padStart(2, "0");
    const inputId = turn.inputId ?? `input-${index + 1}`;
    const createdAt = `2026-04-02T12:${minuteToken}:00.000Z`;
    const completedAt = `2026-04-02T12:${minuteToken}:05.000Z`;
    params.store.insertSessionMessage({
      workspaceId: "workspace-1",
      sessionId,
      role: "user",
      text: turn.userText,
      messageId: `user-${index + 1}`,
      createdAt,
    });
    return params.store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId,
      inputId,
      startedAt: createdAt,
      completedAt,
      status: "completed",
      stopReason: "ok",
      assistantText: turn.assistantText,
      toolUsageSummary: turn.toolUsageSummary ?? undefined,
    });
  });
}

function interactionBatchCursor(store: RuntimeStateStore, sessionId = "session-main"): string | null {
  return store.getWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: `interaction_memory_batch_processed_count:${sessionId}`,
  });
}

function latestInteractionBatchState(store: RuntimeStateStore, sessionId = "session-main"): Record<string, unknown> | null {
  const raw = store.getWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: `interaction_memory_batch_latest:${sessionId}`,
  });
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

test("writeTurnDurableMemory does not mutate turn result summaries or write runtime continuity files", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-");
  seedWorkspace(store);
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "Please keep your responses concise.",
    messageId: "user-1",
    createdAt: "2026-04-02T12:00:00.000Z",
  });

  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    startedAt: "2026-04-02T12:00:00.000Z",
    completedAt: "2026-04-02T12:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Implemented the runtime memory writeback path.\nVerified the affected tests.",
    toolUsageSummary: {
      total_calls: 2,
      completed_calls: 1,
      failed_calls: 1,
      tool_names: ["read", "deploy"],
      tool_ids: ["workspace.deploy"],
    },
    permissionDenials: [
      {
        tool_name: "deploy",
        tool_id: "workspace.deploy",
        reason: "permission denied by policy",
      },
    ],
    promptSectionIds: ["runtime_core", "execution_policy"],
    capabilityManifestFingerprint: "f".repeat(64),
    tokenUsage: { input_tokens: 12, output_tokens: 34 },
  });

  const updated = await writeTurnDurableMemory({
    store,
    memoryService,
    turnResult,
  });
  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  const memoryEntryIds = store.listMemoryEntries({ status: "active" }).map((entry) => entry.memoryId).sort((left, right) =>
    left.localeCompare(right)
  );

  assert.equal(updated.inputId, turnResult.inputId);
  assert.deepEqual(Object.keys(files).sort((left, right) => left.localeCompare(right)), []);
  assert.deepEqual(memoryEntryIds, []);

  store.close();
});

test("writeTurnDurableMemory waits for a full three-turn batch and does not replay a processed batch", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-dedupe-");
  seedWorkspace(store);
  const [firstTurn, secondTurn, thirdTurn] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Checking deploy permissions for the workspace.",
        assistantText: "I reviewed the current deploy permissions.",
      },
      {
        userText: "Deploy access still seems blocked by policy.",
        assistantText: "Deploy access still appears blocked by policy.",
      },
      {
        userText: "Remember that deploy access is currently blocked by policy.",
        assistantText: "Deploy access remains blocked by policy.",
      },
    ],
  });

  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "blocker",
        subject_key: "deploy-policy-blocker",
        title: "Recurring deploy policy blocker",
        summary: "Deploy access is blocked by workspace policy until permissions are expanded.",
        tags: ["deploy", "policy", "blocker"],
        evidence: "The current turn explicitly states that deploy access is blocked by workspace policy until permissions change.",
        confidence: 0.95,
      },
    ],
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult: firstTurn,
        modelContext,
      });
      assert.equal(listActiveInteractionLeaves(store, "workspace-1").length, 0);

      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult: secondTurn,
        modelContext,
      });
      assert.equal(listActiveInteractionLeaves(store, "workspace-1").length, 0);

      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult: thirdTurn,
        modelContext,
      });
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult: thirdTurn,
        modelContext,
      });
    },
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  const filePaths = Object.keys(files).sort((left, right) => left.localeCompare(right));
  const interactionLeaves = listActiveInteractionLeaves(store, "workspace-1");
  const interactionSummaries = listActiveInteractionSummaries(store, "workspace-1");
  const interactionEntities = listActiveInteractionEntities(store, "workspace-1");
  const blockerLeaf = interactionLeaves[0];

  assert.deepEqual(filePaths, [blockerLeaf.path]);
  assert.equal(interactionLeaves.length, 1);
  assert.equal(blockerLeaf.entityId, "interaction:system:recurring-deploy-policy-blocker");
  assert.match(
    blockerLeaf.path,
    /workspace\/workspace-1\/interaction\/entities\/system-recurring-deploy-policy-blocker\/leaves\/leaf-[a-f0-9]{24}\.md$/,
  );
  assert.equal(interactionSummaries.length, 0);
  assert.equal(
    interactionEntities.some((entity) => entity.entityId === "interaction:system:recurring-deploy-policy-blocker"),
    true,
  );
  assert.equal(blockerLeaf.sourceType, "assistant_turn");
  assert.equal(blockerLeaf.admissionConfidence, 0.95);
  assert.match(files[blockerLeaf.path], /Recurring deploy policy blocker/);
  assert.match(files[blockerLeaf.path], /blocked by workspace policy/i);
  assert.equal(interactionBatchCursor(store), "3");

  store.close();
});

test("writeTurnDurableMemory does not advance the batch cursor when extraction fails", async () => {
  const { store, memoryService } = makeRuntimeState("hb-turn-memory-extraction-fail-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Remember that vendor escalation contact is Alicia Park.",
        assistantText: "I will remember the vendor escalation contact.",
      },
      {
        userText: "This is specifically for future escalation handling.",
        assistantText: "Understood.",
      },
      {
        userText: "Keep this durable for future recall.",
        assistantText: "Captured the escalation contact.",
      },
    ],
  });

  await withModelExtractionResponses({
    responses: [{ statusCode: 500 }],
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });

  assert.equal(interactionBatchCursor(store), null);
  assert.deepEqual(listActiveInteractionLeaves(store, "workspace-1"), []);
  const batchState = latestInteractionBatchState(store);
  assert.ok(batchState);
  assert.equal(batchState?.status, "failed");
  assert.equal(batchState?.failureReason, "model_request_failed");
  assert.equal(batchState?.attemptCount, 1);
  assert.equal(batchState?.extractionAttemptCount, 3);

  store.close();
});

test("writeTurnDurableMemory retries extraction with smaller sub-batches when the full batch request fails", async () => {
  const { store, memoryService } = makeRuntimeState("hb-turn-memory-extraction-fallback-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Remember for Pine Harbor that the billing escalation contact is Nina Patel.",
        assistantText: "I will remember the Pine Harbor billing contact.",
      },
      {
        userText: "Also remember for Pine Harbor that the contract renewal owner is Mateo Cruz.",
        assistantText: "I will remember the Pine Harbor contract renewal owner.",
      },
      {
        userText: "Remember that Pine Harbor uses the finance-ledger dispute workflow.",
        assistantText: "I will remember the Pine Harbor dispute workflow.",
      },
    ],
  });

  let requestCount = 0;
  await withModelExtractionResponses({
    responses: [
      { statusCode: 500 },
      {
        statusCode: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      scope: "workspace",
                      memory_type: "fact",
                      subject_key: "pine_harbor",
                      title: "Pine Harbor billing escalation contact",
                      summary: "For Pine Harbor, the billing escalation contact is Nina Patel.",
                      tags: ["customer", "contact"],
                      evidence: "User stated that the Pine Harbor billing escalation contact is Nina Patel.",
                      confidence: 0.99,
                    },
                    {
                      scope: "workspace",
                      memory_type: "fact",
                      subject_key: "pine_harbor",
                      title: "Pine Harbor contract renewal owner",
                      summary: "For Pine Harbor, the contract renewal owner is Mateo Cruz.",
                      tags: ["customer", "owner"],
                      evidence: "User stated that Pine Harbor contract renewal owner is Mateo Cruz.",
                      confidence: 0.99,
                    },
                  ],
                }),
              },
            },
          ],
        },
      },
      {
        statusCode: 200,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      scope: "workspace",
                      memory_type: "reference",
                      subject_key: "pine_harbor",
                      title: "Pine Harbor dispute workflow reference",
                      summary: "Pine Harbor uses the finance-ledger dispute workflow.",
                      tags: ["customer", "workflow"],
                      evidence: "User stated that Pine Harbor uses the finance-ledger dispute workflow.",
                      confidence: 0.95,
                    },
                  ],
                }),
              },
            },
          ],
        },
      },
    ],
    onRequest: () => {
      requestCount += 1;
    },
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });

  assert.equal(requestCount, 4);
  assert.equal(interactionBatchCursor(store), "3");
  const batchState = latestInteractionBatchState(store);
  assert.ok(batchState);
  assert.equal(batchState?.status, "completed");
  assert.equal(batchState?.usedSubBatchFallback, true);
  assert.equal(batchState?.extractionAttemptCount, 3);
  const leaves = listActiveInteractionLeaves(store, "workspace-1").filter(
    (leaf) => leaf.entityId === "interaction:customer:pine-harbor",
  );
  assert.equal(leaves.length, 3);

  store.close();
});

test("writeTurnDurableMemory prevents overlapping extraction for the same session while a batch is in flight", async () => {
  const { store, memoryService } = makeRuntimeState("hb-turn-memory-batch-lease-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Remember for Pine Harbor that the billing escalation contact is Nina Patel.",
        assistantText: "I will remember the Pine Harbor billing contact.",
      },
      {
        userText: "Also remember for Pine Harbor that the contract renewal owner is Mateo Cruz.",
        assistantText: "I will remember the Pine Harbor contract renewal owner.",
      },
      {
        userText: "Remember that Pine Harbor uses the finance-ledger dispute workflow.",
        assistantText: "I will remember the Pine Harbor dispute workflow.",
      },
    ],
  });

  let requestCount = 0;
  await withModelExtractionResponses({
    responses: [
      {
        statusCode: 200,
        delayMs: 150,
        body: {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  memories: [
                    {
                      scope: "workspace",
                      memory_type: "fact",
                      subject_key: "pine_harbor",
                      title: "Pine Harbor billing escalation contact",
                      summary: "For Pine Harbor, the billing escalation contact is Nina Patel.",
                      tags: ["customer", "contact"],
                      evidence: "User stated that the Pine Harbor billing escalation contact is Nina Patel.",
                      confidence: 0.99,
                    },
                  ],
                }),
              },
            },
          ],
        },
      },
    ],
    onRequest: () => {
      requestCount += 1;
    },
    run: async (modelContext) => {
      const firstWrite = writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const secondWrite = await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
      assert.equal(secondWrite.inputId, turnResult.inputId);
      assert.equal(interactionBatchCursor(store), null);
      assert.equal(requestCount, 1);
      await firstWrite;
    },
  });

  assert.equal(requestCount, 1);
  assert.equal(interactionBatchCursor(store), "3");
  assert.equal(listActiveInteractionLeaves(store, "workspace-1").length, 1);

  store.close();
});

test("writeTurnDurableMemory skips recall-only batches instead of re-learning recalled answers", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-recall-only-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Who is the Pine Harbor billing escalation contact?",
        assistantText: "The Pine Harbor billing escalation contact is Nina Patel.",
        toolUsageSummary: {
          tool_names: ["memory_retrieve"],
        },
      },
      {
        userText: "What is the Pine Harbor billing dispute escalation procedure?",
        assistantText: "Open the ledger case, confirm the Stripe dispute event, then escalate to the finance lead.",
        toolUsageSummary: {
          tool_names: ["memory_retrieve"],
        },
      },
      {
        userText: "Who owns Pine Harbor contract renewal?",
        assistantText: "Mateo Cruz owns Pine Harbor contract renewal.",
        toolUsageSummary: {
          tool_names: ["memory_retrieve"],
        },
      },
    ],
  });

  let requestCount = 0;
  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "pine_harbor:billing-escalation-contact",
        title: "Pine Harbor billing escalation contact",
        summary: "The Pine Harbor billing escalation contact is Nina Patel.",
        tags: ["customer", "contact"],
        evidence: "Assistant answered that Nina Patel is the Pine Harbor billing escalation contact.",
        confidence: 0.99,
      },
    ],
    onRequest: () => {
      requestCount += 1;
    },
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  assert.equal(requestCount, 0);
  assert.deepEqual(listActiveInteractionLeaves(store, "workspace-1"), []);
  assert.deepEqual(listActiveInteractionSummaries(store, "workspace-1"), []);
  assert.deepEqual(Object.keys(files), []);
  assert.equal(interactionBatchCursor(store), "3");

  store.close();
});

test("writeTurnDurableMemory excludes recall-heavy turns from mixed extraction batches", async () => {
  const { store, memoryService } = makeRuntimeState("hb-turn-memory-recall-mixed-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Remember this for Pine Harbor: the billing escalation contact is Nina Patel.",
        assistantText: "I will remember the Pine Harbor billing contact.",
      },
      {
        userText: "Also remember for Pine Harbor that the contract renewal owner is Mateo Cruz.",
        assistantText: "I will remember the Pine Harbor contract renewal owner.",
      },
      {
        userText: "Who is the Pine Harbor billing escalation contact?",
        assistantText: "The Pine Harbor billing escalation contact is Nina Patel.",
        toolUsageSummary: {
          tool_names: ["memory_retrieve"],
        },
      },
    ],
  });

  const capturedRequests: string[] = [];
  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "pine_harbor",
        title: "Pine Harbor billing escalation contact",
        summary: "For Pine Harbor, the billing escalation contact is Nina Patel.",
        tags: ["customer", "contact"],
        evidence: "User stated that the Pine Harbor billing escalation contact is Nina Patel.",
        confidence: 0.99,
      },
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "pine_harbor",
        title: "Pine Harbor contract renewal owner",
        summary: "For Pine Harbor, the contract renewal owner is Mateo Cruz.",
        tags: ["customer", "owner"],
        evidence: "User stated that the Pine Harbor contract renewal owner is Mateo Cruz.",
        confidence: 0.99,
      },
    ],
    onRequest: (body) => {
      capturedRequests.push(body);
    },
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });

  assert.equal(capturedRequests.length, 2);
  assert.match(capturedRequests[0], /Excluded recall-heavy turns: 1/);
  assert.doesNotMatch(capturedRequests[0], /Who is the Pine Harbor billing escalation contact\?/);
  assert.doesNotMatch(capturedRequests[0], /The Pine Harbor billing escalation contact is Nina Patel\./);

  const leaves = listActiveInteractionLeaves(store, "workspace-1").filter(
    (leaf) => leaf.entityId === "interaction:customer:pine-harbor",
  );
  assert.equal(leaves.length, 2);
  assert.deepEqual(
    leaves.map((leaf) => leaf.title).sort((left, right) => left.localeCompare(right)),
    ["Pine Harbor billing escalation contact", "Pine Harbor contract renewal owner"],
  );
  assert.equal(interactionBatchCursor(store), "3");

  store.close();
});

test("writeTurnDurableMemory persists model-extracted workspace facts and procedures", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-facts-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Please keep your responses concise.",
        assistantText: "I will keep responses concise.",
      },
      {
        userText: "For verification, use `npm run test`.",
        assistantText: "I will use `npm run test` for verification.",
      },
      {
        userText: [
          "Release procedure:",
          "1. Run `npm run test`.",
          "2. Run `npm run build`.",
          "3. Publish the bundle.",
        ].join("\n"),
        assistantText: "Captured workspace-specific instructions for future runs.",
      },
    ],
  });

  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "verification-command",
        title: "Verification command",
        summary: "Use `npm run test` to verify this workspace before shipping changes.",
        tags: ["verification", "command"],
        evidence: "The current turn explicitly instructs the agent to use `npm run test` as the verification command for this workspace.",
        confidence: 0.94,
      },
      {
        scope: "workspace",
        memory_type: "procedure",
        subject_key: "release-procedure",
        title: "Release procedure",
        summary: "Release by running tests, building the bundle, and then publishing it.",
        tags: ["release", "procedure"],
        evidence: "The current turn explicitly lists a three-step release procedure with test, build, and publish steps for future reuse.",
        confidence: 0.93,
      },
    ],
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  const interactionLeaves = listActiveInteractionLeaves(store, "workspace-1");
  const verificationFact = interactionLeaves.find((leaf) => leaf.title === "Verification command");
  const releaseProcedure = interactionLeaves.find((leaf) => leaf.title === "Release procedure");
  const releaseEntity = releaseProcedure
    ? store.getInteractionEntity({ workspaceId: "workspace-1", entityId: releaseProcedure.entityId })
    : null;

  assert.equal(interactionLeaves.length, 2);
  assert.ok(verificationFact);
  assert.ok(releaseProcedure);
  assert.equal(verificationFact?.entityId, "interaction:uncategorized");
  assert.equal(releaseEntity?.entityType, "workflow");
  assert.equal(releaseEntity?.canonicalName, "Release procedure");
  assert.match(files[verificationFact!.path], /^# Verification command/m);
  assert.match(files[verificationFact!.path], /`npm run test`/);
  assert.match(files[releaseProcedure!.path], /^# Release procedure/m);
  assert.match(files[releaseProcedure!.path], /running tests, building the bundle, and then publishing it/i);
  assert.equal(listActiveInteractionSummaries(store, "workspace-1").length, 0);
  assert.equal(verificationFact?.sourceType, "assistant_turn");
  assert.equal(verificationFact?.admissionConfidence, 0.94);
  assert.equal(releaseProcedure?.sourceType, "assistant_turn");
  assert.equal(releaseProcedure?.admissionConfidence, 0.93);
  assert.equal(interactionBatchCursor(store), "3");

  store.close();
});

test("writeTurnDurableMemory persists model-extracted business facts and procedures", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-business-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Weekly sales review is every Monday at 9am.",
        assistantText: "I noted the weekly sales review cadence.",
      },
      {
        userText: "Invoices over $5000 require finance approval.",
        assistantText: "I noted the finance approval rule.",
      },
      {
        userText: [
          "Customer follow-up process:",
          "1. Review the CRM record.",
          "2. Draft the follow-up email.",
          "3. Send it within 24 hours.",
        ].join("\n"),
        assistantText: "Captured business workflow rules for later recall.",
      },
    ],
  });

  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "weekly-sales-review",
        title: "Sales review cadence",
        summary: "Weekly sales review happens every Monday at 9am.",
        tags: ["sales", "cadence"],
        evidence: "The current turn explicitly states that the weekly sales review happens every Monday at 9am.",
        confidence: 0.91,
      },
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "finance-approval-rule",
        title: "Finance approval rule",
        summary: "Invoices over $5000 require finance approval.",
        tags: ["finance", "approval"],
        evidence: "The current turn explicitly states that invoices over $5000 require finance approval in this workspace.",
        confidence: 0.91,
      },
      {
        scope: "workspace",
        memory_type: "procedure",
        subject_key: "follow-up-procedure",
        title: "Follow-up procedure",
        summary: "Follow up by reviewing the CRM record, drafting the email, and sending it within 24 hours.",
        tags: ["follow-up", "procedure"],
        evidence: "The current turn explicitly lists a three-step customer follow-up procedure with CRM review, draft, and send steps.",
        confidence: 0.93,
      },
    ],
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  const interactionLeaves = listActiveInteractionLeaves(store, "workspace-1");
  const cadenceFact = interactionLeaves.find((leaf) => leaf.title === "Sales review cadence");
  const approvalFact = interactionLeaves.find((leaf) => leaf.title === "Finance approval rule");
  const followUpProcedure = interactionLeaves.find((leaf) => leaf.title === "Follow-up procedure");
  const uncategorizedSummaries = listActiveInteractionSummaries(store, "workspace-1", "interaction:uncategorized");

  assert.ok(cadenceFact);
  assert.ok(approvalFact);
  assert.ok(followUpProcedure);
  assert.equal(cadenceFact?.entityId, "interaction:uncategorized");
  assert.equal(approvalFact?.entityId, "interaction:uncategorized");
  assert.match(files[cadenceFact!.path], /^# Sales review cadence/m);
  assert.match(files[cadenceFact!.path], /Weekly sales review happens every Monday at 9am\./);
  assert.match(files[approvalFact!.path], /^# Finance approval rule/m);
  assert.match(files[approvalFact!.path], /Invoices over \$5000 require finance approval\./);
  assert.match(files[followUpProcedure!.path], /^# Follow-up procedure/m);
  assert.match(files[followUpProcedure!.path], /reviewing the CRM record, drafting the email, and sending it within 24 hours/i);
  assert.equal(uncategorizedSummaries.length, 1);
  assert.match(files[uncategorizedSummaries[0].path], /Sales review cadence/);
  assert.match(files[uncategorizedSummaries[0].path], /Finance approval rule/);
  assert.equal(cadenceFact?.sourceType, "assistant_turn");
  assert.equal(cadenceFact?.admissionConfidence, 0.91);
  assert.equal(approvalFact?.sourceType, "assistant_turn");
  assert.equal(approvalFact?.admissionConfidence, 0.91);
  assert.equal(followUpProcedure?.sourceType, "assistant_turn");
  assert.equal(followUpProcedure?.admissionConfidence, 0.93);
  assert.equal(interactionBatchCursor(store), "3");

  store.close();
});

test("writeTurnDurableMemory keeps distinct memory items active when the extractor reuses an entity-level subject key", async () => {
  const { store, memoryService } = makeRuntimeState("hb-turn-memory-subject-key-refine-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Remember this for Pine Harbor: the billing escalation contact is Nina Patel.",
        assistantText: "I will remember the Pine Harbor billing contact.",
      },
      {
        userText: "Remember this Pine Harbor procedure: 1. Open the ledger case. 2. Confirm the Stripe dispute event. 3. Escalate to the finance lead.",
        assistantText: "I will remember the Pine Harbor procedure.",
      },
      {
        userText: "Also remember for Pine Harbor that the contract renewal owner is Mateo Cruz.",
        assistantText: "I will remember the Pine Harbor contract renewal owner.",
      },
    ],
  });

  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "pine_harbor",
        title: "Pine Harbor billing escalation contact",
        summary: "For Pine Harbor, the billing escalation contact is Nina Patel.",
        tags: ["customer", "contact"],
        evidence: "User stated: Pine Harbor billing escalation contact is Nina Patel.",
        confidence: 0.99,
      },
      {
        scope: "workspace",
        memory_type: "procedure",
        subject_key: "pine_harbor",
        title: "Pine Harbor billing dispute escalation procedure",
        summary: "For Pine Harbor, the procedure is: open the ledger case, confirm the Stripe dispute event, then escalate to the finance lead.",
        tags: ["customer", "procedure"],
        evidence: "User stated the Pine Harbor billing dispute escalation procedure with three concrete steps.",
        confidence: 0.97,
      },
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "pine_harbor",
        title: "Pine Harbor contract renewal owner",
        summary: "For Pine Harbor, the contract renewal owner is Mateo Cruz.",
        tags: ["customer", "owner"],
        evidence: "User stated that Pine Harbor contract renewal owner is Mateo Cruz.",
        confidence: 0.99,
      },
    ],
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });

  const leaves = listActiveInteractionLeaves(store, "workspace-1").filter(
    (leaf) => leaf.entityId === "interaction:customer:pine-harbor",
  );
  const subjectKeys = leaves.map((leaf) => leaf.subjectKey).sort((left, right) => left.localeCompare(right));

  assert.equal(leaves.length, 3);
  assert.deepEqual(subjectKeys, [
    "pine_harbor:billing-dispute-escalation-procedure",
    "pine_harbor:billing-escalation-contact",
    "pine_harbor:contract-renewal-owner",
  ]);

  store.close();
});

test("writeTurnDurableMemory rejects weak model-extracted durable candidates", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-model-reject-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Please keep your responses concise.",
        assistantText: "I will keep responses concise.",
      },
      {
        userText: "Thanks.",
        assistantText: "Understood.",
      },
      {
        userText: "Done for now.",
        assistantText: "Done.",
      },
    ],
  });

  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "reference",
        subject_key: "untrusted-note",
        title: "Untrusted Note",
        summary: "Persist random note.",
        tags: ["random"],
        evidence: "short",
        confidence: 0.42,
      },
    ],
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  assert.deepEqual(listActiveInteractionLeaves(store, "workspace-1"), []);
  assert.deepEqual(listActiveInteractionSummaries(store, "workspace-1"), []);
  assert.deepEqual(Object.keys(files), []);
  assert.equal(interactionBatchCursor(store), "3");

  store.close();
});

test("writeTurnDurableMemory accepts sufficiently confident model-extracted durable candidates", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-model-accept-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Run the checks before shipping.",
        assistantText: "I will run checks before shipping.",
      },
      {
        userText: "Use the standard verification workflow.",
        assistantText: "I will use the standard verification workflow.",
      },
      {
        userText: "For verification, use `npm run test`.",
        assistantText: "Captured verification guidance.",
      },
    ],
  });

  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "verification-command",
        title: "Verification command (model)",
        summary: "Use `npm run test:ci` as the verification command for this workspace.",
        tags: ["verification", "command"],
        evidence: "This was explicitly provided as persistent verification guidance for the workspace.",
        confidence: 0.9,
      },
    ],
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  const verificationFact = listActiveInteractionLeaves(store, "workspace-1").find(
    (leaf) => leaf.title === "Verification command (model)",
  );

  assert.ok(verificationFact);
  assert.match(files[verificationFact!.path], /Verification command \(model\)/);
  assert.match(files[verificationFact!.path], /npm run test:ci/);
  assert.equal(verificationFact?.entityId, "interaction:uncategorized");
  assert.equal(verificationFact?.admissionConfidence, 0.9);
  assert.equal(interactionBatchCursor(store), "3");

  store.close();
});

test("writeTurnDurableMemory processes the first full three-turn batch when a model client is available", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-model-first-batch-");
  seedWorkspace(store);
  const [firstTurn, secondTurn, thirdTurn] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "We need to remember the vendor contact.",
        assistantText: "I will remember the vendor contact.",
      },
      {
        userText: "This is specifically for future escalation handling.",
        assistantText: "Understood.",
      },
      {
        userText: "Remember that the primary vendor escalation contact is Alicia Park.",
        assistantText: "Captured the escalation contact.",
      },
    ],
  });

  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "vendor-escalations.primary-contact",
        title: "Primary vendor escalation contact",
        summary: "Primary vendor escalation contact is Alicia Park.",
        tags: ["vendor", "escalation"],
        evidence: "The user explicitly stated that the primary vendor escalation contact is Alicia Park for future reference.",
        confidence: 0.98,
      },
    ],
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult: firstTurn,
        modelContext,
      });
      assert.equal(listActiveInteractionLeaves(store, "workspace-1").length, 0);

      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult: secondTurn,
        modelContext,
      });
      assert.equal(listActiveInteractionLeaves(store, "workspace-1").length, 0);

      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult: thirdTurn,
        modelContext,
      });
    },
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  const leaf = listActiveInteractionLeaves(store, "workspace-1").find(
    (entry) => entry.title === "Primary vendor escalation contact",
  );

  assert.ok(leaf);
  assert.match(files[leaf!.path], /Alicia Park/);
  assert.equal(leaf?.entityId, "interaction:uncategorized");
  assert.equal(interactionBatchCursor(store), "3");

  store.close();
});

test("refreshMemoryIndexes rebuilds large interaction trees without truncation", async () => {
  const { store, memoryService } = makeRuntimeState("hb-turn-memory-index-pagination-");
  seedWorkspace(store);

  for (let index = 0; index < 550; index += 1) {
    const slug = `fact-${String(index).padStart(3, "0")}`;
    const leafId = `leaf-${slug}`;
    const leafPath = `workspace/workspace-1/interaction/entities/uncategorized/leaves/${leafId}.md`;
    store.upsertInteractionEntity({
      workspaceId: "workspace-1",
      entityId: "interaction:uncategorized",
      entityType: "misc",
      canonicalName: "Uncategorized",
      slug: "uncategorized",
      summary: "Fallback interaction tree.",
      aliases: [],
      isSystem: true,
      status: "active",
    });
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId,
      entityId: "interaction:uncategorized",
      subjectKey: `fact:${slug}`,
      path: leafPath,
      title: `Fact ${slug}`,
      summary: `Summary for ${slug}.`,
      fingerprint: `fingerprint-${slug}`,
      bodySha256: `sha-${slug}`,
      tags: ["scale"],
      secondaryEntityIds: [],
      sourceType: "manual",
      sourceEventId: null,
      sourceMessageId: null,
      sourceTurnInputId: "input-seed",
      admissionConfidence: 0.9,
      entityConfidence: 0.9,
      observedAt: "2026-04-09T10:00:00.000Z",
      supersedesLeafId: null,
      status: "active",
    });
    await memoryService.upsert({
      workspace_id: "workspace-1",
      path: leafPath,
      content: `# Fact ${slug}\n\nSummary for ${slug}.\n`,
      append: false,
    });
  }

  const restoredPaths = await refreshMemoryIndexes({
    store,
    memoryService,
    workspaceId: "workspace-1",
  });
  const summaryNodes = listActiveInteractionSummaries(store, "workspace-1", "interaction:uncategorized");

  assert.equal(summaryNodes.length, 81);
  assert.equal(restoredPaths.length, 81);
  assert.equal(restoredPaths.some((entry) => entry.includes("/summaries/L1/")), true);
  assert.equal(restoredPaths.some((entry) => entry.includes("/summaries/L4/")), true);

  store.close();
});

test("writeTurnDurableMemory rebuilds interaction summaries after new leaves are added", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-incremental-indexes-");
  seedWorkspace(store);

  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:uncategorized",
    entityType: "misc",
    canonicalName: "Uncategorized",
    slug: "uncategorized",
    summary: "Fallback interaction tree.",
    aliases: [],
    isSystem: true,
    status: "active",
  });
  await memoryService.upsert({
    workspace_id: "workspace-1",
    path: "workspace/workspace-1/interaction/entities/uncategorized/leaves/leaf-existing.md",
    content: "# Existing fact\n\nExisting memory.\n",
    append: false,
  });
  store.upsertInteractionLeaf({
    workspaceId: "workspace-1",
    leafId: "leaf-existing",
    entityId: "interaction:uncategorized",
    subjectKey: "fact:existing",
    path: "workspace/workspace-1/interaction/entities/uncategorized/leaves/leaf-existing.md",
    title: "Existing fact",
    summary: "Existing memory.",
    fingerprint: "existing-fingerprint",
    bodySha256: "existing-sha",
    tags: ["seed"],
    secondaryEntityIds: [],
    sourceType: "manual",
    sourceEventId: null,
    sourceMessageId: null,
    sourceTurnInputId: "input-seed",
    admissionConfidence: 0.95,
    entityConfidence: 0.95,
    observedAt: "2026-04-09T10:00:00.000Z",
    supersedesLeafId: null,
    status: "active",
  });
  await refreshMemoryIndexes({
    store,
    memoryService,
    workspaceId: "workspace-1",
  });

  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      {
        userText: "Start tracking the verification workflow.",
        assistantText: "I started tracking the verification workflow.",
      },
      {
        userText: "The verification guidance should be durable.",
        assistantText: "I will preserve the verification guidance.",
      },
      {
        userText: "For verification, use `npm run test`.",
        assistantText: "Captured verification guidance.",
      },
    ],
  });

  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "verification-command",
        title: "Verification command",
        summary: "Use `npm run test` to verify changes in this workspace.",
        tags: ["verification", "command"],
        evidence: "The current turn explicitly instructs the agent to use `npm run test` as the verification command for this workspace.",
        confidence: 0.94,
      },
    ],
    run: async (modelContext) => {
      await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
    },
  });
  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  const leaves = listActiveInteractionLeaves(store, "workspace-1");
  const summaries = listActiveInteractionSummaries(store, "workspace-1", "interaction:uncategorized");

  assert.equal(leaves.length, 2);
  assert.equal(summaries.length, 1);
  assert.ok(files["workspace/workspace-1/interaction/entities/uncategorized/leaves/leaf-existing.md"]);
  const verificationLeaf = leaves.find((leaf) => leaf.title === "Verification command");
  assert.ok(verificationLeaf);
  assert.ok(files[verificationLeaf!.path]);
  assert.ok(files[summaries[0].path]);
  assert.equal(interactionBatchCursor(store), "3");

  store.close();
});
