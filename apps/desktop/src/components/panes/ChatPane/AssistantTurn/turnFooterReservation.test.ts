import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * The turn must not grow when it finishes.
 *
 * The footer row (timestamp + actions) is `mt-1 h-6` — 28px — and its two
 * conditions are both false while streaming: `showActionsMenu` is
 * `hasAnyContent && !live`, and the timestamp only exists once the turn is
 * committed. So the row APPEARED at completion, growing the turn the instant
 * the agent stopped typing and nudging the conversation.
 *
 * Same class as the "Worked for Ns" anchor removed alongside this: anything
 * that exists in only one of the two states moves the layout on the transition.
 * The anchor could simply go; the timestamp and actions are worth keeping, so
 * the row is reserved instead and merely fills in.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "index.tsx"), "utf-8");

test("the footer row is reserved while the turn is live", () => {
  assert.match(
    source,
    /\{showActionsMenu \|\|\s*\(showAvatar && timeLabel\) \|\|\s*\(live && hasAnyContent\) \?/,
    "a live turn with content must still render the footer row, or it appears at completion and grows the turn",
  );
});

test("the reservation matches the settled condition", () => {
  // showActionsMenu is `hasAnyContent && !live`, so a settled turn renders the
  // row exactly when it has content. Reserving on `live && hasAnyContent` is
  // the same predicate on the other side of the flip — reserving more widely
  // would make the row VANISH at completion, a shift in the other direction.
  assert.match(
    source,
    /const showActionsMenu = hasAnyContent && !live;/,
    "the settled condition changed; the reservation above must be re-derived from it",
  );
});

test("the row keeps a fixed height so filling it cannot resize the turn", () => {
  assert.match(
    source,
    /\(live && hasAnyContent\) \? \(\s*<div className="mt-1 flex h-6 items-center gap-2">/,
    "the reserved row must have an explicit height, or an empty row collapses",
  );
});
