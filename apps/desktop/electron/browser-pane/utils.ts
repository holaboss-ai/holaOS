/**
 * Pure utility helpers for the browser-pane subsystem.
 *
 * These functions are leaf-level: no module state, no cross-calls into other
 * browser-pane sub-modules, and no electron APIs that require dynamic
 * dependencies. They are safe to import directly anywhere.
 *
 * Extracted from main.ts as part of BP-P5 to begin separating the browser
 * subsystem's internals from main. See `index.ts` for the broader phasing
 * plan.
 */
import path from "node:path";
import { createHash } from "node:crypto";

import type { ContextMenuParams } from "electron";

import type {
  BrowserSpaceId,
  BrowserStatePayload,
  BrowserTabCountsPayload,
} from "../../shared/browser-pane-protocol.js";

// =============================================================================
// State payload constructors
// =============================================================================

/**
 * Concrete shape returned by `createBrowserState` — tighter than the wire
 * protocol's `BrowserStatePayload` because main.ts requires a non-null
 * `error` string. Compatible-by-assignment with the protocol type.
 */
export interface CreatedBrowserState extends BrowserStatePayload {
  error: string;
}

/**
 * Default human label used by `createBrowserState` when no title is provided.
 * Kept as a parameter so the caller (main.ts) can keep its `NEW_TAB_TITLE`
 * constant authoritative.
 */
export function createBrowserState(
  defaults: { newTabTitle: string },
  overrides?: Partial<BrowserStatePayload>,
): CreatedBrowserState {
  return {
    id: overrides?.id ?? "",
    url: overrides?.url ?? "",
    title: overrides?.title ?? defaults.newTabTitle,
    faviconUrl: overrides?.faviconUrl,
    canGoBack: overrides?.canGoBack ?? false,
    canGoForward: overrides?.canGoForward ?? false,
    loading: overrides?.loading ?? false,
    initialized: overrides?.initialized ?? false,
    error: overrides?.error ?? "",
  };
}

export function emptyBrowserTabCountsPayload(): BrowserTabCountsPayload {
  return {
    user: 0,
    agent: 0,
  };
}

// =============================================================================
// BrowserSpaceId helpers
// =============================================================================

/**
 * Coerce an arbitrary string into a `BrowserSpaceId`, falling back to the
 * caller-supplied default for unrecognised values. main.ts threads the
 * currently-active space id as the fallback.
 */
export function browserSpaceId(
  value: string | null | undefined,
  fallback: BrowserSpaceId,
): BrowserSpaceId {
  return value === "agent" ? "agent" : value === "user" ? "user" : fallback;
}

export function oppositeBrowserSpaceId(space: BrowserSpaceId): BrowserSpaceId {
  return space === "agent" ? "user" : "agent";
}

// =============================================================================
// Session id normalization
// =============================================================================

/** Trim a possibly-null session id to a string. Empty string for falsy input. */
export function browserSessionId(value?: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

// =============================================================================
// Workspace storage paths + partition naming
// =============================================================================

/**
 * Stable filesystem-friendly segment derived from a workspace id. Uses an
 * sha256 prefix to disambiguate collisions on the sanitised label.
 */
export function sanitizeBrowserWorkspaceSegment(workspaceId: string): string {
  const normalized =
    workspaceId
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "workspace";
  const digest = createHash("sha256")
    .update(workspaceId.trim(), "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${normalized}-${digest}`;
}

/**
 * Resolves the on-disk directory used to persist a workspace's browser
 * state JSON. `userDataDir` is `app.getPath("userData")` from main.
 */
export function browserWorkspaceStorageDir(
  userDataDir: string,
  workspaceId: string,
): string {
  return path.join(
    userDataDir,
    "browser-workspaces",
    sanitizeBrowserWorkspaceSegment(workspaceId),
  );
}

export function browserWorkspaceStatePath(
  userDataDir: string,
  workspaceId: string,
): string {
  return path.join(
    browserWorkspaceStorageDir(userDataDir, workspaceId),
    "browser-state.json",
  );
}

/** Electron `partition:` value for the workspace's `Session` store. */
export function browserWorkspacePartition(workspaceId: string): string {
  return `persist:holaboss-browser-${sanitizeBrowserWorkspaceSegment(workspaceId)}`;
}

// =============================================================================
// Aborted load detection
// =============================================================================

export function isAbortedBrowserLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  return (
    candidate.code === "ERR_ABORTED" ||
    candidate.errno === -3 ||
    (typeof candidate.message === "string" &&
      candidate.message.includes("ERR_ABORTED"))
  );
}

export function isAbortedBrowserLoadFailure(
  errorCode: number,
  errorDescription: string,
): boolean {
  return (
    errorCode === -3 || errorDescription.trim().toUpperCase() === "ERR_ABORTED"
  );
}

// =============================================================================
// History tracking guard
// =============================================================================

/**
 * Filters non-http(s) URLs out of history persistence. about:, data:,
 * file:, chrome-extension:, etc. should never enter the history list.
 */
export function shouldTrackHistoryUrl(rawUrl: string): boolean {
  if (!rawUrl) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// =============================================================================
// Popup-window-open helpers
// =============================================================================

/**
 * Reduce a popup-window frame name (`window.open` second arg) to a stable
 * non-empty string, or empty string if it should be treated as anonymous.
 */
export function normalizeBrowserPopupFrameName(
  frameName?: string | null,
): string {
  const normalized = typeof frameName === "string" ? frameName.trim() : "";
  return normalized && normalized !== "_blank" ? normalized : "";
}

/**
 * Heuristic: should a `window.open` call be treated as an OAuth-style popup
 * vs a tab-like new window? A non-empty frame name or any positional /
 * sizing feature flag both flag the request as a popup.
 */
export function isBrowserPopupWindowRequest(
  frameName?: string | null,
  features?: string | null,
): boolean {
  if (normalizeBrowserPopupFrameName(frameName)) {
    return true;
  }
  const normalizedFeatures =
    typeof features === "string" ? features.trim().toLowerCase() : "";
  return (
    normalizedFeatures.includes("popup") ||
    normalizedFeatures.includes("width=") ||
    normalizedFeatures.includes("height=") ||
    normalizedFeatures.includes("left=") ||
    normalizedFeatures.includes("top=")
  );
}

// =============================================================================
// User agent / Accept-Language helpers (workspace browser identity)
// =============================================================================

/**
 * Picks a Chromium-like platform token mirroring the host OS. Used to keep
 * the user-agent string aligned with the user's actual platform when the
 * native `session.getUserAgent()` value is empty.
 */
export function browserChromeLikePlatformToken(
  platform: NodeJS.Platform = process.platform,
): string {
  switch (platform) {
    case "darwin":
      return "Macintosh; Intel Mac OS X 10_15_7";
    case "win32":
      return "Windows NT 10.0; Win64; x64";
    default:
      return "X11; Linux x86_64";
  }
}

/**
 * Constructs an Accept-Language header value derived from the host locale.
 * Falls back to `en-US,en` if the locale is empty.
 */
export function browserAcceptedLanguages(locale: string): string {
  const normalized = locale.trim().replace(/_/g, "-");
  const preferred = [normalized, "en-US", "en"].filter(Boolean);
  return [...new Set(preferred)].join(",");
}

// =============================================================================
// Context-menu filename derivation
// =============================================================================

/**
 * Derive a sanitized download filename from a context-menu invocation. Used
 * by the browser pane's "Save image as…" / "Save link as…" flows.
 *
 * `sanitize` must be supplied (main.ts owns the cross-cutting filename
 * sanitiser used elsewhere for attachments).
 */
export function browserContextSuggestedFilename(
  context: ContextMenuParams,
  sanitize: (raw: string) => string,
): string {
  const suggested = context.suggestedFilename.trim();
  if (suggested) {
    return sanitize(suggested);
  }

  const candidateUrl = context.srcURL.trim() || context.linkURL.trim();
  if (!candidateUrl) {
    return context.mediaType === "image" ? "image" : "download";
  }

  try {
    const parsed = new URL(candidateUrl);
    const basename = path.basename(parsed.pathname).trim();
    if (basename) {
      return sanitize(basename);
    }
  } catch {
    // fall through to fallback names below
  }

  return context.mediaType === "image" ? "image" : "download";
}
