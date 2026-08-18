import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { DEFAULT_OUTPUT_EVENT_RETENTION, RuntimeStateStore } from "./store.js";

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

const WS = "workspace-1";

function appendEvents(
  store: RuntimeStateStore,
  sessionId: string,
  count: number,
  opts: { eventType?: string; createdAt?: string; startSequence?: number } = {},
): void {
  const start = opts.startSequence ?? 1;
  for (let i = 0; i < count; i++) {
    store.appendOutputEvent({
      workspaceId: WS,
      sessionId,
      inputId: "input-1",
      sequence: start + i,
      eventType: opts.eventType ?? "output_delta",
      payload: { i },
      createdAt: opts.createdAt,
    });
  }
}

function eventCount(store: RuntimeStateStore, sessionId: string): number {
  return store.listOutputEvents({ workspaceId: WS, sessionId }).length;
}

test("default retention policy is 30 days / 25k per session / 250k overall", () => {
  assert.deepEqual(DEFAULT_OUTPUT_EVENT_RETENTION, {
    maxAgeDays: 30,
    maxEventsPerSession: 25_000,
    // The global ceiling is the backstop the other two cannot provide: neither
    // bounds the number of SESSIONS. 162 scheduled sessions each sitting at
    // exactly the 25k cap made 2.29M rows / 1.9GB, entirely within policy and
    // nothing prunable — and boot cost scales with the file.
    maxTotalEvents: 250_000,
  });
});

test("trimSessionOutputEvents keeps the newest maxEvents and drops older ones", () => {
  const root = makeTempDir("hb-retention-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "host-state.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    appendEvents(store, "s1", 12);
    assert.equal(eventCount(store, "s1"), 12);

    const deleted = store.trimSessionOutputEvents({
      workspaceId: WS,
      sessionId: "s1",
      maxEvents: 5,
    });
    assert.equal(deleted, 7);

    const remaining = store.listOutputEvents({ workspaceId: WS, sessionId: "s1" });
    assert.equal(remaining.length, 5);
    // Newest 5 kept (sequences 8..12), oldest dropped.
    assert.deepEqual(
      remaining.map((e) => e.sequence),
      [8, 9, 10, 11, 12],
    );
  } finally {
    store.close();
  }
});

test("trimSessionOutputEvents respects the bounded limit", () => {
  const root = makeTempDir("hb-retention-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "host-state.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    appendEvents(store, "s1", 12);
    // 7 are over the cap of 5, but limit=3 caps this call at 3 deletions.
    const deleted = store.trimSessionOutputEvents({
      workspaceId: WS,
      sessionId: "s1",
      maxEvents: 5,
      limit: 3,
    });
    assert.equal(deleted, 3);
    assert.equal(eventCount(store, "s1"), 9);
  } finally {
    store.close();
  }
});

test("trimSessionOutputEvents is a no-op when under the cap", () => {
  const root = makeTempDir("hb-retention-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "host-state.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    appendEvents(store, "s1", 3);
    const deleted = store.trimSessionOutputEvents({
      workspaceId: WS,
      sessionId: "s1",
      maxEvents: 5,
    });
    assert.equal(deleted, 0);
    assert.equal(eventCount(store, "s1"), 3);
  } finally {
    store.close();
  }
});

test("run_completed enforces the per-session cap on the write path", () => {
  const root = makeTempDir("hb-retention-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "host-state.db"),
    workspaceRoot: path.join(root, "workspace"),
    outputEventRetention: { maxEventsPerSession: 5, maxAgeDays: 0 },
  });
  try {
    appendEvents(store, "s1", 5);
    // The 6th event is terminal — the write-path trim fires and caps at 5.
    store.appendOutputEvent({
      workspaceId: WS,
      sessionId: "s1",
      inputId: "input-1",
      sequence: 6,
      eventType: "run_completed",
      payload: {},
    });
    assert.equal(eventCount(store, "s1"), 5);
  } finally {
    store.close();
  }
});

test("pruneRootOutputEventsByAge deletes only rows older than the cutoff", () => {
  const root = makeTempDir("hb-retention-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "host-state.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    const old = "2020-01-01T00:00:00.000Z";
    const recent = "2020-01-10T00:00:00.000Z";
    appendEvents(store, "s1", 4, { createdAt: old, startSequence: 1 });
    appendEvents(store, "s1", 3, { createdAt: recent, startSequence: 5 });

    const deleted = store.pruneRootOutputEventsByAge({
      cutoffIso: "2020-01-05T00:00:00.000Z",
      limit: 1000,
    });
    assert.equal(deleted, 4);

    const remaining = store.listOutputEvents({ workspaceId: WS, sessionId: "s1" });
    assert.equal(remaining.length, 3);
    assert.ok(remaining.every((e) => e.createdAt === recent));
  } finally {
    store.close();
  }
});

test("pruneRootOutputEventsByAge honors the batch limit", () => {
  const root = makeTempDir("hb-retention-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "host-state.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    appendEvents(store, "s1", 10, { createdAt: "2020-01-01T00:00:00.000Z" });
    const first = store.pruneRootOutputEventsByAge({
      cutoffIso: "2020-06-01T00:00:00.000Z",
      limit: 4,
    });
    assert.equal(first, 4);
    assert.equal(eventCount(store, "s1"), 6);
  } finally {
    store.close();
  }
});

test("listRootSessionsExceedingOutputEventCap returns over-cap sessions, heaviest first", () => {
  const root = makeTempDir("hb-retention-");
  const store = new RuntimeStateStore({
    dbPath: path.join(root, "host-state.db"),
    workspaceRoot: path.join(root, "workspace"),
  });
  try {
    appendEvents(store, "big", 12);
    appendEvents(store, "mid", 8);
    appendEvents(store, "small", 3);

    const over = store.listRootSessionsExceedingOutputEventCap(5);
    assert.deepEqual(
      over.map((r) => r.sessionId),
      ["big", "mid"],
    );
    assert.equal(over[0].count, 12);
  } finally {
    store.close();
  }
});

test("requestRootDbCompaction + reopen compacts data.db and preserves data", () => {
  const root = makeTempDir("hb-retention-");
  const opts = {
    dbPath: path.join(root, "host-state.db"),
    workspaceRoot: path.join(root, "workspace"),
  };
  const dataDbPath = path.join(root, "data.db");

  const store1 = new RuntimeStateStore(opts);
  // Grow the file with fat payloads, then delete almost all — freed pages go to
  // the freelist, so the file stays large until compaction rewrites it.
  const fat = "x".repeat(2048);
  for (let i = 0; i < 2000; i++) {
    store1.appendOutputEvent({
      workspaceId: WS,
      sessionId: "s1",
      inputId: "input-1",
      sequence: i + 1,
      eventType: "output_delta",
      payload: { blob: fat },
    });
  }
  store1.trimSessionOutputEvents({ workspaceId: WS, sessionId: "s1", maxEvents: 10 });
  assert.equal(eventCount(store1, "s1"), 10);
  store1.requestRootDbCompaction();
  store1.close();

  const sizeBefore = fs.statSync(dataDbPath).size;
  assert.ok(fs.existsSync(`${dataDbPath}.compact-requested`), "marker should be staged");

  // Reopening triggers the boot-time compact + swap on first root-db access.
  const store2 = new RuntimeStateStore(opts);
  try {
    const remaining = store2.listOutputEvents({ workspaceId: WS, sessionId: "s1" });
    assert.equal(remaining.length, 10, "data survives the swap");
    assert.equal(
      fs.existsSync(`${dataDbPath}.compact-requested`),
      false,
      "marker consumed",
    );
    assert.equal(
      fs.existsSync(`${dataDbPath}.compact.tmp`),
      false,
      "no temp left behind",
    );
    const sizeAfter = fs.statSync(dataDbPath).size;
    assert.ok(
      sizeAfter < sizeBefore,
      `expected compaction to shrink data.db (${sizeBefore} -> ${sizeAfter})`,
    );
  } finally {
    store2.close();
  }
});

test("compaction marker is cleared even when there is little to reclaim", () => {
  const root = makeTempDir("hb-retention-");
  const opts = {
    dbPath: path.join(root, "host-state.db"),
    workspaceRoot: path.join(root, "workspace"),
  };
  const dataDbPath = path.join(root, "data.db");

  const store1 = new RuntimeStateStore(opts);
  appendEvents(store1, "s1", 5);
  store1.requestRootDbCompaction();
  store1.close();

  const store2 = new RuntimeStateStore(opts);
  try {
    // First access triggers the check; too little free space to VACUUM, but the
    // marker must still be cleared so it never retries forever.
    assert.equal(eventCount(store2, "s1"), 5);
    assert.equal(fs.existsSync(`${dataDbPath}.compact-requested`), false);
  } finally {
    store2.close();
  }
});
