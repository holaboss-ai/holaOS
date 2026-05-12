import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  migrateLegacyWorkspaceStatePath,
} from "./workspace-bundle-paths.js";

const WORKSPACE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_STATE_FILE_NAME = "harness-session-state.json";
const SESSION_STATE_VERSION = 2;
const SESSION_STATE_SESSION_KEY = "session_id";
const LEGACY_SESSION_STATE_MAIN_SESSION_KEY = "main_session_id";
const SESSION_STATE_HARNESS_SESSIONS_KEY = "harness_sessions";

type LoggerLike = Pick<typeof console, "warn">;
type HarnessSessionStateMap = Map<string, string>;

function defaultLogger(): LoggerLike {
  return console;
}

function resolveSandboxRoot(): string {
  const raw = (process.env.HB_SANDBOX_ROOT ?? "").trim();
  if (!raw) {
    return "/holaboss";
  }
  const normalized = raw.replace(/\/+$/, "");
  return normalized || "/holaboss";
}

export function sanitizeWorkspaceId(workspaceId: string): string {
  const value = workspaceId.trim();
  if (!value) {
    throw new Error("workspace_id is required");
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error("workspace_id must not contain path separators");
  }
  if (!WORKSPACE_SEGMENT_PATTERN.test(value)) {
    throw new Error("workspace_id contains invalid characters");
  }
  return value;
}

export function workspaceDirForId(workspaceId: string): string {
  return path.join(resolveSandboxRoot(), "workspace", sanitizeWorkspaceId(workspaceId));
}

export function workspaceSessionStatePath(workspaceDir: string): string {
  return migrateLegacyWorkspaceStatePath({
    workspaceDir,
    relativeSegments: [SESSION_STATE_FILE_NAME],
    legacyRelativeSegments: [".holaboss", SESSION_STATE_FILE_NAME],
  });
}

/** Filesystem path of the workspace's shared data SQLite. Single file
 *  per workspace; module apps write tables prefixed with their app id
 *  (twitter_posts, linkedin_posts, …). The path is injected into app
 *  processes via the WORKSPACE_DB_PATH env var. */
export function workspaceDataDbPath(workspaceDir: string): string {
  return migrateLegacyWorkspaceStatePath({
    workspaceDir,
    relativeSegments: ["data.db"],
    legacyRelativeSegments: [".holaboss", "data.db"],
  });
}

/** Ensure the workspace's shared data SQLite exists, with WAL enabled
 *  and a `_workspace_meta` row anchoring the schema version.
 *
 *  data.db used to be created lazily by the first module app to call
 *  getDb() — which left a window where workspace-level data tools saw
 *  "data.db does not exist yet" even though the workspace had been
 *  provisioned and apps were installed. The data layer is a
 *  workspace-level resource, so its existence is the runtime's
 *  responsibility, not any individual app's.
 *
 *  Idempotent: runs CREATE TABLE IF NOT EXISTS and INSERT OR IGNORE,
 *  so calling it on every workspace boot or app start is a no-op
 *  after the first invocation. */
export function ensureWorkspaceDataDb(workspaceDir: string): string {
  const dbPath = workspaceDataDbPath(workspaceDir)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  try {
    db.pragma("journal_mode = WAL")
    db.pragma("foreign_keys = ON")
    db.exec(`
      CREATE TABLE IF NOT EXISTS _workspace_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    db.prepare(
      `INSERT OR IGNORE INTO _workspace_meta (key, value) VALUES ('schema_version', '1')`
    ).run()
    db.prepare(
      `INSERT OR IGNORE INTO _workspace_meta (key, value) VALUES ('created_at', datetime('now'))`
    ).run()
  } finally {
    db.close()
  }

  return dbPath
}

function normalizeHarness(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function readHarnessSessionStateMap(
  state: Record<string, unknown> | null,
  options: { logger?: LoggerLike } = {}
): HarnessSessionStateMap {
  const logger = options.logger ?? defaultLogger();
  const sessions = new Map<string, string>();
  if (!state) {
    return sessions;
  }

  const harnessSessions = state[SESSION_STATE_HARNESS_SESSIONS_KEY];
  if (harnessSessions && typeof harnessSessions === "object" && !Array.isArray(harnessSessions)) {
    for (const [harness, entry] of Object.entries(harnessSessions)) {
      const normalizedHarness = normalizeHarness(harness);
      if (!normalizedHarness || !entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const sessionId = entry[SESSION_STATE_SESSION_KEY] ?? entry[LEGACY_SESSION_STATE_MAIN_SESSION_KEY];
      if (typeof sessionId === "string" && sessionId.trim()) {
        sessions.set(normalizedHarness, sessionId.trim());
      }
    }
    return sessions;
  }

  const legacyHarness = normalizeHarness(state.harness);
  const legacySessionId = state[SESSION_STATE_SESSION_KEY] ?? state[LEGACY_SESSION_STATE_MAIN_SESSION_KEY];
  if (legacyHarness && typeof legacySessionId === "string" && legacySessionId.trim()) {
    sessions.set(legacyHarness, legacySessionId.trim());
    return sessions;
  }

  if (
    state.harness !== undefined ||
    state[SESSION_STATE_SESSION_KEY] !== undefined ||
    state[LEGACY_SESSION_STATE_MAIN_SESSION_KEY] !== undefined
  ) {
    logger.warn("Ignoring incomplete legacy workspace session state payload");
  }
  return sessions;
}

export function readWorkspaceSessionState(
  workspaceDir: string,
  options: { logger?: LoggerLike } = {}
): Record<string, unknown> | null {
  const logger = options.logger ?? defaultLogger();
  const statePath = workspaceSessionStatePath(workspaceDir);
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn(`Ignoring invalid workspace session state path=${statePath}`);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logger.warn(`Ignoring non-object workspace session state path=${statePath}`);
    return null;
  }
  return parsed as Record<string, unknown>;
}

export function readWorkspaceHarnessSessionId(params: {
  workspaceDir: string;
  harness: string;
  logger?: LoggerLike;
}): string | null {
  const logger = params.logger ?? defaultLogger();
  const state = readWorkspaceSessionState(params.workspaceDir, { logger });
  const requestedHarness = normalizeHarness(params.harness);
  if (!requestedHarness) {
    return null;
  }
  return readHarnessSessionStateMap(state, { logger }).get(requestedHarness) ?? null;
}

export function persistWorkspaceHarnessSessionId(params: {
  workspaceDir: string;
  harness: string;
  sessionId: string;
  logger?: LoggerLike;
}): void {
  const logger = params.logger ?? defaultLogger();
  const resolvedHarness = normalizeHarness(params.harness);
  const resolvedSessionId = params.sessionId.trim();
  if (!resolvedHarness || !resolvedSessionId) {
    return;
  }

  const existingState = readWorkspaceSessionState(params.workspaceDir, { logger });
  const sessions = readHarnessSessionStateMap(existingState, { logger });
  sessions.set(resolvedHarness, resolvedSessionId);

  const statePath = workspaceSessionStatePath(params.workspaceDir);
  const payload = {
    version: SESSION_STATE_VERSION,
    [SESSION_STATE_HARNESS_SESSIONS_KEY]: Object.fromEntries(
      [...sessions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([harness, sessionId]) => [harness, { [SESSION_STATE_SESSION_KEY]: sessionId }])
    )
  };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload), "utf8");
    fs.renameSync(tempPath, statePath);
  } catch (error) {
    logger.warn(
      `Failed to persist workspace session state path=${statePath} error=${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function clearWorkspaceHarnessSessionId(params: {
  workspaceDir: string;
  harness: string;
  logger?: LoggerLike;
}): void {
  const logger = params.logger ?? defaultLogger();
  const resolvedHarness = normalizeHarness(params.harness);
  if (!resolvedHarness) {
    return;
  }

  const existingState = readWorkspaceSessionState(params.workspaceDir, { logger });
  const sessions = readHarnessSessionStateMap(existingState, { logger });
  if (!sessions.delete(resolvedHarness)) {
    return;
  }

  const statePath = workspaceSessionStatePath(params.workspaceDir);
  if (sessions.size === 0) {
    try {
      fs.unlinkSync(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(
          `Failed to clear workspace session state path=${statePath} error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return;
  }

  const payload = {
    version: SESSION_STATE_VERSION,
    [SESSION_STATE_HARNESS_SESSIONS_KEY]: Object.fromEntries(
      [...sessions.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([harness, sessionId]) => [harness, { [SESSION_STATE_SESSION_KEY]: sessionId }])
    )
  };

  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(payload), "utf8");
    fs.renameSync(tempPath, statePath);
  } catch (error) {
    logger.warn(
      `Failed to clear workspace session state path=${statePath} error=${error instanceof Error ? error.message : String(error)}`
    );
  }
}
