import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime status stays in starting while launch is in flight", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /let runtimeStartupInFlight = false;/);
  assert.match(
    source,
    /function runtimeUnavailableStatus\(hasBundle: boolean\): RuntimeStatus \{/,
  );
  assert.match(
    source,
    /if \(runtimeStartupInFlight && hasBundle\) \{\s*return "starting";\s*\}/,
  );
  assert.match(
    source,
    /return hasBundle \? "stopped" : "missing";/,
  );
  assert.match(
    source,
    /const unavailableStatus = runtimeUnavailableStatus\(hasBundle\);/,
  );
  assert.match(
    source,
    /status: unavailableStatus,/,
  );
  assert.match(
    source,
    /hasBundle\s*\?\s*runtimeStartupInFlight\s*\?\s*""\s*:\s*runtimeStatus\.lastError/,
  );
  assert.match(
    source,
    /async function startEmbeddedRuntime\(\) \{[\s\S]*runtimeStartupInFlight = true;[\s\S]*finally \{\s*runtimeStartupInFlight = false;\s*\}[\s\S]*\}\s*\);[\s\S]*\}/,
  );
});

test("desktop migration startup detection keys off the workspace legacy backfill marker", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /const WORKSPACE_RUNTIME_LEGACY_BACKFILL_MARKER_KEY =\s*"legacy_workspace_backfill_v1_complete";/,
  );
  assert.match(
    source,
    /"memory_recall_vec"/,
  );
  assert.match(
    source,
    /function workspaceRuntimeLegacyBackfillComplete\(dbPath: string\): boolean \{/,
  );
  assert.match(
    source,
    /SELECT value FROM workspace_runtime_metadata WHERE key = \? LIMIT 1/,
  );
  assert.match(
    source,
    /if \(!workspaceRuntimeLegacyBackfillComplete\(workspaceDbPath\)\) \{\s*return true;\s*\}/,
  );
});

test("desktop runtime health wait can abort early after the spawned runtime exits", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /async function waitForRuntimeHealth\([\s\S]*options:\s*\{\s*abortWhen\?: \(\) => boolean;\s*\}\s*=\s*\{\s*\}/,
  );
  assert.match(
    source,
    /if \(options\.abortWhen\?\.\(\)\) \{\s*return false;\s*\}/,
  );
  assert.match(
    source,
    /abortWhen: \(\) =>\s*runtimeProcess !== child \|\| child\.exitCode !== null/,
  );
});

test("desktop main window forces a runtime state resend after the renderer finishes loading", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /function emitRuntimeState\(force = false\) \{/);
  assert.match(
    source,
    /if \(!force && nextSignature === lastRuntimeStateSignature\) \{\s*return;\s*\}/,
  );
  assert.match(
    source,
    /win\.webContents\.on\("did-finish-load", \(\) => \{[\s\S]*emitRuntimeState\(true\);[\s\S]*\}\);/,
  );
});
