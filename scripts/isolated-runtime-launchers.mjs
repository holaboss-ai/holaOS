import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  firstAccessiblePath,
  resolveRuntimeBundleState,
  runtimeBundleExists,
  runtimeBundleIsStale,
} from "../apps/desktop/scripts/runtime-bundle-state.mjs";
import { runtimeBundleExecutableRelativePaths } from "../apps/desktop/scripts/runtime-bundle.mjs";
import { runNpm } from "../apps/desktop/scripts/npm-runner.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(scriptDir, "..");
export const desktopRoot = path.join(repoRoot, "apps", "desktop");

const desktopPackageRequire = createRequire(path.join(desktopRoot, "package.json"));

const DESKTOP_RUNTIME_PORT_RANGE_START = 39160;
const DESKTOP_RUNTIME_PORT_RANGE_SIZE = 2000;
const STANDALONE_RUNTIME_PORT_RANGE_START = 42160;
const STANDALONE_RUNTIME_PORT_RANGE_SIZE = 2000;
const DEFAULT_DEV_SERVER_URL = "http://localhost:5173";
const MULTI_RUNTIME_HOME_ENV = "HOLABOSS_MULTI_RUNTIME_HOME";

function usageError(message) {
  const error = new Error(message);
  error.name = "UsageError";
  return error;
}

function parsePort(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }
  if (!/^\d+$/.test(normalized)) {
    throw usageError(`${fieldName} must be a numeric TCP port.`);
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw usageError(`${fieldName} must be between 1024 and 65535.`);
  }
  if (parsed === 5060) {
    throw usageError(`${fieldName} cannot be 5060 because Node fetch treats it as a blocked port.`);
  }
  return parsed;
}

function optionValue(argv, index, arg) {
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex >= 0) {
    return {
      nextIndex: index,
      value: arg.slice(equalsIndex + 1),
    };
  }
  if (index + 1 >= argv.length) {
    throw usageError(`Missing value for ${arg}.`);
  }
  return {
    nextIndex: index + 1,
    value: argv[index + 1],
  };
}

export function sanitizeInstanceName(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  if (!normalized) {
    throw usageError("Instance name must contain at least one letter or number.");
  }
  return normalized;
}

export function multiRuntimeHomeRoot() {
  const explicitRoot = (process.env[MULTI_RUNTIME_HOME_ENV] ?? "").trim();
  return path.resolve(explicitRoot || path.join(os.homedir(), ".holaos"));
}

export function resolveDesktopUserDataPath(instanceName, homeRoot = multiRuntimeHomeRoot()) {
  return path.join(homeRoot, "desktop", sanitizeInstanceName(instanceName));
}

export function resolveStandaloneSandboxRoot(
  instanceName,
  namespace = "runtime",
  homeRoot = multiRuntimeHomeRoot(),
) {
  return path.join(
    homeRoot,
    sanitizeInstanceName(namespace),
    sanitizeInstanceName(instanceName),
  );
}

export function stablePortForPath(targetPath, { start, size }) {
  const hash = Number.parseInt(
    createHash("sha256")
      .update(path.resolve(targetPath), "utf8")
      .digest("hex")
      .slice(0, 8),
    16,
  );
  return start + (hash % size);
}

export function desktopRuntimeApiPortForUserDataPath(userDataPath) {
  return stablePortForPath(userDataPath, {
    start: DESKTOP_RUNTIME_PORT_RANGE_START,
    size: DESKTOP_RUNTIME_PORT_RANGE_SIZE,
  });
}

export function standaloneRuntimeApiPortForSandboxRoot(sandboxRoot) {
  return stablePortForPath(sandboxRoot, {
    start: STANDALONE_RUNTIME_PORT_RANGE_START,
    size: STANDALONE_RUNTIME_PORT_RANGE_SIZE,
  });
}

export function parseLauncherArgs(argv) {
  const parsed = {
    defaultName: "",
    devServerUrl: "",
    help: false,
    name: "",
    namespace: "",
    port: null,
    prepare: true,
    sandboxRoot: "",
    userDataPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      const remaining = argv.slice(index + 1);
      if (remaining.length > 1) {
        throw usageError(`Unexpected extra arguments: ${remaining.slice(1).join(", ")}`);
      }
      if (remaining.length === 1) {
        parsed.name = remaining[0];
      }
      break;
    }

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--no-prepare") {
      parsed.prepare = false;
      continue;
    }

    if (arg === "--name" || arg.startsWith("--name=")) {
      const { nextIndex, value } = optionValue(argv, index, arg);
      parsed.name = value;
      index = nextIndex;
      continue;
    }

    if (arg === "--default-name" || arg.startsWith("--default-name=")) {
      const { nextIndex, value } = optionValue(argv, index, arg);
      parsed.defaultName = value;
      index = nextIndex;
      continue;
    }

    if (arg === "--dev-server-url" || arg.startsWith("--dev-server-url=")) {
      const { nextIndex, value } = optionValue(argv, index, arg);
      parsed.devServerUrl = value;
      index = nextIndex;
      continue;
    }

    if (arg === "--user-data-path" || arg.startsWith("--user-data-path=")) {
      const { nextIndex, value } = optionValue(argv, index, arg);
      parsed.userDataPath = value;
      index = nextIndex;
      continue;
    }

    if (arg === "--sandbox-root" || arg.startsWith("--sandbox-root=")) {
      const { nextIndex, value } = optionValue(argv, index, arg);
      parsed.sandboxRoot = value;
      index = nextIndex;
      continue;
    }

    if (arg === "--namespace" || arg.startsWith("--namespace=")) {
      const { nextIndex, value } = optionValue(argv, index, arg);
      parsed.namespace = value;
      index = nextIndex;
      continue;
    }

    if (arg === "--port" || arg.startsWith("--port=")) {
      const { nextIndex, value } = optionValue(argv, index, arg);
      parsed.port = parsePort(value, "--port");
      index = nextIndex;
      continue;
    }

    if (arg.startsWith("-")) {
      throw usageError(`Unknown option ${arg}.`);
    }

    if (parsed.name) {
      throw usageError(`Unexpected extra argument ${arg}.`);
    }
    parsed.name = arg;
  }

  return parsed;
}

function resolvedInstanceName(name, defaultName) {
  const candidate = String(name || defaultName || "isolated").trim();
  return sanitizeInstanceName(candidate);
}

async function ensureUrlReachable(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      `Dev server is not reachable at ${url}. Start \`bun run desktop:dev\` first, then rerun this command.`,
      { cause: error },
    );
  }
}

function ensureDesktopElectronEntrypoint() {
  const entryPoint = path.join(desktopRoot, "out", "dist-electron", "main.cjs");
  if (!fs.existsSync(entryPoint)) {
    console.log("[desktop:dev:isolated] electron main bundle is missing; building it once.");
    runNpm(["run", "build:electron"], {
      cwd: desktopRoot,
      env: { ...process.env },
      stdio: "inherit",
    });
  }
  if (!fs.existsSync(entryPoint)) {
    throw new Error(`Electron entrypoint is still missing at ${entryPoint}.`);
  }
  return entryPoint;
}

export async function ensureDesktopRuntimeBundle({ autoPrepare = true } = {}) {
  const bundleState = resolveRuntimeBundleState(desktopRoot);
  const bundleExists = await runtimeBundleExists(bundleState.requiredRuntimePathGroups);
  const bundleStale =
    bundleState.canPrepareLocalRuntime && bundleExists
      ? await runtimeBundleIsStale(bundleState)
      : false;

  if (!bundleExists || bundleStale) {
    if (!autoPrepare) {
      throw new Error(
        bundleStale
          ? "Runtime bundle is stale. Run `bun run desktop:prepare-runtime:local` first."
          : "Runtime bundle is missing. Run `bun run desktop:prepare-runtime:local` first.",
      );
    }

    if (bundleStale && bundleExists) {
      console.log("[runtime:start] runtime bundle is stale; rebuilding it from local sources.");
    } else {
      console.log("[runtime:start] runtime bundle is missing; preparing it now.");
    }

    const prepareScript = bundleState.canPrepareLocalRuntime
      ? "prepare:runtime:local"
      : "prepare:runtime";
    runNpm(["run", prepareScript], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        HOLABOSS_RUNTIME_PLATFORM: bundleState.runtimePlatform,
      },
      stdio: "inherit",
    });
  }

  return bundleState;
}

export async function resolveRuntimeLauncherPath({ autoPrepare = true } = {}) {
  const bundleState = await ensureDesktopRuntimeBundle({ autoPrepare });
  const candidates = runtimeBundleExecutableRelativePaths(bundleState.runtimePlatform).map(
    (relativePath) => path.join(bundleState.runtimeRoot, relativePath),
  );
  const launcherPath = await firstAccessiblePath(candidates);
  if (!launcherPath) {
    throw new Error(`Runtime launcher not found under ${bundleState.runtimeRoot}.`);
  }
  return {
    bundleState,
    launcherPath,
  };
}

function electronBinaryPath() {
  const electronBinary = desktopPackageRequire("electron");
  if (typeof electronBinary !== "string" || !fs.existsSync(electronBinary)) {
    throw new Error("Electron binary could not be resolved from apps/desktop dependencies.");
  }
  return electronBinary;
}

function spawnUsesShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

export async function spawnAndForward({ command, args, cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env,
    shell: spawnUsesShell(command),
    stdio: "inherit",
  });

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export async function launchIsolatedDesktop(options = {}) {
  const instanceName = resolvedInstanceName(options.name, options.defaultName);
  const userDataPath = path.resolve(
    options.userDataPath || resolveDesktopUserDataPath(instanceName),
  );
  const devServerUrl = String(
    options.devServerUrl || process.env.VITE_DEV_SERVER_URL || DEFAULT_DEV_SERVER_URL,
  ).trim();

  if (!devServerUrl) {
    throw usageError("A dev server URL is required.");
  }

  fs.mkdirSync(userDataPath, { recursive: true });
  await ensureUrlReachable(devServerUrl);
  ensureDesktopElectronEntrypoint();
  await ensureDesktopRuntimeBundle({ autoPrepare: options.prepare !== false });

  const runtimePort = desktopRuntimeApiPortForUserDataPath(userDataPath);
  const entryPoint = path.join(desktopRoot, "out", "dist-electron", "main.cjs");
  const electronPath = electronBinaryPath();

  console.log(`[desktop:dev:isolated] instance: ${instanceName}`);
  console.log(`[desktop:dev:isolated] user data: ${userDataPath}`);
  console.log(`[desktop:dev:isolated] dev server: ${devServerUrl}`);
  console.log(`[desktop:dev:isolated] embedded runtime: http://127.0.0.1:${runtimePort}`);

  return spawnAndForward({
    command: electronPath,
    args: [entryPoint],
    cwd: desktopRoot,
    env: {
      ...process.env,
      HOLABOSS_DESKTOP_USER_DATA_PATH: userDataPath,
      HOLABOSS_DISABLE_SINGLE_INSTANCE_LOCK: "1",
      HOLABOSS_RUNTIME_API_PORT: "",
      SANDBOX_RUNTIME_API_PORT: "",
      VITE_DEV_SERVER_URL: devServerUrl,
    },
  });
}

export async function launchStandaloneRuntime(options = {}) {
  const instanceName = resolvedInstanceName(options.name, options.defaultName);
  const sandboxRoot = path.resolve(
    options.sandboxRoot ||
      resolveStandaloneSandboxRoot(instanceName, options.namespace || "runtime"),
  );
  const port =
    options.port ??
    parsePort(process.env.SANDBOX_AGENT_BIND_PORT, "SANDBOX_AGENT_BIND_PORT") ??
    standaloneRuntimeApiPortForSandboxRoot(sandboxRoot);

  fs.mkdirSync(sandboxRoot, { recursive: true });

  const { bundleState, launcherPath } = await resolveRuntimeLauncherPath({
    autoPrepare: options.prepare !== false,
  });

  console.log(`[runtime:start] instance: ${instanceName}`);
  console.log(`[runtime:start] sandbox root: ${sandboxRoot}`);
  console.log(`[runtime:start] runtime bundle: ${bundleState.runtimeRoot}`);
  console.log(`[runtime:start] runtime api: http://127.0.0.1:${port}`);

  return spawnAndForward({
    command: launcherPath,
    args: [],
    cwd: bundleState.runtimeRoot,
    env: {
      ...process.env,
      HB_SANDBOX_ROOT: sandboxRoot,
      HOLABOSS_CONTROL_PLANE_DB_PATH: path.join(sandboxRoot, "state", "control-plane.db"),
      HOLABOSS_HOST_STATE_DB_PATH: path.join(sandboxRoot, "state", "host-state.db"),
      HOLABOSS_RUNTIME_CONFIG_PATH: path.join(sandboxRoot, "state", "runtime-config.json"),
      HOLABOSS_RUNTIME_DB_PATH: path.join(sandboxRoot, "state", "host-state.db"),
      SANDBOX_AGENT_BIND_HOST: "127.0.0.1",
      SANDBOX_AGENT_BIND_PORT: String(port),
      SANDBOX_RUNTIME_API_PORT: String(port),
      SANDBOX_AGENT_HARNESS: (process.env.SANDBOX_AGENT_HARNESS ?? "").trim() || "pi",
    },
  });
}
