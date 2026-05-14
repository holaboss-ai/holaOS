import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "SimpleMarkdown.tsx");
const normalizationPath = path.join(__dirname, "markdownFenceNormalization.mjs");

test("simple markdown uses react-markdown with gfm and safe defaults", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /import ReactMarkdown, \{ defaultUrlTransform, type Components \} from "react-markdown";/);
  assert.match(source, /import remarkGfm from "remark-gfm";/);
  assert.match(source, /import \{ normalizeWrappedMarkdownFence \} from "\.\/markdownFenceNormalization\.mjs";/);
  assert.match(source, /remarkPlugins=\{\[remarkGfm\]\}/);
  assert.match(source, /skipHtml/);
  assert.match(source, /urlTransform=\{\(url\) => \{/);
  assert.match(source, /if \(url\.startsWith\(MENTION_URL_SCHEME\)\) \{/);
  assert.match(source, /return defaultUrlTransform\(url\);/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /export function renderMarkdown/);
});

test("simple markdown preserves the md-* styling hooks used by chat and marketplace", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /onLinkClick\?: \(url: string\) => void;/);
  assert.match(source, /onLocalLinkClick\?: \(href: string\) => void;/);
  assert.match(source, /const normalizedHttpHref = normalizeHttpUrl\(rawHref\);/);
  assert.match(source, /const isAnchor = rawHref\.startsWith\("#"\);/);
  assert.match(source, /event\.preventDefault\(\);\s*onLinkClick\(normalizedHttpHref\);/);
  assert.match(source, /event\.preventDefault\(\);\s*onLocalLinkClick\(localHref\);/);
  assert.match(source, /className=\{appendClassName\(className, "md-link"\)\}/);
  assert.match(source, /className=\{appendClassName\(className, "md-blockquote"\)\}/);
  assert.match(source, /className=\{appendClassName\(className, "md-inline-code"\)\}/);
  assert.match(source, /className=\{appendClassName\(className, "md-table"\)\}/);
  assert.match(source, /className=\{appendClassName\(className, "md-ul"\)\}/);
  assert.match(source, /className=\{appendClassName\(className, "md-ol"\)\}/);
  assert.match(source, /className=\{appendClassName\(className, "md-li md-oli"\)\}/);
  assert.match(source, /className=\{`simple-markdown \$\{className\}`\.trim\(\)\}/);
  assert.match(source, /target=\{isHttpHref \? "_blank" : undefined\}/);
  assert.match(source, /rel="noopener noreferrer"/);
});

test("simple markdown memoizes renderer components to keep chat content stable during parent rerenders", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /import \{[\s\S]*memo,[\s\S]*useCallback,[\s\S]*useMemo,[\s\S]*useRef,[\s\S]*type ReactNode,[\s\S]*\} from "react";/);
  assert.match(
    source,
    /const normalizedChildren = useMemo\(\s*\(\) => normalizeWrappedMarkdownFence\(children\),\s*\[children\],\s*\);/,
  );
  assert.match(
    source,
    /const components = useMemo\(\s*\(\) =>[\s\S]*createMarkdownComponents\([\s\S]*onLinkClick,[\s\S]*onLocalLinkClick,[\s\S]*handleAnchorClick,[\s\S]*renderMention,[\s\S]*\),[\s\S]*\[handleAnchorClick, onLinkClick, onLocalLinkClick, renderMention\],\s*\);/,
  );
  assert.match(source, /const rootRef = useRef<HTMLDivElement \| null>\(null\);/);
  assert.match(source, /<ReactMarkdown[\s\S]*>\s*\{normalizedChildren\}\s*<\/ReactMarkdown>/);
  assert.match(source, /export const SimpleMarkdown = memo\(SimpleMarkdownComponent\);/);
});

test("simple markdown adds heading ids and handles in-document anchor navigation", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const STANDALONE_HTML_ANCHOR_PATTERN =/);
  assert.match(source, /const FENCED_BLOCK_PATTERN =/);
  assert.match(source, /function markdownHeadingTextToPlainText\(rawText: string\): string/);
  assert.match(source, /function slugifyHeadingText\(rawText: string\): string/);
  assert.match(source, /function plainTextFromNode\(node: ReactNode\): string/);
  assert.match(source, /function resolveHeadingId\(/);
  assert.match(source, /function buildMarkdownAnchorAliasMap\(\s*markdown: string,\s*\): Map<string, string>/);
  assert.match(source, /const fenceMatch = trimmedLine\.match\(FENCED_BLOCK_PATTERN\);/);
  assert.match(source, /aliases\.set\(anchorId, resolvedHeadingId\);/);
  assert.match(source, /createElement\(tag, \{/);
  assert.match(source, /id: resolveHeadingId\(props, headingSlugCounts\),/);
  assert.match(source, /const explicitAnchorAliases = useMemo\(\s*\(\) => buildMarkdownAnchorAliasMap\(normalizedChildren\),/);
  assert.match(source, /const handleAnchorClick = useCallback\(\(href: string\) => \{/);
  assert.match(source, /const rawTargetId = decodeAnchorHref\(href\);/);
  assert.match(source, /const targetId = explicitAnchorAliases\.get\(rawTargetId\) \?\? rawTargetId;/);
  assert.match(source, /scrollElementWithinContainer\(scrollContainer, target\);/);
  assert.match(source, /if \(isAnchor && onAnchorClick\) \{/);
});

test("markdown fence normalization repairs wrapped markdown that contains nested code fences", async () => {
  const { normalizeWrappedMarkdownFence } = await import(pathToFileURL(normalizationPath).href);

  const broken = [
    "Draft preview:",
    "",
    "```md",
    "# AGENTS.md",
    "",
    "```csv",
    "name,value",
    "```",
    "",
    "```",
    "",
    "Confirm before writing it to disk.",
  ].join("\n");

  const normalized = normalizeWrappedMarkdownFence(broken);

  assert.match(normalized, /````md/);
  assert.match(normalized, /name,value/);
  assert.match(normalized, /\n````\n\nConfirm before writing it to disk\.$/);
});

test("markdown fence normalization leaves separate markdown and csv blocks unchanged", async () => {
  const { normalizeWrappedMarkdownFence } = await import(pathToFileURL(normalizationPath).href);

  const separateBlocks = [
    "```md",
    "# AGENTS.md",
    "```",
    "",
    "```csv",
    "name,value",
    "```",
  ].join("\n");

  assert.equal(normalizeWrappedMarkdownFence(separateBlocks), separateBlocks);
});
