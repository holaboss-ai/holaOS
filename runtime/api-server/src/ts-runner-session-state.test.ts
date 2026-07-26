import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  clearWorkspaceHarnessSessionId,
  persistWorkspaceHarnessSessionId,
  readWorkspaceHarnessSessionId,
  readWorkspaceSessionState,
  workspaceDataDbPath,
  workspaceSessionStatePath
} from "./ts-runner-session-state.js";

const ORIGINAL_SANDBOX_ROOT = process.env.HB_SANDBOX_ROOT;

afterEach(() => {
  if (ORIGINAL_SANDBOX_ROOT === undefined) {
    delete process.env.HB_SANDBOX_ROOT;
  } else {
    process.env.HB_SANDBOX_ROOT = ORIGINAL_SANDBOX_ROOT;
  }
});

test("persistWorkspaceHarnessSessionId writes the expected session state payload", () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-ts-runner-state-"));
  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  const workspaceDir = path.join(sandboxRoot, "workspace", "workspace-1");

  persistWorkspaceHarnessSessionId({
    workspaceDir,
    harness: "pi",
    sessionId: "session-123"
  });

  assert.deepEqual(readWorkspaceSessionState(workspaceDir), {
    version: 2,
    harness_sessions: {
      pi: {
        session_id: "session-123"
      }
    }
  });
  assert.equal(readWorkspaceHarnessSessionId({ workspaceDir, harness: "pi" }), "session-123");
});

test("readWorkspaceHarnessSessionId keeps legacy harness payloads readable", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-ts-runner-state-mismatch-"));
  const statePath = workspaceSessionStatePath(workspaceDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      harness: "other",
      main_session_id: "session-123"
    }),
    "utf8"
  );

  assert.equal(readWorkspaceHarnessSessionId({ workspaceDir, harness: "pi" }), null);
});

test("persistWorkspaceHarnessSessionId stores multiple harness session ids side by side", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-ts-runner-state-refuse-"));
  const statePath = workspaceSessionStatePath(workspaceDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      harness: "other",
      main_session_id: "session-123"
    }),
    "utf8"
  );

  persistWorkspaceHarnessSessionId({
    workspaceDir,
    harness: "pi",
    sessionId: "session-456"
  });

  assert.deepEqual(readWorkspaceSessionState(workspaceDir), {
    version: 2,
    harness_sessions: {
      pi: {
        session_id: "session-456"
      },
      other: {
        session_id: "session-123"
      }
    }
  });
  assert.equal(readWorkspaceHarnessSessionId({ workspaceDir, harness: "other" }), "session-123");
  assert.equal(readWorkspaceHarnessSessionId({ workspaceDir, harness: "pi" }), "session-456");
});

test("clearWorkspaceHarnessSessionId removes only the targeted harness entry", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-ts-runner-state-clear-"));

  persistWorkspaceHarnessSessionId({
    workspaceDir,
    harness: "other",
    sessionId: "session-123"
  });
  persistWorkspaceHarnessSessionId({
    workspaceDir,
    harness: "pi",
    sessionId: "session-456"
  });

  clearWorkspaceHarnessSessionId({
    workspaceDir,
    harness: "pi"
  });

  assert.deepEqual(readWorkspaceSessionState(workspaceDir), {
    version: 2,
    harness_sessions: {
      other: {
        session_id: "session-123"
      }
    }
  });
  assert.equal(readWorkspaceHarnessSessionId({ workspaceDir, harness: "pi" }), null);
  assert.equal(readWorkspaceHarnessSessionId({ workspaceDir, harness: "other" }), "session-123");
});

test("workspaceDataDbPath places data.db under the workspace `.holaboss/state` folder", () => {
  const workspaceDir = path.join(os.tmpdir(), "hb-ts-runner-data-db-test");
  const dbPath = workspaceDataDbPath(workspaceDir);
  assert.equal(dbPath, path.join(path.resolve(workspaceDir), ".holaboss", "state", "data.db"));
});
