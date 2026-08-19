import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * Sending into a new session must not blank the canvas.
 *
 * The send path used to call clearSessionView() — setMessages([]) — and only
 * rebuild the view after awaiting session creation, so the canvas sat empty
 * across an IPC round trip. That is the flash when you start a new chat, and it
 * ends at the same moment the new row appears in the sidebar because both hang
 * off the same queue response.
 *
 * The conversation is now held on screen and replaced in one step by the send's
 * own first message. Structural, in a `.test.ts` deliberately: `test:unit`
 * globs `.test.ts` / `.test.tsx`, so a guard written as `.mjs` under src/ would
 * never run.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "index.tsx"), "utf-8");

test("the send path defers blanking instead of clearing across the await", () => {
  const sendClear = /consumeSessionOpenRequest\(pendingSessionTarget\.requestKey\);[\s\S]{0,600}?clearSessionView\((\{[^)]*\})?\)/.exec(
    source,
  );
  assert.ok(sendClear, "could not find the send path's clearSessionView call");
  assert.match(
    sendClear[0],
    /keepMessages:\s*true/,
    "the send path must keep the conversation visible; blanking here empties the canvas for the whole session-creation round trip",
  );
});

test("every other clearSessionView still blanks", () => {
  // Workspace switch, blank draft and session delete genuinely have nothing to
  // put in place of the conversation. Only the send path defers.
  const keepers = source.match(/clearSessionView\(\{[^}]*keepMessages/g) ?? [];
  assert.equal(
    keepers.length,
    1,
    `only the send path may keep messages, found ${keepers.length}`,
  );
});

test("the held conversation is replaced wholesale, not appended to", () => {
  // The list still holds the PREVIOUS session's messages. Appending would show
  // the old conversation with the new message stuck on the end.
  assert.match(
    source,
    /setMessages\(\(prev\) => \(swapping \? \[userMessage\] : \[\.\.\.prev, userMessage\]\)\)/,
    "the optimistic user message must replace the held conversation when swapping",
  );
});

test("the swap flag is consumed even when no message is added", () => {
  // Queueing onto an active run adds no message. A flag left set there would
  // make the NEXT send replace a conversation it should have appended to.
  const consume = /const swapping = pendingSessionSwapRef\.current;\s*\n\s*pendingSessionSwapRef\.current = false;\s*\n\s*if \(!queueOntoActiveRun\)/.test(
    source,
  );
  assert.ok(
    consume,
    "the flag must be read and cleared before the queueOntoActiveRun branch, not inside it",
  );
});

test("a send that fails before the swap does not strand the old conversation", () => {
  // Both early exits between deferring the blank and performing the swap leave
  // the previous session's messages on screen under a session we are no longer
  // in, so each must settle the pending swap.
  const exits = source.match(/settlePendingSessionSwap\(\);/g) ?? [];
  assert.ok(
    exits.length >= 2,
    `expected both early exits to settle the swap, found ${exits.length}`,
  );
  assert.match(
    source,
    /function settlePendingSessionSwap\(\)[\s\S]{0,300}?setMessages\(\[\]\)/,
    "settling must blank the held conversation",
  );
});
