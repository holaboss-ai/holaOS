import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { type RuntimeStateStore } from "@holaboss/runtime-state-store";

import { resolveIntegrationRuntime } from "./integration-runtime.js";
import type { ResolvedApplicationRuntime, WorkspaceComposeShutdownTarget } from "./workspace-apps.js";
import { buildAppSetupEnv } from "./app-setup-env.js";
import {
  buildPortListenerKillCommand,
  killChildProcess,
  spawnShellCommand,
} from "./runtime-shell.js";
import {
  ensureWorkspaceDataDb,
  workspaceDataDbPath,
  workspaceDirForId,
} from "./ts-runner-session-state.js";
import { parseDataSchema, DataSchemaError } from "./data-schema.js";
import { applyAppSchema, ApplySchemaError } from "./apply-app-schema.js";

export interface AppLifecycleActionResult {
  app_id: string;
  status: string;
  detail: string;
  ports: Record<string, number>;
}

export interface LifecycleShutdownResult {
  stopped: string[];
  failed: string[];
}

export interface LifecycleShutdownParams {
  targets?: WorkspaceComposeShutdownTarget[];
}

export interface AppLifecycleStartParams {
  appId: string;
  appDir?: string;
  httpPort?: number;
  mcpPort?: number;
  holabossUserId?: string;
  workspaceId?: string;
  resolvedApp?: ResolvedApplicationRuntime;
  skipSetup?: boolean;
  spawnImpl?: SpawnLike;
  fetchImpl?: typeof fetch;
}

export interface RuntimeAppLifecycleExecutorOptions {
  store?: RuntimeStateStore | null;
  runtimeApiUrl?: string | null;
}

export interface AppLifecycleExecutorLike {
  startApp(params: AppLifecycleStartParams): Promise<AppLifecycleActionResult>;
  stopApp(params: {
    appId: string;
    appDir?: string;
    workspaceId?: string;
    resolvedApp?: ResolvedApplicationRuntime;
  }): Promise<AppLifecycleActionResult>;
  shutdownAll(params?: LifecycleShutdownParams): Promise<LifecycleShutdownResult>;
  /**
   * Returns true when this executor currently has an in-process child
   * tracked for the given workspace+app. Used by callers that need to
   * distinguish "the port is responding because WE are running the app"
   * from "the port is responding because something else is on it"
   * (orphan from a crashed runtime, port collision, etc).
   *
   * Optional so test doubles can omit it. Callers should treat a
   * missing implementation as "tracking is unknown" (i.e. trust health).
   */
  isTrackingApp?(params: { workspaceId?: string; appId: string }): boolean;
  /**
   * Registers the allocated ports for a healthy shell-managed app that
   * the current runtime did not spawn itself (for example after a
   * desktop runtime relaunch). This lets later stop/restart paths fall
   * back to killing the known listeners by port.
   */
  rememberAppPorts?(params: {
    workspaceId?: string;
    appId: string;
    httpPort: number;
    mcpPort: number;
  }): void;
}

/** Returns true if the in-memory shell-lifecycle map currently tracks a
 *  child process for the given workspace+app. Lives at module scope so
 *  the runtime can reach it without instantiating an executor. */
export function isShellLifecycleAppTracked(workspaceId: string | undefined, appId: string): boolean {
  const proc = shellLifecycleProcesses.get(lifecycleMapKey(workspaceId, appId));
  if (!proc) {
    return false;
  }
  // A tracked entry whose exitCode is set means the child died but no
  // one cleaned the map. Treat as untracked.
  if (typeof proc.exitCode === "number") {
    shellLifecycleProcesses.delete(lifecycleMapKey(workspaceId, appId));
    return false;
  }
  return true;
}

export function rememberShellLifecycleAppPorts(params: {
  workspaceId?: string;
  appId: string;
  httpPort: number;
  mcpPort: number;
}): void {
  shellLifecyclePorts.set(lifecycleMapKey(params.workspaceId, params.appId), {
    http: params.httpPort,
    mcp: params.mcpPort,
  });
}

export class AppLifecycleExecutorError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

type SpawnLike = typeof spawn;
type ChildLike = ReturnType<SpawnLike>;

type ShellLifecyclePorts = { http: number; mcp: number };

const shellLifecycleProcesses = new Map<string, ChildLike>();
const shellLifecyclePorts = new Map<string, ShellLifecyclePorts>();
const appStartOperations = new Map<string, Promise<AppLifecycleActionResult>>();

/** Build a composite key for the in-memory process/port maps so that
 *  multiple workspaces running the same appId don't collide. */
function lifecycleMapKey(workspaceId: string | undefined, appId: string): string {
  return workspaceId ? `${workspaceId}:${appId}` : appId;
}

export function appBuildHasCompletedSetup(status: string | null | undefined): boolean {
  const normalized = (status ?? "").trim().toLowerCase();
  return normalized === "completed" || normalized === "running" || normalized === "stopped";
}

function appStartKey(params: {
  appId: string;
  appDir?: string;
  httpPort?: number;
  mcpPort?: number;
}): string {
  if (params.appDir && params.appDir.trim()) {
    return params.appDir;
  }
  return `${params.appId}:${params.httpPort ?? "http"}:${params.mcpPort ?? "mcp"}`;
}

async function withAppStartOperation(
  params: {
    appId: string;
    appDir?: string;
    httpPort?: number;
    mcpPort?: number;
  },
  operation: () => Promise<AppLifecycleActionResult>
): Promise<AppLifecycleActionResult> {
  const key = appStartKey(params);
  const inFlight = appStartOperations.get(key);
  if (inFlight) {
    return await inFlight;
  }
  const promise = (async () => await operation())();
  appStartOperations.set(key, promise);
  try {
    return await promise;
  } finally {
    if (appStartOperations.get(key) === promise) {
      appStartOperations.delete(key);
    }
  }
}

async function waitForExit(child: ChildLike, options: { captureStderr?: boolean } = {}): Promise<{ code: number; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let stderr = "";
    if (options.captureStderr && child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stderr: stderr.trim() });
    });
  });
}

function patchComposePorts(
  composePath: string,
  params: {
    containerHttpPort: number;
    hostHttpPort: number;
    containerMcpPort: number;
    hostMcpPort: number;
  }
): void {
  const original = fs.readFileSync(composePath, "utf8");
  let next = original.replace(
    new RegExp(`(- (?:["']?))\\d+:${params.containerHttpPort}\\b`, "g"),
    `$1${params.hostHttpPort}:${params.containerHttpPort}`
  );
  next = next.replace(
    new RegExp(`(- (?:["']?))\\d+:${params.containerMcpPort}\\b`, "g"),
    `$1${params.hostMcpPort}:${params.containerMcpPort}`
  );
  if (next !== original) {
    fs.writeFileSync(composePath, next, "utf8");
  }
}

function composeFilePath(appDir: string): string | null {
  for (const candidate of ["docker-compose.yml", "docker-compose.yaml"]) {
    const fullPath = `${appDir}/${candidate}`;
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return null;
}

function hasNativeComposeLifecycle(params: {
  appDir?: string;
  resolvedApp?: ResolvedApplicationRuntime;
}): params is { appDir: string; resolvedApp: ResolvedApplicationRuntime } {
  if (!params.appDir || !params.resolvedApp) {
    return false;
  }
  if (params.resolvedApp.lifecycle.start || params.resolvedApp.lifecycle.stop || params.resolvedApp.startCommand) {
    return false;
  }
  return composeFilePath(params.appDir) !== null;
}

function hasNativeShellLifecycle(params: {
  appDir?: string;
  resolvedApp?: ResolvedApplicationRuntime;
}): params is { appDir: string; resolvedApp: ResolvedApplicationRuntime } {
  if (!params.appDir || !params.resolvedApp) {
    return false;
  }
  if (params.resolvedApp.startCommand) {
    return false;
  }
  if (!params.resolvedApp.lifecycle.start && !params.resolvedApp.lifecycle.stop) {
    return false;
  }
  return true;
}

function hasNativeStartCommandLifecycle(params: {
  appDir?: string;
  resolvedApp?: ResolvedApplicationRuntime;
}): params is { appDir: string; resolvedApp: ResolvedApplicationRuntime } {
  if (!params.appDir || !params.resolvedApp) {
    return false;
  }
  if (params.resolvedApp.lifecycle.start || params.resolvedApp.lifecycle.stop) {
    return false;
  }
  return Boolean(params.resolvedApp.startCommand.trim());
}

// Bounded captures so a runaway lifecycle command can't OOM the runtime
// just by logging gigabytes to stderr. ~1 MiB each is plenty for setup
// failure diagnostics; everything beyond is dropped on the floor.
const MAX_RUN_SPAWN_CAPTURE_BYTES = 1024 * 1024;

async function runSpawn(
  spawnImpl: SpawnLike,
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    captureStdout?: boolean;
    captureStderr?: boolean;
    shell?: boolean;
  } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stdoutDropped = false;
    let stderr = "";
    let stderrDropped = false;
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
      stdio: ["ignore", options.captureStdout ? "pipe" : "ignore", options.captureStderr ? "pipe" : "ignore"]
    });
    if (options.captureStdout && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (stdout.length >= MAX_RUN_SPAWN_CAPTURE_BYTES) {
          stdoutDropped = true;
          return;
        }
        stdout += chunk;
        if (stdout.length > MAX_RUN_SPAWN_CAPTURE_BYTES) {
          stdout = stdout.slice(0, MAX_RUN_SPAWN_CAPTURE_BYTES);
          stdoutDropped = true;
        }
      });
    }
    if (options.captureStderr && child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length >= MAX_RUN_SPAWN_CAPTURE_BYTES) {
          stderrDropped = true;
          return;
        }
        stderr += chunk;
        if (stderr.length > MAX_RUN_SPAWN_CAPTURE_BYTES) {
          stderr = stderr.slice(0, MAX_RUN_SPAWN_CAPTURE_BYTES);
          stderrDropped = true;
        }
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (stdoutDropped) stdout += "\n[truncated]";
      if (stderrDropped) stderr += "\n[truncated]";
      resolve({ code: code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function buildShellLifecycleEnv(
  params: {
    appDir?: string;
    httpPort?: number;
    mcpPort?: number;
    holabossUserId?: string;
    workspaceId?: string;
    resolvedApp?: ResolvedApplicationRuntime;
    integrationEnv?: NodeJS.ProcessEnv;
  }
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = params.appDir ? buildAppSetupEnv(params.appDir) : { ...process.env };
  if (params.integrationEnv) {
    Object.assign(env, params.integrationEnv);
  }
  if (params.httpPort !== undefined) {
    env.PORT = String(params.httpPort);
  }
  if (params.mcpPort !== undefined) {
    env.MCP_PORT = String(params.mcpPort);
  }
  if (
    params.holabossUserId &&
    params.resolvedApp &&
    params.resolvedApp.envContract.includes("HOLABOSS_USER_ID")
  ) {
    env.HOLABOSS_USER_ID = params.holabossUserId;
  }
  if (
    params.workspaceId &&
    params.resolvedApp &&
    params.resolvedApp.envContract.includes("HOLABOSS_WORKSPACE_ID") &&
    !env.HOLABOSS_WORKSPACE_ID
  ) {
    env.HOLABOSS_WORKSPACE_ID = params.workspaceId;
  }
  if (
    params.workspaceId &&
    params.resolvedApp &&
    params.resolvedApp.envContract.includes("WORKSPACE_DB_PATH") &&
    !env.WORKSPACE_DB_PATH
  ) {
    try {
      // ensureWorkspaceDataDb() materializes the file with WAL + the
      // _workspace_meta anchor row before the app process spawns. This
      // closes the race where workspace-level data tools ran before
      // any app had called getDb() and saw a missing file even though
      // the app was about to write.
      const dataDbPath = ensureWorkspaceDataDb(workspaceDirForId(params.workspaceId));
      env.WORKSPACE_DB_PATH = dataDbPath;
      maybeApplyAppSchema(params.resolvedApp, dataDbPath);
    } catch {
      // sanitizeWorkspaceId throws on invalid ids; the caller will surface
      // the underlying validation error elsewhere — don't crash env build.
    }
  }
  return env;
}

/** When an app declares `data_schema:` in its app.runtime.yaml, the
 *  runtime owns schema lifecycle (Tier 2). We parse + apply before
 *  spawning so the app process opens a DB whose tables already match
 *  the manifest. Apps without the block still self-manage in their
 *  db.ts (Tier 0/1) — both can coexist during rollout.
 *
 *  Errors are surfaced via console.warn rather than throwing because:
 *  (a) blocking app start on a malformed manifest punishes the rest
 *  of the workspace, (b) the underlying app.runtime.yaml is parsed
 *  here for the first time so its problems are runtime-bug-ish, not
 *  user-input, and (c) the app's existing self-managed schema is a
 *  reasonable fallback during rollout. */
function maybeApplyAppSchema(
  resolvedApp: ResolvedApplicationRuntime,
  dataDbPath: string,
): void {
  if (resolvedApp.dataSchemaRaw === undefined) return;
  try {
    const schema = parseDataSchema(resolvedApp.dataSchemaRaw, { appId: resolvedApp.appId });
    const result = applyAppSchema({ appId: resolvedApp.appId, dataDbPath, schema });
    if (result.kind !== "noop") {
      console.log(
        `[data-schema] ${resolvedApp.appId}: ${result.kind}` +
          (result.kind === "upgraded"
            ? ` v${result.from}→v${result.to} (+${result.addedTables.length} tables, +${result.addedColumns.length} columns, +${result.addedIndexes.length} indexes)`
            : ` v${"version" in result ? result.version : ""}`),
      );
    }
  } catch (err) {
    if (err instanceof DataSchemaError) {
      console.warn(
        `[data-schema] ${resolvedApp.appId}: manifest invalid (${err.message}); falling back to app-managed schema`,
      );
      return;
    }
    if (err instanceof ApplySchemaError) {
      console.warn(
        `[data-schema] ${resolvedApp.appId}: cannot apply (${err.message}); falling back to app-managed schema`,
      );
      return;
    }
    console.warn(`[data-schema] ${resolvedApp.appId}: unexpected error`, err);
  }
}

/** Resolve the persistent install-log directory for an app. Stored at
 *  `<appDir>/.holaboss/logs/` so it survives across runtime restarts
 *  and stays scoped to the app. Each setup run writes a timestamped
 *  file plus mirrors the latest into `setup.latest.log` so the UI can
 *  surface "most recent setup" without parsing filenames. */
function appInstallLogDir(appDir: string): string {
  return path.join(appDir, ".holaboss", "logs");
}

/** Best-effort accessor — returns the path to the latest setup log for
 *  an app, or null if the log directory doesn't exist yet. Used by
 *  install-archive and agent APIs to surface logs for debugging. */
export function latestSetupLogPath(appDir: string): string | null {
  const logPath = path.join(appInstallLogDir(appDir), "setup.latest.log");
  return fs.existsSync(logPath) ? logPath : null;
}

/** Writes a newline-delimited lifecycle event to `<appDir>/.holaboss/
 *  logs/events.ndjson`. Small, append-only, survives restarts, and is
 *  cheap to tail from the CLI. Schema is intentionally narrow so the
 *  reader doesn't have to deal with optional fields. */
function writeAppLifecycleEvent(
  appDir: string,
  event: Record<string, unknown>,
): void {
  try {
    const dir = appInstallLogDir(appDir);
    fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    fs.appendFileSync(path.join(dir, "events.ndjson"), line, "utf8");
  } catch {
    // Best-effort: logging must never bring down a lifecycle op.
  }
}

export interface AppSetupLogResult {
  /** Path to the per-run timestamped log file. */
  logPath: string;
  /** Path to the stable "latest" symlink-style mirror. */
  latestLogPath: string;
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
}

async function runLifecycleSetup(params: {
  appId: string;
  appDir: string;
  resolvedApp: ResolvedApplicationRuntime;
  httpPort: number;
  mcpPort: number;
  holabossUserId?: string;
  integrationEnv?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnLike;
  logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
}): Promise<AppSetupLogResult | null> {
  const setupCommand = params.resolvedApp.lifecycle.setup.trim();
  if (!setupCommand) {
    return null;
  }
  const spawnImpl = params.spawnImpl ?? spawn;
  // NOTE: we intentionally do NOT default NPM_CONFIG_IGNORE_SCRIPTS=true
  // here. Module apps (e.g. TanStack Start + better-sqlite3/esbuild/swc)
  // legitimately rely on dependency postinstall scripts to fetch native
  // binaries or build addons. Blocking them by default makes `npm run
  // build` fail on a fresh workspace create with "vite: command not
  // found" or similar. Supply-chain defense for marketplace apps is a
  // curation/allowlist problem, not a runtime env problem — enforce it
  // at the isAllowedArchiveUrl gate instead.
  const setupEnv = buildShellLifecycleEnv(params);

  // Prepare persistent log file for forensic debugging. Timestamped
  // per-run file + a stable "latest" mirror. Missing dir is created on
  // demand and written with best-effort IO (never throws upward).
  const logDir = appInstallLogDir(params.appDir);
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(logDir, `setup-${runTimestamp}.log`);
  const latestLogPath = path.join(logDir, "setup.latest.log");
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch {
    // best-effort; the write below will surface the error if dir is missing
  }

  const header = [
    `=== app lifecycle setup ===`,
    `app_id:   ${params.appId}`,
    `app_dir:  ${params.appDir}`,
    `command:  ${setupCommand}`,
    `started:  ${new Date().toISOString()}`,
    `pid:      ${process.pid}`,
    `==========================`,
    ``,
  ].join("\n");
  try {
    fs.writeFileSync(logPath, header, "utf8");
  } catch {
    // best-effort
  }

  params.logger?.info(
    { appId: params.appId, appDir: params.appDir, logPath },
    "lifecycle.setup starting",
  );
  writeAppLifecycleEvent(params.appDir, {
    event: "setup.start",
    app_id: params.appId,
    command: setupCommand,
    log_path: logPath,
  });

  const result = await runSpawn(spawnImpl, setupCommand, [], {
    cwd: params.appDir,
    env: setupEnv,
    shell: true,
    captureStdout: true,
    captureStderr: true,
  });

  const body = [
    header,
    `--- STDOUT ---`,
    result.stdout,
    ``,
    `--- STDERR ---`,
    result.stderr,
    ``,
    `--- END ---`,
    `exit_code: ${result.code}`,
    `finished:  ${new Date().toISOString()}`,
    ``,
  ].join("\n");
  try {
    fs.writeFileSync(logPath, body, "utf8");
    fs.writeFileSync(latestLogPath, body, "utf8");
  } catch {
    // best-effort
  }

  const logResult: AppSetupLogResult = {
    logPath,
    latestLogPath,
    exitCode: result.code,
    stdoutTail: result.stdout.slice(-2000),
    stderrTail: result.stderr.slice(-2000),
  };

  if (result.code !== 0) {
    params.logger?.error(
      {
        appId: params.appId,
        appDir: params.appDir,
        logPath,
        exitCode: result.code,
        stderrTail: logResult.stderrTail,
      },
      "lifecycle.setup failed",
    );
    writeAppLifecycleEvent(params.appDir, {
      event: "setup.failed",
      app_id: params.appId,
      exit_code: result.code,
      log_path: logPath,
    });
    throw Object.assign(
      new Error(
        `App '${params.appId}' lifecycle.setup failed (rc=${result.code}). See log at ${logPath}\n` +
          `--- stderr tail ---\n${logResult.stderrTail}`,
      ),
      { setupLogPath: logPath, exitCode: result.code },
    );
  }

  params.logger?.info(
    { appId: params.appId, appDir: params.appDir, logPath, stdoutBytes: result.stdout.length },
    "lifecycle.setup completed",
  );
  writeAppLifecycleEvent(params.appDir, {
    event: "setup.success",
    app_id: params.appId,
    log_path: logPath,
    stdout_bytes: result.stdout.length,
  });

  return logResult;
}

// Attach light-weight pipe consumers to a long-running child so its
// stdout/stderr buffers don't fill up and stall the process. We do not
// log these by default — they would flood the runtime log — but we keep
// the last ~64 KiB tail in memory for post-crash diagnostics. If you need
// real-time logs, run the app's lifecycle.start under your own logger.
const TRACKED_TAIL_BYTES = 64 * 1024;
const trackedProcessTails = new WeakMap<ChildLike, { stdout: string; stderr: string }>();

function attachTrackedPipeConsumers(child: ChildLike): void {
  const tails = { stdout: "", stderr: "" };
  trackedProcessTails.set(child, tails);
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      tails.stdout = (tails.stdout + chunk).slice(-TRACKED_TAIL_BYTES);
    });
    // Discard errors silently; the child is allowed to close its pipes.
    child.stdout.on("error", () => undefined);
  }
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      tails.stderr = (tails.stderr + chunk).slice(-TRACKED_TAIL_BYTES);
    });
    child.stderr.on("error", () => undefined);
  }
}

/** Best-effort accessor for the stdout/stderr tails of a tracked child.
 *  Returns null if the child was never tracked or has been GCed. */
export function getTrackedProcessTails(workspaceId: string | undefined, appId: string): { stdout: string; stderr: string } | null {
  const proc = shellLifecycleProcesses.get(lifecycleMapKey(workspaceId, appId));
  if (!proc) return null;
  return trackedProcessTails.get(proc) ?? null;
}

async function killTrackedProcess(proc: ChildLike, timeoutMs: number): Promise<void> {
  if (typeof proc.exitCode === "number") {
    return;
  }
  try {
    killChildProcess(proc);
    await Promise.race([
      waitForExit(proc),
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), timeoutMs);
      })
    ]);
  } catch {
    try {
      killChildProcess(proc, "SIGKILL");
    } catch {
      // ignore
    }
  }
}

async function killAllocatedPortListeners(mapKey: string, appDir: string, ports: ShellLifecyclePorts): Promise<void> {
  await killPortListeners([ports.http, ports.mcp], appDir);
  // Use the composite mapKey so we don't leak entries when multiple
  // workspaces share the same appId. Previously this used a bare appId
  // which silently failed to delete the map entry for any non-default
  // workspace and slowly grew shellLifecyclePorts unbounded.
  shellLifecyclePorts.delete(mapKey);
}

/** Identity check for the listener bound to `port`: ask lsof for the PID
 *  holding the LISTEN socket, then ask lsof for that PID's cwd. The runtime
 *  always spawns app lifecycle commands with cwd = appDir, so for a healthy
 *  shell-managed app the listener's cwd should equal (or live inside) the
 *  expected appDir. Mismatch means another process is serving on this port
 *  — typically an orphan from a previous install or a same-port allocation
 *  race — and we should refuse the start instead of letting the desktop
 *  render the wrong app's UI behind the right app's chrome.
 *
 *  Returns { ok: false, reason } when we can prove a mismatch; returns
 *  { ok: true } when verified or when the platform/tooling can't determine
 *  (Windows, missing lsof, root-only procfs) — degraded mode is non-fatal
 *  by design since this is a safety net, not a hard contract. */
export function verifyPortListenerCwd(params: {
  port: number;
  expectedAppDir: string;
}): { ok: true } | { ok: false; reason: string } {
  if (process.platform === "win32") {
    // No portable way to read another process's cwd on Windows from here.
    return { ok: true };
  }
  const pid = lookupListenerPid(params.port);
  if (pid === null) {
    return { ok: true };
  }
  const cwd = lookupProcessCwd(pid);
  if (cwd === null) {
    return { ok: true };
  }
  const expected = path.resolve(params.expectedAppDir);
  const observed = path.resolve(cwd);
  // Accept exact match OR observed being a subdir of expected — some apps
  // chdir into a build subfolder after spawn. The previous-app-on-same-port
  // case the check exists to catch never lives under expectedAppDir.
  const matches =
    observed === expected ||
    observed.startsWith(`${expected}${path.sep}`);
  if (matches) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `port ${params.port} listener cwd ${observed} is outside expected app dir ${expected} (pid ${pid})`,
  };
}

function lookupListenerPid(port: number): number | null {
  try {
    const result = spawnSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    );
    if (result.status !== 0 || typeof result.stdout !== "string") {
      return null;
    }
    const firstPid = result.stdout.trim().split(/\s+/)[0];
    const parsed = Number.parseInt(firstPid ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function lookupProcessCwd(pid: number): string | null {
  try {
    // -Fn emits a machine-parseable record: `p<PID>\nf<FD>\nn<CWD>\n`.
    // Each field on its own line, prefixed by a single char tag.
    const result = spawnSync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    );
    if (result.status !== 0 || typeof result.stdout !== "string") {
      return null;
    }
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("n")) {
        return line.slice(1);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Throw if either of the shell-managed listener ports is held by a process
 *  whose cwd is outside the expected appDir. Runs after waitHealthy so we
 *  know *something* responded healthy on the port; this proves the
 *  something is ours. */
function verifyShellAppListenersOrThrow(params: {
  appId: string;
  appDir: string;
  httpPort: number;
  mcpPort: number;
}): void {
  for (const port of [params.httpPort, params.mcpPort]) {
    const result = verifyPortListenerCwd({
      port,
      expectedAppDir: params.appDir,
    });
    if (!result.ok) {
      throw new Error(
        `App '${params.appId}' start aborted: ${result.reason}. Another process — likely an orphan from a previous install or a same-port allocation race — is serving on this port. Uninstall and reinstall to recover.`,
      );
    }
  }
}

/** Kill any process listening on the given ports. Exported for use as a
 *  safety net during workspace deletion and orphan cleanup. */
export async function killPortListeners(ports: number[], cwd?: string): Promise<void> {
  const killCommand = buildPortListenerKillCommand(ports);
  if (!killCommand) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawnShellCommand(spawn, killCommand, {
      cwd: cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

export async function findComposeCommand(spawnImpl: SpawnLike = spawn): Promise<string[] | null> {
  for (const cmd of [["docker", "compose"], ["docker-compose"]]) {
    try {
      const child = spawnImpl(cmd[0]!, [...cmd.slice(1), "version"], {
        stdio: ["ignore", "ignore", "ignore"]
      });
      const { code } = await waitForExit(child);
      if (code === 0) {
        return cmd;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function shutdownComposeTargets(
  targets: WorkspaceComposeShutdownTarget[],
  spawnImpl: SpawnLike = spawn
): Promise<LifecycleShutdownResult> {
  const composeCmd = await findComposeCommand(spawnImpl);
  if (!composeCmd) {
    return { stopped: [], failed: targets.map((target) => target.appId) };
  }

  const stopped: string[] = [];
  const failed: string[] = [];
  for (const target of targets) {
    try {
      const child = spawnImpl(composeCmd[0]!, [...composeCmd.slice(1), "down", "--remove-orphans"], {
        cwd: target.appDir,
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"]
      });
      const { code } = await waitForExit(child, { captureStderr: true });
      if (code === 0) {
        stopped.push(target.appId);
      } else {
        failed.push(target.appId);
      }
    } catch {
      failed.push(target.appId);
    }
  }
  return { stopped, failed };
}

async function composeImagesExist(
  composeCmd: string[],
  appDir: string,
  spawnImpl: SpawnLike,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  const images = await runSpawn(spawnImpl, composeCmd[0]!, [...composeCmd.slice(1), "images", "-q"], {
    cwd: appDir,
    env,
    captureStdout: true
  });
  const services = await runSpawn(spawnImpl, composeCmd[0]!, [...composeCmd.slice(1), "config", "--services"], {
    cwd: appDir,
    env,
    captureStdout: true
  });
  const imageCount = images.stdout ? images.stdout.split("\n").filter(Boolean).length : 0;
  const serviceCount = services.stdout ? services.stdout.split("\n").filter(Boolean).length : 0;
  return serviceCount > 0 && imageCount >= serviceCount;
}

function healthProbeUrls(params: {
  resolvedApp: ResolvedApplicationRuntime;
  httpPort: number;
  mcpPort: number;
}): Array<{ kind: "http" | "mcp"; url: string }> {
  if (params.resolvedApp.healthCheck.target === "api") {
    return [
      {
        kind: "http",
        url: `http://localhost:${params.httpPort}${params.resolvedApp.healthCheck.path}`
      }
    ];
  }
  return [
    {
      kind: "mcp",
      url: `http://localhost:${params.mcpPort}${params.resolvedApp.healthCheck.path}`
    }
  ];
}

export async function isAppHealthy(
  params: {
    resolvedApp: ResolvedApplicationRuntime;
    httpPort: number;
    mcpPort: number;
    fetchImpl?: typeof fetch;
    probeTimeoutMs?: number;
  }
): Promise<boolean> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const probes = healthProbeUrls(params);
  if (probes.length === 0) {
    return false;
  }
  // Probe timeout defaults to 3s but can be overridden — and on slow
  // hosts we let the per-probe timeout grow with the configured health
  // check interval so we don't pre-fail apps that respond in 4–8s.
  const probeTimeoutMs =
    params.probeTimeoutMs ??
    Math.max(3000, params.resolvedApp.healthCheck.intervalS * 1000);
  for (const probe of probes) {
    try {
      const response = await fetchImpl(probe.url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(probeTimeoutMs)
      });
      if (probe.kind === "http") {
        if (response.status >= 200 && response.status < 400) {
          continue;
        }
        return false;
      }
      if (probe.kind === "mcp") {
        if (response.status === 200) {
          continue;
        }
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function waitHealthy(
  params: {
    resolvedApp: ResolvedApplicationRuntime;
    httpPort: number;
    mcpPort: number;
    fetchImpl?: typeof fetch;
    timeoutSeconds?: number;
    intervalSeconds?: number;
  }
): Promise<void> {
  const timeoutMs = (params.timeoutSeconds ?? params.resolvedApp.healthCheck.timeoutS) * 1000;
  const intervalMs = (params.intervalSeconds ?? params.resolvedApp.healthCheck.intervalS) * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAppHealthy(params)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`App '${params.resolvedApp.appId}' did not become healthy within ${params.resolvedApp.healthCheck.timeoutS}s`);
}

export async function startComposeAppTarget(params: {
  appId: string;
  appDir: string;
  resolvedApp: ResolvedApplicationRuntime;
  httpPort: number;
  mcpPort: number;
  holabossUserId?: string;
  integrationEnv?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnLike;
  fetchImpl?: typeof fetch;
}): Promise<AppLifecycleActionResult> {
  return await withAppStartOperation(params, async () => {
    const spawnImpl = params.spawnImpl ?? spawn;
    const composeCmd = await findComposeCommand(spawnImpl);
    if (!composeCmd) {
      throw new Error(`App '${params.appId}' requires docker compose but it is not available`);
    }

    if (await isAppHealthy(params)) {
      return {
        app_id: params.appId,
        status: "started",
        detail: "app started with lifecycle manager",
        ports: { http: params.httpPort, mcp: params.mcpPort }
      };
    }

    const composePath = composeFilePath(params.appDir);
    if (!composePath) {
      throw new Error(`App '${params.appId}' has no docker-compose.yml; cannot launch`);
    }

    patchComposePorts(composePath, {
      containerHttpPort: 8080,
      hostHttpPort: params.httpPort,
      containerMcpPort: params.resolvedApp.mcp.port,
      hostMcpPort: params.mcpPort
    });
    const composeEnv = buildShellLifecycleEnv(params);

    const hasImages = await composeImagesExist(composeCmd, params.appDir, spawnImpl, composeEnv);
    const upArgs = hasImages ? [...composeCmd.slice(1), "up", "-d"] : [...composeCmd.slice(1), "up", "--build", "-d"];
    let upResult = await runSpawn(spawnImpl, composeCmd[0]!, upArgs, {
      cwd: params.appDir,
      env: composeEnv,
      captureStderr: true
    });
    if (upResult.code !== 0) {
      throw new Error(`App '${params.appId}' docker compose up failed (rc=${upResult.code}): ${upResult.stderr.slice(0, 500)}`);
    }

    try {
      await waitHealthy(params);
    } catch (error) {
      upResult = await runSpawn(spawnImpl, composeCmd[0]!, [...composeCmd.slice(1), "up", "--build", "-d"], {
        cwd: params.appDir,
        env: composeEnv,
        captureStderr: true
      });
      if (upResult.code !== 0) {
        throw error;
      }
      await waitHealthy(params);
    }

    return {
      app_id: params.appId,
      status: "started",
      detail: "app started with lifecycle manager",
      ports: { http: params.httpPort, mcp: params.mcpPort }
    };
  });
}

export async function startShellLifecycleAppTarget(params: {
  appId: string;
  appDir: string;
  resolvedApp: ResolvedApplicationRuntime;
  httpPort: number;
  mcpPort: number;
  holabossUserId?: string;
  workspaceId?: string;
  integrationEnv?: NodeJS.ProcessEnv;
  skipSetup?: boolean;
  spawnImpl?: SpawnLike;
  fetchImpl?: typeof fetch;
}): Promise<AppLifecycleActionResult> {
  return await withAppStartOperation(params, async () => {
    const spawnImpl = params.spawnImpl ?? spawn;
    const lifecycleStart = params.resolvedApp.lifecycle.start.trim();
    if (!lifecycleStart) {
      throw new Error(`App '${params.appId}' does not define lifecycle.start`);
    }

    if (await isAppHealthy(params)) {
      return {
        app_id: params.appId,
        status: "started",
        detail: "app started with lifecycle manager",
        ports: { http: params.httpPort, mcp: params.mcpPort }
      };
    }

    if (!params.skipSetup) {
      await runLifecycleSetup(params);
    }

    const mapKey = lifecycleMapKey(params.workspaceId, params.appId);
    const child = spawnImpl(lifecycleStart, [], {
      cwd: params.appDir,
      env: buildShellLifecycleEnv(params),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    shellLifecycleProcesses.set(mapKey, child);
    shellLifecyclePorts.set(mapKey, { http: params.httpPort, mcp: params.mcpPort });
    attachTrackedPipeConsumers(child);

    await waitHealthy(params);
    verifyShellAppListenersOrThrow({
      appId: params.appId,
      appDir: params.appDir,
      httpPort: params.httpPort,
      mcpPort: params.mcpPort,
    });
    return {
      app_id: params.appId,
      status: "started",
      detail: "app started with lifecycle manager",
      ports: { http: params.httpPort, mcp: params.mcpPort }
    };
  });
}

export async function startSubprocessAppTarget(params: {
  appId: string;
  appDir: string;
  resolvedApp: ResolvedApplicationRuntime;
  httpPort: number;
  mcpPort: number;
  holabossUserId?: string;
  workspaceId?: string;
  integrationEnv?: NodeJS.ProcessEnv;
  skipSetup?: boolean;
  spawnImpl?: SpawnLike;
  fetchImpl?: typeof fetch;
}): Promise<AppLifecycleActionResult> {
  return await withAppStartOperation(params, async () => {
    const spawnImpl = params.spawnImpl ?? spawn;
    const startCommand = params.resolvedApp.startCommand.trim();
    if (!startCommand) {
      throw new Error(`App '${params.appId}' does not define startCommand`);
    }

    if (await isAppHealthy(params)) {
      return {
        app_id: params.appId,
        status: "started",
        detail: "app started with lifecycle manager",
        ports: { http: params.httpPort, mcp: params.mcpPort }
      };
    }

    if (!params.skipSetup) {
      await runLifecycleSetup(params);
    }

    const mapKey = lifecycleMapKey(params.workspaceId, params.appId);
    const child = spawnImpl(startCommand, [], {
      cwd: params.appDir,
      env: buildShellLifecycleEnv(params),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    shellLifecycleProcesses.set(mapKey, child);
    shellLifecyclePorts.set(mapKey, { http: params.httpPort, mcp: params.mcpPort });
    attachTrackedPipeConsumers(child);

    await waitHealthy(params);
    verifyShellAppListenersOrThrow({
      appId: params.appId,
      appDir: params.appDir,
      httpPort: params.httpPort,
      mcpPort: params.mcpPort,
    });
    return {
      app_id: params.appId,
      status: "started",
      detail: "app started with lifecycle manager",
      ports: { http: params.httpPort, mcp: params.mcpPort }
    };
  });
}

export async function stopShellLifecycleAppTarget(params: {
  appId: string;
  appDir: string;
  resolvedApp: ResolvedApplicationRuntime;
  workspaceId?: string;
  spawnImpl?: SpawnLike;
}): Promise<AppLifecycleActionResult> {
  const spawnImpl = params.spawnImpl ?? spawn;
  const lifecycleStop = params.resolvedApp.lifecycle.stop.trim();
  const mapKey = lifecycleMapKey(params.workspaceId, params.appId);
  const trackedProc = shellLifecycleProcesses.get(mapKey) ?? null;
  let stopError: Error | null = null;

  if (lifecycleStop) {
    try {
      const child = spawnImpl(lifecycleStop, [], {
        cwd: params.appDir,
        env: buildShellLifecycleEnv({}),
        shell: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let timeoutHandle: NodeJS.Timeout | null = null;
      const stopper = await Promise.race([
        waitForExit(child, { captureStderr: true }),
        new Promise<{ code: number; stderr: string }>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ code: 124, stderr: "timeout" }), 30000);
        })
      ]);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (stopper.code !== 0) {
        if (stopper.code === 124) {
          try {
            killChildProcess(child, "SIGKILL");
          } catch {
            // ignore
          }
        }
        stopError = new Error(`App '${params.appId}' lifecycle.stop failed (rc=${stopper.code}): ${stopper.stderr.slice(0, 500)}`);
      }
    } catch (error) {
      stopError = error instanceof Error ? error : new Error(String(error));
    }
  }

  // Always make sure the tracked child process is dead. killTrackedProcess
  // is idempotent (it short-circuits on a non-null exitCode), but we used
  // to call it twice via an else-if + an unconditional branch which made
  // the intent ambiguous and could cause spurious signals on slow exits.
  if (trackedProc) {
    await killTrackedProcess(trackedProc, 10000);
  }
  shellLifecycleProcesses.delete(mapKey);
  const ports = shellLifecyclePorts.get(mapKey);
  if (ports) {
    await killAllocatedPortListeners(mapKey, params.appDir, ports);
  }

  if (stopError) {
    throw stopError;
  }

  return {
    app_id: params.appId,
    status: "stopped",
    detail: "app stopped via lifecycle manager",
    ports: {}
  };
}

export async function stopSubprocessAppTarget(params: {
  appId: string;
  appDir: string;
  workspaceId?: string;
}): Promise<AppLifecycleActionResult> {
  const mapKey = lifecycleMapKey(params.workspaceId, params.appId);
  const trackedProc = shellLifecycleProcesses.get(mapKey) ?? null;
  if (trackedProc) {
    await killTrackedProcess(trackedProc, 10000);
  }
  shellLifecycleProcesses.delete(mapKey);
  const ports = shellLifecyclePorts.get(mapKey);
  if (ports) {
    await killAllocatedPortListeners(mapKey, params.appDir, ports);
  }
  return {
    app_id: params.appId,
    status: "stopped",
    detail: "app stopped via lifecycle manager",
    ports: {}
  };
}

export async function stopComposeAppTarget(params: {
  appId: string;
  appDir: string;
  spawnImpl?: SpawnLike;
}): Promise<AppLifecycleActionResult> {
  const spawnImpl = params.spawnImpl ?? spawn;
  const composeCmd = await findComposeCommand(spawnImpl);
  if (!composeCmd) {
    throw new Error(`App '${params.appId}' requires docker compose but it is not available`);
  }
  const result = await runSpawn(spawnImpl, composeCmd[0]!, [...composeCmd.slice(1), "down", "--remove-orphans"], {
    cwd: params.appDir,
    env: process.env,
    captureStderr: true
  });
  if (result.code !== 0) {
    throw new Error(`App '${params.appId}' docker compose down failed (rc=${result.code}): ${result.stderr.slice(0, 500)}`);
  }
  return {
    app_id: params.appId,
    status: "stopped",
    detail: "app stopped via lifecycle manager",
    ports: {}
  };
}

function unsupportedStartError(params: {
  appId: string;
  appDir?: string;
  resolvedApp?: ResolvedApplicationRuntime;
}): AppLifecycleExecutorError {
  const composePresent = params.appDir ? composeFilePath(params.appDir) !== null : false;
  const hasLifecycleStart = Boolean(params.resolvedApp?.lifecycle.start?.trim());
  const hasStartCommand = Boolean(params.resolvedApp?.startCommand?.trim());
  if (!params.resolvedApp) {
    return new AppLifecycleExecutorError(400, `App '${params.appId}' metadata is not available`);
  }
  if (!hasLifecycleStart && !hasStartCommand && !composePresent) {
    return new AppLifecycleExecutorError(
      500,
      `App '${params.appId}' has no lifecycle.start, no startCommand, and no docker-compose.yml; cannot launch`
    );
  }
  return new AppLifecycleExecutorError(500, `App '${params.appId}' could not be started with the current lifecycle configuration`);
}

export class RuntimeAppLifecycleExecutor implements AppLifecycleExecutorLike {
  readonly store: RuntimeStateStore | null;

  private readonly runtimeApiUrl: string | null;

  constructor(options: RuntimeAppLifecycleExecutorOptions = {}) {
    this.store = options.store ?? null;
    this.runtimeApiUrl = options.runtimeApiUrl ?? null;
  }

  async startApp(params: AppLifecycleStartParams): Promise<AppLifecycleActionResult> {
    const integrationBrokerUrl = this.runtimeApiUrl
      ? `${this.runtimeApiUrl.replace(/\/+$/, "")}/api/v1/integrations`
      : undefined;
    const integrationRuntime =
      this.store && params.appDir && params.resolvedApp
        ? resolveIntegrationRuntime({
            store: this.store,
            appId: params.appId,
            workspaceId: params.workspaceId,
            appDir: params.appDir,
            resolvedApp: params.resolvedApp,
            integrationBrokerUrl
          })
        : null;
    const integrationEnv = integrationRuntime?.env ?? {};
    const spawnImpl = params.spawnImpl;
    const fetchImpl = params.fetchImpl;
    if (
      hasNativeComposeLifecycle(params) &&
      params.httpPort !== undefined &&
      params.mcpPort !== undefined
    ) {
      return await startComposeAppTarget({
        appId: params.appId,
        appDir: params.appDir,
        resolvedApp: params.resolvedApp,
        httpPort: params.httpPort,
        mcpPort: params.mcpPort,
        holabossUserId: params.holabossUserId,
        integrationEnv,
        spawnImpl,
        fetchImpl
      });
    }
    if (hasNativeShellLifecycle(params) && params.resolvedApp.lifecycle.start) {
      if (params.httpPort === undefined || params.mcpPort === undefined) {
        throw new Error("native lifecycle start requires assigned http and mcp ports");
      }
      return await startShellLifecycleAppTarget({
        appId: params.appId,
        appDir: params.appDir,
        resolvedApp: params.resolvedApp,
        httpPort: params.httpPort,
        mcpPort: params.mcpPort,
        holabossUserId: params.holabossUserId,
        workspaceId: params.workspaceId,
        skipSetup: params.skipSetup,
        integrationEnv,
        spawnImpl,
        fetchImpl
      });
    }
    if (hasNativeStartCommandLifecycle(params)) {
      if (params.httpPort === undefined || params.mcpPort === undefined) {
        throw new Error("native startCommand start requires assigned http and mcp ports");
      }
      return await startSubprocessAppTarget({
        appId: params.appId,
        appDir: params.appDir,
        resolvedApp: params.resolvedApp,
        httpPort: params.httpPort,
        mcpPort: params.mcpPort,
        holabossUserId: params.holabossUserId,
        workspaceId: params.workspaceId,
        skipSetup: params.skipSetup,
        integrationEnv,
        spawnImpl,
        fetchImpl
      });
    }
    throw unsupportedStartError(params);
  }

  async stopApp(params: {
    appId: string;
    appDir?: string;
    workspaceId?: string;
    resolvedApp?: ResolvedApplicationRuntime;
  }): Promise<AppLifecycleActionResult> {
    if (hasNativeComposeLifecycle(params)) {
      return await stopComposeAppTarget({
        appId: params.appId,
        appDir: params.appDir
      });
    }
    if (hasNativeShellLifecycle(params)) {
      return await stopShellLifecycleAppTarget({
        appId: params.appId,
        appDir: params.appDir,
        workspaceId: params.workspaceId,
        resolvedApp: params.resolvedApp
      });
    }
    if (hasNativeStartCommandLifecycle(params)) {
      return await stopSubprocessAppTarget({
        appId: params.appId,
        appDir: params.appDir,
        workspaceId: params.workspaceId
      });
    }
    return {
      app_id: params.appId,
      status: "stopped",
      detail: "app stopped via lifecycle manager",
      ports: {}
    };
  }

  async shutdownAll(params: LifecycleShutdownParams = {}): Promise<LifecycleShutdownResult> {
    const targets = params.targets ?? [];
    if (targets.length === 0) {
      return { stopped: [], failed: [] };
    }
    return await shutdownComposeTargets(targets);
  }

  isTrackingApp(params: { workspaceId?: string; appId: string }): boolean {
    return isShellLifecycleAppTracked(params.workspaceId, params.appId);
  }

  rememberAppPorts(params: {
    workspaceId?: string;
    appId: string;
    httpPort: number;
    mcpPort: number;
  }): void {
    rememberShellLifecycleAppPorts(params);
  }
}
