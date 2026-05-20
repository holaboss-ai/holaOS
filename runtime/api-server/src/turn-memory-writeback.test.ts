import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

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
  run: (modelContext: TurnMemoryWritebackModelContext) => Promise<void>;
}): Promise<void> {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/openai/v1/chat/completions") {
      response.statusCode = 404;
      response.end();
      return;
    }
    void request.resume();
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                memories: params.memories,
              }),
            },
          },
        ],
      })
    );
  });

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

function appendPermissionDeniedToolCall(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  sessionId: string;
  inputId: string;
  toolName?: string;
  toolId?: string;
  reason?: string;
}): void {
  params.store.appendOutputEvent({
    workspaceId: params.workspaceId,
    sessionId: params.sessionId,
    inputId: params.inputId,
    sequence: 1,
    eventType: "tool_call",
    payload: {
      call_id: `call-${params.inputId}`,
      phase: "completed",
      error: true,
      tool_name: params.toolName ?? "deploy",
      tool_id: params.toolId ?? "workspace.deploy",
      message: params.reason ?? "permission denied by policy",
    },
  });
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

test("writeTurnDurableMemory reuses stable durable blocker paths across repeated matching denials", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-dedupe-");
  seedWorkspace(store);

  const firstTurn = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    startedAt: "2026-04-02T12:00:00.000Z",
    completedAt: "2026-04-02T12:00:05.000Z",
    status: "failed",
    stopReason: "policy_denied",
    assistantText: "",
    permissionDenials: [
      {
        tool_name: "deploy",
        tool_id: "workspace.deploy",
        reason: "permission denied by policy",
      },
    ],
  });
  appendPermissionDeniedToolCall({
    store,
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
  });
  await writeTurnDurableMemory({
    store,
    memoryService,
    turnResult: firstTurn,
  });

  const secondTurn = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-2",
    startedAt: "2026-04-02T12:05:00.000Z",
    completedAt: "2026-04-02T12:05:04.000Z",
    status: "failed",
    stopReason: "policy_denied",
    assistantText: "",
    permissionDenials: [
      {
        tool_name: "deploy",
        tool_id: "workspace.deploy",
        reason: "permission denied by policy",
      },
    ],
  });
  appendPermissionDeniedToolCall({
    store,
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-2",
  });
  await writeTurnDurableMemory({
    store,
    memoryService,
    turnResult: secondTurn,
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  const filePaths = Object.keys(files).sort((left, right) => left.localeCompare(right));
  const interactionLeaves = listActiveInteractionLeaves(store, "workspace-1");
  const interactionSummaries = listActiveInteractionSummaries(store, "workspace-1");
  const interactionEntities = listActiveInteractionEntities(store, "workspace-1");
  const blockerLeaf = interactionLeaves[0];

  assert.deepEqual(filePaths, [blockerLeaf.path]);
  assert.equal(interactionLeaves.length, 1);
  assert.equal(blockerLeaf.entityId, "interaction:uncategorized");
  assert.match(blockerLeaf.path, /workspace\/workspace-1\/interaction\/entities\/uncategorized\/leaves\/leaf-[a-f0-9]{24}\.md$/);
  assert.equal(interactionSummaries.length, 0);
  assert.equal(
    interactionEntities.some((entity) => entity.entityId === "interaction:uncategorized"),
    true,
  );
  assert.equal(blockerLeaf.sourceType, "permission_denial");
  assert.equal(blockerLeaf.admissionConfidence, 0.92);
  assert.match(files[blockerLeaf.path], /Recurring Permission Blocker/);
  assert.match(files[blockerLeaf.path], /workspace\.deploy/);

  store.close();
});

test("writeTurnDurableMemory extracts durable workspace facts and procedures from explicit instructions", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-facts-");
  seedWorkspace(store);
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: [
      "Please keep your responses concise.",
      "",
      "For verification, use `npm run test`.",
      "",
      "Release procedure:",
      "1. Run `npm run test`.",
      "2. Run `npm run build`.",
      "3. Publish the bundle.",
    ].join("\n"),
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
    assistantText: "Captured workspace-specific instructions for future runs.",
  });

  await writeTurnDurableMemory({
    store,
    memoryService,
    turnResult,
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
  assert.match(files[verificationFact!.path], /Workspace Fact: Verification Command/);
  assert.match(files[verificationFact!.path], /`npm run test`/);
  assert.match(files[releaseProcedure!.path], /Workspace Procedure: Release/);
  assert.match(files[releaseProcedure!.path], /1\. Run `npm run test`\./);
  assert.match(files[releaseProcedure!.path], /2\. Run `npm run build`\./);
  assert.equal(listActiveInteractionSummaries(store, "workspace-1").length, 0);
  assert.equal(verificationFact?.sourceType, "session_message");
  assert.equal(verificationFact?.admissionConfidence, 0.94);
  assert.equal(releaseProcedure?.sourceType, "session_message");
  assert.equal(releaseProcedure?.admissionConfidence, 0.93);

  store.close();
});

test("writeTurnDurableMemory extracts durable business facts and procedures from explicit workspace instructions", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-business-");
  seedWorkspace(store);
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: [
      "Weekly sales review is every Monday at 9am.",
      "",
      "Invoices over $5000 require finance approval.",
      "",
      "Customer follow-up process:",
      "1. Review the CRM record.",
      "2. Draft the follow-up email.",
      "3. Send it within 24 hours.",
    ].join("\n"),
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
    assistantText: "Captured business workflow rules for later recall.",
  });

  await writeTurnDurableMemory({
    store,
    memoryService,
    turnResult,
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
  assert.match(files[cadenceFact!.path], /Workspace Fact: Sales review cadence/);
  assert.match(files[cadenceFact!.path], /Weekly sales review is every Monday at 9am\./);
  assert.match(files[approvalFact!.path], /Workspace Fact: Finance approval rule/);
  assert.match(files[approvalFact!.path], /Invoices over \$5000 require finance approval in this workspace\./);
  assert.match(files[followUpProcedure!.path], /Workspace Procedure: Follow-up/);
  assert.match(files[followUpProcedure!.path], /1\. Review the CRM record\./);
  assert.equal(uncategorizedSummaries.length, 1);
  assert.match(files[uncategorizedSummaries[0].path], /Sales review cadence/);
  assert.match(files[uncategorizedSummaries[0].path], /Finance approval rule/);
  assert.equal(cadenceFact?.sourceType, "session_message");
  assert.equal(cadenceFact?.admissionConfidence, 0.91);
  assert.equal(approvalFact?.sourceType, "session_message");
  assert.equal(approvalFact?.admissionConfidence, 0.91);
  assert.equal(followUpProcedure?.sourceType, "session_message");
  assert.equal(followUpProcedure?.admissionConfidence, 0.93);

  store.close();
});

test("writeTurnDurableMemory rejects weak uncorroborated model-extracted durable candidates", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-model-reject-");
  seedWorkspace(store);
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "Please keep your responses concise.",
    messageId: "user-1",
    createdAt: "2026-04-02T12:00:00.000Z",
  });
  for (let index = 1; index <= 4; index += 1) {
    store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: `prior-${index}`,
      startedAt: `2026-04-02T11:5${index}:00.000Z`,
      completedAt: `2026-04-02T11:5${index}:05.000Z`,
      status: "completed",
      stopReason: "ok",
      assistantText: `Prior turn ${index}.`,
    });
  }

  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-5",
    startedAt: "2026-04-02T12:00:00.000Z",
    completedAt: "2026-04-02T12:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Done.",
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

  store.close();
});

test("writeTurnDurableMemory accepts corroborated model-extracted durable candidates with relaxed threshold", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-model-corroborated-");
  seedWorkspace(store);
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "For verification, use `npm run test`.",
    messageId: "user-1",
    createdAt: "2026-04-02T12:00:00.000Z",
  });
  for (let index = 1; index <= 4; index += 1) {
    store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: `prior-${index}`,
      startedAt: `2026-04-02T11:5${index}:00.000Z`,
      completedAt: `2026-04-02T11:5${index}:05.000Z`,
      status: "completed",
      stopReason: "ok",
      assistantText: `Prior turn ${index}.`,
    });
  }

  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-5",
    startedAt: "2026-04-02T12:00:00.000Z",
    completedAt: "2026-04-02T12:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Captured verification guidance.",
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
        confidence: 0.61,
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
  assert.equal(verificationFact?.admissionConfidence, 0.61);

  store.close();
});

test("writeTurnDurableMemory skips model extraction before the first cadence turn", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-model-cadence-skip-");
  seedWorkspace(store);
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "Remember that the primary vendor escalation contact is Alicia Park.",
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
    assistantText: "Captured the escalation contact.",
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
        turnResult,
        modelContext,
      });
    },
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");

  assert.deepEqual(listActiveInteractionLeaves(store, "workspace-1"), []);
  assert.deepEqual(listActiveInteractionSummaries(store, "workspace-1"), []);
  assert.deepEqual(Object.keys(files), []);

  store.close();
});

test("writeTurnDurableMemory runs model extraction on cadence turns", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-model-cadence-run-");
  seedWorkspace(store);
  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "Remember that the primary vendor escalation contact is Alicia Park.",
    messageId: "user-1",
    createdAt: "2026-04-02T12:00:00.000Z",
  });

  for (let index = 1; index <= 4; index += 1) {
    store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: `input-${index}`,
      startedAt: `2026-04-02T11:5${index}:00.000Z`,
      completedAt: `2026-04-02T11:5${index}:05.000Z`,
      status: "completed",
      stopReason: "ok",
      assistantText: `Prior turn ${index}.`,
    });
  }
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-5",
    startedAt: "2026-04-02T12:00:00.000Z",
    completedAt: "2026-04-02T12:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Captured the escalation contact.",
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
        turnResult,
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

  store.insertSessionMessage({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    role: "user",
    text: "For verification, use `npm run test`.",
    messageId: "user-1",
    createdAt: "2026-04-09T10:01:00.000Z",
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "input-1",
    startedAt: "2026-04-09T10:01:00.000Z",
    completedAt: "2026-04-09T10:01:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Captured verification guidance.",
  });

  await writeTurnDurableMemory({
    store,
    memoryService,
    turnResult,
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

  store.close();
});
