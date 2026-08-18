import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "index.tsx"), "utf-8");

/**
 * STRUCTURAL guard, in a `.test.ts` deliberately: `src/**` + `/*.test.mjs` is
 * gated by no CI job — `test:electron` globs `electron/`, `test:unit` globs
 * `.test.ts`/`.test.tsx` — so a guard written as `.mjs` under src/ would never
 * run. (ChatPane.test.mjs currently has 50 failing assertions nobody sees.)
 */

test("the refresh ladder stops once the turn it waits for has landed", () => {
  // Every rung re-derives the WHOLE conversation, so running all four
  // unconditionally costs three full rebuilds of every message after the data
  // has already converged — the bulk of the end-of-turn stutter on a long chat.
  assert.match(
    source,
    /const delays = \[150, 500, 1_500, 3_000\];/,
    "the retry curve stays — the persistence delay is still unknown",
  );
  assert.match(
    source,
    /const cancelRemaining = \(\) => \{[\s\S]*?window\.clearTimeout\(timer\)/,
    "the remaining rungs must be cancellable",
  );
  // Keyed on the awaited turn actually landing, not on a timer or a count.
  assert.match(
    source,
    /const stillPending =\s*pendingCommittedAssistantTurnsRef\.current\.some\(\s*\(message\) => message\.id === awaited,\s*\);\s*if \(!stillPending\) \{\s*cancelRemaining\(\);/,
  );
});

test("a ladder that names no turn still runs every rung", () => {
  // run_failed and the other callers converge on things this signal knows
  // nothing about, so they must keep the old behaviour exactly.
  assert.match(source, /if \(!awaited\) \{\s*return;\s*\}/);
});

test("the completion path names the turn it is waiting for", () => {
  assert.match(
    source,
    /scheduleConversationRefresh\(eventSessionId, selectedWorkspaceId, \{\s*awaitAssistantMessageId: committedAssistantMessage,\s*\}\);/,
  );
  // Which requires the commit to hand back an id rather than a bare boolean.
  assert.match(
    source,
    /function commitLiveAssistantMessage\(options\?: \{[\s\S]*?\}\): string \| null \{/,
  );
});
