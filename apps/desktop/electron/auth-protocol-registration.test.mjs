import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("desktop auth protocol registration resolves a stable default-app launch target", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /function nearestPackageJsonDirectory\(startDirectory: string\): string \| null/);
  assert.match(source, /existsSync\(path\.join\(currentDirectory, "package\.json"\)\)/);
  assert.match(source, /function defaultAppProtocolClientArgs\(\): string\[]/);
  assert.match(source, /const flagsWithSeparateValue = new Set\(\["--require", "-r"\]\);/);
  assert.match(source, /if \(maybeAuthCallbackUrl\(argument\)\) \{\s*continue;\s*\}/);
  assert.match(
    source,
    /app\.setAsDefaultProtocolClient\(\s*AUTH_CALLBACK_PROTOCOL,\s*process\.execPath,\s*defaultAppProtocolClientArgs\(\),\s*\);/,
  );
  assert.doesNotMatch(source, /path\.resolve\(process\.argv\[1\]!?\)/);
});

test("desktop auth callback recovery reuses the dev server and user-data path for protocol-spawned processes", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /interface DevLaunchContext \{/);
  assert.match(source, /function devLaunchContextPath\(\): string \{/);
  assert.match(source, /const recoveredDevLaunchContext = loadRecoveredDevLaunchContext\(\);/);
  assert.match(
    source,
    /const RESOLVED_DEV_SERVER_URL =[\s\S]*process\.env\.VITE_DEV_SERVER_URL\?\.trim\(\)[\s\S]*recoveredDevLaunchContext\?\.devServerUrl[\s\S]*"";/,
  );
  assert.match(
    source,
    /const explicit =\s*process\.env\.HOLABOSS_DESKTOP_USER_DATA_PATH\?\.trim\(\)\s*\|\|\s*recoveredDevLaunchContext\?\.userDataPath\?\.trim\(\)\s*\|\|\s*"";/,
  );
  assert.match(
    source,
    /configureStableUserDataPath\(\);\s*resolvedRuntimeApiPort = resolveRuntimeApiPort\(\);\s*persistDevLaunchContext\(\);/,
  );
  assert.match(source, /if \(isDev\) \{\s*void win\.loadURL\(RESOLVED_DEV_SERVER_URL\);\s*\}/);
});
