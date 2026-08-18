import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage } from "./types";
import { preserveMessageIdentity } from "./preserveMessageIdentity";

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: "assistant",
    text: "answer",
    createdAt: "2026-08-18T00:00:00.000Z",
    segments: [{ kind: "output", text: "answer", tone: "default" }],
    ...overrides,
  } as ChatMessage;
}

test("an unchanged turn keeps the object React already has", () => {
  // This is the whole point: AssistantTurn's memo comparator compares props BY
  // REFERENCE, so a rebuilt-but-identical message re-renders the turn and
  // re-runs markdown + syntax highlighting for nothing.
  const prev = [message("a"), message("b")];
  const rebuilt = [message("a"), message("b")]; // same content, new objects

  const merged = preserveMessageIdentity(rebuilt, prev);

  assert.equal(merged[0], prev[0], "unchanged turn keeps its identity");
  assert.equal(merged[1], prev[1]);
});

test("a no-op refresh returns the previous ARRAY, so the useMemo above holds too", () => {
  const prev = [message("a"), message("b")];
  const rebuilt = [message("a"), message("b")];

  assert.equal(
    preserveMessageIdentity(rebuilt, prev),
    prev,
    "identical list → same array reference → displayMessages' memo holds",
  );
});

test("a changed turn is NOT pinned to its stale object", () => {
  // The dangerous failure direction: preserving too eagerly would freeze the
  // old content on screen.
  const prev = [message("a", { text: "old" })];
  const rebuilt = [message("a", { text: "new" })];

  const merged = preserveMessageIdentity(rebuilt, prev);

  assert.equal(merged[0], rebuilt[0], "the changed turn uses the fresh object");
  assert.equal((merged[0] as { text: string }).text, "new");
});

test("a change buried in a nested field still counts as changed", () => {
  // A hand-written field-by-field comparison rots the moment a new field is
  // added — it silently reports "equal" and pins stale content. This is why
  // the comparison is structural.
  const prev = [message("a", { segments: [{ kind: "output", text: "old", tone: "default" }] })];
  const rebuilt = [message("a", { segments: [{ kind: "output", text: "new", tone: "default" }] })];

  const merged = preserveMessageIdentity(rebuilt, prev);

  assert.equal(merged[0], rebuilt[0], "a nested difference must not be preserved away");
});

test("appended turns do not disturb the identity of earlier ones", () => {
  // The common case during a conversation: one new turn arrives, everything
  // before it should stay put and stay memoized.
  const prev = [message("a"), message("b")];
  const rebuilt = [message("a"), message("b"), message("c")];

  const merged = preserveMessageIdentity(rebuilt, prev);

  assert.equal(merged.length, 3);
  assert.equal(merged[0], prev[0], "earlier turns keep identity");
  assert.equal(merged[1], prev[1]);
  assert.equal(merged[2], rebuilt[2], "the new turn is the fresh object");
  assert.notEqual(merged, prev, "a longer list is a new array");
});

test("a removed turn is really removed", () => {
  const prev = [message("a"), message("b")];
  const rebuilt = [message("a")];

  const merged = preserveMessageIdentity(rebuilt, prev);

  assert.deepEqual(merged.map((m) => m.id), ["a"]);
  assert.equal(merged[0], prev[0]);
});

test("empty inputs are pass-throughs", () => {
  const rebuilt = [message("a")];
  assert.equal(preserveMessageIdentity(rebuilt, []), rebuilt);
  assert.deepEqual(preserveMessageIdentity([], [message("a")]), []);
});

test("role changing on the same id is treated as changed", () => {
  const prev = [message("a", { role: "user" })];
  const rebuilt = [message("a", { role: "assistant" })];
  assert.equal(preserveMessageIdentity(rebuilt, prev)[0], rebuilt[0]);
});
