import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test as nodeTest } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { RuntimeMainSessionEventWorker } from "./main-session-event-worker.js";

const tempDirs: string[] = [];

function test(
  name: string,
  fn: () => void | Promise<void>,
): ReturnType<typeof nodeTest> {
  return nodeTest(name, { concurrency: false }, fn);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStore(prefix: string): RuntimeStateStore {
  const root = makeTempDir(prefix);
  return new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspaces"),
  });
}

function seedMainSession(store: RuntimeStateStore) {
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
  return workspace;
}

test("main-session event worker materializes active lab controller events", async () => {
  const store = makeStore("hb-main-session-event-worker-lab-");
  const sourceWorkspace = store.createWorkspace({
    workspaceId: "workspace-1",
    name: "Workspace 1",
    harness: "pi",
    status: "active",
    onboardingStatus: "pending",
    onboardingSessionId: "workspace_onboarding-1",
  });
  const labWorkspace = store.createWorkspace({
    workspaceId: "lab-1",
    name: "Workspace 1 Lab",
    harness: "pi",
    status: "active",
    onboardingStatus: "not_required",
    workspaceRole: "draft_lab",
    sourceWorkspaceId: sourceWorkspace.id,
    labPurpose: "workspace_onboarding",
    labStatus: "active",
  });
  store.ensureSession({
    workspaceId: labWorkspace.id,
    sessionId: "workspace_onboarding-1",
    kind: "workspace_onboarding",
  });
  store.ensureRuntimeState({
    workspaceId: labWorkspace.id,
    sessionId: "workspace_onboarding-1",
    status: "IDLE",
  });
  const event = store.enqueueMainSessionEvent({
    workspaceId: labWorkspace.id,
    ownerMainSessionId: "workspace_onboarding-1",
    originMainSessionId: "workspace_onboarding-1",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: { summary: "Implemented the accepted design." },
  });

  const worker = new RuntimeMainSessionEventWorker({ store });
  const processed = await worker.processAvailableEventsOnce();
  const updatedEvent = store.getMainSessionEvent({
    workspaceId: labWorkspace.id,
    eventId: event.eventId,
  });
  const batchInput = updatedEvent?.materializedInputId
    ? store.getInput({
        workspaceId: labWorkspace.id,
        inputId: updatedEvent.materializedInputId,
      })
    : null;

  assert.equal(processed, 1);
  assert.equal(updatedEvent?.status, "materialized");
  assert.equal(batchInput?.workspaceId, labWorkspace.id);
  assert.equal(batchInput?.sessionId, "workspace_onboarding-1");
  assert.equal(
    (batchInput?.payload.context as Record<string, unknown>)?.source,
    "main_session_event_batch",
  );
  assert.equal(
    store.listPendingMainSessionEvents({
      workspaceId: labWorkspace.id,
      ownerMainSessionId: "workspace_onboarding-1",
    }).length,
    0,
  );

  store.close();
});

test("main-session event worker materializes waiting-user events into one queued main-session input", async () => {
  const store = makeStore("hb-main-session-event-worker-");
  const workspace = seedMainSession(store);
  let woke = 0;

  const first = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "waiting_on_user",
    deliveryBucket: "waiting_on_user",
    payload: {
      summary: "Need a repo name.",
      blocking_question: "Which repo should I inspect?",
    },
  });
  const second = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-2",
    eventType: "waiting_on_user",
    deliveryBucket: "waiting_on_user",
    payload: {
      summary: "Need project confirmation.",
      blocking_question: "Should I create a new GCP project?",
    },
  });

  const worker = new RuntimeMainSessionEventWorker({
    store,
    queueWorker: {
      async start() {},
      wake() {
        woke += 1;
      },
      async close() {},
    },
  });

  const processed = await worker.processAvailableEventsOnce();
  const firstUpdated = store.getMainSessionEvent({ workspaceId: workspace.id, eventId: first.eventId });
  const secondUpdated = store.getMainSessionEvent({ workspaceId: workspace.id, eventId: second.eventId });
  const batchInput = firstUpdated?.materializedInputId
    ? store.getInput({ workspaceId: workspace.id, inputId: firstUpdated.materializedInputId })
    : null;

  assert.equal(processed, 2);
  assert.equal(woke, 1);
  assert.ok(batchInput);
  assert.equal(batchInput?.sessionId, "session-main");
  assert.equal(batchInput?.priority, -100);
  const context = batchInput?.payload.context as Record<string, unknown>;
  assert.equal(context.source, "main_session_event_batch");
  assert.equal(context.delivery_bucket, "waiting_on_user");
  assert.deepEqual(
    [...(context.main_session_event_ids as string[])].sort(),
    [first.eventId, second.eventId].sort(),
  );
  assert.equal(typeof batchInput?.payload.text, "string");
  assert.match(String(batchInput?.payload.text), /numbered items/i);
  assert.ok(firstUpdated);
  assert.ok(secondUpdated);
  assert.equal(firstUpdated?.status, "materialized");
  assert.equal(secondUpdated?.status, "materialized");
  assert.equal(firstUpdated?.materializedInputId, batchInput?.inputId);
  assert.equal(secondUpdated?.materializedInputId, batchInput?.inputId);

  store.close();
});

test("main-session event worker does not materialize when the main session is busy", async () => {
  const store = makeStore("hb-main-session-event-worker-busy-");
  const workspace = seedMainSession(store);
  store.updateRuntimeState({
    workspaceId: workspace.id,
    sessionId: "session-main",
    status: "BUSY",
    currentInputId: null,
    currentWorkerId: "worker-1",
    leaseUntil: null,
    heartbeatAt: null,
    lastError: null,
  });
  store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: { summary: "Done." },
  });

  const worker = new RuntimeMainSessionEventWorker({ store });
  const processed = await worker.processAvailableEventsOnce();

  assert.equal(processed, 0);
  assert.equal(
    store.listPendingMainSessionEvents({ workspaceId: workspace.id, ownerMainSessionId: "session-main" })
      .length,
    1,
  );

  store.close();
});

test("main-session event worker defers its first startup scan until after the initial delay", async () => {
  const store = makeStore("hb-main-session-event-worker-delay-");
  const workspace = seedMainSession(store);

  store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: { summary: "Done." },
  });
  const initialEvent = store.listPendingMainSessionEvents({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
  })[0];

  const worker = new RuntimeMainSessionEventWorker({
    store,
    initialDelayMs: 50,
  });

  try {
    await worker.start();

    assert.equal(
      store.listPendingMainSessionEvents({ workspaceId: workspace.id, ownerMainSessionId: "session-main" })
        .length,
      1,
    );
    assert.equal(
      store.hasAvailableInputsForSession({
        workspaceId: workspace.id,
        sessionId: "session-main",
      }),
      false,
    );

    await sleep(250);

    const updatedEvent = initialEvent
      ? store.getMainSessionEvent({ workspaceId: workspace.id, eventId: initialEvent.eventId })
      : null;
    assert.equal(updatedEvent?.status, "materialized");
    assert.ok(updatedEvent?.materializedInputId);
    assert.equal(
      store.hasAvailableInputsForSession({
        workspaceId: workspace.id,
        sessionId: "session-main",
      }),
      true,
    );
  } finally {
    await worker.close();
    store.close();
  }
});

test("main-session event worker inherits the owner main session model and thinking for synthetic follow-ups", async () => {
  const store = makeStore("hb-main-session-event-worker-model-");
  const workspace = seedMainSession(store);
  const latestUserInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "hello",
      model: "openai_codex/gpt-5.4",
      thinking_value: "medium",
      context: {},
    },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: latestUserInput.inputId,
    fields: {
      status: "DONE",
      claimedBy: null,
      claimedUntil: null,
    },
  });
  const event = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: {
      source_type: "cronjob",
      title: "Hourly Us News",
      goal: "Fetch latest US news",
      context:
        "Research the latest US news headlines and provide a concise hourly summary with the most important developments.",
      cronjob_name: "hourly-us-news",
      cronjob_schedule: "0 * * * *",
      cronjob_first_run: true,
      summary: "Done.",
      assistant_text:
        "<html><body><h1>Full report body</h1><p>This should stay out of the main-session prompt.</p></body></html>",
      forwardable_deliverables: [
        {
          output_id: "output-1",
          artifact_id: "artifact-1",
          type: "report",
          output_type: "document",
          title: "done-report.md",
          status: "completed",
          file_path: "outputs/reports/done-report.md",
          metadata: {
            artifact_type: "report",
          },
        },
      ],
    },
  });

  const worker = new RuntimeMainSessionEventWorker({ store });
  const processed = await worker.processAvailableEventsOnce();
  const updatedEvent = store.getMainSessionEvent({ workspaceId: workspace.id, eventId: event.eventId });
  const batchInput = updatedEvent?.materializedInputId
    ? store.getInput({ workspaceId: workspace.id, inputId: updatedEvent.materializedInputId })
    : null;

  assert.equal(processed, 1);
  assert.equal(batchInput?.payload.model, "openai_codex/gpt-5.4");
  assert.equal(batchInput?.payload.thinking_value, "medium");
  assert.match(
    String(batchInput?.payload.text),
    /only one update, phrase it as a normal conversational continuation/i,
  );
  assert.match(
    String(batchInput?.payload.text),
    /Only use a clearly separated `Background updates` section when there are multiple distinct updates/i,
  );
  assert.match(String(batchInput?.payload.text), /numbered items/i);
  assert.match(
    String(batchInput?.payload.text),
    /supplemental continuation only/i,
  );
  assert.match(
    String(batchInput?.payload.text),
    /If completed work established clearly stable workspace-wide defaults that future runs should obey by default, record them in `AGENTS\.md` with `update_workspace_instructions` before replying\./i,
  );
  assert.match(
    String(batchInput?.payload.text),
    /Before writing to `AGENTS\.md`, ask whether the agent should obey the information by default on most future runs in this workspace even when the current subject is not in scope\./i,
  );
  assert.match(
    String(batchInput?.payload.text),
    /Use `AGENTS\.md` for rules, defaults, conventions, and recurring commands that should shape behavior by default, not as a general fact store for subject-specific knowledge\./i,
  );
  assert.match(
    String(batchInput?.payload.text),
    /Do not record named-subject knowledge in `AGENTS\.md` unless it is explicitly intended to become a workspace-wide default instruction\./i,
  );
  assert.match(
    String(batchInput?.payload.text),
    /A statement being durable or phrased as `remember this` does not by itself make it an `AGENTS\.md` item; if it is mainly contextual knowledge to recall later, keep it in memory instead\./i,
  );
  assert.match(
    String(batchInput?.payload.text),
    /Do not persist one-off deliverables, unresolved hypotheses, partial investigations, or temporary runtime state\. When in doubt, prefer memory or transient context over `AGENTS\.md`\./i,
  );
  assert.match(
    String(batchInput?.payload.text),
    /Do not repeat, paraphrase, or re-answer/i,
  );
  assert.match(
    String(batchInput?.payload.text),
    /Do not start with stock phrases like `Quick follow-up`/i,
  );
  assert.match(String(batchInput?.payload.text), /specific automation update/i);
  assert.match(String(batchInput?.payload.text), /hourly-us-news/i);
  assert.match(String(batchInput?.payload.text), /Fetch latest US news/i);
  assert.match(String(batchInput?.payload.text), /first run/i);
  assert.match(String(batchInput?.payload.text), /done-report\.md/i);
  assert.doesNotMatch(String(batchInput?.payload.text), /<html>/i);

  store.close();
});

test("main-session event worker recovers failed materialized events and retries them with a fresh synthetic input", async () => {
  const store = makeStore("hb-main-session-event-worker-recover-");
  const workspace = seedMainSession(store);
  const latestUserInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "hello",
      model: "openai_codex/gpt-5.4",
      thinking_value: "medium",
      context: {},
    },
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: latestUserInput.inputId,
    fields: {
      status: "DONE",
      claimedBy: null,
      claimedUntil: null,
    },
  });
  const event = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: { summary: "Done." },
  });
  const failedBatchInput = store.enqueueInput({
    workspaceId: workspace.id,
    sessionId: "session-main",
    payload: {
      text: "[Holaboss Main Session Event Batch v1]\nSummarize the queued event.",
      attachments: [],
      image_urls: [],
      context: {
        source: "main_session_event_batch",
        main_session_event_ids: [event.eventId],
        delivery_bucket: "background_update",
      },
    },
    idempotencyKey: `main-session-event-batch:${event.eventId}@${event.updatedAt}`,
  });
  store.updateInput({
    workspaceId: workspace.id,
    inputId: failedBatchInput.inputId,
    fields: {
      status: "FAILED",
      claimedBy: null,
      claimedUntil: null,
    },
  });
  store.markMainSessionEventsMaterialized({
    workspaceId: workspace.id,
    eventIds: [event.eventId],
    materializedInputId: failedBatchInput.inputId,
  });

  const worker = new RuntimeMainSessionEventWorker({ store });
  const processed = await worker.processAvailableEventsOnce();
  const updatedEvent = store.getMainSessionEvent({ workspaceId: workspace.id, eventId: event.eventId });
  const retriedInput = updatedEvent?.materializedInputId
    ? store.getInput({ workspaceId: workspace.id, inputId: updatedEvent.materializedInputId })
    : null;

  assert.equal(processed, 1);
  assert.ok(updatedEvent);
  assert.equal(updatedEvent?.status, "materialized");
  assert.notEqual(updatedEvent?.materializedInputId, failedBatchInput.inputId);
  assert.equal(retriedInput?.payload.model, "openai_codex/gpt-5.4");
  assert.equal(retriedInput?.payload.thinking_value, "medium");

  store.close();
});

test("main-session event worker ignores already materialized events", async () => {
  const store = makeStore("hb-main-session-event-worker-materialized-");
  const workspace = seedMainSession(store);
  const event = store.enqueueMainSessionEvent({
    workspaceId: workspace.id,
    ownerMainSessionId: "session-main",
    originMainSessionId: "session-main",
    subagentId: "subagent-1",
    eventType: "completed",
    deliveryBucket: "background_update",
    payload: { summary: "Done." },
  });
  store.markMainSessionEventsMaterialized({
    workspaceId: workspace.id,
    eventIds: [event.eventId],
    materializedInputId: "main-input-1",
  });

  const worker = new RuntimeMainSessionEventWorker({ store });
  const processed = await worker.processAvailableEventsOnce();
  const updatedEvent = store.getMainSessionEvent({ workspaceId: workspace.id, eventId: event.eventId });

  assert.equal(processed, 0);
  assert.equal(
    store.listPendingMainSessionEvents({ workspaceId: workspace.id, ownerMainSessionId: "session-main" })
      .length,
    0,
  );
  assert.equal(updatedEvent?.status, "materialized");
  assert.equal(updatedEvent?.materializedInputId, "main-input-1");
  assert.equal(
    store.hasAvailableInputsForSession({
      workspaceId: workspace.id,
      sessionId: "session-main",
    }),
    false,
  );

  store.close();
});
