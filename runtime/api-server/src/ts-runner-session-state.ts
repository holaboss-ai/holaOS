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

/**
 * Map keys are persisted as `harness@<absolute-cwd>` (or bare `harness` for
 * the legacy single-cwd format). Lowercasing the whole key collapses
 * `pi@/Users/you/Holaboss/...` and `pi@/users/you/holaboss/...` into
 * the same entry, but `harnessSessionMapKey()` produces case-preserved keys
 * (it only `path.resolve()`s the cwd). That mismatch made every project
 * lookup with a non-all-lowercase path miss the map and fall through to the
 * bare-harness pi key — which then pointed at General's JSONL.
 *
 * Normalize the harness portion only; keep the cwd in its resolved form so
 * reader and writer agree.
 */
function normalizeHarnessMapKey(key: unknown): string {
  if (typeof key !== "string") return "";
  const trimmed = key.trim();
  if (!trimmed) return "";
  const atIndex = trimmed.indexOf("@");
  if (atIndex < 0) {
    return trimmed.toLowerCase();
  }
  const harness = trimmed.slice(0, atIndex).toLowerCase();
  const cwd = trimmed.slice(atIndex + 1);
  // Match harnessSessionMapKey()'s resolve so reader and writer produce
  // byte-identical keys.
  return `${harness}@${path.resolve(cwd)}`;
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
      const normalizedKey = normalizeHarnessMapKey(harness);
      if (!normalizedKey || !entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const sessionId = entry[SESSION_STATE_SESSION_KEY] ?? entry[LEGACY_SESSION_STATE_MAIN_SESSION_KEY];
      if (typeof sessionId === "string" && sessionId.trim()) {
        sessions.set(normalizedKey, sessionId.trim());
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

/**
 * Composite key for the harness session map. Project-bound chats and
 * General-bucket chats in the same workspace run with different cwds and
 * therefore must have different persisted pi-sessions — otherwise the
 * first run's cwd gets baked into the session JSONL and every later run
 * resumes that file, inheriting the wrong cwd ("Current working
 * directory: <X>" in the system prompt, pwd from Bash, file-tool roots…).
 *
 * For backward compatibility, callers that don't pass `agentCwd` (or pass
 * it equal to the workspace dir) still hit the legacy bare-harness key —
 * so existing single-cwd state files keep working until they're naturally
 * replaced.
 */
function harnessSessionMapKey(harness: string, agentCwd?: string | null): string {
  const normalizedCwd = (agentCwd ?? "").trim();
  if (!normalizedCwd) return harness;
  return `${harness}@${path.resolve(normalizedCwd)}`;
}

/**
 * Returns `null` when the agentCwd represents the legacy "agent runs in the
 * workspace" case (no agentCwd, or agentCwd equals workspaceDir). Used by
 * the persist/read helpers to collapse that case onto the bare-harness key
 * so legacy single-cwd state files keep their existing on-disk shape.
 *
 * For project chats and General chats rooted at the managed workspace root
 * (agentCwd != workspaceDir) the value is returned as-is and a scoped key
 * gets used.
 */
function scopedCwdForPersistence(
  agentCwd: string | null | undefined,
  workspaceDir: string,
): string | null {
  const trimmed = (agentCwd ?? "").trim();
  if (!trimmed) return null;
  if (path.resolve(trimmed) === path.resolve(workspaceDir)) {
    return null;
  }
  return trimmed;
}

export function readWorkspaceHarnessSessionId(params: {
  workspaceDir: string;
  harness: string;
  agentCwd?: string | null;
  /**
   * When false, return only the cwd-scoped session id without any fall-
   * through to the legacy bare-harness key, regardless of whether
   * agentCwd matches workspaceDir. Use this when the caller has decided
   * the bare-harness entry is semantically wrong (e.g. a project chat
   * that must NOT inherit General's session). Defaults to true.
   */
  allowLegacyFallback?: boolean;
  logger?: LoggerLike;
}): string | null {
  const logger = params.logger ?? defaultLogger();
  const state = readWorkspaceSessionState(params.workspaceDir, { logger });
  const requestedHarness = normalizeHarness(params.harness);
  if (!requestedHarness) {
    return null;
  }
  const map = readHarnessSessionStateMap(state, { logger });
  // Treat agentCwd === workspaceDir as the legacy unscoped case so the
  // lookup keys against the same bare-harness entry that the persist path
  // writes. Project / General (workspace root) cwds keep their scoped key.
  const persistenceCwd = scopedCwdForPersistence(
    params.agentCwd,
    params.workspaceDir,
  );
  const scoped = map.get(harnessSessionMapKey(requestedHarness, persistenceCwd));
  if (scoped) {
    return scoped;
  }
  if (params.allowLegacyFallback === false) {
    return null;
  }
  // Only fall back to the bare-harness key when the caller is workspace-
  // scoped (no cwd or cwd === workspace_dir). For project chats and
  // HOME-rooted General chats the bare entry was written at a different
  // cwd and resuming it would bake the wrong cwd into the snapshot
  // header — exactly the bug we are fixing across this audit.
  if (persistenceCwd !== null) {
    return null;
  }
  return map.get(requestedHarness) ?? null;
}

export function persistWorkspaceHarnessSessionId(params: {
  workspaceDir: string;
  harness: string;
  sessionId: string;
  agentCwd?: string | null;
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
  // Collapse agentCwd === workspaceDir to the bare-harness key so the
  // legacy single-cwd state file shape is preserved when there is no
  // actual cwd split. Project / HOME chats persist under `pi@<cwd>`.
  const persistenceCwd = scopedCwdForPersistence(
    params.agentCwd,
    params.workspaceDir,
  );
  sessions.set(
    harnessSessionMapKey(resolvedHarness, persistenceCwd),
    resolvedSessionId,
  );

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
  agentCwd?: string | null;
  logger?: LoggerLike;
}): void {
  const logger = params.logger ?? defaultLogger();
  const resolvedHarness = normalizeHarness(params.harness);
  if (!resolvedHarness) {
    return;
  }

  const existingState = readWorkspaceSessionState(params.workspaceDir, { logger });
  const sessions = readHarnessSessionStateMap(existingState, { logger });
  const persistenceCwd = scopedCwdForPersistence(
    params.agentCwd,
    params.workspaceDir,
  );
  const scopedKey = harnessSessionMapKey(resolvedHarness, persistenceCwd);
  // Clear both the cwd-scoped entry and the legacy bare-harness entry if
  // either exists; this keeps `clear` idempotent across the upgrade.
  const hadScoped = sessions.delete(scopedKey);
  const hadLegacy = sessions.delete(resolvedHarness);
  if (!hadScoped && !hadLegacy) {
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
