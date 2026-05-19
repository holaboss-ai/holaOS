import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime binding keeps the existing binding on transient refresh failures", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const refreshSection =
    source.match(
      /function hasRecentTransientRuntimeBindingRefreshFailure[\s\S]*?async function clearRuntimeBindingSecrets/,
    )?.[0] ?? "";
  const ensureBindingFunction =
    source.match(
      /async function ensureRuntimeBindingReadyForWorkspaceFlow\([\s\S]*?\n}\n\nfunction nearestPackageJsonDirectory/,
    )?.[0] ?? "";

  assert.match(
    source,
    /const RUNTIME_BINDING_REFRESH_FAILURE_BACKOFF_MS = 60 \* 1000;/,
  );
  assert.match(
    refreshSection,
    /function hasRecentTransientRuntimeBindingRefreshFailure\(\s*userId: string,\s*\): boolean \{/,
  );
  assert.match(
    refreshSection,
    /function markTransientRuntimeBindingRefreshFailure\(\s*userId: string\s*\): void \{/,
  );

  assert.match(
    ensureBindingFunction,
    /const canUseExistingBindingOnRefreshFailure =[\s\S]*!bindingNeedsReplacement[\s\S]*!Boolean\(options\?\.forceRefresh\)/,
  );
  assert.match(
    ensureBindingFunction,
    /hasRecentTransientRuntimeBindingRefreshFailure\(userId\)/,
  );
  assert.match(
    ensureBindingFunction,
    /if \(\s*canUseExistingBindingOnRefreshFailure &&\s*isTransientRuntimeError\(error\)\s*\) \{[\s\S]*markTransientRuntimeBindingRefreshFailure\(userId\);[\s\S]*using_existing_binding_after_transient_refresh_failure:/,
  );
  assert.match(
    ensureBindingFunction,
    /if \(\s*canUseExistingBindingOnRefreshFailure &&\s*isTransientRuntimeError\(error\)\s*\) \{[\s\S]*return;\s*\}[\s\S]*await clearRuntimeBindingSecrets\(`\$\{reason\}:provision_failed`\);/,
  );
});
