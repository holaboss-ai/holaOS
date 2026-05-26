import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const RUN_ELECTRON_BUILDER_PATH = new URL("./run-electron-builder.mjs", import.meta.url);
const RUN_PACKAGED_PATH = new URL("./run-packaged.mjs", import.meta.url);

test("local Windows packaging uses a fresh output directory unless CI or an explicit override says otherwise", async () => {
  const source = await readFile(RUN_ELECTRON_BUILDER_PATH, "utf8");

  assert.match(source, /function hasExplicitOutputDir\(builderArgs\)/);
  assert.match(source, /function isCiEnvironment\(env\)/);
  assert.match(source, /function buildLocalWindowsOutputDir\(\)/);
  assert.match(source, /process\.platform === "win32"/);
  assert.match(source, /inferredRuntimePlatform === "windows"/);
  assert.match(source, /!isCiEnvironment\(process\.env\)/);
  assert.match(source, /!hasExplicitOutputDir\(builderArgs\)/);
  assert.match(source, /-c\.directories\.output=\$\{localOutputDir\}/);
  assert.match(source, /release-local-/);
});

test("packaged runner can locate the latest local Windows packaging output", async () => {
  const source = await readFile(RUN_PACKAGED_PATH, "utf8");

  assert.match(source, /entry\.name\.startsWith\("release-local-"\)/);
  assert.match(source, /sort\(\(left, right\) => right\.mtimeMs - left\.mtimeMs\)/);
  assert.match(source, /win-unpacked", "holaOS\.exe"/);
  assert.match(source, /await localReleaseCandidates\(\)/);
});
