import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"

export type WorkspaceLocation = "local" | "cloud"

export interface WorkspaceRegistryRecord {
  id: string
  location: WorkspaceLocation
  name: string
  status: string
  harness: string | null
  error_message: string | null
  onboarding_status: string
  onboarding_session_id: string | null
  onboarding_completed_at: string | null
  onboarding_completion_summary: string | null
  onboarding_requested_at: string | null
  onboarding_requested_by: string | null
  created_at: string | null
  updated_at: string | null
  deleted_at_utc: string | null
  workspace_path?: string | null
  folder_state?: "healthy" | "missing" | null
}

export interface WorkspaceRegistryListResponse {
  items: WorkspaceRegistryRecord[]
  total: number
  limit: number
  offset: number
}

export interface LocalWorkspaceRegistry {
  getWorkspaceRecord(workspaceId: string): WorkspaceRegistryRecord | null
  listCachedWorkspaces(): WorkspaceRegistryListResponse
}

export interface LocalWorkspaceRegistryOptions {
  controlPlaneDatabasePath: () => string
  location: WorkspaceLocation
}

export interface LocalControlPlaneDatabaseBootstrapOptions {
  controlPlaneDatabasePath: () => string
  runtimeDatabasePath: () => string
  workspaceRoot: () => string
}

export type RuntimeUserProfileNameSource = "manual" | "agent" | "authFallback"

export interface RuntimeUserProfileRecord {
  profileId: string
  name: string | null
  nameSource: RuntimeUserProfileNameSource | null
  createdAt: string | null
  updatedAt: string | null
}

export interface RuntimeUserProfileUpdate {
  profileId?: string | null
  name?: string | null
  nameSource?: RuntimeUserProfileNameSource | null
}

export interface LocalRuntimeUserProfileStore {
  getProfile(): Promise<RuntimeUserProfileRecord>
  setProfile(payload: RuntimeUserProfileUpdate): Promise<RuntimeUserProfileRecord>
  applyAuthFallback(
    name: string,
    profileId?: string,
  ): Promise<RuntimeUserProfileRecord>
}

export interface LocalRuntimeUserProfileStoreOptions {
  controlPlaneDatabasePath: () => string
}

function utcNowIso(): string {
  return new Date().toISOString()
}

function tableExists(database: Database.Database, tableName: string): boolean {
  const row = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(tableName)
  return Boolean(row)
}

function ensureControlPlaneDatabaseSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      harness TEXT,
      error_message TEXT,
      onboarding_status TEXT NOT NULL,
      onboarding_session_id TEXT,
      onboarding_completed_at TEXT,
      onboarding_completion_summary TEXT,
      onboarding_requested_at TEXT,
      onboarding_requested_by TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at_utc TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_updated
      ON workspaces (updated_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS runtime_user_profiles (
      profile_id TEXT PRIMARY KEY,
      name TEXT,
      name_source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function openControlPlaneDatabase(controlPlaneDatabasePath: string): Database.Database {
  fs.mkdirSync(path.dirname(controlPlaneDatabasePath), { recursive: true })
  const database = new Database(controlPlaneDatabasePath)
  database.pragma("journal_mode = WAL")
  database.pragma("busy_timeout = 5000")
  database.pragma("foreign_keys = ON")
  ensureControlPlaneDatabaseSchema(database)
  return database
}

function mapWorkspaceRegistryRow(
  row: Record<string, unknown>,
  location: WorkspaceLocation,
): WorkspaceRegistryRecord {
  return {
    id: String(row.id ?? ""),
    location,
    name: String(row.name ?? ""),
    status: String(row.status ?? "unknown"),
    harness: row.harness == null ? null : String(row.harness),
    error_message: row.error_message == null ? null : String(row.error_message),
    onboarding_status: String(row.onboarding_status ?? "complete"),
    onboarding_session_id:
      row.onboarding_session_id == null
        ? null
        : String(row.onboarding_session_id),
    onboarding_completed_at:
      row.onboarding_completed_at == null
        ? null
        : String(row.onboarding_completed_at),
    onboarding_completion_summary:
      row.onboarding_completion_summary == null
        ? null
        : String(row.onboarding_completion_summary),
    onboarding_requested_at:
      row.onboarding_requested_at == null
        ? null
        : String(row.onboarding_requested_at),
    onboarding_requested_by:
      row.onboarding_requested_by == null
        ? null
        : String(row.onboarding_requested_by),
    created_at: row.created_at == null ? null : String(row.created_at),
    updated_at: row.updated_at == null ? null : String(row.updated_at),
    deleted_at_utc:
      row.deleted_at_utc == null ? null : String(row.deleted_at_utc),
    workspace_path:
      row.workspace_path == null ? null : String(row.workspace_path),
  }
}

function runtimeUserProfileNameSourceFromStored(
  value: unknown,
): RuntimeUserProfileNameSource | null {
  if (value === "manual" || value === "agent") {
    return value
  }
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (!normalized) {
    return null
  }
  if (normalized === "manual" || normalized === "agent") {
    return normalized
  }
  if (normalized === "auth_fallback") {
    return "authFallback"
  }
  return null
}

function runtimeUserProfileNameSourceToStored(
  value: RuntimeUserProfileNameSource | null | undefined,
): string | null | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (value === "authFallback") {
    return "auth_fallback"
  }
  return value
}

function mapRuntimeUserProfileRow(
  row: Record<string, unknown> | undefined,
  profileId = "default",
): RuntimeUserProfileRecord {
  return {
    profileId:
      typeof row?.profile_id === "string" && row.profile_id.trim()
        ? row.profile_id
        : profileId,
    name:
      typeof row?.name === "string" && row.name.trim() ? row.name : null,
    nameSource: runtimeUserProfileNameSourceFromStored(row?.name_source),
    createdAt:
      typeof row?.created_at === "string" && row.created_at.trim()
        ? row.created_at
        : null,
    updatedAt:
      typeof row?.updated_at === "string" && row.updated_at.trim()
        ? row.updated_at
        : null,
  }
}

function canonicalWorkspacePathFromLegacyRow(
  row: Record<string, unknown>,
  workspaceRoot: string,
): string {
  const explicitPath =
    typeof row.workspace_path === "string" && row.workspace_path.trim()
      ? row.workspace_path.trim()
      : null
  if (explicitPath) {
    return explicitPath
  }
  const workspaceId = typeof row.id === "string" ? row.id.trim() : ""
  return path.join(workspaceRoot, workspaceId)
}

export function bootstrapLocalControlPlaneDatabase(
  options: LocalControlPlaneDatabaseBootstrapOptions,
): void {
  const controlPlanePath = options.controlPlaneDatabasePath()
  const runtimePath = options.runtimeDatabasePath()
  const database = openControlPlaneDatabase(controlPlanePath)
  try {
    if (path.resolve(controlPlanePath) === path.resolve(runtimePath)) {
      return
    }
    if (!fs.existsSync(runtimePath)) {
      return
    }

    const legacy = new Database(runtimePath, { readonly: true })
    try {
      if (tableExists(legacy, "workspaces")) {
        const rows = legacy.prepare("SELECT * FROM workspaces").all() as Array<
          Record<string, unknown>
        >
        const insert = database.prepare(`
          INSERT OR IGNORE INTO workspaces (
            id,
            workspace_path,
            name,
            status,
            harness,
            error_message,
            onboarding_status,
            onboarding_session_id,
            onboarding_completed_at,
            onboarding_completion_summary,
            onboarding_requested_at,
            onboarding_requested_by,
            created_at,
            updated_at,
            deleted_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const row of rows) {
          insert.run(
            row.id,
            canonicalWorkspacePathFromLegacyRow(
              row,
              options.workspaceRoot(),
            ),
            row.name,
            row.status,
            row.harness ?? null,
            row.error_message ?? null,
            row.onboarding_status ?? "complete",
            row.onboarding_session_id ?? null,
            row.onboarding_completed_at ?? null,
            row.onboarding_completion_summary ?? null,
            row.onboarding_requested_at ?? null,
            row.onboarding_requested_by ?? null,
            row.created_at ?? null,
            row.updated_at ?? null,
            row.deleted_at_utc ?? null,
          )
        }
      }

      if (tableExists(legacy, "runtime_user_profiles")) {
        const rows = legacy
          .prepare("SELECT * FROM runtime_user_profiles")
          .all() as Array<Record<string, unknown>>
        const insert = database.prepare(`
          INSERT OR IGNORE INTO runtime_user_profiles (
            profile_id,
            name,
            name_source,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        for (const row of rows) {
          insert.run(
            row.profile_id,
            row.name ?? null,
            row.name_source ?? null,
            row.created_at,
            row.updated_at,
          )
        }
      }
    } finally {
      legacy.close()
    }
  } finally {
    database.close()
  }
}

export function createLocalWorkspaceRegistry(
  options: LocalWorkspaceRegistryOptions,
): LocalWorkspaceRegistry {
  function getWorkspaceRecord(
    workspaceId: string,
  ): WorkspaceRegistryRecord | null {
    const database = new Database(options.controlPlaneDatabasePath(), {
      readonly: true,
    })
    try {
      const row = database
        .prepare(
          `
          SELECT
            id,
            workspace_path,
            name,
            status,
            harness,
            error_message,
            onboarding_status,
            onboarding_session_id,
            onboarding_completed_at,
            onboarding_completion_summary,
            onboarding_requested_at,
            onboarding_requested_by,
            created_at,
            updated_at,
            deleted_at_utc
          FROM workspaces
          WHERE id = @id
        `,
        )
        .get({ id: workspaceId }) as Record<string, unknown> | undefined
      if (!row) {
        return null
      }
      return mapWorkspaceRegistryRow(row, options.location)
    } finally {
      database.close()
    }
  }

  function listCachedWorkspaces(): WorkspaceRegistryListResponse {
    const empty: WorkspaceRegistryListResponse = {
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    }
    let database: Database.Database | null = null
    try {
      database = new Database(options.controlPlaneDatabasePath(), {
        readonly: true,
      })
      if (!tableExists(database, "workspaces")) {
        return empty
      }
      const rows = database
        .prepare(
          `SELECT id, workspace_path, name, status, harness, error_message,
                  onboarding_status, onboarding_session_id,
                  onboarding_completed_at, onboarding_completion_summary,
                  onboarding_requested_at, onboarding_requested_by,
                  created_at, updated_at, deleted_at_utc
           FROM workspaces
           WHERE deleted_at_utc IS NULL
           ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
           LIMIT 100`,
        )
        .all() as Array<Record<string, unknown>>
      const items = rows.map((row) =>
        mapWorkspaceRegistryRow(row, options.location),
      )
      return { items, total: items.length, limit: 100, offset: 0 }
    } catch {
      return empty
    } finally {
      try {
        database?.close()
      } catch {
        // ignore
      }
    }
  }

  return {
    getWorkspaceRecord,
    listCachedWorkspaces,
  }
}

export function createLocalRuntimeUserProfileStore(
  options: LocalRuntimeUserProfileStoreOptions,
): LocalRuntimeUserProfileStore {
  function getProfileRecord(profileId = "default"): RuntimeUserProfileRecord {
    const database = openControlPlaneDatabase(options.controlPlaneDatabasePath())
    try {
      const row = database
        .prepare(
          "SELECT * FROM runtime_user_profiles WHERE profile_id = ? LIMIT 1",
        )
        .get(profileId) as Record<string, unknown> | undefined
      return mapRuntimeUserProfileRow(row, profileId)
    } finally {
      database.close()
    }
  }

  return {
    async getProfile(): Promise<RuntimeUserProfileRecord> {
      return getProfileRecord("default")
    },

    async setProfile(
      payload: RuntimeUserProfileUpdate,
    ): Promise<RuntimeUserProfileRecord> {
      const profileId =
        typeof payload.profileId === "string" && payload.profileId.trim()
          ? payload.profileId.trim()
          : "default"
      const existing = getProfileRecord(profileId)
      const now = utcNowIso()
      const createdAt = existing.createdAt ?? now
      const normalizedName =
        typeof payload.name === "string" ? payload.name.trim() : ""
      const resolvedName = normalizedName || null
      const resolvedNameSource = resolvedName
        ? (payload.nameSource ?? existing.nameSource ?? "manual")
        : null

      const database = openControlPlaneDatabase(options.controlPlaneDatabasePath())
      try {
        database
          .prepare(`
            INSERT INTO runtime_user_profiles (
              profile_id,
              name,
              name_source,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(profile_id) DO UPDATE SET
              name = excluded.name,
              name_source = excluded.name_source,
              updated_at = excluded.updated_at
          `)
          .run(
            profileId,
            resolvedName,
            runtimeUserProfileNameSourceToStored(resolvedNameSource) ?? null,
            createdAt,
            now,
          )
      } finally {
        database.close()
      }
      return getProfileRecord(profileId)
    },

    async applyAuthFallback(
      name: string,
      profileId = "default",
    ): Promise<RuntimeUserProfileRecord> {
      const normalizedName = name.trim()
      if (!normalizedName) {
        return getProfileRecord(profileId)
      }
      const existing = getProfileRecord(profileId)
      if (existing.name?.trim()) {
        return existing
      }
      return this.setProfile({
        profileId,
        name: normalizedName,
        nameSource: "authFallback",
      })
    },
  }
}
