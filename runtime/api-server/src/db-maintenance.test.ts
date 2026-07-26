import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type DbMaintenanceStore,
  runRuntimeDbMaintenance,
} from "./db-maintenance.js";

/** In-memory fake of the retention surface — no native DB needed. */
class FakeStore implements DbMaintenanceStore {
  outputEventRetentionPolicy = { maxAgeDays: 30, maxEventsPerSession: 100 };
  // sessionId -> array of event createdAt ISO strings (id order == array order).
  events = new Map<string, string[]>();
  compactionRequests = 0;
  failNextTrim = 0;

  seed(sessionId: string, count: number, createdAt: string): void {
    const arr = this.events.get(sessionId) ?? [];
    for (let i = 0; i < count; i++) {
      arr.push(createdAt);
    }
    this.events.set(sessionId, arr);
  }

  pruneRootOutputEventsByAge(params: { cutoffIso: string; limit: number }): number {
    let deleted = 0;
    for (const [sessionId, arr] of this.events) {
      const kept: string[] = [];
      for (const createdAt of arr) {
        if (deleted < params.limit && createdAt < params.cutoffIso) {
          deleted++;
        } else {
          kept.push(createdAt);
        }
      }
      this.events.set(sessionId, kept);
    }
    return deleted;
  }

  countRootOutputEventsOlderThan(cutoffIso: string): number {
    let n = 0;
    for (const arr of this.events.values()) {
      for (const createdAt of arr) {
        if (createdAt < cutoffIso) {
          n++;
        }
      }
    }
    return n;
  }

  listRootSessionsExceedingOutputEventCap(
    cap: number,
  ): Array<{ sessionId: string; count: number }> {
    const over: Array<{ sessionId: string; count: number }> = [];
    for (const [sessionId, arr] of this.events) {
      if (arr.length > cap) {
        over.push({ sessionId, count: arr.length });
      }
    }
    return over.sort((a, b) => b.count - a.count);
  }

  trimSessionOutputEvents(params: {
    workspaceId: string;
    sessionId: string;
    maxEvents: number;
    limit?: number;
  }): number {
    if (this.failNextTrim > 0) {
      this.failNextTrim--;
      throw new Error("database is locked");
    }
    const arr = this.events.get(params.sessionId) ?? [];
    const excess = Math.max(0, arr.length - params.maxEvents);
    const toDelete = Math.min(excess, params.limit ?? excess);
    if (toDelete > 0) {
      this.events.set(params.sessionId, arr.slice(toDelete));
    }
    return toDelete;
  }

  requestRootDbCompaction(): void {
    this.compactionRequests++;
  }
}

const NOW = new Date("2026-07-03T00:00:00.000Z");
const fastOpts = { startDelayMs: 0, pauseMs: 0, now: () => NOW };

test("age prune deletes everything older than the cutoff, in batches", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 30, maxEventsPerSession: 0 };
  // 250 old events (older than 30d) + 10 recent — batchSize 100 forces 3 passes.
  store.seed("s1", 250, "2026-01-01T00:00:00.000Z");
  store.seed("s1", 10, "2026-07-02T00:00:00.000Z");

  const result = await runRuntimeDbMaintenance({
    store,
    ...fastOpts,
    batchSize: 100,
    requestCompaction: false,
  });

  assert.equal(result.deletedByAge, 250);
  assert.equal(store.events.get("s1")?.length, 10);
});

test("per-session cap trims heaviest sessions down to the cap", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 0, maxEventsPerSession: 100 };
  store.seed("big", 350, "2026-07-02T00:00:00.000Z");
  store.seed("ok", 40, "2026-07-02T00:00:00.000Z");

  const result = await runRuntimeDbMaintenance({
    store,
    ...fastOpts,
    batchSize: 100,
    requestCompaction: false,
  });

  assert.equal(store.events.get("big")?.length, 100);
  assert.equal(store.events.get("ok")?.length, 40);
  assert.equal(result.deletedByCap, 250);
});

test("requests a compaction once enough rows are freed", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 0, maxEventsPerSession: 100 };
  store.seed("big", 1100, "2026-07-02T00:00:00.000Z");

  const result = await runRuntimeDbMaintenance({
    store,
    ...fastOpts,
    batchSize: 500,
    compactAfterDeletes: 500,
  });

  assert.equal(result.deletedByCap, 1000);
  assert.equal(result.compactionRequested, true);
  assert.equal(store.compactionRequests, 1);
});

test("does NOT request compaction below the free-rows threshold", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 0, maxEventsPerSession: 100 };
  store.seed("big", 150, "2026-07-02T00:00:00.000Z");

  const result = await runRuntimeDbMaintenance({
    store,
    ...fastOpts,
    batchSize: 500,
    compactAfterDeletes: 10_000,
  });

  assert.equal(result.deletedByCap, 50);
  assert.equal(result.compactionRequested, false);
  assert.equal(store.compactionRequests, 0);
});

test("a transient lock is retried, not fatal", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 0, maxEventsPerSession: 100 };
  store.seed("big", 200, "2026-07-02T00:00:00.000Z");
  store.failNextTrim = 2; // first two trim calls throw "database is locked"

  const result = await runRuntimeDbMaintenance({
    store,
    ...fastOpts,
    batchSize: 100,
    requestCompaction: false,
  });

  // Recovered after the transient failures and still trimmed to the cap.
  assert.equal(store.events.get("big")?.length, 100);
  assert.equal(result.deletedByCap, 100);
});

test("flags a heavy sweep up front and reports draining progress to done", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 30, maxEventsPerSession: 0 };
  // 1000 expired events; threshold 500 → heavy.
  store.seed("s1", 1000, "2026-01-01T00:00:00.000Z");

  const progress: Array<{
    phase: string;
    heavy: boolean;
    deletedRows: number;
    estimatedRows: number;
    done: boolean;
  }> = [];
  const result = await runRuntimeDbMaintenance({
    store,
    ...fastOpts,
    batchSize: 250,
    heavyThreshold: 500,
    requestCompaction: false,
    onProgress: (p) => progress.push({ ...p }),
  });

  assert.equal(result.deletedByAge, 1000);
  // The very first emit fixes the heavy verdict + estimate before any deletes.
  assert.equal(progress[0]?.heavy, true);
  assert.equal(progress[0]?.estimatedRows, 1000);
  assert.equal(progress[0]?.deletedRows, 0);
  // Every emit agrees the sweep is heavy; deletedRows climbs monotonically.
  assert.ok(progress.every((p) => p.heavy === true));
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i].deletedRows >= progress[i - 1].deletedRows);
  }
  // Terminal emit unblocks the boot screen.
  const last = progress.at(-1);
  assert.equal(last?.done, true);
  assert.equal(last?.deletedRows, 1000);
});

test("a small backlog is not heavy (stays a silent background sweep)", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 30, maxEventsPerSession: 0 };
  store.seed("s1", 100, "2026-01-01T00:00:00.000Z");

  const progress: Array<{ heavy: boolean; done: boolean }> = [];
  await runRuntimeDbMaintenance({
    store,
    ...fastOpts,
    heavyThreshold: 500,
    requestCompaction: false,
    onProgress: (p) => progress.push({ heavy: p.heavy, done: p.done }),
  });

  assert.ok(progress.every((p) => p.heavy === false));
  assert.equal(progress.at(-1)?.done, true);
});

test("aborting stops the sweep promptly", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 0, maxEventsPerSession: 0 };
  store.seed("s1", 100, "2026-07-02T00:00:00.000Z");
  const controller = new AbortController();
  controller.abort();

  const result = await runRuntimeDbMaintenance({
    store,
    signal: controller.signal,
    startDelayMs: 10_000, // would hang for 10s if abort were ignored
    pauseMs: 0,
    now: () => NOW,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.compactionRequested, false);
});
