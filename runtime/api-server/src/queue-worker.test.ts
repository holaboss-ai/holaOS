import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { buildRuntimeApiServer } from "./app.js";
import { RuntimeQueueWorker } from "./queue-worker.js";
import type { RuntimeSentryCaptureOptions } from "./runtime-sentry.js";

const tempDirs: string[] = [];

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

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  pollIntervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out while waiting for condition");
    }
    await sleep(pollIntervalMs);
  }
}

function outputEventsForInput(
  store: RuntimeStateStore,
  record: { workspaceId: string; sessionId: string; inputId: string },
) {
  return store.listOutputEvents({
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    inputId: record.inputId,
  });
}

function turnResultForInput(
  store: RuntimeStateStore,
  record: { workspaceId: string; inputId: string },
) {
  return store.getTurnResult({
    workspaceId: record.workspaceId,
    inputId: record.inputId,
  });
}

test("runtime queue worker claims queued inputs and executes them in claim order", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-");
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
  const low = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    priority: 1,
    payload: { text: "low" }
  });
  const high = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    priority: 5,
    payload: { text: "high" }
  });

  const seen: string[] = [];
  const worker = new RuntimeQueueWorker({
    store,
    executeClaimedInput: async (record) => {
      seen.push(record.inputId);
      store.updateInput({ workspaceId: record.workspaceId, inputId: record.inputId, fields: {
        status: "DONE",
        claimedBy: null,
        claimedUntil: null,
      } });
    }
  });

  const firstCount = await worker.processAvailableInputsOnce();
  const secondCount = await worker.processAvailableInputsOnce();
  const thirdCount = await worker.processAvailableInputsOnce();

  assert.equal(firstCount, 1);
  assert.equal(secondCount, 1);
  assert.equal(thirdCount, 0);
  assert.deepEqual(seen, [high.inputId, low.inputId]);

  store.close();
});

test("runtime queue worker executes different sessions concurrently while preserving one active input per session", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-");
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
  store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-a",
    priority: 5,
    payload: { text: "a-1" }
  });
  store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-a",
    priority: 4,
    payload: { text: "a-2" }
  });
  store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-b",
    priority: 3,
    payload: { text: "b-1" }
  });

  let active = 0;
  let maxActive = 0;
  const seenSessions: string[] = [];
  const worker = new RuntimeQueueWorker({
    store,
    maxConcurrency: 2,
    executeClaimedInput: async (record) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      seenSessions.push(record.sessionId);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
    }
  });

  const processed = await worker.processAvailableInputsOnce();

  assert.equal(processed, 2);
  assert.equal(maxActive, 2);
  assert.deepEqual(seenSessions.sort(), ["session-a", "session-b"]);
  await worker.close();
  store.close();
});

test("runtime queue worker defaults to five concurrent sessions", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-");
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
  for (let index = 0; index < 6; index += 1) {
    store.enqueueInput({
      workspaceId: "workspace-1",
      sessionId: `session-${index + 1}`,
      priority: 10 - index,
      payload: { text: `task-${index + 1}` }
    });
  }

  let active = 0;
  let maxActive = 0;
  const worker = new RuntimeQueueWorker({
    store,
    executeClaimedInput: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
    }
  });

  const processed = await worker.processAvailableInputsOnce();

  assert.equal(processed, 5);
  assert.equal(maxActive, 5);
  await worker.close();
  store.close();
});

test("runtime queue worker claims later queued work from another session while one session is already active", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-");
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
  store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-a",
    priority: 5,
    payload: { text: "a-1" }
  });
  const sessionASecond = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-a",
    priority: 4,
    payload: { text: "a-2" }
  });

  const release = deferred<void>();
  const aStarted = deferred<void>();
  const bStarted = deferred<void>();
  const seenSessions: string[] = [];
  const worker = new RuntimeQueueWorker({
    store,
    maxConcurrency: 2,
    executeClaimedInput: async (record) => {
      seenSessions.push(record.sessionId);
      if (record.sessionId === "session-a") {
        aStarted.resolve();
      }
      if (record.sessionId === "session-b") {
        bStarted.resolve();
      }
      await release.promise;
    }
  });

  const firstProcessed = await worker.processAvailableInputsOnce();
  assert.equal(firstProcessed, 1);
  await aStarted.promise;

  const sessionBFirst = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-b",
    priority: 3,
    payload: { text: "b-1" }
  });

  const secondProcessed = await worker.processAvailableInputsOnce();
  assert.equal(secondProcessed, 1);
  await bStarted.promise;

  assert.deepEqual(seenSessions.sort(), ["session-a", "session-b"]);
  assert.equal(store.getInput({ workspaceId: sessionASecond.workspaceId, inputId: sessionASecond.inputId })?.status, "QUEUED");
  assert.equal(store.getInput({ workspaceId: sessionBFirst.workspaceId, inputId: sessionBFirst.inputId })?.status, "CLAIMED");

  release.resolve();
  await worker.close();
  store.close();
});

test("runtime queue worker marks claimed input failed when delegated execution raises", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-");
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
  store.ensureRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "QUEUED",
    currentInputId: "input-1"
  });
  const queued = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    priority: 1,
    payload: { text: "hello" }
  });
  const sentryCaptures: RuntimeSentryCaptureOptions[] = [];

  const worker = new RuntimeQueueWorker({
    store,
    captureRuntimeException: (capture) => {
      sentryCaptures.push(capture);
    },
    executeClaimedInput: async () => {
      throw new Error("delegated execution failed");
    }
  });

  const processed = await worker.processAvailableInputsOnce();
  const updated = store.getInput({ workspaceId: queued.workspaceId, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main"
  });

  assert.equal(processed, 1);
  assert.ok(updated);
  assert.equal(updated.status, "FAILED");
  assert.equal(updated.claimedBy, null);
  assert.equal(updated.claimedUntil, null);
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "ERROR");
  assert.deepEqual(runtimeState.lastError, { message: "delegated execution failed" });
  assert.equal(sentryCaptures.length, 1);
  assert.equal(sentryCaptures[0]?.tags?.failure_kind, "claimed_input_exception");
  assert.equal(
    sentryCaptures[0]?.contexts?.claimed_input?.input_id,
    queued.inputId,
  );

  store.close();
});

test("runtime queue worker can pause a queued session input before it is claimed", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-pause-");
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
  const queued = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "pause this" }
  });
  store.updateRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "QUEUED",
    currentInputId: queued.inputId,
    currentWorkerId: null,
    leaseUntil: null,
    heartbeatAt: null,
    lastError: null,
  });

  const worker = new RuntimeQueueWorker({ store });
  const paused = await worker.pauseSessionRun({
    workspaceId: "workspace-1",
    sessionId: "session-main",
  });
  const updated = store.getInput({ workspaceId: queued.workspaceId, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
  });
  const events = store.listOutputEvents({
    workspaceId: queued.workspaceId,
    sessionId: "session-main",
    inputId: queued.inputId,
  });
  const turnResult = store.getTurnResult({
    workspaceId: queued.workspaceId,
    inputId: queued.inputId,
  });

  assert.deepEqual(paused, {
    inputId: queued.inputId,
    sessionId: "session-main",
    status: "PAUSED",
  });
  assert.ok(updated);
  assert.equal(updated.status, "PAUSED");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "PAUSED");
  assert.equal(runtimeState.currentInputId, null);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventType, "run_completed");
  assert.deepEqual(events[0]?.payload, {
    status: "paused",
    stop_reason: "paused",
    message: "Run paused by user request",
  });
  assert.ok(turnResult);
  assert.equal(turnResult.status, "paused");
  assert.equal(turnResult.stopReason, "paused");

  store.close();
});

test("runtime queue worker recovers expired claimed input before processing fresh queue work", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-");
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
  const stale = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "stale" }
  });
  const fresh = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "fresh" }
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "worker-old",
    leaseSeconds: 60
  });
  assert.equal(claimed[0]?.inputId, stale.inputId);
  store.appendOutputEvent({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: stale.inputId,
    sequence: 1,
    eventType: "run_started",
    payload: { status: "running" },
  });
  store.updateInput({ workspaceId: stale.workspaceId, inputId: stale.inputId, fields: {
    claimedUntil: "2000-01-01T00:00:00.000Z"
  } });
  store.updateRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "BUSY",
    currentInputId: stale.inputId,
    currentWorkerId: "worker-old",
    leaseUntil: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    lastError: null
  });
  const seen: string[] = [];
  const worker = new RuntimeQueueWorker({
    store,
    executeClaimedInput: async (record) => {
      seen.push(record.inputId);
      store.updateInput({ workspaceId: record.workspaceId, inputId: record.inputId, fields: {
        status: "DONE",
        claimedBy: null,
        claimedUntil: null
      } });
      store.updateRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        status: "IDLE",
        currentInputId: null,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError: null
      });
    }
  });

  const processed = await worker.processAvailableInputsOnce();
  const staleUpdated = store.getInput({ workspaceId: stale.workspaceId, inputId: stale.inputId });
  const freshUpdated = store.getInput({ workspaceId: fresh.workspaceId, inputId: fresh.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main"
  });
  const staleEvents = store.listOutputEvents({
    workspaceId: stale.workspaceId,
    sessionId: "session-main",
    inputId: stale.inputId
  });

  assert.equal(processed, 2);
  assert.ok(staleUpdated);
  assert.equal(staleUpdated.status, "FAILED");
  assert.ok(freshUpdated);
  assert.equal(freshUpdated.status, "DONE");
  assert.deepEqual(seen, [fresh.inputId]);
  assert.equal(staleEvents.at(-1)?.eventType, "run_failed");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "IDLE");

  store.close();
});

test("runtime queue worker recovers a stale claimed input from another worker before lease expiry", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-stale-owner-");
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
  const stale = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "stale" }
  });
  const fresh = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "fresh" }
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "worker-old",
    leaseSeconds: 300
  });
  assert.equal(claimed[0]?.inputId, stale.inputId);
  store.appendOutputEvent({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: stale.inputId,
    sequence: 1,
    eventType: "run_started",
    payload: { status: "running" },
  });
  store.updateRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "BUSY",
    currentInputId: stale.inputId,
    currentWorkerId: "worker-old",
    leaseUntil: new Date(Date.now() + 300_000).toISOString(),
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    lastError: null
  });

  const seen: string[] = [];
  const worker = new RuntimeQueueWorker({
    store,
    claimedBy: "worker-new",
    claimStaleHeartbeatMs: 1_000,
    executeClaimedInput: async (record) => {
      seen.push(record.inputId);
      store.updateInput({ workspaceId: record.workspaceId, inputId: record.inputId, fields: {
        status: "DONE",
        claimedBy: null,
        claimedUntil: null
      } });
      store.updateRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        status: "IDLE",
        currentInputId: null,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError: null
      });
    }
  });

  const processed = await worker.processAvailableInputsOnce();
  const staleUpdated = store.getInput({ workspaceId: stale.workspaceId, inputId: stale.inputId });
  const freshUpdated = store.getInput({ workspaceId: fresh.workspaceId, inputId: fresh.inputId });
  const events = store.listOutputEvents({
    workspaceId: stale.workspaceId,
    sessionId: "session-main",
    inputId: stale.inputId
  });

  assert.equal(processed, 2);
  assert.deepEqual(seen, [fresh.inputId]);
  assert.equal(staleUpdated?.status, "FAILED");
  assert.equal(freshUpdated?.status, "DONE");
  assert.equal(events.at(-1)?.eventType, "run_failed");
  assert.match(String(events.at(-1)?.payload.message ?? ""), /abandoned/i);

  store.close();
});

test("runtime queue worker requeues a stale claimed input when execution never started", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-stale-prestart-");
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
  const stale = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "stale" }
  });
  store.claimInputs({
    limit: 1,
    claimedBy: "worker-old",
    leaseSeconds: 300
  });
  store.appendOutputEvent({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: stale.inputId,
    sequence: 1,
    eventType: "run_claimed",
    payload: { instruction_preview: "stale" },
  });
  store.updateRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "BUSY",
    currentInputId: stale.inputId,
    currentWorkerId: "worker-old",
    leaseUntil: new Date(Date.now() + 300_000).toISOString(),
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    lastError: null
  });

  const seen: string[] = [];
  const worker = new RuntimeQueueWorker({
    store,
    claimedBy: "worker-new",
    claimStaleHeartbeatMs: 1_000,
    executeClaimedInput: async (record) => {
      seen.push(record.inputId);
      store.updateInput({ workspaceId: record.workspaceId, inputId: record.inputId, fields: {
        status: "DONE",
        claimedBy: null,
        claimedUntil: null,
      } });
      store.updateRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        status: "IDLE",
        currentInputId: null,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError: null,
      });
    }
  });

  const processed = await worker.processAvailableInputsOnce();

  const updated = store.getInput({ workspaceId: stale.workspaceId, inputId: stale.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
  });
  const events = store.listOutputEvents({
    workspaceId: stale.workspaceId,
    sessionId: "session-main",
    inputId: stale.inputId,
  });

  assert.equal(processed, 2);
  assert.deepEqual(seen, [stale.inputId]);
  assert.equal(updated?.status, "DONE");
  assert.equal(updated?.attempt, 1);
  assert.equal(runtimeState?.status, "IDLE");
  assert.equal(events.some((event) => event.eventType === "run_failed"), false);

  store.close();
});

test("runtime queue worker does not recover a claimed input from another worker while its heartbeat is fresh", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-live-owner-");
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
  const active = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "active" }
  });
  const blocked = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "blocked" }
  });
  const claimed = store.claimInputs({
    limit: 1,
    claimedBy: "worker-old",
    leaseSeconds: 300
  });
  assert.equal(claimed[0]?.inputId, active.inputId);
  store.updateRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "BUSY",
    currentInputId: active.inputId,
    currentWorkerId: "worker-old",
    leaseUntil: new Date(Date.now() + 300_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    lastError: null
  });

  const worker = new RuntimeQueueWorker({
    store,
    claimedBy: "worker-new",
    claimStaleHeartbeatMs: 1_000,
    executeClaimedInput: async () => {
      throw new Error("should not execute new work while another worker is still active");
    }
  });

  const processed = await worker.processAvailableInputsOnce();

  assert.equal(processed, 0);
  assert.equal(store.getInput({ workspaceId: active.workspaceId, inputId: active.inputId })?.status, "CLAIMED");
  assert.equal(store.getInput({ workspaceId: blocked.workspaceId, inputId: blocked.inputId })?.status, "QUEUED");

  store.close();
});

test("runtime queue worker aborts an active run when recovering an expired claim", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-expired-abort-");
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
  const queued = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "stale" }
  });
  const started = deferred<void>();
  let abortReason: unknown = null;
  const worker = new RuntimeQueueWorker({
    store,
    executeClaimedInput: async (_record, options = {}) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          abortReason = options.signal.reason;
          resolve();
          return;
        }
        options.signal?.addEventListener(
          "abort",
          () => {
            abortReason = options.signal?.reason;
            resolve();
          },
          { once: true },
        );
      });
    }
  });

  const firstProcessed = await worker.processAvailableInputsOnce();
  assert.equal(firstProcessed, 1);
  await started.promise;

  store.updateInput({ workspaceId: queued.workspaceId, inputId: queued.inputId, fields: {
    claimedUntil: "2000-01-01T00:00:00.000Z"
  } });
  store.updateRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    status: "BUSY",
    currentInputId: queued.inputId,
    currentWorkerId: "sandbox-agent-ts-worker",
    leaseUntil: "2000-01-01T00:00:00.000Z",
    heartbeatAt: "2000-01-01T00:00:00.000Z",
    lastError: null
  });

  const secondProcessed = await worker.processAvailableInputsOnce();
  await worker.close();

  const updated = store.getInput({ workspaceId: queued.workspaceId, inputId: queued.inputId });
  const runtimeState = store.getRuntimeState({
    workspaceId: "workspace-1",
    sessionId: "session-main"
  });
  const events = store.listOutputEvents({
    workspaceId: queued.workspaceId,
    sessionId: "session-main",
    inputId: queued.inputId
  });

  assert.equal(secondProcessed, 1);
  assert.equal(abortReason, "claim_expired");
  assert.ok(updated);
  assert.equal(updated.status, "FAILED");
  assert.ok(runtimeState);
  assert.equal(runtimeState.status, "ERROR");
  assert.equal(events.at(-1)?.eventType, "run_failed");

  store.close();
});

test("runtime queue worker renews an expired claimed input while it waits on a session checkpoint", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-checkpoint-lease-");
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
  const checkpointJob = store.enqueuePostRunJob({
    jobType: "session_checkpoint",
    workspaceId: "workspace-1",
    sessionId: "session-main",
    inputId: "prior-input",
    payload: {
      context_usage: {
        tokens: 50_000,
        context_window: 65_536,
        percent: 76.3,
      },
    },
  });
  store.updatePostRunJob({ workspaceId: checkpointJob.workspaceId, jobId: checkpointJob.jobId, fields: {
    status: "CLAIMED",
    claimedBy: "memory-worker",
    claimedUntil: new Date(Date.now() + 60_000).toISOString(),
  } });
  const queued = store.enqueueInput({
    workspaceId: "workspace-1",
    sessionId: "session-main",
    payload: { text: "wait behind checkpoint" }
  });

  const worker = new RuntimeQueueWorker({
    store,
    leaseSeconds: 1,
    pollIntervalMs: 50,
    executeClaimedInput: async (record) => {
      await waitFor(
        () =>
          store.listPostRunJobs({
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            jobType: "session_checkpoint",
            statuses: ["QUEUED", "CLAIMED"],
            limit: 1,
            offset: 0,
          }).length === 0,
        5_000,
      );
      store.updateInput({ workspaceId: record.workspaceId, inputId: record.inputId, fields: {
        status: "DONE",
        claimedBy: null,
        claimedUntil: null,
      } });
      store.updateRuntimeState({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        status: "IDLE",
        currentInputId: null,
        currentWorkerId: null,
        leaseUntil: null,
        heartbeatAt: null,
        lastError: null,
      });
    },
  });

  await worker.start();
  worker.wake();

  await waitFor(
    () => store.getInput({ workspaceId: queued.workspaceId, inputId: queued.inputId })?.status === "CLAIMED",
  );
  await sleep(1_250);

  const claimedWhileWaiting = store.getInput({ workspaceId: queued.workspaceId, inputId: queued.inputId });
  assert.ok(claimedWhileWaiting);
  assert.equal(claimedWhileWaiting.status, "CLAIMED");
  assert.ok(claimedWhileWaiting.claimedUntil);
  assert.ok(Date.parse(claimedWhileWaiting.claimedUntil) > Date.now());

  store.updatePostRunJob({ workspaceId: checkpointJob.workspaceId, jobId: checkpointJob.jobId, fields: {
    status: "DONE",
    claimedBy: null,
    claimedUntil: null,
    lastError: null,
  } });
  worker.wake();

  await waitFor(
    () => store.getInput({ workspaceId: queued.workspaceId, inputId: queued.inputId })?.status === "DONE",
    5_000,
  );
  await worker.close();

  const updated = store.getInput({ workspaceId: queued.workspaceId, inputId: queued.inputId });
  const events = store.listOutputEvents({
    workspaceId: queued.workspaceId,
    sessionId: "session-main",
    inputId: queued.inputId,
  });
  assert.ok(updated);
  assert.equal(updated.status, "DONE");
  assert.equal(events.some((event) => event.eventType === "run_failed"), false);

  store.close();
});

test("queue route wakes configured queue worker", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-");
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

  let wakeCalls = 0;
  let startCalls = 0;
  let closeCalls = 0;
  const app = buildRuntimeApiServer({
    store,
    queueWorker: {
      async start() {
        startCalls += 1;
      },
      wake() {
        wakeCalls += 1;
      },
      async close() {
        closeCalls += 1;
      }
    },
    cronWorker: null,
    bridgeWorker: null
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/agent-sessions/queue",
    payload: {
      workspace_id: workspace.id,
      session_id: "session-main",
      text: "hello world"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(startCalls, 1);
  assert.equal(wakeCalls, 1);

  await app.close();
  assert.equal(closeCalls, 1);
  store.close();
});

test("app lifecycle starts and closes configured durable memory worker", async () => {
  const root = makeTempDir("hb-runtime-queue-worker-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "runtime.db"),
    workspaceRoot: path.join(root, "workspace")
  });

  let startCalls = 0;
  let closeCalls = 0;
  const app = buildRuntimeApiServer({
    store,
    queueWorker: null,
    durableMemoryWorker: {
      async start() {
        startCalls += 1;
      },
      wake() {},
      async close() {
        closeCalls += 1;
      },
    },
    cronWorker: null,
    bridgeWorker: null,
  });

  const response = await app.inject({ method: "GET", url: "/healthz" });

  assert.equal(response.statusCode, 200);
  assert.equal(startCalls, 1);

  await app.close();
  assert.equal(closeCalls, 1);
  store.close();
});
