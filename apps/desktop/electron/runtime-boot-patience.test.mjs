import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSource = await readFile(path.join(__dirname, "main.ts"), "utf8");

/**
 * A fixed attempt count racing an operation whose duration nobody controls is a
 * race the runtime always loses. On a 1.9GB data.db an integrity check ran ~80s
 * against this 30s budget: the desktop killed a runtime that was working, and
 * the kill left the marker that started the check again — forever, with a bare
 * spinner as the only symptom.
 */

test("the startup probe distinguishes a busy runtime from a dead one", async () => {
  // /healthz answers a boolean, so it cannot express "starting". The boot-status
  // probe is what carries the phase.
  assert.match(mainSource, /function fetchRuntimeBootStatus\(/);
  assert.match(
    mainSource,
    /\/runtime\/boot-status/,
    "the desktop must read the runtime's boot phase",
  );
});

test("a boot phase that is advancing does not burn the attempt budget", async () => {
  const start = mainSource.indexOf("async function waitForRuntimeHealth(");
  assert.notEqual(start, -1);
  const body = mainSource.slice(start, mainSource.indexOf("\n}\n", start));

  // Progress must refund the attempt — otherwise a slow-but-working boot is
  // killed on a timer, which is the whole bug.
  assert.match(
    body,
    /attempt -= 1/,
    "an advancing phase must not count against the overall budget",
  );
  assert.match(
    body,
    /status\.phase !== lastPhase/,
    "patience is keyed on the phase CHANGING, not on elapsed time",
  );
  // …but a phase that stops moving still has to end the wait, or a genuinely
  // hung runtime would be waited on forever.
  assert.match(body, /STALLED_BOOT_PHASE_ATTEMPTS/);
});

test("a runtime without the boot-status endpoint keeps the old behaviour", async () => {
  const start = mainSource.indexOf("async function waitForRuntimeHealth(");
  const body = mainSource.slice(start, mainSource.indexOf("\n}\n", start));
  // Older runtimes 404 it. `status` is null there, and the extension is gated on
  // a truthy status, so the plain attempt count still applies.
  assert.match(
    body,
    /if \(status && !status\.ready\)/,
    "the patience extension must be gated on the runtime actually reporting a phase",
  );
});
