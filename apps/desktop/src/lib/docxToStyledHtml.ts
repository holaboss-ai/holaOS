/**
 * docxToStyledHtml — converts a .docx (OOXML) into styled HTML that preserves
 * text color and shading, which `htmlToUniverDoc` then turns into a colored
 * Univer document.
 *
 * We do this instead of mammoth because mammoth emits *semantic* HTML and
 * deliberately drops presentational run color (`w:color`) and shading
 * (`w:shd`) — the exact styling this bridge needs. Crucially, heading and
 * quote colors live in `styles.xml` (the run only carries `<w:b/>`), so we
 * resolve the style table and merge it under each run's inline `w:rPr`.
 *
 * Tables are emitted as `<table>` (htmlToUniverDoc flattens cells to
 * paragraphs) and images/drawings are dropped — the documented fidelity limit
 * of the HTML bridge, unchanged here.
 */

import JSZip from "jszip";

interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string; // "#RRGGBB"
  background?: string; // "#RRGGBB"
  fontSizePt?: number;
}

const HEADING_TAG_BY_STYLE_ID: Record<string, string> = {
  Title: "h1",
  Heading1: "h1",
  Heading2: "h2",
  Heading3: "h3",
  Heading4: "h4",
  Heading5: "h5",
  Heading6: "h6",
};

const HIGHLIGHT_HEX: Record<string, string> = {
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  red: "#ff0000",
  blue: "#0000ff",
  darkyellow: "#808000",
  darkgreen: "#008000",
  darkred: "#800000",
  darkblue: "#000080",
  lightgray: "#d3d3d3",
  darkgray: "#a9a9a9",
};

function childrenByLocal(el: Element, local: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === local);
}

function childByLocal(el: Element, local: string): Element | null {
  return Array.from(el.children).find((c) => c.localName === local) ?? null;
}

// OOXML attributes are namespaced (`w:val`); match by local name so we don't
// depend on the `w` prefix.
function attrByLocal(el: Element, local: string): string | null {
  for (const attribute of Array.from(el.attributes)) {
    if (attribute.localName === local) {
      return attribute.value;
    }
  }
  return null;
}

function normalizeHex(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const v = value.trim().toLowerCase();
  if (!v || v === "auto") {
    return undefined;
  }
  return /^[0-9a-f]{6}$/.test(v) ? `#${v}` : undefined;
}

// An OOXML boolean toggle (`<w:b/>`, `<w:b w:val="false"/>`): present means on
// unless it carries an explicit false.
function readToggle(rPr: Element, local: string): boolean | undefined {
  const el = childByLocal(rPr, local);
  if (!el) {
    return undefined;
  }
  const val = attrByLocal(el, "val");
  return val !== "false" && val !== "0" && val !== "off";
}

function readRunProps(rPr: Element | null): RunProps {
  if (!rPr) {
    return {};
  }
  const props: RunProps = {};
  const bold = readToggle(rPr, "b");
  if (bold !== undefined) {
    props.bold = bold;
  }
  const italic = readToggle(rPr, "i");
  if (italic !== undefined) {
    props.italic = italic;
  }
  const strike = readToggle(rPr, "strike");
  if (strike !== undefined) {
    props.strike = strike;
  }
  const u = childByLocal(rPr, "u");
  if (u) {
    props.underline = attrByLocal(u, "val") !== "none";
  }
  const color = childByLocal(rPr, "color");
  if (color) {
    props.color = normalizeHex(attrByLocal(color, "val"));
  }
  const shd = childByLocal(rPr, "shd");
  if (shd) {
    props.background = normalizeHex(attrByLocal(shd, "fill"));
  }
  const highlight = childByLocal(rPr, "highlight");
  if (highlight) {
    const name = attrByLocal(highlight, "val")?.toLowerCase() ?? "";
    if (HIGHLIGHT_HEX[name]) {
      props.background = HIGHLIGHT_HEX[name];
    }
  }
  const sz = childByLocal(rPr, "sz");
  if (sz) {
    const half = Number.parseInt(attrByLocal(sz, "val") ?? "", 10);
    if (Number.isFinite(half) && half > 0) {
      props.fontSizePt = half / 2; // half-points → points
    }
  }
  return props;
}

function mergeRunProps(base: RunProps, over: RunProps): RunProps {
  const out: RunProps = { ...base };
  for (const key of Object.keys(over) as (keyof RunProps)[]) {
    const value = over[key];
    if (value !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: homogeneous keyed copy
      (out as any)[key] = value;
    }
  }
  return out;
}

interface StyleDef {
  basedOn: string | null;
  rPr: RunProps;
  outlineHeadingTag: string | null;
}

// Resolve `styles.xml` into a styleId → run-property map, following `basedOn`
// chains so a run that only says `w:pStyle="Heading2"` inherits the blue color
// the theme defined on that style.
function buildStyleTable(stylesXml: string | null): {
  runPropsFor: (styleId: string | null) => RunProps;
  headingTagFor: (styleId: string | null) => string | null;
  quoteStyleIds: Set<string>;
} {
  const defs = new Map<string, StyleDef>();
  let docDefaultRun: RunProps = {};

  if (stylesXml) {
    const doc = new DOMParser().parseFromString(stylesXml, "application/xml");
    const root = doc.documentElement;
    const docDefaults = childByLocal(root, "docDefaults");
    if (docDefaults) {
      const rPrDefault = childByLocal(docDefaults, "rPrDefault");
      const rPr = rPrDefault ? childByLocal(rPrDefault, "rPr") : null;
      docDefaultRun = readRunProps(rPr);
    }
    for (const style of childrenByLocal(root, "style")) {
      const id = attrByLocal(style, "styleId");
      if (!id) {
        continue;
      }
      const basedOnEl = childByLocal(style, "basedOn");
      defs.set(id, {
        basedOn: basedOnEl ? attrByLocal(basedOnEl, "val") : null,
        rPr: readRunProps(childByLocal(style, "rPr")),
        outlineHeadingTag: HEADING_TAG_BY_STYLE_ID[id] ?? null,
      });
    }
  }

  const resolveCache = new Map<string, RunProps>();
  function resolveRun(styleId: string | null, seen: Set<string>): RunProps {
    if (!styleId || !defs.has(styleId) || seen.has(styleId)) {
      return {};
    }
    const cached = resolveCache.get(styleId);
    if (cached) {
      return cached;
    }
    seen.add(styleId);
    const def = defs.get(styleId) as StyleDef;
    const base = resolveRun(def.basedOn, seen);
    const merged = mergeRunProps(base, def.rPr);
    resolveCache.set(styleId, merged);
    return merged;
  }

  return {
    runPropsFor: (styleId) =>
      mergeRunProps(docDefaultRun, resolveRun(styleId, new Set())),
    headingTagFor: (styleId) =>
      styleId ? (HEADING_TAG_BY_STYLE_ID[styleId] ?? null) : null,
    quoteStyleIds: new Set(["Quote", "IntenseQuote"]),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function runPropsToInlineHtml(text: string, props: RunProps): string {
  if (!text) {
    return "";
  }
  const styles: string[] = [];
  if (props.color) {
    styles.push(`color:${props.color}`);
  }
  if (props.background) {
    styles.push(`background-color:${props.background}`);
  }
  if (props.fontSizePt) {
    styles.push(`font-size:${props.fontSizePt}pt`);
  }
  let html = escapeHtml(text);
  if (props.strike) {
    html = `<s>${html}</s>`;
  }
  if (props.underline) {
    html = `<u>${html}</u>`;
  }
  if (props.italic) {
    html = `<em>${html}</em>`;
  }
  if (props.bold) {
    html = `<strong>${html}</strong>`;
  }
  return styles.length > 0 ? `<span style="${styles.join(";")}">${html}</span>` : html;
}

interface StyleTable {
  runPropsFor: (styleId: string | null) => RunProps;
  headingTagFor: (styleId: string | null) => string | null;
  quoteStyleIds: Set<string>;
}

function renderRun(run: Element, baseProps: RunProps): string {
  const props = mergeRunProps(baseProps, readRunProps(childByLocal(run, "rPr")));
  let out = "";
  for (const node of Array.from(run.children)) {
    if (node.localName === "t") {
      out += runPropsToInlineHtml(node.textContent ?? "", props);
    } else if (node.localName === "tab") {
      out += runPropsToInlineHtml("\t", props);
    } else if (node.localName === "br" || node.localName === "cr") {
      out += "<br />";
    }
  }
  return out;
}

function renderParagraphInline(paragraph: Element, baseProps: RunProps): string {
  let out = "";
  for (const child of Array.from(paragraph.children)) {
    if (child.localName === "r") {
      out += renderRun(child, baseProps);
    } else if (child.localName === "hyperlink") {
      for (const run of childrenByLocal(child, "r")) {
        out += renderRun(run, baseProps);
      }
    }
  }
  return out;
}

const ALIGN_CSS: Record<string, string> = {
  center: "center",
  right: "right",
  both: "justify",
  distribute: "justify",
  left: "left",
};

function renderParagraph(paragraph: Element, styles: StyleTable): string {
  const pPr = childByLocal(paragraph, "pPr");
  const pStyleEl = pPr ? childByLocal(pPr, "pStyle") : null;
  const resolvedStyleId = pStyleEl ? attrByLocal(pStyleEl, "val") : null;

  const baseProps = styles.runPropsFor(resolvedStyleId);
  const inner = renderParagraphInline(paragraph, baseProps);

  const isList = Boolean(pPr && childByLocal(pPr, "numPr"));
  const headingTag = styles.headingTagFor(resolvedStyleId);
  const isQuote = resolvedStyleId
    ? styles.quoteStyleIds.has(resolvedStyleId)
    : false;

  const jc = pPr ? childByLocal(pPr, "jc") : null;
  const align = jc ? (ALIGN_CSS[attrByLocal(jc, "val") ?? ""] ?? "") : "";
  const styleAttr = align ? ` style="text-align:${align}"` : "";

  // Empty paragraph → keep a spacing line.
  const body = inner || "&#8203;";
  if (isList) {
    return `<ul><li${styleAttr}>${body}</li></ul>`;
  }
  if (headingTag) {
    return `<${headingTag}${styleAttr}>${body}</${headingTag}>`;
  }
  if (isQuote) {
    return `<blockquote${styleAttr}>${body}</blockquote>`;
  }
  return `<p${styleAttr}>${body}</p>`;
}

function renderTable(table: Element, styles: StyleTable): string {
  let rows = "";
  for (const row of childrenByLocal(table, "tr")) {
    let cells = "";
    for (const cell of childrenByLocal(row, "tc")) {
      const tcPr = childByLocal(cell, "tcPr");
      const shd = tcPr ? childByLocal(tcPr, "shd") : null;
      const fill = shd ? normalizeHex(attrByLocal(shd, "fill")) : undefined;
      const styleAttr = fill ? ` style="background-color:${fill}"` : "";
      let content = "";
      for (const paragraph of childrenByLocal(cell, "p")) {
        content += renderParagraphInline(
          paragraph,
          styles.runPropsFor(
            (() => {
              const pPr = childByLocal(paragraph, "pPr");
              const pStyle = pPr ? childByLocal(pPr, "pStyle") : null;
              return pStyle ? attrByLocal(pStyle, "val") : null;
            })(),
          ),
        );
      }
      cells += `<td${styleAttr}>${content || "&#8203;"}</td>`;
    }
    rows += `<tr>${cells}</tr>`;
  }
  return `<table>${rows}</table>`;
}

/** Pure OOXML → styled HTML. Exposed for unit testing. */
export function ooxmlToStyledHtml(
  documentXml: string,
  stylesXml: string | null,
): string {
  const styles = buildStyleTable(stylesXml);
  const doc = new DOMParser().parseFromString(documentXml, "application/xml");
  const body = childByLocal(doc.documentElement, "body");
  if (!body) {
    return "";
  }
  const parts: string[] = [];
  for (const block of Array.from(body.children)) {
    if (block.localName === "p") {
      parts.push(renderParagraph(block, styles));
    } else if (block.localName === "tbl") {
      parts.push(renderTable(block, styles));
    }
  }
  return parts.join("");
}

/** Unzip a .docx and convert its body to styled HTML. */
export async function docxBytesToStyledHtml(
  bytes: Uint8Array,
): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file("word/document.xml")?.async("text");
  if (!documentXml) {
    throw new Error("docx has no word/document.xml");
  }
  const stylesXml = (await zip.file("word/styles.xml")?.async("text")) ?? null;
  return ooxmlToStyledHtml(documentXml, stylesXml);
}
