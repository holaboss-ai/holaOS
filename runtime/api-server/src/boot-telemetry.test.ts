import assert from "node:assert/strict";
import test from "node:test";

import {
  BASELINE_MIN_MS,
  BOOT_HISTORY_LIMIT,
  DEFAULT_PHASE_BUDGET_MS,
  TOTAL_BOOT_BUDGET_MS,
  appendBootRecord,
  baselineTotalMs,
  classifyBoot,
  parseBootHistory,
  phaseBudgetMs,
  phaseOverBudget,
  type BootRecord,
} from "./boot-telemetry.js";

function record(overrides: Partial<BootRecord> = {}): BootRecord {
  return {
    total_ms: 1_000,
    phases: [{ phase: "durable_memory", ms: 500 }],
    at: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

test("known phases get their own budget, unknown phases get the default", () => {
  assert.equal(phaseBudgetMs("durable_memory"), 30_000);
  assert.equal(phaseBudgetMs("channel_gateway"), 20_000);
  assert.equal(phaseBudgetMs("a_phase_added_next_year"), DEFAULT_PHASE_BUDGET_MS);
});

test("phaseOverBudget answers for a phase that has not finished", () => {
  // The livelock case: the process never reaches the end of this phase, so the
  // only useful question is about the time spent so far.
  assert.equal(phaseOverBudget("durable_memory", 29_999), false);
  assert.equal(phaseOverBudget("durable_memory", 30_001), true);
});

test("a healthy boot raises nothing", () => {
  assert.deepEqual(classifyBoot(record()), []);
});

test("a phase over its own budget is named in the alarm", () => {
  const alarms = classifyBoot(
    record({ phases: [{ phase: "queue_worker", ms: 11_000 }] }),
  );
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].kind, "phase_over_budget");
  assert.equal(alarms[0].phase, "queue_worker");
  assert.match(alarms[0].message, /queue_worker took 11000ms/);
});

test("the total budget fires independently of any single phase", () => {
  // Death by a thousand cuts: every phase inside its budget, the sum well past
  // the point a user has given up on the app.
  const phases = Array.from({ length: 20 }, (_, index) => ({
    phase: `step_${index}`,
    ms: 4_000,
  }));
  const alarms = classifyBoot(record({ total_ms: 80_000, phases }));
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].kind, "total_over_budget");
  assert.equal(alarms[0].budget_ms, TOTAL_BOOT_BUDGET_MS);
});

test("median baseline ignores a single pathological boot", () => {
  const history = [
    record({ total_ms: 2_000 }),
    record({ total_ms: 2_200 }),
    record({ total_ms: 80_000 }),
  ];
  // A mean would be ~28s and would hide every subsequent slow boot.
  assert.equal(baselineTotalMs(history), 2_200);
});

test("baseline is null with no usable history", () => {
  assert.equal(baselineTotalMs([]), null);
  assert.equal(baselineTotalMs([record({ total_ms: 0 })]), null);
  assert.equal(baselineTotalMs([record({ total_ms: Number.NaN })]), null);
});

test("a regression against this machine's own history is reported", () => {
  const history = Array.from({ length: 5 }, () => record({ total_ms: 4_000 }));
  const alarms = classifyBoot(record({ total_ms: 20_000 }), history);
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].kind, "slower_than_baseline");
  assert.equal(alarms[0].baseline_ms, 4_000);
  assert.match(alarms[0].message, /5\.0x this machine's baseline/);
});

test("a boot inside the regression factor stays quiet", () => {
  const history = Array.from({ length: 5 }, () => record({ total_ms: 4_000 }));
  assert.deepEqual(classifyBoot(record({ total_ms: 11_000 }), history), []);
});

test("fast machines do not trip the regression alarm on noise", () => {
  // 40ms -> 200ms is 5x and completely meaningless.
  const history = Array.from({ length: 5 }, () => record({ total_ms: 40 }));
  assert.ok(40 < BASELINE_MIN_MS);
  assert.deepEqual(classifyBoot(record({ total_ms: 200 }), history), []);
});

test("both an absolute breach and a regression are reported together", () => {
  // They point at different things — one at a subsystem, one at the data — so
  // collapsing them would throw away half the signal.
  const history = Array.from({ length: 5 }, () => record({ total_ms: 4_000 }));
  const alarms = classifyBoot(
    record({ total_ms: 90_000, phases: [{ phase: "durable_memory", ms: 85_000 }] }),
    history,
  );
  assert.deepEqual(alarms.map((alarm) => alarm.kind), [
    "phase_over_budget",
    "total_over_budget",
    "slower_than_baseline",
  ]);
});

test("history is a bounded ring that drops the oldest", () => {
  let history: BootRecord[] = [];
  for (let index = 0; index < BOOT_HISTORY_LIMIT + 5; index += 1) {
    history = appendBootRecord(history, record({ total_ms: index }));
  }
  assert.equal(history.length, BOOT_HISTORY_LIMIT);
  assert.equal(history[0].total_ms, 5);
  assert.equal(history.at(-1)?.total_ms, BOOT_HISTORY_LIMIT + 4);
});

test("parsing a persisted history never throws", () => {
  // This reads a row an older build wrote. Losing the baseline is acceptable;
  // failing the boot that is trying to read it is not.
  assert.deepEqual(parseBootHistory(null), []);
  assert.deepEqual(parseBootHistory(""), []);
  assert.deepEqual(parseBootHistory("{not json"), []);
  assert.deepEqual(parseBootHistory('{"total_ms":1}'), []);
  assert.deepEqual(parseBootHistory("[1,2,3]"), []);
  assert.deepEqual(parseBootHistory('[{"total_ms":"slow","phases":[]}]'), []);
});

test("parsing keeps the well-formed entries and drops the rest", () => {
  const parsed = parseBootHistory(
    JSON.stringify([
      { total_ms: 1_000, phases: [], at: "2026-08-19T00:00:00.000Z" },
      { total_ms: null, phases: [] },
      { total_ms: 2_000, phases: [{ phase: "queue_worker", ms: 10 }] },
    ]),
  );
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((entry) => entry.total_ms), [1_000, 2_000]);
});
