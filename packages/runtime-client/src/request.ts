// Ported verbatim from holaOS/desktop/electron/main.ts (lines 13823-13978).
// Two intentional changes from the original:
//   1. Transport: node:http -> fetch. Electron renderer + Node 24 + Bun all
//      support fetch + AbortSignal natively, so the SDK works in every host.
//   2. Base URL: callback (`getBaseURL`) instead of an inline call to
//      `ensureRuntimeReady()`, which was Electron-main-process-bound.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type RuntimeRequestMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export type RuntimeRequestParams = Record<
  string,
  string | number | boolean | null | undefined
>;

export type RuntimeRequest = {
  method: RuntimeRequestMethod;
  path: string;
  payload?: unknown;
  params?: RuntimeRequestParams;
  timeoutMs?: number;
  /**
   * Enables retry on transient errors for non-GET methods. GET methods retry
   * by default. Use this for idempotent operations that aren't GET (e.g. PATCH
   * with the same body produces the same outcome).
   */
  retryTransientErrors?: boolean;
  signal?: AbortSignal;
};

export type CreateRuntimeRequestOptions = {
  /**
   * Async resolver for the runtime base URL. Called once per attempt — if the
   * runtime restarts mid-flight, the next retry will pick up the new URL.
   */
  getBaseURL: () => Promise<string>;
  /**
   * Default per-request timeout (ms). Defaults to 15000.
   */
  defaultTimeoutMs?: number;
  /**
   * Override fetch implementation (tests).
   */
  fetch?: typeof fetch;
};

export function isTransientRuntimeError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("embedded runtime is not ready") ||
    message.includes("fetch failed") ||
    message.includes("bad port") ||
    message.includes("invalid url") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("network request failed") ||
    message.includes("aborted")
  );
}

export function runtimeErrorFromBody(
  statusCode: number,
  statusMessage: string | undefined,
  body: string
): Error {
  const trimmed = body.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as {
        detail?: unknown;
        message?: unknown;
        error?: unknown;
      };
      const detail =
        typeof parsed.detail === "string"
          ? parsed.detail
          : typeof parsed.message === "string"
            ? parsed.message
            : typeof parsed.error === "string"
              ? parsed.error
              : "";
      if (detail) {
        const error = new Error(detail) as Error & {
          status?: number;
          body?: string;
        };
        error.status = statusCode;
        return error;
      }
    } catch {
      const error = new Error(trimmed) as Error & {
        status?: number;
      };
      error.status = statusCode;
      return error;
    }
  }
  const fallback = new Error(
    `${statusCode} ${statusMessage ?? "Runtime request failed."}`.trim()
  ) as Error & { status?: number };
  fallback.status = statusCode;
  return fallback;
}

function buildUrl(
  baseURL: string,
  path: string,
  params: RuntimeRequestParams | undefined
): URL {
  const trimmedBase = baseURL.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${trimmedBase}${normalizedPath}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function requestOnce<T>(
  fetchFn: typeof fetch,
  url: URL,
  method: RuntimeRequestMethod,
  payload: unknown,
  timeoutMs: number,
  externalSignal: AbortSignal | undefined
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("Runtime request timed out."));
  }, timeoutMs);

  // Compose with caller's signal if present.
  const cleanup: Array<() => void> = [() => clearTimeout(timer)];
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      const onAbort = () => controller.abort(externalSignal.reason);
      externalSignal.addEventListener("abort", onAbort, { once: true });
      cleanup.push(() =>
        externalSignal.removeEventListener("abort", onAbort)
      );
    }
  }

  const init: RequestInit = {
    method,
    signal: controller.signal,
  };

  if (payload !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(payload);
  }

  let response: Response;
  try {
    response = await fetchFn(url, init);
  } finally {
    for (const fn of cleanup) {
      fn();
    }
  }

  if (!response.ok) {
    const body = await response.text();
    throw runtimeErrorFromBody(response.status, response.statusText, body);
  }

  if (response.status === 204) {
    return null as T;
  }

  const body = await response.text();
  if (!body.trim()) {
    return null as T;
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error("Runtime returned invalid JSON.");
  }
}

export type RequestFn = <T>(req: RuntimeRequest) => Promise<T>;

export function createRequestFn(options: CreateRuntimeRequestOptions): RequestFn {
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const defaultTimeout = options.defaultTimeoutMs ?? 15000;

  return async function request<T>(req: RuntimeRequest): Promise<T> {
    const attempts = req.method === "GET" || req.retryTransientErrors ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const baseURL = await options.getBaseURL();
        const url = buildUrl(baseURL, req.path, req.params);
        return await requestOnce<T>(
          fetchFn,
          url,
          req.method,
          req.payload,
          req.timeoutMs ?? defaultTimeout,
          req.signal
        );
      } catch (error) {
        lastError = error;
        if (attempt < attempts && isTransientRuntimeError(error)) {
          await sleep(250 * attempt);
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Runtime request failed after retries.");
  };
}
