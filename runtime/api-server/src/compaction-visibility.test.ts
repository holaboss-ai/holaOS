import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * A failed end-of-turn compaction has to be readable somewhere.
 *
 * Compaction runs after the terminal event and its failure does not fail the
 * run, so pi's warning went to the ts-runner stderr this module "buffers and
 * only surfaces on failure" — written where nobody could read it. The cost is
 * not cosmetic: a failed compaction leaves the session uncompacted, so the next
 * turn is larger and likelier to fail the same way, and the first anyone learns
 * of it is a turn that blows the context window.
 *
 * The [ttft] line is the channel that does reach runtime.log on a successful
 * turn, which is why it carries this.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "runner-worker.ts"), "utf-8");

test("compaction failures are scraped from the live stderr stream", () => {
  // Scraped as chunks arrive, not from the buffered result: that result is
  // discarded on a successful run, which is exactly the case in question.
  assert.match(
    source,
    /for await \(const chunk of stderr\)[\s\S]{0,600}?pi end-of-turn compaction failed/,
    "the marker must be matched inside the stderr consumer loop",
  );
});

test("the failure reaches the [ttft] line", () => {
  assert.match(
    source,
    /compactionFailure \? ` compaction_failed=/,
    "a compaction failure must appear on the line that lands in runtime.log",
  );
});

test("a healthy turn stays quiet", () => {
  // Only failures are reported. `compaction=ok` on every turn would be noise,
  // and its absence is the normal case.
  assert.doesNotMatch(
    source,
    /compaction_failed=\$\{[^}]*\}`\s*\)/,
    "the field must be conditional, not unconditional",
  );
  assert.match(
    source,
    /let compactionFailure: string \| null = null;/,
    "null means no failure was seen this turn",
  );
});

test("the captured text is bounded", () => {
  // pi's message embeds an upstream error that could be arbitrarily long; an
  // unbounded slice of it would run away with the log line.
  assert.match(source, /\.slice\(0, 200\)/);
});
