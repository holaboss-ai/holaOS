import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";
import { seedWorkspaceRecord } from "./__test-helpers__/seed-workspace.js";

import { buildRuntimeApiServer } from "./app.js";
import {
  RuntimeCronWorker,
  cronjobCheckIntervalMs,
  cronjobInstruction,
  cronjobIsDue,
  cronjobNextRunAt
} from "./cron-worker.js";

const tempDirs: string[] = [];
const ORIGINAL_ENV = {
  HB_SANDBOX_ROOT: process.env.HB_SANDBOX_ROOT,
  HOLABOSS_RUNTIME_CONFIG_PATH: process.env.HOLABOSS_RUNTIME_CONFIG_PATH,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (ORIGINAL_ENV.HB_SANDBOX_ROOT === undefined) {
    delete process.env.HB_SANDBOX_ROOT;
  } else {
    process.env.HB_SANDBOX_ROOT = ORIGINAL_ENV.HB_SANDBOX_ROOT;
  }
  if (ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = ORIGINAL_ENV.HOLABOSS_RUNTIME_CONFIG_PATH;
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("cronjob helpers honor next_run_at and preserve compatibility scheduling behavior", () => {
  const scheduledJob = {
    enabled: true,
    cron: "0 9 * * *",
    lastRunAt: null,
    metadata: { timezone: "America/New_York" },
    nextRunAt: "2025-01-01T10:00:00Z"
  };
  assert.equal(cronjobIsDue(scheduledJob as never, new Date("2025-01-01T09:30:00Z")), false);
  assert.equal(cronjobIsDue(scheduledJob as never, new Date("2025-01-01T10:00:00Z")), true);

  const legacyDueJob = {
    enabled: true,
    cron: "0 9 * * *",
    lastRunAt: null,
    metadata: {},
    nextRunAt: null
  };
  assert.equal(cronjobIsDue(legacyDueJob as never, new Date("2025-01-01T09:30:00Z")), true);
  assert.ok(cronjobNextRunAt("0 9 * * *", new Date("2025-01-01T09:30:00Z")));
  assert.equal(
    cronjobNextRunAt(
      "0 9 * * *",
      new Date("2025-01-01T13:30:00Z"),
      "America/New_York",
    ),
    "2025-01-01T14:00:00.000Z",
  );
  assert.equal(
    cronjobNextRunAt("0 9 * * *", new Date("2025-01-01T13:30:00Z"), "UTC"),
    "2025-01-02T09:00:00.000Z",
  );
  assert.equal(
    cronjobIsDue(
      {
        enabled: true,
        cron: "0 9 * * *",
        lastRunAt: null,
        metadata: {},
        nextRunAt: "2025-01-02T09:00:00.000Z",
      } as never,
      new Date("2025-01-01T14:30:00Z"),
      "America/New_York",
    ),
    true,
  );
  assert.equal(cronjobNextRunAt("not a cron", new Date("2025-01-01T09:30:00Z")), null);
  assert.equal(
    cronjobInstruction("Daily check", { priority: 1, team: "growth" }),
    'Daily check\n\n[Cronjob Metadata]\n{"team":"growth"}'
  );
  assert.equal(
    cronjobInstruction("Remind me to drink water.", {
      source_session_id: "session-main",
      team: "growth"
    }),
    'Remind me to drink water.\n\n[Cronjob Metadata]\n{"team":"growth"}'
  );

  const previous = process.env.CRONJOB_RUNNER_CHECK_INTERVAL_SECONDS;
  process.env.CRONJOB_RUNNER_CHECK_INTERVAL_SECONDS = "2";
  assert.equal(cronjobCheckIntervalMs(), 5000);
  if (previous === undefined) {
    delete process.env.CRONJOB_RUNNER_CHECK_INTERVAL_SECONDS;
  } else {
    process.env.CRONJOB_RUNNER_CHECK_INTERVAL_SECONDS = previous;
  }
});

test("runtime cron worker fires due native cronjobs as fresh scheduled sessions", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "Daily",
    cron: "0 9 * * *",
    description: "Daily check",
    instruction: "Say hello",
    delivery: { channel: "session_run" },
    enabled: true,
    nextRunAt: "2025-01-01T09:00:00Z",
  });

  const worker = new RuntimeCronWorker({ store });
  const processed = await worker.processDueCronjobsOnce(new Date("2025-01-01T09:30:00Z"));
  assert.equal(processed, 1);

  // A fresh scheduled main session was created and seeded with the instruction.
  const scheduled = store
    .listSessions({ workspaceId: workspace.id })
    .filter((session) => session.createdBy === "cronjob");
  assert.equal(scheduled.length, 1);
  const queued = store.claimInputs({ limit: 10, claimedBy: "test", leaseSeconds: 300 });
  assert.equal(queued.length, 1);
  const queuedText = String(queued[0]?.payload.text ?? "");
  assert.ok(queuedText.includes("Say hello"));
  assert.match(queuedText, /scheduled run/i);

  // The run was recorded and the schedule advanced past the trigger time.
  const updated = store.getCronjob({ workspaceId: workspace.id, jobId: job.id });
  assert.equal(updated?.runCount, 1);
  assert.equal(updated?.lastStatus, "fired");
  assert.ok(updated?.nextRunAt && updated.nextRunAt > "2025-01-01T09:30:00Z");

  store.close();
});

test("runtime cron worker does not fire a cronjob before its next_run_at", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "Hourly",
    cron: "0 * * * *",
    description: "Hourly check",
    instruction: "tick",
    delivery: { channel: "session_run" },
    enabled: true,
    nextRunAt: "2025-01-01T10:00:00Z",
  });

  const worker = new RuntimeCronWorker({ store });
  assert.equal(await worker.processDueCronjobsOnce(new Date("2025-01-01T09:30:00Z")), 0);
  assert.equal(await worker.processDueCronjobsOnce(new Date("2025-01-01T10:01:00Z")), 1);

  store.close();
});

test("cronjob routes compute next_run_at and cron worker lifecycle hooks run", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });

  let startCalls = 0;
  let closeCalls = 0;
  const app = buildRuntimeApiServer({
    store,
    queueWorker: null,
    cronWorker: {
      async start() {
        startCalls += 1;
      },
      async close() {
        closeCalls += 1;
      }
    }
  });
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/cronjobs",
      payload: {
        workspace_id: workspace.id,
        initiated_by: "workspace_agent",
        session_id: "session-main",
        cron: "0 9 * * *",
        description: "Daily check",
        delivery: { channel: "session_run" },
        model: "openai_codex/gpt-5.4",
      }
    });
    const body = created.json() as {
      id: string;
      next_run_at: string | null;
      metadata: {
        model?: string;
        source_session_id?: string;
      };
    };
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/cronjobs/${body.id}`,
      payload: {
        workspace_id: workspace.id,
        cron: "0 10 * * *",
        session_id: "session-follow-up",
      }
    });
    const updatedBody = updated.json() as {
      next_run_at: string | null;
      metadata: {
        model?: string;
        source_session_id?: string;
      };
    };

    assert.equal(startCalls, 1);
    assert.equal(created.statusCode, 200);
    assert.ok(body.next_run_at);
    assert.equal(body.metadata.model, undefined);
    assert.equal(body.metadata.source_session_id, "session-main");
    assert.equal(updated.statusCode, 200);
    assert.ok(updatedBody.next_run_at);
    assert.equal(updatedBody.metadata.model, undefined);
    assert.equal(
      updatedBody.metadata.source_session_id,
      "session-main",
      "session_id patches do not overwrite an existing source_session_id",
    );
  } finally {
    await app.close();
    assert.equal(closeCalls, 1);
    store.close();
  }
});

test("cronjob run-now route fires a fresh scheduled session with the cronjob instruction", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  const workspace = seedWorkspaceRecord(store, {
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "Run now",
    cron: "0 9 * * *",
    description: "Report the current model.",
    instruction: "Report the current model.",
    delivery: { channel: "session_run" },
    enabled: true,
    nextRunAt: "2025-01-01T09:00:00Z",
  });

  const app = buildRuntimeApiServer({ store, queueWorker: null, cronWorker: null });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/cronjobs/${job.id}/run`,
      query: { workspace_id: workspace.id },
      payload: {},
    });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.equal(body.success, true);
    assert.equal(typeof body.session_id, "string");
    assert.ok(body.session_id);

    const queued = store.claimInputs({ limit: 10, claimedBy: "test", leaseSeconds: 300 });
    assert.equal(queued.length, 1);
    const runNowText = String(queued[0]?.payload.text ?? "");
    assert.ok(runNowText.includes("Report the current model."));
    assert.match(runNowText, /scheduled run/i);

    const updated = store.getCronjob({ workspaceId: workspace.id, jobId: job.id });
    assert.equal(updated?.runCount, 1);
    assert.equal(updated?.lastStatus, "fired");
  } finally {
    await app.close();
    store.close();
  }
});
