/**
 * Internal types for the browser-pane subsystem.
 *
 * These types support the profile-import flow extracted in BP-P2 (chromium
 * + safari import). They duplicate / specialise some of the renderer-visible
 * types in `shared/browser-pane-protocol.ts` because the main-process code
 * uses slightly different shapes (e.g. download status uses Electron-native
 * `"progressing"|"interrupted"` while the renderer protocol uses
 * `"in_progress"|"failed"`).
 *
 * Future phases will consolidate these as more browser-pane code migrates
 * out of main.ts.
 */
import type { Session } from "electron";

import type {
  BrowserBookmarkPayload,
  BrowserHistoryEntryPayload,
} from "../../shared/browser-pane-protocol.js";

export type { BrowserBookmarkPayload, BrowserHistoryEntryPayload };

/** Source kinds the import flow accepts from the renderer. */
export type BrowserImportSource = "chrome" | "chromium" | "arc" | "safari";

/** Chromium family browsers we know how to introspect. */
export type ChromiumFamilyBrowser = Exclude<BrowserImportSource, "safari">;

/** Resolved chromium profile location used by the discovery + import flow. */
export interface ChromiumProfileSelection {
  browser: ChromiumFamilyBrowser;
  userDataDir: string;
  profileId: string;
  profileDir: string;
  profileLabel: string;
}

/** Subset of the chrome `Bookmarks` JSON node structure we read. */
export interface ChromeBookmarkNodePayload {
  type?: string;
  name?: string;
  url?: string;
  date_added?: string;
  children?: ChromeBookmarkNodePayload[];
}

/** Result of importing cookies for a single profile/session pair. */
export interface BrowserCookieImportSummary {
  importedCount: number;
  skippedCount: number;
  warnings: string[];
}

/** Aggregate summary returned from a complete import operation. */
export interface BrowserImportSummary {
  sourceKind: BrowserImportSource | "workspace_copy";
  sourceLabel: string;
  sourcePath: string;
  sourceProfileDir: string;
  sourceProfileLabel: string;
  importedBookmarks: number;
  importedHistoryEntries: number;
  importedCookies: number;
  skippedCookies: number;
  warnings: string[];
}

/** Wire payload for `workspace:importBrowserProfile`. */
export interface BrowserImportProfilePayload {
  workspaceId: string;
  source: BrowserImportSource;
  profileDir?: string | null;
  safariArchivePath?: string | null;
}

/** Wire payload for `workspace:copyBrowserWorkspaceProfile`. */
export interface BrowserCopyWorkspaceProfilePayload {
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
}

/** A single discoverable profile option presented to the renderer. */
export interface BrowserImportProfileOptionPayload {
  profileId: string;
  profileLabel: string;
  profileDir: string;
}

/**
 * Native fingerprint for a workspace browser session — used by configuration
 * code and copied across import operations.
 */
export interface BrowserSessionIdentity {
  userAgent: string;
  acceptLanguages: string;
}

/**
 * Minimal structural view of an internal `BrowserWorkspaceState` — only what
 * the import / merge functions actually read or mutate. Avoids pulling the
 * full BrowserTabSpaceState graph into this module while main.ts retains
 * ownership of the state object.
 *
 * Fields kept loose (`unknown`) where the import code merely passes them
 * around without inspecting; the concrete shape lives in main.ts.
 */
export interface BrowserWorkspaceImportTarget {
  workspaceId: string;
  session: Session;
  bookmarks: BrowserBookmarkPayload[];
  history: BrowserHistoryEntryPayload[];
  /**
   * Loose because the download status enum differs main.ts ↔ protocol.
   * Callers cast at the boundary; `cloneBrowserDownloadPayload<T>` preserves T.
   */
  downloads: unknown[];
}
