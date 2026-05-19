import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "HtmlPreviewFrame.tsx");

test("html preview frame injects a click bridge into sandboxed srcDoc content", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /export const HTML_PREVIEW_LINK_MESSAGE_TYPE =\s*"holaboss:html-preview-link";/);
  assert.match(source, /const CONTENT_SECURITY_POLICY_META_PATTERN =/);
  assert.match(source, /const HTML_PREVIEW_CSP = \[/);
  assert.match(source, /const HTML_PREVIEW_BRIDGE = \[/);
  assert.match(source, /const scrollToHash = \(rawHref\) => \{/);
  assert.match(source, /window\.addEventListener\('hashchange', \(\) => \{/);
  assert.match(source, /window\.addEventListener\('DOMContentLoaded', \(\) => \{/);
  assert.match(source, /document\.scrollingElement \?\? document\.documentElement \?\? document\.body/);
  assert.match(source, /const top = scrollElement\.scrollTop \+ \(targetRect\.top - scrollRect\.top\);/);
  assert.match(source, /scrollElement\.scrollTo\(\{/);
  assert.match(source, /window\.parent\.postMessage\(\{ type: messageType, href \}, "\*"\);/);
  assert.match(source, /event\.source !== iframeRef\.current\?\.contentWindow/);
  assert.match(source, /window\.addEventListener\("message", handlePreviewMessage\);/);
  assert.match(source, /window\.removeEventListener\("message", handlePreviewMessage\);/);
  assert.match(source, /sandbox="allow-scripts"/);
  assert.match(source, /srcDoc=\{srcDoc\}/);
});

test("html preview frame routes external links to the browser and workspace paths locally", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /function normalizeHttpUrl\(rawHref: string \| null \| undefined\): string \| null/);
  assert.match(source, /if \(parsed\.protocol === "http:" \|\| parsed\.protocol === "https:"\)/);
  assert.match(source, /if \(href\.startsWith\('#'\)\) \{/);
  assert.match(source, /scrollToHash\(href\);/);
  assert.match(source, /onOpenLinkInBrowser\?\.\(normalizedHttpHref\);/);
  assert.match(source, /onOpenLocalLink\?\.\(href\);/);
  assert.match(source, /export function buildHtmlPreviewSrcDoc\(rawHtml: string\): string/);
  assert.match(source, /rawHtml\.replace\(\s*CONTENT_SECURITY_POLICY_META_PATTERN,/);
});
