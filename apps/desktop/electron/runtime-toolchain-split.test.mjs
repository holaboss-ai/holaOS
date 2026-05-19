import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const builderConfigPath = path.join(__dirname, "..", "electron-builder.config.cjs");
const packagedConfigPath = path.join(__dirname, "..", "scripts", "write-packaged-config.mjs");

test("desktop packager embeds the full bundled runtime including node and python", async () => {
  const builderConfigSource = await readFile(builderConfigPath, "utf8");

  assert.match(builderConfigSource, /from: runtimeBundlePath,/);
  assert.match(builderConfigSource, /"bin\/\*\*\/\*"/);
  assert.match(builderConfigSource, /"node-runtime\/\*\*\/\*"/);
  assert.match(builderConfigSource, /"python-runtime\/\*\*\/\*"/);
  assert.match(builderConfigSource, /"runtime\/\*\*\/\*"/);
  assert.doesNotMatch(builderConfigSource, /HOLABOSS_BUNDLE_TOOLCHAIN_SEED/);
  assert.doesNotMatch(builderConfigSource, /HOLABOSS_TOOLCHAIN_TARBALL/);
});

test("packaged config records release-channel metadata and updater enablement for the desktop shell", async () => {
  const source = await readFile(packagedConfigPath, "utf8");

  assert.match(source, /function resolveUpdateChannel\(\)/);
  assert.match(source, /function resolveAppUpdateEnabled\(\)/);
  assert.match(source, /process\.env\.RELEASE_TAG\?\.trim\(\) \|\|/);
  assert.match(source, /process\.env\.HOLABOSS_RELEASE_TAG\?\.trim\(\) \|\|/);
  assert.match(source, /const appUpdateEnabled = resolveAppUpdateEnabled\(\);/);
  assert.match(source, /appUpdateEnabled,/);
  assert.match(source, /\.\.\.\(updateChannel === "beta" \? \{ updateChannel \} : \{\}\),/);
  assert.doesNotMatch(source, /toolchainManifest/);
  assert.doesNotMatch(source, /toolchain_id/);
});

test("packaged config script stays valid plain JavaScript", () => {
  execFileSync(process.execPath, ["--check", packagedConfigPath], {
    stdio: "pipe",
  });
});

test("runtime startup resolves everything from the embedded runtime root", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /const REQUIRED_RUNTIME_ROOT_PATH_GROUPS = \[/);
  assert.match(source, /runtimeBundleNodeRelativePaths\(CURRENT_RUNTIME_PLATFORM\)/);
  assert.match(source, /runtimeBundleNpmRelativePaths\(CURRENT_RUNTIME_PLATFORM\)/);
  assert.match(source, /runtimeBundlePythonRelativePaths\(CURRENT_RUNTIME_PLATFORM\)/);
  assert.match(source, /async function resolveRuntimeLaunchSpec\(\s*runtimeRoot: string,\s*executablePath: string,\s*\): Promise<RuntimeLaunchSpec \| null>/);
  assert.match(source, /function isReleaseStyleAppVersion\(version: string\)/);
  assert.match(source, /if \(typeof packagedDesktopConfig\.appUpdateEnabled === "boolean"\) \{\s*return packagedDesktopConfig\.appUpdateEnabled;\s*\}/);
  assert.match(source, /return isReleaseStyleAppVersion\(currentAppVersion\(\)\);/);
  assert.match(source, /const hasBundle = Boolean\(runtimeRoot && executablePath\);/);
  assert.match(source, /status: runtimeUnavailableStatus\(hasBundle\),/);
  assert.match(source, /const launchSpec = await resolveRuntimeLaunchSpec\(\s*runtimeRoot,\s*executablePath,\s*\);/);
  assert.doesNotMatch(source, /TOOLCHAIN_RELEASE_ASSET_NAMES/);
  assert.doesNotMatch(source, /ensureManagedRuntimeToolchainInstalled/);
  assert.doesNotMatch(source, /managedRuntimeToolchainSyncPromise/);
  assert.doesNotMatch(source, /HOLABOSS_RUNTIME_TOOLCHAIN_ROOT:/);
});
