import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  relayTsRunnerEvent,
  resolveTsRunnerBootstrapState,
} from "./ts-runner.js";

/**
 * Resume, end to end across two turns.
 *
 * Both halves are already covered on their own: that a terminal event persists
 * its `harness_session_id`, and that bootstrap can load a persisted id. What was
 * not covered is that they meet — that the id turn 1 WRITES is the id turn 2
 * READS. The write goes to `.holaboss/state/harness-session-state.json` (v2) and
 * the read also accepts a legacy `.holaboss/harness-session-state.json` (v1), so
 * the two sides address the same fact through different paths and formats. Each
 * half can stay green while the seam between them silently stops working.
 *
 * When it does stop working the symptom is not an error: every turn simply
 * starts a fresh pi session, and the agent quietly forgets the conversation.
 * That is why this was previously checked by hand — by sending several messages
 * and looking at whether one session file grew.
 */

function turnWorkspace(prefix: string): {
  sandboxRoot: string;
  workspaceId: string;
  workspaceDir: string;
} {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspaceId = "workspace-1";
  const workspaceDir = path.join(sandboxRoot, "workspace", workspaceId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { sandboxRoot, workspaceId, workspaceDir };
}

/** The bootstrap turn N performs: what session, if any, does it resume? */
function bootstrapForTurn(workspaceId: string, inputId: string) {
  return resolveTsRunnerBootstrapState({
    workspace_id: workspaceId,
    session_id: "session-1",
    input_id: inputId,
    instruction: "hello",
    context: { _sandbox_runtime_exec_v1: { harness: "pi" } },
    model: null,
    debug: false,
  });
}

/** The terminal event that ends a turn, carrying the id to resume from. */
async function completeTurn(params: {
  workspaceDir: string;
  inputId: string;
  harnessSessionId: string;
  status?: "success" | "failed";
}): Promise<void> {
  const failed = params.status === "failed";
  await relayTsRunnerEvent({
    harness: "pi",
    workspaceDir: params.workspaceDir,
    event: {
      session_id: "session-1",
      input_id: params.inputId,
      sequence: 4,
      event_type: failed ? "run_failed" : "run_completed",
      timestamp: new Date().toISOString(),
      payload: {
        status: failed ? "failed" : "success",
        harness_session_id: params.harnessSessionId,
      },
    },
    emitEvent: async () => {},
  });
}

test("turn 2 resumes the session turn 1 persisted", async (t) => {
  const previousRoot = process.env.HB_SANDBOX_ROOT;
  t.after(() => {
    process.env.HB_SANDBOX_ROOT = previousRoot;
  });
  const { sandboxRoot, workspaceId, workspaceDir } = turnWorkspace(
    "hb-resume-round-trip-",
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;

  // Turn 1 starts with nothing to resume — the first turn of a conversation.
  assert.equal(
    bootstrapForTurn(workspaceId, "input-1").persistedHarnessSessionId,
    null,
    "a fresh workspace must not resume anything",
  );

  await completeTurn({
    workspaceDir,
    inputId: "input-1",
    harnessSessionId: "pi-session-abc",
  });

  // Turn 2 must pick it up. This is the assertion the manual check was making.
  const secondTurn = bootstrapForTurn(workspaceId, "input-2");
  assert.equal(
    secondTurn.persistedHarnessSessionId,
    "pi-session-abc",
    "turn 2 did not resume turn 1's session — the agent would silently forget the conversation",
  );
  assert.equal(secondTurn.workspaceDir, workspaceDir);
  assert.equal(secondTurn.harness, "pi");
});

test("the resumed id stays stable across a run of turns", async (t) => {
  const previousRoot = process.env.HB_SANDBOX_ROOT;
  t.after(() => {
    process.env.HB_SANDBOX_ROOT = previousRoot;
  });
  const { sandboxRoot, workspaceId, workspaceDir } = turnWorkspace(
    "hb-resume-stable-",
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;

  // pi returns the same session id every turn once a session exists; the
  // runtime must keep converging on it rather than accumulating or rotating.
  for (let turn = 1; turn <= 4; turn += 1) {
    const bootstrap = bootstrapForTurn(workspaceId, `input-${turn}`);
    assert.equal(
      bootstrap.persistedHarnessSessionId,
      turn === 1 ? null : "pi-session-abc",
      `turn ${turn} resumed the wrong session`,
    );
    await completeTurn({
      workspaceDir,
      inputId: `input-${turn}`,
      harnessSessionId: "pi-session-abc",
    });
  }
});

test("a failed turn clears the pointer so the next turn starts clean", async (t) => {
  const previousRoot = process.env.HB_SANDBOX_ROOT;
  t.after(() => {
    process.env.HB_SANDBOX_ROOT = previousRoot;
  });
  const { sandboxRoot, workspaceId, workspaceDir } = turnWorkspace(
    "hb-resume-failed-",
  );
  process.env.HB_SANDBOX_ROOT = sandboxRoot;

  await completeTurn({
    workspaceDir,
    inputId: "input-1",
    harnessSessionId: "pi-session-abc",
  });
  assert.equal(
    bootstrapForTurn(workspaceId, "input-2").persistedHarnessSessionId,
    "pi-session-abc",
  );

  // This is the direction that matters for the in-process path: a run reported
  // as FAILED clears the pointer. It is why a post-terminal error (compaction
  // throwing after run_completed) must never be reported as a failed run — the
  // turn succeeded, but relaying a failure here would discard the conversation.
  await completeTurn({
    workspaceDir,
    inputId: "input-2",
    harnessSessionId: "pi-session-abc",
    status: "failed",
  });

  assert.equal(
    bootstrapForTurn(workspaceId, "input-3").persistedHarnessSessionId,
    null,
    "a failed run must clear the resume pointer",
  );
});
