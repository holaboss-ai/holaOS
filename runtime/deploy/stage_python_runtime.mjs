#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prunePackagedTree } from "./prune_packaged_tree.mjs";

const DEFAULT_PYTHON_RELEASE = "20260303";
const DEFAULT_PYTHON_VERSION = "3.12.13";
const DEFAULT_PYTHON_SOURCE_REPO = "astral-sh/python-build-standalone";
const DEFAULT_PYTHON_VARIANTS = ["install_only_stripped", "install_only"];

function log(message) {
  process.stderr.write(`[package-python-runtime] ${message}\n`);
}

function firstExistingPath(paths) {
  for (const candidatePath of paths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

function firstMatchingEntry(rootPath, matcher) {
  if (!existsSync(rootPath)) {
    return null;
  }

  const entries = readdirSync(rootPath);
  for (const entry of entries) {
    if (matcher(entry)) {
      return path.join(rootPath, entry);
    }
  }
  return null;
}

function pathExists(targetPath) {
  try {
    const details = statSync(targetPath);
    return details.isFile() || details.isDirectory();
  } catch {
    return false;
  }
}

export function normalizeRuntimePlatform(value) {
  const normalized = String(value || process.platform).trim().toLowerCase();
  switch (normalized) {
    case "darwin":
    case "mac":
    case "macos":
      return "macos";
    case "linux":
      return "linux";
    case "win32":
    case "windows":
      return "windows";
    default:
      throw new Error(`Unsupported runtime platform for bundled Python: ${normalized}`);
  }
}

export function normalizeRuntimeArch(value = process.arch) {
  const normalized = String(value).trim().toLowerCase();
  switch (normalized) {
    case "x64":
    case "amd64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      throw new Error(`Unsupported runtime architecture for bundled Python: ${normalized}`);
  }
}

export function resolvePythonTargetTriple(runtimePlatform, runtimeArch = process.arch) {
  const platform = normalizeRuntimePlatform(runtimePlatform);
  const arch = normalizeRuntimeArch(runtimeArch);
  if (platform === "macos") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
}

export function resolvePythonVariants(env = process.env) {
  const explicitVariant = (env.HOLABOSS_RUNTIME_PYTHON_VARIANT ?? "").trim();
  return explicitVariant ? [explicitVariant] : [...DEFAULT_PYTHON_VARIANTS];
}

export function buildPythonAssetName(params) {
  return `cpython-${params.pythonVersion}+${params.pythonRelease}-${params.targetTriple}-${params.variant}.tar.gz`;
}

export function buildPythonDownloadUrl(params) {
  const encodedAssetName = encodeURIComponent(params.assetName);
  return `https://github.com/${params.sourceRepo}/releases/download/${params.pythonRelease}/${encodedAssetName}`;
}

function runtimePythonCacheDir(env = process.env) {
  const configured = (env.HOLABOSS_RUNTIME_PYTHON_CACHE_DIR ?? "").trim();
  return configured ? path.resolve(configured) : path.join(os.tmpdir(), "holaboss-runtime-python-cache");
}

function resolveBundledPythonSpec(runtimePlatform, env = process.env) {
  const platform = normalizeRuntimePlatform(runtimePlatform);
  const pythonVersion = (env.HOLABOSS_RUNTIME_PYTHON_VERSION ?? DEFAULT_PYTHON_VERSION).trim();
  const pythonRelease = (env.HOLABOSS_RUNTIME_PYTHON_RELEASE ?? DEFAULT_PYTHON_RELEASE).trim();
  const sourceRepo = (env.HOLABOSS_RUNTIME_PYTHON_SOURCE_REPO ?? DEFAULT_PYTHON_SOURCE_REPO).trim();
  const targetTriple =
    (env.HOLABOSS_RUNTIME_PYTHON_TARGET_TRIPLE ?? "").trim() ||
    resolvePythonTargetTriple(platform, env.HOLABOSS_RUNTIME_PYTHON_ARCH ?? process.arch);

  return {
    platform,
    pythonVersion,
    pythonRelease,
    sourceRepo,
    targetTriple,
    variants: resolvePythonVariants(env),
    localDir: (env.HOLABOSS_RUNTIME_PYTHON_DIR ?? "").trim(),
    localArchive: (env.HOLABOSS_RUNTIME_PYTHON_TARBALL ?? "").trim(),
    explicitUrl: (env.HOLABOSS_RUNTIME_PYTHON_URL ?? "").trim(),
    githubToken:
      (env.HOLABOSS_RUNTIME_PYTHON_GITHUB_TOKEN ?? "").trim() ||
      (env.GITHUB_TOKEN ?? "").trim() ||
      (env.HOLABOSS_GITHUB_TOKEN ?? "").trim(),
  };
}

async function downloadToFile(url, destinationPath, token = "") {
  const headers = {
    "User-Agent": "holaboss-runtime-python-stager",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });
  if (response.status === 404) {
    return { ok: false, status: 404 };
  }
  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${url} (${response.status} ${response.statusText})`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destinationPath));
  return { ok: true, status: response.status };
}

async function resolvePythonArchive(spec) {
  if (spec.localArchive) {
    return {
      archivePath: path.resolve(spec.localArchive),
      variant: "custom",
      source: "local-tarball",
    };
  }

  if (spec.explicitUrl) {
    const cacheDir = runtimePythonCacheDir();
    mkdirSync(cacheDir, { recursive: true });
    const archivePath = path.join(cacheDir, path.basename(new URL(spec.explicitUrl).pathname || "python-runtime.tar.gz"));
    if (!pathExists(archivePath)) {
      const tempPath = `${archivePath}.downloading`;
      rmSync(tempPath, { force: true });
      log(`downloading bundled Python from ${spec.explicitUrl}`);
      const downloadResult = await downloadToFile(spec.explicitUrl, tempPath, spec.githubToken);
      if (!downloadResult.ok) {
        throw new Error(`bundled Python URL returned ${downloadResult.status}: ${spec.explicitUrl}`);
      }
      rmSync(archivePath, { force: true });
      cpSync(tempPath, archivePath);
      rmSync(tempPath, { force: true });
    }
    return {
      archivePath,
      variant: "custom",
      source: "url",
    };
  }

  const cacheDir = runtimePythonCacheDir();
  mkdirSync(cacheDir, { recursive: true });

  let lastError = "no candidate download URLs were attempted";
  for (const variant of spec.variants) {
    const assetName = buildPythonAssetName({
      pythonVersion: spec.pythonVersion,
      pythonRelease: spec.pythonRelease,
      targetTriple: spec.targetTriple,
      variant,
    });
    const archivePath = path.join(cacheDir, assetName);
    if (pathExists(archivePath)) {
      return {
        archivePath,
        variant,
        source: "cache",
      };
    }

    const url = buildPythonDownloadUrl({
      sourceRepo: spec.sourceRepo,
      pythonRelease: spec.pythonRelease,
      assetName,
    });
    const tempPath = `${archivePath}.downloading`;
    rmSync(tempPath, { force: true });
    log(`downloading bundled Python ${assetName}`);
    try {
      const downloadResult = await downloadToFile(url, tempPath, spec.githubToken);
      if (!downloadResult.ok) {
        lastError = `asset ${assetName} was not found`;
        rmSync(tempPath, { force: true });
        continue;
      }
      rmSync(archivePath, { force: true });
      cpSync(tempPath, archivePath);
      rmSync(tempPath, { force: true });
      return {
        archivePath,
        variant,
        source: "github",
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      rmSync(tempPath, { force: true });
    }
  }

  throw new Error(
    `failed to resolve bundled Python archive for ${spec.targetTriple}: ${lastError}`,
  );
}

// On Windows, `tar` on PATH is usually GNU tar (shipped with Git), which reads
// `-f C:\path` as a remote `host:path` spec and fails with "Cannot connect to
// C: resolve failed". The in-box bsdtar at System32\tar.exe (Win10 1803+)
// handles Windows paths natively, so prefer it there. GNU/BSD tar on
// macOS/Linux is fine.
function resolveTarExe() {
  if (process.platform === "win32") {
    const inbox = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "tar.exe",
    );
    if (existsSync(inbox)) {
      return inbox;
    }
  }
  return "tar";
}

function extractTarball(archivePath, extractDir) {
  mkdirSync(extractDir, { recursive: true });
  execFileSync(resolveTarExe(), ["-xzf", archivePath, "-C", extractDir], {
    stdio: "inherit",
    env: process.env,
  });
}

function resolveExtractedPythonRoot(extractDir) {
  const explicitPythonRoot = path.join(extractDir, "python");
  if (pathExists(explicitPythonRoot)) {
    return explicitPythonRoot;
  }

  const nestedPythonRoot = firstMatchingEntry(extractDir, (entry) =>
    pathExists(path.join(extractDir, entry, "python")),
  );
  if (nestedPythonRoot) {
    return path.join(nestedPythonRoot, "python");
  }

  throw new Error(`downloaded Python archive did not contain a top-level python/ directory under ${extractDir}`);
}

function resolvePosixPythonBinary(pythonInstallRoot) {
  const binDir = path.join(pythonInstallRoot, "bin");
  const direct = firstExistingPath([
    path.join(binDir, "python"),
    path.join(binDir, "python3"),
  ]);
  if (direct) {
    return direct;
  }
  const versioned = firstMatchingEntry(binDir, (entry) => /^python3(\.\d+)?$/.test(entry));
  if (versioned) {
    return versioned;
  }
  throw new Error(`bundled Python executable was not found under ${binDir}`);
}

function ensureWindowsPythonAliases(pythonInstallRoot) {
  const pythonExe = path.join(pythonInstallRoot, "python.exe");
  if (!pathExists(pythonExe)) {
    throw new Error(`bundled Python executable was not found under ${pythonInstallRoot}`);
  }

  const python3Exe = path.join(pythonInstallRoot, "python3.exe");
  if (!pathExists(python3Exe)) {
    copyFileSync(pythonExe, python3Exe);
  }

  return {
    pythonExe,
    python3Exe,
  };
}

function writePosixShim(targetPath, commandRelativePath, args = []) {
  const relativeCommand = commandRelativePath.split(path.sep).join("/");
  const staticArgs = args.length > 0 ? ` ${args.join(" ")}` : "";
  writeFileSync(
    targetPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      `exec "\${SCRIPT_DIR}/${relativeCommand}"${staticArgs} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(targetPath, 0o755);
}

function writeWindowsShim(targetPath, commandRelativePath, args = []) {
  const relativeCommand = commandRelativePath.split("/").join("\\");
  const staticArgs = args.length > 0 ? ` ${args.join(" ")}` : "";
  writeFileSync(
    targetPath,
    `@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "TARGET=%SCRIPT_DIR%${relativeCommand.startsWith("..") ? "" : "."}${relativeCommand}"
if not exist "%TARGET%" (
  >&2 echo bundled python runtime not found: "%TARGET%"
  exit /b 1
)
"%TARGET%"${staticArgs} %*
`,
  );
}

function writePosixToolShims(pythonRuntimeRoot, pythonInstallRoot) {
  const shimDir = path.join(pythonRuntimeRoot, "bin");
  mkdirSync(shimDir, { recursive: true });
  const pythonBinary = resolvePosixPythonBinary(pythonInstallRoot);
  const pythonRelative = path.relative(shimDir, pythonBinary);

  writePosixShim(path.join(shimDir, "python"), pythonRelative);
  writePosixShim(path.join(shimDir, "python3"), pythonRelative);
  writePosixShim(path.join(shimDir, "pip"), pythonRelative, ["-m", "pip"]);
  writePosixShim(path.join(shimDir, "pip3"), pythonRelative, ["-m", "pip"]);
}

function writeWindowsToolShims(pythonRuntimeRoot, pythonInstallRoot) {
  const shimDir = path.join(pythonRuntimeRoot, "bin");
  mkdirSync(shimDir, { recursive: true });
  const aliases = ensureWindowsPythonAliases(pythonInstallRoot);
  const pythonRelative = path.relative(shimDir, aliases.pythonExe).split(path.sep).join("\\");
  const python3Relative = path.relative(shimDir, aliases.python3Exe).split(path.sep).join("\\");

  writeWindowsShim(path.join(shimDir, "python.cmd"), pythonRelative);
  writeWindowsShim(path.join(shimDir, "python3.cmd"), python3Relative);
  writeWindowsShim(path.join(shimDir, "pip.cmd"), pythonRelative, ["-m", "pip"]);
  writeWindowsShim(path.join(shimDir, "pip3.cmd"), pythonRelative, ["-m", "pip"]);
}

function materializeSymlinks(rootPath) {
  if (!pathExists(rootPath) || !statSync(rootPath).isDirectory()) {
    return;
  }

  const queue = [rootPath];
  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (!currentPath) {
      continue;
    }

    for (const entry of readdirSync(currentPath)) {
      const entryPath = path.join(currentPath, entry);
      const entryDetails = lstatSync(entryPath);

      if (entryDetails.isSymbolicLink()) {
        const resolvedTargetPath = realpathSync(entryPath);
        rmSync(entryPath, { recursive: true, force: true });

        const targetDetails = statSync(resolvedTargetPath);
        if (targetDetails.isDirectory()) {
          cpSync(resolvedTargetPath, entryPath, { recursive: true, force: true });
          queue.push(entryPath);
        } else {
          copyFileSync(resolvedTargetPath, entryPath);
        }
        continue;
      }

      if (entryDetails.isDirectory()) {
        queue.push(entryPath);
      }
    }
  }
}

function resolveLocalPythonRoot(localDir) {
  const resolvedDir = path.resolve(localDir);
  const pythonRoot = firstExistingPath([path.join(resolvedDir, "python"), resolvedDir]);
  if (!pythonRoot || !statSync(pythonRoot).isDirectory()) {
    throw new Error(`HOLABOSS_RUNTIME_PYTHON_DIR did not point to a Python install root: ${resolvedDir}`);
  }
  return pythonRoot;
}

export async function stagePythonRuntime(outputRootArg, runtimePlatformArg = process.platform) {
  const outputRoot = path.resolve(outputRootArg);
  const spec = resolveBundledPythonSpec(runtimePlatformArg);
  const pythonRuntimeRoot = path.join(outputRoot, "python-runtime");
  const pythonInstallRoot = path.join(pythonRuntimeRoot, "python");
  const stagingRoot = path.join(os.tmpdir(), `holaboss-python-stage-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  rmSync(pythonRuntimeRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(stagingRoot, { recursive: true });

  try {
    let extractedPythonRoot;
    if (spec.localDir) {
      extractedPythonRoot = resolveLocalPythonRoot(spec.localDir);
      log(`using bundled Python directory from ${extractedPythonRoot}`);
    } else {
      const { archivePath, variant, source } = await resolvePythonArchive(spec);
      log(`using bundled Python archive ${archivePath} (${source}, variant=${variant})`);
      extractTarball(archivePath, stagingRoot);
      extractedPythonRoot = resolveExtractedPythonRoot(stagingRoot);
    }

    mkdirSync(pythonRuntimeRoot, { recursive: true });
    cpSync(extractedPythonRoot, pythonInstallRoot, { recursive: true, force: true });
    materializeSymlinks(pythonInstallRoot);
    prunePackagedTree(pythonInstallRoot, spec.platform);

    if (spec.platform === "windows") {
      writeWindowsToolShims(pythonRuntimeRoot, pythonInstallRoot);
    } else {
      writePosixToolShims(pythonRuntimeRoot, pythonInstallRoot);
    }

    const bundledPythonBin =
      spec.platform === "windows"
        ? firstExistingPath([
            path.join(pythonInstallRoot, "python.exe"),
            path.join(pythonInstallRoot, "python3.exe"),
          ])
        : firstExistingPath([
            path.join(pythonRuntimeRoot, "bin", "python"),
            path.join(pythonRuntimeRoot, "bin", "python3"),
          ]);

    return {
      pythonRuntimeRoot,
      bundledPythonBin,
      bundledPythonVersion: spec.pythonVersion,
      bundledPythonTarget: spec.targetTriple,
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function isDirectRun() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const outputRoot = process.argv[2];
  const runtimePlatform = process.argv[3] ?? process.platform;
  if (!outputRoot) {
    log("usage: stage_python_runtime.mjs <output-root> [platform]");
    process.exit(1);
  }

  try {
    const result = await stagePythonRuntime(outputRoot, runtimePlatform);
    log(
      `staged bundled Python at ${result.pythonRuntimeRoot} (version=${result.bundledPythonVersion}, target=${result.bundledPythonTarget})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    process.exit(1);
  }
}
