import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "./types";
import { preserveDisplayedTurnOutputs } from "./preserveDisplayedTurnOutputs";

function output(id: string): WorkspaceOutputRecordPayload {
  return { id } as WorkspaceOutputRecordPayload;
}

function assistant(
  id: string,
  outputs?: WorkspaceOutputRecordPayload[],
): ChatMessage {
  return { id, role: "assistant", text: "", outputs };
}

function user(id: string): ChatMessage {
  return { id, role: "user", text: "hi" };
}

test("keeps a prior turn's output card when a cold re-derivation blanks it", () => {
  const prev = [
    user("user-1"),
    assistant("assistant-1", [output("o-1")]),
  ];
  // A refresh mid-next-turn rebuilds assistant-1 with no outputs (cold pool).
  const next = [
    user("user-1"),
    assistant("assistant-1", []),
    user("user-2"),
    assistant("assistant-2", []),
  ];

  const result = preserveDisplayedTurnOutputs(next, prev);

  assert.deepEqual(result[1].outputs, [output("o-1")]);
});

test("prefers freshly derived outputs over the stale displayed ones", () => {
  const prev = [assistant("assistant-1", [output("o-1")])];
  const next = [assistant("assistant-1", [output("o-1"), output("o-2")])];

  const result = preserveDisplayedTurnOutputs(next, prev);

  assert.deepEqual(result[0].outputs, [output("o-1"), output("o-2")]);
});

test("does not fabricate outputs for a turn that never had any", () => {
  const prev = [assistant("assistant-1")];
  const next = [assistant("assistant-1", [])];

  const result = preserveDisplayedTurnOutputs(next, prev);

  assert.equal(result[0].outputs?.length ?? 0, 0);
});

test("returns the next list unchanged when nothing was displayed yet", () => {
  const next = [assistant("assistant-1", [])];

  const result = preserveDisplayedTurnOutputs(next, []);

  assert.equal(result, next);
});

test("only restores outputs onto the matching turn id", () => {
  const prev = [assistant("assistant-1", [output("o-1")])];
  const next = [assistant("assistant-2", [])];

  const result = preserveDisplayedTurnOutputs(next, prev);

  assert.equal(result[0].outputs?.length ?? 0, 0);
});
