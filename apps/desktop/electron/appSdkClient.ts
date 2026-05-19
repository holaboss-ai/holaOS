import {
  createAppClient,
  type RequestConfig,
  type ResponseConfig,
} from "@holaboss/app-sdk/core";

/**
 * Main-process client factory for @holaboss/app-sdk. Built once and reused for
 * every call. The Cookie header is read fresh per request from the supplied
 * `getCookie` callback so rotated Better-Auth sessions work without a restart.
 * Mirrors the billingFetch pattern already used for the Better-Auth RPC.
 *
 * When `getCookie` returns an empty string the call still proceeds — some
 * marketplace endpoints are public (e.g. listing templates) and must work
 * before the user signs in. The server decides whether auth is required.
 */
export function buildAppSdkClient(options: {
  baseURL: string;
  getCookie: () => string;
  onUnauthorized?: () => void;
}) {
  const base = createAppClient({
    baseURL: options.baseURL,
    headers: undefined,
  });

  return async <TData, TError = unknown, TVariables = unknown>(
    config: RequestConfig<TVariables>
  ): Promise<ResponseConfig<TData>> => {
    const headers = new Headers();
    headers.set("Accept", "application/json");
    // Do NOT set credentials: "include" — we carry the cookie explicitly and
    // `credentials: include` would trigger Electron's fetch CORS preflight.
    const cookie = options.getCookie();
    if (cookie) {
      headers.set("Cookie", cookie);
    }
    for (const [key, value] of new Headers(
      (config.headers as HeadersInit | undefined) ?? undefined
    ).entries()) {
      headers.set(key, value);
    }

    try {
      return await base<TData, TError, TVariables>({
        ...config,
        headers,
      });
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? (error as { status?: number }).status
          : undefined;
      if (status === 401 || status === 403) {
        options.onUnauthorized?.();
        // Re-throw with a diagnostic message so the caller can tell whether
        // the request was even carrying a cookie. This is the single biggest
        // source of "why am I 401" confusion on the desktop BFF path.
        const hadCookie = cookie.length > 0;
        const diagnostic = hadCookie
          ? `sent Cookie header (${cookie.length} bytes) but server rejected it`
          : "no Cookie header — Better-Auth session missing or expired. Sign in to desktop first.";
        // The SDK base client attaches the parsed response body to `.data`
        // on the error. Surface that so we can see Hono's actual reason.
        let bodyDump = "";
        const errData = (error as { data?: unknown }).data;
        if (errData !== undefined) {
          try {
            bodyDump = ` body=${JSON.stringify(errData)}`;
          } catch {
            bodyDump = ` body=<unserializable>`;
          }
        }
        // Cookie name hint — shows what names are in the cookie header so we
        // can tell whether Better-Auth's expected cookie (e.g. `better-auth.session_token`)
        // is present at all.
        const cookieNames = hadCookie
          ? cookie
              .split(/;\s*/)
              .map((kv) => kv.split("=")[0])
              .filter(Boolean)
              .join(",")
          : "";
        const cookieHint = cookieNames ? ` cookieNames=[${cookieNames}]` : "";
        const message = `Marketplace BFF returned ${status}: ${diagnostic}. Method=${config.method} URL=${config.url}${cookieHint}${bodyDump}`;
        const wrapped = new Error(message) as Error & {
          status?: number;
          originalError?: unknown;
        };
        wrapped.status = status;
        wrapped.originalError = error;
        throw wrapped;
      }
      throw error;
    }
  };
}
