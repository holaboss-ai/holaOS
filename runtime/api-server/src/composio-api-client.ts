// Server-side client for Composio's curated API surface, used by the
// runtime when it needs to talk to Composio outside the context of an
// active browser session (cron tasks, onboarding context prefetch,
// background data harvesting). Pairs with the `/api/composio/internal/*`
// route family on the Hono worker.
//
// Security model (read this before changing anything):
//
//   - Auth is a Better-Auth bearer token. There is NO org-wide service
//     token, no symmetric API key, no impersonation surface — by design,
//     because holaOS ships open source and any such secret would be
//     extractable from a published build.
//
//   - The token IS the Better-Auth session token for a real user. The
//     desktop captures it when the user signs in (Better-Auth's bearer
//     plugin returns it via the `set-auth-token` response header) and
//     injects it into the runtime as HOLABOSS_AUTH_BEARER_TOKEN.
//
//   - The runtime never declares "owner_user_id" — Hono derives it from
//     the resolved session user. A misbehaving runtime cannot lie about
//     which user it represents; the worst it can do is exhaust its own
//     user's Composio quota.
//
//   - Connection ownership is still re-verified upstream at Composio:
//     the session user can only act on connected accounts whose
//     user_id matches their own.

export interface ComposioApiClientConfig {
  /** Hono base URL (no trailing slash). Env: HOLABOSS_AUTH_BASE_URL. */
  honoBaseUrl: string;
  /** Better-Auth session token for the real user this runtime represents.
   *  Env: HOLABOSS_AUTH_BEARER_TOKEN. Sent as `Authorization: Bearer <token>`.
   *  Issued to the desktop via Better-Auth's bearer() plugin on login. */
  bearerToken: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

export interface ComposioApiClientErrorInfo {
  code: string;
  message?: string;
  status?: number;
  slug?: string;
  logId?: string;
  connectedAccountId?: string;
  userAction?: string;
}

/** Thrown when a Composio internal call did not return ok=true. Carries
 *  the structured error from Hono so callers can branch on `info.code`. */
export class ComposioApiClientError extends Error {
  readonly info: ComposioApiClientErrorInfo;
  readonly httpStatus: number;

  constructor(httpStatus: number, info: ComposioApiClientErrorInfo) {
    super(info.message ?? info.code);
    this.name = "ComposioApiClientError";
    this.info = info;
    this.httpStatus = httpStatus;
  }
}

export interface ExecuteActionParams {
  toolSlug: string;
  connectedAccountId: string;
  arguments?: Record<string, unknown>;
}

export interface ExecuteActionResponse<TData = unknown> {
  data: TData | null;
  logId: string | null;
}

export interface ProxyRequestParams {
  connectedAccountId: string;
  endpoint: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ProxyRequestResponse<TData = unknown> {
  data: TData | null;
  status: number;
  headers: Record<string, string>;
}

export interface ListConnectionsParams {
  providerId?: string;
}

export interface ListConnectionsResponse {
  connections: Array<Record<string, unknown>>;
}

export interface GetConnectionResponse {
  connection: Record<string, unknown>;
}

export interface ListToolkitToolsResponse {
  tools: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asErrorInfo(raw: unknown, fallbackCode: string): ComposioApiClientErrorInfo {
  if (!isRecord(raw)) {
    return { code: fallbackCode };
  }
  const out: ComposioApiClientErrorInfo = {
    code: typeof raw.code === "string" ? raw.code : fallbackCode,
  };
  if (typeof raw.message === "string") out.message = raw.message;
  if (typeof raw.status === "number") out.status = raw.status;
  if (typeof raw.slug === "string") out.slug = raw.slug;
  if (typeof raw.log_id === "string") out.logId = raw.log_id;
  if (typeof raw.connected_account_id === "string") {
    out.connectedAccountId = raw.connected_account_id;
  }
  if (typeof raw.user_action === "string") out.userAction = raw.user_action;
  return out;
}

export class ComposioApiClient {
  readonly honoBaseUrl: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ComposioApiClientConfig) {
    if (!config.honoBaseUrl) {
      throw new Error("ComposioApiClient: honoBaseUrl is required");
    }
    if (!config.bearerToken) {
      throw new Error("ComposioApiClient: bearerToken is required");
    }
    this.honoBaseUrl = config.honoBaseUrl.replace(/\/+$/, "");
    this.bearerToken = config.bearerToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Execute a Composio cataloged tool by slug on behalf of the session
   *  user. Generic — covers any of Composio's curated tool slugs. */
  async executeAction<TData = unknown>(
    params: ExecuteActionParams,
  ): Promise<ExecuteActionResponse<TData>> {
    const response = await this.postJson("/api/composio/internal/tools/execute", {
      tool_slug: params.toolSlug,
      connected_account_id: params.connectedAccountId,
      arguments: params.arguments ?? {},
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      data?: TData | null;
      log_id?: string | null;
      error?: Record<string, unknown>;
    };
    if (!response.ok || payload.ok === false) {
      throw new ComposioApiClientError(
        response.status,
        asErrorInfo(payload.error, "composio_execute_failed"),
      );
    }
    return {
      data: (payload.data ?? null) as TData | null,
      logId: payload.log_id ?? null,
    };
  }

  /** Forward an arbitrary upstream HTTP request through Composio's
   *  /tools/execute/proxy endpoint. Use when the action isn't in
   *  Composio's curated catalog but the toolkit's REST API exposes it. */
  async proxyRequest<TData = unknown>(
    params: ProxyRequestParams,
  ): Promise<ProxyRequestResponse<TData>> {
    const response = await this.postJson("/api/composio/internal/proxy", {
      connected_account_id: params.connectedAccountId,
      endpoint: params.endpoint,
      method: params.method ?? "GET",
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.headers ? { headers: params.headers } : {}),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      data?: TData | null;
      status?: number;
      headers?: Record<string, string>;
      error?: Record<string, unknown>;
    };
    if (!response.ok || payload.ok === false) {
      throw new ComposioApiClientError(
        response.status,
        asErrorInfo(payload.error, "composio_proxy_failed"),
      );
    }
    return {
      data: (payload.data ?? null) as TData | null,
      status: payload.status ?? response.status,
      headers: payload.headers ?? {},
    };
  }

  /** List the session user's Composio connected accounts, optionally
   *  filtered by toolkit. */
  async listConnections(
    params: ListConnectionsParams = {},
  ): Promise<ListConnectionsResponse> {
    const search = new URLSearchParams();
    if (params.providerId) {
      search.set("provider_id", params.providerId);
    }
    const qs = search.toString();
    const path = qs
      ? `/api/composio/internal/connections?${qs}`
      : "/api/composio/internal/connections";
    const response = await this.getJson(path);
    const payload = (await response.json()) as {
      ok?: boolean;
      connections?: Array<Record<string, unknown>>;
      error?: Record<string, unknown>;
    };
    if (!response.ok || payload.ok === false) {
      throw new ComposioApiClientError(
        response.status,
        asErrorInfo(payload.error, "composio_list_connections_failed"),
      );
    }
    return { connections: payload.connections ?? [] };
  }

  /** Read a single Composio connected account by id. */
  async getConnection(connectionId: string): Promise<GetConnectionResponse> {
    const response = await this.getJson(
      `/api/composio/internal/connections/${encodeURIComponent(connectionId)}`,
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      connection?: Record<string, unknown>;
      error?: Record<string, unknown>;
    };
    if (!response.ok || payload.ok === false) {
      throw new ComposioApiClientError(
        response.status,
        asErrorInfo(payload.error, "composio_get_connection_failed"),
      );
    }
    return { connection: payload.connection ?? {} };
  }

  /** Enumerate the catalog of executable tools for a toolkit. */
  async listToolkitTools(toolkitSlug: string): Promise<ListToolkitToolsResponse> {
    const response = await this.getJson(
      `/api/composio/internal/toolkits/${encodeURIComponent(toolkitSlug)}/tools`,
    );
    const payload = (await response.json()) as {
      ok?: boolean;
      tools?: Array<Record<string, unknown>>;
      error?: Record<string, unknown>;
    };
    if (!response.ok || payload.ok === false) {
      throw new ComposioApiClientError(
        response.status,
        asErrorInfo(payload.error, "composio_list_tools_failed"),
      );
    }
    return { tools: payload.tools ?? [] };
  }

  private postJson(path: string, body: Record<string, unknown>): Promise<Response> {
    return this.fetchImpl(`${this.honoBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  private getJson(path: string): Promise<Response> {
    return this.fetchImpl(`${this.honoBaseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        Accept: "application/json",
      },
    });
  }
}

/** Build a `ComposioApiClient` from the runtime's standard env vars.
 *  Returns `null` when either env is missing so the caller can branch on
 *  "no signed-in user available in this process" without throwing at
 *  boot. */
export function createComposioApiClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ComposioApiClient | null {
  const honoBaseUrl = (env.HOLABOSS_AUTH_BASE_URL ?? "").trim();
  const bearerToken = (env.HOLABOSS_AUTH_BEARER_TOKEN ?? "").trim();
  if (!honoBaseUrl || !bearerToken) {
    return null;
  }
  return new ComposioApiClient({ honoBaseUrl, bearerToken });
}
