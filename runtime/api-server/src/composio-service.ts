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
  /** Raw response body (truncated) when the upstream returned a non-JSON error
   *  (e.g. a gateway 502). Logged for diagnosis; not shown to the agent. */
  responseBody?: string;
  /** Cloudflare Ray ID (`cf-ray` header) to correlate this failure with the
   *  edge's own logs, and the `server` header to see which layer answered. */
  cfRay?: string;
  originServer?: string;
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

/**
 * Better Auth's Electron client returns the cookie header as `; name=value`
 * (leading "; " — meant for splicing onto an existing Cookie header). Passed
 * verbatim as a fresh `Cookie:` header, Hono on Cloudflare Workers sees a
 * leading empty cookie pair and the session-auth middleware crashes → the
 * Worker bubbles a generic 500 instead of a clean 401. Strip leading whitespace
 * and semicolons so the header starts with a real `name=value` pair.
 */
function normalizeAuthCookie(raw: string): string {
  return (raw ?? "").replace(/^[\s;]+/, "").trim();
}

export class ComposioService {
  readonly honoBaseUrl: string;
  private currentAuthCookie: string;
  private readonly fetchImpl: typeof fetch;

  /**
   * Read per request, never captured.
   *
   * The session cookie ROTATES: better-auth reissues it whenever the backend
   * sends a fresh Set-Cookie, which happens silently on get-session and most
   * auth-touching endpoints. The desktop already accounts for that — its
   * authCookieHeader() deliberately stopped caching for exactly this reason —
   * but it hands the runtime a value once, in the spawn environment, so the
   * runtime kept presenting a pre-rotation cookie for as long as it lived.
   *
   * Every call went through `this.authCookie`, captured in the constructor, so
   * there was nowhere to put a newer one even if we had it. Reading through a
   * getter is what makes `setAuthCookie` possible at all.
   */
  get authCookie(): string {
    return this.currentAuthCookie;
  }

  /** Adopt a rotated session cookie. Ignores empty values: an empty cookie is
   *  "we don't know yet", not "sign the runtime out". */
  setAuthCookie(next: string): void {
    const normalized = normalizeAuthCookie(next);
    if (!normalized || normalized === this.currentAuthCookie) {
      return;
    }
    this.currentAuthCookie = normalized;
  }

  constructor(config: ComposioServiceConfig) {
    this.honoBaseUrl = config.honoBaseUrl.replace(/\/+$/, "");
    // Better Auth's Electron client returns the cookie header as `; name=value`
    // (leading "; " — used to splice onto an existing Cookie header). When we
    // pass this verbatim as a fresh `Cookie:` header, Hono on Cloudflare Workers
    // sees a leading empty cookie pair and the session-auth middleware crashes
    // → the Worker bubbles a generic 500 "Internal Server Error" instead of a
    // clean 401. Strip the leading `; ` (and any other leading whitespace /
    // semicolons) so the header starts with the first real `name=value` pair.
    this.currentAuthCookie = normalizeAuthCookie(config.authCookie);
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

    // Read the body once as text so a non-JSON error (gateway 502, HTML page)
    // isn't discarded by response.json() — we keep a snippet for the failure log.
    const rawBody = await response.text().catch(() => "");
    let payload:
      | {
          ok?: boolean;
          data?: TData | null;
          log_id?: string | null;
          error?: ComposioExecuteError;
        }
      | null = null;
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = null;
      }
    }

    if (!response.ok || payload?.ok === false) {
      // cf-ray identifies the request in Cloudflare's own logs; `server`
      // reveals which edge (cloudflare / the Dokploy proxy) emitted the error.
      const cfRay = response.headers.get("cf-ray") ?? undefined;
      const originServer = response.headers.get("server") ?? undefined;
      const detail: ComposioExecuteError = payload?.error
        ? { ...payload.error, cfRay, originServer }
        : {
            code: "unknown_error",
            message: `HTTP ${response.status}`,
            responseBody: rawBody.trim().slice(0, 300) || undefined,
            cfRay,
            originServer,
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

  /**
   * Semantic search over Composio's FULL catalog (not the preloaded subset),
   * via the Hono /api/composio/tools/search passthrough. Backs the
   * composio_search_tools meta-tool so the agent can reach any tool on demand.
   */
  async searchTools(
    query: string,
    toolkitSlug: string | undefined,
    limit = 20,
  ): Promise<ComposioSearchResult[]> {
    const url = new URL(`${this.honoBaseUrl}/api/composio/tools/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    if (toolkitSlug) {
      url.searchParams.set("toolkit_slug", toolkitSlug);
    }
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Cookie: this.authCookie,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Composio searchTools via Hono failed: ${response.status} ${text.slice(0, 300)}`,
      );
    }
    const payload = (await response.json()) as {
      tools?: Array<{
        slug?: string;
        name?: string;
        description?: string;
        toolkit_slug?: string;
        input_parameters?: Record<string, unknown>;
      }>;
    };
    return (payload.tools ?? [])
      .map((tool) => ({
        slug: tool.slug ?? "",
        name: tool.name ?? tool.slug ?? "",
        description: tool.description ?? "",
        toolkit_slug: tool.toolkit_slug ?? toolkitSlug ?? "",
        input_schema: (tool.input_parameters ?? {
          type: "object",
          properties: {},
        }) as Record<string, unknown>,
      }))
      .filter((tool) => tool.slug.length > 0);
  }
}

export interface ComposioSearchResult {
  slug: string;
  name: string;
  description: string;
  toolkit_slug: string;
  input_schema: Record<string, unknown>;
}
