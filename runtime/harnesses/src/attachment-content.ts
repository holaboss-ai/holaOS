import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  extractImages,
  extractLinks,
  extractText,
  extractTextItems,
  getDocumentProxy,
  getMeta,
  renderPageAsImage,
  type StructuredTextItem,
} from "unpdf";
import JSZip from "jszip";
import type ExcelJSNamespace from "exceljs";

import type { HarnessInputAttachmentPayload } from "./types.js";

type ExcelJSWorkbook = ExcelJSNamespace.Workbook;
type ExcelJSWorksheet = ExcelJSNamespace.Worksheet;
type ExcelJSCell = ExcelJSNamespace.Cell;

interface ExcelJSModule {
  Workbook: new () => ExcelJSWorkbook;
}

const nodeRequire = createRequire(import.meta.url);
const ExcelJS = nodeRequire("exceljs") as ExcelJSModule;

export interface HarnessInlineImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface HarnessAttachmentTextExtractionParams {
  attachment: HarnessInputAttachmentPayload;
  absolutePath: string;
  maxInlineTextBytes?: number;
}

export interface HarnessAttachmentTextExtractionResult {
  text: string;
  sourceByteLength: number;
  truncatedByByteLimit: boolean;
}

export interface HarnessDocumentAttachmentSectionParams extends HarnessAttachmentTextExtractionParams {
  promptPath?: string;
  maxExtractedTextChars?: number;
  maxExcerptLines?: number;
}

export interface HarnessDocumentAttachmentSectionResult {
  section: string;
  extractedTextChars: number;
  truncated: boolean;
}

export interface HarnessInlineImageAttachmentParams {
  attachment: HarnessInputAttachmentPayload;
  absolutePath: string;
  maxInlineImageBytes?: number;
}

export const DEFAULT_HARNESS_MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_HARNESS_MAX_INLINE_TEXT_BYTES = 128 * 1024;
export const DEFAULT_HARNESS_MAX_EXTRACTED_TEXT_CHARS = 120_000;
export const DEFAULT_HARNESS_MAX_EXCERPT_LINES = 400;
const DEFAULT_HARNESS_MAX_PDF_IMAGE_SCAN_PAGES = 20;
const DEFAULT_HARNESS_MAX_PDF_RENDERED_PAGE_PREVIEWS = 1;
const MAX_PDF_METADATA_ENTRIES = 80;
const MAX_PDF_LINKS = 200;
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/x-sh",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/sql",
]);

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cfg",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".kt",
  ".log",
  ".lua",
  ".md",
  ".mdx",
  ".mjs",
  ".php",
  ".pl",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svg",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const PDF_ATTACHMENT_MIME_TYPES = new Set(["application/pdf"]);
const DOCX_ATTACHMENT_MIME_TYPES = new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
const PPTX_ATTACHMENT_MIME_TYPES = new Set(["application/vnd.openxmlformats-officedocument.presentationml.presentation"]);
const EXCEL_ATTACHMENT_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

function isTextLikeAttachment(attachment: HarnessInputAttachmentPayload): boolean {
  const mimeType = attachment.mime_type.trim().toLowerCase();
  if (mimeType.startsWith("text/") || TEXT_ATTACHMENT_MIME_TYPES.has(mimeType)) {
    return true;
  }
  return TEXT_ATTACHMENT_EXTENSIONS.has(path.extname(attachment.name).toLowerCase());
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 1024)).includes(0);
}

export function detectHarnessInlineImageMimeType(
  bytes: Uint8Array,
): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function truncateExtractedText(text: string, maxExtractedTextChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxExtractedTextChars) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, maxExtractedTextChars),
    truncated: true,
  };
}

function truncateExtractedTextLines(
  text: string,
  maxExcerptLines: number,
): { text: string; truncated: boolean; lineCount: number } {
  const lines = text.split("\n");
  if (lines.length <= maxExcerptLines) {
    return { text, truncated: false, lineCount: lines.length };
  }
  return {
    text: lines.slice(0, maxExcerptLines).join("\n"),
    truncated: true,
    lineCount: maxExcerptLines,
  };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeWorkbookCellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.hyperlink === "string" && typeof obj.text === "string") {
      return obj.text;
    }
    if ("formula" in obj || "sharedFormula" in obj) {
      if (obj.result !== undefined && obj.result !== null) {
        return normalizeWorkbookCellText(obj.result);
      }
      return "";
    }
    if (Array.isArray(obj.richText)) {
      return obj.richText
        .map((segment) => {
          if (segment && typeof segment === "object" && "text" in segment) {
            const segmentText = (segment as { text?: unknown }).text;
            return typeof segmentText === "string" ? segmentText : "";
          }
          return "";
        })
        .join("");
    }
    if ("error" in obj) {
      return typeof obj.error === "string" ? obj.error : "";
    }
    if (typeof obj.text === "string") {
      return obj.text;
    }
  }
  return String(value);
}

function readWorksheetCellText(cell: ExcelJSCell): string {
  const value = cell.value;
  if (value === null || value === undefined) {
    return "";
  }
  const fromValue = normalizeWorkbookCellText(value);
  if (fromValue.length > 0) {
    return fromValue;
  }
  if (typeof cell.text === "string" && cell.text.length > 0) {
    return cell.text;
  }
  return fromValue;
}

function workbookRowsFromWorksheet(worksheet: ExcelJSWorksheet): string[][] {
  const rowCount = worksheet.rowCount;
  const columnCount = worksheet.columnCount;
  if (rowCount <= 0 || columnCount <= 0) {
    return [];
  }
  const rows: string[][] = [];
  for (let rowIndex = 1; rowIndex <= rowCount; rowIndex += 1) {
    const row = worksheet.getRow(rowIndex);
    const cells: string[] = [];
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      cells.push(readWorksheetCellText(row.getCell(columnIndex)));
    }
    rows.push(cells);
  }
  return rows;
}

function isPdfAttachment(attachment: HarnessInputAttachmentPayload): boolean {
  const lowerName = attachment.name.toLowerCase();
  return PDF_ATTACHMENT_MIME_TYPES.has(attachment.mime_type.toLowerCase()) || lowerName.endsWith(".pdf");
}

function isDocxAttachment(attachment: HarnessInputAttachmentPayload): boolean {
  const lowerName = attachment.name.toLowerCase();
  return DOCX_ATTACHMENT_MIME_TYPES.has(attachment.mime_type.toLowerCase()) || lowerName.endsWith(".docx");
}

function isPptxAttachment(attachment: HarnessInputAttachmentPayload): boolean {
  const lowerName = attachment.name.toLowerCase();
  return PPTX_ATTACHMENT_MIME_TYPES.has(attachment.mime_type.toLowerCase()) || lowerName.endsWith(".pptx");
}

function isExcelAttachment(attachment: HarnessInputAttachmentPayload): boolean {
  const lowerName = attachment.name.toLowerCase();
  return (
    EXCEL_ATTACHMENT_MIME_TYPES.has(attachment.mime_type.toLowerCase()) ||
    lowerName.endsWith(".xlsx") ||
    lowerName.endsWith(".xls")
  );
}

function buildAttachmentXmlPromptPath(attachment: HarnessInputAttachmentPayload): string {
  return `./${attachment.workspace_path}`;
}

function serializePdfValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pdfRecordEntries(record: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!record) {
    return [];
  }
  return Object.entries(record)
    .map(([key, value]) => [key, serializePdfValue(value)] as [string, string])
    .filter(([, value]) => value.length > 0);
}

function pdfMetadataEntries(metadata: unknown): Array<[string, string]> {
  if (!metadata || typeof metadata !== "object") {
    return [];
  }
  const iterable = metadata as Partial<Iterable<unknown>>;
  if (typeof iterable[Symbol.iterator] === "function") {
    const entries: Array<[string, string]> = [];
    for (const entry of metadata as Iterable<unknown>) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const key = serializePdfValue(entry[0]);
        const value = serializePdfValue(entry[1]);
        if (key && value) {
          entries.push([key, value]);
        }
      }
    }
    return entries;
  }
  return pdfRecordEntries(metadata as Record<string, unknown>);
}

function formatPdfMetadataSection(
  infoEntries: Array<[string, string]>,
  metadataEntries: Array<[string, string]>,
): string {
  const lines = ['<metadata>'];
  const limitedInfoEntries = infoEntries.slice(0, MAX_PDF_METADATA_ENTRIES);
  const limitedMetadataEntries = metadataEntries.slice(0, MAX_PDF_METADATA_ENTRIES);

  if (limitedInfoEntries.length > 0) {
    lines.push('<info>');
    for (const [key, value] of limitedInfoEntries) {
      lines.push(`<entry key="${escapeXmlAttribute(key)}">${escapeXmlText(value)}</entry>`);
    }
    lines.push('</info>');
  }
  if (limitedMetadataEntries.length > 0) {
    lines.push('<xmp>');
    for (const [key, value] of limitedMetadataEntries) {
      lines.push(`<entry key="${escapeXmlAttribute(key)}">${escapeXmlText(value)}</entry>`);
    }
    lines.push('</xmp>');
  }
  if (infoEntries.length > limitedInfoEntries.length || metadataEntries.length > limitedMetadataEntries.length) {
    lines.push(
      `<truncated info_entries="${infoEntries.length}" xmp_entries="${metadataEntries.length}" max_entries="${MAX_PDF_METADATA_ENTRIES}" />`,
    );
  }
  lines.push('</metadata>');
  return lines.join("\n");
}

function summarizeStructuredTextItems(items: StructuredTextItem[]): string {
  const fontFamilies = [...new Set(items.map((item) => item.fontFamily).filter(Boolean))].slice(0, 12);
  const directions = [...new Set(items.map((item) => item.dir).filter(Boolean))].slice(0, 4);
  const eolCount = items.filter((item) => item.hasEOL).length;
  return [
    `items="${items.length}"`,
    `line_breaks="${eolCount}"`,
    fontFamilies.length > 0 ? `fonts="${escapeXmlAttribute(fontFamilies.join(", "))}"` : null,
    directions.length > 0 ? `directions="${escapeXmlAttribute(directions.join(", "))}"` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizePdfPageText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

async function extractPdfAttachmentText(buffer: Buffer, fileName: string): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const lines = [`<pdf filename="${escapeXmlAttribute(fileName)}" pages="${pdf.numPages}">`];

    try {
      const meta = await getMeta(pdf, { parseDates: true });
      const infoEntries = pdfRecordEntries(meta.info);
      const xmpEntries = pdfMetadataEntries(meta.metadata);
      if (infoEntries.length > 0 || xmpEntries.length > 0) {
        lines.push(formatPdfMetadataSection(infoEntries, xmpEntries));
      }
    } catch (error) {
      lines.push(`<metadata error="${escapeXmlAttribute(error instanceof Error ? error.message : String(error))}" />`);
    }

    try {
      const linkResult = await extractLinks(pdf);
      const links = linkResult.links.slice(0, MAX_PDF_LINKS);
      lines.push(`<links total="${linkResult.links.length}" pages="${linkResult.totalPages}">`);
      for (let index = 0; index < links.length; index += 1) {
        lines.push(`<link index="${index + 1}">${escapeXmlText(links[index])}</link>`);
      }
      if (linkResult.links.length > links.length) {
        lines.push(`<truncated max_links="${MAX_PDF_LINKS}" />`);
      }
      lines.push('</links>');
    } catch (error) {
      lines.push(`<links error="${escapeXmlAttribute(error instanceof Error ? error.message : String(error))}" />`);
    }

    const textResult = await extractText(pdf, { mergePages: false });
    const structuredTextResult = await extractTextItems(pdf);
    lines.push(`<pages total="${textResult.totalPages}">`);
    for (let index = 0; index < textResult.text.length; index += 1) {
      const pageNumber = index + 1;
      const pageText = normalizePdfPageText(textResult.text[index] ?? "");
      const textItems = structuredTextResult.items[index] ?? [];
      lines.push(`<page number="${pageNumber}">`);
      lines.push(`<text_item_summary ${summarizeStructuredTextItems(textItems)} />`);
      lines.push(`<text>${escapeXmlText(pageText)}</text>`);
      lines.push('</page>');
    }
    lines.push('</pages>');

    const imageScanPages = Math.min(pdf.numPages, DEFAULT_HARNESS_MAX_PDF_IMAGE_SCAN_PAGES);
    lines.push(`<embedded_images scanned_pages="${imageScanPages}" total_pages="${pdf.numPages}">`);
    let imageCount = 0;
    for (let pageNumber = 1; pageNumber <= imageScanPages; pageNumber += 1) {
      try {
        const images = await extractImages(pdf, pageNumber);
        imageCount += images.length;
        lines.push(`<page number="${pageNumber}" count="${images.length}">`);
        for (const image of images) {
          lines.push(
            `<image key="${escapeXmlAttribute(image.key)}" width="${image.width}" height="${image.height}" channels="${image.channels}" bytes="${image.data.byteLength}" />`,
          );
        }
        lines.push('</page>');
      } catch (error) {
        lines.push(
          `<page number="${pageNumber}" error="${escapeXmlAttribute(error instanceof Error ? error.message : String(error))}" />`,
        );
      }
    }
    if (imageScanPages < pdf.numPages) {
      lines.push(`<skipped_pages count="${pdf.numPages - imageScanPages}" />`);
    }
    lines.push(`<summary total_images="${imageCount}" />`);
    lines.push('</embedded_images>');

    const renderedPagePreviews = Math.min(pdf.numPages, DEFAULT_HARNESS_MAX_PDF_RENDERED_PAGE_PREVIEWS);
    lines.push(`<rendered_pages scanned_pages="${renderedPagePreviews}" total_pages="${pdf.numPages}">`);
    for (let pageNumber = 1; pageNumber <= renderedPagePreviews; pageNumber += 1) {
      try {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const image = await renderPageAsImage(pdf, pageNumber, {
          width: 320,
          canvasImport: () => import("@napi-rs/canvas"),
        });
        lines.push(
          `<page number="${pageNumber}" source_width="${Math.round(viewport.width)}" source_height="${Math.round(viewport.height)}" rendered_width="320" bytes="${image.byteLength}" format="image/png" />`,
        );
      } catch (error) {
        lines.push(
          `<page number="${pageNumber}" error="${escapeXmlAttribute(error instanceof Error ? error.message : String(error))}" />`,
        );
      }
    }
    lines.push('</rendered_pages>');

    lines.push("</pdf>");
    return normalizeExtractedText(lines.join("\n"));
  } finally {
    await pdf.destroy();
  }
}

async function extractDocxAttachmentText(buffer: Buffer, fileName: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) {
    throw new Error(`DOCX document XML not found for ${fileName}`);
  }
  const paragraphs = documentXml.match(/<w:p[\s\S]*?<\/w:p>/g) ?? [];
  const lines = paragraphs
    .map((paragraph) => {
      const matches = [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)];
      return decodeXmlEntities(matches.map((match) => match[1] ?? "").join("")).trim();
    })
    .filter((line) => line.length > 0);
  const extractedText = `<docx filename="${escapeXmlAttribute(fileName)}">\n<page number="1">\n${lines.join("\n")}\n</page>\n</docx>`;
  return normalizeExtractedText(extractedText);
}

async function extractPptxAttachmentText(buffer: Buffer, fileName: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  let extractedText = `<pptx filename="${escapeXmlAttribute(fileName)}">`;
  for (let index = 0; index < slideFiles.length; index += 1) {
    const slideFile = zip.file(slideFiles[index]);
    if (!slideFile) {
      continue;
    }
    const slideXml = await slideFile.async("text");
    const matches = [...slideXml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)];
    const slideText = matches.map((match) => decodeXmlEntities(match[1] ?? "").trim()).filter(Boolean).join("\n");
    if (!slideText) {
      continue;
    }
    extractedText += `\n<slide number="${index + 1}">\n${slideText}\n</slide>`;
  }
  extractedText += "\n</pptx>";
  return normalizeExtractedText(extractedText);
}

async function extractExcelAttachmentText(buffer: Buffer, fileName: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await (workbook.xlsx.load as unknown as (data: Uint8Array) => Promise<ExcelJSWorkbook>)(buffer);
  let extractedText = `<excel filename="${escapeXmlAttribute(fileName)}">`;
  workbook.worksheets.forEach((worksheet, index) => {
    const worksheetRows = workbookRowsFromWorksheet(worksheet);
    const csvRows: string[] = [];
    for (const row of worksheetRows) {
      const cells = [...row];
      let lastNonEmptyIndex = cells.length - 1;
      while (lastNonEmptyIndex >= 0 && cells[lastNonEmptyIndex] === "") {
        lastNonEmptyIndex -= 1;
      }
      const normalized = cells.slice(0, lastNonEmptyIndex + 1);
      if (normalized.length > 0) {
        csvRows.push(
          normalized
            .map((raw) => (
              /[",\n\r]/.test(raw)
                ? `"${raw.replace(/"/g, "\"\"")}"`
                : raw
            ))
            .join(","),
        );
      }
    }

    extractedText += `\n<sheet name="${escapeXmlAttribute(worksheet.name)}" index="${index}">\n${csvRows.join("\n").trim()}\n</sheet>`;
  });
  extractedText += "\n</excel>";
  return normalizeExtractedText(extractedText);
}

export function buildHarnessAttachmentPromptPath(attachment: HarnessInputAttachmentPayload): string {
  return buildAttachmentXmlPromptPath(attachment);
}

export function buildHarnessAttachmentFallbackPromptLine(
  attachment: HarnessInputAttachmentPayload,
  promptPath = buildHarnessAttachmentPromptPath(attachment),
): string {
  const label =
    attachment.kind === "image"
      ? "image"
      : attachment.kind === "folder"
        ? "folder"
        : "file";
  return `- ${attachment.name} (${label}, ${attachment.mime_type}) at ${promptPath}`;
}

export function isHarnessFolderAttachment(attachment: HarnessInputAttachmentPayload): boolean {
  return attachment.kind === "folder" || attachment.mime_type.trim().toLowerCase() === "inode/directory";
}

export async function extractHarnessAttachmentTextDetails(
  params: HarnessAttachmentTextExtractionParams,
): Promise<HarnessAttachmentTextExtractionResult | null> {
  const {
    attachment,
    absolutePath,
    maxInlineTextBytes = DEFAULT_HARNESS_MAX_INLINE_TEXT_BYTES,
  } = params;
  const buffer = fs.readFileSync(absolutePath);

  if (isPdfAttachment(attachment)) {
    const text = await extractPdfAttachmentText(buffer, attachment.name);
    return text
      ? {
          text,
          sourceByteLength: buffer.length,
          truncatedByByteLimit: false,
        }
      : null;
  }
  if (isDocxAttachment(attachment)) {
    const text = await extractDocxAttachmentText(buffer, attachment.name);
    return text
      ? {
          text,
          sourceByteLength: buffer.length,
          truncatedByByteLimit: false,
        }
      : null;
  }
  if (isPptxAttachment(attachment)) {
    const text = await extractPptxAttachmentText(buffer, attachment.name);
    return text
      ? {
          text,
          sourceByteLength: buffer.length,
          truncatedByByteLimit: false,
        }
      : null;
  }
  if (isExcelAttachment(attachment)) {
    try {
      const text = await extractExcelAttachmentText(buffer, attachment.name);
      return text
        ? {
            text,
            sourceByteLength: buffer.length,
            truncatedByByteLimit: false,
          }
        : null;
    } catch {
      return null;
    }
  }
  if (!isTextLikeAttachment(attachment) || isBinaryBuffer(buffer)) {
    return null;
  }

  const truncated = buffer.length > maxInlineTextBytes;
  const text = normalizeExtractedText(buffer.subarray(0, maxInlineTextBytes).toString("utf8"));
  if (!text) {
    return {
      text: "[file is empty]",
      sourceByteLength: buffer.length,
      truncatedByByteLimit: false,
    };
  }
  return {
    text,
    sourceByteLength: buffer.length,
    truncatedByByteLimit: truncated,
  };
}

export async function extractHarnessAttachmentText(
  params: HarnessAttachmentTextExtractionParams,
): Promise<string | null> {
  return (await extractHarnessAttachmentTextDetails(params))?.text ?? null;
}

export async function buildHarnessDocumentAttachmentSection(
  params: HarnessDocumentAttachmentSectionParams,
): Promise<HarnessDocumentAttachmentSectionResult | null> {
  const {
    attachment,
    absolutePath,
    promptPath = buildHarnessAttachmentPromptPath(attachment),
    maxExtractedTextChars = DEFAULT_HARNESS_MAX_EXTRACTED_TEXT_CHARS,
    maxInlineTextBytes,
    maxExcerptLines = DEFAULT_HARNESS_MAX_EXCERPT_LINES,
  } = params;
  if (isHarnessFolderAttachment(attachment)) {
    return null;
  }
  const extractedText = await extractHarnessAttachmentTextDetails({
    attachment,
    absolutePath,
    maxInlineTextBytes,
  });
  if (!extractedText) {
    return null;
  }
  const truncatedChars = truncateExtractedText(
    extractedText.text,
    maxExtractedTextChars,
  );
  const truncatedLines = truncateExtractedTextLines(
    truncatedChars.text,
    maxExcerptLines,
  );
  const noticeLines: string[] = [];
  if (extractedText.truncatedByByteLimit || truncatedChars.truncated || truncatedLines.truncated) {
    noticeLines.push(
      `[excerpted for prompt size: ${truncatedLines.lineCount} line(s), ${truncatedLines.text.length} char(s), source ${extractedText.sourceByteLength} byte(s)]`,
    );
    noticeLines.push(
      `Use the read tool on ${promptPath} with line selectors or offset/limit to inspect the remainder.`,
    );
  }
  return {
    section: [
      `[Document: ${attachment.name}]`,
      `Mime-Type: ${attachment.mime_type}`,
      `Workspace Path: ${promptPath}`,
      ...(noticeLines.length > 0 ? ["Excerpt Policy:", ...noticeLines] : []),
      "",
      truncatedLines.text.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
    extractedTextChars: truncatedLines.text.length,
    truncated:
      extractedText.truncatedByByteLimit ||
      truncatedChars.truncated ||
      truncatedLines.truncated,
  };
}

export async function inlineHarnessDocumentAttachmentSection(
  params: HarnessDocumentAttachmentSectionParams,
): Promise<string | null> {
  return (await buildHarnessDocumentAttachmentSection(params))?.section ?? null;
}

export function inlineHarnessImageAttachment(
  params: HarnessInlineImageAttachmentParams,
): HarnessInlineImageContent | null {
  const {
    attachment,
    absolutePath,
    maxInlineImageBytes = DEFAULT_HARNESS_MAX_INLINE_IMAGE_BYTES,
  } = params;
  if (attachment.kind !== "image" && !attachment.mime_type.startsWith("image/")) {
    return null;
  }
  const buffer = fs.readFileSync(absolutePath);
  if (buffer.length > maxInlineImageBytes) {
    return null;
  }
  const mimeType = detectHarnessInlineImageMimeType(buffer);
  if (!mimeType || !SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(mimeType)) {
    return null;
  }
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType,
  };
}

const CLI_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS = 12_000;
const CLI_ATTACHMENT_MAX_EXCERPT_LINES = 400;

export interface HarnessCliAttachmentInput {
  /** Inlined image blocks (base64). Populated only when `inlineImages`. */
  images: HarnessInlineImageContent[];
  /** Remote http(s) image URLs to pass through as URL image sources. Populated only when `inlineImages`. */
  remoteImageUrls: string[];
  /**
   * Text to append to the instruction: document excerpts, file/folder path
   * references, and — when `inlineImages` is false — image references and
   * image-URL labels too, so a text-only harness still learns of every
   * attachment.
   */
  textLines: string[];
}

export interface RenderHarnessCliAttachmentsParams {
  attachments: HarnessInputAttachmentPayload[] | undefined;
  imageUrls: string[] | undefined;
  /** Roots to resolve `workspace_path` against, in priority order (workspace dir, then agent cwd). */
  roots: string[];
  /**
   * Vision-capable harness (e.g. Claude stream-json): images are inlined as
   * image content and remote image URLs are surfaced for URL image sources.
   * Text-only harness (e.g. Codex app-server, which has no image input item):
   * every attachment is rendered as text/path so nothing is silently dropped.
   */
  inlineImages: boolean;
  maxInlineImageBytes?: number;
  maxExtractedTextChars?: number;
  maxExcerptLines?: number;
}

/**
 * Resolve an attachment's `workspace_path` against candidate roots. Staged
 * attachments live under the workspace dir; @-mention attachments may live
 * under the agent cwd — try each, preferring one that exists on disk. A
 * containment guard rejects paths that escape a root via `..`. Returns the
 * first in-bounds candidate (so a downstream read surfaces a real ENOENT
 * rather than a silent miss), or null if every candidate escapes its root.
 */
export function resolveHarnessAttachmentAbsolutePath(
  roots: string[],
  workspacePath: string,
): string | null {
  let firstResolved: string | null = null;
  for (const root of roots) {
    if (!root) {
      continue;
    }
    const base = path.resolve(root);
    const resolved = path.resolve(base, workspacePath);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      continue;
    }
    if (firstResolved === null) {
      firstResolved = resolved;
    }
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return firstResolved;
}

/** Decode a `data:image/...;base64,...` URL into an inline image, or null. */
export function decodeHarnessImageDataUrl(
  dataUrl: string,
  maxInlineImageBytes = DEFAULT_HARNESS_MAX_INLINE_IMAGE_BYTES,
): HarnessInlineImageContent | null {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  const declaredMime = (match[1] ?? "").trim().toLowerCase();
  if (!declaredMime.startsWith("image/")) {
    return null;
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(match[2] ?? "", "base64");
  } catch {
    return null;
  }
  if (buffer.length === 0 || buffer.length > maxInlineImageBytes) {
    return null;
  }
  const mimeType = detectHarnessInlineImageMimeType(buffer);
  if (!mimeType || !SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(mimeType)) {
    return null;
  }
  return { type: "image", data: buffer.toString("base64"), mimeType };
}

function harnessImageUrlLabel(imageUrl: string, index: number): string {
  if (/^data:/i.test(imageUrl)) {
    return `[Image ${index + 1}] (inline data URL)`;
  }
  try {
    return `[Image ${index + 1}] ${new URL(imageUrl).toString()}`;
  } catch {
    return `[Image ${index + 1}] ${imageUrl}`;
  }
}

/**
 * Render a request's attachments + image_urls into the pieces a spawned CLI
 * harness can consume: inline image blocks (vision harnesses), remote image
 * URLs, and instruction text (document excerpts + path references). Reuses
 * the per-attachment helpers above so behavior matches the in-process path.
 */
export async function renderHarnessCliAttachments(
  params: RenderHarnessCliAttachmentsParams,
): Promise<HarnessCliAttachmentInput> {
  const {
    attachments = [],
    imageUrls = [],
    roots,
    inlineImages,
    maxInlineImageBytes = DEFAULT_HARNESS_MAX_INLINE_IMAGE_BYTES,
    maxExtractedTextChars = CLI_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS,
    maxExcerptLines = CLI_ATTACHMENT_MAX_EXCERPT_LINES,
  } = params;

  const images: HarnessInlineImageContent[] = [];
  const remoteImageUrls: string[] = [];
  const textLines: string[] = [];

  for (const attachment of attachments) {
    const promptPath = buildHarnessAttachmentPromptPath(attachment);
    const absolutePath = resolveHarnessAttachmentAbsolutePath(
      roots,
      attachment.workspace_path,
    );
    const exists = Boolean(absolutePath && fs.existsSync(absolutePath));
    const isImage =
      attachment.kind === "image" ||
      attachment.mime_type.trim().toLowerCase().startsWith("image/");

    if (inlineImages && isImage && absolutePath && exists) {
      const image = inlineHarnessImageAttachment({
        attachment,
        absolutePath,
        maxInlineImageBytes,
      });
      if (image) {
        images.push(image);
        continue;
      }
      // Inline failed (too large / unsupported codec) — fall through so the
      // agent at least gets a path reference.
    }

    if (!isHarnessFolderAttachment(attachment) && absolutePath && exists) {
      try {
        const section = await buildHarnessDocumentAttachmentSection({
          attachment,
          absolutePath,
          promptPath,
          maxExtractedTextChars,
          maxExcerptLines,
        });
        if (section) {
          textLines.push(section.section);
          continue;
        }
      } catch {
        // Extraction failure (corrupt PDF, etc.) — fall through to a path ref.
      }
    }

    textLines.push(buildHarnessAttachmentFallbackPromptLine(attachment, promptPath));
  }

  imageUrls.forEach((imageUrl, index) => {
    const trimmed = imageUrl.trim();
    if (!trimmed) {
      return;
    }
    if (inlineImages) {
      if (/^data:/i.test(trimmed)) {
        const image = decodeHarnessImageDataUrl(trimmed, maxInlineImageBytes);
        if (image) {
          images.push(image);
          return;
        }
      } else if (/^https?:\/\//i.test(trimmed)) {
        remoteImageUrls.push(trimmed);
        return;
      }
      // Other schemes (file:, etc.) — fall through to a text label.
    }
    textLines.push(harnessImageUrlLabel(trimmed, index));
  });

  return { images, remoteImageUrls, textLines };
}
