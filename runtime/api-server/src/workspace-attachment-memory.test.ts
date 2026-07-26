import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";
import JSZip from "jszip";

import { buildMemoryBrowserGraph, buildMemoryBrowserTree } from "./memory-browser.js";
import { appendDurableMemoryRelatedSections } from "./memory-related-entities.js";
import { workspaceMemoryDir } from "./workspace-bundle-paths.js";
import {
  artifactContextsForSourceTurnInput,
  ensureWorkspaceArtifactRelationsBackfilled,
  listWorkspaceAttachmentDocumentTrees,
  listWorkspaceImageUrlDocumentTrees,
  listWorkspaceOutputDocumentTrees,
  listWorkspaceToolResultDocumentTrees,
  persistTurnInputAttachmentsAsDocuments,
  persistTurnReferencedImageUrlsAsDocuments,
  persistTurnIntegrationToolResultsAsDocuments,
  persistTurnOutputArtifactsAsDocuments,
  syncWorkspaceArtifactRelations,
} from "./workspace-attachment-memory.js";
import { retrieveWorkspaceMemory } from "./workspace-memory.js";

const tempDirs: string[] = [];
const ORIGINAL_FETCH = globalThis.fetch;
const nodeRequire = createRequire(import.meta.url);
const DARWIN_SWIFTC_PATH = "/usr/bin/swiftc";
const DARWIN_VISION_OCR_AVAILABLE = process.platform === "darwin" && fs.existsSync(DARWIN_SWIFTC_PATH);
interface ExcelJSCellLike {
  value: unknown;
}
interface ExcelJSWorksheetLike {
  name: string;
  getCell(row: number, col: number): ExcelJSCellLike;
}
interface ExcelJSWorkbookLike {
  addWorksheet(name?: string): ExcelJSWorksheetLike;
  xlsx: { writeBuffer(): Promise<Buffer | Uint8Array | ArrayBuffer> };
}
const ExcelJS = nodeRequire("exceljs") as {
  Workbook: new () => ExcelJSWorkbookLike;
};

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

function makeRuntimeState(prefix: string): {
  workspaceRoot: string;
  store: RuntimeStateStore;
} {
  const root = makeTempDir(prefix);
  const workspaceRoot = path.join(root, "workspaces");
  return {
    workspaceRoot,
    store: new RuntimeStateStore({
      dbPath: path.join(root, "runtime.db"),
      workspaceRoot,
    }),
  };
}

function seedWorkspace(store: RuntimeStateStore): void {
  seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
}

async function createDocxBuffer(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const body = lines.map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function createXlsxBuffer(rows: string[][], sheetName = "Sheet1"): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName);
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      worksheet.getCell(rowIndex + 1, columnIndex + 1).value = value;
    });
  });
  const output = await workbook.xlsx.writeBuffer();
  if (Buffer.isBuffer(output)) {
    return output;
  }
  if (output instanceof Uint8Array) {
    return Buffer.from(output);
  }
  return Buffer.from(output);
}

async function createPptxBuffer(slides: string[][]): Promise<Buffer> {
  const zip = new JSZip();
  slides.forEach((slideLines, index) => {
    const body = slideLines.map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`).join("");
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`,
    );
  });
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
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
  const stageDir = makeTempDir("hb-image-ocr-fixture-");
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

test("persistTurnInputAttachmentsAsDocuments indexes attachments as first-class artifact trees for retrieval and browser visibility", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-attachment-memory-");
  seedWorkspace(store);

  const attachmentRelativePath = ".holaboss/input-attachments/batch-1/outreach-report.html";
  const attachmentAbsolutePath = path.join(
    workspaceRoot,
    "workspace-1",
    ".holaboss",
    "input-attachments",
    "batch-1",
    "outreach-report.html",
  );
  fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
  fs.writeFileSync(
    attachmentAbsolutePath,
    [
      "<html><body>",
      "<h1>holaboss personal outreach</h1>",
      "<p>Ben Book from anyIP emailed the user personally about holaboss.</p>",
      "<p>Use the saved thread for future outreach follow-up.</p>",
      "</body></html>",
    ].join(""),
    "utf8",
  );

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Save this attachment for later reference.",
      attachments: [
        {
          id: "att-1",
          kind: "file",
          name: "outreach-report.html",
          mime_type: "text/html",
          size_bytes: 256,
          workspace_path: attachmentRelativePath,
        },
      ],
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-03T09:00:00.000Z",
    completedAt: "2026-06-03T09:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I saved the attachment for later reference.",
  });

  const treeIds = await persistTurnInputAttachmentsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });
  assert.equal(treeIds.length, 1);

  const attachmentTrees = listWorkspaceAttachmentDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(attachmentTrees.length, 1);
  assert.equal(attachmentTrees[0]?.title, "outreach-report.html");

  const treeId = attachmentTrees[0]!.treeId;
  const nodes = store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  assert.equal(nodes.length, 2);
  assert.ok(nodes.some((node) => node.nodeClass === "leaf"));

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "future outreach follow-up",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.match(retrieval.evidence[0]?.title ?? "", /outreach-report\.html/i);
  assert.ok(retrieval.evidence[0]?.reasons.includes("lexical_match"));

  const browserTree = await buildMemoryBrowserTree({
    store,
    workspaceId: "workspace-1",
  });
  const workspaceDirectory = (browserTree.root.children ?? []).find((child) => child.name === "workspace");
  const artifactsDirectory = (workspaceDirectory?.children ?? []).find((child) => child.name === "artifacts");
  assert.ok(artifactsDirectory && artifactsDirectory.kind === "directory");
  const attachmentDirectory = (artifactsDirectory.children ?? []).find((child) =>
    child.name.startsWith("outreach-report-"),
  );
  assert.ok(attachmentDirectory && attachmentDirectory.kind === "directory");
  assert.ok((attachmentDirectory.children ?? []).some((child) => child.name === "content.md"));

  const graph = await buildMemoryBrowserGraph({
    store,
    workspaceId: "workspace-1",
    forest: "workspace",
  });
  assert.ok(graph.nodes.some((node) => node.label === "Artifacts" && node.kind === "section"));
  assert.ok(graph.nodes.some((node) => node.tree_id === treeId && node.label === "outreach-report.html"));

  store.close();
});

test("ensureWorkspaceArtifactRelationsBackfilled disambiguates repeated attachment IDs across separate turns", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-attachment-tree-repeat-backfill-");
  seedWorkspace(store);

  const attachmentRelativePath = ".holaboss/input-attachments/shared/customer-notes.md";
  const attachmentAbsolutePath = path.join(workspaceRoot, "workspace-1", attachmentRelativePath);
  fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
  fs.writeFileSync(
    attachmentAbsolutePath,
    [
      "# Customer Notes",
      "",
      "Mina Chen owns the renewal checkpoint.",
    ].join("\n"),
    "utf8",
  );

  for (const completedAt of [
    "2026-06-04T10:05:05.000Z",
    "2026-06-04T10:10:05.000Z",
  ]) {
    const queuedInput = store.enqueueInput({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      payload: {
        text: "Keep the shared attachment around.",
        attachments: [
          {
            id: "att-shared-1",
            kind: "file",
            name: "customer-notes.md",
            mime_type: "text/markdown",
            size_bytes: 128,
            workspace_path: attachmentRelativePath,
          },
        ],
      },
    });
    store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: queuedInput.inputId,
      startedAt: completedAt,
      completedAt,
      status: "completed",
      stopReason: "ok",
      assistantText: "Saved the shared attachment.",
    });
  }

  store.setWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: "workspace_artifact_relation_backfill_v1_complete",
    value: "true",
  });

  ensureWorkspaceArtifactRelationsBackfilled({
    store,
    workspaceId: "workspace-1",
  });

  const attachmentTrees = listWorkspaceAttachmentDocumentTrees({
    store,
    workspaceId: "workspace-1",
  }).filter((descriptor) => descriptor.attachmentId === "att-shared-1");
  assert.equal(attachmentTrees.length, 2);
  assert.equal(new Set(attachmentTrees.map((descriptor) => descriptor.path)).size, 2);
  assert.equal(new Set(attachmentTrees.map((descriptor) => descriptor.sourceTurnInputId)).size, 2);

  const browserTree = await buildMemoryBrowserTree({
    store,
    workspaceId: "workspace-1",
  });
  const workspaceDirectory = (browserTree.root.children ?? []).find((child) => child.name === "workspace");
  const artifactsDirectory = (workspaceDirectory?.children ?? []).find((child) => child.name === "artifacts");
  const repeatedAttachmentDirectories = (artifactsDirectory?.children ?? []).filter((child) =>
    child.name.startsWith("customer-notes-att-shar-"),
  ) ?? [];
  assert.equal(repeatedAttachmentDirectories.length, 2);

  store.close();
});

test("persistTurnInputAttachmentsAsDocuments extracts searchable text from docx attachments", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-docx-attachment-memory-");
  seedWorkspace(store);

  const attachmentRelativePath = ".holaboss/input-attachments/batch-1/customer-brief.docx";
  const attachmentAbsolutePath = path.join(workspaceRoot, "workspace-1", attachmentRelativePath);
  fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
  fs.writeFileSync(
    attachmentAbsolutePath,
    await createDocxBuffer([
      "Pine Harbor billing escalation contact is Nina Patel.",
      "Renewal owner is Mateo Cruz.",
    ]),
  );

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Remember the contacts from this docx brief.",
      attachments: [
        {
          id: "att-docx-1",
          kind: "file",
          name: "customer-brief.docx",
          mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size_bytes: fs.statSync(attachmentAbsolutePath).size,
          workspace_path: attachmentRelativePath,
        },
      ],
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T09:10:00.000Z",
    completedAt: "2026-06-04T09:10:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the docx attachment.",
  });

  const treeIds = await persistTurnInputAttachmentsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });
  assert.equal(treeIds.length, 1);

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "Nina Patel Pine Harbor billing escalation",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => /customer-brief\.docx/i.test(item.title)));
  assert.ok(retrieval.evidence.some((item) => item.reasons.includes("lexical_match")));

  store.close();
});

test("persistTurnInputAttachmentsAsDocuments extracts searchable text from PDF attachments", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-pdf-attachment-memory-");
  seedWorkspace(store);

  const attachmentRelativePath = ".holaboss/input-attachments/batch-1/account-brief.pdf";
  const attachmentAbsolutePath = path.join(
    workspaceRoot,
    "workspace-1",
    ".holaboss",
    "input-attachments",
    "batch-1",
    "account-brief.pdf",
  );
  fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
  fs.writeFileSync(
    attachmentAbsolutePath,
    createPdfBuffer("AWS account 423623864703 exceeded zero spend budget"),
  );

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Remember the key facts from this PDF attachment.",
      attachments: [
        {
          id: "att-pdf-1",
          kind: "file",
          name: "account-brief.pdf",
          mime_type: "application/pdf",
          size_bytes: fs.statSync(attachmentAbsolutePath).size,
          workspace_path: attachmentRelativePath,
        },
      ],
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T09:00:00.000Z",
    completedAt: "2026-06-04T09:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the PDF attachment.",
  });

  const treeIds = await persistTurnInputAttachmentsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });
  assert.equal(treeIds.length, 1);

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "423623864703 zero spend budget",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => /account-brief\.pdf/i.test(item.title)));
  assert.ok(retrieval.evidence.some((item) => item.reasons.includes("lexical_match")));

  const browserTree = await buildMemoryBrowserTree({
    store,
    workspaceId: "workspace-1",
  });
  const workspaceDirectory = (browserTree.root.children ?? []).find((child) => child.name === "workspace");
  const artifactsDirectory = (workspaceDirectory?.children ?? []).find((child) => child.name === "artifacts");
  assert.ok(artifactsDirectory && artifactsDirectory.kind === "directory");

  store.close();
});

test("persistTurnInputAttachmentsAsDocuments extracts searchable text from pptx attachments", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-pptx-attachment-memory-");
  seedWorkspace(store);

  const attachmentRelativePath = ".holaboss/input-attachments/batch-1/q2-review.pptx";
  const attachmentAbsolutePath = path.join(workspaceRoot, "workspace-1", attachmentRelativePath);
  fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
  fs.writeFileSync(
    attachmentAbsolutePath,
    await createPptxBuffer([
      ["Q2 Review", "Nina Patel owns the Pine Harbor rollout"],
      ["Next steps", "Mateo Cruz to confirm renewal timeline"],
    ]),
  );

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Keep the key points from this presentation.",
      attachments: [
        {
          id: "att-pptx-1",
          kind: "file",
          name: "q2-review.pptx",
          mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          size_bytes: fs.statSync(attachmentAbsolutePath).size,
          workspace_path: attachmentRelativePath,
        },
      ],
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T09:15:00.000Z",
    completedAt: "2026-06-04T09:15:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the presentation attachment.",
  });

  const treeIds = await persistTurnInputAttachmentsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });
  assert.equal(treeIds.length, 1);

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "Pine Harbor rollout Nina Patel",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => /q2-review\.pptx/i.test(item.title)));
  assert.ok(retrieval.evidence.some((item) => item.reasons.includes("lexical_match")));

  store.close();
});

test(
  "persistTurnInputAttachmentsAsDocuments extracts searchable text from image attachments via macOS Vision OCR",
  { skip: !DARWIN_VISION_OCR_AVAILABLE },
  async () => {
    const { store, workspaceRoot } = makeRuntimeState("hb-workspace-image-attachment-memory-");
    seedWorkspace(store);

    const attachmentRelativePath = ".holaboss/input-attachments/batch-1/escalation-note.png";
    const attachmentAbsolutePath = path.join(workspaceRoot, "workspace-1", attachmentRelativePath);
    fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
    fs.writeFileSync(
      attachmentAbsolutePath,
      createPngBufferWithText("Nina Patel owns Pine Harbor billing escalation"),
    );

    const queuedInput = store.enqueueInput({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      payload: {
        text: "Keep the key detail from this image.",
        attachments: [
          {
            id: "att-image-1",
            kind: "image",
            name: "escalation-note.png",
            mime_type: "image/png",
            size_bytes: fs.statSync(attachmentAbsolutePath).size,
            workspace_path: attachmentRelativePath,
          },
        ],
      },
    });
    const turnResult = store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: queuedInput.inputId,
      startedAt: "2026-06-04T10:10:00.000Z",
      completedAt: "2026-06-04T10:10:05.000Z",
      status: "completed",
      stopReason: "ok",
      assistantText: "I preserved the image attachment.",
    });

    const treeIds = await persistTurnInputAttachmentsAsDocuments({
      store,
      turnResult,
      embeddingClient: null,
    });
    assert.equal(treeIds.length, 1);

    const retrieval = await retrieveWorkspaceMemory({
      store,
      workspaceId: "workspace-1",
      query: "Nina Patel Pine Harbor billing escalation",
      executionProfile: {
        useEmbeddings: false,
        useLlmRerank: false,
      },
    });
    assert.ok(retrieval.evidence.some((item) => /escalation-note\.png/i.test(item.title)));
    assert.ok(retrieval.evidence.some((item) => item.reasons.includes("lexical_match")));

    store.close();
  },
);

test("persistTurnInputAttachmentsAsDocuments extracts searchable text from image attachments via model fallback", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-image-attachment-model-memory-");
  seedWorkspace(store);

  const attachmentRelativePath = ".holaboss/input-attachments/batch-1/escalation-note.png";
  const attachmentAbsolutePath = path.join(workspaceRoot, "workspace-1", attachmentRelativePath);
  fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
  fs.writeFileSync(attachmentAbsolutePath, Buffer.from("not-a-real-png"));

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Keep the key detail from this image.",
      attachments: [
        {
          id: "att-image-2",
          kind: "image",
          name: "escalation-note.png",
          mime_type: "image/png",
          size_bytes: fs.statSync(attachmentAbsolutePath).size,
          workspace_path: attachmentRelativePath,
        },
      ],
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T10:12:00.000Z",
    completedAt: "2026-06-04T10:12:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the image attachment.",
  });

  let recordedRequestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input, init) => {
    recordedRequestBody =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                extracted_text: "Nina Patel owns Pine Harbor billing escalation",
                summary: "Escalation ownership note.",
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const treeIds = await persistTurnInputAttachmentsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
    visionModelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-image",
      modelId: "gpt-4.1-mini",
      apiStyle: "openai_compatible",
    },
  });
  assert.equal(treeIds.length, 1);
  assert.ok(recordedRequestBody);
  const requestBody = recordedRequestBody as Record<string, unknown>;
  const messages = requestBody.messages as Array<Record<string, unknown>>;
  const content = messages[1]?.content as Array<Record<string, unknown>>;
  assert.equal(content[1]?.type, "image_url");
  assert.match(String((content[1]?.image_url as Record<string, unknown>)?.url ?? ""), /^data:image\/png;base64,/);

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "Nina Patel Pine Harbor billing escalation",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => /escalation-note\.png/i.test(item.title)));
  assert.ok(retrieval.evidence.some((item) => item.reasons.includes("lexical_match")));

  store.close();
});

test("persistTurnReferencedImageUrlsAsDocuments indexes file:// image URLs as first-class artifact trees", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-image-url-memory-");
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
    startedAt: "2026-06-04T10:40:00.000Z",
    completedAt: "2026-06-04T10:40:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the referenced image URL.",
  });

  const treeIds = await persistTurnReferencedImageUrlsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });
  assert.equal(treeIds.length, 1);

  const imageUrlTrees = listWorkspaceImageUrlDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(imageUrlTrees.length, 1);
  assert.equal(imageUrlTrees[0]?.title, "reference.png");

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "reference.png",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => /reference\.png/i.test(item.title)));

  const graph = await buildMemoryBrowserGraph({
    store,
    workspaceId: "workspace-1",
    forest: "workspace",
  });
  assert.ok(graph.nodes.some((node) => node.label === "Artifacts" && node.kind === "section"));
  assert.ok(graph.nodes.some((node) => node.tree_id === imageUrlTrees[0]?.treeId && /reference\.png/i.test(node.label)));

  store.close();
});

test("persistTurnReferencedImageUrlsAsDocuments disambiguates repeated image URLs across separate turns", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-image-url-repeat-memory-");
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
  const imageUrl = pathToFileURL(imageAbsolutePath).toString();

  for (const completedAt of [
    "2026-06-04T10:40:05.000Z",
    "2026-06-04T10:41:05.000Z",
  ]) {
    const queuedInput = store.enqueueInput({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      payload: {
        text: "Keep this referenced image around.",
        image_urls: [imageUrl],
      },
    });
    const turnResult = store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: queuedInput.inputId,
      startedAt: completedAt,
      completedAt,
      status: "completed",
      stopReason: "ok",
      assistantText: "I preserved the referenced image URL.",
    });
    const treeIds = await persistTurnReferencedImageUrlsAsDocuments({
      store,
      turnResult,
      embeddingClient: null,
    });
    assert.equal(treeIds.length, 1);
  }

  const imageUrlTrees = listWorkspaceImageUrlDocumentTrees({
    store,
    workspaceId: "workspace-1",
  }).filter((descriptor) => descriptor.imageUrl === imageUrl);
  assert.equal(imageUrlTrees.length, 2);
  assert.equal(new Set(imageUrlTrees.map((descriptor) => descriptor.path)).size, 2);
  assert.equal(new Set(imageUrlTrees.map((descriptor) => descriptor.sourceTurnInputId)).size, 2);

  const graph = await buildMemoryBrowserGraph({
    store,
    workspaceId: "workspace-1",
    forest: "workspace",
  });
  assert.equal(
    graph.nodes.filter((node) => /reference\.png/i.test(node.label)).length,
    2,
  );

  store.close();
});

test(
  "persistTurnReferencedImageUrlsAsDocuments extracts searchable text from image URLs via macOS Vision OCR",
  { skip: !DARWIN_VISION_OCR_AVAILABLE },
  async () => {
    const { store, workspaceRoot } = makeRuntimeState("hb-workspace-image-url-ocr-memory-");
    seedWorkspace(store);

    const imageRelativePath = "references/escalation-note.png";
    const imageAbsolutePath = path.join(workspaceRoot, "workspace-1", imageRelativePath);
    fs.mkdirSync(path.dirname(imageAbsolutePath), { recursive: true });
    fs.writeFileSync(
      imageAbsolutePath,
      createPngBufferWithText("Nina Patel owns Pine Harbor billing escalation"),
    );

    const queuedInput = store.enqueueInput({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      payload: {
        text: "Keep the fact from this referenced image.",
        image_urls: [pathToFileURL(imageAbsolutePath).toString()],
      },
    });
    const turnResult = store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: queuedInput.inputId,
      startedAt: "2026-06-04T10:45:00.000Z",
      completedAt: "2026-06-04T10:45:05.000Z",
      status: "completed",
      stopReason: "ok",
      assistantText: "I preserved the referenced image URL.",
    });

    const treeIds = await persistTurnReferencedImageUrlsAsDocuments({
      store,
      turnResult,
      embeddingClient: null,
    });
    assert.equal(treeIds.length, 1);

    const retrieval = await retrieveWorkspaceMemory({
      store,
      workspaceId: "workspace-1",
      query: "Nina Patel Pine Harbor billing escalation",
      executionProfile: {
        useEmbeddings: false,
        useLlmRerank: false,
      },
    });
    assert.ok(retrieval.evidence.some((item) => /escalation-note\.png/i.test(item.title)));
    assert.ok(retrieval.evidence.some((item) => item.reasons.includes("lexical_match")));

    store.close();
  },
);

test("persistTurnReferencedImageUrlsAsDocuments extracts searchable text from image URLs via model fallback", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-image-url-model-memory-");
  seedWorkspace(store);

  const imageRelativePath = "references/escalation-note.png";
  const imageAbsolutePath = path.join(workspaceRoot, "workspace-1", imageRelativePath);
  fs.mkdirSync(path.dirname(imageAbsolutePath), { recursive: true });
  fs.writeFileSync(imageAbsolutePath, Buffer.from("not-a-real-png"));

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Keep the fact from this referenced image.",
      image_urls: [pathToFileURL(imageAbsolutePath).toString()],
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T10:46:00.000Z",
    completedAt: "2026-06-04T10:46:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the referenced image URL.",
  });

  let recordedRequestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input, init) => {
    recordedRequestBody =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                extracted_text: "Nina Patel owns Pine Harbor billing escalation",
                summary: "Escalation ownership note.",
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const treeIds = await persistTurnReferencedImageUrlsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
    visionModelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-image",
      modelId: "gpt-4.1-mini",
      apiStyle: "openai_compatible",
    },
  });
  assert.equal(treeIds.length, 1);
  assert.ok(recordedRequestBody);
  const requestBody = recordedRequestBody as Record<string, unknown>;
  const messages = requestBody.messages as Array<Record<string, unknown>>;
  const content = messages[1]?.content as Array<Record<string, unknown>>;
  assert.equal(content[1]?.type, "image_url");

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "Nina Patel Pine Harbor billing escalation",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => /escalation-note\.png/i.test(item.title)));
  assert.ok(retrieval.evidence.some((item) => item.reasons.includes("lexical_match")));

  store.close();
});

test("persistTurnIntegrationToolResultsAsDocuments indexes tool results as first-class artifact trees for retrieval and browser visibility", async () => {
  const { store } = makeRuntimeState("hb-workspace-tool-result-memory-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Use Gmail and preserve the important result.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-03T09:10:00.000Z",
    completedAt: "2026-06-03T09:10:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the key Gmail result.",
  });
  store.appendOutputEvent({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    sequence: 1,
    eventType: "tool_call",
    payload: {
      phase: "completed",
      tool_name: "holaboss_composio.gmail_fetch_emails",
      tool_id: "holaboss_composio.gmail_fetch_emails",
      call_id: "call-gmail-1",
      error: false,
      result: {
        content: [
          {
            type: "text",
            text: "Ben Book at anyIP reached out to the user personally about holaboss and followed up on the same thread.",
          },
        ],
        details: {
          raw: {
            _meta: {
              holaboss_integration_account: {
                provider_id: "gmail",
                connected_account_id: "ca_gmail_primary",
                account_namespace: "ops@example.com",
                connection_id: "conn_gmail_primary",
              },
            },
            thread_id: "thread-1",
            labels: ["INBOX", "IMPORTANT"],
          },
        },
      },
    },
    createdAt: "2026-06-03T09:10:03.000Z",
  });

  const treeIds = await persistTurnIntegrationToolResultsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });
  assert.equal(treeIds.length, 1);

  const toolResultTrees = listWorkspaceToolResultDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(toolResultTrees.length, 1);
  assert.equal(toolResultTrees[0]?.providerId, "gmail");
  assert.equal(toolResultTrees[0]?.accountNamespace, "ops@example.com");

  const treeId = toolResultTrees[0]!.treeId;
  const nodes = store.listSemanticMemoryNodes({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  });
  assert.ok(nodes.some((node) => node.nodeClass === "semantic"));
  assert.ok(nodes.some((node) => node.nodeClass === "leaf"));

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "followed up on the same thread",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => item.tree_id === treeId));
  assert.ok(retrieval.evidence.some((item) => item.account_namespace === "ops@example.com"));

  const browserTree = await buildMemoryBrowserTree({
    store,
    workspaceId: "workspace-1",
  });
  const workspaceDirectory = (browserTree.root.children ?? []).find((child) => child.name === "workspace");
  const artifactsDirectory = (workspaceDirectory?.children ?? []).find((child) => child.name === "artifacts");
  const toolResultsDirectory = (artifactsDirectory?.children ?? []).find((child) => child.name === "tool-results");
  assert.ok(toolResultsDirectory && toolResultsDirectory.kind === "directory");

  const graph = await buildMemoryBrowserGraph({
    store,
    workspaceId: "workspace-1",
    forest: "workspace",
  });
  assert.ok(graph.nodes.some((node) => node.label === "Artifacts" && node.kind === "section"));
  assert.ok(
    graph.nodes.some((node) =>
      node.tree_id === treeId
      && /gmail_fetch_emails result/i.test(node.label),
    ),
  );

  store.close();
});

test("persistTurnIntegrationToolResultsAsDocuments stores related-entity relations on artifact roots", async () => {
  const { store } = makeRuntimeState("hb-workspace-tool-result-relations-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Preserve the Gmail result and its related contacts.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T11:00:00.000Z",
    completedAt: "2026-06-04T11:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the Gmail result.",
  });
  store.appendOutputEvent({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    sequence: 1,
    eventType: "tool_call",
    payload: {
      phase: "completed",
      tool_name: "holaboss_composio.gmail_fetch_emails",
      tool_id: "holaboss_composio.gmail_fetch_emails",
      call_id: "call-gmail-related-1",
      error: false,
      result: {
        content: [
          {
            type: "text",
            text: "Ben Book at anyIP reached out again and asked for an escalation owner.",
          },
        ],
        details: {
          raw: {
            _meta: {
              holaboss_integration_account: {
                provider_id: "gmail",
                connected_account_id: "ca_gmail_primary",
                account_namespace: "ops@example.com",
                connection_id: "conn_gmail_primary",
              },
            },
          },
        },
      },
    },
    createdAt: "2026-06-04T11:00:03.000Z",
  });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                related_entities: [
                  { entity_type: "person", label: "Ben Book" },
                  { entity_type: "organization", label: "anyIP" },
                ],
                relations: [
                  { relation_type: "contacted_by", entity_type: "person", entity_label: "Ben Book" },
                  { relation_type: "works_at", entity_type: "organization", entity_label: "anyIP" },
                ],
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as typeof fetch;

  const treeIds = await persistTurnIntegrationToolResultsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
    relatedInfoModelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-related",
      modelId: "gpt-4.1-mini",
      apiStyle: "openai_compatible",
    },
  });
  assert.equal(treeIds.length, 1);

  const relations = store.listSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: treeIds[0]!,
    limit: 100,
  });
  assert.ok(relations.some((relation) => relation.relationType === "contacted_by"));
  assert.ok(relations.some((relation) => relation.metadata?.entity_label === "Ben Book"));

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "Ben Book",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => item.tree_id === treeIds[0]));

  const graph = await buildMemoryBrowserGraph({
    store,
    workspaceId: "workspace-1",
    forest: "workspace",
  });
  assert.ok(graph.nodes.some((node) => node.id === "semantic:related:person:ben-book"));
  assert.ok(graph.edges.some((edge) => edge.kind === "reference" && edge.to === "semantic:related:person:ben-book"));

  store.close();
});

test("ensureWorkspaceArtifactRelationsBackfilled restores cleared tool-result artifact relations from stored markdown", async () => {
  const { store } = makeRuntimeState("hb-workspace-tool-result-relation-backfill-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Preserve the Gmail result and keep the related contact discoverable.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T11:20:00.000Z",
    completedAt: "2026-06-04T11:20:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the Gmail result.",
  });
  store.appendOutputEvent({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    sequence: 1,
    eventType: "tool_call",
    payload: {
      phase: "completed",
      tool_name: "holaboss_composio.gmail_fetch_emails",
      tool_id: "holaboss_composio.gmail_fetch_emails",
      call_id: "call-gmail-backfill-1",
      error: false,
      result: {
        content: [
          {
            type: "text",
            text: "Ben Book at anyIP reached out again about holaboss.",
          },
        ],
        details: {
          raw: {
            _meta: {
              holaboss_integration_account: {
                provider_id: "gmail",
                connected_account_id: "ca_gmail_primary",
                account_namespace: "ops@example.com",
                connection_id: "conn_gmail_primary",
              },
            },
          },
        },
      },
    },
    createdAt: "2026-06-04T11:20:03.000Z",
  });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                related_entities: [
                  { entity_type: "person", label: "Ben Book" },
                ],
                relations: [
                  { relation_type: "contacted_by", entity_type: "person", entity_label: "Ben Book" },
                ],
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as typeof fetch;

  const treeIds = await persistTurnIntegrationToolResultsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
    relatedInfoModelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-related",
      modelId: "gpt-4.1-mini",
      apiStyle: "openai_compatible",
    },
  });
  const treeId = treeIds[0]!;
  assert.ok(
    store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId,
      limit: 100,
    }).some((relation) => relation.relationType === "contacted_by"),
  );

  store.syncSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId,
    relations: [],
  });
  assert.equal(
    store.listSemanticMemoryRelations({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId,
      limit: 100,
    }).length,
    0,
  );

  ensureWorkspaceArtifactRelationsBackfilled({
    store,
    workspaceId: "workspace-1",
  });

  const restoredRelations = store.listSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId,
    limit: 100,
  });
  assert.ok(restoredRelations.some((relation) => relation.relationType === "contacted_by"));
  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_artifact_relation_backfill_v1_complete",
    }),
    "true",
  );

  store.close();
});

test("ensureWorkspaceArtifactRelationsBackfilled backfills missing output artifact trees from legacy output rows", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-output-tree-backfill-");
  seedWorkspace(store);

  const reportRelativePath = "outputs/reports/legacy-deliverable.md";
  const reportAbsolutePath = path.join(workspaceRoot, "workspace-1", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# Legacy Deliverable",
      "",
      "Ben Book at anyIP documented the durable rollout follow-up in this legacy output.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-legacy-1",
    outputType: "document",
    title: "legacy-deliverable.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: "input-legacy-1",
    artifactId: "artifact-legacy-1",
    metadata: {
      origin_type: "forwarded_subagent",
      source_subagent_id: "subagent-legacy-1",
      source_event_id: "event-legacy-1",
    },
  });

  assert.equal(
    listWorkspaceOutputDocumentTrees({
      store,
      workspaceId: "workspace-1",
    }).length,
    0,
  );

  ensureWorkspaceArtifactRelationsBackfilled({
    store,
    workspaceId: "workspace-1",
  });

  const outputTrees = listWorkspaceOutputDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(outputTrees.length, 1);
  assert.equal(outputTrees[0]?.outputId, "output-legacy-1");
  assert.equal(outputTrees[0]?.title, "legacy-deliverable.md");

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "durable rollout follow-up",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => item.tree_id === outputTrees[0]?.treeId));

  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_output_artifact_tree_backfill_v1_complete",
    }),
    "true",
  );
  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_artifact_relation_backfill_v1_complete",
    }),
    "true",
  );

  store.close();
});

test("ensureWorkspaceArtifactRelationsBackfilled backfills missing attachment artifact trees from legacy turn inputs", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-attachment-tree-backfill-");
  seedWorkspace(store);

  const attachmentRelativePath = ".holaboss/input-attachments/batch-legacy/personal-outreach.html";
  const attachmentAbsolutePath = path.join(
    workspaceRoot,
    "workspace-1",
    ".holaboss",
    "input-attachments",
    "batch-legacy",
    "personal-outreach.html",
  );
  fs.mkdirSync(path.dirname(attachmentAbsolutePath), { recursive: true });
  fs.writeFileSync(
    attachmentAbsolutePath,
    [
      "<html><body>",
      "<h1>Personal Outreach</h1>",
      "<p>Ben Book at anyIP emailed the user personally about holaboss.</p>",
      "</body></html>",
    ].join(""),
    "utf8",
  );

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Keep this attachment around.",
      attachments: [
        {
          id: "att-legacy-1",
          kind: "file",
          name: "personal-outreach.html",
          mime_type: "text/html",
          size_bytes: 256,
          workspace_path: attachmentRelativePath,
        },
      ],
    },
  });
  store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T12:00:00.000Z",
    completedAt: "2026-06-04T12:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Saved for later.",
  });

  assert.equal(
    listWorkspaceAttachmentDocumentTrees({
      store,
      workspaceId: "workspace-1",
    }).length,
    0,
  );
  store.setWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: "workspace_artifact_relation_backfill_v1_complete",
    value: "true",
  });

  ensureWorkspaceArtifactRelationsBackfilled({
    store,
    workspaceId: "workspace-1",
  });

  const attachmentTrees = listWorkspaceAttachmentDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(attachmentTrees.length, 1);
  assert.equal(attachmentTrees[0]?.attachmentId, "att-legacy-1");
  assert.equal(attachmentTrees[0]?.title, "personal-outreach.html");

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "emailed the user personally about holaboss",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => item.tree_id === attachmentTrees[0]?.treeId));

  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_attachment_artifact_tree_backfill_v1_complete",
    }),
    "true",
  );
  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_artifact_relation_backfill_v1_complete",
    }),
    "true",
  );

  store.close();
});

test("ensureWorkspaceArtifactRelationsBackfilled backfills missing referenced-image artifact trees from legacy turn inputs", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-image-url-tree-backfill-");
  seedWorkspace(store);

  const imageRelativePath = "images/legacy-reference.png";
  const imageAbsolutePath = path.join(workspaceRoot, "workspace-1", imageRelativePath);
  fs.mkdirSync(path.dirname(imageAbsolutePath), { recursive: true });
  fs.writeFileSync(
    imageAbsolutePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sVxubUAAAAASUVORK5CYII=",
      "base64",
    ),
  );

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Keep this referenced image for later.",
      image_urls: [pathToFileURL(imageAbsolutePath).toString()],
    },
  });
  store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T12:05:00.000Z",
    completedAt: "2026-06-04T12:05:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "Saved the referenced image.",
  });

  assert.equal(
    listWorkspaceImageUrlDocumentTrees({
      store,
      workspaceId: "workspace-1",
    }).length,
    0,
  );
  store.setWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: "workspace_artifact_relation_backfill_v1_complete",
    value: "true",
  });

  ensureWorkspaceArtifactRelationsBackfilled({
    store,
    workspaceId: "workspace-1",
  });

  const imageUrlTrees = listWorkspaceImageUrlDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(imageUrlTrees.length, 1);
  assert.match(imageUrlTrees[0]?.title ?? "", /legacy-reference\.png/i);

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "legacy-reference.png",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => item.tree_id === imageUrlTrees[0]?.treeId));

  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_image_url_artifact_tree_backfill_v1_complete",
    }),
    "true",
  );
  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_artifact_relation_backfill_v1_complete",
    }),
    "true",
  );

  store.close();
});

test("ensureWorkspaceArtifactRelationsBackfilled backfills missing tool-result artifact trees from legacy completed turns", async () => {
  const { store } = makeRuntimeState("hb-workspace-tool-result-tree-backfill-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Keep the Gmail result searchable.",
    },
  });
  store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T12:10:00.000Z",
    completedAt: "2026-06-04T12:10:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I saved the Gmail result.",
  });
  store.appendOutputEvent({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    sequence: 1,
    eventType: "tool_call",
    payload: {
      phase: "completed",
      tool_name: "holaboss_composio.gmail_fetch_emails",
      tool_id: "holaboss_composio.gmail_fetch_emails",
      call_id: "call-gmail-legacy-tree-1",
      error: false,
      result: {
        content: [
          {
            type: "text",
            text: "Ben Book at anyIP emailed ops@example.com about the durable rollout.",
          },
        ],
        details: {
          raw: {
            _meta: {
              holaboss_integration_account: {
                provider_id: "gmail",
                connected_account_id: "ca_gmail_primary",
                account_namespace: "ops@example.com",
                connection_id: "conn_gmail_primary",
              },
            },
          },
        },
      },
    },
    createdAt: "2026-06-04T12:10:03.000Z",
  });

  assert.equal(
    listWorkspaceToolResultDocumentTrees({
      store,
      workspaceId: "workspace-1",
    }).length,
    0,
  );

  ensureWorkspaceArtifactRelationsBackfilled({
    store,
    workspaceId: "workspace-1",
  });

  const toolResultTrees = listWorkspaceToolResultDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(toolResultTrees.length, 1);
  assert.equal(toolResultTrees[0]?.providerId, "gmail");
  assert.equal(toolResultTrees[0]?.accountNamespace, "ops@example.com");
  assert.equal(toolResultTrees[0]?.callId, "call-gmail-legacy-tree-1");

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "durable rollout",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => item.tree_id === toolResultTrees[0]?.treeId));

  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_tool_result_artifact_tree_backfill_v1_complete",
    }),
    "true",
  );
  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_artifact_relation_backfill_v1_complete",
    }),
    "true",
  );

  store.close();
});

test("persistTurnOutputArtifactsAsDocuments indexes current-turn outputs as first-class artifact trees for retrieval and browser visibility", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-output-memory-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Preserve the subagent report as a first-class deliverable.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-03T09:20:00.000Z",
    completedAt: "2026-06-03T09:20:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the subagent report.",
  });

  const reportRelativePath = "outputs/reports/build-fix-report.md";
  const reportAbsolutePath = path.join(workspaceRoot, "workspace-1", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# Build Fix Report",
      "",
      "Ben Book at anyIP confirmed the fix and the subagent documented the durable follow-up.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-1",
    outputType: "document",
    title: "build-fix-report.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    artifactId: "artifact-1",
    metadata: {
      origin_type: "forwarded_subagent",
      source_subagent_id: "subagent-1",
      source_event_id: "event-1",
    },
  });

  const treeIds = await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });
  assert.equal(treeIds.length, 1);

  const outputTrees = listWorkspaceOutputDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(outputTrees.length, 1);
  assert.equal(outputTrees[0]?.title, "build-fix-report.md");
  assert.equal(outputTrees[0]?.filePath, reportRelativePath);

  const treeId = outputTrees[0]!.treeId;
  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "documented the durable follow-up",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => item.tree_id === treeId));

  const browserTree = await buildMemoryBrowserTree({
    store,
    workspaceId: "workspace-1",
  });
  const workspaceDirectory = (browserTree.root.children ?? []).find((child) => child.name === "workspace");
  const artifactsDirectory = (workspaceDirectory?.children ?? []).find((child) => child.name === "artifacts");
  const outputsDirectory = (artifactsDirectory?.children ?? []).find((child) => child.name === "outputs");
  assert.ok(outputsDirectory && outputsDirectory.kind === "directory");

  const graph = await buildMemoryBrowserGraph({
    store,
    workspaceId: "workspace-1",
    forest: "workspace",
  });
  assert.ok(graph.nodes.some((node) => node.label === "Artifacts" && node.kind === "section"));
  assert.ok(graph.nodes.some((node) => node.tree_id === treeId && /build-fix-report\.md/i.test(node.label)));

  store.close();
});

test("artifactContextsForSourceTurnInput prioritizes forwarded outputs ahead of same-turn tool results", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-artifact-context-priority-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Preserve the teammate deliverable and the Gmail evidence behind it.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T12:30:00.000Z",
    completedAt: "2026-06-04T12:30:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the deliverable and underlying Gmail evidence.",
  });

  for (let index = 0; index < 5; index += 1) {
    store.appendOutputEvent({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: queuedInput.inputId,
      sequence: index + 1,
      eventType: "tool_call",
      payload: {
        phase: "completed",
        tool_name: "holaboss_composio.gmail_fetch_emails",
        tool_id: "holaboss_composio.gmail_fetch_emails",
        call_id: `call-gmail-priority-${index + 1}`,
        error: false,
        result: {
          content: [
            {
              type: "text",
              text: `Gmail result ${index + 1} captured outreach evidence for Ben Book at anyIP.`,
            },
          ],
          details: {
            raw: {
              _meta: {
                holaboss_integration_account: {
                  provider_id: "gmail",
                  connected_account_id: "ca_gmail_primary",
                  account_namespace: "ops@example.com",
                  connection_id: "conn_gmail_primary",
                },
              },
            },
          },
        },
      },
      createdAt: `2026-06-04T12:30:0${index}.000Z`,
    });
  }

  const reportRelativePath = "outputs/reports/priority-deliverable.md";
  const reportAbsolutePath = path.join(workspaceRoot, "workspace-1", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# Priority Deliverable",
      "",
      "Ben Book at anyIP needs a named outreach owner and this report is the forwarded deliverable.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-priority-1",
    outputType: "document",
    title: "priority-deliverable.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    artifactId: "artifact-priority-1",
    metadata: {
      origin_type: "forwarded_subagent",
      source_subagent_id: "subagent-priority-1",
      source_event_id: "event-priority-1",
    },
  });

  await persistTurnIntegrationToolResultsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });
  await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });

  const contexts = artifactContextsForSourceTurnInput({
    store,
    workspaceId: "workspace-1",
    sourceTurnInputId: queuedInput.inputId,
  });

  assert.equal(contexts.length, 6);
  assert.equal(contexts[0]?.sourceKind, "output_artifact");
  assert.equal(contexts[0]?.title, "priority-deliverable.md");
  assert.ok(contexts.slice(0, 4).some((context) => context.sourceKind === "output_artifact"));
  assert.deepEqual(
    contexts.slice(1).map((context) => context.sourceKind),
    ["tool_result", "tool_result", "tool_result", "tool_result", "tool_result"],
  );

  store.close();
});

test("artifactContextsForSourceTurnInput keeps forwarded deliverables inside the output slice when many same-turn outputs exist", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-artifact-context-output-slice-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Preserve the teammate deliverable even if the turn emitted many outputs.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T12:40:00.000Z",
    completedAt: "2026-06-04T12:40:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the teammate deliverable and the other outputs.",
  });

  for (let index = 0; index < 6; index += 1) {
    const relativePath = `outputs/reports/alpha-${index + 1}.md`;
    const absolutePath = path.join(workspaceRoot, "workspace-1", relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      [
        `# Alpha Output ${index + 1}`,
        "",
        `This is incidental output ${index + 1}.`,
      ].join("\n"),
      "utf8",
    );
    store.createOutput({
      workspaceId: "workspace-1",
      outputId: `output-alpha-${index + 1}`,
      outputType: "document",
      title: `alpha-${index + 1}.md`,
      status: "completed",
      filePath: relativePath,
      sessionId: "session-main",
      inputId: queuedInput.inputId,
      artifactId: `artifact-alpha-${index + 1}`,
    });
  }

  const reportRelativePath = "outputs/reports/zz-team-deliverable.md";
  const reportAbsolutePath = path.join(workspaceRoot, "workspace-1", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# Team Deliverable",
      "",
      "This forwarded teammate deliverable must stay inside the shared artifact context slice.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-forwarded-priority",
    outputType: "document",
    title: "zz-team-deliverable.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    artifactId: "artifact-forwarded-priority",
    metadata: {
      origin_type: "forwarded_subagent",
      source_subagent_id: "subagent-forwarded-priority",
      source_event_id: "event-forwarded-priority",
    },
  });

  await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });

  const contexts = artifactContextsForSourceTurnInput({
    store,
    workspaceId: "workspace-1",
    sourceTurnInputId: queuedInput.inputId,
  });

  assert.equal(contexts.length, 6);
  assert.equal(contexts[0]?.sourceKind, "output_artifact");
  assert.equal(contexts[0]?.title, "zz-team-deliverable.md");
  assert.ok(contexts.some((context) =>
    context.sourceKind === "output_artifact" && context.title === "zz-team-deliverable.md",
  ));
  assert.equal(
    contexts.filter((context) => context.sourceKind === "output_artifact" && context.title.startsWith("alpha-")).length,
    5,
  );

  store.close();
});

test("artifactContextsForSourceTurnInput prioritizes latest same-turn tool results within the tool-result slice", async () => {
  const { store } = makeRuntimeState("hb-workspace-artifact-context-tool-result-order-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Preserve the latest Gmail tool results for durable memory extraction.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T12:50:00.000Z",
    completedAt: "2026-06-04T12:50:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the Gmail tool results.",
  });

  for (let index = 0; index < 7; index += 1) {
    store.appendOutputEvent({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: queuedInput.inputId,
      sequence: index + 1,
      eventType: "tool_call",
      payload: {
        phase: "completed",
        tool_name: "holaboss_composio.gmail_fetch_emails",
        tool_id: "holaboss_composio.gmail_fetch_emails",
        call_id: `call-gmail-latest-${index + 1}`,
        error: false,
        result: {
          content: [
            {
              type: "text",
              text: `Gmail result ${index + 1} captured outreach evidence.`,
            },
          ],
          details: {
            raw: {
              _meta: {
                holaboss_integration_account: {
                  provider_id: "gmail",
                  connected_account_id: "ca_gmail_primary",
                  account_namespace: "ops@example.com",
                  connection_id: "conn_gmail_primary",
                },
              },
            },
          },
        },
      },
      createdAt: `2026-06-04T12:50:0${index}.000Z`,
    });
  }

  await persistTurnIntegrationToolResultsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });

  const contexts = artifactContextsForSourceTurnInput({
    store,
    workspaceId: "workspace-1",
    sourceTurnInputId: queuedInput.inputId,
  });

  assert.equal(contexts.length, 6);
  assert.ok(contexts.every((context) => context.sourceKind === "tool_result"));
  assert.deepEqual(
    contexts.map((context) => context.canonicalEntityKey),
    [
      "artifact:tool-result:gmail:call-gmail-latest-7",
      "artifact:tool-result:gmail:call-gmail-latest-6",
      "artifact:tool-result:gmail:call-gmail-latest-5",
      "artifact:tool-result:gmail:call-gmail-latest-4",
      "artifact:tool-result:gmail:call-gmail-latest-3",
      "artifact:tool-result:gmail:call-gmail-latest-2",
    ],
  );
  assert.ok(!contexts.some((context) =>
    context.canonicalEntityKey === "artifact:tool-result:gmail:call-gmail-latest-1",
  ));

  store.close();
});

test("artifactContextsForSourceTurnInput preserves original attachment input order within the attachment slice", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-artifact-context-attachment-order-");
  seedWorkspace(store);

  const attachments = [
    {
      id: "att-order-1",
      kind: "file" as const,
      name: "zeta-brief-1.txt",
      mime_type: "text/plain",
      size_bytes: 32,
      workspace_path: ".holaboss/input-attachments/batch-order/zeta-brief-1.txt",
    },
    {
      id: "att-order-2",
      kind: "file" as const,
      name: "yankee-brief-2.txt",
      mime_type: "text/plain",
      size_bytes: 32,
      workspace_path: ".holaboss/input-attachments/batch-order/yankee-brief-2.txt",
    },
    {
      id: "att-order-3",
      kind: "file" as const,
      name: "xray-brief-3.txt",
      mime_type: "text/plain",
      size_bytes: 32,
      workspace_path: ".holaboss/input-attachments/batch-order/xray-brief-3.txt",
    },
    {
      id: "att-order-4",
      kind: "file" as const,
      name: "whiskey-brief-4.txt",
      mime_type: "text/plain",
      size_bytes: 32,
      workspace_path: ".holaboss/input-attachments/batch-order/whiskey-brief-4.txt",
    },
    {
      id: "att-order-5",
      kind: "file" as const,
      name: "victor-brief-5.txt",
      mime_type: "text/plain",
      size_bytes: 32,
      workspace_path: ".holaboss/input-attachments/batch-order/victor-brief-5.txt",
    },
    {
      id: "att-order-6",
      kind: "file" as const,
      name: "uniform-brief-6.txt",
      mime_type: "text/plain",
      size_bytes: 32,
      workspace_path: ".holaboss/input-attachments/batch-order/uniform-brief-6.txt",
    },
    {
      id: "att-order-7",
      kind: "file" as const,
      name: "alpha-brief-7.txt",
      mime_type: "text/plain",
      size_bytes: 32,
      workspace_path: ".holaboss/input-attachments/batch-order/alpha-brief-7.txt",
    },
  ];

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Keep the first attachments in the same order the user supplied them.",
      attachments,
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T13:00:00.000Z",
    completedAt: "2026-06-04T13:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the attachments.",
  });

  for (const attachment of attachments) {
    const relativePath = attachment.workspace_path;
    const absolutePath = path.join(workspaceRoot, "workspace-1", relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      `Attachment ${attachment.id} mentions Ben Book and anyIP.`,
      "utf8",
    );
  }

  await persistTurnInputAttachmentsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });

  const contexts = artifactContextsForSourceTurnInput({
    store,
    workspaceId: "workspace-1",
    sourceTurnInputId: queuedInput.inputId,
  });

  assert.equal(contexts.length, 6);
  assert.ok(contexts.every((context) => context.sourceKind === "attachment"));
  assert.deepEqual(
    contexts.map((context) => context.title),
    [
      "zeta-brief-1.txt",
      "yankee-brief-2.txt",
      "xray-brief-3.txt",
      "whiskey-brief-4.txt",
      "victor-brief-5.txt",
      "uniform-brief-6.txt",
    ],
  );
  assert.ok(!contexts.some((context) => context.title === "alpha-brief-7.txt"));

  store.close();
});

test("artifactContextsForSourceTurnInput preserves original image URL order within the image slice", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-artifact-context-image-order-");
  seedWorkspace(store);

  const imageRelativePaths = [
    "references/zeta-ref-1.png",
    "references/yankee-ref-2.png",
    "references/xray-ref-3.png",
    "references/whiskey-ref-4.png",
    "references/victor-ref-5.png",
    "references/uniform-ref-6.png",
    "references/alpha-ref-7.png",
  ];
  const imageUrls = imageRelativePaths.map((relativePath) => {
    const absolutePath = path.join(workspaceRoot, "workspace-1", relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z9WQAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    return pathToFileURL(absolutePath).toString();
  });

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Keep the referenced images in the same order the user supplied them.",
      image_urls: imageUrls,
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T13:05:00.000Z",
    completedAt: "2026-06-04T13:05:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the referenced images.",
  });

  await persistTurnReferencedImageUrlsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });

  const contexts = artifactContextsForSourceTurnInput({
    store,
    workspaceId: "workspace-1",
    sourceTurnInputId: queuedInput.inputId,
  });

  assert.equal(contexts.length, 6);
  assert.ok(contexts.every((context) => context.sourceKind === "image_url"));
  assert.deepEqual(
    contexts.map((context) => context.title),
    [
      "zeta-ref-1.png",
      "yankee-ref-2.png",
      "xray-ref-3.png",
      "whiskey-ref-4.png",
      "victor-ref-5.png",
      "uniform-ref-6.png",
    ],
  );
  assert.ok(!contexts.some((context) => context.title === "alpha-ref-7.png"));

  store.close();
});

test("ensureWorkspaceArtifactRelationsBackfilled repairs missing legacy attachment and image input positions", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-artifact-context-legacy-position-repair-");
  seedWorkspace(store);

  const attachments = [
    {
      id: "att-legacy-1",
      kind: "file" as const,
      name: "zeta-legacy-1.txt",
      mime_type: "text/plain",
      size_bytes: 32,
      workspace_path: ".holaboss/input-attachments/legacy-order/zeta-legacy-1.txt",
    },
    {
      id: "att-legacy-2",
      kind: "file" as const,
      name: "yankee-legacy-2.txt",
      mime_type: "text/plain",
      size_bytes: 32,
      workspace_path: ".holaboss/input-attachments/legacy-order/yankee-legacy-2.txt",
    },
    {
      id: "att-legacy-3",
      kind: "file" as const,
      name: "alpha-legacy-3.txt",
      mime_type: "text/plain",
      size_bytes: 32,
      workspace_path: ".holaboss/input-attachments/legacy-order/alpha-legacy-3.txt",
    },
  ];
  for (const attachment of attachments) {
    const absolutePath = path.join(workspaceRoot, "workspace-1", attachment.workspace_path);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, `Attachment ${attachment.id} mentions Ben Book.`, "utf8");
  }

  const imageRelativePaths = [
    "references/zeta-legacy-1.png",
    "references/yankee-legacy-2.png",
    "references/alpha-legacy-3.png",
  ];
  const imageUrls = imageRelativePaths.map((relativePath) => {
    const absolutePath = path.join(workspaceRoot, "workspace-1", relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z9WQAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    return pathToFileURL(absolutePath).toString();
  });

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Preserve legacy artifact order.",
      attachments,
      image_urls: imageUrls,
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T13:10:00.000Z",
    completedAt: "2026-06-04T13:10:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the legacy artifact order.",
  });

  await persistTurnInputAttachmentsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });
  await persistTurnReferencedImageUrlsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });

  const attachmentDescriptors = listWorkspaceAttachmentDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  const imageDescriptors = listWorkspaceImageUrlDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });

  for (const descriptor of [...attachmentDescriptors, ...imageDescriptors]) {
    const rootNode = store.getSemanticMemoryNode({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: descriptor.treeId,
      nodeId: descriptor.rootNodeId,
    });
    assert.ok(rootNode);
    const metadata = rootNode.metadata && typeof rootNode.metadata === "object" && !Array.isArray(rootNode.metadata)
      ? { ...rootNode.metadata as Record<string, unknown> }
      : {};
    delete metadata.source_turn_input_position;
    store.upsertSemanticMemoryNode({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: rootNode.treeId,
      nodeId: rootNode.nodeId,
      nodeClass: rootNode.nodeClass,
      nodeKind: rootNode.nodeKind,
      sourceLeafId: rootNode.sourceLeafId,
      path: rootNode.path,
      title: rootNode.title,
      summary: rootNode.summary,
      bodySha256: rootNode.bodySha256,
      childCount: rootNode.childCount,
      observedAt: rootNode.observedAt,
      status: rootNode.status,
      isMaterialized: rootNode.isMaterialized,
      metadata,
      createdAt: rootNode.createdAt,
      updatedAt: rootNode.updatedAt,
    });
  }

  store.setWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: "workspace_artifact_relation_backfill_v1_complete",
    value: "true",
  });
  store.setWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: "workspace_artifact_relation_backfill_v2_complete",
    value: "true",
  });
  store.setWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: "workspace_tool_result_artifact_tree_backfill_v1_complete",
    value: "true",
  });
  store.setWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: "workspace_attachment_artifact_tree_backfill_v1_complete",
    value: "true",
  });
  store.setWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: "workspace_image_url_artifact_tree_backfill_v1_complete",
    value: "true",
  });
  store.setWorkspaceRuntimeMetadata({
    workspaceId: "workspace-1",
    key: "workspace_output_artifact_tree_backfill_v1_complete",
    value: "true",
  });

  const contextsBeforeRepair = artifactContextsForSourceTurnInput({
    store,
    workspaceId: "workspace-1",
    sourceTurnInputId: queuedInput.inputId,
  });
  assert.deepEqual(
    contextsBeforeRepair.filter((context) => context.sourceKind === "attachment").map((context) => context.title),
    ["zeta-legacy-1.txt", "yankee-legacy-2.txt", "alpha-legacy-3.txt"],
  );
  assert.deepEqual(
    contextsBeforeRepair.filter((context) => context.sourceKind === "image_url").map((context) => context.title),
    ["zeta-legacy-1.png", "yankee-legacy-2.png", "alpha-legacy-3.png"],
  );

  ensureWorkspaceArtifactRelationsBackfilled({
    store,
    workspaceId: "workspace-1",
  });

  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_artifact_source_turn_input_position_backfill_v1_complete",
    }),
    "true",
  );

  for (const [index, descriptor] of attachmentDescriptors
    .sort((left, right) => attachments.findIndex((item) => item.id === left.attachmentId)
      - attachments.findIndex((item) => item.id === right.attachmentId))
    .entries()) {
    const rootNode = store.getSemanticMemoryNode({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: descriptor.treeId,
      nodeId: descriptor.rootNodeId,
    });
    assert.equal(rootNode?.metadata?.source_turn_input_position, index);
  }
  for (const [index, descriptor] of imageDescriptors
    .sort((left, right) => imageUrls.findIndex((item) => item === left.imageUrl)
      - imageUrls.findIndex((item) => item === right.imageUrl))
    .entries()) {
    const rootNode = store.getSemanticMemoryNode({
      category: "workspace",
      workspaceId: "workspace-1",
      treeId: descriptor.treeId,
      nodeId: descriptor.rootNodeId,
    });
    assert.equal(rootNode?.metadata?.source_turn_input_position, index);
  }

  store.close();
});

test("persistTurnOutputArtifactsAsDocuments preserves content-derived related-entity relations after output relation sync", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-output-relations-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Preserve the outreach deliverable and its related contacts.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T11:10:00.000Z",
    completedAt: "2026-06-04T11:10:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the outreach deliverable.",
  });

  const reportRelativePath = "outputs/reports/outreach-escalation.md";
  const reportAbsolutePath = path.join(workspaceRoot, "workspace-1", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# Outreach Escalation",
      "",
      "Ben Book at anyIP needs a named escalation owner for the holaboss rollout.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-related-1",
    outputType: "document",
    title: "outreach-escalation.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    artifactId: "artifact-related-1",
    metadata: {
      origin_type: "forwarded_subagent",
      source_subagent_id: "subagent-related-1",
      source_event_id: "event-related-1",
    },
  });

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                related_entities: [
                  { entity_type: "person", label: "Ben Book" },
                  { entity_type: "organization", label: "anyIP" },
                ],
                relations: [
                  { relation_type: "contacted_by", entity_type: "person", entity_label: "Ben Book" },
                  { relation_type: "works_at", entity_type: "organization", entity_label: "anyIP" },
                ],
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as typeof fetch;

  const treeIds = await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
    relatedInfoModelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-related",
      modelId: "gpt-4.1-mini",
      apiStyle: "openai_compatible",
    },
  });
  assert.equal(treeIds.length, 1);

  const relations = store.listSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: treeIds[0]!,
    limit: 100,
  });
  assert.ok(relations.some((relation) => relation.relationType === "contacted_by"));
  assert.ok(relations.some((relation) => relation.metadata?.entity_label === "Ben Book"));

  const graph = await buildMemoryBrowserGraph({
    store,
    workspaceId: "workspace-1",
    forest: "workspace",
  });
  assert.ok(graph.nodes.some((node) => node.id === "semantic:related:person:ben-book"));
  assert.ok(graph.edges.some((edge) => edge.kind === "reference" && edge.to === "semantic:related:person:ben-book"));

  store.close();
});

test("syncWorkspaceArtifactRelations keeps stored output artifact placeholder keys attached to the current artifact tree when titles collide", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-output-artifact-collision-");
  seedWorkspace(store);

  const olderInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Persist the older status report.",
    },
  });
  const olderTurn = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: olderInput.inputId,
    startedAt: "2026-06-03T09:20:00.000Z",
    completedAt: "2026-06-03T09:20:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the older status report.",
  });

  const olderRelativePath = "outputs/reports/status-report-older.md";
  const olderAbsolutePath = path.join(workspaceRoot, "workspace-1", olderRelativePath);
  fs.mkdirSync(path.dirname(olderAbsolutePath), { recursive: true });
  fs.writeFileSync(
    olderAbsolutePath,
    [
      "# Status Report",
      "",
      "This is the older status report.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-older",
    outputType: "document",
    title: "status-report.md",
    status: "completed",
    filePath: olderRelativePath,
    sessionId: "session-main",
    inputId: olderInput.inputId,
    artifactId: "artifact-older",
  });
  await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult: olderTurn,
    embeddingClient: null,
  });

  const newerInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Persist the newer status report.",
    },
  });
  const newerTurn = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: newerInput.inputId,
    startedAt: "2026-06-04T09:20:00.000Z",
    completedAt: "2026-06-04T09:20:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the newer status report.",
  });

  const newerRelativePath = "outputs/reports/status-report-newer.md";
  const newerAbsolutePath = path.join(workspaceRoot, "workspace-1", newerRelativePath);
  fs.mkdirSync(path.dirname(newerAbsolutePath), { recursive: true });
  fs.writeFileSync(
    newerAbsolutePath,
    [
      "# Status Report",
      "",
      "This is the newer status report.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-newer",
    outputType: "document",
    title: "status-report.md",
    status: "completed",
    filePath: newerRelativePath,
    sessionId: "session-main",
    inputId: newerInput.inputId,
    artifactId: "artifact-newer",
  });
  await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult: newerTurn,
    embeddingClient: null,
  });

  const outputTrees = listWorkspaceOutputDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  const olderTree = outputTrees.find((item) => item.outputId === "output-older");
  const newerTree = outputTrees.find((item) => item.outputId === "output-newer");
  assert.ok(olderTree);
  assert.ok(newerTree);

  const olderRootPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    olderTree!.path,
  );
  fs.writeFileSync(
    olderRootPath,
    appendDurableMemoryRelatedSections(
      [
        "# Status Report",
        "",
        "## Summary",
        "",
        "This report should remain attached to the original artifact tree.",
      ].join("\n"),
      {
        relatedEntities: [
          {
            entityType: "artifact",
            entityKey: "artifact:.-status-report.md",
            label: "./status-report.md",
          },
        ],
        relations: [
          {
            relationType: "derived_from",
            entityKey: "artifact:.-status-report.md",
          },
        ],
      },
    ),
    "utf8",
  );

  store.syncSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: olderTree!.treeId,
    relations: [],
  });

  syncWorkspaceArtifactRelations({
    store,
    workspaceId: "workspace-1",
  });

  const relations = store.listSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: olderTree!.treeId,
    limit: 100,
  });
  assert.ok(relations.some((relation) =>
    relation.relationType === "derived_from"
    && relation.metadata.entity_key === "artifact:output:output-older"
    && relation.metadata.target_tree_id === olderTree!.treeId
    && relation.toNodeId === olderTree!.rootNodeId,
  ));
  assert.ok(!relations.some((relation) =>
    relation.relationType === "derived_from"
    && relation.metadata.entity_key === "artifact:output:output-newer",
  ));
  const repairedBody = fs.readFileSync(olderRootPath, "utf8");
  assert.match(repairedBody, /`artifact:output:output-older` \| status-report\.md/);
  assert.doesNotMatch(repairedBody, /`artifact:\.-status-report\.md` \| \.\/status-report\.md/);

  store.close();
});

test("ensureWorkspaceArtifactRelationsBackfilled reruns artifact relation repair when legacy v1 markers are already complete", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-artifact-relation-backfill-upgrade-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Preserve the notion report.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-05T09:40:00.000Z",
    completedAt: "2026-06-05T09:40:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the notion report.",
  });

  const reportRelativePath = "outputs/notion-related-pages.md";
  const reportAbsolutePath = path.join(workspaceRoot, "workspace-1", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# Notion Related Pages",
      "",
      "Builder Mode research lives here.",
    ].join("\n"),
    "utf8",
  );
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-upgrade-1",
    outputType: "document",
    title: "notion-related-pages.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    artifactId: "artifact-upgrade-1",
  });
  await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });

  const descriptor = listWorkspaceOutputDocumentTrees({
    store,
    workspaceId: "workspace-1",
  }).find((item) => item.outputId === "output-upgrade-1");
  assert.ok(descriptor);

  const rootPath = path.join(
    workspaceMemoryDir(path.join(workspaceRoot, "workspace-1")),
    descriptor!.path,
  );
  fs.writeFileSync(
    rootPath,
    appendDurableMemoryRelatedSections(
      [
        "# Notion Related Pages",
        "",
        "## Summary",
        "",
        "Builder Mode research lives here.",
      ].join("\n"),
      {
        relatedEntities: [
          {
            entityType: "artifact",
            entityKey: "artifact:.-notion-related-pages.md",
            label: "./notion-related-pages.md",
          },
        ],
        relations: [
          {
            relationType: "about",
            entityKey: "artifact:.-notion-related-pages.md",
          },
        ],
      },
    ),
    "utf8",
  );
  store.syncSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: descriptor!.treeId,
    relations: [],
  });

  for (const key of [
    "workspace_artifact_relation_backfill_v1_complete",
    "workspace_tool_result_artifact_tree_backfill_v1_complete",
    "workspace_attachment_artifact_tree_backfill_v1_complete",
    "workspace_image_url_artifact_tree_backfill_v1_complete",
    "workspace_output_artifact_tree_backfill_v1_complete",
  ]) {
    store.setWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key,
      value: "true",
    });
  }
  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_artifact_relation_backfill_v2_complete",
    }),
    null,
  );

  ensureWorkspaceArtifactRelationsBackfilled({
    store,
    workspaceId: "workspace-1",
  });

  const relations = store.listSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: descriptor!.treeId,
    limit: 100,
  });
  assert.ok(relations.some((relation) =>
    relation.relationType === "about"
    && relation.metadata.entity_key === "artifact:output:output-upgrade-1"
    && relation.toNodeId === descriptor!.rootNodeId,
  ));
  const repairedBody = fs.readFileSync(rootPath, "utf8");
  assert.match(repairedBody, /`artifact:output:output-upgrade-1` \| notion-related-pages\.md/);
  assert.doesNotMatch(repairedBody, /`artifact:\.-notion-related-pages\.md` \| \.\/notion-related-pages\.md/);
  assert.equal(
    store.getWorkspaceRuntimeMetadata({
      workspaceId: "workspace-1",
      key: "workspace_artifact_relation_backfill_v2_complete",
    }),
    "true",
  );

  store.close();
});

test("persistTurnOutputArtifactsAsDocuments extracts searchable text from spreadsheet outputs", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-xlsx-output-memory-");
  seedWorkspace(store);

  const queuedInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "Preserve the revenue workbook as a first-class deliverable.",
    },
  });
  const turnResult = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    startedAt: "2026-06-04T09:20:00.000Z",
    completedAt: "2026-06-04T09:20:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I preserved the workbook output.",
  });

  const workbookRelativePath = "outputs/reports/q2-revenue.xlsx";
  const workbookAbsolutePath = path.join(workspaceRoot, "workspace-1", workbookRelativePath);
  fs.mkdirSync(path.dirname(workbookAbsolutePath), { recursive: true });
  fs.writeFileSync(
    workbookAbsolutePath,
    await createXlsxBuffer([
      ["account", "owner", "arr"],
      ["Pine Harbor", "Nina Patel", "42000"],
      ["Maple Jet", "Mateo Cruz", "38000"],
    ], "Revenue"),
  );
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-xlsx-1",
    outputType: "document",
    title: "q2-revenue.xlsx",
    status: "completed",
    filePath: workbookRelativePath,
    sessionId: "session-main",
    inputId: queuedInput.inputId,
    artifactId: "artifact-xlsx-1",
    metadata: {
      origin_type: "forwarded_subagent",
      source_subagent_id: "subagent-1",
      source_event_id: "event-xlsx-1",
    },
  });

  const treeIds = await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult,
    embeddingClient: null,
  });
  assert.equal(treeIds.length, 1);

  const retrieval = await retrieveWorkspaceMemory({
    store,
    workspaceId: "workspace-1",
    query: "Pine Harbor Nina Patel 42000",
    executionProfile: {
      useEmbeddings: false,
      useLlmRerank: false,
    },
  });
  assert.ok(retrieval.evidence.some((item) => /q2-revenue\.xlsx/i.test(item.title)));
  assert.ok(retrieval.evidence.some((item) => item.reasons.includes("lexical_match")));

  store.close();
});

test(
  "persistTurnOutputArtifactsAsDocuments extracts searchable text from image outputs via macOS Vision OCR",
  { skip: !DARWIN_VISION_OCR_AVAILABLE },
  async () => {
    const { store, workspaceRoot } = makeRuntimeState("hb-workspace-image-output-memory-");
    seedWorkspace(store);

    const queuedInput = store.enqueueInput({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      payload: {
        text: "Preserve the screenshot deliverable as a first-class artifact.",
      },
    });
    const turnResult = store.upsertTurnResult({
      workspaceId: "workspace-1",
      sessionId: "session-main",
      inputId: queuedInput.inputId,
      startedAt: "2026-06-04T10:30:00.000Z",
      completedAt: "2026-06-04T10:30:05.000Z",
      status: "completed",
      stopReason: "ok",
      assistantText: "I preserved the screenshot output.",
    });

    const imageRelativePath = "outputs/reports/escalation-note.png";
    const imageAbsolutePath = path.join(workspaceRoot, "workspace-1", imageRelativePath);
    fs.mkdirSync(path.dirname(imageAbsolutePath), { recursive: true });
    fs.writeFileSync(
      imageAbsolutePath,
      createPngBufferWithText("Nina Patel owns Pine Harbor billing escalation"),
    );
    store.createOutput({
      workspaceId: "workspace-1",
      outputId: "output-image-1",
      outputType: "image",
      title: "escalation-note.png",
      status: "completed",
      filePath: imageRelativePath,
      sessionId: "session-main",
      inputId: queuedInput.inputId,
      artifactId: "artifact-image-1",
      metadata: {
        origin_type: "forwarded_subagent",
        source_subagent_id: "subagent-1",
        source_event_id: "event-image-1",
      },
    });

    const treeIds = await persistTurnOutputArtifactsAsDocuments({
      store,
      turnResult,
      embeddingClient: null,
    });
    assert.equal(treeIds.length, 1);

    const retrieval = await retrieveWorkspaceMemory({
      store,
      workspaceId: "workspace-1",
      query: "Nina Patel Pine Harbor billing escalation",
      executionProfile: {
        useEmbeddings: false,
        useLlmRerank: false,
      },
    });
    assert.ok(retrieval.evidence.some((item) => /escalation-note\.png/i.test(item.title)));
    assert.ok(retrieval.evidence.some((item) => item.reasons.includes("lexical_match")));

    store.close();
  },
);

test("persistTurnOutputArtifactsAsDocuments links forwarded deliverables back to the original subagent artifact tree", async () => {
  const { store, workspaceRoot } = makeRuntimeState("hb-workspace-forwarded-output-memory-");
  seedWorkspace(store);

  const reportRelativePath = "outputs/reports/build-fix-report.md";
  const reportAbsolutePath = path.join(workspaceRoot, "workspace-1", reportRelativePath);
  fs.mkdirSync(path.dirname(reportAbsolutePath), { recursive: true });
  fs.writeFileSync(
    reportAbsolutePath,
    [
      "# Build Fix Report",
      "",
      "The subagent validated the fix and documented the durable follow-up for the main session.",
    ].join("\n"),
    "utf8",
  );

  const subagentInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "subagent-1",
    payload: {
      text: "Investigate the build fix and return a deliverable.",
    },
  });
  const subagentTurn = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "subagent-1",
    inputId: subagentInput.inputId,
    startedAt: "2026-06-04T07:00:00.000Z",
    completedAt: "2026-06-04T07:00:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I prepared the subagent deliverable.",
  });
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-subagent",
    outputType: "document",
    title: "build-fix-report.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "subagent-1",
    inputId: subagentInput.inputId,
    artifactId: "artifact-1",
    metadata: {
      origin_type: "subagent_output",
    },
  });
  store.appendOutputEvent({
    workspaceId: "workspace-1",
    sessionId: "subagent-1",
    inputId: subagentInput.inputId,
    sequence: 1,
    eventType: "tool_call",
    payload: {
      phase: "completed",
      tool_name: "holaboss_composio.gmail_fetch_emails",
      tool_id: "holaboss_composio.gmail_fetch_emails",
      call_id: "call-gmail-forwarded-1",
      error: false,
      result: {
        content: [
          {
            type: "text",
            text: "Ben Book at anyIP reached out to the user personally about holaboss.",
          },
        ],
        details: {
          raw: {
            _meta: {
              holaboss_integration_account: {
                provider_id: "gmail",
                connected_account_id: "ca_gmail_primary",
                account_namespace: "ops@example.com",
                connection_id: "conn_gmail_primary",
              },
            },
          },
        },
      },
    },
    createdAt: "2026-06-04T11:10:02.000Z",
  });
  await persistTurnIntegrationToolResultsAsDocuments({
    store,
    turnResult: subagentTurn,
    embeddingClient: null,
  });
  await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult: subagentTurn,
    embeddingClient: null,
  });

  const mainInput = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: {
      text: "What came back from the subagent?",
    },
  });
  const mainTurn = store.upsertTurnResult({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: mainInput.inputId,
    startedAt: "2026-06-04T07:01:00.000Z",
    completedAt: "2026-06-04T07:01:05.000Z",
    status: "completed",
    stopReason: "ok",
    assistantText: "I attached the forwarded subagent deliverable.",
  });
  const forwardedEvent = store.enqueueMainSessionEvent({
    eventId: "event-1",
    workspaceId: "workspace-1",
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: {
      summary: "The subagent delivered the build fix report.",
    },
  });
  store.createOutput({
    workspaceId: "workspace-1",
    outputId: "output-main",
    outputType: "document",
    title: "build-fix-report.md",
    status: "completed",
    filePath: reportRelativePath,
    sessionId: "session-main",
    inputId: mainInput.inputId,
    artifactId: "artifact-1",
    metadata: {
      origin_type: "forwarded_subagent",
      forwarded_output_id: "output-subagent",
      source_event_id: forwardedEvent.eventId,
    },
  });
  await persistTurnOutputArtifactsAsDocuments({
    store,
    turnResult: mainTurn,
    embeddingClient: null,
  });

  const outputTrees = listWorkspaceOutputDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(outputTrees.length, 2);
  const originalTree = outputTrees.find((item) => item.outputId === "output-subagent");
  const forwardedTree = outputTrees.find((item) => item.outputId === "output-main");
  assert.ok(originalTree);
  assert.ok(forwardedTree);
  assert.equal(forwardedTree?.forwardedOutputId, "output-subagent");
  assert.equal(forwardedTree?.sourceSubagentId, null);

  const relations = store.listSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: forwardedTree!.treeId,
    limit: 20,
    offset: 0,
  });
  const forwardedFrom = relations.find((relation) => relation.relationType === "forwarded_from");
  assert.ok(forwardedFrom);
  assert.equal(forwardedFrom?.toNodeId, originalTree?.rootNodeId);
  assert.equal(forwardedFrom?.metadata.target_tree_id, originalTree?.treeId);
  assert.equal(forwardedFrom?.metadata.output_id, "output-subagent");
  assert.equal(forwardedFrom?.metadata.source_subagent_id, "subagent-1");

  const originalRelations = store.listSemanticMemoryRelations({
    category: "workspace",
    workspaceId: "workspace-1",
    treeId: originalTree!.treeId,
    limit: 20,
    offset: 0,
  });
  const toolResultTrees = listWorkspaceToolResultDocumentTrees({
    store,
    workspaceId: "workspace-1",
  });
  assert.equal(toolResultTrees.length, 1);
  const derivedFromToolResult = originalRelations.find((relation) =>
    relation.relationType === "derived_from"
    && relation.metadata.target_tree_id === toolResultTrees[0]?.treeId,
  );
  assert.ok(derivedFromToolResult);
  assert.equal(derivedFromToolResult?.metadata.entity_label, toolResultTrees[0]?.title);

  store.close();
});
