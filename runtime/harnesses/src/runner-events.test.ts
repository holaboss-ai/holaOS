import assert from "node:assert/strict";
import test from "node:test";

import {
  noteHarnessWaitingForUserOnToolCompletion,
  type HarnessRunnerWaitState,
} from "./runner-events.js";

function freshState(): HarnessRunnerWaitState {
  return { waitingForUser: false };
}

test("question tool flips waitingForUser when call succeeds", () => {
  const state = freshState();
  noteHarnessWaitingForUserOnToolCompletion({
    toolName: "question",
    isError: false,
    state,
  });
  assert.equal(state.waitingForUser, true);
});

test("question tool error does not flip waitingForUser", () => {
  const state = freshState();
  noteHarnessWaitingForUserOnToolCompletion({
    toolName: "question",
    isError: true,
    state,
  });
  assert.equal(state.waitingForUser, false);
});

test("non-question tool with no result does not flip", () => {
  const state = freshState();
  noteHarnessWaitingForUserOnToolCompletion({
    toolName: "workspace_apps_get_status",
    isError: false,
    state,
  });
  assert.equal(state.waitingForUser, false);
});

test("requires_session_refresh on top-level result flips waitingForUser", () => {
  const state = freshState();
  noteHarnessWaitingForUserOnToolCompletion({
    toolName: "workspace_apps_register",
    isError: false,
    state,
    result: { ok: true, requires_session_refresh: true },
  });
  assert.equal(state.waitingForUser, true);
});

test("requires_session_refresh nested under details flips waitingForUser", () => {
  const state = freshState();
  noteHarnessWaitingForUserOnToolCompletion({
    toolName: "workspace_apps_ensure_running",
    isError: false,
    state,
    result: {
      content: [{ type: "text", text: "ok" }],
      details: { requires_session_refresh: true, new_servers: ["twitter"] },
    },
  });
  assert.equal(state.waitingForUser, true);
});

test("requires_session_refresh false does not flip", () => {
  const state = freshState();
  noteHarnessWaitingForUserOnToolCompletion({
    toolName: "workspace_apps_register",
    isError: false,
    state,
    result: { details: { requires_session_refresh: false } },
  });
  assert.equal(state.waitingForUser, false);
});

test("requires_session_refresh ignored when call errored", () => {
  const state = freshState();
  noteHarnessWaitingForUserOnToolCompletion({
    toolName: "workspace_apps_register",
    isError: true,
    state,
    result: { details: { requires_session_refresh: true } },
  });
  assert.equal(state.waitingForUser, false);
});

test("non-record result is ignored safely", () => {
  const state = freshState();
  noteHarnessWaitingForUserOnToolCompletion({
    toolName: "workspace_apps_register",
    isError: false,
    state,
    result: "ok",
  });
  assert.equal(state.waitingForUser, false);
});
