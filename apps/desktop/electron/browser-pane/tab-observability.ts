/**
 * Per-tab observability state mutation (BP-OB-2).
 *
 * Wraps the four Electron `webRequest`/`console` listener callbacks that
 * record into a tab's `consoleEntries` / `errorEntries` / `requests`
 * Map. Pure formatting/types live in `observability.ts`; this layer is
 * the stateful append/upsert side, plus the WebContents-id reverse
 * lookup needed to find the right tab.
 *
 * Returned by `createTabObservability(deps)`. `deps.eachTabRecord` is
 * the only state coupling — it iterates the workspace map so
 * `webContents.id → tab` resolution can stay in main.ts.
 */
import {
  BROWSER_OBSERVABILITY_ENTRY_LIMIT,
  BROWSER_REQUEST_HISTORY_LIMIT,
  appendBoundedEntry,
  browserHeaderRecord,
  browserIsoFromNetworkTimestamp,
  browserRequestBodyMetadata,
  browserRequestIdValue,
  browserResponseBodyMetadata,
  type BrowserObservedError,
  type BrowserRequestRecord,
} from "./observability.js";

/** Subset of the full BrowserTabRecord this module needs. */
export interface ObservabilityTabRecord {
  view: { webContents: { id: number } };
  errorEntries: BrowserObservedError[];
  requests: Map<string, BrowserRequestRecord>;
  requestOrder: string[];
}

export interface TabObservabilityDeps {
  /**
   * Iterate every live tab record across all workspaces and spaces. The
   * caller is the source of truth for which workspaces exist; this module
   * only consumes the iterator to find the tab matching a `webContents.id`.
   */
  eachTabRecord: () => Iterable<ObservabilityTabRecord>;
}

export interface TabObservability {
  browserTabForWebContentsId: (
    webContentsId: number,
  ) => ObservabilityTabRecord | null;
  appendBrowserObservedError: (
    tab: ObservabilityTabRecord,
    entry: BrowserObservedError,
  ) => void;
  upsertBrowserRequestRecord: (
    tab: ObservabilityTabRecord,
    requestId: string,
    overrides: Partial<BrowserRequestRecord>,
  ) => BrowserRequestRecord;
  trackBrowserRequestStart: (details: {
    id: unknown;
    webContentsId?: number;
    url?: string;
    method?: string;
    resourceType?: string;
    referrer?: string;
    timestamp?: number;
    uploadData?: unknown;
  }) => void;
  trackBrowserRequestHeaders: (details: {
    id: unknown;
    webContentsId?: number;
    requestHeaders?: unknown;
  }) => void;
  trackBrowserRequestCompletion: (details: {
    id: unknown;
    webContentsId?: number;
    url?: string;
    method?: string;
    resourceType?: string;
    referrer?: string;
    timestamp?: number;
    fromCache?: boolean;
    statusCode?: number;
    statusLine?: string;
    error?: string;
    responseHeaders?: unknown;
  }) => void;
  trackBrowserRequestFailure: (details: {
    id: unknown;
    webContentsId?: number;
    url?: string;
    method?: string;
    resourceType?: string;
    referrer?: string;
    timestamp?: number;
    fromCache?: boolean;
    error?: string;
  }) => void;
}

export function createTabObservability(
  deps: TabObservabilityDeps,
): TabObservability {
  function browserTabForWebContentsId(
    webContentsId: number,
  ): ObservabilityTabRecord | null {
    for (const tab of deps.eachTabRecord()) {
      if (tab.view.webContents.id === webContentsId) {
        return tab;
      }
    }
    return null;
  }

  function appendBrowserObservedError(
    tab: ObservabilityTabRecord,
    entry: BrowserObservedError,
  ): void {
    appendBoundedEntry(
      tab.errorEntries,
      entry,
      BROWSER_OBSERVABILITY_ENTRY_LIMIT,
    );
  }

  function upsertBrowserRequestRecord(
    tab: ObservabilityTabRecord,
    requestId: string,
    overrides: Partial<BrowserRequestRecord>,
  ): BrowserRequestRecord {
    const existing = tab.requests.get(requestId);
    if (existing) {
      const next = { ...existing, ...overrides };
      tab.requests.set(requestId, next);
      return next;
    }
    const next: BrowserRequestRecord = {
      id: requestId,
      url: overrides.url ?? "",
      method: overrides.method ?? "",
      resourceType: overrides.resourceType ?? "other",
      referrer: overrides.referrer ?? "",
      startedAt: overrides.startedAt ?? new Date().toISOString(),
      completedAt: overrides.completedAt ?? null,
      durationMs: overrides.durationMs ?? null,
      fromCache: overrides.fromCache ?? false,
      statusCode: overrides.statusCode ?? null,
      statusLine: overrides.statusLine ?? "",
      error: overrides.error ?? "",
      requestHeaders: overrides.requestHeaders ?? null,
      responseHeaders: overrides.responseHeaders ?? null,
      requestBody: overrides.requestBody ?? null,
      responseBody: overrides.responseBody ?? null,
    };
    tab.requests.set(requestId, next);
    tab.requestOrder.push(requestId);
    if (tab.requestOrder.length > BROWSER_REQUEST_HISTORY_LIMIT) {
      const removedRequestId = tab.requestOrder.shift();
      if (removedRequestId) {
        tab.requests.delete(removedRequestId);
      }
    }
    return next;
  }

  function trackBrowserRequestStart(details: {
    id: unknown;
    webContentsId?: number;
    url?: string;
    method?: string;
    resourceType?: string;
    referrer?: string;
    timestamp?: number;
    uploadData?: unknown;
  }): void {
    if (typeof details.webContentsId !== "number") {
      return;
    }
    const tab = browserTabForWebContentsId(details.webContentsId);
    const requestId = browserRequestIdValue(details.id);
    if (!tab || !requestId) {
      return;
    }
    upsertBrowserRequestRecord(tab, requestId, {
      url: typeof details.url === "string" ? details.url : "",
      method: typeof details.method === "string" ? details.method : "",
      resourceType:
        typeof details.resourceType === "string"
          ? details.resourceType
          : "other",
      referrer: typeof details.referrer === "string" ? details.referrer : "",
      startedAt: browserIsoFromNetworkTimestamp(details.timestamp),
      requestBody: browserRequestBodyMetadata(details.uploadData),
    });
  }

  function trackBrowserRequestHeaders(details: {
    id: unknown;
    webContentsId?: number;
    requestHeaders?: unknown;
  }): void {
    if (typeof details.webContentsId !== "number") {
      return;
    }
    const tab = browserTabForWebContentsId(details.webContentsId);
    const requestId = browserRequestIdValue(details.id);
    if (!tab || !requestId) {
      return;
    }
    upsertBrowserRequestRecord(tab, requestId, {
      requestHeaders: browserHeaderRecord(details.requestHeaders),
    });
  }

  function trackBrowserRequestCompletion(details: {
    id: unknown;
    webContentsId?: number;
    url?: string;
    method?: string;
    resourceType?: string;
    referrer?: string;
    timestamp?: number;
    fromCache?: boolean;
    statusCode?: number;
    statusLine?: string;
    error?: string;
    responseHeaders?: unknown;
  }): void {
    if (typeof details.webContentsId !== "number") {
      return;
    }
    const tab = browserTabForWebContentsId(details.webContentsId);
    const requestId = browserRequestIdValue(details.id);
    if (!tab || !requestId) {
      return;
    }
    const existing = upsertBrowserRequestRecord(tab, requestId, {
      url: typeof details.url === "string" ? details.url : "",
      method: typeof details.method === "string" ? details.method : "",
      resourceType:
        typeof details.resourceType === "string"
          ? details.resourceType
          : "other",
      referrer: typeof details.referrer === "string" ? details.referrer : "",
      completedAt: browserIsoFromNetworkTimestamp(details.timestamp),
      fromCache: details.fromCache === true,
      statusCode:
        typeof details.statusCode === "number" &&
        Number.isFinite(details.statusCode)
          ? details.statusCode
          : null,
      statusLine:
        typeof details.statusLine === "string" ? details.statusLine : "",
      error: typeof details.error === "string" ? details.error : "",
      responseHeaders: browserHeaderRecord(details.responseHeaders),
    });
    if (existing.completedAt) {
      const startedAtMs = Date.parse(existing.startedAt);
      const completedAtMs = Date.parse(existing.completedAt);
      if (Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)) {
        existing.durationMs = Math.max(0, completedAtMs - startedAtMs);
      }
    }
    existing.responseBody = browserResponseBodyMetadata(existing.responseHeaders);
    tab.requests.set(requestId, existing);
    if ((existing.statusCode ?? 0) >= 400) {
      appendBrowserObservedError(tab, {
        id: `network-${requestId}-${existing.completedAt ?? existing.startedAt}`,
        source: "network",
        kind: "http_error",
        level: "error",
        message:
          existing.statusLine ||
          `HTTP ${existing.statusCode ?? "error"} ${existing.url}`,
        timestamp: existing.completedAt ?? new Date().toISOString(),
        url: existing.url,
        requestId,
        statusCode: existing.statusCode ?? undefined,
        resourceType: existing.resourceType,
      });
    }
  }

  function trackBrowserRequestFailure(details: {
    id: unknown;
    webContentsId?: number;
    url?: string;
    method?: string;
    resourceType?: string;
    referrer?: string;
    timestamp?: number;
    fromCache?: boolean;
    error?: string;
  }): void {
    if (typeof details.webContentsId !== "number") {
      return;
    }
    const tab = browserTabForWebContentsId(details.webContentsId);
    const requestId = browserRequestIdValue(details.id);
    if (!tab || !requestId) {
      return;
    }
    const existing = upsertBrowserRequestRecord(tab, requestId, {
      url: typeof details.url === "string" ? details.url : "",
      method: typeof details.method === "string" ? details.method : "",
      resourceType:
        typeof details.resourceType === "string"
          ? details.resourceType
          : "other",
      referrer: typeof details.referrer === "string" ? details.referrer : "",
      completedAt: browserIsoFromNetworkTimestamp(details.timestamp),
      fromCache: details.fromCache === true,
      error: typeof details.error === "string" ? details.error : "Request failed",
    });
    if (existing.completedAt) {
      const startedAtMs = Date.parse(existing.startedAt);
      const completedAtMs = Date.parse(existing.completedAt);
      if (Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)) {
        existing.durationMs = Math.max(0, completedAtMs - startedAtMs);
      }
    }
    tab.requests.set(requestId, existing);
    appendBrowserObservedError(tab, {
      id: `network-${requestId}-${existing.completedAt ?? existing.startedAt}`,
      source: "network",
      kind: "request_error",
      level: "error",
      message: existing.error || `Request failed for ${existing.url}`,
      timestamp: existing.completedAt ?? new Date().toISOString(),
      url: existing.url,
      requestId,
      resourceType: existing.resourceType,
    });
  }

  return {
    browserTabForWebContentsId,
    appendBrowserObservedError,
    upsertBrowserRequestRecord,
    trackBrowserRequestStart,
    trackBrowserRequestHeaders,
    trackBrowserRequestCompletion,
    trackBrowserRequestFailure,
  };
}
