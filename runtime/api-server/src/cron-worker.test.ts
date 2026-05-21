import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

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

test("cronjob helpers honor next_run_at and preserve legacy scheduling fallback", () => {
  const scheduledJob = {
    enabled: true,
    cron: "0 9 * * *",
    lastRunAt: null,
    nextRunAt: "2025-01-01T10:00:00Z"
  };
  assert.equal(cronjobIsDue(scheduledJob as never, new Date("2025-01-01T09:30:00Z")), false);
  assert.equal(cronjobIsDue(scheduledJob as never, new Date("2025-01-01T10:00:00Z")), true);

  const legacyDueJob = {
    enabled: true,
    cron: "0 9 * * *",
    lastRunAt: null,
    nextRunAt: null
  };
  assert.equal(cronjobIsDue(legacyDueJob as never, new Date("2025-01-01T09:30:00Z")), true);
  assert.ok(cronjobNextRunAt("0 9 * * *", new Date("2025-01-01T09:30:00Z")));
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

test("runtime cron worker queues due session_run cronjobs as hidden subagents and updates bookkeeping", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        runtime: {
          default_model: "openai/gpt-5.4",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
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
  store.upsertConversationBinding({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: "session-main",
    role: "main_session",
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "Daily",
    cron: "0 9 * * *",
    description: "Daily check",
    instruction: "Say hello",
    delivery: { channel: "session_run" },
    metadata: {
      session_id: "session-main",
      model: "openai_codex/gpt-5.4",
      priority: 3,
      idempotency_key: "cron-idempotency",
      team: "growth"
    },
    nextRunAt: "2025-01-01T09:00:00Z",
  });

  let wakeCalls = 0;
  const worker = new RuntimeCronWorker({
    store,
    queueWorker: {
      async start() {},
      wake() {
        wakeCalls += 1;
      },
      async close() {}
    }
  });

  const processed = await worker.processDueCronjobsOnce(new Date("2025-01-01T09:30:00Z"));
  const updated = store.getCronjob({ workspaceId: workspace.id, jobId: job.id });
  const runs = store.listSubagentRunsByWorkspace({ workspaceId: workspace.id });
  const run = runs[0];
  const runtimeState = run
    ? store.getRuntimeState({
        workspaceId: workspace.id,
        sessionId: run.childSessionId,
      })
    : null;
  const queued = store.claimInputs({ limit: 10, claimedBy: "test", leaseSeconds: 300 });
  const childSession = run
    ? store.getSession({ workspaceId: workspace.id, sessionId: run.childSessionId })
    : null;
  const notifications = store.listRuntimeNotifications({ workspaceId: workspace.id });

  assert.equal(processed, 1);
  assert.equal(wakeCalls, 1);
  assert.ok(updated);
  assert.equal(updated.lastStatus, "success");
  assert.equal(updated.runCount, 1);
  assert.ok(updated.lastRunAt);
  assert.ok(updated.nextRunAt);
  assert.equal(runs.length, 1);
  assert.ok(run);
  assert.equal(run?.originMainSessionId, "session-main");
  assert.equal(run?.ownerMainSessionId, "session-main");
  assert.equal(run?.parentSessionId, "session-main");
  assert.equal(run?.sourceType, "cronjob");
  assert.equal(run?.cronjobId, job.id);
  assert.equal(run?.status, "queued");
  assert.deepEqual(run?.toolProfile, {
    requested_tools: ["terminal", "file", "browser", "web"],
  });
  assert.equal(run?.requestedModel, null);
  assert.equal(run?.effectiveModel, "openai/gpt-5.4");
  assert.ok(childSession);
  assert.equal(childSession?.kind, "subagent");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "QUEUED");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.model, "openai/gpt-5.4");
  assert.equal(queued[0].payload.thinking_value, "medium");
  assert.equal(
    (queued[0].payload.context as Record<string, unknown>).source,
    "subagent",
  );
  assert.equal(
    (queued[0].payload.context as Record<string, unknown>).source_type,
    "cronjob",
  );
  assert.equal(
    (queued[0].payload.context as Record<string, unknown>).cronjob_id,
    job.id,
  );
  assert.equal(
    (queued[0].payload.context as Record<string, unknown>).subagent_id,
    run?.subagentId,
  );
  assert.deepEqual(
    (queued[0].payload.context as Record<string, unknown>).tool_profile,
    {
      requested_tools: ["terminal", "file", "browser", "web"],
    },
  );
  assert.match(String(queued[0].payload.text), /^Say hello/);
  assert.match(String(queued[0].payload.text), /\[Cronjob Metadata\]/);
  assert.equal(notifications.length, 0);

  store.close();
});

test("runtime cron worker auto-disables enabled lab cronjobs instead of executing them", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-lab-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "lab-1",
    name: "Lab 1",
    harness: "pi",
    status: "active",
    workspaceRole: "draft_lab",
    labPurpose: "workspace_onboarding",
    labStatus: "active",
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "Daily",
    cron: "0 9 * * *",
    description: "Daily check",
    instruction: "Say hello",
    enabled: true,
    delivery: { channel: "session_run" },
    nextRunAt: "2025-01-01T09:00:00Z",
  });

  const worker = new RuntimeCronWorker({ store });
  const processed = await worker.processDueCronjobsOnce(new Date("2025-01-01T09:30:00Z"));
  const updated = store.getCronjob({ workspaceId: workspace.id, jobId: job.id });
  const runs = store.listSubagentRunsByWorkspace({ workspaceId: workspace.id });

  assert.equal(processed, 0);
  assert.ok(updated);
  assert.equal(updated.enabled, false);
  assert.equal(updated.nextRunAt, null);
  assert.equal(updated.runCount, 0);
  assert.equal(updated.lastRunAt, null);
  assert.deepEqual(updated.metadata, {
    author_recommended_enabled: true,
    lab_execution_disabled: true,
  });
  assert.equal(runs.length, 0);

  store.close();
});

test("runtime cron worker inherits the latest non-batch main-session model when the cronjob has no explicit model", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        runtime: {
          default_model: "holaboss_model_proxy/gpt-5.4",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
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
  store.upsertConversationBinding({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: "session-main",
    role: "main_session",
  });
  store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "Use Codex for this workspace.",
      model: "openai_codex/gpt-5.4",
      thinking_value: "xhigh",
      context: {},
    },
  });
  store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "[Holaboss Main Session Event Batch v1]",
      model: "holaboss_model_proxy/gpt-5.4",
      thinking_value: "medium",
      context: {
        source: "main_session_event_batch",
      },
    },
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "Hourly follow composer",
    cron: "0 * * * *",
    description: "Follow the latest main-session model",
    instruction: "Do the hourly follow-composer task.",
    delivery: { channel: "session_run" },
    metadata: {},
    nextRunAt: "2025-01-01T09:00:00Z",
  });

  const worker = new RuntimeCronWorker({
    store,
    queueWorker: {
      async start() {},
      wake() {},
      async close() {}
    }
  });

  const processed = await worker.processDueCronjobsOnce(new Date("2025-01-01T09:30:00Z"));
  const queued = store.claimInputs({ limit: 10, claimedBy: "test", leaseSeconds: 300 });
  const runs = store.listSubagentRunsByWorkspace({ workspaceId: workspace.id });
  const childQueued = queued.find((record) =>
    typeof record.payload.context === "object" &&
    record.payload.context !== null &&
    (record.payload.context as Record<string, unknown>).source === "subagent"
  );

  assert.equal(processed, 1);
  assert.ok(childQueued);
  assert.equal(childQueued?.payload.model, "openai_codex/gpt-5.4");
  assert.equal(childQueued?.payload.thinking_value, "xhigh");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.requestedModel, "openai_codex/gpt-5.4");
  assert.equal(runs[0]?.effectiveModel, "openai_codex/gpt-5.4");

  store.close();
});

test("runtime cron worker prefers the current desktop main-session binding over the cronjob source session", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        runtime: {
          default_model: "openai/gpt-5.4",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-old",
    kind: "main_session",
  });
  store.ensureSession({
    workspaceId: workspace.id,
    sessionId: "session-current",
    kind: "main_session",
  });
  store.upsertConversationBinding({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: "session-current",
    role: "main_session",
  });
  store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-old",
    payload: {
      text: "Old main session composer",
      model: "openai_codex/gpt-5.4",
      thinking_value: "xhigh",
      context: {},
    },
  });
  store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-current",
    payload: {
      text: "Current desktop composer",
      model: "holaboss_model_proxy/gpt-5.5",
      thinking_value: "medium",
      context: {},
    },
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "Follow desktop composer",
    cron: "0 9 * * *",
    description: "Use the current desktop main session",
    instruction: "Use the current desktop main session.",
    delivery: { channel: "session_run" },
    metadata: {
      source_session_id: "session-old",
    },
    nextRunAt: "2025-01-01T09:00:00Z",
  });

  const worker = new RuntimeCronWorker({
    store,
    queueWorker: {
      async start() {},
      wake() {},
      async close() {}
    }
  });

  const processed = await worker.processDueCronjobsOnce(new Date("2025-01-01T09:30:00Z"));
  const queued = store.claimInputs({ limit: 10, claimedBy: "test", leaseSeconds: 300 });
  const runs = store.listSubagentRunsByWorkspace({ workspaceId: workspace.id });
  const childQueued = queued.find((record) =>
    typeof record.payload.context === "object" &&
    record.payload.context !== null &&
    (record.payload.context as Record<string, unknown>).source === "subagent"
  );

  assert.equal(processed, 1);
  assert.ok(childQueued);
  assert.equal(childQueued?.payload.model, "holaboss_model_proxy/gpt-5.5");
  assert.equal(childQueued?.payload.thinking_value, "medium");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.ownerMainSessionId, "session-current");
  assert.equal(runs[0]?.requestedModel, "holaboss_model_proxy/gpt-5.5");
  assert.equal(runs[0]?.effectiveModel, "holaboss_model_proxy/gpt-5.5");

  store.close();
});

test("runtime cron worker ignores the configured global subagent model and follows the main-session model", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        runtime: {
          default_model: "openai/gpt-5.4",
          subagents: {
            model: "anthropic_direct/claude-sonnet-4-6",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
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
  store.upsertConversationBinding({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: "session-main",
    role: "main_session",
  });
  store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "Use Codex for cronjobs.",
      model: "openai_codex/gpt-5.4",
      thinking_value: "xhigh",
      context: {},
    },
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "Hello",
    cron: "0 9 * * *",
    description: "Say hello every day.",
    instruction: "Say hello.",
    delivery: { channel: "session_run" },
    metadata: {},
    nextRunAt: "2025-01-01T09:00:00Z",
  });

  const worker = new RuntimeCronWorker({
    store,
    queueWorker: {
      async start() {},
      wake() {},
      async close() {}
    }
  });

  const processed = await worker.processDueCronjobsOnce(new Date("2025-01-01T09:30:00Z"));
  const queued = store.claimInputs({ limit: 10, claimedBy: "test", leaseSeconds: 300 });
  const runs = store.listSubagentRunsByWorkspace({ workspaceId: workspace.id });
  const childQueued = queued.find((record) =>
    typeof record.payload.context === "object" &&
    record.payload.context !== null &&
    (record.payload.context as Record<string, unknown>).source === "subagent"
  );

  assert.equal(processed, 1);
  assert.ok(childQueued);
  assert.equal(childQueued?.payload.model, "openai_codex/gpt-5.4");
  assert.equal(childQueued?.payload.thinking_value, "xhigh");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.ownerMainSessionId, "session-main");
  assert.equal(runs[0]?.requestedModel, "openai_codex/gpt-5.4");
  assert.equal(runs[0]?.effectiveModel, "openai_codex/gpt-5.4");

  store.close();
});

test("runtime cron worker persists system_notification cronjobs as unread notifications", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "drink-water-minute",
    cron: "0 9 * * *",
    description: "Time to drink water.",
    delivery: { channel: "system_notification" },
    metadata: {
      notification_title: "Drink Water",
      notification_level: "warning",
      notification_priority: "critical"
    },
    nextRunAt: "2025-01-01T09:00:00Z",
  });

  const worker = new RuntimeCronWorker({ store });
  const processed = await worker.processDueCronjobsOnce(new Date("2025-01-01T09:30:00Z"));
  const notifications = store.listRuntimeNotifications({ workspaceId: workspace.id });
  const updated = store.getCronjob({ workspaceId: workspace.id, jobId: job.id });

  assert.equal(processed, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.title, "Drink Water");
  assert.equal(notifications[0]?.message, "Time to drink water.");
  assert.equal(notifications[0]?.level, "warning");
  assert.equal(notifications[0]?.priority, "critical");
  assert.equal(notifications[0]?.state, "unread");
  assert.equal(notifications[0]?.cronjobId, job.id);
  assert.ok(updated);
  assert.equal(updated.lastStatus, "success");
  assert.equal(updated.runCount, 1);

  store.close();
});

test("runtime cron worker records failures for unsupported delivery channels", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
  });
  const job = store.createCronjob({
    workspaceId: "workspace-1",
    initiatedBy: "workspace_agent",
    name: "Broken",
    cron: "0 9 * * *",
    description: "Broken",
    delivery: { channel: "email" },
    nextRunAt: "2025-01-01T09:00:00Z",
  });

  const worker = new RuntimeCronWorker({ store });
  const processed = await worker.processDueCronjobsOnce(new Date("2025-01-01T09:30:00Z"));
  const updated = store.getCronjob({ workspaceId: "workspace-1", jobId: job.id });

  assert.equal(processed, 1);
  assert.ok(updated);
  assert.equal(updated.lastStatus, "failed");
  assert.equal(updated.runCount, 0);
  assert.match(updated.lastError ?? "", /unsupported cronjob delivery channel/);

  store.close();
});

test("cronjob routes compute next_run_at and cron worker lifecycle hooks run", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
  const workspace = store.createWorkspace({
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
    bridgeWorker: null,
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
    assert.equal(updatedBody.metadata.source_session_id, "session-follow-up");
  } finally {
    await app.close();
    assert.equal(closeCalls, 1);
    store.close();
  }
});

test("cronjob run-now route follows the current composer model override", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const configPath = path.join(root, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        runtime: {
          default_model: "openai/gpt-5.4",
          subagents: {
            model: "anthropic_direct/claude-sonnet-4-6",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  process.env.HB_SANDBOX_ROOT = root;
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
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
  store.upsertConversationBinding({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: "session-main",
    role: "main_session",
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "Run now follows composer",
    cron: "0 9 * * *",
    description: "Follow the current composer model",
    instruction: "Report the current model.",
    delivery: { channel: "session_run" },
    metadata: {
      source_session_id: "session-main",
      model: "openai_codex/gpt-5.4",
    },
    nextRunAt: "2025-01-01T09:00:00Z",
  });

  const app = buildRuntimeApiServer({
    store,
    queueWorker: null,
    bridgeWorker: null,
    cronWorker: null,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/cronjobs/${job.id}/run`,
      query: {
        workspace_id: workspace.id,
      },
      payload: {
        model: "holaboss_model_proxy/gpt-5.5",
      }
    });
    const queued = store.claimInputs({ limit: 10, claimedBy: "test", leaseSeconds: 300 });
    const runs = store.listSubagentRunsByWorkspace({ workspaceId: workspace.id });

    assert.equal(response.statusCode, 200);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.payload.model, "holaboss_model_proxy/gpt-5.5");
    assert.equal(queued[0]?.payload.thinking_value, "medium");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.requestedModel, "holaboss_model_proxy/gpt-5.5");
    assert.equal(runs[0]?.effectiveModel, "holaboss_model_proxy/gpt-5.5");
  } finally {
    await app.close();
    store.close();
  }
});

test("runtime cron worker does not execute a newly created cronjob before next_run_at", async () => {
  const root = makeTempDir("hb-runtime-cron-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });
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
  store.upsertConversationBinding({
    workspaceId: workspace.id,
    channel: "desktop",
    conversationKey: "main_session",
    sessionId: "session-main",
    role: "main_session",
  });
  const job = store.createCronjob({
    workspaceId: workspace.id,
    initiatedBy: "workspace_agent",
    name: "Hourly US News",
    cron: "0 * * * *",
    description: "Fetch latest US news",
    instruction: "Research the latest US news headlines and provide a concise hourly summary.",
    delivery: { channel: "session_run" },
    metadata: {
      source_session_id: "session-main",
      model: "openai_codex/gpt-5.4",
    },
    nextRunAt: "2025-01-01T10:00:00Z",
  });

  let wakeCalls = 0;
  const worker = new RuntimeCronWorker({
    store,
    queueWorker: {
      async start() {},
      wake() {
        wakeCalls += 1;
      },
      async close() {}
    }
  });

  const processed = await worker.processDueCronjobsOnce(new Date("2025-01-01T09:30:00Z"));
  const updated = store.getCronjob({ workspaceId: "workspace-1", jobId: job.id });
  const runs = store.listSubagentRunsByWorkspace({ workspaceId: workspace.id });
  const notifications = store.listRuntimeNotifications({ workspaceId: workspace.id });

  assert.equal(processed, 0);
  assert.equal(wakeCalls, 0);
  assert.ok(updated);
  assert.equal(updated.lastRunAt, null);
  assert.equal(updated.runCount, 0);
  assert.equal(updated.nextRunAt, "2025-01-01T10:00:00Z");
  assert.equal(runs.length, 0);
  assert.equal(notifications.length, 0);

  store.close();
});
