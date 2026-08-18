import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { RuntimeStateStore } from "./store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(): { store: RuntimeStateStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "boot-timing-"));
  tempDirs.push(root);
  return {
    store: new RuntimeStateStore({
      dbPath: path.join(root, "host-state.db"),
      workspaceRoot: path.join(root, "workspace"),
    }),
    root,
  };
}

test("boot telemetry never forces the root DB open", () => {
  // The rule this enforces: the root DB open is the expensive thing boot
  // telemetry exists to measure (an 80s PRAGMA quick_check on a large data.db),
  // so a telemetry read that opens it would cause the very failure it reports.
  // Both accessors decline instead, and the caller loses only its baseline.
  const { store, root } = makeStore();
  try {
    assert.equal(store.readBootTimingHistoryJson(), null);
    assert.equal(store.writeBootTimingHistoryJson("[]"), false);
    // The proof: no data.db exists, because nothing opened it.
    assert.equal(fs.existsSync(path.join(root, "state", "data.db")), false);
  } finally {
    store.close();
  }
});

test("boot timings round-trip once the root DB is open", () => {
  const { store } = makeStore();
  try {
    // Any real read opens the root DB, which is the normal case at end-of-boot:
    // the background workers have already touched the store by then.
    store.countRootOutputEvents();

    assert.equal(store.readBootTimingHistoryJson(), null);
    const history = JSON.stringify([
      { total_ms: 1_200, phases: [{ phase: "durable_memory", ms: 900 }], at: "2026-08-19T00:00:00.000Z" },
    ]);
    assert.equal(store.writeBootTimingHistoryJson(history), true);
    assert.equal(store.readBootTimingHistoryJson(), history);

    // Upsert, not append: the ring is bounded by the writer.
    const replacement = JSON.stringify([{ total_ms: 42, phases: [], at: "x" }]);
    assert.equal(store.writeBootTimingHistoryJson(replacement), true);
    assert.equal(store.readBootTimingHistoryJson(), replacement);
  } finally {
    store.close();
  }
});

test("root DB open timings are recorded once the DB is opened", () => {
  const { store } = makeStore();
  try {
    // Nulls before the open — "not opened" is the honest answer, and reporting
    // it must not trigger the open.
    assert.deepEqual(store.rootRuntimeDbOpenTimings(), {
      openMs: null,
      integrityCheckMs: null,
    });

    store.countRootOutputEvents();

    const timings = store.rootRuntimeDbOpenTimings();
    assert.ok(
      typeof timings.openMs === "number" && timings.openMs >= 0,
      "the open should be timed so it is attributed to the open rather than to whichever worker touched the store first",
    );
    // A clean first run never runs the integrity check — it only runs after an
    // unclean exit — so this stays null here.
    assert.equal(timings.integrityCheckMs, null);
  } finally {
    store.close();
  }
});
