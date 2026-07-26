import assert from "node:assert/strict";
import test from "node:test";

import {
  invalidateHarnessAvailabilityCache,
  listHarnessAvailability,
  resolveHarnessAvailabilityWithModels,
} from "./harness-availability.js";

test("listHarnessAvailability covers every registered harness", () => {
  invalidateHarnessAvailabilityCache();
  const ids = listHarnessAvailability().map((entry) => entry.id);
  for (const expected of ["pi", "claude-code", "codex"]) {
    assert.ok(ids.includes(expected), `missing harness ${expected}`);
  }
  // pi is always available (in-process); the CLI harnesses are PATH-gated.
  const pi = listHarnessAvailability().find((entry) => entry.id === "pi");
  assert.equal(pi?.available, true);
  assert.equal(pi?.detection, "in-process");
});

test("CLI harnesses expose a non-empty model catalogue (never the empty=pi-combobox case)", () => {
  invalidateHarnessAvailabilityCache();
  const byId = new Map(listHarnessAvailability().map((entry) => [entry.id, entry]));
  for (const id of ["claude-code", "codex"]) {
    const entry = byId.get(id);
    assert.ok(entry, `missing ${id}`);
    assert.ok(entry!.supportedModels.length > 0, `${id} must have a static fallback catalogue`);
    assert.equal(entry!.supportedModels.filter((m) => m.default).length, 1, `${id} needs one default`);
  }
});

test("resolveHarnessAvailabilityWithModels falls back to the static catalogue for unavailable harnesses", async () => {
  invalidateHarnessAvailabilityCache();
  const staticById = new Map(listHarnessAvailability().map((entry) => [entry.id, entry]));
  const resolved = await resolveHarnessAvailabilityWithModels();

  // Same harness set + availability as the sync probe.
  assert.deepEqual(
    resolved.map((e) => ({ id: e.id, available: e.available })),
    [...staticById.values()].map((e) => ({ id: e.id, available: e.available })),
  );

  // Any harness that isn't installed keeps its static fallback models —
  // discovery only runs for available harnesses, so this is deterministic
  // regardless of which CLIs happen to be on PATH.
  for (const entry of resolved) {
    if (!entry.available) {
      assert.deepEqual(
        entry.supportedModels,
        staticById.get(entry.id)?.supportedModels,
        `${entry.id} should keep its static catalogue when unavailable`,
      );
    }
  }
});
