#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function logRuntimeMessage(message) {
  process.stderr.write(`[sandbox-entrypoint] ${new Date().toISOString()} ${message}\n`);
}

function resolveBundleRoot(explicitBundleRoot) {
  if (explicitBundleRoot?.trim()) {
    return path.resolve(explicitBundleRoot);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "..", "..");
}

function resolveToolchainRoot(bundleRoot) {
  const explicitToolchainRoot =
    process.env.HOLABOSS_RUNTIME_TOOLCHAIN_ROOT?.trim();
  if (explicitToolchainRoot) {
    return path.resolve(explicitToolchainRoot);
  }
  return bundleRoot;
}

function resolveSandboxRoot() {
  const configuredRoot = (process.env.HB_SANDBOX_ROOT ?? "").trim().replace(/[\\/]+$/, "");
  if (configuredRoot) {
    return configuredRoot;
  }
  return path.join(process.env.LOCALAPPDATA?.trim() || os.tmpdir(), "holaboss");
}

function firstExistingPath(paths) {
  for (const candidatePath of paths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

function runtimeNodeCandidates(bundleRoot) {
  return [
    path.join(bundleRoot, "node-runtime", "bin", "node.exe"),
    path.join(bundleRoot, "node-runtime", "node_modules", ".bin", "node.exe"),
    path.join(bundleRoot, "node-runtime", "node_modules", "node", "bin", "node.exe")
  ];
}

function runtimePythonPathEntries(toolchainRoot) {
  return [
    path.join(toolchainRoot, "python-runtime", "python"),
    path.join(toolchainRoot, "python-runtime", "python", "Scripts"),
    path.join(toolchainRoot, "python-runtime", "bin"),
  ];
}

function runtimeApiEntryCandidates(runtimeAppRoot) {
  return [
    path.join(runtimeAppRoot, "api-server", "dist", "index.mjs"),
    path.join(runtimeAppRoot, "..", "api-server", "dist", "index.mjs")
  ];
}

function isPathLikeCommand(command) {
  return path.isAbsolute(command) || command.includes(path.sep) || command.includes("/");
}

export async function startWindowsRuntime(args = process.argv.slice(2), options = {}) {
  const bundleRoot = resolveBundleRoot(options.bundleRoot);
  const toolchainRoot = resolveToolchainRoot(bundleRoot);
  const sandboxRoot = resolveSandboxRoot();
  const workspaceRoot = path.join(sandboxRoot, "workspace");
  const memoryRoot = process.env.MEMORY_ROOT_DIR?.trim() || path.join(sandboxRoot, "memory");
  const stateRoot = process.env.STATE_ROOT_DIR?.trim() || path.join(sandboxRoot, "state");
  const runtimeAppRoot =
    process.env.HOLABOSS_RUNTIME_APP_ROOT?.trim() || path.join(bundleRoot, "runtime");
  const runtimeNodeBin =
    process.env.HOLABOSS_RUNTIME_NODE_BIN?.trim() ||
    firstExistingPath(runtimeNodeCandidates(toolchainRoot)) ||
    process.execPath;
  const runtimeApiEntry = firstExistingPath(runtimeApiEntryCandidates(runtimeAppRoot));
  const pathEntries = [
    ...runtimePythonPathEntries(toolchainRoot),
    path.join(toolchainRoot, "node-runtime", "bin"),
    path.join(toolchainRoot, "node-runtime", "node_modules", ".bin"),
    process.env.PATH ?? ""
  ].filter((value) => value.length > 0);

  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(memoryRoot, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(runtimeAppRoot, { recursive: true });

  process.env.HB_SANDBOX_ROOT = sandboxRoot;
  process.env.HOLABOSS_RUNTIME_APP_ROOT = runtimeAppRoot;
  process.env.HOLABOSS_RUNTIME_ROOT =
    process.env.HOLABOSS_RUNTIME_ROOT?.trim() || runtimeAppRoot;
  process.env.HOLABOSS_RUNTIME_TOOLCHAIN_ROOT = toolchainRoot;
  process.env.HOLABOSS_RUNTIME_NODE_BIN = runtimeNodeBin;
  process.env.HOLABOSS_USER_ID = process.env.SANDBOX_HOLABOSS_USER_ID?.trim() || "";
  process.env.MEMORY_ROOT_DIR = memoryRoot;
  process.env.STATE_ROOT_DIR = stateRoot;
  process.env.PATH = pathEntries.join(path.delimiter);
  process.env.SANDBOX_RUNTIME_API_HOST =
    process.env.SANDBOX_RUNTIME_API_HOST?.trim() ||
    process.env.SANDBOX_AGENT_BIND_HOST?.trim() ||
    "0.0.0.0";
  process.env.SANDBOX_RUNTIME_API_PORT =
    process.env.SANDBOX_RUNTIME_API_PORT?.trim() ||
    process.env.SANDBOX_AGENT_BIND_PORT?.trim() ||
    "8080";
  process.env.HOLABOSS_MODEL_PROXY_BASE_URL_DEFAULT =
    process.env.HOLABOSS_MODEL_PROXY_BASE_URL_DEFAULT?.trim() ||
    "http://127.0.0.1:3060/api/v1/model-proxy";

  if (isPathLikeCommand(runtimeNodeBin) && !existsSync(runtimeNodeBin)) {
    throw new Error(`runtime node binary not found: ${runtimeNodeBin}`);
  }
  if (!runtimeApiEntry) {
    throw new Error(
      `runtime api entrypoint not found under HOLABOSS_RUNTIME_APP_ROOT=${runtimeAppRoot}`
    );
  }

  process.chdir(workspaceRoot);
  logRuntimeMessage(`using workspace root cwd=${workspaceRoot}`);
  logRuntimeMessage(
    `starting sandbox runtime TS API on ${process.env.SANDBOX_RUNTIME_API_HOST}:${process.env.SANDBOX_RUNTIME_API_PORT}`
  );

  const child = spawn(runtimeNodeBin, [runtimeApiEntry, ...args], {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
    windowsHide: true
  });

  const forwardSignal = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // Ignore shutdown races while the runtime is exiting.
    }
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
    process.on(signal, () => forwardSignal(signal));
  }

  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

function isDirectRun() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  try {
    const exitCode = await startWindowsRuntime();
    process.exit(typeof exitCode === "number" ? exitCode : 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logRuntimeMessage(message);
    process.exit(1);
  }
}
