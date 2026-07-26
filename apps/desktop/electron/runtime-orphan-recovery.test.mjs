import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime process state persists launch ownership for orphan recovery", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /const DESKTOP_LAUNCH_ID = randomUUID\(\);/);
  assert.match(source, /function migrateRuntimeProcessStateTable\(database: Database\.Database\) \{/);
  assert.match(source, /ALTER TABLE runtime_process_state ADD COLUMN launch_id TEXT;/);
  assert.match(source, /ALTER TABLE runtime_process_state ADD COLUMN sandbox_root TEXT;/);
  assert.match(
    source,
    /CREATE TABLE IF NOT EXISTS runtime_process_state \([\s\S]*launch_id TEXT,[\s\S]*sandbox_root TEXT,[\s\S]*updated_at TEXT NOT NULL[\s\S]*\);/,
  );
  assert.match(source, /launch_id: DESKTOP_LAUNCH_ID,/);
  assert.match(source, /sandbox_root: runtimeSandboxRoot\(\),/);
  assert.match(
    source,
    /function persistedRuntimeMatchesCurrentLaunch\([\s\S]*record\?\.launchId === DESKTOP_LAUNCH_ID[\s\S]*record\?\.sandboxRoot === sandboxRoot[\s\S]*\)/,
  );
});

test("desktop runtime orphan cleanup kills persisted pids and falls back to the runtime port listener", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /async function killRuntimeProcessByPid\(pid: number\)/);
  assert.match(source, /function killRuntimePortListener\(port: number\)/);
  assert.match(
    source,
    /async function terminateDetachedRuntime\(params: \{[\s\S]*const persisted = readPersistedRuntimeProcessState\(\);[\s\S]*const pid = persisted\?\.pid \?\? null;[\s\S]*if \(pid !== null\) \{[\s\S]*await killRuntimeProcessByPid\(pid\);[\s\S]*\}[\s\S]*killRuntimePortListener\(runtimeApiPort\(\)\);[\s\S]*event: "embedded_runtime.detached_cleanup",/,
  );
});
