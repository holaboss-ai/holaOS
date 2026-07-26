export type HeaderValue = null | string | undefined;

export type RequestHeaders =
  | Headers
  | Record<string, HeaderValue>
  | [string, HeaderValue][];

export type QueryParamValue =
  | boolean
  | null
  | number
  | string
  | undefined
  | Array<boolean | null | number | string | undefined>;

export type RequestConfig<TData = unknown> = {
  baseURL?: string;
  credentials?: RequestCredentials;
  data?: TData;
  headers?: RequestHeaders;
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  params?: Record<string, QueryParamValue>;
  responseType?: "arraybuffer" | "blob" | "json" | "text";
  signal?: AbortSignal;
  url?: string;
};

export type ResponseConfig<TData = unknown> = {
  data: TData;
  headers: Headers;
  status: number;
  statusText: string;
};

export type ResponseErrorConfig<TError = unknown> = Error & {
  data?: TError;
  headers?: Headers;
  status: number;
  statusText: string;
};

export class UpstreamInvalidResponseError extends Error {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly bodySnippet: string;

  constructor(params: {
    url: string;
    status: number;
    contentType: string;
    bodySnippet: string;
  }) {
    const snippet = params.bodySnippet.slice(0, 200);
    super(
      `Upstream returned ${params.status} with non-JSON body ` +
        `(content-type="${params.contentType || "<none>"}", length=${params.bodySnippet.length}) ` +
        `from ${params.url}. This usually means the request hit a catchall handler or a ` +
        `misrouted reverse proxy. Body: ${JSON.stringify(snippet)}`
    );
    this.name = "UpstreamInvalidResponseError";
    this.url = params.url;
    this.status = params.status;
    this.contentType = params.contentType;
    this.bodySnippet = snippet;
  }
}

function toHeaders(headers?: RequestHeaders): Headers {
  const normalized = new Headers();

  if (!headers) {
    return normalized;
  }

  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) {
      normalized.set(key, value);
    }
    return normalized;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (value != null) {
        normalized.set(key, value);
      }
    }
    return normalized;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value != null) {
      normalized.set(key, value);
    }
  }

  return normalized;
}

function appendQueryParam(
  searchParams: URLSearchParams,
  key: string,
  value: Exclude<QueryParamValue, QueryParamValue[]>
) {
  if (value == null) {
    return;
  }

  searchParams.append(key, String(value));
}

export function buildUrl({
  baseURL,
  params,
  url,
}: Pick<RequestConfig, "baseURL" | "params" | "url">): URL {
  if (!url) {
    throw new Error("Request URL is required.");
  }

  const hasAbsoluteUrl = /^https?:\/\//u.test(url);
  if (!(baseURL || hasAbsoluteUrl)) {
    throw new Error(`Relative URL "${url}" requires a baseURL.`);
  }

  // Concatenate baseURL and url manually so any path segment on the baseURL
  // (e.g. `/api/marketplace`) is preserved. `new URL("/templates", base)`
  // would treat the leading slash as path-absolute and discard the
  // baseURL's existing path component.
  let resolved: URL;
  if (hasAbsoluteUrl) {
    resolved = new URL(url);
  } else {
    const trimmedBase = (baseURL ?? "").replace(/\/+$/u, "");
    const normalizedPath = url.startsWith("/") ? url : `/${url}`;
    resolved = new URL(`${trimmedBase}${normalizedPath}`);
  }

  for (const [key, rawValue] of Object.entries(params ?? {})) {
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) {
        appendQueryParam(resolved.searchParams, key, value);
      }
      continue;
    }

    appendQueryParam(resolved.searchParams, key, rawValue);
  }

  return resolved;
}

function isJsonBody(
  value: unknown
): value is Record<string, unknown> | unknown[] {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof Blob) &&
    !(value instanceof FormData) &&
    !(value instanceof URLSearchParams)
  );
}

async function parseSuccessBody<TData>(
  response: Response,
  responseType: RequestConfig["responseType"] | undefined,
  requestUrl: string
): Promise<TData> {
  if (response.status === 204) {
    return undefined as TData;
  }

  if (responseType === "arraybuffer") {
    return (await response.arrayBuffer()) as TData;
  }

  if (responseType === "blob") {
    return (await response.blob()) as TData;
  }

  if (responseType === "text") {
    return (await response.text()) as TData;
  }

  // Default path: caller expects JSON. Treat anything else (empty body, text,
  // HTML from a reverse-proxy catchall, etc.) as a hard failure so routing
  // mistakes surface with a clear error instead of bleeding into downstream
  // Zod "expected object, received string" errors.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const snippet = await response.text();
    throw new UpstreamInvalidResponseError({
      url: requestUrl,
      status: response.status,
      contentType,
      bodySnippet: snippet,
    });
  }

  const raw = await response.text();
  if (raw.length === 0) {
    throw new UpstreamInvalidResponseError({
      url: requestUrl,
      status: response.status,
      contentType,
      bodySnippet: "",
    });
  }

  try {
    return JSON.parse(raw) as TData;
  } catch (_parseError) {
    throw new UpstreamInvalidResponseError({
      url: requestUrl,
      status: response.status,
      contentType,
      bodySnippet: raw,
    });
  }
}

async function parseErrorBody(response: Response): Promise<unknown> {
  // Best-effort on error paths: try JSON when advertised, otherwise text,
  // and never throw — we always want the caller to see the HTTP failure.
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const raw = await response.text();
      return raw.length === 0 ? undefined : JSON.parse(raw);
    }
    return await response.text();
  } catch {
    return;
  }
}

async function baseClient<TData, TError = unknown, TVariables = unknown>(
  config: RequestConfig<TVariables>
): Promise<ResponseConfig<TData>> {
  const requestUrl = buildUrl(config);
  const headers = toHeaders(config.headers);

  const init: RequestInit = {
    credentials: config.credentials,
    headers,
    method: config.method,
    signal: config.signal,
  };

  if (config.data !== undefined && config.method !== "GET") {
    if (isJsonBody(config.data)) {
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      init.body = JSON.stringify(config.data);
    } else {
      init.body = config.data as BodyInit;
    }
  }

  const response = await fetch(requestUrl, init);

  if (!response.ok) {
    const errorData = await parseErrorBody(response);
    const error = new Error(
      `Request failed with status ${response.status} ${response.statusText}`
    ) as ResponseErrorConfig<TError>;
    error.status = response.status;
    error.statusText = response.statusText;
    error.headers = response.headers;
    error.data = errorData as TError;
    throw error;
  }

  const data = await parseSuccessBody<TData>(
    response,
    config.responseType,
    requestUrl.toString()
  );

  return {
    data,
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  };
}

export function createClient(
  defaults: Pick<RequestConfig, "baseURL" | "credentials" | "headers">
) {
  return <TData, TError = unknown, TVariables = unknown>(
    config: RequestConfig<TVariables>
  ) => {
    const headers = toHeaders(defaults.headers);
    for (const [key, value] of toHeaders(config.headers).entries()) {
      headers.set(key, value);
    }

    return baseClient<TData, TError, TVariables>({
      ...config,
      baseURL: config.baseURL ?? defaults.baseURL,
      credentials: config.credentials ?? defaults.credentials,
      headers,
    });
  };
}

export default baseClient;
