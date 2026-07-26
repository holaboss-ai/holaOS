// LLM provider HTTP errors get normalized to a one-line `errorMessage` by
// the underlying SDK (e.g. OpenAI APIError → `"400 Provider returned
// error"`). The actual upstream body — which holds the real cause when
// the call goes through an OpenRouter-style proxy (the proxy reports
// `{error: {message: "Provider returned error", metadata: {raw_provider_error:
// ...}}}`) — gets dropped before we ever see it.
//
// This module wraps `globalThis.fetch` so that 4xx/5xx responses from LLM
// endpoints have their body teed into a tiny in-process ring buffer. The
// pi event mapper reads from the buffer when emitting `run_failed` and
// attaches the raw body so the desktop UI can surface the real reason.
//
// Harness-host runs as a short-lived subprocess per agent run, so the
// ring buffer is naturally scoped to a single run and there is no
// cross-run contamination to worry about.

const RING_BUFFER_SIZE = 8;
const MAX_BODY_BYTES = 64 * 1024;

const LLM_ENDPOINT_PATTERNS: RegExp[] = [
  /\/responses(\?|$)/,
  /\/chat\/completions(\?|$)/,
  /\/messages(\?|$)/,
  /\/model-proxy\//,
  /\/v1\/embeddings(\?|$)/,
];

export type CapturedUpstreamError = {
  captured_at_ms: number;
  url: string;
  method: string;
  status: number;
  status_text: string;
  content_type: string | null;
  body: string;
  body_truncated: boolean;
  parsed_body: unknown;
  duration_ms: number;
};

const captures: CapturedUpstreamError[] = [];
let installed = false;

function isLlmEndpoint(url: string): boolean {
  return LLM_ENDPOINT_PATTERNS.some((p) => p.test(url));
}

function pushCapture(entry: CapturedUpstreamError): void {
  captures.push(entry);
  if (captures.length > RING_BUFFER_SIZE) {
    captures.splice(0, captures.length - RING_BUFFER_SIZE);
  }
}

export function installUpstreamErrorCapture(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method =
      (init?.method ??
        (typeof input === "string" || input instanceof URL ? "GET" : input.method)) ||
      "GET";
    const startedAt = performance.now();
    const response = await original(input as Parameters<typeof original>[0], init);
    if (response.status >= 400 && isLlmEndpoint(url)) {
      // Await so the capture lands in the ring buffer *before* the SDK's
      // error propagates up to the event mapper. Errors are rare and the
      // body read happens off a cloned stream, so this neither blocks
      // success paths nor consumes the SDK's body.
      await captureBody(response.clone(), url, method, startedAt);
    }
    return response;
  };
}

async function captureBody(
  cloned: Response,
  url: string,
  method: string,
  startedAt: number,
): Promise<void> {
  try {
    const contentType = cloned.headers.get("content-type");
    const raw = await cloned.text();
    const truncated = raw.length > MAX_BODY_BYTES;
    const body = truncated ? raw.slice(0, MAX_BODY_BYTES) : raw;
    let parsedBody: unknown = null;
    if (contentType && contentType.toLowerCase().includes("json")) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        // Body claimed JSON but wasn't — keep raw text only.
      }
    }
    pushCapture({
      captured_at_ms: Date.now(),
      url,
      method,
      status: cloned.status,
      status_text: cloned.statusText,
      content_type: contentType,
      body,
      body_truncated: truncated,
      parsed_body: parsedBody,
      duration_ms: performance.now() - startedAt,
    });
  } catch {
    // Capturing must never break the call. Drop silently.
  }
}

export function peekLatestUpstreamError(
  opts?: { withinMs?: number },
): CapturedUpstreamError | null {
  const withinMs = opts?.withinMs;
  if (withinMs === undefined) {
    return captures.at(-1) ?? null;
  }
  const cutoff = Date.now() - withinMs;
  for (let i = captures.length - 1; i >= 0; i -= 1) {
    const entry = captures[i];
    if (entry && entry.captured_at_ms >= cutoff) {
      return entry;
    }
  }
  return null;
}

export function clearUpstreamErrorCaptures(): void {
  captures.length = 0;
}

// Test-only: drops the "already installed" guard so each test can wrap a
// fresh `globalThis.fetch` stub. Production code never needs this — the
// harness-host process exits after every agent run, so the guard is
// scoped to a single run.
export function __resetUpstreamErrorCaptureForTests(): void {
  installed = false;
  captures.length = 0;
}

// Walks the parsed body for the deepest non-empty string under common
// error keys, so callers can promote "400 Provider returned error" into
// something like "400 Provider returned error: <real upstream reason>".
//
// Key order matters: container-shaped keys (`metadata`, `raw`, `error`,
// ...) come before terminal string-shaped keys (`message`, `detail`,
// ...). Without this, OpenRouter-style bodies — `{error: {message:
// "Provider returned error", metadata: {raw: "<escaped json with the
// real error>"}}}` — collapse to the outer "Provider returned error"
// instead of the underlying cause.
//
// String values that look like JSON are parsed and re-walked. OpenRouter
// stuffs the upstream OpenAI body into `metadata.raw` as an escaped JSON
// string, so without the parse step the walker would stop one layer
// short of the real `tools[N].parameters: invalid_function_parameters`
// message.
const PROVIDER_ERROR_KEYS = [
  "raw_provider_error",
  "raw",
  "previous_errors",
  "metadata",
  "cause",
  "body",
  "error",
  "errors",
  "details",
  "detail",
  "error_message",
  "message",
] as const;

function tryParseJsonObject(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function extractDeepProviderMessage(value: unknown, depth = 0): string | null {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = tryParseJsonObject(trimmed);
    if (parsed !== null) {
      const nested = extractDeepProviderMessage(parsed, depth + 1);
      if (nested) return nested;
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractDeepProviderMessage(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of PROVIDER_ERROR_KEYS) {
    if (key in record) {
      const nested = extractDeepProviderMessage(record[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}
