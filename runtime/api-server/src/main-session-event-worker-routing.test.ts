import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { RuntimeMainSessionEventWorker } from "./main-session-event-worker.js";

function makeStore(prefix: string): RuntimeStateStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
}

test("main-session event worker reroutes invalid subagent-owned events back to the coordinator session", async () => {
  const store = makeStore("hb-main-session-event-worker-routing-");
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-main",
    kind: "main_session",
  });
  store.ensureRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
    status: "IDLE",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-issue-1",
    kind: "subagent",
    parentSessionId: "session-main",
  });
  const run = store.createSubagentRun({
    workspaceId: workspace.id,
    parentSessionId: "session-issue-1",
    originMainSessionId: "session-issue-1",
    ownerMainSessionId: "session-issue-1",
    childSessionId: "session-issue-1",
    goal: "Finish the issue work.",
    status: "completed",
  });
  const event = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-issue-1",
    originMainSessionId: "session-issue-1",
    subagentId: run.subagentId,
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: { summary: "Done." },
  });

  try {
    const worker = new RuntimeMainSessionEventWorker({ store });
    const processed = await worker.processAvailableEventsOnce();
    const updatedRun = store.getSubagentRun({
      workspaceId: workspace.id,
      subagentId: run.subagentId,
    });
    const updatedEvent = store.getMainSessionEvent({
      workspaceId: workspace.id,
      eventId: event.eventId,
    });
    const batchInput = updatedEvent?.materializedInputId
      ? store.getInput({
          workspaceId: workspace.id,
          inputId: updatedEvent.materializedInputId,
        })
      : null;

    assert.equal(processed, 1);
    assert.equal(updatedRun?.ownerMainSessionId, "session-main");
    assert.equal(updatedEvent?.ownerMainSessionId, "session-main");
    assert.equal(updatedEvent?.status, "materialized");
    assert.equal(batchInput?.sessionId, "session-main");
  } finally {
    store.close();
  }
});
