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

import type { HarnessInputAttachmentPayload } from "./types.js";

interface XlsxPopulateRange {
  value(): unknown;
}

interface XlsxPopulateWorksheet {
  name(): string;
  usedRange(): XlsxPopulateRange | undefined;
}

interface XlsxPopulateWorkbook {
  sheets(): XlsxPopulateWorksheet[];
}

interface XlsxPopulateStatic {
  fromDataAsync(data: Buffer | Uint8Array | ArrayBuffer): Promise<XlsxPopulateWorkbook>;
}

const nodeRequire = createRequire(import.meta.url);
const XlsxPopulate = nodeRequire("xlsx-populate") as XlsxPopulateStatic;

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

export interface HarnessDocumentAttachmentSectionParams extends HarnessAttachmentTextExtractionParams {
  promptPath?: string;
  maxExtractedTextChars?: number;
}

export interface HarnessInlineImageAttachmentParams {
  attachment: HarnessInputAttachmentPayload;
  absolutePath: string;
  maxInlineImageBytes?: number;
}

export const DEFAULT_HARNESS_MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_HARNESS_MAX_INLINE_TEXT_BYTES = 128 * 1024;
export const DEFAULT_HARNESS_MAX_EXTRACTED_TEXT_CHARS = 120_000;
const DEFAULT_HARNESS_MAX_PDF_IMAGE_SCAN_PAGES = 20;
const DEFAULT_HARNESS_MAX_PDF_RENDERED_PAGE_PREVIEWS = 1;
const MAX_PDF_METADATA_ENTRIES = 80;
const MAX_PDF_LINKS = 200;

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

function truncateExtractedText(text: string, maxExtractedTextChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxExtractedTextChars) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, maxExtractedTextChars),
    truncated: true,
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
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (
    typeof value === "object" &&
    "text" in value &&
    typeof (value as { text?: unknown }).text === "function"
  ) {
    const textValue = (value as { text: () => unknown }).text();
    return typeof textValue === "string" ? textValue : String(textValue ?? "");
  }
  return String(value);
}

function workbookRowsFromUsedRange(range: XlsxPopulateRange | undefined): string[][] {
  if (!range) {
    return [];
  }

  const matrix = range.value();
  const rows = Array.isArray(matrix)
    ? matrix.map((row) => (Array.isArray(row) ? row : [row]))
    : [[matrix]];

  return rows.map((row) => row.map((cell) => normalizeWorkbookCellText(cell)));
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
  const workbook = await XlsxPopulate.fromDataAsync(buffer);
  let extractedText = `<excel filename="${escapeXmlAttribute(fileName)}">`;
  workbook.sheets().forEach((worksheet, index) => {
    const worksheetRows = workbookRowsFromUsedRange(worksheet.usedRange());
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

    extractedText += `\n<sheet name="${escapeXmlAttribute(worksheet.name())}" index="${index}">\n${csvRows.join("\n").trim()}\n</sheet>`;
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

export async function extractHarnessAttachmentText(params: HarnessAttachmentTextExtractionParams): Promise<string | null> {
  const {
    attachment,
    absolutePath,
    maxInlineTextBytes = DEFAULT_HARNESS_MAX_INLINE_TEXT_BYTES,
  } = params;
  const buffer = fs.readFileSync(absolutePath);

  if (isPdfAttachment(attachment)) {
    return await extractPdfAttachmentText(buffer, attachment.name);
  }
  if (isDocxAttachment(attachment)) {
    return await extractDocxAttachmentText(buffer, attachment.name);
  }
  if (isPptxAttachment(attachment)) {
    return await extractPptxAttachmentText(buffer, attachment.name);
  }
  if (isExcelAttachment(attachment)) {
    try {
      return await extractExcelAttachmentText(buffer, attachment.name);
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
    return "[file is empty]";
  }
  return truncated ? `${text}\n\n[truncated to first ${maxInlineTextBytes} bytes]` : text;
}

export async function inlineHarnessDocumentAttachmentSection(
  params: HarnessDocumentAttachmentSectionParams,
): Promise<string | null> {
  const {
    attachment,
    absolutePath,
    promptPath = buildHarnessAttachmentPromptPath(attachment),
    maxExtractedTextChars = DEFAULT_HARNESS_MAX_EXTRACTED_TEXT_CHARS,
    maxInlineTextBytes,
  } = params;
  if (isHarnessFolderAttachment(attachment)) {
    return null;
  }
  const extractedText = await extractHarnessAttachmentText({
    attachment,
    absolutePath,
    maxInlineTextBytes,
  });
  if (!extractedText) {
    return null;
  }
  const truncatedText = truncateExtractedText(extractedText, maxExtractedTextChars);
  const notice = truncatedText.truncated ? "\n[document text truncated for prompt size]" : "";
  return [
    `[Document: ${attachment.name}]`,
    `Mime-Type: ${attachment.mime_type}`,
    `Workspace Path: ${promptPath}`,
    "",
    `${truncatedText.text}${notice}`.trim(),
  ]
    .filter(Boolean)
    .join("\n");
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
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType: attachment.mime_type,
  };
}
