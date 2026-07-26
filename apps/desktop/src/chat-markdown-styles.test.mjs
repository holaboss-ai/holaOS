import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "styles", "markdown.css");

test("chat markdown styles wrap long content without disabling code block scrolling", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /\.chat-markdown \{\s*max-width: 100%;[\s\S]*overflow-wrap: anywhere;[\s\S]*word-break: break-word;/);
  assert.match(source, /\.chat-user-markdown \{\s*font-size: var\(--text-base\);[\s\S]*line-height: 1\.6;/);
  assert.match(source, /\.chat-assistant-markdown \{\s*font-size: var\(--text-base\);[\s\S]*line-height: 1\.72;/);
  assert.match(source, /\.chat-thinking-markdown \{\s*font-size: var\(--text-xs\);[\s\S]*line-height: 1\.6;/);
  assert.match(source, /\.chat-markdown \.md-link,[\s\S]*\.chat-markdown \.md-table th \{\s*overflow-wrap: anywhere;[\s\S]*word-break: break-word;/);
  assert.match(source, /\.chat-markdown \.md-inline-code \{[\s\S]*background: color-mix\(in oklch, var\(--muted\) 68%, transparent\);[\s\S]*font-family: var\(--font-mono\);/);
  assert.match(source, /\.md-code-block-wrapper \{[\s\S]*background: color-mix\(in oklch, var\(--input\) 78%, var\(--background\) 22%\);[\s\S]*box-shadow: var\(--shadow-2xs\);/);
  assert.match(source, /\.simple-markdown \.md-code-block \{[\s\S]*overflow-x: auto;/);
  assert.match(source, /\.simple-markdown \.md-code-block > code \{[\s\S]*background: transparent;/);
  assert.match(source, /\.simple-markdown \.md-ul \{[\s\S]*list-style: disc;/);
  assert.match(source, /\.simple-markdown \.md-ol \{[\s\S]*list-style: decimal;/);
  assert.match(source, /\.chat-markdown \.md-h1 \{[\s\S]*font-size: var\(--text-xl\);[\s\S]*line-height: 1\.3;/);
  assert.match(source, /\.chat-markdown \.md-p:first-child,[\s\S]*\.chat-markdown \.md-table:first-child \{[\s\S]*margin-top: 0;/);
  assert.match(source, /\.chat-markdown \.md-p:last-child,[\s\S]*\.chat-markdown \.md-table:last-child \{[\s\S]*margin-bottom: 0;/);
});
