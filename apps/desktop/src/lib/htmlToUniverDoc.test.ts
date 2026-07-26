import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { htmlToUniverDocument } from "./htmlToUniverDoc.js";

// The converter reads DOMParser/Node at call time; wire up a spec-compliant
// DOM (jsdom mirrors the browser's HTML parsing) before any test runs.
const dom = new JSDOM("");
(globalThis as unknown as { DOMParser: unknown }).DOMParser =
  dom.window.DOMParser;
(globalThis as unknown as { Node: unknown }).Node = dom.window.Node;

function bodyOf(html: string) {
  const doc = htmlToUniverDocument(html);
  const body = doc.body;
  if (!body) {
    throw new Error("no body");
  }
  return body;
}

test("terminates paragraphs with \\r and ends with a section break", () => {
  const body = bodyOf("<p>Hello</p><p>World</p>");
  assert.equal(body.dataStream, "Hello\rWorld\r\n");
  for (const paragraph of body.paragraphs ?? []) {
    assert.equal(body.dataStream[paragraph.startIndex], "\r");
  }
});

test("maps headings to namedStyleType", () => {
  const body = bodyOf("<h1>Title</h1><h2>Sub</h2><p>Body</p>");
  assert.equal(body.paragraphs?.[0]?.paragraphStyle?.namedStyleType, 4);
  assert.equal(body.paragraphs?.[1]?.paragraphStyle?.namedStyleType, 5);
  assert.equal(body.paragraphs?.[2]?.paragraphStyle, undefined);
});

test("captures bold, italic, and underline as text runs over the right range", () => {
  const body = bodyOf(
    "<p>a <strong>bold</strong> <em>it</em> <u>ul</u></p>",
  );
  const text = body.dataStream;
  const bold = body.textRuns?.find((run) => run.ts?.bl === 1);
  const italic = body.textRuns?.find((run) => run.ts?.it === 1);
  const underline = body.textRuns?.find((run) => run.ts?.ul?.s === 1);
  assert.equal(bold && text.slice(bold.st, bold.ed), "bold");
  assert.equal(italic && text.slice(italic.st, italic.ed), "it");
  assert.equal(underline && text.slice(underline.st, underline.ed), "ul");
});

test("flattens list items into paragraphs", () => {
  const body = bodyOf("<ul><li>one</li><li>two</li></ul>");
  assert.equal(body.dataStream, "one\rtwo\r\n");
  assert.equal(body.paragraphs?.length, 2);
});

test("maps paragraph alignment", () => {
  const body = bodyOf('<p style="text-align: center">Centered</p>');
  assert.equal(body.paragraphs?.[0]?.paragraphStyle?.horizontalAlign, 2);
});

test("produces one empty paragraph for empty input", () => {
  const body = bodyOf("");
  assert.equal(body.dataStream, "\r\n");
  assert.equal(body.paragraphs?.length, 1);
});

test("descends into nested containers without losing content", () => {
  const body = bodyOf("<div><p>nested</p></div>");
  assert.ok(body.dataStream.startsWith("nested\r"));
});

test("captures inline text color as a run color style", () => {
  const body = bodyOf('<p>a <span style="color:#2E75B6">blue</span></p>');
  const run = body.textRuns?.find((r) => r.ts?.cl?.rgb);
  assert.equal(run && body.dataStream.slice(run.st, run.ed), "blue");
  assert.equal(run?.ts?.cl?.rgb, "#2e75b6");
});

test("parses rgb() and 3-digit hex colors", () => {
  const body = bodyOf(
    '<p><span style="color: rgb(198, 40, 40)">r</span><span style="color:#0a0">g</span></p>',
  );
  const rgb = body.textRuns?.find(
    (r) => body.dataStream.slice(r.st, r.ed) === "r",
  );
  const short = body.textRuns?.find(
    (r) => body.dataStream.slice(r.st, r.ed) === "g",
  );
  assert.equal(rgb?.ts?.cl?.rgb, "#c62828");
  assert.equal(short?.ts?.cl?.rgb, "#00aa00");
});

test("propagates cell background as run background", () => {
  const body = bodyOf(
    '<table><tr><td style="background-color:#2E75B6"><strong>Head</strong></td></tr></table>',
  );
  const run = body.textRuns?.find(
    (r) => body.dataStream.slice(r.st, r.ed) === "Head",
  );
  assert.equal(run?.ts?.bg?.rgb, "#2e75b6");
  assert.equal(run?.ts?.bl, 1);
});

test("colors heading text from the heading element", () => {
  const body = bodyOf('<h2 style="color:#1565C0">Sub</h2>');
  const run = body.textRuns?.find((r) => r.ts?.cl?.rgb);
  assert.equal(run && body.dataStream.slice(run.st, run.ed), "Sub");
  assert.equal(run?.ts?.cl?.rgb, "#1565c0");
});

test("captures strikethrough from <s> and text-decoration", () => {
  const tag = bodyOf("<p><s>gone</s></p>");
  assert.equal(tag.textRuns?.find((r) => r.ts?.st)?.ts?.st?.s, 1);
  const css = bodyOf('<p><span style="text-decoration: line-through">x</span></p>');
  assert.equal(css.textRuns?.find((r) => r.ts?.st)?.ts?.st?.s, 1);
});
