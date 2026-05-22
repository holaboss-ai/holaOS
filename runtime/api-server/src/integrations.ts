import { randomUUID } from "node:crypto";

import { type RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  type IntegrationReadinessResult,
  checkIntegrationReadiness
} from "./integration-runtime.js";
import {
  INTEGRATION_CATALOG_PROVIDERS,
  type IntegrationCatalogProviderRecord,
} from "./integration-catalog.js";
import { resolveWorkspaceAppRuntime } from "./workspace-apps.js";

export interface IntegrationConnectionPayload {
  connection_id: string;
  provider_id: string;
  owner_user_id: string;
  account_label: string;
  account_external_id: string | null;
  account_handle: string | null;
  account_email: string | null;
  context_cron_auto_fetch_enabled: boolean;
  last_context_fetch_attempted_at: string | null;
  last_context_fetch_completed_at: string | null;
  last_context_fetch_status: string | null;
  auth_mode: string;
  granted_scopes: string[];
  status: string;
  secret_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationBindingPayload {
  binding_id: string;
  workspace_id: string;
  target_type: "workspace" | "app" | "agent";
  target_id: string;
  integration_key: string;
  connection_id: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export class IntegrationServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

const VALID_TARGET_TYPES = new Set(["workspace", "app", "agent"]);

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new IntegrationServiceError(400, `${fieldName} is required`);
  }
  return value.trim();
}

function lookupProviderDisplayName(providerId: string): string {
  return (
    INTEGRATION_CATALOG_PROVIDERS.find((provider) => provider.provider_id === providerId)?.display_name ??
    providerId
  );
}

function optionalBoolean(value: unknown, defaultValue = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return defaultValue;
}

function validateTargetType(targetType: string): "workspace" | "app" | "agent" {
  const normalized = requiredString(targetType, "target_type");
  if (!VALID_TARGET_TYPES.has(normalized)) {
    throw new IntegrationServiceError(400, "target_type must be workspace, app, or agent");
  }
  return normalized as "workspace" | "app" | "agent";
}

function requireWorkspace(store: RuntimeStateStore, workspaceId: string): void {
  if (!store.getWorkspace(workspaceId)) {
    throw new IntegrationServiceError(404, "workspace not found");
  }
}

function toIntegrationConnectionPayload(record: {
  connectionId: string;
  providerId: string;
  ownerUserId: string;
  accountLabel: string;
  accountExternalId: string | null;
  accountHandle?: string | null;
  accountEmail?: string | null;
  contextCronAutoFetchEnabled?: boolean;
  lastContextFetchAttemptedAt?: string | null;
  lastContextFetchCompletedAt?: string | null;
  lastContextFetchStatus?: string | null;
  authMode: string;
  grantedScopes: string[];
  status: string;
  secretRef: string | null;
  createdAt: string;
  updatedAt: string;
}): IntegrationConnectionPayload {
  return {
    connection_id: record.connectionId,
    provider_id: record.providerId,
    owner_user_id: record.ownerUserId,
    account_label: record.accountLabel,
    account_external_id: record.accountExternalId,
    account_handle: record.accountHandle ?? null,
    account_email: record.accountEmail ?? null,
    context_cron_auto_fetch_enabled:
      record.contextCronAutoFetchEnabled ?? true,
    last_context_fetch_attempted_at:
      record.lastContextFetchAttemptedAt ?? null,
    last_context_fetch_completed_at:
      record.lastContextFetchCompletedAt ?? null,
    last_context_fetch_status: record.lastContextFetchStatus ?? null,
    auth_mode: record.authMode,
    granted_scopes: record.grantedScopes,
    status: record.status,
    secret_ref: record.secretRef,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

function toIntegrationBindingPayload(record: {
  bindingId: string;
  workspaceId: string;
  targetType: string;
  targetId: string;
  integrationKey: string;
  connectionId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}): IntegrationBindingPayload {
  const targetType = validateTargetType(record.targetType);
  return {
    binding_id: record.bindingId,
    workspace_id: record.workspaceId,
    target_type: targetType,
    target_id: record.targetId,
    integration_key: record.integrationKey,
    connection_id: record.connectionId,
    is_default: record.isDefault,
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

export interface IntegrationServiceHooks {
  /** Called whenever a connection becomes (or stays) active. Used by the
   *  api-server to wake inputs that were parked waiting for this provider
   *  to be connected via a propose_connect card. */
  onConnectionActive?: (params: {
    providerId: string;
    connectionId: string;
    ownerUserId: string;
  }) => void;
}

export class RuntimeIntegrationService {
  readonly store: RuntimeStateStore;
  readonly hooks: IntegrationServiceHooks;

  constructor(store: RuntimeStateStore, hooks: IntegrationServiceHooks = {}) {
    this.store = store;
    this.hooks = hooks;
  }

  getCatalog(): { providers: IntegrationCatalogProviderRecord[] } {
    return { providers: INTEGRATION_CATALOG_PROVIDERS };
  }

  listConnections(params: { providerId?: string; ownerUserId?: string } = {}): {
    connections: IntegrationConnectionPayload[];
  } {
    return {
      connections: this.store
        .listIntegrationConnections({
          providerId: params.providerId,
          ownerUserId: params.ownerUserId
        })
        .map(toIntegrationConnectionPayload)
    };
  }

  listBindings(params: { workspaceId: string }): { bindings: IntegrationBindingPayload[] } {
    const workspaceId = requiredString(params.workspaceId, "workspace_id");
    requireWorkspace(this.store, workspaceId);
    return {
      bindings: this.store.listIntegrationBindings({ workspaceId }).map(toIntegrationBindingPayload)
    };
  }

  upsertBinding(params: {
    workspaceId: string;
    targetType: string;
    targetId: string;
    integrationKey: string;
    connectionId: string;
    isDefault?: boolean;
  }): IntegrationBindingPayload {
    const workspaceId = requiredString(params.workspaceId, "workspace_id");
    const targetType = validateTargetType(params.targetType);
    const targetId = requiredString(params.targetId, "target_id");
    const integrationKey = requiredString(params.integrationKey, "integration_key");
    const connectionId = requiredString(params.connectionId, "connection_id");
    const isDefault = optionalBoolean(params.isDefault, false);
    requireWorkspace(this.store, workspaceId);

    const connection = this.store.getIntegrationConnection(connectionId);
    if (!connection) {
      throw new IntegrationServiceError(404, `integration connection ${connectionId} not found`);
    }
    if (connection.providerId !== integrationKey) {
      throw new IntegrationServiceError(
        400,
        `connection provider ${connection.providerId} does not match integration ${integrationKey}`
      );
    }

    const existing = this.store.getIntegrationBindingByTarget({
      workspaceId,
      targetType,
      targetId,
      integrationKey
    });
    const binding = this.store.upsertIntegrationBinding({
      bindingId: existing?.bindingId ?? randomUUID(),
      workspaceId,
      targetType,
      targetId,
      integrationKey,
      connectionId,
      isDefault
    });

    return toIntegrationBindingPayload(binding);
  }

  deleteBinding(bindingId: string, workspaceId?: string): { deleted: true } {
    const normalizedBindingId = requiredString(bindingId, "binding_id");
    const normalizedWorkspaceId = requiredString(workspaceId, "workspace_id");
    requireWorkspace(this.store, normalizedWorkspaceId);

    const binding = this.store.getIntegrationBinding(normalizedBindingId);
    if (!binding || binding.workspaceId !== normalizedWorkspaceId) {
      throw new IntegrationServiceError(404, "binding not found");
    }

    const deleted = this.store.deleteIntegrationBinding(normalizedBindingId);
    if (!deleted) {
      throw new IntegrationServiceError(404, "binding not found");
    }
    return { deleted: true };
  }

  createConnection(params: {
    providerId: string;
    ownerUserId: string;
    accountLabel: string;
    authMode: string;
    grantedScopes: string[];
    secretRef?: string;
    accountExternalId?: string;
    /** Stable provider-side identity from whoami (e.g. Twitter handle). */
    accountHandle?: string | null;
    /** Stable provider-side email from whoami (e.g. Gmail address). */
    accountEmail?: string | null;
  }): IntegrationConnectionPayload {
    const providerId = requiredString(params.providerId, "provider_id");
    const ownerUserId = requiredString(params.ownerUserId, "owner_user_id");
    const authMode = requiredString(params.authMode, "auth_mode");
    const rawAccountLabel = typeof params.accountLabel === "string" ? params.accountLabel.trim() : "";
    const accountLabel =
      rawAccountLabel ||
      (authMode === "manual_token" ? `${lookupProviderDisplayName(providerId)} connection` : requiredString(params.accountLabel, "account_label"));

    // Dedupe-on-reconnect: if the caller has resolved a stable identity
    // (handle or email) for the new external account, look for an existing
    // active connection on the same (provider, owner) tuple matching that
    // identity. If found, treat this as a re-auth — keep the existing
    // connection_id (so all integration_bindings stay valid) and refresh
    // the volatile fields (external_id, secret_ref, label, scopes).
    const existing =
      params.accountHandle || params.accountEmail
        ? this.store.findActiveIntegrationConnectionByIdentity({
            providerId,
            ownerUserId,
            accountHandle: params.accountHandle ?? null,
            accountEmail: params.accountEmail ?? null
          })
        : null;

    const record = this.store.upsertIntegrationConnection({
      connectionId: existing?.connectionId ?? randomUUID(),
      providerId,
      ownerUserId,
      accountLabel,
      contextCronAutoFetchEnabled:
        existing?.contextCronAutoFetchEnabled ?? true,
      lastContextFetchAttemptedAt: existing?.lastContextFetchAttemptedAt ?? null,
      lastContextFetchCompletedAt: existing?.lastContextFetchCompletedAt ?? null,
      lastContextFetchStatus: existing?.lastContextFetchStatus ?? null,
      authMode,
      grantedScopes: params.grantedScopes ?? existing?.grantedScopes ?? [],
      status: "active",
      secretRef: params.secretRef ?? existing?.secretRef ?? null,
      accountExternalId: params.accountExternalId ?? existing?.accountExternalId ?? null,
      accountHandle: params.accountHandle ?? existing?.accountHandle ?? null,
      accountEmail: params.accountEmail ?? existing?.accountEmail ?? null
    });

    this.notifyConnectionActive(
      record.connectionId,
      record.providerId,
      record.ownerUserId,
      record.status,
    );
    return toIntegrationConnectionPayload(record);
  }

  private notifyConnectionActive(
    connectionId: string,
    providerId: string,
    ownerUserId: string,
    status: string,
  ): void {
    if (status.trim().toLowerCase() !== "active") return;
    try {
      this.hooks.onConnectionActive?.({ providerId, connectionId, ownerUserId });
    } catch {
      // Hook is best-effort — never block the connection write.
    }
  }

  updateConnection(connectionId: string, params: {
    status?: string;
    secretRef?: string;
    accountLabel?: string;
    grantedScopes?: string[];
    /**
     * Provider-side identity. Pass `undefined` to leave the existing
     * value untouched; pass `null` to explicitly clear; pass a string
     * (or trimmed-to-empty) to backfill / overwrite. Used by the
     * desktop's whoami enrichment to backfill identity on legacy rows
     * created before identity columns existed, so the next finalize
     * dedupe can match them.
     */
    accountHandle?: string | null;
    accountEmail?: string | null;
    contextCronAutoFetchEnabled?: boolean;
  }): IntegrationConnectionPayload {
    const normalizedId = requiredString(connectionId, "connection_id");
    const existing = this.store.getIntegrationConnection(normalizedId);
    if (!existing) {
      throw new IntegrationServiceError(404, "connection not found");
    }

    const record = this.store.upsertIntegrationConnection({
      connectionId: existing.connectionId,
      providerId: existing.providerId,
      ownerUserId: existing.ownerUserId,
      accountLabel: params.accountLabel ?? existing.accountLabel,
      authMode: existing.authMode,
      grantedScopes: params.grantedScopes ?? existing.grantedScopes,
      status: params.status ?? existing.status,
      secretRef: params.secretRef !== undefined ? params.secretRef : existing.secretRef,
      accountExternalId: existing.accountExternalId,
      accountHandle:
        params.accountHandle !== undefined ? params.accountHandle : existing.accountHandle,
      accountEmail:
        params.accountEmail !== undefined ? params.accountEmail : existing.accountEmail,
      contextCronAutoFetchEnabled:
        params.contextCronAutoFetchEnabled !== undefined
          ? params.contextCronAutoFetchEnabled
          : existing.contextCronAutoFetchEnabled,
      lastContextFetchAttemptedAt: existing.lastContextFetchAttemptedAt,
      lastContextFetchCompletedAt: existing.lastContextFetchCompletedAt,
      lastContextFetchStatus: existing.lastContextFetchStatus,
    });

    this.notifyConnectionActive(
      record.connectionId,
      record.providerId,
      record.ownerUserId,
      record.status,
    );
    return toIntegrationConnectionPayload(record);
  }

  /**
   * Merge duplicate connections into a single canonical row. Used to
   * collapse legacy duplicate rows for the same provider-side identity
   * once whoami enrichment reveals they're the same account.
   *
   * - All bindings pointing at any `removeConnectionIds` are repointed
   *   at `keepConnectionId` (UPSERT, so existing bindings on the keep
   *   side win on the unique target).
   * - Removed connections are deleted afterwards.
   * - The keep connection must exist and share (provider, owner) with
   *   every removed connection — refuse otherwise so an unrelated
   *   account can't accidentally absorb someone else's bindings.
   */
  mergeConnections(params: {
    keepConnectionId: string;
    removeConnectionIds: string[];
  }): { kept_connection_id: string; removed_count: number; repointed_bindings: number } {
    const keepId = requiredString(params.keepConnectionId, "keep_connection_id");
    const keep = this.store.getIntegrationConnection(keepId);
    if (!keep) {
      throw new IntegrationServiceError(404, "keep connection not found");
    }
    const removeIds = (params.removeConnectionIds ?? [])
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter((id) => id.length > 0 && id !== keepId);
    if (removeIds.length === 0) {
      return { kept_connection_id: keepId, removed_count: 0, repointed_bindings: 0 };
    }

    // Validate every remove row up front so a half-completed merge
    // can't leave the DB in a partial state. The actual binding
    // repoint + connection delete runs inside a single transaction.
    const removeRows: Array<{ id: string; row: typeof keep }> = [];
    for (const removeId of removeIds) {
      const removeRow = this.store.getIntegrationConnection(removeId);
      if (!removeRow) {
        continue;
      }
      if (
        removeRow.providerId !== keep.providerId ||
        removeRow.ownerUserId !== keep.ownerUserId
      ) {
        throw new IntegrationServiceError(
          400,
          `cannot merge: connection ${removeId} provider/owner does not match the keep connection`
        );
      }
      removeRows.push({ id: removeId, row: removeRow });
    }
    if (removeRows.length === 0) {
      return { kept_connection_id: keepId, removed_count: 0, repointed_bindings: 0 };
    }

    let repointed = 0;
    this.store.transaction(() => {
    for (const { id: removeId } of removeRows) {
      const bindings = this.store
        .listIntegrationBindings({})
        .filter((b) => b.connectionId === removeId);
      for (const binding of bindings) {
        // Look for a *different* binding row that already owns the same
        // (workspace, target_type, target_id, integration_key) on the
        // keep id — that's the only real collision. The lookup ignores
        // connection_id, so we filter by bindingId to make sure we don't
        // mistake the row we're about to repoint for a collision and
        // delete it.
        const existingOnTarget = this.store.getIntegrationBindingByTarget({
          workspaceId: binding.workspaceId,
          targetType: binding.targetType,
          targetId: binding.targetId,
          integrationKey: binding.integrationKey
        });
        const collision =
          existingOnTarget && existingOnTarget.bindingId !== binding.bindingId
            ? existingOnTarget
            : null;
        if (collision && collision.connectionId === keepId) {
          // keep already owns this target via a separate binding row —
          // drop our duplicate.
          this.store.deleteIntegrationBinding(binding.bindingId);
        } else if (collision) {
          // Some other connection owns this target on the keep side
          // (shouldn't happen given provider+owner guard above, but be
          // safe): collapse onto keep id, drop the duplicate.
          this.store.upsertIntegrationBinding({
            bindingId: collision.bindingId,
            workspaceId: collision.workspaceId,
            targetType: collision.targetType,
            targetId: collision.targetId,
            integrationKey: collision.integrationKey,
            connectionId: keepId,
            isDefault: collision.isDefault || binding.isDefault
          });
          this.store.deleteIntegrationBinding(binding.bindingId);
        } else {
          // No collision — repoint our row in place.
          this.store.upsertIntegrationBinding({
            bindingId: binding.bindingId,
            workspaceId: binding.workspaceId,
            targetType: binding.targetType,
            targetId: binding.targetId,
            integrationKey: binding.integrationKey,
            connectionId: keepId,
            isDefault: binding.isDefault
          });
        }
        repointed += 1;
      }
      this.store.deleteIntegrationConnection(removeId);
    }
    });

    return {
      kept_connection_id: keepId,
      removed_count: removeRows.length,
      repointed_bindings: repointed
    };
  }

  deleteConnection(connectionId: string): { deleted: true; removed_bindings: number } {
    const normalizedId = requiredString(connectionId, "connection_id");
    const existing = this.store.getIntegrationConnection(normalizedId);
    if (!existing) {
      throw new IntegrationServiceError(404, "connection not found");
    }

    // Connections are user-global; deleting one means it should also
    // disappear from every workspace that binds it. Cascade through all
    // bindings (orphaned + live) before dropping the connection so the
    // FK ON DELETE RESTRICT on integration_bindings doesn't block us
    // and we don't leave dangling references behind.
    const bindings = this.store
      .listIntegrationBindings({})
      .filter((b) => b.connectionId === normalizedId);
    for (const binding of bindings) {
      this.store.deleteIntegrationBinding(binding.bindingId);
    }

    this.store.deleteIntegrationConnection(normalizedId);
    return { deleted: true, removed_bindings: bindings.length };
  }

  checkReadiness(params: {
    workspaceId: string;
    appId: string;
  }): IntegrationReadinessResult {
    const workspaceId = requiredString(params.workspaceId, "workspace_id");
    const appId = requiredString(params.appId, "app_id");
    requireWorkspace(this.store, workspaceId);

    const workspaceDir = this.store.workspaceDir(workspaceId);
    try {
      const appRuntime = resolveWorkspaceAppRuntime(workspaceDir, appId, {
        store: this.store,
        workspaceId
      });
      return checkIntegrationReadiness({
        store: this.store,
        workspaceId,
        appId,
        resolvedApp: appRuntime.resolvedApp
      });
    } catch {
      return { ready: true, issues: [] };
    }
  }
}
