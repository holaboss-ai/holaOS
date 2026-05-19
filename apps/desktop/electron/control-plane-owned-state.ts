import Database from "better-sqlite3"
import { randomUUID } from "node:crypto"
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

export type AppCatalogSource = "marketplace" | "local"

export interface LocalIntegrationConnectionRecord {
  connection_id: string
  provider_id: string
  owner_user_id: string
  account_label: string
  account_external_id: string | null
  account_handle: string | null
  account_email: string | null
  auth_mode: string
  granted_scopes: string[]
  status: string
  secret_ref: string | null
  created_at: string
  updated_at: string
}

export interface LocalIntegrationConnectionListResponse {
  connections: LocalIntegrationConnectionRecord[]
}

export interface LocalIntegrationConnectionCreatePayload {
  provider_id: string
  owner_user_id: string
  account_label: string
  auth_mode: string
  granted_scopes: string[]
  secret_ref?: string
  account_external_id?: string | null
  account_handle?: string | null
  account_email?: string | null
  status?: string
}

export interface LocalIntegrationConnectionUpdatePayload {
  status?: string
  secret_ref?: string | null
  account_label?: string
  granted_scopes?: string[]
  account_handle?: string | null
  account_email?: string | null
}

export interface LocalIntegrationMergeConnectionsResult {
  kept_connection_id: string
  removed_count: number
  repointed_bindings: number
}

export interface LocalOAuthAppConfigRecord {
  provider_id: string
  client_id: string
  client_secret: string
  authorize_url: string
  token_url: string
  scopes: string[]
  redirect_port: number
  created_at: string
  updated_at: string
}

export interface LocalOAuthAppConfigListResponse {
  configs: LocalOAuthAppConfigRecord[]
}

export interface LocalOAuthAppConfigUpsertPayload {
  client_id: string
  client_secret: string
  authorize_url: string
  token_url: string
  scopes: string[]
  redirect_port?: number
}

export interface LocalIntegrationMetadataStore {
  listConnections(params?: {
    providerId?: string
    ownerUserId?: string
  }): Promise<LocalIntegrationConnectionListResponse>
  createConnection(
    payload: LocalIntegrationConnectionCreatePayload,
  ): Promise<LocalIntegrationConnectionRecord>
  updateConnection(
    connectionId: string,
    payload: LocalIntegrationConnectionUpdatePayload,
  ): Promise<LocalIntegrationConnectionRecord>
  deleteConnection(connectionId: string): Promise<{ deleted: boolean }>
  mergeConnections(
    keepConnectionId: string,
    removeConnectionIds: string[],
  ): Promise<LocalIntegrationMergeConnectionsResult>
  listOAuthConfigs(): Promise<LocalOAuthAppConfigListResponse>
  upsertOAuthConfig(
    providerId: string,
    payload: LocalOAuthAppConfigUpsertPayload,
  ): Promise<LocalOAuthAppConfigRecord>
  deleteOAuthConfig(providerId: string): Promise<{ deleted: boolean }>
}

export interface LocalIntegrationMetadataStoreOptions {
  controlPlaneDatabasePath: () => string
}

export interface LocalAppCatalogEntryRecord {
  app_id: string
  source: AppCatalogSource
  name: string
  description: string | null
  icon: string | null
  category: string | null
  tags: string[]
  version: string | null
  archive_url: string | null
  archive_path: string | null
  target: string
  cached_at: string
  provider_id: string | null
  credential_source: string | null
}

export interface LocalAppCatalogListResponse {
  entries: LocalAppCatalogEntryRecord[]
  count: number
}

export interface LocalAppCatalogSyncEntryInput {
  [key: string]: unknown
}

export interface LocalAppCatalogSyncPayload {
  source: AppCatalogSource
  target: string
  entries: LocalAppCatalogSyncEntryInput[]
}

export interface LocalAppCatalogSyncResponse {
  synced: number
  source: AppCatalogSource
  target: string
}

export interface LocalAppCatalogStore {
  listCatalog(params?: {
    source?: AppCatalogSource
  }): Promise<LocalAppCatalogListResponse>
  syncCatalog(
    payload: LocalAppCatalogSyncPayload,
  ): Promise<LocalAppCatalogSyncResponse>
}

export interface LocalAppCatalogStoreOptions {
  controlPlaneDatabasePath: () => string
}

interface LocalIntegrationBindingRecord {
  binding_id: string
  workspace_id: string
  target_type: string
  target_id: string
  integration_key: string
  connection_id: string
  is_default: boolean
  created_at: string
  updated_at: string
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

    CREATE TABLE IF NOT EXISTS integration_connections (
      connection_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      account_label TEXT NOT NULL,
      account_external_id TEXT,
      account_handle TEXT,
      account_email TEXT,
      auth_mode TEXT NOT NULL,
      granted_scopes TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      secret_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_integration_connections_provider_owner_updated
      ON integration_connections (provider_id, owner_user_id, updated_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS integration_bindings (
      binding_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      integration_key TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, target_type, target_id, integration_key),
      FOREIGN KEY (connection_id) REFERENCES integration_connections(connection_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_integration_bindings_workspace_updated
      ON integration_bindings (workspace_id, is_default DESC, updated_at DESC, created_at DESC);

    CREATE TABLE IF NOT EXISTS app_catalog (
      app_id TEXT NOT NULL,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      category TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      version TEXT,
      archive_url TEXT,
      archive_path TEXT,
      target TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      provider_id TEXT,
      credential_source TEXT,
      PRIMARY KEY (source, app_id)
    );

    CREATE INDEX IF NOT EXISTS idx_app_catalog_source
      ON app_catalog (source);

    CREATE TABLE IF NOT EXISTS oauth_app_configs (
      provider_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL,
      authorize_url TEXT NOT NULL,
      token_url TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT '[]',
      redirect_port INTEGER NOT NULL DEFAULT 38765,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function ensureAppCatalogProviderColumns(database: Database.Database): void {
  const columns = new Set(
    (database
      .prepare("PRAGMA table_info(app_catalog)")
      .all() as Array<{ name: string }>)
      .map((row) => row.name),
  )
  if (!columns.has("provider_id")) {
    database.exec("ALTER TABLE app_catalog ADD COLUMN provider_id TEXT")
  }
  if (!columns.has("credential_source")) {
    database.exec("ALTER TABLE app_catalog ADD COLUMN credential_source TEXT")
  }
}

function openControlPlaneDatabase(controlPlaneDatabasePath: string): Database.Database {
  fs.mkdirSync(path.dirname(controlPlaneDatabasePath), { recursive: true })
  const database = new Database(controlPlaneDatabasePath)
  database.pragma("journal_mode = WAL")
  database.pragma("busy_timeout = 5000")
  database.pragma("foreign_keys = ON")
  ensureControlPlaneDatabaseSchema(database)
  ensureAppCatalogProviderColumns(database)
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

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required`)
  }
  return value.trim()
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }
  const normalized = value.trim()
  return normalized || null
}

function normalizeIdentityValue(value: unknown): string | null {
  return normalizeOptionalString(value)
}

function parseStoredStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string")
  }
  if (typeof value !== "string" || !value.trim()) {
    return []
  }
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : []
  } catch {
    return []
  }
}

function normalizeAppCatalogSource(value: unknown): AppCatalogSource {
  if (value === "marketplace" || value === "local") {
    return value
  }
  throw new Error("source must be 'marketplace' or 'local'")
}

function sanitizeAppCatalogId(value: unknown): string {
  const appId = requiredString(value, "app_id")
  if (appId.includes("/") || appId.includes("\\")) {
    throw new Error("app_id must not contain path separators")
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(appId)) {
    throw new Error("app_id is invalid")
  }
  return appId
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

function mapIntegrationConnectionRow(
  row: Record<string, unknown> | undefined,
): LocalIntegrationConnectionRecord | null {
  if (!row) {
    return null
  }
  return {
    connection_id: String(row.connection_id ?? ""),
    provider_id: String(row.provider_id ?? ""),
    owner_user_id: String(row.owner_user_id ?? ""),
    account_label: String(row.account_label ?? ""),
    account_external_id:
      row.account_external_id == null ? null : String(row.account_external_id),
    account_handle:
      row.account_handle == null ? null : String(row.account_handle),
    account_email: row.account_email == null ? null : String(row.account_email),
    auth_mode: String(row.auth_mode ?? ""),
    granted_scopes: parseStoredStringArray(row.granted_scopes),
    status: String(row.status ?? ""),
    secret_ref: row.secret_ref == null ? null : String(row.secret_ref),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  }
}

function mapIntegrationBindingRow(
  row: Record<string, unknown> | undefined,
): LocalIntegrationBindingRecord | null {
  if (!row) {
    return null
  }
  return {
    binding_id: String(row.binding_id ?? ""),
    workspace_id: String(row.workspace_id ?? ""),
    target_type: String(row.target_type ?? ""),
    target_id: String(row.target_id ?? ""),
    integration_key: String(row.integration_key ?? ""),
    connection_id: String(row.connection_id ?? ""),
    is_default:
      row.is_default === true ||
      row.is_default === 1 ||
      row.is_default === "1",
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  }
}

function mapOAuthAppConfigRow(
  row: Record<string, unknown> | undefined,
): LocalOAuthAppConfigRecord | null {
  if (!row) {
    return null
  }
  return {
    provider_id: String(row.provider_id ?? ""),
    client_id: String(row.client_id ?? ""),
    client_secret: String(row.client_secret ?? ""),
    authorize_url: String(row.authorize_url ?? ""),
    token_url: String(row.token_url ?? ""),
    scopes: parseStoredStringArray(row.scopes),
    redirect_port:
      typeof row.redirect_port === "number"
        ? row.redirect_port
        : Number(row.redirect_port ?? 38765),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  }
}

function mapAppCatalogRow(
  row: Record<string, unknown> | undefined,
): LocalAppCatalogEntryRecord | null {
  if (!row) {
    return null
  }
  return {
    app_id: String(row.app_id ?? ""),
    source: normalizeAppCatalogSource(row.source),
    name: String(row.name ?? ""),
    description: row.description == null ? null : String(row.description),
    icon: row.icon == null ? null : String(row.icon),
    category: row.category == null ? null : String(row.category),
    tags: parseStoredStringArray(row.tags_json),
    version: row.version == null ? null : String(row.version),
    archive_url: row.archive_url == null ? null : String(row.archive_url),
    archive_path: row.archive_path == null ? null : String(row.archive_path),
    target: String(row.target ?? ""),
    cached_at: String(row.cached_at ?? ""),
    provider_id: row.provider_id == null ? null : String(row.provider_id),
    credential_source:
      row.credential_source == null ? null : String(row.credential_source),
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

      if (tableExists(legacy, "integration_connections")) {
        const rows = legacy
          .prepare("SELECT * FROM integration_connections")
          .all() as Array<Record<string, unknown>>
        const insert = database.prepare(`
          INSERT OR IGNORE INTO integration_connections (
            connection_id,
            provider_id,
            owner_user_id,
            account_label,
            account_external_id,
            account_handle,
            account_email,
            auth_mode,
            granted_scopes,
            status,
            secret_ref,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const row of rows) {
          insert.run(
            row.connection_id,
            row.provider_id,
            row.owner_user_id,
            row.account_label,
            row.account_external_id ?? null,
            row.account_handle ?? null,
            row.account_email ?? null,
            row.auth_mode,
            row.granted_scopes ?? "[]",
            row.status,
            row.secret_ref ?? null,
            row.created_at,
            row.updated_at,
          )
        }
      }

      if (tableExists(legacy, "integration_bindings")) {
        const rows = legacy
          .prepare("SELECT * FROM integration_bindings")
          .all() as Array<Record<string, unknown>>
        const insert = database.prepare(`
          INSERT OR IGNORE INTO integration_bindings (
            binding_id,
            workspace_id,
            target_type,
            target_id,
            integration_key,
            connection_id,
            is_default,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const row of rows) {
          insert.run(
            row.binding_id,
            row.workspace_id,
            row.target_type,
            row.target_id,
            row.integration_key,
            row.connection_id,
            row.is_default,
            row.created_at,
            row.updated_at,
          )
        }
      }

      if (tableExists(legacy, "oauth_app_configs")) {
        const rows = legacy
          .prepare("SELECT * FROM oauth_app_configs")
          .all() as Array<Record<string, unknown>>
        const insert = database.prepare(`
          INSERT OR IGNORE INTO oauth_app_configs (
            provider_id,
            client_id,
            client_secret,
            authorize_url,
            token_url,
            scopes,
            redirect_port,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const row of rows) {
          insert.run(
            row.provider_id,
            row.client_id,
            row.client_secret,
            row.authorize_url,
            row.token_url,
            row.scopes ?? "[]",
            row.redirect_port ?? 38765,
            row.created_at,
            row.updated_at,
          )
        }
      }

      if (tableExists(legacy, "app_catalog")) {
        const rows = legacy
          .prepare("SELECT * FROM app_catalog")
          .all() as Array<Record<string, unknown>>
        const insert = database.prepare(`
          INSERT OR IGNORE INTO app_catalog (
            app_id,
            source,
            name,
            description,
            icon,
            category,
            tags_json,
            version,
            archive_url,
            archive_path,
            target,
            cached_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        for (const row of rows) {
          insert.run(
            row.app_id,
            row.source,
            row.name,
            row.description ?? null,
            row.icon ?? null,
            row.category ?? null,
            row.tags_json ?? "[]",
            row.version ?? null,
            row.archive_url ?? null,
            row.archive_path ?? null,
            row.target,
            row.cached_at,
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

function getIntegrationConnectionRecord(
  database: Database.Database,
  connectionId: string,
): LocalIntegrationConnectionRecord | null {
  const row = database
    .prepare("SELECT * FROM integration_connections WHERE connection_id = ? LIMIT 1")
    .get(connectionId) as Record<string, unknown> | undefined
  return mapIntegrationConnectionRow(row)
}

function getIntegrationBindingByTarget(
  database: Database.Database,
  params: {
    workspaceId: string
    targetType: string
    targetId: string
    integrationKey: string
  },
): LocalIntegrationBindingRecord | null {
  const row = database
    .prepare(
      `
        SELECT * FROM integration_bindings
        WHERE workspace_id = ? AND target_type = ? AND target_id = ? AND integration_key = ?
        LIMIT 1
      `,
    )
    .get(
      params.workspaceId,
      params.targetType,
      params.targetId,
      params.integrationKey,
    ) as Record<string, unknown> | undefined
  return mapIntegrationBindingRow(row)
}

function listIntegrationBindingsForConnection(
  database: Database.Database,
  connectionId: string,
): LocalIntegrationBindingRecord[] {
  const rows = database
    .prepare(
      `
        SELECT * FROM integration_bindings
        WHERE connection_id = ?
        ORDER BY is_default DESC, datetime(created_at) ASC, binding_id ASC
      `,
    )
    .all(connectionId) as Array<Record<string, unknown>>
  return rows
    .map((row) => mapIntegrationBindingRow(row))
    .filter((row): row is LocalIntegrationBindingRecord => Boolean(row))
}

function upsertIntegrationConnectionRecord(
  database: Database.Database,
  params: {
    connectionId: string
    providerId: string
    ownerUserId: string
    accountLabel: string
    accountExternalId?: string | null
    accountHandle?: string | null
    accountEmail?: string | null
    authMode: string
    grantedScopes: string[]
    status: string
    secretRef?: string | null
  },
): LocalIntegrationConnectionRecord {
  const now = utcNowIso()
  database
    .prepare(`
      INSERT INTO integration_connections (
        connection_id,
        provider_id,
        owner_user_id,
        account_label,
        account_external_id,
        account_handle,
        account_email,
        auth_mode,
        granted_scopes,
        status,
        secret_ref,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET
        provider_id = excluded.provider_id,
        owner_user_id = excluded.owner_user_id,
        account_label = excluded.account_label,
        account_external_id = excluded.account_external_id,
        account_handle = excluded.account_handle,
        account_email = excluded.account_email,
        auth_mode = excluded.auth_mode,
        granted_scopes = excluded.granted_scopes,
        status = excluded.status,
        secret_ref = excluded.secret_ref,
        updated_at = excluded.updated_at
    `)
    .run(
      params.connectionId,
      params.providerId,
      params.ownerUserId,
      params.accountLabel,
      params.accountExternalId ?? null,
      normalizeIdentityValue(params.accountHandle),
      normalizeIdentityValue(params.accountEmail),
      params.authMode,
      JSON.stringify(params.grantedScopes ?? []),
      params.status,
      params.secretRef ?? null,
      now,
      now,
    )
  const record = getIntegrationConnectionRecord(database, params.connectionId)
  if (!record) {
    throw new Error("failed to load integration connection")
  }
  return record
}

function upsertAppCatalogEntry(
  database: Database.Database,
  params: {
    appId: string
    source: AppCatalogSource
    name: string
    description: string | null
    icon: string | null
    category: string | null
    tags: string[]
    version: string | null
    archiveUrl: string | null
    archivePath: string | null
    target: string
    cachedAt: string
    providerId: string | null
    credentialSource: string | null
  },
): void {
  database
    .prepare(`
      INSERT INTO app_catalog (
        app_id,
        source,
        name,
        description,
        icon,
        category,
        tags_json,
        version,
        archive_url,
        archive_path,
        target,
        cached_at,
        provider_id,
        credential_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, app_id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        icon = excluded.icon,
        category = excluded.category,
        tags_json = excluded.tags_json,
        version = excluded.version,
        archive_url = excluded.archive_url,
        archive_path = excluded.archive_path,
        target = excluded.target,
        cached_at = excluded.cached_at,
        provider_id = excluded.provider_id,
        credential_source = excluded.credential_source
    `)
    .run(
      params.appId,
      params.source,
      params.name,
      params.description,
      params.icon,
      params.category,
      JSON.stringify(params.tags ?? []),
      params.version,
      params.archiveUrl,
      params.archivePath,
      params.target,
      params.cachedAt,
      params.providerId,
      params.credentialSource,
    )
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

export function createLocalIntegrationMetadataStore(
  options: LocalIntegrationMetadataStoreOptions,
): LocalIntegrationMetadataStore {
  function withDatabase<T>(callback: (database: Database.Database) => T): T {
    const database = openControlPlaneDatabase(options.controlPlaneDatabasePath())
    try {
      return callback(database)
    } finally {
      database.close()
    }
  }

  return {
    async listConnections(params = {}): Promise<LocalIntegrationConnectionListResponse> {
      return withDatabase((database) => {
        let query = "SELECT * FROM integration_connections"
        const filters: string[] = []
        const values: string[] = []
        if (params.providerId) {
          filters.push("provider_id = ?")
          values.push(params.providerId)
        }
        if (params.ownerUserId) {
          filters.push("owner_user_id = ?")
          values.push(params.ownerUserId)
        }
        if (filters.length > 0) {
          query += ` WHERE ${filters.join(" AND ")}`
        }
        query += " ORDER BY datetime(created_at) ASC, connection_id ASC"
        const rows = database.prepare(query).all(...values) as Array<
          Record<string, unknown>
        >
        return {
          connections: rows
            .map((row) => mapIntegrationConnectionRow(row))
            .filter(
              (row): row is LocalIntegrationConnectionRecord => Boolean(row),
            ),
        }
      })
    },

    async createConnection(
      payload: LocalIntegrationConnectionCreatePayload,
    ): Promise<LocalIntegrationConnectionRecord> {
      return withDatabase((database) => {
        const providerId = requiredString(payload.provider_id, "provider_id")
        const ownerUserId = requiredString(payload.owner_user_id, "owner_user_id")
        const authMode = requiredString(payload.auth_mode, "auth_mode")
        const accountLabel =
          normalizeOptionalString(payload.account_label) ??
          `${providerId} connection`
        return upsertIntegrationConnectionRecord(database, {
          connectionId: randomUUID(),
          providerId,
          ownerUserId,
          accountLabel,
          accountExternalId: normalizeOptionalString(payload.account_external_id),
          accountHandle: payload.account_handle ?? null,
          accountEmail: payload.account_email ?? null,
          authMode,
          grantedScopes: Array.isArray(payload.granted_scopes)
            ? payload.granted_scopes.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : [],
          status: normalizeOptionalString(payload.status) ?? "active",
          secretRef:
            payload.secret_ref === undefined
              ? null
              : normalizeOptionalString(payload.secret_ref),
        })
      })
    },

    async updateConnection(
      connectionId: string,
      payload: LocalIntegrationConnectionUpdatePayload,
    ): Promise<LocalIntegrationConnectionRecord> {
      return withDatabase((database) => {
        const existing = getIntegrationConnectionRecord(
          database,
          requiredString(connectionId, "connection_id"),
        )
        if (!existing) {
          throw new Error("connection not found")
        }
        return upsertIntegrationConnectionRecord(database, {
          connectionId: existing.connection_id,
          providerId: existing.provider_id,
          ownerUserId: existing.owner_user_id,
          accountLabel:
            normalizeOptionalString(payload.account_label) ??
            existing.account_label,
          accountExternalId: existing.account_external_id,
          accountHandle:
            payload.account_handle !== undefined
              ? payload.account_handle
              : existing.account_handle,
          accountEmail:
            payload.account_email !== undefined
              ? payload.account_email
              : existing.account_email,
          authMode: existing.auth_mode,
          grantedScopes: Array.isArray(payload.granted_scopes)
            ? payload.granted_scopes.filter(
                (entry): entry is string => typeof entry === "string",
              )
            : existing.granted_scopes,
          status:
            normalizeOptionalString(payload.status) ?? existing.status,
          secretRef:
            payload.secret_ref !== undefined
              ? normalizeOptionalString(payload.secret_ref)
              : existing.secret_ref,
        })
      })
    },

    async deleteConnection(connectionId: string): Promise<{ deleted: boolean }> {
      return withDatabase((database) => {
        const normalizedId = requiredString(connectionId, "connection_id")
        const existing = getIntegrationConnectionRecord(database, normalizedId)
        if (!existing) {
          throw new Error("connection not found")
        }
        const transaction = database.transaction(() => {
          const bindings = listIntegrationBindingsForConnection(
            database,
            normalizedId,
          )
          for (const binding of bindings) {
            database
              .prepare("DELETE FROM integration_bindings WHERE binding_id = ?")
              .run(binding.binding_id)
          }
          database
            .prepare("DELETE FROM integration_connections WHERE connection_id = ?")
            .run(normalizedId)
        })
        transaction()
        return { deleted: true }
      })
    },

    async mergeConnections(
      keepConnectionId: string,
      removeConnectionIds: string[],
    ): Promise<LocalIntegrationMergeConnectionsResult> {
      return withDatabase((database) => {
        const keepId = requiredString(keepConnectionId, "keep_connection_id")
        const keep = getIntegrationConnectionRecord(database, keepId)
        if (!keep) {
          throw new Error("keep connection not found")
        }
        const uniqueRemoveIds = Array.from(
          new Set(
            (removeConnectionIds ?? [])
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter((entry) => entry.length > 0 && entry !== keepId),
          ),
        )
        const removeRows = uniqueRemoveIds
          .map((id) => ({
            id,
            row: getIntegrationConnectionRecord(database, id),
          }))
          .filter(
            (
              entry,
            ): entry is {
              id: string
              row: LocalIntegrationConnectionRecord
            } => Boolean(entry.row),
          )

        for (const entry of removeRows) {
          if (
            entry.row.provider_id !== keep.provider_id ||
            entry.row.owner_user_id !== keep.owner_user_id
          ) {
            throw new Error(
              `cannot merge: connection ${entry.id} provider/owner does not match the keep connection`,
            )
          }
        }

        if (removeRows.length === 0) {
          return {
            kept_connection_id: keepId,
            removed_count: 0,
            repointed_bindings: 0,
          }
        }

        let repointedBindings = 0
        const transaction = database.transaction(() => {
          for (const entry of removeRows) {
            const bindings = listIntegrationBindingsForConnection(
              database,
              entry.id,
            )
            for (const binding of bindings) {
              const collision = getIntegrationBindingByTarget(database, {
                workspaceId: binding.workspace_id,
                targetType: binding.target_type,
                targetId: binding.target_id,
                integrationKey: binding.integration_key,
              })
              const existingOnTarget =
                collision && collision.binding_id !== binding.binding_id
                  ? collision
                  : null
              if (existingOnTarget?.connection_id === keepId) {
                database
                  .prepare("DELETE FROM integration_bindings WHERE binding_id = ?")
                  .run(binding.binding_id)
              } else if (existingOnTarget) {
                database
                  .prepare(`
                    UPDATE integration_bindings
                    SET connection_id = ?, is_default = ?, updated_at = ?
                    WHERE binding_id = ?
                  `)
                  .run(
                    keepId,
                    existingOnTarget.is_default || binding.is_default ? 1 : 0,
                    utcNowIso(),
                    existingOnTarget.binding_id,
                  )
                database
                  .prepare("DELETE FROM integration_bindings WHERE binding_id = ?")
                  .run(binding.binding_id)
              } else {
                database
                  .prepare(`
                    UPDATE integration_bindings
                    SET connection_id = ?, updated_at = ?
                    WHERE binding_id = ?
                  `)
                  .run(keepId, utcNowIso(), binding.binding_id)
              }
              repointedBindings += 1
            }
            database
              .prepare("DELETE FROM integration_connections WHERE connection_id = ?")
              .run(entry.id)
          }
        })
        transaction()

        return {
          kept_connection_id: keepId,
          removed_count: removeRows.length,
          repointed_bindings: repointedBindings,
        }
      })
    },

    async listOAuthConfigs(): Promise<LocalOAuthAppConfigListResponse> {
      return withDatabase((database) => {
        const rows = database
          .prepare("SELECT * FROM oauth_app_configs ORDER BY provider_id")
          .all() as Array<Record<string, unknown>>
        return {
          configs: rows
            .map((row) => mapOAuthAppConfigRow(row))
            .filter((row): row is LocalOAuthAppConfigRecord => Boolean(row)),
        }
      })
    },

    async upsertOAuthConfig(
      providerId: string,
      payload: LocalOAuthAppConfigUpsertPayload,
    ): Promise<LocalOAuthAppConfigRecord> {
      return withDatabase((database) => {
        const now = utcNowIso()
        const normalizedProviderId = requiredString(providerId, "provider_id")
        database
          .prepare(`
            INSERT INTO oauth_app_configs (
              provider_id,
              client_id,
              client_secret,
              authorize_url,
              token_url,
              scopes,
              redirect_port,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider_id) DO UPDATE SET
              client_id = excluded.client_id,
              client_secret = CASE
                WHEN excluded.client_secret = '' THEN oauth_app_configs.client_secret
                ELSE excluded.client_secret
              END,
              authorize_url = excluded.authorize_url,
              token_url = excluded.token_url,
              scopes = excluded.scopes,
              redirect_port = excluded.redirect_port,
              updated_at = excluded.updated_at
          `)
          .run(
            normalizedProviderId,
            requiredString(payload.client_id, "client_id"),
            typeof payload.client_secret === "string"
              ? payload.client_secret
              : "",
            requiredString(payload.authorize_url, "authorize_url"),
            requiredString(payload.token_url, "token_url"),
            JSON.stringify(
              Array.isArray(payload.scopes)
                ? payload.scopes.filter(
                    (entry): entry is string => typeof entry === "string",
                  )
                : [],
            ),
            payload.redirect_port ?? 38765,
            now,
            now,
          )
        const record = mapOAuthAppConfigRow(
          database
            .prepare("SELECT * FROM oauth_app_configs WHERE provider_id = ?")
            .get(normalizedProviderId) as Record<string, unknown> | undefined,
        )
        if (!record) {
          throw new Error("failed to load OAuth app config")
        }
        return record
      })
    },

    async deleteOAuthConfig(providerId: string): Promise<{ deleted: boolean }> {
      return withDatabase((database) => {
        const result = database
          .prepare("DELETE FROM oauth_app_configs WHERE provider_id = ?")
          .run(requiredString(providerId, "provider_id"))
        return { deleted: result.changes > 0 }
      })
    },
  }
}

export function createLocalAppCatalogStore(
  options: LocalAppCatalogStoreOptions,
): LocalAppCatalogStore {
  function withDatabase<T>(callback: (database: Database.Database) => T): T {
    const database = openControlPlaneDatabase(options.controlPlaneDatabasePath())
    try {
      return callback(database)
    } finally {
      database.close()
    }
  }

  return {
    async listCatalog(
      params = {},
    ): Promise<LocalAppCatalogListResponse> {
      return withDatabase((database) => {
        const rows = params.source
          ? (database
              .prepare("SELECT * FROM app_catalog WHERE source = ? ORDER BY app_id")
              .all(params.source) as Array<Record<string, unknown>>)
          : (database
              .prepare("SELECT * FROM app_catalog ORDER BY source, app_id")
              .all() as Array<Record<string, unknown>>)
        const entries = rows
          .map((row) => mapAppCatalogRow(row))
          .filter((row): row is LocalAppCatalogEntryRecord => Boolean(row))
        return {
          entries,
          count: entries.length,
        }
      })
    },

    async syncCatalog(
      payload: LocalAppCatalogSyncPayload,
    ): Promise<LocalAppCatalogSyncResponse> {
      return withDatabase((database) => {
        const source = normalizeAppCatalogSource(payload.source)
        const target = requiredString(payload.target, "target")
        const now = utcNowIso()
        let synced = 0
        const transaction = database.transaction(() => {
          database.prepare("DELETE FROM app_catalog WHERE source = ?").run(source)
          for (const entry of payload.entries ?? []) {
            if (!entry || typeof entry !== "object") {
              continue
            }
            try {
              upsertAppCatalogEntry(database, {
                appId: sanitizeAppCatalogId(entry.app_id),
                source,
                name: requiredString(entry.name, "name"),
                description: normalizeOptionalString(entry.description),
                icon: normalizeOptionalString(entry.icon),
                category: normalizeOptionalString(entry.category),
                tags: Array.isArray(entry.tags)
                  ? entry.tags.filter(
                      (tag): tag is string => typeof tag === "string",
                    )
                  : [],
                version: normalizeOptionalString(entry.version),
                archiveUrl: normalizeOptionalString(entry.archive_url),
                archivePath: normalizeOptionalString(entry.archive_path),
                target,
                cachedAt: now,
                providerId: normalizeOptionalString(entry.provider_id),
                credentialSource: normalizeOptionalString(
                  entry.credential_source,
                ),
              })
              synced += 1
            } catch {
              continue
            }
          }
        })
        transaction()
        return {
          synced,
          source,
          target,
        }
      })
    },
  }
}
