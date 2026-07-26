import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureElectronInstall, resolveElectronInstallState } from "./ensure-electron-install.mjs";

function createFakeElectronDesktopRoot() {
  const desktopRoot = mkdtempSync(path.join(os.tmpdir(), "holaboss-electron-"));
  const electronDir = path.join(desktopRoot, "node_modules", "electron");
  mkdirSync(path.join(electronDir, "dist"), { recursive: true });
  writeFileSync(
    path.join(electronDir, "package.json"),
    JSON.stringify({ name: "electron", version: "41.6.1" }),
  );
  writeFileSync(path.join(electronDir, "install.js"), "// test stub");
  return { desktopRoot, electronDir };
}

test("ensureElectronInstall recreates path.txt when Bun leaves the binary in place", (t) => {
  const { desktopRoot, electronDir } = createFakeElectronDesktopRoot();
  t.after(() => rmSync(desktopRoot, { force: true, recursive: true }));

  writeFileSync(path.join(electronDir, "dist", "version"), "v41.6.1");
  writeFileSync(path.join(electronDir, "dist", "electron.exe"), "");

  const env = { npm_config_platform: "win32" };
  const initialState = resolveElectronInstallState(desktopRoot, env);
  assert.equal(initialState.hasPathFile, false);
  assert.equal(initialState.expectedBinaryExists, true);

  let installCalls = 0;
  const repairedState = ensureElectronInstall(desktopRoot, env, {
    probeElectronBinary() {
      return true;
    },
    runInstall() {
      installCalls += 1;
    },
  });

  assert.equal(installCalls, 0);
  assert.equal(repairedState.hasPathFile, true);
  assert.equal(repairedState.configuredPath, "electron.exe");
  assert.equal(readFileSync(path.join(electronDir, "path.txt"), "utf8"), "electron.exe");
});

test("ensureElectronInstall falls back to Electron's installer when required files are missing", (t) => {
  const { desktopRoot, electronDir } = createFakeElectronDesktopRoot();
  t.after(() => rmSync(desktopRoot, { force: true, recursive: true }));

  let installCalls = 0;
  const repairedState = ensureElectronInstall(desktopRoot, { npm_config_platform: "win32" }, {
    probeElectronBinary() {
      return true;
    },
    runInstall(state) {
      installCalls += 1;
      mkdirSync(path.dirname(state.expectedBinaryPath), { recursive: true });
      writeFileSync(path.join(electronDir, "dist", "version"), "v41.6.1");
      writeFileSync(state.expectedBinaryPath, "");
      writeFileSync(state.pathFilePath, state.platformPath);
    },
  });

  assert.equal(installCalls, 1);
  assert.equal(repairedState.hasPathFile, true);
  assert.equal(repairedState.versionMatches, true);
  assert.equal(repairedState.expectedBinaryExists, true);
});

test("ensureElectronInstall forces a clean reinstall when the existing binary fails the launch probe", (t) => {
  const { desktopRoot, electronDir } = createFakeElectronDesktopRoot();
  t.after(() => rmSync(desktopRoot, { force: true, recursive: true }));

  writeFileSync(path.join(electronDir, "dist", "version"), "v41.6.1");
  writeFileSync(path.join(electronDir, "dist", "electron.exe"), "");
  writeFileSync(path.join(electronDir, "path.txt"), "electron.exe");

  let installCalls = 0;
  let probeCalls = 0;
  const repairedState = ensureElectronInstall(desktopRoot, { npm_config_platform: "win32" }, {
    probeElectronBinary() {
      probeCalls += 1;
      return probeCalls > 1;
    },
    runInstall(_state, _root, _env, installOptions) {
      installCalls += 1;
      assert.equal(installOptions.forceNoCache, true);
      assert.equal(installOptions.resetDist, true);
    },
  });

  assert.equal(installCalls, 1);
  assert.equal(repairedState.hasPathFile, true);
  assert.equal(repairedState.expectedBinaryExists, true);
});
