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

export class ComposioService {
  private readonly honoBaseUrl: string;
  private readonly authCookie: string;
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
}
