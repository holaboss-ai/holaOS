#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRuntimeRoot, runCommand } from "./build_runtime_root.mjs";
import { prunePackagedTree } from "./prune_packaged_tree.mjs";
import { stagePythonRuntime } from "./stage_python_runtime.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(runtimeRoot, "..");
const DEFAULT_RUNTIME_NODE_VERSION = "24.14.1";

function isNodeScriptPath(targetPath) {
  const extension = path.extname(targetPath).toLowerCase();
  return extension === ".js" || extension === ".cjs" || extension === ".mjs";
}

function resolveWindowsNpmCliPath() {
  const envExecPath = process.env.npm_execpath?.trim();
  if (envExecPath && existsSync(envExecPath) && isNodeScriptPath(envExecPath)) {
    return envExecPath;
  }

  const bundledCliPath = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundledCliPath)) {
    return bundledCliPath;
  }

  throw new Error("failed to resolve npm CLI entrypoint on Windows");
}

function npmInvocation() {
  if (process.platform === "win32") {
    return {
      command: process.execPath,
      argsPrefix: [resolveWindowsNpmCliPath()]
    };
  }

  return {
    command: "npm",
    argsPrefix: []
  };
}

function runNpm(args, options = {}) {
  const { command, argsPrefix } = npmInvocation();
  return execFileSync(command, [...argsPrefix, ...args], {
    env: process.env,
    ...options
  });
}

function assertWindowsHost() {
  if (process.platform !== "win32") {
    throw new Error("package_windows_runtime.mjs must run on Windows to produce a native Windows runtime bundle.");
  }
}

function firstExistingPath(paths) {
  for (const candidatePath of paths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

function bundledNodeCandidates(outputRoot) {
  return [
    path.join(outputRoot, "node-runtime", "bin", "node.exe"),
    path.join(outputRoot, "node-runtime", "node_modules", ".bin", "node.exe"),
    path.join(outputRoot, "node-runtime", "node_modules", "node", "bin", "node.exe"),
    path.join(outputRoot, "node-runtime", "node_modules", ".bin", "node.cmd")
  ];
}

function bundledNpmCandidates(outputRoot) {
  return [
    path.join(outputRoot, "node-runtime", "bin", "npm.cmd"),
    path.join(outputRoot, "node-runtime", "bin", "npm"),
    path.join(outputRoot, "node-runtime", "node_modules", ".bin", "npm.cmd"),
    path.join(outputRoot, "node-runtime", "node_modules", ".bin", "npm"),
    path.join(outputRoot, "node-runtime", "node_modules", "npm", "bin", "npm-cli.js")
  ];
}

function bundledPythonCandidates(outputRoot) {
  return [
    path.join(outputRoot, "python-runtime", "python", "python.exe"),
    path.join(outputRoot, "python-runtime", "python", "python3.exe"),
    path.join(outputRoot, "python-runtime", "bin", "python.cmd"),
    path.join(outputRoot, "python-runtime", "bin", "python3.cmd")
  ];
}

function resolveNodeVersion() {
  return process.env.HOLABOSS_RUNTIME_NODE_VERSION?.trim() || DEFAULT_RUNTIME_NODE_VERSION;
}

function resolveNpmVersion() {
  const explicitVersion = process.env.HOLABOSS_RUNTIME_NPM_VERSION?.trim();
  if (explicitVersion) {
    return explicitVersion;
  }
  return runNpm(["--version"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8"
  }).trim();
}

function sanitizeToolchainId(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function buildWindowsRuntimeLauncherSource() {
  return `import { startWindowsRuntime } from "../runtime/bootstrap/windows.mjs";

try {
  const exitCode = await startWindowsRuntime(process.argv.slice(2));
  process.exit(typeof exitCode === "number" ? exitCode : 0);
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(\`\${message}\\n\`);
  process.exit(1);
}
`;
}

export function buildWindowsRuntimeCmdLauncherSource() {
  return `@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "BUNDLE_ROOT=%%~fI"
if "%HOLABOSS_RUNTIME_TOOLCHAIN_ROOT%"=="" (
  set "TOOLCHAIN_ROOT=%BUNDLE_ROOT%"
) else (
  set "TOOLCHAIN_ROOT=%HOLABOSS_RUNTIME_TOOLCHAIN_ROOT%"
)
set "BUNDLED_NODE_BIN=%TOOLCHAIN_ROOT%\\node-runtime\\bin\\node.exe"
if not exist "%BUNDLED_NODE_BIN%" set "BUNDLED_NODE_BIN=%TOOLCHAIN_ROOT%\\node-runtime\\node_modules\\node\\bin\\node.exe"
if not exist "%BUNDLED_NODE_BIN%" set "BUNDLED_NODE_BIN=%TOOLCHAIN_ROOT%\\node-runtime\\node_modules\\.bin\\node.exe"
if not exist "%BUNDLED_NODE_BIN%" (
  >&2 echo bundled node runtime not found under "%TOOLCHAIN_ROOT%\\node-runtime"
  exit /b 1
)
"%BUNDLED_NODE_BIN%" "%SCRIPT_DIR%sandbox-runtime.mjs" %*
`;
}

function buildWindowsPosixNodeLauncherSource() {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "\${SCRIPT_DIR}/node.exe" "$@"
`;
}

function buildWindowsPosixCliLauncherSource(cliRelativePath) {
  const normalizedCliRelativePath = cliRelativePath.replaceAll("\\", "/");
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "\${SCRIPT_DIR}/node.exe" "\${SCRIPT_DIR}/${normalizedCliRelativePath}" "$@"
`;
}

function buildWindowsCmdCliLauncherSource(cliRelativePath) {
  const normalizedCliRelativePath = cliRelativePath.replaceAll("/", "\\");
  return `@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
"%SCRIPT_DIR%node.exe" "%SCRIPT_DIR%${normalizedCliRelativePath}" %*
`;
}

function stageWindowsNodeCommandLaunchers(outputRoot) {
  const nodeBinDir = path.join(outputRoot, "node-runtime", "bin");
  const bundledNodeExe = path.join(outputRoot, "node-runtime", "node_modules", "node", "bin", "node.exe");
  if (!existsSync(bundledNodeExe)) {
    return;
  }

  mkdirSync(nodeBinDir, { recursive: true });
  cpSync(bundledNodeExe, path.join(nodeBinDir, "node.exe"));
  writeFileSync(path.join(nodeBinDir, "node"), buildWindowsPosixNodeLauncherSource());
  writeFileSync(
    path.join(nodeBinDir, "npm"),
    buildWindowsPosixCliLauncherSource("../node_modules/npm/bin/npm-cli.js"),
  );
  writeFileSync(
    path.join(nodeBinDir, "npx"),
    buildWindowsPosixCliLauncherSource("../node_modules/npm/bin/npx-cli.js"),
  );
  writeFileSync(
    path.join(nodeBinDir, "npm.cmd"),
    buildWindowsCmdCliLauncherSource("..\\node_modules\\npm\\bin\\npm-cli.js"),
  );
  writeFileSync(
    path.join(nodeBinDir, "npx.cmd"),
    buildWindowsCmdCliLauncherSource("..\\node_modules\\npm\\bin\\npx-cli.js"),
  );
}

export async function packageWindowsRuntime(
  outputRootArg = path.join(repoRoot, "out", "runtime-windows")
) {
  assertWindowsHost();

  const outputRoot = path.resolve(outputRootArg);
  const stagingRoot = mkdtempSync(path.join(os.tmpdir(), "holaboss-runtime-windows."));
  const buildNodeRuntimeDir = path.join(stagingRoot, "build-node-runtime");
  const buildNodeExe = path.join(buildNodeRuntimeDir, "node_modules", "node", "bin", "node.exe");
  const buildNpmCli = path.join(buildNodeRuntimeDir, "node_modules", "npm", "bin", "npm-cli.js");
  const buildPathEntries = [
    path.join(buildNodeRuntimeDir, "node_modules", "node", "bin"),
    path.join(buildNodeRuntimeDir, "node_modules", ".bin"),
    process.env.PATH ?? ""
  ].filter((value) => value.length > 0);
  const runtimeStagingRoot = path.join(stagingRoot, "runtime-root");
  const runtimeOutputRoot = path.join(outputRoot, "runtime");
  const nodeRuntimeDir = path.join(outputRoot, "node-runtime");
  const binDir = path.join(outputRoot, "bin");
  const packageMetadataPath = path.join(outputRoot, "package-metadata.json");
  const skipNodeDeps = process.env.HOLABOSS_SKIP_NODE_DEPS?.trim() === "1";
  const nodeVersion = resolveNodeVersion();
  const npmVersion = resolveNpmVersion();

  try {
    if (!skipNodeDeps) {
      mkdirSync(buildNodeRuntimeDir, { recursive: true });
      runNpm(["install", "--prefix", buildNodeRuntimeDir, `node@${nodeVersion}`, `npm@${npmVersion}`], {
        stdio: "inherit",
        env: process.env
      });
      runCommand(buildNodeExe, [path.join(scriptDir, "build_runtime_root.mjs"), runtimeStagingRoot], {
        env: {
          ...process.env,
          HOLABOSS_RUNTIME_BUILD_NPM_CLI: buildNpmCli,
          PATH: buildPathEntries.join(path.delimiter),
        }
      });
    } else {
      buildRuntimeRoot(runtimeStagingRoot);
    }

    rmSync(outputRoot, { recursive: true, force: true });
    mkdirSync(outputRoot, { recursive: true });
    cpSync(runtimeStagingRoot, runtimeOutputRoot, { recursive: true, dereference: true });
    prunePackagedTree(runtimeOutputRoot, "windows");

    mkdirSync(binDir, { recursive: true });
    if (!skipNodeDeps) {
      cpSync(buildNodeRuntimeDir, nodeRuntimeDir, { recursive: true, dereference: true });
      stageWindowsNodeCommandLaunchers(outputRoot);
      prunePackagedTree(nodeRuntimeDir, "windows");
    }

    const pythonStageResult = await stagePythonRuntime(outputRoot, "windows");
    const toolchainId = sanitizeToolchainId(
      `windows-node${nodeVersion}-npm${npmVersion}-python${pythonStageResult.bundledPythonVersion}-${pythonStageResult.bundledPythonTarget}`,
    );

    writeFileSync(path.join(binDir, "sandbox-runtime.mjs"), buildWindowsRuntimeLauncherSource());
    writeFileSync(path.join(binDir, "sandbox-runtime.cmd"), buildWindowsRuntimeCmdLauncherSource());

    const bundledNodeBin = firstExistingPath(bundledNodeCandidates(outputRoot));
    const bundledNpmBin = firstExistingPath(bundledNpmCandidates(outputRoot));
    const bundledPythonBin =
      pythonStageResult.bundledPythonBin || firstExistingPath(bundledPythonCandidates(outputRoot));
    const packageMetadata = {
      platform: "windows",
      toolchain_id: toolchainId,
      node_deps_installed: !skipNodeDeps,
      bundled_node_bin: Boolean(bundledNodeBin),
      bundled_node_version: skipNodeDeps ? null : nodeVersion,
      bundled_npm_bin: Boolean(bundledNpmBin),
      bundled_npm_version: skipNodeDeps ? null : npmVersion,
      bundled_python_bin: Boolean(bundledPythonBin),
      bundled_python_version: pythonStageResult.bundledPythonVersion,
      bundled_python_target: pythonStageResult.bundledPythonTarget
    };
    writeFileSync(packageMetadataPath, `${JSON.stringify(packageMetadata, null, 2)}\n`);

    console.error(`packaged Windows runtime bundle at ${outputRoot}`);
    return outputRoot;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function isDirectRun() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  await packageWindowsRuntime(process.argv[2]);
}
