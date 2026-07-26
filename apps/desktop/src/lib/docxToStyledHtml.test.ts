import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { ooxmlToStyledHtml } from "./docxToStyledHtml.js";
import { htmlToUniverDocument } from "./htmlToUniverDoc.js";

const dom = new JSDOM("");
(globalThis as unknown as { DOMParser: unknown }).DOMParser =
  dom.window.DOMParser;
(globalThis as unknown as { Node: unknown }).Node = dom.window.Node;

function doc(paragraphs: string): string {
  return `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`;
}

test("emits inline run color from w:color", () => {
  const html = ooxmlToStyledHtml(
    doc(
      '<w:p><w:r><w:rPr><w:color w:val="2E75B6"/></w:rPr><w:t>blue</w:t></w:r></w:p>',
    ),
    null,
  );
  assert.match(html, /color:#2e75b6/);
  assert.match(html, />blue</);
});

test("emits cell shading as td background", () => {
  const html = ooxmlToStyledHtml(
    doc(
      '<w:tbl><w:tr><w:tc><w:tcPr><w:shd w:fill="2E75B6"/></w:tcPr><w:p><w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr><w:t>Head</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ),
    null,
  );
  assert.match(html, /<td style="background-color:#2e75b6">/);
  assert.match(html, /color:#ffffff/);
});

test("inherits heading color from styles.xml when the run only carries bold", () => {
  const styles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading2"><w:rPr><w:color w:val="1565C0"/></w:rPr></w:style></w:styles>`;
  const html = ooxmlToStyledHtml(
    doc(
      '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Sub</w:t></w:r></w:p>',
    ),
    styles,
  );
  assert.match(html, /<h2>/);
  assert.match(html, /color:#1565c0/);
  assert.match(html, /<strong>/);
});

test("follows basedOn chains for inherited color", () => {
  const styles = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="character" w:styleId="Base"><w:rPr><w:color w:val="C62828"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Warn"><w:basedOn w:val="Base"/></w:style></w:styles>`;
  const html = ooxmlToStyledHtml(
    doc(
      '<w:p><w:pPr><w:pStyle w:val="Warn"/></w:pPr><w:r><w:t>alert</w:t></w:r></w:p>',
    ),
    styles,
  );
  assert.match(html, /color:#c62828/);
});

test("an explicit false toggle disables inherited bold", () => {
  const html = ooxmlToStyledHtml(
    doc('<w:p><w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t>plain</w:t></w:r></w:p>'),
    null,
  );
  assert.doesNotMatch(html, /<strong>/);
});

test("full chain: OOXML color reaches Univer run cl/bg", () => {
  const html = ooxmlToStyledHtml(
    doc(
      '<w:tbl><w:tr><w:tc><w:tcPr><w:shd w:fill="2E75B6"/></w:tcPr><w:p><w:r><w:rPr><w:color w:val="FFFFFF"/></w:rPr><w:t>Head</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    ),
    null,
  );
  const body = htmlToUniverDocument(html).body;
  const run = body?.textRuns?.find(
    (r) => body.dataStream.slice(r.st, r.ed) === "Head",
  );
  assert.equal(run?.ts?.cl?.rgb, "#ffffff");
  assert.equal(run?.ts?.bg?.rgb, "#2e75b6");
});
