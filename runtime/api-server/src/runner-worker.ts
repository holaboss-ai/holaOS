import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import path from "node:path";
import { Readable } from "node:stream";

import {
  killChildProcess,
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

function runtimeRoot(): string {
  const configured = (process.env.HOLABOSS_RUNTIME_ROOT ?? "").trim();
  return configured || "/runtime";
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
  return typeof value === "string" ? value.trim().toLowerCase() : "";
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
  if (normalizeSessionKind(payload) !== "task_proposal") {
    return baseTimeoutSeconds;
  }
  return secondsFromEnv(
    "SANDBOX_AGENT_TASK_PROPOSAL_RUN_TIMEOUT_S",
    Math.max(baseTimeoutSeconds, DEFAULT_TASK_PROPOSAL_RUN_TIMEOUT_SECONDS),
    { min: 1, max: 7200 }
  );
}

function runnerIdleTimeoutSeconds(payload: Record<string, unknown>): number {
  const baseIdleTimeoutSeconds = secondsFromEnv("SANDBOX_AGENT_RUN_IDLE_TIMEOUT_S", DEFAULT_IDLE_TIMEOUT_SECONDS, {
    min: 1,
    max: 7200
  });
  if (normalizeSessionKind(payload) !== "task_proposal") {
    return baseIdleTimeoutSeconds;
  }
  return secondsFromEnv(
    "SANDBOX_AGENT_TASK_PROPOSAL_RUN_IDLE_TIMEOUT_S",
    runnerTimeoutSeconds(payload),
    { min: 1, max: 7200 }
  );
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
  env.PATH = prependPathEntries(env.PATH, [
    ...bundledRuntimePythonPathEntries(),
    ...bundledRuntimeNodePathEntries(),
    path.join(runtimeAppRoot(), "api-server", "node_modules", ".bin")
  ]);
  return env;
}

function runtimeApiServerRoot(): string {
  return path.join(runtimeRoot(), "api-server");
}

function defaultRunnerCommand(payload: Record<string, unknown>): string {
  const requestBase64 = quoteShellValue(encodeRequest(payload));
  const runtimeNodeQuoted = quoteShellValue(runtimeNode());
  const runtimeApiServerRootQuoted = quoteShellValue(runtimeApiServerRoot());
  if (runtimeShellKind() === "powershell") {
    return `Set-Location -LiteralPath ${runtimeApiServerRootQuoted}; & ${runtimeNodeQuoted} dist/ts-runner.mjs --request-base64 ${requestBase64}`;
  }
  return `cd ${runtimeApiServerRootQuoted} && ${runtimeNodeQuoted} dist/ts-runner.mjs --request-base64 ${requestBase64}`;
}

function runnerCommand(payload: Record<string, unknown>): string {
  const template = (process.env.SANDBOX_AGENT_RUNNER_COMMAND_TEMPLATE ?? "").trim();
  if (!template) {
    return defaultRunnerCommand(payload);
  }
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
    return rendered;
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
  const command = runnerCommand(payload);
  const env = buildRunnerEnv();
  const workspaceId = typeof payload.workspace_id === "string" ? payload.workspace_id.trim() : "";
  if (workspaceId) {
    env.HOLABOSS_WORKSPACE_ID = workspaceId;
  }
  const child = spawnShellCommand(spawn, command, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
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
    void options.onHeartbeat?.();
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
          killChildProcess(child, "SIGTERM");
        }
      }
    }
    const trailingLine = stdoutBuffer.trim();
    if (trailingLine) {
      const parsed = parseRunnerEventLine(trailingLine);
      if (parsed) {
        resetIdleTimeout();
        events.push(parsed);
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
          killChildProcess(child, "SIGTERM");
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
    const command = runnerCommand(payload);
    const child = spawnShellCommand(spawn, command, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildRunnerEnv(),
    });
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
        if (sawTerminal) {
          if (heartbeat) {
            clearTimeout(heartbeat);
          }
          killChildProcess(child, "SIGTERM");
        }
      }
    });

    const finalize = (returnCode: number) => {
      if (heartbeat) {
        clearTimeout(heartbeat);
      }
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
        const message =
          returnCode !== 0
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
      if (!child.killed) {
        killChildProcess(child, "SIGTERM");
      }
    });

    return stream;
  }
}
