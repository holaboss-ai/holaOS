import type { RequestFn } from "../request";

export type IntegrationCatalogProvider = {
  provider_id: string;
  display_name: string;
  description: string;
  auth_modes: string[];
  supports_oss: boolean;
  supports_managed: boolean;
  default_scopes: string[];
  docs_url: string | null;
};

export type IntegrationCatalogResponse = {
  providers: IntegrationCatalogProvider[];
};

export type IntegrationConnection = {
  connection_id: string;
  provider_id: string;
  owner_user_id: string;
  account_label: string;
  account_external_id: string | null;
  account_handle: string | null;
  account_email: string | null;
  auth_mode: string;
  granted_scopes: string[];
  status: string;
  secret_ref: string | null;
  created_at: string;
  updated_at: string;
};

export type IntegrationConnectionListResponse = {
  connections: IntegrationConnection[];
};

export type IntegrationBinding = {
  binding_id: string;
  workspace_id: string;
  target_type: "workspace" | "app" | "agent";
  target_id: string;
  integration_key: string;
  connection_id: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type IntegrationBindingListResponse = {
  bindings: IntegrationBinding[];
};

export type IntegrationUpsertBindingPayload = {
  connection_id: string;
  is_default?: boolean;
};

export type IntegrationCreateConnectionPayload = {
  provider_id: string;
  owner_user_id: string;
  account_label: string;
  auth_mode: string;
  granted_scopes: string[];
  secret_ref?: string;
};

export type IntegrationUpdateConnectionPayload = {
  status?: string;
  secret_ref?: string;
  account_label?: string;
  account_handle?: string | null;
  account_email?: string | null;
};

export type IntegrationMergeConnectionsResult = {
  kept_connection_id: string;
  removed_count: number;
  repointed_bindings: number;
};

export type OAuthAppConfig = {
  provider_id: string;
  client_id: string;
  client_secret: string;
  authorize_url: string;
  token_url: string;
  scopes: string[];
  redirect_port: number;
  created_at: string;
  updated_at: string;
};

export type OAuthAppConfigListResponse = {
  configs: OAuthAppConfig[];
};

export type OAuthAppConfigUpsertPayload = {
  client_id: string;
  client_secret: string;
  authorize_url: string;
  token_url: string;
  scopes: string[];
  redirect_port?: number;
};

export type OAuthAuthorizeResponse = {
  authorize_url: string;
  state: string;
};

export type ListIntegrationConnectionsParams = {
  providerId?: string;
  ownerUserId?: string;
};

export type ComposioFinalizePayload = {
  connected_account_id: string;
  provider: string;
  owner_user_id: string;
  account_label?: string;
  account_handle?: string | null;
  account_email?: string | null;
};

export type IntegrationsMethods = {
  listCatalog(): Promise<IntegrationCatalogResponse>;
  listConnections(
    params?: ListIntegrationConnectionsParams
  ): Promise<IntegrationConnectionListResponse>;
  createConnection(
    payload: IntegrationCreateConnectionPayload
  ): Promise<IntegrationConnection>;
  updateConnection(
    connectionId: string,
    payload: IntegrationUpdateConnectionPayload
  ): Promise<IntegrationConnection>;
  deleteConnection(connectionId: string): Promise<{ deleted: boolean }>;
  mergeConnections(
    keepConnectionId: string,
    removeConnectionIds: string[]
  ): Promise<IntegrationMergeConnectionsResult>;
  listBindings(workspaceId: string): Promise<IntegrationBindingListResponse>;
  upsertBinding(
    workspaceId: string,
    targetType: string,
    targetId: string,
    integrationKey: string,
    payload: IntegrationUpsertBindingPayload
  ): Promise<IntegrationBinding>;
  deleteBinding(
    bindingId: string,
    workspaceId: string
  ): Promise<{ deleted: boolean }>;
  listOAuthConfigs(): Promise<OAuthAppConfigListResponse>;
  upsertOAuthConfig(
    providerId: string,
    payload: OAuthAppConfigUpsertPayload
  ): Promise<OAuthAppConfig>;
  deleteOAuthConfig(providerId: string): Promise<{ deleted: boolean }>;
  authorizeOAuth(payload: {
    provider: string;
    owner_user_id: string;
  }): Promise<OAuthAuthorizeResponse>;
  composioFinalize(
    payload: ComposioFinalizePayload & Record<string, unknown>
  ): Promise<IntegrationConnection>;
};

export function makeIntegrationsMethods(
  request: RequestFn
): IntegrationsMethods {
  return {
    listCatalog() {
      return request<IntegrationCatalogResponse>({
        method: "GET",
        path: "/api/v1/integrations/catalog",
      });
    },
    listConnections(params) {
      return request<IntegrationConnectionListResponse>({
        method: "GET",
        path: "/api/v1/integrations/connections",
        params: {
          provider_id: params?.providerId,
          owner_user_id: params?.ownerUserId,
        },
      });
    },
    createConnection(payload) {
      return request<IntegrationConnection>({
        method: "POST",
        path: "/api/v1/integrations/connections",
        payload,
      });
    },
    updateConnection(connectionId, payload) {
      return request<IntegrationConnection>({
        method: "PATCH",
        path: `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`,
        payload,
      });
    },
    deleteConnection(connectionId) {
      return request<{ deleted: boolean }>({
        method: "DELETE",
        path: `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}`,
      });
    },
    mergeConnections(keepConnectionId, removeConnectionIds) {
      return request<IntegrationMergeConnectionsResult>({
        method: "POST",
        path: `/api/v1/integrations/connections/${encodeURIComponent(keepConnectionId)}/merge`,
        payload: { remove_connection_ids: removeConnectionIds },
      });
    },
    listBindings(workspaceId) {
      return request<IntegrationBindingListResponse>({
        method: "GET",
        path: "/api/v1/integrations/bindings",
        params: { workspace_id: workspaceId },
      });
    },
    upsertBinding(workspaceId, targetType, targetId, integrationKey, payload) {
      return request<IntegrationBinding>({
        method: "PUT",
        path: `/api/v1/integrations/bindings/${encodeURIComponent(workspaceId)}/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}/${encodeURIComponent(integrationKey)}`,
        payload,
      });
    },
    deleteBinding(bindingId, workspaceId) {
      return request<{ deleted: boolean }>({
        method: "DELETE",
        path: `/api/v1/integrations/bindings/${encodeURIComponent(bindingId)}`,
        params: { workspace_id: workspaceId },
      });
    },
    listOAuthConfigs() {
      return request<OAuthAppConfigListResponse>({
        method: "GET",
        path: "/api/v1/integrations/oauth/configs",
      });
    },
    upsertOAuthConfig(providerId, payload) {
      return request<OAuthAppConfig>({
        method: "PUT",
        path: `/api/v1/integrations/oauth/configs/${encodeURIComponent(providerId)}`,
        payload,
      });
    },
    deleteOAuthConfig(providerId) {
      return request<{ deleted: boolean }>({
        method: "DELETE",
        path: `/api/v1/integrations/oauth/configs/${encodeURIComponent(providerId)}`,
      });
    },
    authorizeOAuth(payload) {
      return request<OAuthAuthorizeResponse>({
        method: "POST",
        path: "/api/v1/integrations/oauth/authorize",
        payload,
      });
    },
    composioFinalize(payload) {
      return request<IntegrationConnection>({
        method: "POST",
        path: "/api/v1/integrations/composio/finalize",
        payload,
      });
    },
  };
}
