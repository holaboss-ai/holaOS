import fs from "node:fs/promises";
import path from "node:path";

import {
  createReadToolDefinition,
  defineTool,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import {
  normalizeToLF,
  stripBom,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js";
import {
  resolveReadPath,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/core/tools/path-utils.js";
import { extractHarnessAttachmentText } from "../../harnesses/src/attachment-content.js";
import type { HarnessInputAttachmentPayload } from "../../harnesses/src/types.js";
import { summarizeCode, type SummaryResult, type SummarySegment } from "./code-summary.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const DOCUMENT_MIME_TYPES = new Map<string, string>([
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xls", "application/vnd.ms-excel"],
]);
const PROSE_SUMMARY_EXTENSIONS = new Set([".md", ".txt"]);
const DIRECTORY_DEFAULT_LIMIT = 200;
const MAX_DOCUMENT_CHARS = 120_000;
const BINARY_SNIFF_BYTES = 1024;
const SUMMARY_MAX_BYTES = 2 * 1024 * 1024;
const SUMMARY_MAX_LINES = 20_000;
const SUMMARY_MIN_TOTAL_LINES = 100;
const SUMMARY_MIN_BODY_LINES = 4;
const SUMMARY_MIN_COMMENT_LINES = 6;
const SUMMARY_UNFOLD_UNTIL = 50;
const SUMMARY_UNFOLD_LIMIT = 100;

function normalizeDisplayPath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (relative === "") return path.basename(absolutePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return absolutePath.split(path.sep).join("/");
}

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, BINARY_SNIFF_BYTES)).includes(0);
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
    mime_type: DOCUMENT_MIME_TYPES.get(params.extension) ?? "application/octet-stream",
    size_bytes: params.sizeBytes,
    workspace_path: params.displayPath,
  };
}

function truncateDocumentText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DOCUMENT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_DOCUMENT_CHARS), truncated: true };
}

function splitLogicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
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
  if (params.bodyLines.length === 0) return `${headerPrefix}${params.emptyMessage}`;
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
    if ((wouldExceedLines || wouldExceedBytes) && renderedLineCount > 0) break;
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
  if (renderedLineCount === 0) rendered.push("[No lines rendered.]");
  if (renderedRangeEnd < params.bodyLines.length) {
    rendered.push(
      `[Showing ${params.unitLabel} ${startLine}-${renderedRangeEnd} of ${params.bodyLines.length}. Use offset=${renderedRangeEnd + 1} to continue.]`,
    );
  }
  return rendered.join("\n");
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
      if (entry.isDirectory()) return `${entry.name}/`;
      if (entry.isSymbolicLink()) return `${entry.name}@`;
      return entry.name;
    });
  return renderNumberedReadOutput({
    headerLines: [`[Directory: ${params.displayPath}]`, `Entries: ${bodyLines.length}`, ""],
    bodyLines,
    offset: params.offset,
    limit: params.limit ?? DIRECTORY_DEFAULT_LIMIT,
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
  return truncated.truncated ? `${numbered}\n[document text truncated for read output]` : numbered;
}

function renderBinaryReadOutput(params: { displayPath: string; extension: string; sizeBytes: number }): string {
  const details = [
    `[Binary file: ${params.displayPath}]`,
    `Size: ${formatSize(params.sizeBytes)}`,
  ];
  if (params.extension) details.push(`Extension: ${params.extension}`);
  details.push(
    "This file type is not readable as plain text here. The read tool supports text files, directories, images, PDFs, DOCX, PPTX, XLSX, and XLS files.",
  );
  return details.join("\n");
}

function renderSummaryReadOutput(params: {
  displayPath: string;
  summary: SummaryResult;
  totalLines: number;
}): string {
  const rendered: string[] = [`[Read: ${params.displayPath} — structural summary]`];
  let renderedBytes = Buffer.byteLength(`${rendered[0]}\n`, "utf-8");
  let renderedLineCount = 0;
  let exhausted = false;

  const pushRenderedLine = (line: string): boolean => {
    const withNewline = `${line}\n`;
    const bytes = Buffer.byteLength(withNewline, "utf-8");
    const wouldExceedLines = renderedLineCount >= DEFAULT_MAX_LINES;
    const wouldExceedBytes = renderedBytes + bytes > DEFAULT_MAX_BYTES;
    if ((wouldExceedLines || wouldExceedBytes) && renderedLineCount > 0) {
      exhausted = true;
      return false;
    }
    if (wouldExceedBytes && renderedLineCount === 0) {
      rendered.push(`[Summary output exceeds ${formatSize(DEFAULT_MAX_BYTES)}. Use offset/limit for a more targeted read.]`);
      renderedLineCount += 1;
      exhausted = true;
      return false;
    }
    rendered.push(line);
    renderedBytes += bytes;
    renderedLineCount += 1;
    return true;
  };

  const elidedRanges: Array<{ startLine: number; endLine: number }> = [];

  for (const segment of params.summary.segments) {
    if (exhausted) break;
    if (isElidedSegment(segment)) {
      elidedRanges.push({ startLine: segment.startLine, endLine: segment.endLine });
      const span = segment.endLine - segment.startLine + 1;
      const lineWord = span === 1 ? "line" : "lines";
      const rangeLabel = segment.startLine === segment.endLine
        ? `${segment.startLine}`
        : `${segment.startLine}-${segment.endLine}`;
      if (!pushRenderedLine(`[${span} ${lineWord} elided, ${rangeLabel}; re-read with offset=${segment.startLine} limit=${span}]`)) {
        break;
      }
      continue;
    }
    const textLines = segment.text.length === 0 ? [""] : segment.text.split("\n");
    for (const line of textLines) {
      if (!pushRenderedLine(line)) break;
    }
  }

  if (elidedRanges.length > 0 && !exhausted) {
    const totalElided = elidedRanges.reduce((sum, r) => sum + (r.endLine - r.startLine + 1), 0);
    const lineWord = totalElided === 1 ? "line" : "lines";
    pushRenderedLine(`[${totalElided} ${lineWord} elided across ${elidedRanges.length} range(s) of ${params.totalLines} total. Re-read needed ranges with offset/limit.]`);
  }

  return rendered.join("\n");
}

function isElidedSegment(segment: SummarySegment): segment is { kind: "elided"; startLine: number; endLine: number } {
  return "kind" in segment && segment.kind === "elided";
}

async function maybeRenderStructuralSummary(params: {
  displayPath: string;
  extension: string;
  sizeBytes: number;
  normalizedText: string;
  totalLines: number;
}): Promise<string | null> {
  if (params.sizeBytes > SUMMARY_MAX_BYTES) return null;
  if (PROSE_SUMMARY_EXTENSIONS.has(params.extension)) return null;
  if (params.totalLines < SUMMARY_MIN_TOTAL_LINES || params.totalLines > SUMMARY_MAX_LINES) return null;

  try {
    const summary = await summarizeCode({
      code: params.normalizedText,
      path: params.displayPath,
      minBodyLines: SUMMARY_MIN_BODY_LINES,
      minCommentLines: SUMMARY_MIN_COMMENT_LINES,
      unfoldUntilLines: SUMMARY_UNFOLD_UNTIL,
      unfoldLimitLines: SUMMARY_UNFOLD_LIMIT,
    });
    if (!summary.parsed || !summary.elided) return null;
    return renderSummaryReadOutput({
      displayPath: params.displayPath,
      summary,
      totalLines: params.totalLines,
    });
  } catch {
    return null;
  }
}

export function createPiDocumentReadToolDefinitions(cwd: string): ToolDefinition[] {
  const baseReadTool = createReadToolDefinition(cwd);

  const readTool = defineTool({
    ...baseReadTool,
    description:
      "Read files, directories, and common documents. Use this tool instead of shelling out to `cat`, `head`, `tail`, or `ls`. Plain text/code reads return verbatim file contents and can be paginated with offset/limit. Large source files (100-20000 lines) may return a structural summary that keeps declarations and elides long function bodies; re-read elided ranges with offset/limit before editing. Directories return numbered entry listings. Images are returned inline as attachments. PDFs, DOCX, PPTX, XLSX, and XLS files are converted into readable text output.",
    promptSnippet: "Read file contents, directories, or documents",
    promptGuidelines: [
      "Use read to inspect files instead of shelling out to cat/head/tail/ls.",
      "When you only need part of a large file, pass offset (1-indexed) and limit to avoid loading the whole file.",
      "Structural summaries elide long function bodies. To see the elided lines, re-read with the offset and limit shown in the elision marker.",
      "Directories, PDFs, DOCX, PPTX, XLSX, and XLS files are also readable via this tool.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requestedPath = (params as { path: string }).path;
      const offset = (params as { offset?: number }).offset;
      const limit = (params as { limit?: number }).limit;

      const absolutePath = resolveReadPath(requestedPath, cwd);
      const stats = await fs.stat(absolutePath);
      const displayPath = normalizeDisplayPath(cwd, absolutePath);

      if (stats.isDirectory()) {
        return {
          content: [{
            type: "text",
            text: await renderDirectoryReadOutput({ absolutePath, displayPath, offset, limit }),
          }],
          details: undefined,
        };
      }

      const extension = path.extname(absolutePath).toLowerCase();

      if (IMAGE_EXTENSIONS.has(extension)) {
        return baseReadTool.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      if (DOCUMENT_MIME_TYPES.has(extension)) {
        return {
          content: [{
            type: "text",
            text: await renderDocumentReadOutput({
              absolutePath,
              displayPath,
              extension,
              sizeBytes: stats.size,
              offset,
              limit,
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
            text: renderBinaryReadOutput({ displayPath, extension, sizeBytes: stats.size }),
          }],
          details: undefined,
        };
      }

      if (offset !== undefined || limit !== undefined) {
        return baseReadTool.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      const rawContent = rawBuffer.toString("utf-8");
      const { text } = stripBom(rawContent);
      const normalizedText = normalizeToLF(text);
      const totalLines = splitLogicalLines(normalizedText).length;

      if (totalLines >= SUMMARY_MIN_TOTAL_LINES) {
        const summaryOutput = await maybeRenderStructuralSummary({
          displayPath,
          extension,
          sizeBytes: stats.size,
          normalizedText,
          totalLines,
        });
        if (summaryOutput) {
          return {
            content: [{ type: "text", text: summaryOutput }],
            details: undefined,
          };
        }
      }

      return baseReadTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  return [readTool];
}
