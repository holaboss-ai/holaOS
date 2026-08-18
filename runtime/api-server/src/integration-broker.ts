import { type RuntimeStateStore } from "@holaboss/runtime-state-store";

import { resolveConnectionMerged } from "./integration-connections-merged.js";
import { validateSignedGrant } from "./grant-signing.js";
import { invalidateComposioInlineToolCache } from "./composio-cache-invalidation.js";

export type BrokerErrorCode =
  | "grant_invalid"
  | "integration_not_bound"
  | "connection_inactive"
  | "token_unavailable";

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly statusCode: number;

  constructor(code: BrokerErrorCode, statusCode: number, message: string) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ParsedAppGrant {
  workspaceId: string;
  appId: string;
  nonce: string;
}

export interface TokenExchangeResult {
  token: string;
  provider: string;
  connection_id: string;
}

export function parseAppGrant(grant: string): ParsedAppGrant | null {
  if (typeof grant !== "string" || !grant.startsWith("grant:")) {
    return null;
  }
  const parts = grant.slice("grant:".length).split(":");
  if (parts.length < 3) {
    return null;
  }
  const workspaceId = parts[0]!;
  const appId = parts[1]!;
  const nonce = parts.slice(2).join(":");
  if (!workspaceId || !appId || !nonce) {
    return null;
  }
  return { workspaceId, appId, nonce };
}

export interface ComposioProxyRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ComposioProxyResponse {
  data: unknown;
  status: number;
  headers: Record<string, string>;
}

export interface ProviderConnectionRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  endpoint?: string;
  url?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ProviderConnectionResponse {
  connection_id: string;
  provider: string;
  transport: "proxy" | "bearer";
  data: unknown;
  status: number;
  headers: Record<string, string>;
}

export interface ComposioTokenResolver {
  proxyRequest(params: { connectedAccountId: string } & ComposioProxyRequest): Promise<ComposioProxyResponse>;
}

export class IntegrationBrokerService {
  readonly store: RuntimeStateStore;
  private readonly composio: ComposioTokenResolver | null;

  constructor(store: RuntimeStateStore, composio?: ComposioTokenResolver | null) {
    this.store = store;
    this.composio = composio ?? null;
  }

  async exchangeToken(params: {
    grant: string;
    provider: string;
  }): Promise<TokenExchangeResult> {
    const validated = validateSignedGrant(params.grant);
    const parsed = validated
      ? { workspaceId: validated.workspaceId, appId: validated.appId, nonce: validated.nonce }
      : parseAppGrant(params.grant);
    if (!parsed) {
      throw new BrokerError("grant_invalid", 401, "app grant is malformed");
    }

    const provider = params.provider.trim();
    if (!provider) {
      throw new BrokerError("grant_invalid", 401, "provider is required");
    }

    const binding =
      this.store.getIntegrationBindingByTarget({
        workspaceId: parsed.workspaceId,
        targetType: "app",
        targetId: parsed.appId,
        integrationKey: provider
      }) ??
      this.store.getIntegrationBindingByTarget({
        workspaceId: parsed.workspaceId,
        targetType: "workspace",
        targetId: "default",
        integrationKey: provider
      });

    if (!binding) {
      throw new BrokerError(
        "integration_not_bound",
        404,
        `no ${provider} binding for workspace ${parsed.workspaceId}`
      );
    }

    const connection = this.store.getIntegrationConnection(
      binding.connectionId
    );
    if (!connection) {
      throw new BrokerError(
        "integration_not_bound",
        404,
        `connection ${binding.connectionId} not found`
      );
    }

    if (connection.status.trim().toLowerCase() !== "active") {
      throw new BrokerError(
        "connection_inactive",
        403,
        `${provider} connection is ${connection.status}`
      );
    }

    if (connection.authMode === "composio") {
      throw new BrokerError(
        "token_unavailable",
        400,
        `${provider} uses managed auth — use /broker/proxy instead of /broker/token`
      );
    }

    if (!connection.secretRef) {
      throw new BrokerError(
        "token_unavailable",
        503,
        `${provider} connection has no credential`
      );
    }

    const token = await this.resolveTokenWithRefresh(connection);
    return { token, provider, connection_id: connection.connectionId };
  }

  async proxyProviderRequest(params: {
    grant: string;
    provider: string;
    request: ComposioProxyRequest;
  }): Promise<ComposioProxyResponse> {
    const validated = validateSignedGrant(params.grant);
    const parsed = validated
      ? { workspaceId: validated.workspaceId, appId: validated.appId, nonce: validated.nonce }
      : parseAppGrant(params.grant);
    if (!parsed) {
      throw new BrokerError("grant_invalid", 401, "app grant is malformed");
    }

    const provider = params.provider.trim();
    if (!provider) {
      throw new BrokerError("grant_invalid", 401, "provider is required");
    }

    const binding =
      this.store.getIntegrationBindingByTarget({
        workspaceId: parsed.workspaceId,
        targetType: "app",
        targetId: parsed.appId,
        integrationKey: provider
      }) ??
      this.store.getIntegrationBindingByTarget({
        workspaceId: parsed.workspaceId,
        targetType: "workspace",
        targetId: "default",
        integrationKey: provider
      });

    if (!binding) {
      throw new BrokerError("integration_not_bound", 404, `no ${provider} binding for workspace ${parsed.workspaceId}`);
    }

    const connection = await resolveConnectionMerged(
      this.store,
      binding.connectionId,
    );
    if (!connection) {
      throw new BrokerError("integration_not_bound", 404, `connection ${binding.connectionId} not found`);
    }

    if (connection.status.trim().toLowerCase() !== "active") {
      throw new BrokerError("connection_inactive", 403, `${provider} connection is ${connection.status}`);
    }

    if (connection.authMode === "composio") {
      if (!connection.accountExternalId) {
        throw new BrokerError("token_unavailable", 503, `${provider} composio connection has no linked account`);
      }
      if (!this.composio) {
        throw new BrokerError("token_unavailable", 503, "composio resolver is not configured");
      }
      return this.composio.proxyRequest({
        connectedAccountId: connection.accountExternalId,
        ...params.request
      });
    }

    throw new BrokerError("token_unavailable", 503, `proxy is only supported for composio connections, got auth_mode: ${connection.authMode}`);
  }

  async executeConnectionRequest(params: {
    connectionId: string;
    provider: string;
    request: ProviderConnectionRequest;
    transport?: "auto" | "proxy" | "bearer";
  }): Promise<ProviderConnectionResponse> {
    const provider = params.provider.trim();
    if (!provider) {
      throw new Error("provider is required");
    }
    const connection = this.store.getIntegrationConnection(params.connectionId);
    if (!connection) {
      throw new BrokerError(
        "integration_not_bound",
        404,
        `connection ${params.connectionId} not found`,
      );
    }
    if (connection.providerId.trim().toLowerCase() !== provider.toLowerCase()) {
      throw new Error(
        `connection ${params.connectionId} is bound to provider ${connection.providerId}, expected ${provider}`,
      );
    }
    if (connection.status.trim().toLowerCase() !== "active") {
      throw new BrokerError(
        "connection_inactive",
        403,
        `${provider} connection is ${connection.status}`,
      );
    }

    const transport =
      params.transport == null || params.transport === "auto"
        ? connection.authMode === "composio"
          ? "proxy"
          : "bearer"
        : params.transport;

    if (transport === "proxy") {
      if (connection.authMode !== "composio") {
        throw new Error(
          `provider ${provider} transport mismatch: proxy requires a composio connection`,
        );
      }
      const endpoint = params.request.endpoint?.trim();
      if (!endpoint) {
        throw new Error(`provider ${provider} proxy requests require request.endpoint`);
      }
      if (!connection.accountExternalId) {
        throw new BrokerError(
          "token_unavailable",
          503,
          `${provider} composio connection has no linked account`,
        );
      }
      if (!this.composio) {
        throw new BrokerError(
          "token_unavailable",
          503,
          "composio resolver is not configured",
        );
      }
      const response = await this.composio.proxyRequest({
        connectedAccountId: connection.accountExternalId,
        method: params.request.method,
        endpoint,
        ...(params.request.body !== undefined ? { body: params.request.body } : {}),
        ...(params.request.headers ? { headers: params.request.headers } : {}),
      });
      return {
        connection_id: connection.connectionId,
        provider,
        transport: "proxy",
        data: response.data,
        status: response.status,
        headers: response.headers,
      };
    }

    if (connection.authMode === "composio") {
      throw new Error(
        `provider ${provider} transport mismatch: bearer requests are not supported for composio connections`,
      );
    }
    const rawUrl = params.request.url?.trim();
    if (!rawUrl) {
      throw new Error(`provider ${provider} bearer requests require request.url`);
    }
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`provider ${provider} request.url must use http or https`);
    }

    const token = await this.resolveTokenWithRefresh(connection);
    const headers: Record<string, string> = {
      ...(params.request.headers ?? {}),
      Authorization: `Bearer ${token}`,
    };
    let body: string | undefined;
    if (params.request.body !== undefined) {
      if (typeof params.request.body === "string") {
        body = params.request.body;
      } else {
        body = JSON.stringify(params.request.body);
        if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
          headers["Content-Type"] = "application/json";
        }
      }
    }
    const response = await fetch(parsedUrl.toString(), {
      method: params.request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const contentType = response.headers.get("content-type") ?? "";
    let data: unknown = null;
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch {
        data = await response.text();
      }
    } else {
      data = await response.text();
    }
    return {
      connection_id: connection.connectionId,
      provider,
      transport: "bearer",
      data,
      status: response.status,
      headers: responseHeaders,
    };
  }

  private async resolveTokenWithRefresh(connection: {
    connectionId: string;
    providerId: string;
    secretRef: string | null;
    status: string;
    ownerUserId: string;
    accountLabel: string;
    authMode: string;
    grantedScopes: string[];
    accountExternalId: string | null;
    createdAt: string;
    updatedAt: string;
  }): Promise<string> {
    const secretRef = connection.secretRef;
    if (!secretRef) throw new BrokerError("token_unavailable", 503, "connection has no credential");

    let parsed: { access_token?: string; refresh_token?: string; expires_at?: string } | null = null;
    try { parsed = JSON.parse(secretRef); } catch { return secretRef; }
    if (!parsed?.access_token) return secretRef;

    if (parsed.expires_at && parsed.refresh_token) {
      const expiresAt = new Date(parsed.expires_at).getTime();
      if (Date.now() > expiresAt - 60_000) {
        const refreshed = await this.refreshToken(connection, parsed.refresh_token);
        if (refreshed) return refreshed;
      }
    }
    return parsed.access_token;
  }

  private async refreshToken(connection: {
    connectionId: string;
    providerId: string;
    secretRef: string | null;
    status: string;
    ownerUserId: string;
    accountLabel: string;
    authMode: string;
    grantedScopes: string[];
    accountExternalId: string | null;
    createdAt: string;
    updatedAt: string;
  }, refreshToken: string): Promise<string | null> {
    const config = this.store.getOAuthAppConfig(connection.providerId);
    if (!config) return null;
    try {
      const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: config.clientId,
          client_secret: config.clientSecret
        }).toString()
      });
      if (!response.ok) return null;
      const tokens = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number };
      const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
      const newPayload = JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? refreshToken,
        expires_at: expiresAt,
        token_type: "Bearer"
      });
      this.store.upsertIntegrationConnection({
        connectionId: connection.connectionId,
        providerId: connection.providerId,
        ownerUserId: connection.ownerUserId,
        accountLabel: connection.accountLabel,
        authMode: connection.authMode,
        grantedScopes: connection.grantedScopes,
        status: "active",
        secretRef: newPayload,
        accountExternalId: connection.accountExternalId
      });
      // Only when this refresh REVIVES the connection. A routine refresh swaps
      // secretRef on an already-active row and cannot change the active-toolkit
      // set the inline listing is derived from — invalidating there would drop
      // the cache on a background token rotation and undo the point of having it.
      if (connection.status !== "active") {
        invalidateComposioInlineToolCache(this.store);
      }
      return tokens.access_token;
    } catch { return null; }
  }
}
