import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  killChildProcess,
  terminateRunnerAfterTerminalEvent,
  quoteShellValue,
  runtimeShellKind,
  shellPathDelimiter,
  spawnShellCommand,
} from "./runtime-shell.js";

const TERMINAL_EVENT_TYPES = new Set(["run_completed", "run_failed"]);
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_RUN_TIMEOUT_SECONDS = 1800;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 900;
const DEFAULT_TASK_PROPOSAL_RUN_TIMEOUT_SECONDS = 7200;
const DEFAULT_POST_START_TIMEOUT_GRACE_SECONDS = 60;

export interface RunnerExecutorLike {
  run(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  stream(payload: Record<string, unknown>): Promise<Readable>;
}

export class RunnerExecutorError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface RunnerExecutionResult {
  events: Record<string, unknown>[];
  skippedLines: string[];
  stderr: string;
  returnCode: number;
  sawTerminal: boolean;
  aborted?: boolean;
  abortReason?: string | null;
}

export type RunnerEvent = Record<string, unknown>;

function encodeRequest(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

function runtimeAppRoot(): string {
  return (process.env.HOLABOSS_RUNTIME_APP_ROOT ?? "/app").trim() || "/app";
}

let cachedModuleAnchoredRuntimeRoot: string | null | undefined;

/**
 * Derive the runtime root from this module's own on-disk location, as a
 * fallback when HOLABOSS_RUNTIME_ROOT is unset. The bundled layout is
 * `<bundle>/runtime/api-server/{dist,src}/<thisfile>`, and `runtimeApiServerRoot`
 * relies on `<runtimeRoot>/api-server` existing — so the runtime root is the
 * nearest ancestor directory that contains an `api-server` child. Returns null
 * if that can't be resolved (non-standard layout), leaving the legacy default.
 */
function moduleAnchoredRuntimeRoot(): string | null {
  if (cachedModuleAnchoredRuntimeRoot !== undefined) {
    return cachedModuleAnchoredRuntimeRoot;
  }
  let resolved: string | null = null;
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, "api-server"))) {
        resolved = dir;
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    resolved = null;
  }
  cachedModuleAnchoredRuntimeRoot = resolved;
  return resolved;
}

function runtimeRoot(): string {
  const configured = (process.env.HOLABOSS_RUNTIME_ROOT ?? "").trim();
  if (configured) {
    return configured;
  }
  // Prefer a root derived from this module's location over the POSIX-only
  // "/runtime" literal: on Windows `runtimeBundleRoot()`'s `path.resolve(root,
  // "..")` turns "/runtime" into the drive root `C:\`, so the bundled-Python
  // PATH entries become bogus `C:\python-runtime\...` dirs and the agent's
  // bash silently falls back to a system Python (mismatched python/pip). See
  // buildRunnerEnv's bundled-Python check.
  return moduleAnchoredRuntimeRoot() ?? "/runtime";
}

function runtimeBundleRoot(): string {
  return path.resolve(runtimeRoot(), "..");
}

function runtimeNode(): string {
  const configured = (process.env.HOLABOSS_RUNTIME_NODE_BIN ?? "").trim();
  return configured || "node";
}

function bundledRuntimeNodeModulesBinDir(): string {
  return path.join(runtimeBundleRoot(), "node-runtime", "node_modules", ".bin");
}

export function bundledRuntimeNodeBinDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return path.join(runtimeBundleRoot(), "node-runtime", "bin");
  }
  return path.join(runtimeBundleRoot(), "node-runtime", "node_modules", "node", "bin");
}

function bundledRuntimeNodePathEntries(platform: NodeJS.Platform = process.platform): string[] {
  const nodeBinDir = bundledRuntimeNodeBinDir(platform);
  const nodeModulesBinDir = bundledRuntimeNodeModulesBinDir();
  return platform === "win32"
    ? [nodeBinDir, nodeModulesBinDir]
    : [nodeModulesBinDir, nodeBinDir];
}

function bundledRuntimePythonPathEntries(platform: NodeJS.Platform = process.platform): string[] {
  const bundleRoot = runtimeBundleRoot();
  if (platform === "win32") {
    return [
      path.join(bundleRoot, "python-runtime", "python"),
      path.join(bundleRoot, "python-runtime", "python", "Scripts"),
      path.join(bundleRoot, "python-runtime", "bin"),
    ];
  }
  return [
    path.join(bundleRoot, "python-runtime", "bin"),
    path.join(bundleRoot, "python-runtime", "python", "bin"),
  ];
}

function prependPathEntries(currentPath: string | undefined, entries: string[]): string {
  const normalizedEntries = entries.map((entry) => entry.trim()).filter(Boolean);
  if (normalizedEntries.length === 0) {
    return currentPath ?? "";
  }

  const delimiter = shellPathDelimiter();
  const currentEntries = (currentPath ?? "").split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  const deduped = [
    ...normalizedEntries,
    ...currentEntries.filter((entry) => !normalizedEntries.includes(entry))
  ];
  return deduped.join(delimiter);
}

function normalizeSessionKind(payload: Record<string, unknown>): string {
  const value = payload.session_kind;
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "task_proposal") {
    return "subagent";
  }
  return normalized;
}

function secondsFromEnv(
  envName: string,
  defaultValue: number,
  options: { min: number; max: number }
): number {
  const raw = (process.env[envName] ?? String(defaultValue)).trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(options.min, Math.min(parsed, options.max));
}

function millisecondsFromEnv(
  envName: string,
  defaultValue: number,
  options: { min: number; max: number }
): number {
  const raw = (process.env[envName] ?? String(defaultValue)).trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(options.min, Math.min(parsed, options.max));
}

function runnerTimeoutSeconds(payload: Record<string, unknown>): number {
  const baseTimeoutSeconds = secondsFromEnv("SANDBOX_AGENT_RUN_TIMEOUT_S", DEFAULT_RUN_TIMEOUT_SECONDS, {
    min: 1,
    max: 7200
  });
  if (normalizeSessionKind(payload) === "subagent") {
    return secondsFromEnv(
      "SANDBOX_AGENT_SUBAGENT_RUN_TIMEOUT_S",
      Math.max(baseTimeoutSeconds, DEFAULT_TASK_PROPOSAL_RUN_TIMEOUT_SECONDS),
      { min: 1, max: 7200 }
    );
  }
  return baseTimeoutSeconds;
}

function runnerIdleTimeoutSeconds(payload: Record<string, unknown>): number {
  const baseIdleTimeoutSeconds = secondsFromEnv("SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S", DEFAULT_IDLE_TIMEOUT_SECONDS, {
    min: 1,
    max: 7200
  });
  if (normalizeSessionKind(payload) === "subagent") {
    return secondsFromEnv(
      "SANDBOX_AGENT_SUBAGENT_RUN_IDLE_TIMEOUT_S",
      runnerTimeoutSeconds(payload),
      { min: 1, max: 7200 }
    );
  }
  return baseIdleTimeoutSeconds;
}

function runnerHeartbeatIntervalMs(): number {
  return millisecondsFromEnv("SANDBOX_AGENT_RUNNER_HEARTBEAT_MS", DEFAULT_HEARTBEAT_INTERVAL_MS, {
    min: 50,
    max: 60_000,
  });
}

function postStartTimeoutGraceSeconds(): number {
  return secondsFromEnv(
    "SANDBOX_AGENT_RUN_POST_START_GRACE_S",
    DEFAULT_POST_START_TIMEOUT_GRACE_SECONDS,
    { min: 0, max: 600 }
  );
}

function harnessTimeoutSeconds(payload: Record<string, unknown>): number | null {
  const raw = payload.harness_timeout_seconds;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const normalized = Math.max(0, Math.min(Math.trunc(parsed), 7200));
  return normalized > 0 ? normalized : null;
}

function usesSlidingHarnessDeadline(payload: Record<string, unknown>): boolean {
  return normalizeSessionKind(payload) === "subagent";
}

function normalizeRuntimeApiHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::") {
    return "127.0.0.1";
  }
  return trimmed;
}

export function currentRuntimeApiUrl(): string | undefined {
  const configured = (process.env.SANDBOX_RUNTIME_API_URL ?? "").trim();
  if (configured) {
    return configured;
  }

  const portValue = (process.env.SANDBOX_RUNTIME_API_PORT ?? process.env.SANDBOX_AGENT_BIND_PORT ?? "").trim();
  if (!portValue) {
    return undefined;
  }
  const port = Number.parseInt(portValue, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return undefined;
  }

  const host = normalizeRuntimeApiHost(
    process.env.SANDBOX_RUNTIME_API_HOST ?? process.env.SANDBOX_AGENT_BIND_HOST ?? "127.0.0.1"
  );
  return `http://${host}:${port}`;
}

export function buildRunnerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const currentApiUrl = currentRuntimeApiUrl();
  if (currentApiUrl && !(env.SANDBOX_RUNTIME_API_URL ?? "").trim()) {
    env.SANDBOX_RUNTIME_API_URL = currentApiUrl;
  }
  const pythonPathEntries = bundledRuntimePythonPathEntries();
  warnIfBundledPythonMissing(pythonPathEntries);
  applyPrependedPath(env, [
    ...pythonPathEntries,
    ...bundledRuntimeNodePathEntries(),
    path.join(runtimeAppRoot(), "api-server", "node_modules", ".bin")
  ]);
  return env;
}

let warnedBundledPythonMissing = false;

/**
 * Warn once when the bundled Python interpreter dir isn't on disk. The agent's
 * bash inherits this env, so a missing bundle means it falls back to whatever
 * `python` happens to be on the system PATH — often with `python`/`pip`
 * resolving to different interpreters. Making that loud turns a silent,
 * hard-to-debug fallback into a visible signal.
 */
function warnIfBundledPythonMissing(pythonPathEntries: string[]): void {
  if (warnedBundledPythonMissing) {
    return;
  }
  const interpreterDir = pythonPathEntries[0];
  if (!interpreterDir) {
    return;
  }
  try {
    if (!fs.existsSync(interpreterDir)) {
      warnedBundledPythonMissing = true;
      console.warn(
        `[runner] bundled Python not found at ${interpreterDir}; agent shells will fall back to a system Python on PATH. ` +
          `Set HOLABOSS_RUNTIME_ROOT to the runtime bundle, or stage python-runtime.`,
      );
    }
  } catch {
    // Never let a diagnostic check break env construction.
  }
}

/**
 * Prepend `entries` onto the env's PATH *in place*, honoring the actual key
 * casing. Windows stores PATH under the key "Path"; `process.env` reads it
 * case-insensitively via a Node proxy, but a plain `{ ...process.env }` copy is
 * case-SENSITIVE — so reading/writing `env.PATH` on that copy would miss the
 * real value and create a competing "PATH" key. The child process then
 * inherits an ambiguous Path/PATH pair that Windows collapses
 * case-insensitively, dropping entries like ~/.local/bin (claude) — which is
 * why real runs hit `spawn claude ENOENT` while the connection test (which
 * inherits process.env untouched) succeeds. Update the existing key in place.
 */
export function applyPrependedPath(
  env: NodeJS.ProcessEnv,
  entries: string[],
): void {
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = prependPathEntries(env[pathKey], entries);
}

function runtimeApiServerRoot(): string {
  return path.join(runtimeRoot(), "api-server");
}

/**
 * A launchable runner invocation: the shell command to run, plus — for the
 * default path, which hands the request off via a temp file — that file's path
 * so the caller can delete it once the child has exited. `requestFilePath` is
 * null for the custom-template path, which inlines the base64 request itself.
 */
export interface RunnerInvocation {
  command: string;
  requestFilePath: string | null;
}

/**
 * Write the base64-encoded request to a short-named temp file and return its
 * path. The default runner command references the request BY FILE rather than
 * inlining the (potentially very large) base64 on the command line, because
 * Windows caps a process command line at ~32,767 chars — a big chat/automation
 * context otherwise overflows it and fails the spawn with `ENAMETOOLONG`.
 */
function writeRunnerRequestFile(payload: Record<string, unknown>): string {
  const filePath = path.join(os.tmpdir(), `holaboss-runner-${randomUUID()}.b64`);
  fs.writeFileSync(filePath, encodeRequest(payload), "utf-8");
  return filePath;
}

/** Best-effort removal of a runner request temp file (no-op when null). The OS
 *  reaps stale temp files, so a rare leaked handful is harmless. */
export function removeRunnerRequestFile(filePath: string | null): void {
  if (!filePath) {
    return;
  }
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // ignore cleanup failures
  }
}

function defaultRunnerCommand(requestFilePath: string): string {
  const requestFileQuoted = quoteShellValue(requestFilePath);
  const runtimeNodeQuoted = quoteShellValue(runtimeNode());
  const runtimeApiServerRootQuoted = quoteShellValue(runtimeApiServerRoot());
  if (runtimeShellKind() === "powershell") {
    return `Set-Location -LiteralPath ${runtimeApiServerRootQuoted}; & ${runtimeNodeQuoted} dist/ts-runner.mjs --request-file ${requestFileQuoted}`;
  }
  return `cd ${runtimeApiServerRootQuoted} && ${runtimeNodeQuoted} dist/ts-runner.mjs --request-file ${requestFileQuoted}`;
}

export function runnerInvocation(payload: Record<string, unknown>): RunnerInvocation {
  const template = (process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE ?? "").trim();
  if (!template) {
    const requestFilePath = writeRunnerRequestFile(payload);
    return { command: defaultRunnerCommand(requestFilePath), requestFilePath };
  }
  // Custom templates inline the base64 request themselves; leave that behavior
  // untouched (they opt out of the temp-file path and own any length limits).
  const replacements: Record<string, string> = {
    request_base64: quoteShellValue(encodeRequest(payload)),
    runtime_api_server_root: quoteShellValue(runtimeApiServerRoot()),
    runtime_app_root: quoteShellValue(runtimeAppRoot()),
    runtime_root: quoteShellValue(runtimeRoot()),
    runtime_node: quoteShellValue(runtimeNode())
  };
  try {
    const rendered = template.replace(
      /\{(request_base64|runtime_api_server_root|runtime_app_root|runtime_root|runtime_node)\}/g,
      (match, key) => {
        const replacement = replacements[key];
        if (replacement === undefined) {
          throw new Error(`missing placeholder: ${key}`);
        }
        return replacement;
      }
    );
    if (/\{[^{}]+\}/.test(rendered)) {
      throw new Error("unresolved template placeholders");
    }
    return { command: rendered, requestFilePath: null };
  } catch (error) {
    throw new RunnerExecutorError(
      500,
      `invalid SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunnerEvent(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.session_id === "string" &&
    typeof value.input_id === "string" &&
    typeof value.sequence === "number" &&
    typeof value.event_type === "string" &&
    isRecord(value.payload)
  );
}

function parseRunnerEventLine(line: string): RunnerEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRunnerEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function appendSkippedLine(skippedLines: string[], line: string): void {
  if (line && skippedLines.length < 20) {
    skippedLines.push(line);
  }
}

function eventSequence(event: Record<string, unknown>): number {
  return typeof event.sequence === "number" ? event.sequence : 0;
}

export function buildRunFailedEvent(params: {
  sessionId: string;
  inputId: string;
  sequence: number;
  message: string;
  errorType?: string;
}): RunnerEvent {
  return {
    session_id: params.sessionId,
    input_id: params.inputId,
    sequence: params.sequence,
    event_type: "run_failed",
    payload: {
      type: params.errorType ?? "RuntimeError",
      message: params.message
    }
  };
}

export function buildRunCompletedEvent(params: {
  sessionId: string;
  inputId: string;
  sequence: number;
  payload?: Record<string, unknown>;
}): RunnerEvent {
  return {
    session_id: params.sessionId,
    input_id: params.inputId,
    sequence: params.sequence,
    event_type: "run_completed",
    payload: params.payload ?? {},
  };
}

function sseEvent(event: RunnerEvent): string {
  const eventType = typeof event.event_type === "string" ? event.event_type : "message";
  const inputId = typeof event.input_id === "string" ? event.input_id : "unknown";
  const sequence = eventSequence(event);
  return [`event: ${eventType}`, `id: ${inputId}:${sequence}`, `data: ${JSON.stringify(event)}`].join("\n") + "\n\n";
}

function requiredString(payload: Record<string, unknown>, fieldName: string): string {
  const value = payload[fieldName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunnerExecutorError(400, `${fieldName} is required`);
  }
  return value;
}

function validateRunnerPayload(payload: Record<string, unknown>): void {
  requiredString(payload, "workspace_id");
  requiredString(payload, "session_id");
  requiredString(payload, "input_id");
  requiredString(payload, "instruction");
  if (payload.context !== undefined && !isRecord(payload.context)) {
    throw new RunnerExecutorError(400, "context must be an object");
  }
}

export function synthesizeFailure(params: {
  payload: Record<string, unknown>;
  events: RunnerEvent[];
  skippedLines: string[];
  stderr: string;
  returnCode: number;
  sawTerminal: boolean;
  stream: boolean;
}): RunnerEvent[] {
  if (params.sawTerminal) {
    return params.events;
  }

  const sequence = Math.max(0, ...params.events.map(eventSequence)) + 1;
  const details = params.skippedLines.length > 0 ? params.skippedLines.slice(0, 3).join("; ") : "";
  const suffix = details ? ` (skipped output: ${details})` : "";
  const message =
    params.returnCode !== 0
      ? params.stderr || `runner command failed with exit_code=${params.returnCode}`
      : `runner ${params.stream ? "stream " : ""}ended before terminal event${suffix}`;
  const errorType = params.returnCode !== 0 ? "RunnerCommandError" : "RuntimeError";
  return params.events.concat(
    buildRunFailedEvent({
      sessionId: requiredString(params.payload, "session_id"),
      inputId: requiredString(params.payload, "input_id"),
      sequence,
      message,
      errorType
    })
  );
}

export async function executeRunnerRequest(
  payload: Record<string, unknown>,
  options: {
    onEvent?: (event: RunnerEvent) => void | Promise<void>;
    onHeartbeat?: () => void | Promise<void>;
    signal?: AbortSignal;
  } = {}
): Promise<RunnerExecutionResult> {
  validateRunnerPayload(payload);
  if (options.signal?.aborted) {
    return {
      events: [],
      skippedLines: [],
      stderr: "runner command aborted by caller",
      returnCode: 130,
      sawTerminal: false,
      aborted: true,
      abortReason:
        typeof options.signal.reason === "string" && options.signal.reason.trim()
          ? options.signal.reason.trim()
          : null,
    };
  }
  const invocation = runnerInvocation(payload);
  const env = buildRunnerEnv();
  const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id.trim() : "";
  if (workspaceId) {
    env.HOLABOSS_WORKSPACE_ID = workspaceId;
  }
  // TTFT dissection — capture spawn + key event arrival times. Logged via
  // console.log at the end so it lands in runtime.log (the ts-runner subprocess
  // stderr is buffered by us and only surfaced on failure, so a log there is
  // invisible on successful turns).
  const ttftSpawnAtMs = Date.now();
  let ttftFirstEventAtMs: number | null = null;
  let ttftRunStartedAtMs: number | null = null;
  let ttftBootstrapMs: number | null = null;
  // Which harness path ran. Without this on the line, an A/B of the in-process
  // flag cannot tell "the flag worked and saved little" from "the flag never
  // took effect" — the two look identical in every other number.
  let ttftHarnessInProcess: boolean | null = null;
  let ttftSessionSetupMs: number | null = null;
  let ttftSetupBreakdown: Record<string, unknown> | null = null;
  let ttftFirstTokenAtMs: number | null = null;
  // First model response's token accounting (prefill size + cache-read), so the
  // [ttft] line shows whether model_ttft was a cache MISS (full prefill) or a warm
  // HIT. Populated from the run_completed usage payload, available by run-end when
  // the line is logged.
  let ttftInputTokens: number | null = null;
  let ttftCachedInputTokens: number | null = null;
  const captureTtft = (event: RunnerEvent): void => {
    if (ttftFirstEventAtMs === null) {
      ttftFirstEventAtMs = Date.now();
    }
    if (event.event_type === "run_started") {
      if (ttftRunStartedAtMs === null) {
        ttftRunStartedAtMs = Date.now();
      }
      const payload = event.payload as Record<string, unknown> | undefined;
      const inProcess = payload?.harness_in_process;
      if (ttftHarnessInProcess === null && typeof inProcess === "boolean") {
        ttftHarnessInProcess = inProcess;
      }
      const bootstrap = payload?.bootstrap_total_ms;
      if (ttftBootstrapMs === null && typeof bootstrap === "number") {
        ttftBootstrapMs = bootstrap;
      }
      // Harness-measured (precise): total createSession time + per-step map so we
      // can split harness_boot into cold-load vs the serial session setup.
      const setup = payload?.session_setup_ms;
      if (ttftSessionSetupMs === null && typeof setup === "number") {
        ttftSessionSetupMs = setup;
      }
      const breakdown = payload?.session_setup_timings_ms;
      if (
        ttftSetupBreakdown === null &&
        breakdown !== null &&
        typeof breakdown === "object"
      ) {
        ttftSetupBreakdown = breakdown as Record<string, unknown>;
      }
    }
    // First sign the model produced output — text, reasoning, or a tool/skill
    // call (a tool-first turn emits no output_delta, which is why some turns
    // logged n/a before). run_started/mcp events are harness lifecycle, not
    // model output, so they don't count.
    if (
      ttftFirstTokenAtMs === null &&
      (event.event_type === "output_delta" ||
        event.event_type === "thinking_delta" ||
        event.event_type === "tool_call" ||
        event.event_type === "skill_invocation")
    ) {
      ttftFirstTokenAtMs = Date.now();
    }
    if (
      ttftInputTokens === null &&
      (event.event_type === "run_completed" ||
        event.event_type === "run_failed")
    ) {
      const usage = (event.payload as Record<string, unknown> | undefined)?.usage;
      if (usage !== null && typeof usage === "object") {
        const u = usage as Record<string, unknown>;
        if (typeof u.input_tokens === "number") {
          ttftInputTokens = u.input_tokens;
        }
        if (typeof u.cached_input_tokens === "number") {
          ttftCachedInputTokens = u.cached_input_tokens;
        }
      }
    }
  };
  let child;
  try {
    child = spawnShellCommand(spawn, invocation.command, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (error) {
    removeRunnerRequestFile(invocation.requestFilePath);
    throw error;
  }
  // The child reads the request file at startup; delete it once it exits.
  child.once("close", () => removeRunnerRequestFile(invocation.requestFilePath));
  child.once("error", () => removeRunnerRequestFile(invocation.requestFilePath));
  const closePromise = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });

  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdout || !stderr) {
    throw new Error("sandbox runner subprocess streams were not initialized");
  }

  const timeoutMs = runnerTimeoutSeconds(payload) * 1000;
  const idleTimeoutMs = runnerIdleTimeoutSeconds(payload) * 1000;
  const postStartHarnessTimeoutSeconds = harnessTimeoutSeconds(payload);
  const postStartTimeoutGraceMs = postStartTimeoutGraceSeconds() * 1000;
  let timedOut = false;
  let idleTimedOut = false;
  let sawTerminal = false;
  let aborted = false;
  let timeout: NodeJS.Timeout | null = null;
  let hardDeadlineAtMs = Date.now() + timeoutMs;
  let postStartDeadlineApplied = false;
  const refreshPostStartDeadline = () => {
    if (postStartHarnessTimeoutSeconds === null) {
      return;
    }
    scheduleHardTimeoutAt(
      Math.max(
        hardDeadlineAtMs,
        Date.now() + postStartHarnessTimeoutSeconds * 1000 + postStartTimeoutGraceMs
      )
    );
  };
  const scheduleHardTimeoutAt = (deadlineAtMs: number) => {
    hardDeadlineAtMs = deadlineAtMs;
    if (timeout) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      timedOut = true;
      killChildProcess(child, "SIGKILL");
    }, Math.max(1, hardDeadlineAtMs - Date.now()));
  };
  scheduleHardTimeoutAt(hardDeadlineAtMs);
  let idleTimeout: NodeJS.Timeout | null = null;
  const resetIdleTimeout = () => {
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    idleTimeout = setTimeout(() => {
      if (sawTerminal) {
        return;
      }
      idleTimedOut = true;
      killChildProcess(child, "SIGKILL");
    }, idleTimeoutMs);
  };
  resetIdleTimeout();
  const heartbeat = setInterval(() => {
    // Keep silent-but-alive runs from tripping the idle watchdog while still
    // letting the hard timeout cap total wall-clock execution.
    resetIdleTimeout();
    // This fires on a timer, so an unguarded throw — or a rejected promise —
    // from the caller's heartbeat hook (e.g. a transient "database is locked"
    // while it renews the input-claim lease) would surface as an
    // uncaughtException / unhandledRejection and crash the entire runtime
    // (process.exit(1)), aborting the run the user just queued. A missed
    // heartbeat is harmless — it renews on the next tick — so isolate it.
    try {
      const result = options.onHeartbeat?.();
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((error) => {
          console.error("runner heartbeat hook rejected (ignored)", error);
        });
      }
    } catch (error) {
      console.error("runner heartbeat hook threw (ignored)", error);
    }
  }, runnerHeartbeatIntervalMs());
  const abortChild = () => {
    if (sawTerminal || timedOut || idleTimedOut || aborted) {
      return;
    }
    aborted = true;
    killChildProcess(child, "SIGKILL");
  };
  options.signal?.addEventListener("abort", abortChild, { once: true });

  const stderrPromise = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of stderr) {
      resetIdleTimeout();
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8").trim();
  })();

  const events: RunnerEvent[] = [];
  const skippedLines: string[] = [];
  let stdoutBuffer = "";

  try {
    for await (const chunk of stdout) {
      stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        const parsed = parseRunnerEventLine(line);
        if (!parsed) {
          appendSkippedLine(skippedLines, line);
          continue;
        }
        resetIdleTimeout();
        events.push(parsed);
        captureTtft(parsed);
        if (
          parsed.event_type === "run_started" &&
          !postStartDeadlineApplied &&
          postStartHarnessTimeoutSeconds !== null
        ) {
          postStartDeadlineApplied = true;
          refreshPostStartDeadline();
        } else if (
          postStartDeadlineApplied &&
          usesSlidingHarnessDeadline(payload) &&
          !TERMINAL_EVENT_TYPES.has(parsed.event_type as string)
        ) {
          refreshPostStartDeadline();
        }
        if (options.onEvent) {
          await options.onEvent(parsed);
        }
        if (TERMINAL_EVENT_TYPES.has(parsed.event_type as string)) {
          sawTerminal = true;
          terminateRunnerAfterTerminalEvent(child);
        }
      }
    }
    const trailingLine = stdoutBuffer.trim();
    if (trailingLine) {
      const parsed = parseRunnerEventLine(trailingLine);
      if (parsed) {
        resetIdleTimeout();
        events.push(parsed);
        captureTtft(parsed);
        if (
          parsed.event_type === "run_started" &&
          !postStartDeadlineApplied &&
          postStartHarnessTimeoutSeconds !== null
        ) {
          postStartDeadlineApplied = true;
          refreshPostStartDeadline();
        } else if (
          postStartDeadlineApplied &&
          usesSlidingHarnessDeadline(payload) &&
          !TERMINAL_EVENT_TYPES.has(parsed.event_type as string)
        ) {
          refreshPostStartDeadline();
        }
        if (options.onEvent) {
          await options.onEvent(parsed);
        }
        if (TERMINAL_EVENT_TYPES.has(parsed.event_type as string)) {
          sawTerminal = true;
          terminateRunnerAfterTerminalEvent(child);
        }
      } else {
        appendSkippedLine(skippedLines, trailingLine);
      }
    }
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (idleTimeout) {
      clearTimeout(idleTimeout);
    }
    clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", abortChild);
  }

  const returnCode = await closePromise;

  // TTFT dissection line (greppable in runtime.log via stdout). The harness
  // emits run_started immediately before the model call (sendUserMessage), so
  // run_started->first_token isolates the pure model TTFT, and the pre-run_started
  // window splits into bootstrap + harness boot:
  //   ts_runner_load = outer spawn -> run_claimed: node start + ts-runner bundle
  //                    cold-load + request parse
  //   bootstrap      = in-process request build (from the run_started payload)
  //   harness_boot   = (run_started - run_claimed) - bootstrap: harness-host
  //                    spawn + 1.1MB bundle cold-load + pi session setup
  //   harness_load   = harness_boot - session_setup: spawn + bundle cold-load
  //   session_setup  = harness-measured createSession (serial MCP/composio/
  //                    runtime/browser/web-search/agent-session setup); the
  //                    setup=[...] breakdown shows which step dominates
  //   model_ttft     = run_started -> first token: model network + generation
  //   total          = spawn -> first token
  {
    const sessionId =
      typeof payload.session_id === "string" ? payload.session_id : "?";
    const loadMs =
      ttftFirstEventAtMs === null ? null : ttftFirstEventAtMs - ttftSpawnAtMs;
    const harnessBootMs =
      ttftRunStartedAtMs !== null && ttftFirstEventAtMs !== null
        ? Math.max(
            0,
            ttftRunStartedAtMs - ttftFirstEventAtMs - (ttftBootstrapMs ?? 0),
          )
        : null;
    const harnessLoadMs =
      harnessBootMs !== null && ttftSessionSetupMs !== null
        ? Math.max(0, harnessBootMs - ttftSessionSetupMs)
        : null;
    const modelTtftMs =
      ttftRunStartedAtMs !== null && ttftFirstTokenAtMs !== null
        ? Math.max(0, ttftFirstTokenAtMs - ttftRunStartedAtMs)
        : null;
    const totalMs =
      ttftFirstTokenAtMs === null ? null : ttftFirstTokenAtMs - ttftSpawnAtMs;
    const setupBreakdown = ttftSetupBreakdown
      ? Object.entries(ttftSetupBreakdown)
          .filter(([, v]) => typeof v === "number" && v > 0)
          .sort((a, b) => (b[1] as number) - (a[1] as number))
          .map(([k, v]) => `${k}=${v}`)
          .join(",")
      : "";
    console.log(
      `[ttft] session=${sessionId} exit=${returnCode} ` +
        `ts_runner_load_ms=${loadMs ?? "n/a"} ` +
        `bootstrap_ms=${ttftBootstrapMs ?? "n/a"} ` +
        `harness_load_ms=${harnessLoadMs ?? "n/a"} ` +
        `in_process=${ttftHarnessInProcess === null ? "n/a" : String(ttftHarnessInProcess)} ` +
        `session_setup_ms=${ttftSessionSetupMs ?? "n/a"} ` +
        `model_ttft_ms=${modelTtftMs ?? "n/a"} ` +
        `total_ttft_ms=${totalMs ?? "n/a"} ` +
        `input_tokens=${ttftInputTokens ?? "n/a"} ` +
        `cache_read=${ttftCachedInputTokens ?? "n/a"}` +
        (ttftInputTokens && ttftInputTokens > 0 && ttftCachedInputTokens !== null
          ? ` cache_hit=${Math.round((ttftCachedInputTokens / ttftInputTokens) * 100)}%`
          : "") +
        (setupBreakdown ? ` setup=[${setupBreakdown}]` : ""),
    );
  }

  const stderrText = timedOut
    ? "runner command timed out"
    : idleTimedOut
      ? `runner command became idle for ${Math.round(idleTimeoutMs / 1000)}s without a terminal event`
      : aborted
        ? "runner command aborted by caller"
        : await stderrPromise;

  return {
    events,
    skippedLines,
    stderr: stderrText,
    returnCode: timedOut || idleTimedOut ? 124 : aborted ? 130 : returnCode,
    sawTerminal,
    aborted,
    abortReason:
      aborted && typeof options.signal?.reason === "string" && options.signal.reason.trim()
        ? options.signal.reason.trim()
        : null,
  };
}

export class NativeRunnerExecutor implements RunnerExecutorLike {
  async run(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const execution = await executeRunnerRequest(payload);
    const events = synthesizeFailure({
      payload,
      events: execution.events,
      skippedLines: execution.skippedLines,
      stderr: execution.stderr,
      returnCode: execution.returnCode,
      sawTerminal: execution.sawTerminal,
      stream: false
    });
    return {
      session_id: requiredString(payload, "session_id"),
      input_id: requiredString(payload, "input_id"),
      events
    };
  }

  async stream(payload: Record<string, unknown>): Promise<Readable> {
    validateRunnerPayload(payload);
    const invocation = runnerInvocation(payload);
    let child;
    try {
      child = spawnShellCommand(spawn, invocation.command, {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildRunnerEnv(),
      });
    } catch (error) {
      removeRunnerRequestFile(invocation.requestFilePath);
      throw error;
    }
    // The child reads the request file at startup; delete it once it exits.
    child.once("close", () => removeRunnerRequestFile(invocation.requestFilePath));
    child.once("error", () => removeRunnerRequestFile(invocation.requestFilePath));
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      throw new Error("sandbox runner subprocess streams were not initialized");
    }

    const stream = new Readable({
      read() {}
    });
    const stderrChunks: Buffer[] = [];
    let stdoutBuffer = "";
    let skippedLines: string[] = [];
    let sawTerminal = false;
    let lastSequence = 0;
    let heartbeat: NodeJS.Timeout | null = null;

    // The heartbeat below only pushes `: ping` — it proves the HTTP connection
    // is alive, not that the runner is. Without the two watchdogs that
    // executeRunnerRequest has, a wedged runner emitted pings forever and the
    // caller saw a healthy-looking stream that never produced a terminal event
    // and never errored. Mirror them here so the streaming endpoint fails the
    // same way, with the same wording, as the non-streaming one.
    let timedOut = false;
    let idleTimedOut = false;
    const hardTimeoutMs = runnerTimeoutSeconds(payload) * 1000;
    const idleTimeoutMs = runnerIdleTimeoutSeconds(payload) * 1000;
    const hardTimeout = setTimeout(() => {
      if (sawTerminal) {
        return;
      }
      timedOut = true;
      killChildProcess(child, "SIGKILL");
    }, Math.max(1, hardTimeoutMs));
    hardTimeout.unref?.();
    let idleTimeout: NodeJS.Timeout | null = null;
    const clearWatchdogs = () => {
      clearTimeout(hardTimeout);
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
    };
    const resetIdleTimeout = () => {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(() => {
        if (sawTerminal) {
          return;
        }
        idleTimedOut = true;
        killChildProcess(child, "SIGKILL");
      }, idleTimeoutMs);
      idleTimeout.unref?.();
    };
    resetIdleTimeout();

    const resetHeartbeat = () => {
      if (heartbeat) {
        clearTimeout(heartbeat);
      }
      heartbeat = setTimeout(() => {
        stream.push(": ping\n\n");
        resetHeartbeat();
      }, runnerHeartbeatIntervalMs());
    };

    resetHeartbeat();
    stream.push(": connected\n\n");

    stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    stdout.on("data", (chunk) => {
      stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk);
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        const parsed = parseRunnerEventLine(line);
        if (!parsed) {
          appendSkippedLine(skippedLines, line);
          continue;
        }
        lastSequence = Math.max(lastSequence, eventSequence(parsed));
        if (TERMINAL_EVENT_TYPES.has(parsed.event_type as string)) {
          sawTerminal = true;
        }
        stream.push(sseEvent(parsed));
        resetHeartbeat();
        // A parsed event is real progress; a heartbeat is not, which is why
        // the idle watchdog resets here and not in resetHeartbeat.
        resetIdleTimeout();
        if (sawTerminal) {
          if (heartbeat) {
            clearTimeout(heartbeat);
          }
          clearWatchdogs();
          terminateRunnerAfterTerminalEvent(child);
        }
      }
    });

    const finalize = (returnCode: number) => {
      if (heartbeat) {
        clearTimeout(heartbeat);
      }
      clearWatchdogs();
      const trailingLine = stdoutBuffer.trim();
      if (trailingLine) {
        const parsed = parseRunnerEventLine(trailingLine);
        if (parsed) {
          lastSequence = Math.max(lastSequence, eventSequence(parsed));
          if (TERMINAL_EVENT_TYPES.has(parsed.event_type as string)) {
            sawTerminal = true;
          }
          stream.push(sseEvent(parsed));
        } else {
          appendSkippedLine(skippedLines, trailingLine);
        }
      }
      if (!sawTerminal) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf-8").trim();
        const details = skippedLines.length > 0 ? skippedLines.slice(0, 3).join("; ") : "";
        const suffix = details ? ` (skipped output: ${details})` : "";
        const message = timedOut
          ? "runner command timed out"
          : idleTimedOut
            ? `runner command became idle for ${Math.round(idleTimeoutMs / 1000)}s without a terminal event`
            : returnCode !== 0
              ? stderrText || `runner command failed with exit_code=${returnCode}`
              : `runner stream ended before terminal event${suffix}`;
        const event = buildRunFailedEvent({
          sessionId: requiredString(payload, "session_id"),
          inputId: requiredString(payload, "input_id"),
          sequence: lastSequence + 1,
          message,
          errorType: returnCode !== 0 ? "RunnerCommandError" : "RuntimeError"
        });
        stream.push(sseEvent(event));
      }
      stream.push(null);
    };

    child.once("error", (error) => {
      if (heartbeat) {
        clearTimeout(heartbeat);
      }
      stream.destroy(error);
    });
    child.once("close", (code) => finalize(code ?? 0));

    stream.once("close", () => {
      if (heartbeat) {
        clearTimeout(heartbeat);
      }
      // The consumer went away; the child is being killed, so the watchdogs
      // have nothing left to guard.
      clearWatchdogs();
      if (!child.killed) {
        killChildProcess(child, "SIGTERM");
      }
    });

    return stream;
  }
}
