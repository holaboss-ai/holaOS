/**
 * Renderer-side @holaboss/app-sdk client backed by the bff:fetch IPC bridge.
 *
 * Architectural rationale: Chromium 138+ blocks third-party cookies on
 * cross-site fetch even with `SameSite=None; Secure`. Our renderer (origin
 * localhost:5173 in dev, file:// when packaged) is third-party to the BFF,
 * so direct fetch + `credentials: include` silently drops the auth cookie.
 *
 * The bff:fetch bridge (see `bff-fetch-bridge.ts` + `electron/bff-fetch.ts`)
 * routes requests through the main process, which uses Node fetch and
 * injects the Better-Auth cookie. The renderer never touches the cookie
 * string; it only sees a fetch-shaped Promise<Response>.
 *
 * Base URLs are still pulled once from main via IPC (auth:getApiBaseUrl /
 * auth:getMarketplaceBaseUrl) because they vary per environment.
 */
import type {
  RequestConfig,
  ResponseConfig,
  ResponseErrorConfig,
} from "@holaboss/app-sdk/core";

import { bffFetch } from "./bff-fetch-bridge";

let cachedApiBaseUrl: string | null = null;
let cachedMarketplaceBaseUrl: string | null = null;
let bootstrapPromise: Promise<void> | null = null;

async function bootstrapBaseUrls(): Promise<void> {
  if (cachedApiBaseUrl !== null && cachedMarketplaceBaseUrl !== null) {
    return;
  }
  if (!bootstrapPromise) {
    bootstrapPromise = (async () => {
      const [apiBaseUrl, marketplaceBaseUrl] = await Promise.all([
        window.electronAPI.auth.getApiBaseUrl(),
        window.electronAPI.auth.getMarketplaceBaseUrl(),
      ]);
      cachedApiBaseUrl = apiBaseUrl ?? "";
      cachedMarketplaceBaseUrl = marketplaceBaseUrl ?? "";
    })();
  }
  await bootstrapPromise;
}

/**
 * Force the next request to refetch base URLs from main. Called on auth
 * lifecycle events from `installRendererAuthCacheListeners`.
 */
export function invalidateAppSdkAuthCache(): void {
  cachedApiBaseUrl = null;
  cachedMarketplaceBaseUrl = null;
  bootstrapPromise = null;
}

/**
 * Wire the cache to Better-Auth lifecycle events so a fresh sign-in or
 * sign-out propagates without a renderer reload. Returns an unsubscribe.
 */
export function installRendererAuthCacheListeners(): () => void {
  const unsubAuthenticated = window.electronAPI.auth.onAuthenticated(() => {
    invalidateAppSdkAuthCache();
  });
  const unsubUserUpdated = window.electronAPI.auth.onUserUpdated(() => {
    invalidateAppSdkAuthCache();
  });
  return () => {
    unsubAuthenticated();
    unsubUserUpdated();
  };
}

// ---------------------------------------------------------------------------
// Internal: a thin re-implementation of @holaboss/app-sdk's `createAppClient`
// that uses bffFetch instead of globalThis.fetch. We can't override fetch in
// the upstream SDK (it reaches for the global directly), so we provide a
// drop-in client function with the same RequestConfig/ResponseConfig shape.
// ---------------------------------------------------------------------------

type QueryParamValue =
  | boolean
  | null
  | number
  | string
  | undefined
  | Array<boolean | null | number | string | undefined>;

function appendQueryParam(
  searchParams: URLSearchParams,
  key: string,
  value: Exclude<QueryParamValue, QueryParamValue[]>,
) {
  if (value == null) {
    return;
  }
  searchParams.append(key, String(value));
}

function buildBffRequestUrl({
  baseURL,
  url,
  params,
}: Pick<RequestConfig, "baseURL" | "params" | "url">): URL {
  if (!url) {
    throw new Error("Request URL is required.");
  }
  const hasAbsoluteUrl = /^https?:\/\//u.test(url);
  if (!(baseURL || hasAbsoluteUrl)) {
    throw new Error(`Relative URL "${url}" requires a baseURL.`);
  }
  // Preserve any path on the baseURL (e.g. `/api/marketplace`).
  const trimmedBase = (baseURL ?? "").replace(/\/+$/u, "");
  const normalizedPath = url.startsWith("/") ? url : `/${url}`;
  const resolved = hasAbsoluteUrl
    ? new URL(url)
    : new URL(`${trimmedBase}${normalizedPath}`);

  for (const [key, raw] of Object.entries(params ?? {})) {
    if (Array.isArray(raw)) {
      for (const value of raw) {
        appendQueryParam(resolved.searchParams, key, value);
      }
      continue;
    }
    appendQueryParam(resolved.searchParams, key, raw);
  }
  return resolved;
}

async function bffAppSdkRequest<TData, TError = unknown, TVariables = unknown>(
  baseURL: string,
  config: RequestConfig<TVariables>,
): Promise<ResponseConfig<TData>> {
  const requestUrl = buildBffRequestUrl({ ...config, baseURL });

  const headers = new Headers();
  headers.set("Accept", "application/json");
  if (config.headers) {
    for (const [key, value] of new Headers(
      config.headers as HeadersInit,
    ).entries()) {
      headers.set(key, value);
    }
  }

  let body: string | undefined;
  if (config.data !== undefined && config.method !== "GET") {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    body = JSON.stringify(config.data);
  }

  const response = await bffFetch(requestUrl.toString(), {
    method: config.method,
    headers,
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    let errData: unknown = errText;
    if (errText) {
      try {
        errData = JSON.parse(errText);
      } catch {
        // leave as text
      }
    }
    const error = new Error(
      `Request failed with status ${response.status} ${response.statusText}`,
    ) as ResponseErrorConfig<TError>;
    error.status = response.status;
    error.statusText = response.statusText;
    error.headers = response.headers;
    error.data = errData as TError;
    throw error;
  }

  if (response.status === 204) {
    return {
      data: undefined as TData,
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    };
  }

  const text = await response.text();
  const data = (text ? JSON.parse(text) : undefined) as TData;
  return {
    data,
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  };
}

let marketplaceClientCache:
  | (<TData, TError = unknown, TVariables = unknown>(
      config: RequestConfig<TVariables>,
    ) => Promise<ResponseConfig<TData>>)
  | null = null;

/**
 * Renderer-side @holaboss/app-sdk client targeting the marketplace BFF.
 * All requests go through `bffFetch` — main injects the auth cookie.
 */
export function getMarketplaceAppSdkClient() {
  if (marketplaceClientCache) {
    return marketplaceClientCache;
  }

  marketplaceClientCache = async <TData, TError = unknown, TVariables = unknown>(
    config: RequestConfig<TVariables>,
  ): Promise<ResponseConfig<TData>> => {
    await bootstrapBaseUrls();
    const baseURL = cachedMarketplaceBaseUrl ?? "";
    if (!baseURL) {
      throw new Error(
        "Marketplace BFF base URL is not configured — main process did not return one.",
      );
    }

    try {
      return await bffAppSdkRequest<TData, TError, TVariables>(baseURL, config);
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? (error as { status?: number }).status
          : undefined;
      if (status === 401 || status === 403) {
        invalidateAppSdkAuthCache();
        const wrapped = new Error(
          `Marketplace BFF returned ${status}: Better-Auth session missing or expired (sign in to desktop first). Method=${config.method} URL=${config.url}`,
        ) as Error & {
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

  return marketplaceClientCache;
}

/**
 * Issue a Better-Auth oRPC POST against the Hono API root. Used by billing
 * helpers (`/rpc/quota/myQuota`, `/rpc/billing/myBillingInfo`,
 * `/rpc/quota/myTransactions`) — same renderer-direct cookie path via
 * bffFetch as marketplace.
 */
interface BillingRpcEnvelope<T> {
  json: T;
  meta?: unknown;
}

export async function billingRpcFetch<T>(
  path: string,
  input?: unknown,
): Promise<T> {
  await bootstrapBaseUrls();
  const baseURL = cachedApiBaseUrl ?? "";
  if (!baseURL) {
    throw new Error(
      "Remote billing is not configured. Set HOLABOSS_AUTH_BASE_URL outside the public repo.",
    );
  }

  const response = await bffFetch(`${baseURL}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input === undefined ? {} : { json: input }),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      invalidateAppSdkAuthCache();
      throw new Error("Not authenticated — sign in first.");
    }
    const detail = await response.text();
    throw new Error(
      detail || `Desktop billing request failed with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as BillingRpcEnvelope<T> | null;
  if (!payload || !("json" in payload)) {
    throw new Error("Desktop billing received a malformed RPC response.");
  }
  return payload.json;
}
