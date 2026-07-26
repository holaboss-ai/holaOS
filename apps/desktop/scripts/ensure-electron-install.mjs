#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const desktopRoot = path.resolve(scriptDir, "..");

export function electronPlatformPath(platform = process.env.npm_config_platform || process.platform) {
  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

export function resolveElectronInstallState(root = desktopRoot, env = process.env) {
  let electronPackagePath;
  try {
    electronPackagePath = require.resolve("electron/package.json", { paths: [root] });
  } catch (error) {
    throw new Error(
      "Electron is not installed for apps/desktop. Run `bun install` before starting desktop:dev.",
      { cause: error },
    );
  }

  const electronDir = path.dirname(electronPackagePath);
  const electronPackage = JSON.parse(readFileSync(electronPackagePath, "utf8"));
  const platformPath = electronPlatformPath(env.npm_config_platform || process.platform);
  const pathFilePath = path.join(electronDir, "path.txt");
  const configuredPath = existsSync(pathFilePath) ? readFileSync(pathFilePath, "utf8").trim() : "";
  const distRoot = (env.ELECTRON_OVERRIDE_DIST_PATH ?? "").trim() || path.join(electronDir, "dist");
  const expectedBinaryPath = path.join(distRoot, platformPath);
  const resolvedBinaryPath = path.join(distRoot, configuredPath || platformPath);
  const versionPath = path.join(electronDir, "dist", "version");
  const installedVersion = existsSync(versionPath)
    ? readFileSync(versionPath, "utf8").trim().replace(/^v/, "")
    : "";

  return {
    configuredPath,
    distRoot,
    electronDir,
    expectedBinaryPath,
    expectedBinaryExists: existsSync(expectedBinaryPath),
    expectedVersion: electronPackage.version,
    hasPathFile: existsSync(pathFilePath),
    installScriptPath: path.join(electronDir, "install.js"),
    installedVersion,
    pathFilePath,
    platformPath,
    resolvedBinaryExists: existsSync(resolvedBinaryPath),
    resolvedBinaryPath,
    versionMatches: installedVersion === electronPackage.version,
  };
}

export function electronInstallIsValid(state) {
  return (
    state.hasPathFile &&
    state.configuredPath === state.platformPath &&
    state.versionMatches &&
    state.expectedBinaryExists
  );
}

export function canRepairElectronPathFile(state) {
  return state.versionMatches && state.expectedBinaryExists && state.configuredPath !== state.platformPath;
}

export function probeElectronBinary(state, env = process.env) {
  const probeEnv = {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
  };
  delete probeEnv.ELECTRON_SKIP_BINARY_DOWNLOAD;
  try {
    execFileSync(state.expectedBinaryPath, ["-e", "process.exit(0)"], {
      env: probeEnv,
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function runElectronInstaller(
  state,
  root = desktopRoot,
  env = process.env,
  { forceNoCache = false, resetDist = false } = {},
) {
  const installEnv = { ...env };
  delete installEnv.ELECTRON_SKIP_BINARY_DOWNLOAD;
  if (forceNoCache) {
    installEnv.force_no_cache = "true";
  } else {
    delete installEnv.force_no_cache;
  }
  if (resetDist) {
    rmSync(state.pathFilePath, { force: true });
    rmSync(path.join(state.electronDir, "dist"), { force: true, recursive: true });
  }
  process.stdout.write(
    `[ensure-electron-install] running Electron installer for ${path.relative(root, state.electronDir) || state.electronDir}\n`,
  );
  execFileSync(process.execPath, [state.installScriptPath], {
    cwd: root,
    env: installEnv,
    stdio: "inherit",
  });
}

export function ensureElectronInstall(root = desktopRoot, env = process.env, options = {}) {
  const runInstall = options.runInstall ?? runElectronInstaller;
  const probe = options.probeElectronBinary ?? probeElectronBinary;

  let state = resolveElectronInstallState(root, env);
  if (electronInstallIsValid(state) && probe(state, env)) {
    return state;
  }

  if (canRepairElectronPathFile(state)) {
    writeFileSync(state.pathFilePath, state.platformPath);
    process.stdout.write(
      `[ensure-electron-install] restored ${path.relative(root, state.pathFilePath) || state.pathFilePath}\n`,
    );
    state = resolveElectronInstallState(root, env);
    if (electronInstallIsValid(state) && probe(state, env)) {
      return state;
    }
  }

  const reinstallFromScratch = electronInstallIsValid(state);
  runInstall(state, root, env, {
    forceNoCache: reinstallFromScratch,
    resetDist: reinstallFromScratch,
  });

  state = resolveElectronInstallState(root, env);
  if (!electronInstallIsValid(state) || !probe(state, env)) {
    throw new Error(
      `Electron install is still incomplete. Expected ${state.expectedBinaryPath} and ${state.pathFilePath}.`,
    );
  }
  return state;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    ensureElectronInstall();
  } catch (error) {
    console.error(`[ensure-electron-install] ${error.message}`);
    process.exit(1);
  }
}
