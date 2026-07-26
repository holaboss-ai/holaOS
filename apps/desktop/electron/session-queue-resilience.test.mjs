import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("session queue keeps the existing binding when auth session lookup fails transiently", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const ensureBindingFunction =
    source.match(
      /async function ensureRuntimeBindingReadyForWorkspaceFlow\([\s\S]*?\n}\n\nfunction nearestPackageJsonDirectory/,
    )?.[0] ?? "";

  assert.match(
    ensureBindingFunction,
    /try \{\s*user = await getAuthenticatedUser\(\);\s*\} catch \(error\) \{/,
  );
  assert.match(
    ensureBindingFunction,
    /const canUseExistingBindingOnSessionLookupFailure =[\s\S]*runtimeConfigHasBindingMaterial\(currentConfig\)[\s\S]*!Boolean\(options\?\.forceRefresh\)/,
  );
  assert.match(
    ensureBindingFunction,
    /if \(\s*canUseExistingBindingOnSessionLookupFailure &&\s*isTransientRuntimeError\(error\)\s*\) \{[\s\S]*using_existing_binding_after_transient_session_lookup_failure:/,
  );
});

test("session queue retries transient runtime post failures with an idempotency key", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const queueFunction =
    source.match(
      /async function queueSessionInput\([\s\S]*?\n}\n\nasync function pauseSessionRun/,
    )?.[0] ?? "";

  assert.match(
    queueFunction,
    /const idempotencyKey =[\s\S]*payload\.idempotency_key\?\.trim\(\) \|\| `desktop-session-input:\$\{randomUUID\(\)\}`;/,
  );
  assert.match(queueFunction, /idempotency_key: idempotencyKey,/);
  assert.match(queueFunction, /retryTransientErrors: true,/);
});
