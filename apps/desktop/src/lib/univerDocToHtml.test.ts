import test from "node:test";
import assert from "node:assert/strict";
import type { IDocumentBody } from "@univerjs/core";

import { univerDocumentBodyToHtml } from "./univerDocToHtml.js";

test("renders paragraphs terminated by \\r", () => {
  const body: IDocumentBody = {
    dataStream: "Hello\rWorld\r\n",
    paragraphs: [{ startIndex: 5 }, { startIndex: 11 }],
    textRuns: [],
  };
  assert.equal(univerDocumentBodyToHtml(body), "<p>Hello</p><p>World</p>");
});

test("maps namedStyleType back to heading tags", () => {
  const body: IDocumentBody = {
    dataStream: "Title\rSub\r\n",
    paragraphs: [
      { startIndex: 5, paragraphStyle: { namedStyleType: 4 } },
      { startIndex: 9, paragraphStyle: { namedStyleType: 5 } },
    ],
    textRuns: [],
  };
  assert.equal(univerDocumentBodyToHtml(body), "<h1>Title</h1><h2>Sub</h2>");
});

test("wraps bold/italic/underline runs", () => {
  const body: IDocumentBody = {
    dataStream: "a bold c\r\n",
    paragraphs: [{ startIndex: 8 }],
    textRuns: [{ st: 2, ed: 6, ts: { bl: 1 } }],
  };
  assert.equal(univerDocumentBodyToHtml(body), "<p>a <strong>bold</strong> c</p>");
});

test("combines multiple inline styles on one run", () => {
  const body: IDocumentBody = {
    dataStream: "x\r\n",
    paragraphs: [{ startIndex: 1 }],
    textRuns: [{ st: 0, ed: 1, ts: { bl: 1, it: 1, ul: { s: 1 } } }],
  };
  assert.equal(
    univerDocumentBodyToHtml(body),
    "<p><strong><em><u>x</u></em></strong></p>",
  );
});

test("emits text-align style for aligned paragraphs", () => {
  const body: IDocumentBody = {
    dataStream: "mid\r\n",
    paragraphs: [{ startIndex: 3, paragraphStyle: { horizontalAlign: 2 } }],
    textRuns: [],
  };
  assert.equal(
    univerDocumentBodyToHtml(body),
    '<p style="text-align:center">mid</p>',
  );
});

test("escapes HTML-special characters", () => {
  const body: IDocumentBody = {
    dataStream: "a < b & c > d\r\n",
    paragraphs: [{ startIndex: 13 }],
    textRuns: [],
  };
  assert.equal(
    univerDocumentBodyToHtml(body),
    "<p>a &lt; b &amp; c &gt; d</p>",
  );
});

test("handles an empty paragraph", () => {
  const body: IDocumentBody = {
    dataStream: "\r\n",
    paragraphs: [{ startIndex: 0 }],
    textRuns: [],
  };
  assert.equal(univerDocumentBodyToHtml(body), "<p></p>");
});
