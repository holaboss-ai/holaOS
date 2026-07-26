import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { SessionInputRecord, TurnResultRecord } from "@holaboss/runtime-state-store";
import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";
import { maybeCreateMainSessionCompletionNotification } from "./claimed-input-executor.js";

function makeRecord(workspaceId: string, sessionId: string): SessionInputRecord {
  return {
    workspaceId,
    sessionId,
    inputId: "in-1",
  } as SessionInputRecord;
}

function makeTurnResult(): TurnResultRecord {
  return {
    status: "completed",
    assistantText: "done — here is your reply",
    stopReason: "end_turn",
  } as TurnResultRecord;
}

test("main-session completion notifies for desktop sessions but not channel sessions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hb-completion-notify-"));
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    const workspace = seedWorkspaceRecord(store);

    store.ensureSession({
      workspaceId: workspace.id,
      sessionId: "desktop-session",
      kind: "main_session",
      createdBy: "desktop_user",
    });
    maybeCreateMainSessionCompletionNotification({
      store,
      record: makeRecord(workspace.id, "desktop-session"),
      turnResult: makeTurnResult(),
    });
    assert.equal(
      store.listRuntimeNotifications({ workspaceId: workspace.id }).length,
      1,
      "desktop main session completion still notifies",
    );

    store.ensureSession({
      workspaceId: workspace.id,
      sessionId: "im:wechat:dm:1",
      kind: "main_session",
      createdBy: "im:wechat",
    });
    maybeCreateMainSessionCompletionNotification({
      store,
      record: makeRecord(workspace.id, "im:wechat:dm:1"),
      turnResult: makeTurnResult(),
    });
    assert.equal(
      store.listRuntimeNotifications({ workspaceId: workspace.id }).length,
      1,
      "channel session completion must NOT create a desktop notification",
    );
  } finally {
    store.close();
  }
});
