import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildWindowsRuntimeCmdLauncherSource,
  buildWindowsRuntimeLauncherSource
} from "./package_windows_runtime.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildRuntimeRootPath = path.join(__dirname, "build_runtime_root.mjs");
const macosPackagerPath = path.join(__dirname, "package_macos_runtime.sh");
const linuxPackagerPath = path.join(__dirname, "package_linux_runtime.sh");
const windowsPackagerPath = path.join(__dirname, "package_windows_runtime.mjs");

for (const targetPath of [macosPackagerPath, linuxPackagerPath]) {
  test(`${path.basename(targetPath)} bundles local node and python runtimes and exports them`, async () => {
    const source = await readFile(targetPath, "utf8");
    const targetPlatform = path.basename(targetPath).includes("macos") ? "macos" : "linux";

    assert.match(
      source,
      /(?:npm install --prefix "\$\{BUILD_NODE_RUNTIME_DIR\}" "node@\$\{NODE_VERSION\}" "npm@\$\{NPM_VERSION\}"|bun add "node@\$\{NODE_VERSION\}" "npm@\$\{NPM_VERSION\}")/,
    );
    assert.match(source, /DEFAULT_RUNTIME_NODE_VERSION="24\.14\.1"/);
    assert.match(source, /NODE_VERSION="\$\{HOLABOSS_RUNTIME_NODE_VERSION:-\$\{DEFAULT_RUNTIME_NODE_VERSION\}\}"/);
    assert.match(source, /BUILD_NODE_RUNTIME_DIR="\$\{STAGING_ROOT\}\/build-node-runtime"/);
    assert.match(source, /build_runtime_root\.mjs/);
    assert.match(source, /cp -R "\$\{BUILD_NODE_RUNTIME_DIR\}" "\$\{NODE_RUNTIME_DIR\}"/);
    assert.match(source, new RegExp(`node "\\$\\{SCRIPT_DIR\\}/stage_python_runtime\\.mjs" "\\$\\{OUTPUT_ROOT\\}" "${targetPlatform}"`));
    assert.match(source, /TOOLCHAIN_ROOT="\$\{HOLABOSS_RUNTIME_TOOLCHAIN_ROOT:-\$\{BUNDLE_ROOT\}\}"/);
    assert.match(source, /BUNDLED_NODE_BIN="\$\{TOOLCHAIN_ROOT\}\/node-runtime\/node_modules\/node\/bin\/node"/);
    assert.match(source, /export HOLABOSS_RUNTIME_TOOLCHAIN_ROOT="\$\{TOOLCHAIN_ROOT\}"/);
    assert.match(source, /export PATH="\$\{TOOLCHAIN_ROOT\}\/python-runtime\/bin:\$\{TOOLCHAIN_ROOT\}\/python-runtime\/python\/bin:\$\{TOOLCHAIN_ROOT\}\/node-runtime\/node_modules\/node\/bin:\$\{TOOLCHAIN_ROOT\}\/node-runtime\/node_modules\/\.bin:\$\{PATH\}"/);
    assert.match(source, /export HOLABOSS_RUNTIME_NODE_BIN="\$\{BUNDLED_NODE_BIN\}"/);
    assert.match(source, /"toolchain_id":/);
    assert.match(source, /"bundled_npm_bin":/);
    assert.match(source, /"bundled_npm_version":/);
    assert.match(source, /"bundled_python_bin":/);
    assert.match(source, /"bundled_python_version":/);
    assert.match(source, /"bundled_python_target":/);
    assert.equal(/npm install --global --prefix "\$\{NODE_RUNTIME_DIR\}"/.test(source), false);
    assert.equal(/HOLABOSS_INSTALL_[A-Z_]+/.test(source), false);

    if (targetPlatform === "linux") {
      assert.match(source, /run_build_runtime_root\(\) \{/);
      assert.match(source, /local max_attempts=3/);
      assert.match(source, /runtime root assembly failed on attempt \$\{attempt\}\/\$\{max_attempts\}; retrying/);
      assert.match(source, /run_build_runtime_root/);
    }
  });
}

test("package_windows_runtime.mjs writes launchers that use the bundled node runtime and stages Python", async () => {
  const source = await readFile(windowsPackagerPath, "utf8");
  const launcherSource = buildWindowsRuntimeLauncherSource();
  const cmdLauncherSource = buildWindowsRuntimeCmdLauncherSource();

  assert.match(source, /import \{ stagePythonRuntime \} from "\.\/stage_python_runtime\.mjs";/);
  assert.match(source, /const DEFAULT_RUNTIME_NODE_VERSION = "24\.14\.1";/);
  assert.match(source, /const buildNodeRuntimeDir = path\.join\(stagingRoot, "build-node-runtime"\);/);
  assert.match(source, /HOLABOSS_RUNTIME_BUILD_NPM_CLI: buildNpmCli/);
  assert.match(source, /runNpm\(\["install", "--prefix", buildNodeRuntimeDir, `node@\$\{nodeVersion\}`, `npm@\$\{npmVersion\}`\]/);
  assert.match(source, /cpSync\(buildNodeRuntimeDir, nodeRuntimeDir, \{ recursive: true, dereference: true \}\)/);
  assert.match(source, /prunePackagedTree\(nodeRuntimeDir, "windows"\)/);
  assert.match(source, /const pythonStageResult = await stagePythonRuntime\(outputRoot, "windows"\);/);
  assert.match(source, /bundled_npm_bin: Boolean\(bundledNpmBin\)/);
  assert.match(source, /bundled_npm_version: skipNodeDeps \? null : npmVersion/);
  assert.match(source, /bundled_python_bin: Boolean\(bundledPythonBin\)/);
  assert.match(source, /bundled_python_version: pythonStageResult\.bundledPythonVersion/);
  assert.match(source, /bundled_python_target: pythonStageResult\.bundledPythonTarget/);
  assert.match(source, /toolchain_id: toolchainId/);
  assert.match(launcherSource, /startWindowsRuntime/);
  assert.match(launcherSource, /process\.exit/);
  assert.match(cmdLauncherSource, /HOLABOSS_RUNTIME_TOOLCHAIN_ROOT/);
  assert.match(cmdLauncherSource, /node-runtime\\bin\\node\.exe/);
  assert.match(cmdLauncherSource, /sandbox-runtime\.mjs/);
});

test("build_runtime_root stages package-local scripts before npm ci", async () => {
  const source = await readFile(buildRuntimeRootPath, "utf8");

  assert.match(
    source,
    /copyIfPresent\(path\.join\(packageDir, "scripts"\), path\.join\(targetDir, "scripts"\)\);/,
  );
});
