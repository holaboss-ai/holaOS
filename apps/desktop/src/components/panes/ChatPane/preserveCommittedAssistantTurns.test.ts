import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatMessage } from "./types";
import {
  preserveCommittedAssistantTurns,
  settleCommittedAssistantTurns,
} from "./preserveCommittedAssistantTurns";

function user(id: string): ChatMessage {
  return { id, role: "user", text: "hi", createdAt: "2026-08-18T00:00:00.000Z" } as ChatMessage;
}

function assistant(id: string, text = "answer"): ChatMessage {
  return {
    id,
    role: "assistant",
    text,
    createdAt: "2026-08-18T00:00:01.000Z",
  } as ChatMessage;
}

test("a just-committed turn survives a refresh that predates its persistence", () => {
  // The flicker: the run finishes, the turn is committed locally, and the 150ms
  // refresh lands before the runtime has persisted it. Without this the turn is
  // dropped and only returns on the 500ms refresh.
  const serverHistory = [user("user-1")];
  const pending = [assistant("assistant-input-1")];

  const merged = preserveCommittedAssistantTurns(serverHistory, pending);

  assert.deepEqual(
    merged.map((m) => m.id),
    ["user-1", "assistant-input-1"],
    "the committed turn stays on screen, after the user message that prompted it",
  );
});

test("the server's copy wins once it arrives", () => {
  // The server's turn carries outputs, provenance and ids the local one never
  // had, so it must not be shadowed or duplicated by the pending copy.
  const serverHistory = [user("user-1"), assistant("assistant-input-1", "server text")];
  const pending = [assistant("assistant-input-1", "local text")];

  const merged = preserveCommittedAssistantTurns(serverHistory, pending);

  assert.equal(merged.length, 2, "no duplicate turn");
  assert.equal(
    merged.find((m) => m.id === "assistant-input-1")?.text,
    "server text",
    "the persisted copy is authoritative",
  );
});

test("a settled turn stops being held, so a later deletion is not undone", () => {
  // Without settling, a turn the user later deletes server-side would be
  // re-appended by every subsequent refresh, forever.
  const pending = [assistant("assistant-input-1")];

  const settled = settleCommittedAssistantTurns(pending, [
    user("user-1"),
    assistant("assistant-input-1"),
  ]);
  assert.deepEqual(settled, [], "the server caught up, so nothing is held");

  // A later refresh without the turn (it was deleted) must leave it gone.
  assert.deepEqual(
    preserveCommittedAssistantTurns([user("user-1")], settled).map((m) => m.id),
    ["user-1"],
    "a deleted turn is not resurrected",
  );
});

test("nothing pending is a pass-through, identity included", () => {
  // The common case by far — every refresh outside the completion window. It
  // must not allocate a new array, or it would defeat downstream memoization.
  const serverHistory = [user("user-1"), assistant("assistant-input-1")];

  assert.equal(
    preserveCommittedAssistantTurns(serverHistory, []),
    serverHistory,
    "same array reference when there is nothing to hold",
  );
  assert.equal(
    preserveCommittedAssistantTurns(serverHistory, [assistant("assistant-input-1")]),
    serverHistory,
    "same array reference when everything pending has already landed",
  );
});

test("several turns can be in flight at once", () => {
  // Two runs completing in quick succession, neither persisted yet.
  const merged = preserveCommittedAssistantTurns(
    [user("user-1")],
    [assistant("assistant-input-1"), assistant("assistant-input-2")],
  );
  assert.deepEqual(merged.map((m) => m.id), [
    "user-1",
    "assistant-input-1",
    "assistant-input-2",
  ]);
});
