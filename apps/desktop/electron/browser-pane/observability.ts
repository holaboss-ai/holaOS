/**
 * Browser-pane observability — types + pure formatting helpers (BP-OB).
 *
 * Each tab captures console entries, page/runtime/network errors, and a
 * bounded ring buffer of network request records. This module owns the
 * **types and pure transforms** for those streams: header parsing, body
 * metadata extraction, level coercion, summary shaping. Nothing here
 * touches Electron, the workspace map, or any tab record state — it's
 * the `lodash`-like layer of the subsystem so the wire/HTTP route layer
 * and the listener layer can share consistent shapes.
 *
 * Stateful helpers (per-tab append/upsert, the WebContents-id reverse
 * lookup) live alongside tab-state.
 */

export type BrowserConsoleLevel = "debug" | "info" | "warning" | "error";
export type BrowserErrorSource = "page" | "runtime" | "network";

export interface BrowserConsoleEntry {
  id: string;
  level: BrowserConsoleLevel;
  message: string;
  sourceId: string;
  lineNumber: number | null;
  timestamp: string;
  frameUrl: string;
}

export interface BrowserObservedError {
  id: string;
  source: BrowserErrorSource;
  kind: string;
  level: "warning" | "error";
  message: string;
  timestamp: string;
  url: string;
  requestId?: string;
  statusCode?: number;
  resourceType?: string;
  lineNumber?: number;
  sourceId?: string;
  errorCode?: number;
}

export interface BrowserRequestBodyMetadata {
  entryCount: number;
  byteLength: number;
  fileCount: number;
  types: string[];
}

export interface BrowserResponseBodyMetadata {
  contentType: string | null;
  contentLength: number | null;
}

export interface BrowserRequestRecord {
  id: string;
  url: string;
  method: string;
  resourceType: string;
  referrer: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  fromCache: boolean;
  statusCode: number | null;
  statusLine: string;
  error: string;
  requestHeaders: Record<string, string[]> | null;
  responseHeaders: Record<string, string[]> | null;
  requestBody: BrowserRequestBodyMetadata | null;
  responseBody: BrowserResponseBodyMetadata | null;
}

/** Hard cap on per-tab console / error entries kept in memory. */
export const BROWSER_OBSERVABILITY_ENTRY_LIMIT = 100;

/** Hard cap on per-tab in-flight + completed network request records. */
export const BROWSER_REQUEST_HISTORY_LIMIT = 200;

/** Default `?limit=` for /api/v1/browser/{console,errors,requests} routes. */
export const BROWSER_OBSERVABILITY_DEFAULT_LIMIT = 20;

/**
 * Parse a `?limit=` query value into a bounded number. Negative / non-finite
 * values return the default; values above the per-tab cap are clamped down.
 */
export function browserObservabilityLimit(
  value: string | null | undefined,
  defaultValue = BROWSER_OBSERVABILITY_DEFAULT_LIMIT,
): number {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.max(
    1,
    Math.min(BROWSER_OBSERVABILITY_ENTRY_LIMIT, Math.floor(parsed)),
  );
}

export function browserConsoleLevelValue(value: unknown): BrowserConsoleLevel {
  return value === "warning" ||
    value === "error" ||
    value === "debug" ||
    value === "info"
    ? value
    : "info";
}

export function browserConsoleLevelRank(level: BrowserConsoleLevel): number {
  switch (level) {
    case "debug":
      return 0;
    case "info":
      return 1;
    case "warning":
      return 2;
    case "error":
      return 3;
  }
}

export function browserObservedErrorSource(
  value: unknown,
): BrowserErrorSource | null {
  return value === "page" || value === "runtime" || value === "network"
    ? value
    : null;
}

/**
 * Convert Chromium's network event timestamps (seconds since epoch as a
 * float) to an ISO string. Falls back to `Date.now()` for non-numeric or
 * non-positive inputs so downstream consumers always have a usable value.
 */
export function browserIsoFromNetworkTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Normalize a heterogeneous Electron headers object (values can be string
 * or string[]) into a stable `Record<name, string[]>`. Returns `null` if
 * the input has no usable string values, so callers can short-circuit.
 */
export function browserHeaderRecord(
  value: unknown,
): Record<string, string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, string[]> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rawValue === "string") {
      result[key] = [rawValue];
      continue;
    }
    if (Array.isArray(rawValue)) {
      const entries = rawValue
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry);
      if (entries.length > 0) {
        result[key] = entries;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** Case-insensitive header lookup; returns the first non-empty trimmed value. */
export function browserHeaderFirstValue(
  headers: Record<string, string[]> | null | undefined,
  headerName: string,
): string | null {
  if (!headers) {
    return null;
  }
  const normalizedName = headerName.toLowerCase();
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalizedName || values.length === 0) {
      continue;
    }
    const value = values[0]?.trim() || "";
    return value || null;
  }
  return null;
}

export function browserResponseBodyMetadata(
  headers: Record<string, string[]> | null,
): BrowserResponseBodyMetadata | null {
  if (!headers) {
    return null;
  }
  const contentType = browserHeaderFirstValue(headers, "content-type");
  const contentLengthRaw = browserHeaderFirstValue(headers, "content-length");
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : null;
  if (!contentType && !Number.isFinite(contentLength ?? NaN)) {
    return null;
  }
  return {
    contentType,
    contentLength:
      typeof contentLength === "number" && Number.isFinite(contentLength)
        ? contentLength
        : null,
  };
}

export function browserRequestBodyMetadata(
  uploadData: unknown,
): BrowserRequestBodyMetadata | null {
  if (!Array.isArray(uploadData) || uploadData.length === 0) {
    return null;
  }
  let byteLength = 0;
  let fileCount = 0;
  const types = new Set<string>();
  for (const entry of uploadData) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.bytes instanceof Uint8Array) {
      byteLength += record.bytes.byteLength;
      types.add("bytes");
    } else if (Buffer.isBuffer(record.bytes)) {
      byteLength += record.bytes.byteLength;
      types.add("bytes");
    } else if (typeof record.file === "string" && record.file.trim()) {
      fileCount += 1;
      types.add("file");
    } else if (typeof record.blobUUID === "string" && record.blobUUID.trim()) {
      types.add("blob");
    } else {
      types.add("other");
    }
  }
  return {
    entryCount: uploadData.length,
    byteLength,
    fileCount,
    types: [...types],
  };
}

/**
 * Push `entry` into `entries` in-place, evicting from the front to keep
 * `entries.length <= limit`. Used by the per-tab console / error ring
 * buffers and the in-flight request order list.
 */
export function appendBoundedEntry<T>(
  entries: T[],
  entry: T,
  limit: number,
): void {
  entries.push(entry);
  if (entries.length > limit) {
    entries.splice(0, entries.length - limit);
  }
}

export function browserRequestIdValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return "";
}

export function browserRequestFailure(record: BrowserRequestRecord): boolean {
  return Boolean(record.error) || (record.statusCode ?? 0) >= 400;
}

export function browserRequestSummary(
  record: BrowserRequestRecord,
): Record<string, unknown> {
  return {
    id: record.id,
    url: record.url,
    method: record.method,
    resourceType: record.resourceType,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
    fromCache: record.fromCache,
    statusCode: record.statusCode,
    statusLine: record.statusLine,
    error: record.error,
  };
}
