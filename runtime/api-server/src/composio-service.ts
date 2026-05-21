/**
 * ComposioService — runtime-side client that proxies Composio operations
 * through the Hono backend server, authenticated via the user's session cookie.
 *
 * The runtime never calls Composio directly and never holds COMPOSIO_API_KEY.
 */

export interface ComposioServiceConfig {
  /** Hono server base URL, e.g. "http://localhost:4000" or "https://api.holaboss.ai" */
  honoBaseUrl: string;
  /** Better Auth session cookie from the desktop */
  authCookie: string;
  fetchImpl?: typeof fetch;
}

export interface ProxyResponse<TData = unknown> {
  data: TData | null;
  status: number;
  headers: Record<string, string>;
}

export interface ExecuteToolParams {
  toolSlug: string;
  connectedAccountId: string;
  arguments?: Record<string, unknown>;
}

export interface ExecuteToolResponse<TData = unknown> {
  data: TData | null;
  logId: string | null;
}

export interface ComposioExecuteError {
  code: string;
  message?: string;
  slug?: string | null;
  status?: number;
  log_id?: string | null;
  connected_account_id?: string;
  user_action?: string;
}

export class ComposioToolExecutionError extends Error {
  readonly httpStatus: number;
  readonly detail: ComposioExecuteError;

  constructor(httpStatus: number, detail: ComposioExecuteError) {
    super(detail.message ?? `Composio execute failed (${detail.code})`);
    this.name = "ComposioToolExecutionError";
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

export interface ComposioToolDescriptor {
  slug: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  scopes: string[];
  tags: string[];
  read_only: boolean;
  deprecated: boolean;
}

export interface ComposioConnectionSummary {
  id: string;
  status: string;
  toolkitSlug: string;
  toolkitName: string;
  toolkitLogo: string | null;
  userId: string;
  createdAt: string;
}

export class ComposioService {
  readonly honoBaseUrl: string;
  readonly authCookie: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ComposioServiceConfig) {
    this.honoBaseUrl = config.honoBaseUrl.replace(/\/+$/, "");
    // Better Auth's Electron client returns the cookie header as `; name=value`
    // (leading "; " — used to splice onto an existing Cookie header). When we
    // pass this verbatim as a fresh `Cookie:` header, Hono on Cloudflare Workers
    // sees a leading empty cookie pair and the session-auth middleware crashes
    // → the Worker bubbles a generic 500 "Internal Server Error" instead of a
    // clean 401. Strip the leading `; ` (and any other leading whitespace /
    // semicolons) so the header starts with the first real `name=value` pair.
    this.authCookie = config.authCookie.replace(/^[\s;]+/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async proxyRequest<TData = unknown>(params: {
    connectedAccountId: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    endpoint: string;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<ProxyResponse<TData>> {
    const response = await this.fetchImpl(`${this.honoBaseUrl}/api/composio/proxy`, {
      method: "POST",
      headers: {
        Cookie: this.authCookie,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        connected_account_id: params.connectedAccountId,
        endpoint: params.endpoint,
        method: params.method,
        ...(params.body !== undefined ? { body: params.body } : {}),
        ...(params.headers ? { headers: params.headers } : {}),
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Composio proxy via Hono failed: ${response.status} ${text.slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      data?: TData | null;
      status?: number;
      headers?: Record<string, string>;
    };
    return {
      data: payload.data ?? null,
      status: payload.status ?? response.status,
      headers: payload.headers ?? {},
    };
  }

  /**
   * Invoke a Composio cataloged tool by slug. Used by the composio-mcp
   * sidecar to expose Composio integrations directly to the agent without
   * requiring an app wrapper. Throws ComposioToolExecutionError on any
   * non-2xx — the caller (MCP host) translates that into a structured
   * tool-error result for the agent.
   */
  async executeTool<TData = unknown>(
    params: ExecuteToolParams
  ): Promise<ExecuteToolResponse<TData>> {
    const response = await this.fetchImpl(`${this.honoBaseUrl}/api/composio/execute`, {
      method: "POST",
      headers: {
        Cookie: this.authCookie,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        tool_slug: params.toolSlug,
        connected_account_id: params.connectedAccountId,
        arguments: params.arguments ?? {},
      }),
    });

    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      data?: TData | null;
      log_id?: string | null;
      error?: ComposioExecuteError;
    } | null;

    if (!response.ok || payload?.ok === false) {
      const detail: ComposioExecuteError = payload?.error ?? {
        code: "unknown_error",
        message: `HTTP ${response.status}`,
      };
      throw new ComposioToolExecutionError(response.status, detail);
    }

    return {
      data: payload?.data ?? null,
      logId: payload?.log_id ?? null,
    };
  }

  /**
   * List the session user's Composio connections via Hono.
   * Used by the composio-mcp manager to discover which toolkits the user
   * has connected (and thus which tools to surface to the agent).
   */
  async listConnections(): Promise<ComposioConnectionSummary[]> {
    const response = await this.fetchImpl(`${this.honoBaseUrl}/api/composio/connections`, {
      method: "GET",
      headers: {
        Cookie: this.authCookie,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Composio listConnections via Hono failed: ${response.status} ${text.slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      connections?: Array<{
        id?: string;
        status?: string;
        toolkitSlug?: string;
        toolkitName?: string;
        toolkitLogo?: string | null;
        userId?: string;
        createdAt?: string;
      }>;
    };
    return (payload.connections ?? []).map((entry) => ({
      id: entry.id ?? "",
      status: (entry.status ?? "UNKNOWN").toUpperCase(),
      toolkitSlug: entry.toolkitSlug ?? "",
      toolkitName: entry.toolkitName ?? entry.toolkitSlug ?? "",
      toolkitLogo: entry.toolkitLogo ?? null,
      userId: entry.userId ?? "",
      createdAt: entry.createdAt ?? "",
    }));
  }

  /**
   * Fetch a toolkit's full tool catalog from Composio (cached 24h on the
   * Hono side). Used when we haven't hand-written entries for a toolkit
   * in TOOLKIT_CATALOG — the runtime falls back to this and applies a
   * verb-pattern heuristic to pick a top-N subset to expose to the agent.
   */
  async listToolkitTools(toolkitSlug: string): Promise<ComposioToolDescriptor[]> {
    const response = await this.fetchImpl(
      `${this.honoBaseUrl}/api/composio/tools?toolkit_slug=${encodeURIComponent(toolkitSlug)}`,
      {
        method: "GET",
        headers: {
          Cookie: this.authCookie,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Composio listToolkitTools via Hono failed: ${response.status} ${text.slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      tools?: Array<{
        slug?: string;
        name?: string;
        description?: string;
        input_parameters?: Record<string, unknown>;
        scopes?: string[];
        tags?: string[];
        is_deprecated?: boolean;
      }>;
    };
    return (payload.tools ?? []).map((tool) => {
      const tags = Array.isArray(tool.tags) ? tool.tags.filter((t): t is string => typeof t === "string") : [];
      return {
        slug: tool.slug ?? "",
        name: tool.name ?? tool.slug ?? "",
        description: tool.description ?? "",
        input_schema: (tool.input_parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
        scopes: Array.isArray(tool.scopes) ? tool.scopes.filter((s): s is string => typeof s === "string") : [],
        tags,
        read_only: tags.includes("readOnlyHint"),
        deprecated: Boolean(tool.is_deprecated),
      };
    }).filter((tool) => tool.slug.length > 0 && !tool.deprecated);
  }
}
