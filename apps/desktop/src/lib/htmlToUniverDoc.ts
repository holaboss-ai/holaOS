/**
 * htmlToUniverDoc — converts mammoth-rendered docx HTML into a Univer
 * `IDocumentData` snapshot. Univer ships no importable HTML→doc converter,
 * so we build the document model by hand: a `dataStream` of text with each
 * paragraph terminated by `\r` (and a trailing `\n` section break), plus
 * `paragraphs` marking the breaks (headings/alignment) and `textRuns`
 * annotating inline ranges (bold/italic/underline).
 *
 * Runs in the renderer (uses DOMParser). Tables are flattened to paragraphs
 * and images are dropped — a documented fidelity limit of the HTML bridge.
 */

import type {
  IDocumentBody,
  IDocumentData,
  IParagraph,
  ITextRun,
  ITextStyle,
} from "@univerjs/core";

// Univer enum values inlined (verified against @univerjs/core 0.25).
const NAMED_STYLE = {
  NORMAL: 1,
  TITLE: 2,
  HEADING_1: 4,
  HEADING_2: 5,
  HEADING_3: 6,
  HEADING_4: 7,
  HEADING_5: 8,
} as const;
const H_ALIGN = { left: 1, center: 2, right: 3, justify: 4 } as const;
const BOOL_TRUE = 1;
const DOCUMENT_FLAVOR_MODERN = 2;
// Page margins (px in Univer's doc coordinate space) so text isn't flush
// against the pane edges.
const PAGE_MARGIN = { top: 48, bottom: 48, left: 56, right: 56 } as const;
const PARAGRAPH_MARK = "\r";
const SECTION_MARK = "\n";

const HEADING_TAGS: Record<string, number> = {
  h1: NAMED_STYLE.HEADING_1,
  h2: NAMED_STYLE.HEADING_2,
  h3: NAMED_STYLE.HEADING_3,
  h4: NAMED_STYLE.HEADING_4,
  h5: NAMED_STYLE.HEADING_5,
  h6: NAMED_STYLE.HEADING_5,
};
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "td",
  "th",
]);

interface InlineStyleState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** "#RRGGBB" foreground color, inherited down the inline tree. */
  color?: string;
  /** "#RRGGBB" run background (docx run/cell shading). */
  background?: string;
  /** Font size in points. */
  fontSizePt?: number;
}

const EMPTY_INLINE_STYLE: InlineStyleState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
};

// CSS color (hex or rgb()) → "#rrggbb". Returns undefined for unparseable /
// transparent values so we never emit an empty color style.
function cssColorToHex(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (!value || value === "transparent" || value === "inherit") {
    return undefined;
  }
  const hex = value.match(/^#([0-9a-f]{6})$/);
  if (hex) {
    return `#${hex[1]}`;
  }
  const short = value.match(/^#([0-9a-f]{3})$/);
  if (short) {
    const [r, g, b] = short[1];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgb) {
    const toHex = (n: string) =>
      Math.min(255, Number.parseInt(n, 10)).toString(16).padStart(2, "0");
    return `#${toHex(rgb[1])}${toHex(rgb[2])}${toHex(rgb[3])}`;
  }
  return undefined;
}

// Read the presentational overrides an element carries in its inline `style`
// (and <font color>), so both block seeds (headings/cells) and inline spans
// contribute color/shading/size.
function readStyleOverrides(element: Element): Partial<InlineStyleState> {
  const out: Partial<InlineStyleState> = {};
  const style = element.getAttribute("style") ?? "";
  const color = cssColorToHex(
    style.match(/(?:^|;)\s*color:\s*([^;]+)/i)?.[1] ??
      element.getAttribute("color") ??
      undefined,
  );
  if (color) {
    out.color = color;
  }
  const background = cssColorToHex(
    style.match(/background(?:-color)?:\s*([^;]+)/i)?.[1] ?? undefined,
  );
  if (background) {
    out.background = background;
  }
  const decoration = style.match(/text-decoration[^:]*:\s*([^;]+)/i)?.[1] ?? "";
  if (/line-through/i.test(decoration)) {
    out.strike = true;
  }
  if (/underline/i.test(decoration)) {
    out.underline = true;
  }
  const weight = style.match(/font-weight:\s*([^;]+)/i)?.[1]?.trim();
  if (weight && (weight === "bold" || Number.parseInt(weight, 10) >= 600)) {
    out.bold = true;
  }
  const size = style.match(/font-size:\s*([\d.]+)pt/i)?.[1];
  if (size) {
    out.fontSizePt = Number.parseFloat(size);
  }
  return out;
}

class DocumentBuilder {
  private text = "";
  readonly paragraphs: IParagraph[] = [];
  readonly textRuns: ITextRun[] = [];

  appendRun(content: string, style: InlineStyleState) {
    if (!content) {
      return;
    }
    const start = this.text.length;
    this.text += content;
    const ts = inlineStyleToTextStyle(style);
    if (ts) {
      this.textRuns.push({ st: start, ed: this.text.length, ts });
    }
  }

  endParagraph(namedStyleType: number, align?: number) {
    const startIndex = this.text.length;
    this.text += PARAGRAPH_MARK;
    const paragraph: IParagraph = { startIndex };
    if (namedStyleType !== NAMED_STYLE.NORMAL || align) {
      paragraph.paragraphStyle = {
        ...(namedStyleType !== NAMED_STYLE.NORMAL
          ? { namedStyleType }
          : {}),
        ...(align ? { horizontalAlign: align } : {}),
      };
    }
    this.paragraphs.push(paragraph);
  }

  hasContent(): boolean {
    return this.paragraphs.length > 0;
  }

  build(): IDocumentBody {
    return {
      dataStream: `${this.text}${SECTION_MARK}`,
      paragraphs: this.paragraphs,
      textRuns: this.textRuns,
    };
  }
}

function inlineStyleToTextStyle(
  style: InlineStyleState,
): ITextStyle | undefined {
  const ts: ITextStyle = {};
  if (style.bold) {
    ts.bl = BOOL_TRUE;
  }
  if (style.italic) {
    ts.it = BOOL_TRUE;
  }
  if (style.underline) {
    ts.ul = { s: BOOL_TRUE };
  }
  if (style.strike) {
    ts.st = { s: BOOL_TRUE };
  }
  if (style.color) {
    ts.cl = { rgb: style.color };
  }
  if (style.background) {
    ts.bg = { rgb: style.background };
  }
  if (style.fontSizePt) {
    ts.fs = style.fontSizePt;
  }
  return Object.keys(ts).length > 0 ? ts : undefined;
}

function readAlignment(element: Element): number | undefined {
  const align =
    element.getAttribute("align") ??
    element.getAttribute("style")?.match(/text-align:\s*(\w+)/)?.[1];
  return align ? H_ALIGN[align as keyof typeof H_ALIGN] : undefined;
}

function walkInline(
  node: Node,
  style: InlineStyleState,
  builder: DocumentBuilder,
) {
  if (node.nodeType === Node.TEXT_NODE) {
    builder.appendRun(node.textContent ?? "", style);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return;
  }
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (tag === "br") {
    builder.appendRun(" ", style);
    return;
  }
  const overrides = readStyleOverrides(element);
  const nextStyle: InlineStyleState = {
    bold: style.bold || overrides.bold || tag === "strong" || tag === "b",
    italic: style.italic || overrides.italic || tag === "em" || tag === "i",
    underline: style.underline || overrides.underline || tag === "u",
    strike:
      style.strike ||
      overrides.strike ||
      tag === "s" ||
      tag === "strike" ||
      tag === "del",
    color: overrides.color ?? style.color,
    background: overrides.background ?? style.background,
    fontSizePt: overrides.fontSizePt ?? style.fontSizePt,
  };
  for (const child of Array.from(element.childNodes)) {
    walkInline(child, nextStyle, builder);
  }
}

function walkBlock(element: Element, builder: DocumentBuilder) {
  const tag = element.tagName.toLowerCase();

  // Recurse into containers that hold other blocks rather than inline text.
  if (
    tag === "ul" ||
    tag === "ol" ||
    tag === "table" ||
    tag === "thead" ||
    tag === "tbody" ||
    tag === "tr" ||
    tag === "div" ||
    tag === "section" ||
    tag === "article"
  ) {
    for (const child of Array.from(element.children)) {
      walkBlock(child, builder);
    }
    return;
  }

  if (BLOCK_TAGS.has(tag)) {
    // Seed the inline walk from the block's own color/shading so heading
    // colors (on <h2>) and cell shading (on <td style="background:...">)
    // reach the runs inside — docx keeps those at the paragraph/cell level.
    const baseStyle: InlineStyleState = {
      ...EMPTY_INLINE_STYLE,
      ...readStyleOverrides(element),
    };
    for (const child of Array.from(element.childNodes)) {
      walkInline(child, baseStyle, builder);
    }
    builder.endParagraph(HEADING_TAGS[tag] ?? NAMED_STYLE.NORMAL, readAlignment(element));
    return;
  }

  // Unknown wrapper — descend so we don't lose nested content.
  for (const child of Array.from(element.children)) {
    walkBlock(child, builder);
  }
}

export function htmlToUniverDocument(
  html: string,
  id = "univer-doc-preview",
): IDocumentData {
  const parsed = new DOMParser().parseFromString(html ?? "", "text/html");
  const builder = new DocumentBuilder();
  for (const child of Array.from(parsed.body.children)) {
    walkBlock(child, builder);
  }
  // Guarantee at least one paragraph so Univer renders an empty page cleanly.
  if (!builder.hasContent()) {
    builder.endParagraph(NAMED_STYLE.NORMAL);
  }

  return {
    id,
    body: builder.build(),
    documentStyle: {
      documentFlavor: DOCUMENT_FLAVOR_MODERN,
      marginTop: PAGE_MARGIN.top,
      marginBottom: PAGE_MARGIN.bottom,
      marginLeft: PAGE_MARGIN.left,
      marginRight: PAGE_MARGIN.right,
    },
  };
}
