import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime restart guard checks runtime-state blockers before stopping the embedded runtime", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const restartGuardSection =
    source.match(
      /function normalizeDeferredRuntimeRestartReason[\s\S]*?async function restartEmbeddedRuntimeIfNeeded\(/,
    )?.[0] ?? "";

  assert.match(
    restartGuardSection,
    /FROM session_runtime_state[\s\S]*WHERE status IN \('BUSY', 'QUEUED'\)[\s\S]*OR current_input_id IS NOT NULL/,
  );
  assert.match(
    restartGuardSection,
    /const healthy = await isRuntimeHealthy\(runtimeBaseUrl\(\)\);[\s\S]*const blockers = healthy \? listRuntimeRestartBlockingSessions\(\) : \[\];/,
  );
  assert.match(
    restartGuardSection,
    /event: "embedded_runtime\.restart_deferred"[\s\S]*outcome: "deferred"/,
  );
  assert.match(
    restartGuardSection,
    /event: "embedded_runtime\.restart_resumed"[\s\S]*outcome: "start"/,
  );
  assert.match(
    restartGuardSection,
    /await stopEmbeddedRuntime\(\);[\s\S]*void startEmbeddedRuntime\(\);/,
  );
});

test("desktop runtime routes config and manual restarts through the deferred restart guard", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /async function restartEmbeddedRuntimeIfNeeded\([\s\S]*await restartEmbeddedRuntimeSafely\(reason\);[\s\S]*return true;/,
  );
  assert.match(
    source,
    /if \(shouldRestartRuntime\) \{[\s\S]*await restartEmbeddedRuntimeSafely\("runtime_config_document"\);[\s\S]*\}/,
  );
  assert.match(
    source,
    /handleTrustedIpc\("runtime:restart", \["main"\], async \(\) => \{[\s\S]*await restartEmbeddedRuntimeSafely\("manual_restart"\);[\s\S]*return refreshRuntimeStatus\(\);[\s\S]*\}\);/,
  );
});
