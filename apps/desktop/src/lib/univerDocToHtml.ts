/**
 * univerDocToHtml — the inverse of htmlToUniverDoc. Serializes a Univer
 * `IDocumentBody` (dataStream + paragraphs + textRuns) back into HTML, which
 * the main process then hands to `html-to-docx` to persist edits. Pure string
 * logic — no DOM — so it's fully unit-testable.
 *
 * Lists are emitted as paragraphs (the forward pass already flattened them),
 * a documented round-trip limit of the HTML bridge.
 */

import type { IDocumentBody, ITextRun, ITextStyle } from "@univerjs/core";

const HEADING_TAG_BY_STYLE: Record<number, string> = {
  2: "h1", // TITLE
  4: "h1",
  5: "h2",
  6: "h3",
  7: "h4",
  8: "h5",
};
const ALIGN_BY_VALUE: Record<number, string> = {
  2: "center",
  3: "right",
  4: "justify",
};
const PARAGRAPH_MARK = "\r";

export function univerDocumentBodyToHtml(body: IDocumentBody): string {
  const dataStream = body.dataStream ?? "";
  const paragraphs = body.paragraphs ?? [];
  const textRuns = body.textRuns ?? [];

  const parts: string[] = [];
  let rangeStart = 0;
  for (const paragraph of paragraphs) {
    const rangeEnd = paragraph.startIndex;
    const inner = renderInline(dataStream, rangeStart, rangeEnd, textRuns);
    const tag =
      HEADING_TAG_BY_STYLE[paragraph.paragraphStyle?.namedStyleType ?? 0] ?? "p";
    const align = ALIGN_BY_VALUE[paragraph.paragraphStyle?.horizontalAlign ?? 0];
    const styleAttr = align ? ` style="text-align:${align}"` : "";
    parts.push(`<${tag}${styleAttr}>${inner}</${tag}>`);
    // Skip the paragraph mark itself.
    rangeStart = rangeEnd + PARAGRAPH_MARK.length;
  }
  return parts.join("");
}

function renderInline(
  dataStream: string,
  rangeStart: number,
  rangeEnd: number,
  textRuns: ITextRun[],
): string {
  const relevant = textRuns
    .filter((run) => run.ed > rangeStart && run.st < rangeEnd)
    .sort((a, b) => a.st - b.st);

  let html = "";
  let cursor = rangeStart;
  for (const run of relevant) {
    const segStart = Math.max(run.st, rangeStart);
    const segEnd = Math.min(run.ed, rangeEnd);
    if (segStart > cursor) {
      html += escapeHtml(dataStream.slice(cursor, segStart));
    }
    html += wrapInline(escapeHtml(dataStream.slice(segStart, segEnd)), run.ts);
    cursor = segEnd;
  }
  if (cursor < rangeEnd) {
    html += escapeHtml(dataStream.slice(cursor, rangeEnd));
  }
  return html;
}

function wrapInline(inner: string, style: ITextStyle | undefined): string {
  if (!style) {
    return inner;
  }
  let result = inner;
  if (style.st?.s === 1) {
    result = `<s>${result}</s>`;
  }
  if (style.ul?.s === 1) {
    result = `<u>${result}</u>`;
  }
  if (style.it === 1) {
    result = `<em>${result}</em>`;
  }
  if (style.bl === 1) {
    result = `<strong>${result}</strong>`;
  }
  const cssParts: string[] = [];
  if (style.cl?.rgb) {
    cssParts.push(`color:${style.cl.rgb}`);
  }
  if (style.bg?.rgb) {
    cssParts.push(`background-color:${style.bg.rgb}`);
  }
  if (style.fs) {
    cssParts.push(`font-size:${style.fs}pt`);
  }
  return cssParts.length > 0
    ? `<span style="${cssParts.join(";")}">${result}</span>`
    : result;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
