// Shared logging contract for the Remote API request path. Dependency-free so
// both the client and the server bindings can use it. The runtime injects its
// pino logger and the desktop injects its own; when none is supplied a
// structured console logger is used so logs are never silently dropped.

export type RemoteApiLogLevel = "debug" | "info" | "warn" | "error";

export type RemoteApiLogFields = Record<string, unknown>;

export interface RemoteApiLogger {
  debug(event: string, fields?: RemoteApiLogFields): void;
  info(event: string, fields?: RemoteApiLogFields): void;
  warn(event: string, fields?: RemoteApiLogFields): void;
  error(event: string, fields?: RemoteApiLogFields): void;
}

const CONSOLE_METHOD: Record<RemoteApiLogLevel, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "info",
  warn: "warn",
  error: "error",
};

/** Structured-JSON console logger used when the host supplies none. */
export function createConsoleRemoteApiLogger(
  bindings: RemoteApiLogFields = {}
): RemoteApiLogger {
  const emit = (level: RemoteApiLogLevel, event: string, fields?: RemoteApiLogFields) => {
    const line = JSON.stringify({ level, event, ...bindings, ...fields });
    // eslint-disable-next-line no-console -- structured JSON, not ad-hoc logging
    console[CONSOLE_METHOD[level]](line);
  };
  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

/** No-op logger for callers that want to silence the path entirely. */
export const noopRemoteApiLogger: RemoteApiLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export const REQUEST_ID_HEADER = "x-request-id";

export function generateRequestId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Normalizes an error into stable log fields (oRPC errors carry `code`). */
export function errorLogFields(error: unknown): RemoteApiLogFields {
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      status?: unknown;
    };
    return {
      errorCode: typeof candidate.code === "string" ? candidate.code : undefined,
      errorName: typeof candidate.name === "string" ? candidate.name : undefined,
      errorMessage:
        typeof candidate.message === "string" ? candidate.message : String(error),
      errorStatus:
        typeof candidate.status === "number" ? candidate.status : undefined,
    };
  }
  return { errorMessage: String(error) };
}

/** Best-effort extraction of a workspace id from a procedure input for log context. */
export function workspaceIdFromInput(input: unknown): string | undefined {
  if (input && typeof input === "object" && "workspaceId" in input) {
    const value = (input as { workspaceId?: unknown }).workspaceId;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}
