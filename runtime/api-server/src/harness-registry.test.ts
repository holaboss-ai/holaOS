import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { DESKTOP_BROWSER_TOOL_IDS } from "../../harnesses/src/desktop-browser-tools.js";
import {
  listRuntimeHarnessAdapters,
  normalizeHarnessId,
  requireRuntimeHarnessAdapter,
  requireRuntimeHarnessPlugin,
  resolveRuntimeHarnessAdapter
} from "./harness-registry.js";

const ORIGINAL_ENV = {
  HOLABOSS_HARNESS_RUN_TIMEOUT_S: process.env.HOLABOSS_HARNESS_RUN_TIMEOUT_S,
  HOLABOSS_SUBAGENT_HARNESS_RUN_TIMEOUT_S: process.env.HOLABOSS_SUBAGENT_HARNESS_RUN_TIMEOUT_S,
  HOLABOSS_TASK_PROPOSAL_HARNESS_RUN_TIMEOUT_S: process.env.HOLABOSS_TASK_PROPOSAL_HARNESS_RUN_TIMEOUT_S
};

afterEach(() => {
  if (ORIGINAL_ENV.HOLABOSS_HARNESS_RUN_TIMEOUT_S === undefined) {
    delete process.env.HOLABOSS_HARNESS_RUN_TIMEOUT_S;
  } else {
    process.env.HOLABOSS_HARNESS_RUN_TIMEOUT_S = ORIGINAL_ENV.HOLABOSS_HARNESS_RUN_TIMEOUT_S;
  }
  if (ORIGINAL_ENV.HOLABOSS_SUBAGENT_HARNESS_RUN_TIMEOUT_S === undefined) {
    delete process.env.HOLABOSS_SUBAGENT_HARNESS_RUN_TIMEOUT_S;
  } else {
    process.env.HOLABOSS_SUBAGENT_HARNESS_RUN_TIMEOUT_S =
      ORIGINAL_ENV.HOLABOSS_SUBAGENT_HARNESS_RUN_TIMEOUT_S;
  }
  if (ORIGINAL_ENV.HOLABOSS_TASK_PROPOSAL_HARNESS_RUN_TIMEOUT_S === undefined) {
    delete process.env.HOLABOSS_TASK_PROPOSAL_HARNESS_RUN_TIMEOUT_S;
  } else {
    process.env.HOLABOSS_TASK_PROPOSAL_HARNESS_RUN_TIMEOUT_S = ORIGINAL_ENV.HOLABOSS_TASK_PROPOSAL_HARNESS_RUN_TIMEOUT_S;
  }
});

test("normalizeHarnessId falls back to the default harness", () => {
  assert.equal(normalizeHarnessId(undefined), "pi");
  assert.equal(normalizeHarnessId(" PI "), "pi");
});

test("listRuntimeHarnessAdapters exposes registered harnesses", () => {
  assert.deepEqual(
    listRuntimeHarnessAdapters().map((adapter) => ({ id: adapter.id, hostCommand: adapter.hostCommand })),
    [{ id: "pi", hostCommand: "run-pi" }]
  );
});

test("resolveRuntimeHarnessAdapter resolves supported harnesses", () => {
  assert.equal(resolveRuntimeHarnessAdapter("pi")?.hostCommand, "run-pi");
  assert.equal(resolveRuntimeHarnessAdapter("unsupported"), null);
});

test("requireRuntimeHarnessAdapter rejects unsupported harnesses", () => {
  assert.throws(() => requireRuntimeHarnessAdapter("unsupported"), /unsupported harness: unsupported/);
});

test("requireRuntimeHarnessPlugin uses extended timeouts for task proposal runs", () => {
  process.env.HOLABOSS_HARNESS_RUN_TIMEOUT_S = "45";
  process.env.HOLABOSS_SUBAGENT_HARNESS_RUN_TIMEOUT_S = "900";
  process.env.HOLABOSS_TASK_PROPOSAL_HARNESS_RUN_TIMEOUT_S = "600";

  const plugin = requireRuntimeHarnessPlugin("pi");
  assert.equal(
    plugin.timeoutSeconds({
      request: {
        workspace_id: "workspace-1",
        session_id: "session-main",
        session_kind: "main_session",
        input_id: "input-1",
        instruction: "Inspect the project"
      }
    }),
    45
  );
  assert.equal(
    plugin.timeoutSeconds({
      request: {
        workspace_id: "workspace-1",
        session_id: "subagent-1",
        session_kind: "subagent",
        input_id: "input-1a",
        instruction: "Investigate the issue"
      }
    }),
    900
  );
  assert.equal(
    plugin.timeoutSeconds({
      request: {
        workspace_id: "workspace-1",
        session_id: "proposal-1",
        session_kind: "task_proposal",
        input_id: "input-2",
        instruction: "Finish the delegated task"
      }
    }),
    600
  );
});

test("requireRuntimeHarnessPlugin stages browser tools only for subagent sessions", () => {
  const plugin = requireRuntimeHarnessPlugin("pi");
  const browserConfig = {
    desktopBrowserEnabled: true,
    desktopBrowserUrl: "http://127.0.0.1:3555",
    desktopBrowserAuthToken: "token"
  };

  assert.deepEqual(
    plugin.stageBrowserTools({
      workspaceDir: "/tmp/workspace-1",
      sessionKind: "main_session",
      browserConfig
    }),
    {
      changed: false,
      toolIds: []
    }
  );
  assert.deepEqual(
    plugin.stageBrowserTools({
      workspaceDir: "/tmp/workspace-1",
      sessionKind: "subagent",
      browserConfig
    }),
    {
      changed: false,
      toolIds: [...DESKTOP_BROWSER_TOOL_IDS]
    }
  );
  assert.deepEqual(
    plugin.stageBrowserTools({
      workspaceDir: "/tmp/workspace-1",
      sessionKind: "task_proposal",
      browserConfig
    }),
    {
      changed: false,
      toolIds: []
    }
  );
  assert.deepEqual(
    plugin.stageBrowserTools({
      workspaceDir: "/tmp/workspace-1",
      sessionKind: "onboarding",
      browserConfig
    }),
    {
      changed: false,
      toolIds: []
    }
  );
});
