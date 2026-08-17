import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import { RuntimeStateStore, type TurnResultRecord } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import { FilesystemMemoryService } from "./memory.js";
import {
  globalMemoryDirForWorkspaceRoot,
  workspaceMemoryDir,
} from "./workspace-bundle-paths.js";
import {
  refreshMemoryIndexes,
  waitForPendingWorkspaceMemoryTreeRebuilds,
  writeTurnDurableMemory,
  writeTurnMemory,
  type TurnMemoryWritebackModelContext,
} from "./turn-memory-writeback.js";
import {
  legacyRelatedEntityKey,
} from "./workspace-related-entity-keys.js";
import {
  listWorkspaceAttachmentDocumentTrees,
  listWorkspaceImageUrlDocumentTrees,
  listWorkspaceOutputDocumentTrees,
  listWorkspaceToolResultDocumentTrees,
} from "./workspace-attachment-memory.js";
import {
  parseDurableMemoryRelatedInfo,
} from "./memory-related-entities.js";
import { retrieveWorkspaceMemory } from "./workspace-memory.js";

const tempDirs: string[] = [];
const DARWIN_SWIFTC_PATH = "/usr/bin/swiftc";
const DARWIN_VISION_OCR_AVAILABLE = process.platform === "darwin" && fs.existsSync(DARWIN_SWIFTC_PATH);

afterEach(async () => {
  await waitForPendingWorkspaceMemoryTreeRebuilds();
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

function createPdfBuffer(text: string): Buffer {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT\n/F1 12 Tf\n72 200 Td\n(${escapedText}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let output = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += object;
  }
  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, "utf8");
}

function createPngBufferWithText(text: string): Buffer {
  assert.ok(DARWIN_VISION_OCR_AVAILABLE, "macOS Vision OCR fixture generation requires swiftc on Darwin");
  const stageDir = makeTempDir("hb-image-ocr-writeback-fixture-");
  const sourcePath = path.join(stageDir, "make-image.swift");
  const binaryPath = path.join(stageDir, "make-image");
  const outputPath = path.join(stageDir, "test.png");
  fs.writeFileSync(
    sourcePath,
    [
      "import AppKit",
      "import Foundation",
      "",
      "let size = NSSize(width: 1400, height: 320)",
      "let image = NSImage(size: size)",
      "image.lockFocus()",
      "NSColor.white.setFill()",
      "NSBezierPath(rect: NSRect(origin: .zero, size: size)).fill()",
      "let paragraph = NSMutableParagraphStyle()",
      "paragraph.alignment = .left",
      "let attrs: [NSAttributedString.Key: Any] = [",
      "  .font: NSFont.systemFont(ofSize: 54, weight: .regular),",
      "  .foregroundColor: NSColor.black,",
      "  .paragraphStyle: paragraph,",
      "]",
      `let text = ${JSON.stringify(text)}`,
      "text.draw(in: NSRect(x: 48, y: 120, width: 1300, height: 140), withAttributes: attrs)",
      "image.unlockFocus()",
      "guard let tiff = image.tiffRepresentation,",
      "      let rep = NSBitmapImageRep(data: tiff),",
      "      let png = rep.representation(using: .png, properties: [:]) else {",
      "  throw NSError(domain: \"make-image\", code: 1)",
      "}",
      "let outputPath = CommandLine.arguments[1]",
      "try png.write(to: URL(fileURLWithPath: outputPath))",
    ].join("\n"),
    "utf8",
  );
  const compile = spawnSync(DARWIN_SWIFTC_PATH, [sourcePath, "-o", binaryPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const run = spawnSync(binaryPath, [outputPath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  return fs.readFileSync(outputPath);
}

function listActiveInteractionLeaves(store: RuntimeStateStore, workspaceId: string) {
  return store.listInteractionLeaves({
    workspaceId,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
}

function listSummaryLikeSemanticInteractionNodes(
  store: RuntimeStateStore,
  workspaceId: string,
  treeId?: string,
) {
  return store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId,
    treeId: treeId ?? undefined,
    nodeClass: "semantic",
    status: "active",
    limit: 10_000,
    offset: 0,
  })
    .filter((node) => node.nodeKind !== "tree" || node.childCount > 1)
    .map((node) => ({
      ...node,
      path: `workspace/${workspaceId}/${node.path}`,
    }));
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
  waitForRebuilds?: boolean;
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
    waitForRebuilds: params.waitForRebuilds,
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
  responseForRequest?: (
    body: string,
    index: number,
  ) => {
    statusCode: number;
    body?: Record<string, unknown>;
    delayMs?: number;
  };
  waitForRebuilds?: boolean;
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
      const requestBody = Buffer.concat(chunks).toString("utf8");
      params.onRequest?.(requestBody, requestIndex);
      const configuredResponse = params.responseForRequest?.(requestBody, requestIndex)
        ?? params.responses[Math.min(requestIndex, params.responses.length - 1)]
        ?? {
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
    if (params.waitForRebuilds !== false) {
      await waitForPendingWorkspaceMemoryTreeRebuilds({ workspaceId: "workspace-1" });
    }
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
  seedWorkspaceRecord(store, {
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

function workspaceBatchCursor(store: RuntimeStateStore, sessionId = "session-main"): string | null {
  return store.getWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: `workspace_memory_batch_processed_count:${sessionId}`,
  });
}

function latestWorkspaceBatchState(store: RuntimeStateStore, sessionId = "session-main"): Record<string, unknown> | null {
  const raw = store.getWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: `workspace_memory_batch_latest:${sessionId}`,
  });
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

test("writeTurnDurableMemory does NOT run the per-turn extraction by default (tool-only) — no model call, nothing extracted", async () => {
  // Regression guard: durable capture is the agent's `remember` tool, not post-hoc
  // extraction. The per-turn extraction pass was removed entirely — even with a
  // model client available and turns that once WOULD have extracted, writeTurnDurableMemory
  // must make no model call and persist no durable leaves. (Artifact indexing is
  // covered separately.)
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-tool-only-");
  seedWorkspace(store);
  const [, , turnResult] = seedCompletedTurns({
    store,
    turns: [
      { userText: "Please keep your responses concise.", assistantText: "I will keep responses concise." },
      { userText: "For verification, use `npm run test`.", assistantText: "I will use `npm run test` for verification." },
      { userText: "Release: run tests, build, publish.", assistantText: "Captured workspace-specific instructions." },
    ],
  });

  let modelRequestCount = 0;
  await withModelExtractionResponse({
    memories: [
      {
        scope: "workspace",
        memory_type: "fact",
        subject_key: "verification-command",
        title: "Verification command",
        summary: "Use `npm run test` to verify this workspace before shipping changes.",
        tags: ["verification"],
        evidence: "The current turn explicitly instructs the agent to use `npm run test`.",
        confidence: 0.94,
      },
    ],
    onRequest: () => {
      modelRequestCount += 1;
    },
    run: async (modelContext) => {
      // A model client is available (via modelContext), yet no extraction runs.
      const updated = await writeTurnDurableMemory({
        store,
        memoryService,
        turnResult,
        modelContext,
      });
      assert.equal(updated.inputId, turnResult.inputId);
    },
  });

  const files = snapshotMemoryFiles(workspaceRoot, "workspace-1");
  assert.equal(modelRequestCount, 0, "extraction must make no model call by default");
  assert.deepEqual(listActiveInteractionLeaves(store, "workspace-1"), []);
  assert.deepEqual(Object.keys(files), []);
  assert.equal(workspaceBatchCursor(store), null);

  store.close();
});

test("writeTurnDurableMemory persists referenced image URLs as first-class artifact docs", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-image-url-doc-");
  seedWorkspace(store);

  const imageRelativePath = "references/reference.png";
  const imageAbsolutePath = path.join(workspaceRoot, "workspace-1", imageRelativePath);
  fs.mkdirSync(path.dirname(imageAbsolutePath), { recursive: true });
  fs.writeFileSync(
    imageAbsolutePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z9WQAAAAASUVORK5CYII=",
      "base64",
    ),
  );

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Keep this referenced image around.",
      image_urls: [pathToFileURL(imageAbsolutePath).toString()],
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T10:15:00.000Z",
    completedAt: "2026-06-04T10:15:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the referenced image.",
  });

  await writeTurnDurableMemory({
    store,
    memoryService,
    turnResult,
    modelContext: null,
  });

  const imageUrlTrees = listWorkspaceImageUrlDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(imageUrlTrees.length, 1);
  assert.equal(imageUrlTrees[0]?.title, "reference.png");

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
  const summaryNodes = listSummaryLikeSemanticInteractionNodes(store, "workspace-1", "interaction:uncategorized");

  assert.equal(summaryNodes.length, 81);
  assert.equal(restoredPaths.length, 81);
  assert.equal(restoredPaths.includes("semantic/workspace/knowledge/uncategorized/content.md"), true);
  assert.equal(restoredPaths.some((entry) => entry.includes("/slice-l1-")), true);
  assert.equal(restoredPaths.some((entry) => entry.includes("/slice-l3-")), true);

  store.close();
});

test("refreshMemoryIndexes can target specific interaction entities", async () => {
  const { store, memoryService, workspaceRoot } = makeRuntimeState("hb-turn-memory-targeted-index-refresh-");
  seedWorkspace(store);

  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:customer:redwood-care",
    entityType: "customer",
    canonicalName: "Redwood Care",
    slug: "customer-redwood-care",
    summary: "Customer memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });
  store.upsertInteractionEntity({
    workspaceId: "workspace-1",
    entityId: "interaction:workflow:deploy-procedure",
    entityType: "workflow",
    canonicalName: "Deploy procedure",
    slug: "workflow-deploy-procedure",
    summary: "Workflow memory.",
    aliases: [],
    isSystem: false,
    status: "active",
  });

  const seedLeaf = async (params: {
    entityId: string;
    slug: string;
    leafId: string;
    title: string;
    summary: string;
  }) => {
    const leafPath = `workspace/workspace-1/interaction/entities/${params.slug}/leaves/${params.leafId}.md`;
    store.upsertInteractionLeaf({
      workspaceId: "workspace-1",
      leafId: params.leafId,
      entityId: params.entityId,
      subjectKey: `seed:${params.leafId}`,
      path: leafPath,
      title: params.title,
      summary: params.summary,
      fingerprint: `fingerprint-${params.leafId}`,
      bodySha256: `sha-${params.leafId}`,
      tags: ["seed"],
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
      content: `# ${params.title}\n\n${params.summary}\n`,
      append: false,
    });
  };

  await seedLeaf({
    entityId: "interaction:customer:redwood-care",
    slug: "customer-redwood-care",
    leafId: "leaf-customer",
    title: "Redwood escalation owner",
    summary: "Route severe billing issues to Alicia Park.",
  });
  await seedLeaf({
    entityId: "interaction:customer:redwood-care",
    slug: "customer-redwood-care",
    leafId: "leaf-customer-2",
    title: "Redwood billing backup",
    summary: "Escalate backup billing issues to Jordan Lee.",
  });
  await seedLeaf({
    entityId: "interaction:workflow:deploy-procedure",
    slug: "workflow-deploy-procedure",
    leafId: "leaf-workflow",
    title: "Deploy verification",
    summary: "Run smoke tests before release.",
  });

  await refreshMemoryIndexes({
    store,
    memoryService,
    workspaceId: "workspace-1",
  });

  const workspaceDir = workspaceMemoryDir(path.join(workspaceRoot, "workspace-1"));
  const customerSummaryPath = path.join(
    workspaceDir,
    "semantic",
    "workspace",
    "organizations",
    "customer-redwood-care",
    "content.md",
  );
  const workflowSummaryPath = path.join(
    workspaceDir,
    "semantic",
    "workspace",
    "processes",
    "workflow-deploy-procedure",
    "content.md",
  );
  assert.equal(fs.existsSync(customerSummaryPath), true);
  assert.equal(fs.existsSync(workflowSummaryPath), true);

  fs.rmSync(path.dirname(customerSummaryPath), { recursive: true, force: true });
  fs.rmSync(path.dirname(workflowSummaryPath), { recursive: true, force: true });
  assert.equal(fs.existsSync(customerSummaryPath), false);
  assert.equal(fs.existsSync(workflowSummaryPath), false);

  const restoredPaths = await refreshMemoryIndexes({
    store,
    memoryService,
    workspaceId: "workspace-1",
    entityIds: ["interaction:customer:redwood-care"],
  });

  assert.ok(restoredPaths.length > 0);
  assert.ok(restoredPaths.every((entry) => entry.includes("customer-redwood-care")));
  assert.equal(fs.existsSync(customerSummaryPath), true);
  assert.equal(fs.existsSync(workflowSummaryPath), false);

  store.close();
});

test("writeTurnMemory logs a writeback failure instead of swallowing it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-memory-writeback-log-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const turnResult = {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      inputId: "input-1",
    } as unknown as TurnResultRecord;

    // No workspace seeded and a store that will reject the writeback, so the
    // durable pass throws. The caller fires this without awaiting, so it must
    // still resolve — but silently is what made a lost turn undiagnosable.
    const returned = await writeTurnMemory({
      store: {
        ...store,
        getTurnResult: () => null,
      } as unknown as RuntimeStateStore,
      turnResult,
      modelContext: null,
    });

    assert.equal(returned, turnResult, "must resolve to the caller's turn result");
    assert.equal(warnings.length, 1, "the failure must be logged exactly once");
    assert.match(String(warnings[0]?.[0]), /\[memory\] durable writeback failed/);
    assert.match(String(warnings[0]?.[0]), /input=input-1/);
  } finally {
    console.warn = originalWarn;
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
