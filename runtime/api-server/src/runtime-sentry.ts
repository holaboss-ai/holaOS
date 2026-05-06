import * as Sentry from "@sentry/node";
import fs from "node:fs";
import path from "node:path";

type RuntimeSentryLevel = "fatal" | "error" | "warning" | "log" | "info" | "debug";
const RUNTIME_SENTRY_LOG_TAIL_BYTES = 64 * 1024;
const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /cookie/i,
  /^authorization$/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /refresh[_-]?token/i,
  /access[_-]?token/i,
];
const SENSITIVE_TEXT_ASSIGNMENT_PATTERN =
  /((?:token|secret|password|cookie|authorization|api[_-]?key|private[_-]?key|refresh[_-]?token|access[_-]?token)[^:=\n\r]{0,64}[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const AUTHORIZATION_BEARER_PATTERN =
  /(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+(?:\s+[^\s,;]+)?/gi;

export interface RuntimeSentryAttachment {
  filename: string;
  data: string | Uint8Array;
  contentType?: string;
}

export interface RuntimeSentryCaptureOptions {
  error: unknown;
  level?: RuntimeSentryLevel;
  tags?: Record<string, unknown>;
  extras?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | null | undefined>;
  fingerprint?: string[];
  attachments?: RuntimeSentryAttachment[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
    );
  }
  return value === undefined ? null : String(value);
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.trim();
  if (!normalized) {
    return false;
  }
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function redactRuntimeSentryValue(
  value: unknown,
  keyName = "",
): unknown {
  if (shouldRedactKey(keyName)) {
    if (value === null || value === undefined) {
      return value;
    }
    return REDACTED_VALUE;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactRuntimeSentryValue(entry));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactRuntimeSentryValue(entry, key),
      ]),
    );
  }

  return value;
}

export function redactRuntimeSentryText(text: string): string {
  return text
    .replace(AUTHORIZATION_BEARER_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(
      SENSITIVE_TEXT_ASSIGNMENT_PATTERN,
      `$1${REDACTED_VALUE}`,
    );
}

function normalizeTagValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function normalizeError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  const message =
    typeof value === "string"
      ? value
      : JSON.stringify(jsonValue(value)) ?? "Unknown runtime error";
  return new Error(message);
}

function stringDiagnostic(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = redactRuntimeSentryText(value).trim();
  return normalized || null;
}

function numberDiagnostic(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorDiagnostic(value: unknown): Record<string, unknown> | null {
  if (!(value instanceof Error) && !isRecord(value)) {
    return null;
  }
  const source: Record<string, unknown> = value instanceof Error
    ? ((value as unknown as Record<string, unknown>) ?? {})
    : value;
  const diagnostic: Record<string, unknown> = {};
  const name = stringDiagnostic(
    value instanceof Error ? value.name : source.name,
  );
  const message = stringDiagnostic(
    value instanceof Error ? value.message : source.message,
  );
  const code = stringDiagnostic(source.code);
  if (name) {
    diagnostic.name = name;
  }
  if (message) {
    diagnostic.message = message;
  }
  if (code) {
    diagnostic.code = code;
  }
  return Object.keys(diagnostic).length > 0 ? diagnostic : null;
}

function socketDiagnostic(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const diagnostic: Record<string, unknown> = {};
  const localAddress = stringDiagnostic(value.localAddress);
  const remoteAddress = stringDiagnostic(value.remoteAddress);
  const remoteFamily = stringDiagnostic(value.remoteFamily);
  const localPort = numberDiagnostic(value.localPort);
  const remotePort = numberDiagnostic(value.remotePort);
  const timeout = numberDiagnostic(value.timeout);
  const bytesWritten = numberDiagnostic(value.bytesWritten);
  const bytesRead = numberDiagnostic(value.bytesRead);
  if (localAddress) {
    diagnostic.localAddress = localAddress;
  }
  if (localPort !== null) {
    diagnostic.localPort = localPort;
  }
  if (remoteAddress) {
    diagnostic.remoteAddress = remoteAddress;
  }
  if (remotePort !== null) {
    diagnostic.remotePort = remotePort;
  }
  if (remoteFamily) {
    diagnostic.remoteFamily = remoteFamily;
  }
  if (timeout !== null) {
    diagnostic.timeout = timeout;
  }
  if (bytesWritten !== null) {
    diagnostic.bytesWritten = bytesWritten;
  }
  if (bytesRead !== null) {
    diagnostic.bytesRead = bytesRead;
  }
  return Object.keys(diagnostic).length > 0 ? diagnostic : null;
}

export function extractRuntimeFetchErrorDiagnostics(
  error: unknown,
): Record<string, unknown> | null {
  const diagnostic: Record<string, unknown> = {};
  const errorDetails = errorDiagnostic(error);
  if (errorDetails) {
    diagnostic.error = errorDetails;
  }
  const causeValue =
    error instanceof Error
      ? error.cause
      : isRecord(error)
        ? error.cause
        : undefined;
  const causeDetails = errorDiagnostic(causeValue);
  if (causeDetails) {
    diagnostic.cause = causeDetails;
  }
  const socketDetails = socketDiagnostic(
    isRecord(causeValue)
      ? causeValue.socket
      : isRecord(error)
        ? error.socket
        : undefined,
  );
  if (socketDetails) {
    diagnostic.socket = socketDetails;
  }
  return Object.keys(diagnostic).length > 0 ? diagnostic : null;
}

function envPath(name: string): string {
  return process.env[name]?.trim() || "";
}

function safeStat(filePath: string): Record<string, unknown> {
  if (!filePath) {
    return {
      path: null,
      exists: false,
    };
  }
  try {
    const stats = fs.statSync(filePath);
    return {
      path: path.basename(filePath),
      exists: true,
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return {
      path: path.basename(filePath),
      exists: false,
    };
  }
}

function readFileTail(filePath: string, maxBytes: number): string | null {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  const buffer = fs.readFileSync(filePath);
  const start = Math.max(0, buffer.length - maxBytes);
  return buffer.subarray(start).toString("utf8");
}

function runtimeSentrySnapshot(): Record<string, unknown> {
  const runtimeDbPath =
    envPath("HOLABOSS_HOST_STATE_DB_PATH")
    || envPath("HOLABOSS_RUNTIME_DB_PATH");
  const runtimeLogPath = envPath("HOLABOSS_RUNTIME_LOG_PATH");
  const runtimeConfigPath = envPath("HOLABOSS_RUNTIME_CONFIG_PATH");
  return {
    captured_at: new Date().toISOString(),
    runtime: {
      embedded_runtime: process.env.HOLABOSS_EMBEDDED_RUNTIME === "1",
      workflow_backend: process.env.HOLABOSS_RUNTIME_WORKFLOW_BACKEND ?? null,
      runtime_version: process.env.HOLABOSS_RUNTIME_VERSION ?? null,
      sentry_environment: process.env.SENTRY_ENVIRONMENT ?? null,
      desktop_launch_id: process.env.HOLABOSS_DESKTOP_LAUNCH_ID ?? null,
      desktop_app_version: process.env.HOLABOSS_DESKTOP_APP_VERSION ?? null,
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
    },
    files: {
      host_state_db: safeStat(runtimeDbPath),
      runtime_log: safeStat(runtimeLogPath),
      runtime_config: safeStat(runtimeConfigPath),
    },
  };
}

function redactedRuntimeConfigAttachment(): RuntimeSentryAttachment | null {
  const runtimeConfigPath = envPath("HOLABOSS_RUNTIME_CONFIG_PATH");
  if (!runtimeConfigPath || !fs.existsSync(runtimeConfigPath)) {
    return null;
  }

  let data = "";
  try {
    const rawDocument = fs.readFileSync(runtimeConfigPath, "utf8");
    const parsed = JSON.parse(rawDocument) as unknown;
    data = `${JSON.stringify(redactRuntimeSentryValue(parsed), null, 2)}\n`;
  } catch {
    data = `${JSON.stringify(
      {
        error: "runtime-config.json could not be parsed for redaction.",
      },
      null,
      2,
    )}\n`;
  }

  return {
    filename: "runtime-config.redacted.json",
    data,
    contentType: "application/json",
  };
}

function runtimeLogTailAttachment(): RuntimeSentryAttachment | null {
  const runtimeLogPath = envPath("HOLABOSS_RUNTIME_LOG_PATH");
  const tail = readFileTail(runtimeLogPath, RUNTIME_SENTRY_LOG_TAIL_BYTES);
  if (!tail) {
    return null;
  }
  return {
    filename: "runtime-log-tail.txt",
    data: redactRuntimeSentryText(tail),
    contentType: "text/plain",
  };
}

export function buildRuntimeSentryDiagnostics(): {
  attachments: RuntimeSentryAttachment[];
  contexts: Record<string, Record<string, unknown>>;
} {
  const snapshot = runtimeSentrySnapshot();
  const attachments: RuntimeSentryAttachment[] = [
    {
      filename: "runtime-diagnostics.json",
      data: `${JSON.stringify(snapshot, null, 2)}\n`,
      contentType: "application/json",
    },
  ];
  const logTailAttachment = runtimeLogTailAttachment();
  if (logTailAttachment) {
    attachments.push(logTailAttachment);
  }
  const configAttachment = redactedRuntimeConfigAttachment();
  if (configAttachment) {
    attachments.push(configAttachment);
  }
  return {
    attachments,
    contexts: {
      runtime_process: jsonValue(snapshot.runtime) as Record<string, unknown>,
      runtime_files: jsonValue(snapshot.files) as Record<string, unknown>,
    },
  };
}

export function captureRuntimeException(
  options: RuntimeSentryCaptureOptions,
): void {
  const error = normalizeError(options.error);
  Sentry.withScope((scope) => {
    if (options.level) {
      scope.setLevel(options.level);
    }
    if (Array.isArray(options.fingerprint) && options.fingerprint.length > 0) {
      scope.setFingerprint(options.fingerprint.filter((item) => item.trim()));
    }
    for (const [key, value] of Object.entries(options.tags ?? {})) {
      const normalized = normalizeTagValue(value);
      if (normalized) {
        scope.setTag(key, normalized);
      }
    }
    for (const [key, value] of Object.entries(options.extras ?? {})) {
      scope.setExtra(key, jsonValue(value));
    }
    for (const [key, value] of Object.entries(options.contexts ?? {})) {
      if (value && Object.keys(value).length > 0) {
        scope.setContext(key, jsonValue(value) as Record<string, unknown>);
      }
    }
    for (const attachment of options.attachments ?? []) {
      scope.addAttachment({
        filename: attachment.filename,
        data: attachment.data,
        contentType: attachment.contentType,
      });
    }
    Sentry.captureException(error);
  });
}
