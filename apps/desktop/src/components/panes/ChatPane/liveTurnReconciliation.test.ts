import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The live turn must reconcile into the committed one, not be replaced by it.
 *
 * When a turn finishes, the streaming node is dropped and the committed node
 * takes its place. If React tears the first down and builds the second, the
 * turn's entrance animation — `animate-in fade-in-0 slide-in-from-bottom-1` —
 * replays: a fade and a slide, which is the blink-and-nudge at the end of every
 * turn.
 *
 * The key was already matched for exactly this reason. It was not enough,
 * because the live turn was a keyed Fragment and the committed turn a keyed
 * <div>: React tears down across an element TYPE change no matter what the key
 * says. Both sides must be the same element.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "ConversationTurns.tsx"), "utf-8");

test("the live turn is wrapped in the same element type as a committed turn", () => {
  const live = /if \(liveAssistantTurn\) \{[\s\S]*?renderedTurns\.push\(([\s\S]*?)<AssistantTurn/.exec(
    source,
  );
  assert.ok(live, "could not find the live turn's wrapper");
  assert.match(
    live[1],
    /<div\b/,
    "the live turn must be wrapped in a <div>, matching the committed turn; a Fragment is a different element type and forces a remount",
  );
  assert.doesNotMatch(
    live[1],
    /<Fragment\b/,
    "a keyed Fragment cannot reconcile into a keyed <div>",
  );
});

test("the live turn carries the key it will have once committed", () => {
  assert.match(
    source,
    /const liveTurnKey = liveAssistantTurn\.id \?\? "__live_assistant_turn__";/,
    "the live turn's key must be the committed message id",
  );
  assert.match(source, /key=\{liveTurnKey\}/);
});

test("committed turns still key on the message id", () => {
  // The other half of the pair. If this changes, the live key above has to
  // change with it or they stop matching and the remount returns.
  assert.match(
    source,
    /key=\{message\.id\}/,
    "committed turns must key on message.id for the live key to match",
  );
});
