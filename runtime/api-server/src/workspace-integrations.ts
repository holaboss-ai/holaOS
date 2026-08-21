import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import { invalidateComposioInlineToolCache } from "./composio-cache-invalidation.js";
import { resolveConnectionMerged } from "./integration-connections-merged.js";

export class WorkspaceIntegrationsService {
  private readonly store: RuntimeStateStore;

  constructor(store: RuntimeStateStore) {
    this.store = store;
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

  async setWorkspaceDefaultAccount(params: {
    workspaceId: string;
    providerId: string;
    connectionId: string;
  }): Promise<{ connection_id: string }> {
    const connection = await resolveConnectionMerged(
      this.store,
      params.connectionId,
    );
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
    // The default binding decides WHICH account's tools the listing resolves
    // (see the composio toolkit resolver's workspace_default lookup), so changing
    // it changes the tool set just as much as connecting does — drop the cached
    // listing or the previous account's tools stay in front of the agent.
    invalidateComposioInlineToolCache(this.store);
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
    // Clearing the default falls resolution back to another account, so the
    // listing changes here too.
    invalidateComposioInlineToolCache(this.store);
    return { deleted: true };
  }
}
