import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import {
  buildPythonAssetName,
  buildPythonDownloadUrl,
  normalizeRuntimeArch,
  normalizeRuntimePlatform,
  resolvePythonTargetTriple,
  resolvePythonVariants,
  stagePythonRuntime,
} from "./stage_python_runtime.mjs";

test("python runtime helper normalizes supported platforms and architectures", () => {
  assert.equal(normalizeRuntimePlatform("darwin"), "macos");
  assert.equal(normalizeRuntimePlatform("linux"), "linux");
  assert.equal(normalizeRuntimePlatform("win32"), "windows");
  assert.equal(normalizeRuntimeArch("amd64"), "x64");
  assert.equal(normalizeRuntimeArch("aarch64"), "arm64");
});

test("python runtime helper maps target triples by platform and architecture", () => {
  assert.equal(resolvePythonTargetTriple("macos", "arm64"), "aarch64-apple-darwin");
  assert.equal(resolvePythonTargetTriple("macos", "x64"), "x86_64-apple-darwin");
  assert.equal(resolvePythonTargetTriple("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(resolvePythonTargetTriple("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(resolvePythonTargetTriple("windows", "arm64"), "aarch64-pc-windows-msvc");
  assert.equal(resolvePythonTargetTriple("windows", "x64"), "x86_64-pc-windows-msvc");
});

test("python runtime helper builds pinned standalone asset names and download URLs", () => {
  const assetName = buildPythonAssetName({
    pythonVersion: "3.12.13",
    pythonRelease: "20260303",
    targetTriple: "x86_64-unknown-linux-gnu",
    variant: "install_only_stripped",
  });
  assert.equal(
    assetName,
    "cpython-3.12.13+20260303-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
  );
  assert.equal(
    buildPythonDownloadUrl({
      sourceRepo: "astral-sh/python-build-standalone",
      pythonRelease: "20260303",
      assetName,
    }),
    "https://github.com/astral-sh/python-build-standalone/releases/download/20260303/cpython-3.12.13%2B20260303-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
  );
});

test("python runtime helper defaults to stripped then unstripped archives", () => {
  assert.deepEqual(resolvePythonVariants({}), ["install_only_stripped", "install_only"]);
  assert.deepEqual(
    resolvePythonVariants({ HOLABOSS_RUNTIME_PYTHON_VARIANT: "install_only" }),
    ["install_only"],
  );
});

test("python runtime staging dereferences absolute symlinks from the source install", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "holaboss-python-stage-test-"));
  const sourceRoot = path.join(tempRoot, "source-python");
  const sourceBin = path.join(sourceRoot, "bin");
  const outputRoot = path.join(tempRoot, "output");
  mkdirSync(sourceBin, { recursive: true });

  const versionedPython = path.join(sourceBin, "python3.12");
  writeFileSync(
    versionedPython,
    "#!/usr/bin/env bash\nprintf 'python-ok\\n'\n",
  );
  chmodSync(versionedPython, 0o755);

  symlinkSync(versionedPython, path.join(sourceBin, "python"));
  symlinkSync(versionedPython, path.join(sourceBin, "python3"));

  const previousPythonDir = process.env.HOLABOSS_RUNTIME_PYTHON_DIR;
  try {
    process.env.HOLABOSS_RUNTIME_PYTHON_DIR = sourceRoot;
    const result = await stagePythonRuntime(outputRoot, "macos");
    const stagedPython = path.join(result.pythonRuntimeRoot, "python", "bin", "python");
    const stagedPython3 = path.join(result.pythonRuntimeRoot, "python", "bin", "python3");

    assert.equal(lstatSync(stagedPython).isSymbolicLink(), false);
    assert.equal(lstatSync(stagedPython3).isSymbolicLink(), false);
    assert.equal(
      readFileSync(stagedPython, "utf8"),
      readFileSync(versionedPython, "utf8"),
    );
    assert.equal(
      readFileSync(stagedPython3, "utf8"),
      readFileSync(versionedPython, "utf8"),
    );
  } finally {
    if (previousPythonDir === undefined) {
      delete process.env.HOLABOSS_RUNTIME_PYTHON_DIR;
    } else {
      process.env.HOLABOSS_RUNTIME_PYTHON_DIR = previousPythonDir;
    }
    try {
      unlinkSync(path.join(sourceBin, "python"));
      unlinkSync(path.join(sourceBin, "python3"));
    } catch {
      // ignore
    }
  }
});
