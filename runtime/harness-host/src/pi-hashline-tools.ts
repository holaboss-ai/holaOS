import fs from "node:fs/promises";
import path from "node:path";

import {
  createEditToolDefinition,
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  formatSize,
  type ToolDefinition,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js";
import {
  resolveReadPath,
  resolveToCwd,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/path-utils.js";
import { extractHarnessAttachmentText } from "../../harnesses/src/attachment-content.js";
import type { HarnessInputAttachmentPayload } from "../../harnesses/src/types.js";

type HashlineSnapshot = {
  absolutePath: string;
  displayPath: string;
  normalizedText: string;
};

type HashlineBodyRow =
  | { kind: "add"; text: string }
  | { kind: "keep"; start: number; end: number };

type HashlineHunk =
  | { kind: "bof"; body: HashlineBodyRow[] }
  | { kind: "eof"; body: HashlineBodyRow[] }
  | { kind: "range"; start: number; end: number; body: HashlineBodyRow[] };

type HashlineSection = {
  path: string;
  tag: string | null;
  hunks: HashlineHunk[];
};

type PreparedHashlineSection = {
  absolutePath: string;
  displayPath: string;
  currentNormalized: string;
  nextNormalized: string;
  bom: string;
  lineEnding: "\n" | "\r\n";
  diff: string;
  firstChangedLine?: number;
};

const HASHLINE_HEADER_PREFIX = "¶";
const HASHLINE_TAG_SPACE = 0x1000;
const HASHLINE_TAG_MULTIPLIER = 0xb5d;
const HASHLINE_TAG_OFFSET = 0x0ad;
const HASHLINE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const HASHLINE_DOCUMENT_MIME_TYPES = new Map<string, string>([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xls", "application/vnd.ms-excel"],
]);
const HASHLINE_DIRECTORY_DEFAULT_LIMIT = 200;
const HASHLINE_MAX_DOCUMENT_CHARS = 120_000;
const HASHLINE_BINARY_SNIFF_BYTES = 1024;

class HashlineSnapshotStore {
  #counter = 0;
  #snapshots = new Map<string, HashlineSnapshot>();

  record(snapshot: HashlineSnapshot): string {
    const tag = (((this.#counter * HASHLINE_TAG_MULTIPLIER) + HASHLINE_TAG_OFFSET) & (HASHLINE_TAG_SPACE - 1))
      .toString(16)
      .toUpperCase()
      .padStart(3, "0");
    this.#counter += 1;
    this.#snapshots.set(tag, snapshot);
    return tag;
  }

  lookup(absolutePath: string, tag: string): HashlineSnapshot | null {
    const snapshot = this.#snapshots.get(tag.trim().toUpperCase());
    return snapshot && snapshot.absolutePath === absolutePath ? snapshot : null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeDisplayPath(cwd: string, absolutePath: string): string {
  const relativePath = path.relative(cwd, absolutePath);
  if (relativePath === "") {
    return path.basename(absolutePath);
  }
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join("/");
  }
  return absolutePath.split(path.sep).join("/");
}

function hashlineHeader(displayPath: string, tag: string): string {
  return `${HASHLINE_HEADER_PREFIX}${displayPath}#${tag}`;
}

function splitLogicalLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function joinLogicalLines(lines: readonly string[], hadTrailingNewline: boolean): string {
  if (lines.length === 0) {
    return "";
  }
  const joined = lines.join("\n");
  return hadTrailingNewline ? `${joined}\n` : joined;
}

function hashlineInputFromArgs(args: unknown): string | null {
  if (!isRecord(args)) {
    return null;
  }
  if (typeof args.input === "string") {
    return args.input;
  }
  if (typeof args._input === "string") {
    return args._input;
  }
  return null;
}

function parseHashlineHeader(rawLine: string): { path: string; tag: string | null } | null {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith(HASHLINE_HEADER_PREFIX)) {
    return null;
  }
  const match = /^¶(.+?)(?:#([0-9A-Fa-f]{3}))?$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid hashline section header ${JSON.stringify(trimmed)}. Use ¶path#TAG from read output.`,
    );
  }
  const rawPath = match[1]?.trim() ?? "";
  if (!rawPath) {
    throw new Error("Hashline section header is missing a file path.");
  }
  const unquotedPath = rawPath.length >= 2
    && ((rawPath.startsWith("\"") && rawPath.endsWith("\"")) || (rawPath.startsWith("'") && rawPath.endsWith("'")))
    ? rawPath.slice(1, -1)
    : rawPath;
  return {
    path: unquotedPath,
    tag: match[2]?.toUpperCase() ?? null,
  };
}

function parseHashlineKeepRow(rawLine: string): HashlineBodyRow {
  const match = /^&(\d+)(?:\.\.(\d+))?$/.exec(rawLine.trim());
  if (!match) {
    throw new Error(
      `Invalid hashline keep row ${JSON.stringify(rawLine)}. Use &N or &A..B to copy original lines.`,
    );
  }
  const start = Number.parseInt(match[1] ?? "", 10);
  const end = Number.parseInt(match[2] ?? match[1] ?? "", 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new Error(`Invalid hashline keep range ${JSON.stringify(rawLine)}.`);
  }
  return { kind: "keep", start, end };
}

function parseHashlineSections(input: string): HashlineSection[] {
  const lines = normalizeToLF(input).split("\n");
  const sections: HashlineSection[] = [];
  let currentSection: HashlineSection | null = null;
  let currentHunk: HashlineHunk | null = null;
  let currentHunkUnifiedDiffMode = false;

  const pushHunk = () => {
    if (currentSection && currentHunk) {
      currentSection.hunks.push(currentHunk);
      currentHunk = null;
    }
    currentHunkUnifiedDiffMode = false;
  };

  const enterUnifiedDiffMode = () => {
    if (!currentHunk || currentHunkUnifiedDiffMode) {
      return;
    }
    currentHunkUnifiedDiffMode = true;
    for (const row of currentHunk.body) {
      if (row.kind === "add" && row.text.startsWith(" ")) {
        row.text = row.text.slice(1);
      }
    }
  };

  const pushSection = () => {
    pushHunk();
    if (currentSection) {
      if (currentSection.hunks.length === 0) {
        throw new Error(`Hashline section for ${currentSection.path} has no hunks.`);
      }
      sections.push(currentSection);
      currentSection = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const header = parseHashlineHeader(line);
    if (header) {
      pushSection();
      currentSection = { path: header.path, tag: header.tag, hunks: [] };
      continue;
    }
    if (!currentSection) {
      throw new Error("Hashline input must start with a ¶path#TAG section header.");
    }
    if (/^BOF$/i.test(trimmed)) {
      pushHunk();
      currentHunk = { kind: "bof", body: [] };
      continue;
    }
    if (/^EOF$/i.test(trimmed)) {
      pushHunk();
      currentHunk = { kind: "eof", body: [] };
      continue;
    }
    const numericAnchor = /^(\d+)(?:\s+(\d+))?$/.exec(trimmed);
    if (numericAnchor) {
      pushHunk();
      const start = Number.parseInt(numericAnchor[1] ?? "", 10);
      const end = Number.parseInt(numericAnchor[2] ?? numericAnchor[1] ?? "", 10);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error(`Invalid hashline hunk header ${JSON.stringify(trimmed)}.`);
      }
      currentHunk = { kind: "range", start, end, body: [] };
      continue;
    }
    if (!currentHunk) {
      throw new Error(
        `Hashline body row ${JSON.stringify(line)} appears before a hunk header in ${currentSection.path}.`,
      );
    }
    if (line.startsWith("+")) {
      currentHunk.body.push({ kind: "add", text: line.slice(1) });
      continue;
    }
    if (line.startsWith("&")) {
      currentHunk.body.push(parseHashlineKeepRow(line));
      continue;
    }
    if (line.startsWith("-")) {
      enterUnifiedDiffMode();
      continue;
    }
    if (currentHunkUnifiedDiffMode && line.startsWith(" ")) {
      currentHunk.body.push({ kind: "add", text: line.slice(1) });
      continue;
    }
    currentHunk.body.push({ kind: "add", text: line });
  }

  pushSection();
  if (sections.length === 0) {
    throw new Error("No hashline sections found in input.");
  }
  return sections;
}

function renderHashlineReadOutput(params: {
  displayPath: string;
  tag: string;
  allLines: readonly string[];
  offset?: number;
  limit?: number;
}): string {
  const startLine = params.offset && params.offset > 0 ? params.offset : 1;
  const startIndex = startLine - 1;
  if (params.allLines.length === 0) {
    return `${hashlineHeader(params.displayPath, params.tag)}\n[Empty file. Use BOF or EOF to insert content.]`;
  }
  if (startIndex >= params.allLines.length) {
    throw new Error(`Offset ${startLine} is beyond end of file (${params.allLines.length} lines total)`);
  }

  const requestedLimit = params.limit && params.limit > 0 ? Math.floor(params.limit) : Number.POSITIVE_INFINITY;
  const selectedLines = params.allLines.slice(startIndex, startIndex + requestedLimit);
  const rendered: string[] = [hashlineHeader(params.displayPath, params.tag)];
  let renderedBytes = Buffer.byteLength(`${rendered[0]}\n`, "utf-8");
  let renderedLineCount = 0;
  let nextLineNumber = startLine;

  for (const line of selectedLines) {
    const prefixed = `${nextLineNumber}:${line}`;
    const prefixedBytes = Buffer.byteLength(`${prefixed}\n`, "utf-8");
    const wouldExceedLines = renderedLineCount >= DEFAULT_MAX_LINES;
    const wouldExceedBytes = renderedBytes + prefixedBytes > DEFAULT_MAX_BYTES;
    if ((wouldExceedLines || wouldExceedBytes) && renderedLineCount > 0) {
      break;
    }
    if (wouldExceedBytes && renderedLineCount === 0) {
      const lineSize = formatSize(Buffer.byteLength(line, "utf-8"));
      rendered.push(
        `[Line ${nextLineNumber} is ${lineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use offset=${nextLineNumber} with a more targeted read.]`,
      );
      renderedLineCount = 1;
      nextLineNumber += 1;
      break;
    }
    rendered.push(prefixed);
    renderedBytes += prefixedBytes;
    renderedLineCount += 1;
    nextLineNumber += 1;
  }

  const renderedRangeEnd = nextLineNumber - 1;
  if (renderedLineCount === 0) {
    rendered.push("[No lines rendered.]");
  }
  if (renderedRangeEnd < params.allLines.length) {
    rendered.push(
      `[Showing lines ${startLine}-${renderedRangeEnd} of ${params.allLines.length}. Use offset=${renderedRangeEnd + 1} to continue.]`,
    );
  }
  return rendered.join("\n");
}

function renderNumberedReadOutput(params: {
  headerLines: readonly string[];
  bodyLines: readonly string[];
  offset?: number;
  limit?: number;
  emptyMessage: string;
  unitLabel: string;
}): string {
  const rendered: string[] = [...params.headerLines];
  const renderedHeader = rendered.join("\n");
  const headerPrefix = renderedHeader.length > 0 ? `${renderedHeader}\n` : "";
  const startLine = params.offset && params.offset > 0 ? Math.floor(params.offset) : 1;
  const startIndex = startLine - 1;
  if (params.bodyLines.length === 0) {
    return `${headerPrefix}${params.emptyMessage}`;
  }
  if (startIndex >= params.bodyLines.length) {
    throw new Error(`Offset ${startLine} is beyond end of ${params.unitLabel} (${params.bodyLines.length} total)`);
  }

  const requestedLimit = params.limit && params.limit > 0 ? Math.floor(params.limit) : Number.POSITIVE_INFINITY;
  const selectedLines = params.bodyLines.slice(startIndex, startIndex + requestedLimit);
  let renderedBytes = Buffer.byteLength(headerPrefix, "utf-8");
  let renderedLineCount = 0;
  let nextLineNumber = startLine;

  for (const line of selectedLines) {
    const prefixed = `${nextLineNumber}:${line}`;
    const prefixedBytes = Buffer.byteLength(`${prefixed}\n`, "utf-8");
    const wouldExceedLines = renderedLineCount >= DEFAULT_MAX_LINES;
    const wouldExceedBytes = renderedBytes + prefixedBytes > DEFAULT_MAX_BYTES;
    if ((wouldExceedLines || wouldExceedBytes) && renderedLineCount > 0) {
      break;
    }
    if (wouldExceedBytes && renderedLineCount === 0) {
      rendered.push(
        `[${params.unitLabel.slice(0, 1).toUpperCase()}${params.unitLabel.slice(1)} ${nextLineNumber} exceeds ${formatSize(DEFAULT_MAX_BYTES)} output limit. Use offset=${nextLineNumber} with a more targeted read.]`,
      );
      renderedLineCount = 1;
      nextLineNumber += 1;
      break;
    }
    rendered.push(prefixed);
    renderedBytes += prefixedBytes;
    renderedLineCount += 1;
    nextLineNumber += 1;
  }

  const renderedRangeEnd = nextLineNumber - 1;
  if (renderedLineCount === 0) {
    rendered.push("[No lines rendered.]");
  }
  if (renderedRangeEnd < params.bodyLines.length) {
    rendered.push(
      `[Showing ${params.unitLabel} ${startLine}-${renderedRangeEnd} of ${params.bodyLines.length}. Use offset=${renderedRangeEnd + 1} to continue.]`,
    );
  }
  return rendered.join("\n");
}

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, HASHLINE_BINARY_SNIFF_BYTES)).includes(0);
}

function syntheticReadAttachment(params: {
  absolutePath: string;
  displayPath: string;
  extension: string;
  sizeBytes: number;
}): HarnessInputAttachmentPayload {
  return {
    id: params.absolutePath,
    kind: "file",
    name: path.basename(params.absolutePath),
    mime_type: HASHLINE_DOCUMENT_MIME_TYPES.get(params.extension) ?? "application/octet-stream",
    size_bytes: params.sizeBytes,
    workspace_path: params.displayPath,
  };
}

function truncateDocumentText(text: string): { text: string; truncated: boolean } {
  if (text.length <= HASHLINE_MAX_DOCUMENT_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, HASHLINE_MAX_DOCUMENT_CHARS),
    truncated: true,
  };
}

async function renderDirectoryReadOutput(params: {
  absolutePath: string;
  displayPath: string;
  offset?: number;
  limit?: number;
}): Promise<string> {
  const entries = await fs.readdir(params.absolutePath, { withFileTypes: true });
  const bodyLines = entries
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }))
    .map((entry) => {
      if (entry.isDirectory()) {
        return `${entry.name}/`;
      }
      if (entry.isSymbolicLink()) {
        return `${entry.name}@`;
      }
      return entry.name;
    });
  return renderNumberedReadOutput({
    headerLines: [
      `[Directory: ${params.displayPath}]`,
      `Entries: ${bodyLines.length}`,
      "",
    ],
    bodyLines,
    offset: params.offset,
    limit: params.limit ?? HASHLINE_DIRECTORY_DEFAULT_LIMIT,
    emptyMessage: "(empty directory)",
    unitLabel: "entries",
  });
}

async function renderDocumentReadOutput(params: {
  absolutePath: string;
  displayPath: string;
  extension: string;
  sizeBytes: number;
  offset?: number;
  limit?: number;
}): Promise<string> {
  const attachment = syntheticReadAttachment(params);
  const extractedText = await extractHarnessAttachmentText({
    attachment,
    absolutePath: params.absolutePath,
  });
  if (!extractedText) {
    throw new Error(`Unable to extract readable content from ${params.displayPath}`);
  }
  const truncated = truncateDocumentText(extractedText);
  const numbered = renderNumberedReadOutput({
    headerLines: [
      `[Document: ${attachment.name}]`,
      `Mime-Type: ${attachment.mime_type}`,
      `Path: ${params.displayPath}`,
      "",
    ],
    bodyLines: splitLogicalLines(normalizeToLF(truncated.text)),
    offset: params.offset,
    limit: params.limit,
    emptyMessage: "[document contained no readable text]",
    unitLabel: "lines",
  });
  if (!truncated.truncated) {
    return numbered;
  }
  return `${numbered}\n[document text truncated for read output]`;
}

function renderBinaryReadOutput(params: {
  displayPath: string;
  extension: string;
  sizeBytes: number;
}): string {
  const details = [
    `[Binary file: ${params.displayPath}]`,
    `Size: ${formatSize(params.sizeBytes)}`,
  ];
  if (params.extension) {
    details.push(`Extension: ${params.extension}`);
  }
  details.push(
    "This file type is not readable as plain text here. The read tool supports text files, directories, images, PDFs, DOCX, PPTX, XLSX, and XLS files.",
  );
  return details.join("\n");
}

function validateHashlineHunks(section: HashlineSection, baseLines: readonly string[]): void {
  let bofSeen = false;
  let eofSeen = false;
  const numericHunks = section.hunks
    .filter((hunk): hunk is Extract<HashlineHunk, { kind: "range" }> => hunk.kind === "range")
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < numericHunks.length; index += 1) {
    const previous = numericHunks[index - 1]!;
    const current = numericHunks[index]!;
    if (previous.end >= current.start) {
      throw new Error(
        `Hashline hunks for ${section.path} overlap at lines ${previous.start}-${previous.end} and ${current.start}-${current.end}.`,
      );
    }
  }
  for (const hunk of section.hunks) {
    if (hunk.kind === "bof") {
      if (bofSeen) {
        throw new Error(`Hashline section for ${section.path} contains multiple BOF hunks.`);
      }
      bofSeen = true;
      continue;
    }
    if (hunk.kind === "eof") {
      if (eofSeen) {
        throw new Error(`Hashline section for ${section.path} contains multiple EOF hunks.`);
      }
      eofSeen = true;
      continue;
    }
    if (hunk.start > baseLines.length) {
      throw new Error(
        `Hashline hunk ${hunk.start}-${hunk.end} is outside ${section.path} (${baseLines.length} lines total).`,
      );
    }
    if (hunk.end > baseLines.length) {
      throw new Error(
        `Hashline hunk ${hunk.start}-${hunk.end} extends beyond ${section.path} (${baseLines.length} lines total).`,
      );
    }
    for (const row of hunk.body) {
      if (row.kind !== "keep") {
        continue;
      }
      if (row.start < 1 || row.end > baseLines.length) {
        throw new Error(
          `Hashline keep range ${row.start}-${row.end} is outside ${section.path} (${baseLines.length} lines total).`,
        );
      }
    }
  }
}

function expandHashlineBody(body: readonly HashlineBodyRow[], baseLines: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const row of body) {
    if (row.kind === "add") {
      expanded.push(row.text);
      continue;
    }
    expanded.push(...baseLines.slice(row.start - 1, row.end));
  }
  return expanded;
}

function applyHashlineSection(section: HashlineSection, baseText: string): {
  nextText: string;
  firstChangedLine?: number;
  diff: string;
} {
  const baseLines = splitLogicalLines(baseText);
  validateHashlineHunks(section, baseLines);
  const bofLines: string[] = [];
  const eofLines: string[] = [];
  const replacements = new Map<number, { end: number; lines: string[] }>();

  for (const hunk of section.hunks) {
    if (hunk.kind === "bof") {
      bofLines.push(...expandHashlineBody(hunk.body, baseLines));
      continue;
    }
    if (hunk.kind === "eof") {
      eofLines.push(...expandHashlineBody(hunk.body, baseLines));
      continue;
    }
    replacements.set(hunk.start, {
      end: hunk.end,
      lines: expandHashlineBody(hunk.body, baseLines),
    });
  }

  const nextLines: string[] = [...bofLines];
  let lineNumber = 1;
  while (lineNumber <= baseLines.length) {
    const replacement = replacements.get(lineNumber);
    if (replacement) {
      nextLines.push(...replacement.lines);
      lineNumber = replacement.end + 1;
      continue;
    }
    nextLines.push(baseLines[lineNumber - 1] ?? "");
    lineNumber += 1;
  }
  nextLines.push(...eofLines);

  const hadTrailingNewline = baseText.endsWith("\n");
  const nextText = joinLogicalLines(nextLines, hadTrailingNewline);
  const diffResult = generateDiffString(baseText, nextText);
  return {
    nextText,
    firstChangedLine: diffResult.firstChangedLine,
    diff: diffResult.diff,
  };
}

async function prepareHashlineEdit(params: {
  cwd: string;
  store: HashlineSnapshotStore;
  section: HashlineSection;
}): Promise<PreparedHashlineSection> {
  const absolutePath = resolveToCwd(params.section.path, params.cwd);
  const displayPath = normalizeDisplayPath(params.cwd, absolutePath);
  const rawContent = await fs.readFile(absolutePath, "utf-8").catch((error: NodeJS.ErrnoException) => {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  const exists = rawContent !== null;
  const currentRaw = rawContent ?? "";
  const { bom, text } = stripBom(currentRaw);
  const lineEnding = detectLineEnding(text);
  const currentNormalized = normalizeToLF(text);
  const hasAnchoredContent = params.section.hunks.some((hunk) =>
    hunk.kind === "range" || hunk.body.some((row) => row.kind === "keep"),
  );
  if (hasAnchoredContent && !params.section.tag) {
    throw new Error(
      `Missing hashline snapshot tag for anchored edit to ${displayPath}. Use the exact ${HASHLINE_HEADER_PREFIX}${displayPath}#TAG header from read.`,
    );
  }
  if (!exists && hasAnchoredContent) {
    throw new Error(`File not found: ${displayPath}`);
  }
  if (params.section.tag) {
    const snapshot = params.store.lookup(absolutePath, params.section.tag);
    if (!snapshot || snapshot.normalizedText !== currentNormalized) {
      const currentTag = params.store.record({ absolutePath, displayPath, normalizedText: currentNormalized });
      throw new Error(
        `Stale hashline snapshot for ${displayPath}. Expected ${hashlineHeader(displayPath, params.section.tag)} but the current file is ${hashlineHeader(displayPath, currentTag)}. Re-read the file and retry.`,
      );
    }
  }
  const applyResult = applyHashlineSection(
    params.section,
    params.section.tag ? params.store.lookup(absolutePath, params.section.tag)?.normalizedText ?? currentNormalized : currentNormalized,
  );
  if (applyResult.nextText === currentNormalized) {
    throw new Error(
      `Edits to ${displayPath} parsed cleanly but produced no change. Re-read the file before issuing another edit.`,
    );
  }
  return {
    absolutePath,
    displayPath,
    currentNormalized,
    nextNormalized: applyResult.nextText,
    bom,
    lineEnding,
    diff: applyResult.diff,
    firstChangedLine: applyResult.firstChangedLine,
  };
}

async function commitHashlineEdit(params: {
  store: HashlineSnapshotStore;
  prepared: PreparedHashlineSection;
}): Promise<{ text: string; diff: string; firstChangedLine?: number }> {
  return withFileMutationQueue(params.prepared.absolutePath, async () => {
    const rawBeforeWrite = await fs.readFile(params.prepared.absolutePath, "utf-8").catch((error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") {
        return "";
      }
      throw error;
    });
    const { text } = stripBom(rawBeforeWrite);
    const liveNormalized = normalizeToLF(text);
    if (liveNormalized !== params.prepared.currentNormalized) {
      const currentTag = params.store.record({
        absolutePath: params.prepared.absolutePath,
        displayPath: params.prepared.displayPath,
        normalizedText: liveNormalized,
      });
      throw new Error(
        `File changed while applying edit to ${params.prepared.displayPath}. Current snapshot is ${hashlineHeader(params.prepared.displayPath, currentTag)}. Re-read and retry.`,
      );
    }
    const persisted = params.prepared.bom + restoreLineEndings(params.prepared.nextNormalized, params.prepared.lineEnding);
    await fs.writeFile(params.prepared.absolutePath, persisted, "utf-8");
    const nextTag = params.store.record({
      absolutePath: params.prepared.absolutePath,
      displayPath: params.prepared.displayPath,
      normalizedText: params.prepared.nextNormalized,
    });
    return {
      text: `Updated ${params.prepared.displayPath}.\nNext snapshot: ${hashlineHeader(params.prepared.displayPath, nextTag)}`,
      diff: params.prepared.diff,
      firstChangedLine: params.prepared.firstChangedLine,
    };
  });
}

export function createPiHashlineToolDefinitions(cwd: string): ToolDefinition[] {
  const baseReadTool = createReadToolDefinition(cwd);
  const {
    renderCall: _baseEditRenderCall,
    renderResult: _baseEditRenderResult,
    ...baseEditTool
  } = createEditToolDefinition(cwd);
  const store = new HashlineSnapshotStore();

  const readTool = defineTool({
    ...baseReadTool,
    description:
      "Read files, directories, and common documents. Editable text results are returned as snapshot-tagged, line-numbered hashline output (`¶path#TAG` then `N:text`) so follow-up edits can anchor to the exact file view you read. Directories return numbered entry listings. Images are returned inline as attachments. PDFs, DOCX, PPTX, XLSX, and XLS files are converted into readable text output.",
    promptSnippet: "Read snapshot-tagged file contents for anchored hashline edits",
    promptGuidelines: [
      "Use read before edit. Copy the exact `¶path#TAG` header from the latest read output and never invent the tag.",
      "Hashline edit anchors are bare line numbers from read output. Use offset/limit to continue large files instead of re-reading from the top.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const rawPath = String((params as { path: string }).path ?? "").trim();
      const absolutePath = resolveReadPath(rawPath, cwd);
      const stats = await fs.stat(absolutePath);
      const displayPath = normalizeDisplayPath(cwd, absolutePath);
      if (stats.isDirectory()) {
        return {
          content: [{
            type: "text",
            text: await renderDirectoryReadOutput({
              absolutePath,
              displayPath,
              offset: typeof (params as { offset?: number }).offset === "number" ? (params as { offset?: number }).offset : undefined,
              limit: typeof (params as { limit?: number }).limit === "number" ? (params as { limit?: number }).limit : undefined,
            }),
          }],
          details: undefined,
        };
      }
      const extension = path.extname(absolutePath).toLowerCase();
      if (HASHLINE_IMAGE_EXTENSIONS.has(extension)) {
        return baseReadTool.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      if (HASHLINE_DOCUMENT_MIME_TYPES.has(extension)) {
        return {
          content: [{
            type: "text",
            text: await renderDocumentReadOutput({
              absolutePath,
              displayPath,
              extension,
              sizeBytes: stats.size,
              offset: typeof (params as { offset?: number }).offset === "number" ? (params as { offset?: number }).offset : undefined,
              limit: typeof (params as { limit?: number }).limit === "number" ? (params as { limit?: number }).limit : undefined,
            }),
          }],
          details: undefined,
        };
      }
      const rawBuffer = await fs.readFile(absolutePath);
      if (isLikelyBinaryBuffer(rawBuffer)) {
        return {
          content: [{
            type: "text",
            text: renderBinaryReadOutput({
              displayPath,
              extension,
              sizeBytes: stats.size,
            }),
          }],
          details: undefined,
        };
      }
      const rawContent = rawBuffer.toString("utf-8");
      const { text } = stripBom(rawContent);
      const normalizedText = normalizeToLF(text);
      const tag = store.record({ absolutePath, displayPath, normalizedText });
      const outputText = renderHashlineReadOutput({
        displayPath,
        tag,
        allLines: splitLogicalLines(normalizedText),
        offset: typeof (params as { offset?: number }).offset === "number" ? (params as { offset?: number }).offset : undefined,
        limit: typeof (params as { limit?: number }).limit === "number" ? (params as { limit?: number }).limit : undefined,
      });
      return {
        content: [{ type: "text", text: outputText }],
        details: undefined,
      };
    },
  });

  const hashlineEditSchema = Type.Object(
    {
      input: Type.String({
        description:
          "Hashline patch input. Use one or more sections that start with ¶path#TAG from read output, followed by bare hunk headers (`A`, `A B`, `BOF`, `EOF`) and body rows (`+text`, `&A..B`).",
      }),
      _input: Type.Optional(Type.String({
        description: "Provider-compatibility alias for input.",
      })),
    },
    { additionalProperties: true },
  );

  const editTool = defineTool({
    ...baseEditTool,
    parameters: hashlineEditSchema,
    description:
      "Edit files with hashline patches. Pass a single `input` string containing one or more sections. Each section starts with `¶path#TAG` from the latest read output, then uses bare hunk headers (`A`, `A B`, `BOF`, `EOF`) and body rows (`+text`, `&A..B`). The snapshot tag is required for anchored edits and stale tags are rejected.",
    promptSnippet: "Edit files with hashline sections anchored to the latest read snapshot tag",
    promptGuidelines: [
      "Always read the file first and copy the exact `¶path#TAG` header into your edit input. Never guess or fabricate the tag.",
      "Hashline hunks use bare anchors only: `A`, `A B`, `BOF`, or `EOF`. Do not use unified diff syntax like `@@` or `-old/+new` rows.",
      "Use `+text` to add literal lines and `&A..B` or `&A` to keep original lines. An empty hunk body deletes the selected range.",
    ],
    prepareArguments(args) {
      const input = hashlineInputFromArgs(args);
      if (input === null) {
        return args as never;
      }
      return { ...(isRecord(args) ? args : {}), input } as never;
    },
    async execute(_toolCallId, params) {
      const input = hashlineInputFromArgs(params);
      if (input === null) {
        throw new Error("Hashline edit input must include an `input` string.");
      }
      const sections = parseHashlineSections(input);
      const prepared: PreparedHashlineSection[] = [];
      const preparedPaths = new Set<string>();
      for (const section of sections) {
        const nextPrepared = await prepareHashlineEdit({ cwd, store, section });
        if (preparedPaths.has(nextPrepared.absolutePath)) {
          throw new Error(
            `Multiple hashline sections resolve to the same file (${nextPrepared.displayPath}). Merge them into one section before editing.`,
          );
        }
        preparedPaths.add(nextPrepared.absolutePath);
        prepared.push(nextPrepared);
      }
      const committed = [];
      for (const nextPrepared of prepared) {
        committed.push(await commitHashlineEdit({ store, prepared: nextPrepared }));
      }
      return {
        content: [{ type: "text", text: committed.map((entry) => entry.text).join("\n\n") }],
        details: {
          diff: committed.map((entry) => entry.diff).join("\n"),
          firstChangedLine: committed.length === 1 ? committed[0]?.firstChangedLine : undefined,
        },
      };
    },
  });

  return [readTool, editTool];
}
