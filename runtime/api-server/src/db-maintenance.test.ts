import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type DbMaintenanceStore,
  runRuntimeDbMaintenance,
  startRuntimeDbMaintenanceLoop,
} from "./db-maintenance.js";

/** In-memory fake of the retention surface — no native DB needed. */
class FakeStore implements DbMaintenanceStore {
  outputEventRetentionPolicy = {
    maxAgeDays: 30,
    maxEventsPerSession: 100,
    // Off unless a test opts in, so the existing age/cap cases keep measuring
    // exactly what they measured before.
    maxTotalEvents: 0,
  };
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

  countRootOutputEvents(): number {
    let total = 0;
    for (const arr of this.events.values()) {
      total += arr.length;
    }
    return total;
  }

  /** Oldest-first across all sessions, mirroring the real DELETE ... ORDER BY id. */
  trimRootOutputEventsToTotal(params: { keep: number; limit: number }): number {
    const excess = this.countRootOutputEvents() - params.keep;
    if (excess <= 0) {
      return 0;
    }
    let toDelete = Math.min(excess, params.limit);
    let deleted = 0;
    for (const [sessionId, arr] of this.events) {
      if (toDelete <= 0) {
        break;
      }
      const take = Math.min(toDelete, arr.length);
      this.events.set(sessionId, arr.slice(take));
      deleted += take;
      toDelete -= take;
    }
    return deleted;
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
  store.outputEventRetentionPolicy = { maxAgeDays: 30, maxEventsPerSession: 0, maxTotalEvents: 0 };
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
  store.outputEventRetentionPolicy = { maxAgeDays: 0, maxEventsPerSession: 100, maxTotalEvents: 0 };
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
  store.outputEventRetentionPolicy = { maxAgeDays: 0, maxEventsPerSession: 100, maxTotalEvents: 0 };
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
  store.outputEventRetentionPolicy = { maxAgeDays: 0, maxEventsPerSession: 100, maxTotalEvents: 0 };
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
  store.outputEventRetentionPolicy = { maxAgeDays: 0, maxEventsPerSession: 100, maxTotalEvents: 0 };
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
  store.outputEventRetentionPolicy = { maxAgeDays: 30, maxEventsPerSession: 0, maxTotalEvents: 0 };
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
  store.outputEventRetentionPolicy = { maxAgeDays: 30, maxEventsPerSession: 0, maxTotalEvents: 0 };
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

test("the loop sweeps repeatedly, not just once at boot", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 30, maxEventsPerSession: 0, maxTotalEvents: 0 };

  // Every sweep emits exactly one "estimating" before it prunes, so counting
  // them counts sweeps. A one-shot implementation never gets past 1 — which is
  // precisely the bug that let data.db grow unbounded on long-lived installs.
  let sweeps = 0;
  const controller = new AbortController();
  const loop = startRuntimeDbMaintenanceLoop({
    store,
    ...fastOpts,
    intervalMs: 1,
    requestCompaction: false,
    signal: controller.signal,
    onProgress: (p) => {
      if (p.phase === "estimating") {
        sweeps += 1;
      }
    },
  });

  const deadline = Date.now() + 2_000;
  while (sweeps < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  controller.abort();
  await loop;

  assert.ok(sweeps >= 2, `expected repeated sweeps, saw ${sweeps}`);
});

test("background sweeps can never raise the blocking boot screen", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 30, maxEventsPerSession: 0, maxTotalEvents: 0 };
  store.seed("s1", 200, "2026-01-01T00:00:00.000Z");

  // BootGate blocks the UI on `heavy && !done`. The first sweep may legitimately
  // be heavy; every later one must not be, or a mid-session background sweep
  // could drop the user back onto the boot splash.
  //
  // Re-seed after each sweep so the backlog stays above the threshold — a
  // workload that keeps producing prunable rows. Without that the estimate
  // falls to zero after sweep 1 and `heavy` would read false whether or not the
  // guard is doing anything.
  const heavyBySweep: boolean[] = [];
  const controller = new AbortController();
  const loop = startRuntimeDbMaintenanceLoop({
    store,
    ...fastOpts,
    intervalMs: 1,
    heavyThreshold: 10, // trivially exceeded, so sweep 1 is heavy
    requestCompaction: false,
    signal: controller.signal,
    onProgress: (p) => {
      if (p.phase === "estimating") {
        heavyBySweep.push(p.heavy);
      }
      if (p.phase === "done") {
        store.seed("s1", 200, "2026-01-01T00:00:00.000Z");
      }
    },
  });

  const deadline = Date.now() + 2_000;
  while (heavyBySweep.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  controller.abort();
  await loop;

  assert.equal(heavyBySweep[0], true, "first sweep should be heavy here");
  assert.ok(
    heavyBySweep.slice(1).every((heavy) => heavy === false),
    `later sweeps must never be heavy, saw ${JSON.stringify(heavyBySweep)}`,
  );
});

test("the loop resolves on abort instead of running forever", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 30, maxEventsPerSession: 0, maxTotalEvents: 0 };
  const controller = new AbortController();

  const loop = startRuntimeDbMaintenanceLoop({
    store,
    ...fastOpts,
    // Would idle for an hour between sweeps if abort were ignored.
    intervalMs: 3_600_000,
    requestCompaction: false,
    signal: controller.signal,
  });

  controller.abort();
  await loop; // hangs the test run if the loop ignores the signal
});

test("aborting stops the sweep promptly", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = { maxAgeDays: 0, maxEventsPerSession: 0, maxTotalEvents: 0 };
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

test("a global ceiling bounds the table when every session is within policy", async () => {
  // The failure this exists for: neither knob bounds the number of SESSIONS.
  // In the field 162 scheduled sessions each sat at exactly the 25k per-session
  // cap — 2.29M rows, 1.9GB, every one within policy and NOTHING prunable — and
  // boot cost scales with the file, so the app could not start.
  const store = new FakeStore();
  store.outputEventRetentionPolicy = {
    maxAgeDays: 30,
    maxEventsPerSession: 100,
    maxTotalEvents: 250,
  };
  // Five sessions at exactly the per-session cap: age prunes nothing (all
  // recent), the cap prunes nothing (none exceed it). 500 rows, all legal.
  const recent = new Date().toISOString();
  for (let i = 0; i < 5; i++) {
    store.seed(`scheduled-${i}`, 100, recent);
  }
  assert.equal(store.countRootOutputEvents(), 500);

  const result = await runRuntimeDbMaintenance({ store, ...fastOpts, requestCompaction: false });

  assert.equal(result.deletedByAge, 0, "nothing is old enough");
  assert.equal(result.deletedByCap, 0, "no session exceeds the per-session cap");
  assert.equal(result.deletedByTotalCap, 250, "the global ceiling is what bounds it");
  assert.equal(store.countRootOutputEvents(), 250);
});

test("the global ceiling is off by default in the fake, and a zero disables it", async () => {
  const store = new FakeStore();
  store.outputEventRetentionPolicy = {
    maxAgeDays: 0,
    maxEventsPerSession: 0,
    maxTotalEvents: 0,
  };
  store.seed("s1", 400, new Date().toISOString());

  const result = await runRuntimeDbMaintenance({ store, ...fastOpts, requestCompaction: false });

  assert.equal(result.deletedByTotalCap, 0, "0 must disable the ceiling, like the other knobs");
  assert.equal(store.countRootOutputEvents(), 400);
});

test("the ceiling trims oldest-first, so a quiet session keeps its recent history", async () => {
  // Trimming the LARGEST sessions instead would let a chatty session evict a
  // quiet one's newest events. Oldest-first matches what a retention bound
  // means and matches the age phase.
  const store = new FakeStore();
  store.outputEventRetentionPolicy = {
    maxAgeDays: 0,
    maxEventsPerSession: 0,
    maxTotalEvents: 50,
  };
  store.seed("old-session", 80, "2026-01-01T00:00:00.000Z");
  store.seed("recent-session", 20, "2026-08-18T00:00:00.000Z");

  await runRuntimeDbMaintenance({ store, ...fastOpts, requestCompaction: false });

  assert.equal(store.countRootOutputEvents(), 50);
  assert.equal(
    store.events.get("recent-session")?.length,
    20,
    "the newer session keeps all of its events",
  );
  assert.equal(
    store.events.get("old-session")?.length,
    30,
    "the older session absorbs the whole trim",
  );
});
