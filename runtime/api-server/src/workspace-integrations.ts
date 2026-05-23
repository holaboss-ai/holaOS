import type {
  RuntimeStateStore,
  WorkspaceIntegrationOverrideRecord,
  WorkspaceIntegrationOverrideState,
} from "@holaboss/runtime-state-store";

import { hasHeroEntry } from "./composio-tool-registry.js";
import { isInStoreCatalog } from "./integration-store-catalog.js";
import type { ComposioConnectionSummary, ComposioService } from "./composio-service.js";

export type WorkspaceIntegrationEffectiveState =
  | "auto"        // No override: inherits the account active pool.
  | "disabled"    // Override: explicitly disabled in this workspace.
  | "pinned";     // Override: locked to a specific connected_account.

export interface WorkspaceIntegrationConnectionView {
  connected_account_id: string;
  status: string;
  user_id: string;
  created_at: string;
}

export interface WorkspaceIntegrationView {
  toolkit_slug: string;
  toolkit_name: string;
  toolkit_logo: string | null;
  /** True if the agent can use this toolkit (always true for ACTIVE connections; reserved for future "agent-incompatible" flags). */
  supported: boolean;
  /** "hero" = hand-curated tool set; "auto" = discovered from Composio. */
  tier: "hero" | "auto";
  effective_state: WorkspaceIntegrationEffectiveState;
  effective_connection_id: string | null;
  pinned_connection_id: string | null;
  connections: WorkspaceIntegrationConnectionView[];
}

export interface ListWorkspaceIntegrationsResult {
  workspace_id: string;
  integrations: WorkspaceIntegrationView[];
}

export class WorkspaceIntegrationsService {
  private readonly store: RuntimeStateStore;
  private readonly composio: ComposioService | null;

  constructor(store: RuntimeStateStore, composio: ComposioService | null) {
    this.store = store;
    this.composio = composio;
  }

  async list(workspaceId: string): Promise<ListWorkspaceIntegrationsResult> {
    const overrides = this.store.listWorkspaceIntegrationOverrides({ workspaceId });
    const overrideByToolkit = new Map<string, WorkspaceIntegrationOverrideRecord>();
    for (const o of overrides) overrideByToolkit.set(o.toolkitSlug, o);

    let connections: ComposioConnectionSummary[] = [];
    if (this.composio) {
      try {
        connections = await this.composio.listConnections();
      } catch {
        connections = [];
      }
    }
    const grouped = new Map<string, ComposioConnectionSummary[]>();
    for (const conn of connections) {
      if (conn.status !== "ACTIVE") continue;
      const list = grouped.get(conn.toolkitSlug);
      if (list) list.push(conn);
      else grouped.set(conn.toolkitSlug, [conn]);
    }

    // Show one row per toolkit that the user has at least one active
    // connection for OR an explicit override for. Sorted: supported
    // first (so the user lands on the controllable ones), then alpha.
    const toolkitSlugs = new Set<string>();
    for (const slug of grouped.keys()) toolkitSlugs.add(slug);
    for (const slug of overrideByToolkit.keys()) toolkitSlugs.add(slug);

    const views: WorkspaceIntegrationView[] = [];
    for (const slug of toolkitSlugs) {
      const conns = grouped.get(slug) ?? [];
      const override = overrideByToolkit.get(slug) ?? null;
      const tier = hasHeroEntry(slug) ? "hero" : "auto";
      // Out-of-scope toolkits (somehow connected outside the curated
      // store) get supported=false so the agent ignores them and the UI
      // hides them. The user can still see + remove them from the
      // account-level IntegrationsPane.
      const supported = conns.length > 0 && isInStoreCatalog(slug);
      const sample = conns[0] ?? null;

      let effectiveState: WorkspaceIntegrationEffectiveState = "auto";
      let effectiveConnectionId: string | null = sample?.id ?? null;
      if (override?.state === "disabled") {
        effectiveState = "disabled";
        effectiveConnectionId = null;
      } else if (override?.state === "pinned") {
        effectiveState = "pinned";
        effectiveConnectionId =
          override.pinnedConnectionId &&
          conns.some((c) => c.id === override.pinnedConnectionId)
            ? override.pinnedConnectionId
            : null;
      }

      views.push({
        toolkit_slug: slug,
        toolkit_name: sample?.toolkitName || slug,
        toolkit_logo: sample?.toolkitLogo ?? null,
        supported,
        tier,
        effective_state: effectiveState,
        effective_connection_id: effectiveConnectionId,
        pinned_connection_id: override?.pinnedConnectionId ?? null,
        connections: conns.map((c) => ({
          connected_account_id: c.id,
          status: c.status,
          user_id: c.userId,
          created_at: c.createdAt,
        })),
      });
    }

    views.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === "hero" ? -1 : 1;
      return a.toolkit_slug.localeCompare(b.toolkit_slug);
    });

    return { workspace_id: workspaceId, integrations: views };
  }

  setOverride(params: {
    workspaceId: string;
    toolkitSlug: string;
    state: WorkspaceIntegrationOverrideState;
    pinnedConnectionId?: string | null;
  }): WorkspaceIntegrationOverrideRecord {
    if (params.state === "pinned" && !params.pinnedConnectionId) {
      throw new Error("pinned state requires pinned_connection_id");
    }
    return this.store.upsertWorkspaceIntegrationOverride({
      workspaceId: params.workspaceId,
      toolkitSlug: params.toolkitSlug,
      state: params.state,
      pinnedConnectionId:
        params.state === "pinned" ? (params.pinnedConnectionId ?? null) : null,
    });
  }

  clearOverride(params: { workspaceId: string; toolkitSlug: string }): { deleted: boolean } {
    const deleted = this.store.deleteWorkspaceIntegrationOverride({
      workspaceId: params.workspaceId,
      toolkitSlug: params.toolkitSlug,
    });
    return { deleted };
  }

  // ---------------------------------------------------------------------
  // Workspace-default account selection (Layer 2 in the four-layer
  // account-resolution model — see active-account-resolver.ts).
  //
  // "When this workspace makes a direct (non-app) call to provider X,
  // use connection C by default unless a conversation pin overrides."
  //
  // Stored on the existing integration_bindings table with
  //   target_type = "workspace_default"
  //   target_id   = <workspace_id>
  //   integration_key = <provider_id>
  //   connection_id = <chosen connection>
  // No schema change required — the table already accepts arbitrary
  // target_type strings (app bindings already use target_type="app").
  // ---------------------------------------------------------------------

  getWorkspaceDefaultAccount(params: {
    workspaceId: string;
    providerId: string;
  }): { connection_id: string | null } {
    const binding = this.store.getIntegrationBindingByTarget({
      workspaceId: params.workspaceId,
      targetType: "workspace_default",
      targetId: params.workspaceId,
      integrationKey: params.providerId,
    });
    return { connection_id: binding?.connectionId ?? null };
  }

  setWorkspaceDefaultAccount(params: {
    workspaceId: string;
    providerId: string;
    connectionId: string;
  }): { connection_id: string } {
    const connection = this.store.getIntegrationConnection(params.connectionId);
    if (!connection) {
      throw new Error(`integration connection ${params.connectionId} not found`);
    }
    if (connection.providerId.trim().toLowerCase() !== params.providerId.trim().toLowerCase()) {
      throw new Error(
        `connection ${params.connectionId} belongs to provider ${connection.providerId}, not ${params.providerId}`,
      );
    }
    if (connection.status.trim().toLowerCase() !== "active") {
      throw new Error(`connection ${params.connectionId} is not active (status=${connection.status})`);
    }
    this.store.upsertIntegrationBinding({
      bindingId: `wsd:${params.workspaceId}:${params.providerId.toLowerCase()}`,
      workspaceId: params.workspaceId,
      targetType: "workspace_default",
      targetId: params.workspaceId,
      integrationKey: params.providerId.toLowerCase(),
      connectionId: params.connectionId,
      isDefault: true,
    });
    return { connection_id: params.connectionId };
  }

  clearWorkspaceDefaultAccount(params: {
    workspaceId: string;
    providerId: string;
  }): { deleted: boolean } {
    const existing = this.store.getIntegrationBindingByTarget({
      workspaceId: params.workspaceId,
      targetType: "workspace_default",
      targetId: params.workspaceId,
      integrationKey: params.providerId.toLowerCase(),
    });
    if (!existing) return { deleted: false };
    this.store.deleteIntegrationBinding(existing.bindingId);
    return { deleted: true };
  }
}
