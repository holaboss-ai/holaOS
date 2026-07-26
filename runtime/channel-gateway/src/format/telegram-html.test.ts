import { test } from "node:test";
import assert from "node:assert/strict";

import { markdownToTelegramHtml } from "./telegram-html.js";

test("escapes HTML-significant characters", () => {
  assert.equal(markdownToTelegramHtml("a < b & c > d"), "a &lt; b &amp; c &gt; d");
});

test("bold and italic map to Telegram tags", () => {
  assert.equal(markdownToTelegramHtml("**bold**"), "<b>bold</b>");
  assert.equal(markdownToTelegramHtml("an _italic_ word"), "an <i>italic</i> word");
});

test("inline code is wrapped and its contents escaped", () => {
  assert.equal(markdownToTelegramHtml("call `a<b>`"), "call <code>a&lt;b&gt;</code>");
});

test("fenced code block becomes pre/code with escaped body", () => {
  assert.equal(
    markdownToTelegramHtml("```\nx <y>\n```"),
    "<pre><code>x &lt;y&gt;\n</code></pre>",
  );
});

test("links become anchor tags", () => {
  assert.equal(
    markdownToTelegramHtml("[site](https://example.com)"),
    '<a href="https://example.com">site</a>',
  );
});

test("headings keep their text and bullets become dots", () => {
  assert.equal(markdownToTelegramHtml("## Title"), "Title");
  assert.equal(markdownToTelegramHtml("- item"), "• item");
});

test("empty input yields empty string", () => {
  assert.equal(markdownToTelegramHtml(""), "");
});
