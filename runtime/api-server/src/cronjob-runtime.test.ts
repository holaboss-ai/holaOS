import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";
import { fireCronjob } from "./cronjob-runtime.js";

test("fireCronjob frames the instruction as an execution, not a scheduling request", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hb-cronjob-runtime-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    const workspace = seedWorkspaceRecord(store);
    const instruction =
      "Every Monday at 9:00 AM Asia/Shanghai, prepare a concise GitHub recap.";
    const cronjob = store.createCronjob({
      workspaceId: workspace.id,
      initiatedBy: "desktop_user",
      name: "Monday recap",
      cron: "0 9 * * 1",
      description: "Weekly GitHub recap",
      instruction,
      delivery: { mode: "announce", channel: "session_run", to: null },
    });

    const fired = fireCronjob({ store, workspace, cronjob });

    const input = store.getInput({
      workspaceId: workspace.id,
      inputId: fired.inputId,
    });
    assert.ok(input, "fired input should be queued");
    const text = String(input.payload?.text ?? "");
    // The schedule already fired — the agent must be told to execute the
    // task now rather than read the cadence phrasing as a request to
    // create/modify a schedule.
    assert.ok(text.includes(instruction), "instruction text is preserved");
    assert.notEqual(
      text.trim(),
      instruction,
      "raw instruction must not be sent bare",
    );
    assert.match(text, /scheduled run/i);
    assert.match(text, /do not (create|set up|modify)[^.]*schedule/i);
  } finally {
    store.close();
  }
});

test("fireCronjob binds the run session to the cronjob's project", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hb-cronjob-runtime-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    const workspace = seedWorkspaceRecord(store);
    const project = store.createWorkspaceProject({
      workspaceId: workspace.id,
      projectId: "project-1",
      name: "Weekly reports",
      projectPath: path.join(root, "projects", "weekly-reports"),
    });
    const cronjob = store.createCronjob({
      workspaceId: workspace.id,
      initiatedBy: "desktop_user",
      name: "Weekly report",
      cron: "0 9 * * 1",
      description: "Weekly report",
      instruction: "Write the weekly report.",
      delivery: { mode: "announce", channel: "session_run", to: null },
      metadata: { project_id: project.projectId },
    });

    const fired = fireCronjob({ store, workspace, cronjob });

    const session = store.getSession({
      workspaceId: workspace.id,
      sessionId: fired.sessionId,
    });
    assert.equal(session?.projectId, project.projectId);
  } finally {
    store.close();
  }
});

test("fireCronjob ignores a project binding that no longer exists", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hb-cronjob-runtime-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    const workspace = seedWorkspaceRecord(store);
    const cronjob = store.createCronjob({
      workspaceId: workspace.id,
      initiatedBy: "desktop_user",
      name: "Weekly report",
      cron: "0 9 * * 1",
      description: "Weekly report",
      instruction: "Write the weekly report.",
      delivery: { mode: "announce", channel: "session_run", to: null },
      metadata: { project_id: "project-deleted" },
    });

    const fired = fireCronjob({ store, workspace, cronjob });

    const session = store.getSession({
      workspaceId: workspace.id,
      sessionId: fired.sessionId,
    });
    assert.equal(session?.projectId, null);
  } finally {
    store.close();
  }
});

test("fireCronjob records the fired session id on the cronjob", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hb-cronjob-runtime-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    const workspace = seedWorkspaceRecord(store);
    const cronjob = store.createCronjob({
      workspaceId: workspace.id,
      initiatedBy: "desktop_user",
      name: "Weekly report",
      cron: "0 9 * * 1",
      description: "Weekly report",
      instruction: "Write the weekly report.",
      delivery: { mode: "announce", channel: "session_run", to: null },
      metadata: { harness: "pi" },
    });

    const fired = fireCronjob({ store, workspace, cronjob });

    const updated = store.getCronjob({
      workspaceId: workspace.id,
      jobId: cronjob.id,
    });
    assert.equal(updated?.metadata.last_session_id, fired.sessionId);
    assert.equal(updated?.metadata.harness, "pi");
  } finally {
    store.close();
  }
});

test("fireCronjob pins the automation's reasoning effort onto the run", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hb-cronjob-runtime-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    const workspace = seedWorkspaceRecord(store);
    const cronjob = store.createCronjob({
      workspaceId: workspace.id,
      initiatedBy: "desktop_user",
      name: "Deep recap",
      cron: "0 9 * * 1",
      description: "Deep recap",
      instruction: "Write a thorough recap.",
      delivery: { mode: "announce", channel: "session_run", to: null },
      // Pinned model + reasoning effort, as the desktop dialogs persist them.
      metadata: { selected_model: "claude-sonnet-4-6", thinking_value: "high" },
    });

    const fired = fireCronjob({ store, workspace, cronjob });

    const input = store.getInput({
      workspaceId: workspace.id,
      inputId: fired.inputId,
    });
    assert.equal(input?.payload?.model, "claude-sonnet-4-6");
    assert.equal(input?.payload?.thinking_value, "high");
  } finally {
    store.close();
  }
});

test("fireCronjob leaves thinking_value null when the automation pins none", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hb-cronjob-runtime-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    const workspace = seedWorkspaceRecord(store);
    const cronjob = store.createCronjob({
      workspaceId: workspace.id,
      initiatedBy: "desktop_user",
      name: "Plain recap",
      cron: "0 9 * * 1",
      description: "Plain recap",
      instruction: "Write a recap.",
      delivery: { mode: "announce", channel: "session_run", to: null },
    });

    const fired = fireCronjob({ store, workspace, cronjob });

    const input = store.getInput({
      workspaceId: workspace.id,
      inputId: fired.inputId,
    });
    assert.equal(input?.payload?.thinking_value, null);
  } finally {
    store.close();
  }
});
