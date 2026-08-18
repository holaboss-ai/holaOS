import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "CodeBlock.tsx"), "utf8");

/**
 * STRUCTURAL guard. CodeBlock is a React component with a shiki dependency and
 * DOM observers, and the repo has no React test renderer — so the behaviour
 * (highlight once when the text settles, share one theme observer) is not
 * reachable from a unit test here. These pin the three properties that made it
 * expensive, each of which is a small edit away from coming back.
 */

test("highlighting is keyed on settled text, not the live body", () => {
  // The cache key contains the whole body. Keyed on the live text, every
  // streamed character was a miss that also stored an entry — re-tokenizing
  // each frame and filling a 200-entry FIFO with throwaway partials.
  assert.match(
    source,
    /const cacheKey = `\$\{theme\}:\$\{resolvedLanguage\}:\$\{settledCode\}`/,
    "the highlight cache key is back on the live body",
  );
  assert.match(
    source,
    /await codeToHtml\(settledCode,/,
    "highlighting no longer runs on the settled text",
  );
});

test("a streaming block never renders a stale highlight", () => {
  // Two distinct staleness sources, and checking only one leaves a visible
  // flash:
  //
  //   settledCode === trimmed   — the body has stopped growing. Without it a
  //                               streaming block freezes at an earlier frame.
  //   highlighted.key === cacheKey — the HTML belongs to THIS text. Without it
  //                               the commit in which settledCode catches up
  //                               paints the previous, shorter body, because
  //                               the clearing effect has not run yet.
  assert.match(
    source,
    /highlighted\?\.key === cacheKey && settledCode === trimmed \? \(/,
    "highlighted HTML is rendered without checking it matches the current text",
  );
});

test("one theme observer is shared across code blocks", () => {
  // A long conversation renders many CodeBlocks; each used to observe
  // <html> itself for a signal that changes a handful of times per session.
  assert.match(source, /function subscribeShikiTheme\(/);
  assert.match(source, /useEffect\(\(\) => subscribeShikiTheme\(setTheme\), \[\]\)/);

  const observers = source.match(/new MutationObserver\(/g) ?? [];
  assert.equal(
    observers.length,
    1,
    `expected exactly one MutationObserver construction, found ${observers.length}`,
  );
  // …and it must be released when the last block unmounts.
  assert.match(source, /rootThemeObserver\?\.disconnect\(\)/);
});

test("cached and freshly computed highlights both carry their key", () => {
  // Storing bare HTML is what allowed a commit to paint the previous body's
  // highlight, so both writers have to record the key it was produced for.
  assert.match(
    source,
    /setHighlighted\(\{ key: cacheKey, html: cached \}\)/,
    "the cache hit path stores HTML without its key",
  );
  assert.match(
    source,
    /setHighlighted\(\{ key: cacheKey, html \}\)/,
    "the freshly highlighted path stores HTML without its key",
  );
  assert.match(
    source,
    /dangerouslySetInnerHTML=\{\{ __html: highlighted\.html \}\}/,
  );
});
