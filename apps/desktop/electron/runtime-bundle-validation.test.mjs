import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.join(__dirname, "main.ts");
const ensureRuntimeBundlePath = path.join(__dirname, "..", "scripts", "ensure-runtime-bundle.mjs");
const desktopPackagePath = path.join(__dirname, "..", "package.json");
const stageRuntimeBundlePath = path.join(__dirname, "..", "scripts", "stage-runtime-bundle.mjs");
const runtimeBundlePath = path.join(__dirname, "..", "scripts", "runtime-bundle.mjs");

test("desktop runtime validation treats the packaged runtime as self-contained", async () => {
  const source = await readFile(mainPath, "utf8");

  assert.match(source, /"node-runtime",\s*"bin",\s*"node\.exe"/);
  assert.match(source, /path\.join\("python-runtime", "bin", "python"\)/);
  assert.match(source, /const REQUIRED_RUNTIME_ROOT_PATH_GROUPS = \[/);
  assert.match(source, /runtimeBundleNodeRelativePaths\(CURRENT_RUNTIME_PLATFORM\)/);
  assert.match(source, /runtimeBundleNpmRelativePaths\(CURRENT_RUNTIME_PLATFORM\)/);
  assert.match(source, /runtimeBundlePythonRelativePaths\(CURRENT_RUNTIME_PLATFORM\)/);
  assert.doesNotMatch(source, /REQUIRED_RUNTIME_TOOLCHAIN_PATH_GROUPS/);
  assert.doesNotMatch(source, /validateRuntimeToolchainRoot/);
});

test("desktop runtime staging checks the bundled runtime requirement groups", async () => {
  const [ensureSource, stageSource, runtimeBundleSource] = await Promise.all([
    readFile(ensureRuntimeBundlePath, "utf8"),
    readFile(stageRuntimeBundlePath, "utf8"),
    readFile(runtimeBundlePath, "utf8"),
  ]);

  assert.match(ensureSource, /resolveRuntimeBundleState\(desktopRoot\)/);
  assert.match(ensureSource, /runtimeBundleState\.requiredRuntimePathGroups/);
  assert.match(ensureSource, /runtimeBundleIsStale\(runtimeBundleState\)/);
  assert.match(stageSource, /runtimeBundleRequiredPathGroups\(runtimePlatform\)/);
  assert.match(runtimeBundleSource, /export function runtimeBundlePythonRelativePaths/);
  assert.match(runtimeBundleSource, /path\.join\("python-runtime", "bin", "python"\)/);
});

test("desktop packaging scripts build and stage local runtimes by default", async () => {
  const packageJson = JSON.parse(await readFile(desktopPackagePath, "utf8"));

  assert.match(packageJson.scripts["dist:mac"], /prepare:runtime:local:macos/);
  assert.match(packageJson.scripts["dist:mac:dmg"], /prepare:runtime:local:macos/);
  assert.match(packageJson.scripts["dist:win"], /prepare:runtime:local:windows/);
});
