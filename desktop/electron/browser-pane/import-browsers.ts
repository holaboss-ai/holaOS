/**
 * Browser profile import — orchestration + Safari helpers.
 *
 * This module owns:
 *   - Safari export (.zip) parsing.
 *   - Bookmark / history merge into a workspace's in-memory state.
 *   - Cookie copy between two electron sessions.
 *   - The public entrypoints called by the workspace IPC handlers
 *     (`importBrowserProfileIntoWorkspace`, `copyBrowserWorkspaceProfile`,
 *     `listImportBrowserProfiles`, etc.).
 *
 * Workspace state, persistence, and renderer notifications are injected via
 * the `BrowserImportDeps` shape so this module never touches main.ts's
 * module-level globals directly. Internal tab manipulation used by
 * `copyBrowserWorkspaceProfile` is also surfaced through `deps` since main
 * still owns the `BrowserTabSpaceState` graph.
 *
 * Extracted from `electron/main.ts` (BP-P2b). Behaviour is unchanged.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  dialog,
  type BrowserWindow,
  type OpenDialogOptions,
  type Session,
} from "electron";
import JSZip from "jszip";

import {
  CHROME_HISTORY_IMPORT_LIMIT,
  chromiumFamilyDisplayName,
  chromeTimestampMicrosToIso,
  discoverChromiumFamilyImportProfiles,
  importChromiumFamilyCookiesIntoWorkspaceSession,
  importedCookieUrl,
  readChromeBookmarks,
  readChromeHistory,
  resolveChromiumFamilyProfileSelection,
  shouldTrackHistoryUrlForImport,
} from "./import-chromium.js";
import type {
  BrowserBookmarkPayload,
  BrowserCookieImportSummary,
  BrowserCopyWorkspaceProfilePayload,
  BrowserHistoryEntryPayload,
  BrowserImportProfileOptionPayload,
  BrowserImportProfilePayload,
  BrowserImportSource,
  BrowserImportSummary,
  BrowserWorkspaceImportTarget,
  ChromiumFamilyBrowser,
} from "./types.js";

const SAFARI_EXPORT_BOOKMARKS_FILE_NAME = "bookmarks.html";
const SAFARI_EXPORT_HISTORY_FILE_NAME = "history.json";

function utcNowIso() {
  return new Date().toISOString();
}

// =============================================================================
// Pure helpers (Safari + bookmark/history merge)
// =============================================================================

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function stripHtmlTags(value: string) {
  return value.replace(/<[^>]*>/g, " ");
}

function normalizeImportedBookmarkFolderPath(
  folderPath: readonly unknown[] | undefined,
) {
  if (!Array.isArray(folderPath)) {
    return [];
  }
  return folderPath
    .map((segment) => (typeof segment === "string" ? segment.trim() : ""))
    .filter(Boolean);
}

function sameBookmarkFolderPath(
  left: readonly unknown[] | undefined,
  right: readonly unknown[] | undefined,
) {
  const leftNormalized = normalizeImportedBookmarkFolderPath(left);
  const rightNormalized = normalizeImportedBookmarkFolderPath(right);
  if (leftNormalized.length !== rightNormalized.length) {
    return false;
  }
  return leftNormalized.every((segment, index) => segment === rightNormalized[index]);
}

export function parseImportedVisitTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(trimmed)) {
      return parseImportedVisitTimestamp(numeric);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
    return null;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  if (value >= 11644473600000000) {
    return chromeTimestampMicrosToIso(Math.floor(value)) ?? null;
  }

  if (value > 10_000_000_000_000) {
    return new Date(Math.floor(value / 1000)).toISOString();
  }

  if (value > 10_000_000_000) {
    return new Date(Math.floor(value)).toISOString();
  }

  return new Date(Math.floor(value * 1000)).toISOString();
}

function zipEntryBasename(entryName: string) {
  const normalized = entryName.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return (segments[segments.length - 1] || "").toLowerCase();
}

export function parseSafariBookmarksFromHtml(
  html: string,
): BrowserBookmarkPayload[] {
  const bookmarks: BrowserBookmarkPayload[] = [];
  const folderPath: string[] = [];
  const dlFolderOwnership: boolean[] = [];
  let pendingFolderName = "";
  const tokenPattern =
    /<h3\b[^>]*>([\s\S]*?)<\/h3>|<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>|<\/?dl\b[^>]*>/gi;

  for (const match of html.matchAll(tokenPattern)) {
    const token = match[0] || "";
    if (/^<h3\b/i.test(token)) {
      pendingFolderName = decodeHtmlEntities(
        stripHtmlTags(match[1] || "")
          .replace(/\s+/g, " ")
          .trim(),
      );
      continue;
    }

    if (/^<dl\b/i.test(token)) {
      const ownsFolder = Boolean(pendingFolderName);
      dlFolderOwnership.push(ownsFolder);
      if (ownsFolder) {
        folderPath.push(pendingFolderName);
        pendingFolderName = "";
      }
      continue;
    }

    if (/^<\/dl\b/i.test(token)) {
      const ownsFolder = dlFolderOwnership.pop();
      if (ownsFolder) {
        folderPath.pop();
      }
      pendingFolderName = "";
      continue;
    }

    const url = (match[2] || "").trim();
    if (!shouldTrackHistoryUrlForImport(url)) {
      pendingFolderName = "";
      continue;
    }
    const cleanedTitle = decodeHtmlEntities(
      stripHtmlTags(match[3] || "")
        .replace(/\s+/g, " ")
        .trim(),
    );
    const normalizedFolderPath = normalizeImportedBookmarkFolderPath(folderPath);
    bookmarks.push({
      id: `bookmark-import-${randomUUID()}`,
      url,
      title: cleanedTitle || url,
      ...(normalizedFolderPath.length > 0
        ? { folderPath: normalizedFolderPath }
        : {}),
      createdAt: utcNowIso(),
    });
    pendingFolderName = "";
  }
  return bookmarks;
}

export function safariHistoryObjectString(
  value: Record<string, unknown>,
  keys: readonly string[],
) {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return "";
}

export function safariHistoryObjectNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
) {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === "string") {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function collectSafariHistoryEntries(
  value: unknown,
  bucket: BrowserHistoryEntryPayload[],
) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSafariHistoryEntries(entry, bucket);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const url = safariHistoryObjectString(record, ["url", "URL"]);
  if (url && shouldTrackHistoryUrlForImport(url)) {
    const title =
      safariHistoryObjectString(record, [
        "title",
        "Title",
        "pageTitle",
        "page_title",
      ]) || url;
    const visitCountRaw = safariHistoryObjectNumber(record, [
      "visit_count",
      "visitCount",
      "visit_count_total",
    ]);
    const visitCount =
      visitCountRaw && visitCountRaw > 0 ? Math.floor(visitCountRaw) : 1;
    const lastVisitedAt =
      parseImportedVisitTimestamp(
        record.lastVisitedAt ??
          record.last_visited_at ??
          record.lastVisitTime ??
          record.last_visit_time ??
          record.visitedAt ??
          record.visited_at ??
          record.visit_time ??
          record.visitTime ??
          record.timestamp,
      ) ?? utcNowIso();
    bucket.push({
      id: `history-import-${randomUUID()}`,
      url,
      title,
      visitCount,
      createdAt: lastVisitedAt,
      lastVisitedAt,
    });
  }

  for (const nestedValue of Object.values(record)) {
    if (nestedValue && typeof nestedValue === "object") {
      collectSafariHistoryEntries(nestedValue, bucket);
    }
  }
}

export function parseSafariHistoryEntriesFromJson(
  jsonContent: string,
): BrowserHistoryEntryPayload[] {
  const parsed = JSON.parse(jsonContent) as unknown;
  const entries: BrowserHistoryEntryPayload[] = [];
  collectSafariHistoryEntries(parsed, entries);
  return entries.slice(0, CHROME_HISTORY_IMPORT_LIMIT);
}

async function selectSafariExportArchivePath(
  ownerWindow: BrowserWindow | null,
): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: "Select Safari Export ZIP",
    buttonLabel: "Import Safari Export",
    properties: ["openFile"],
    filters: [{ name: "ZIP files", extensions: ["zip"] }],
    defaultPath: path.join(os.homedir(), "Downloads"),
    message:
      "Choose a Safari export zip that contains Bookmarks.html and History.json.",
  };
  const validOwner =
    ownerWindow && !ownerWindow.isDestroyed() ? ownerWindow : undefined;
  const result = validOwner
    ? await dialog.showOpenDialog(validOwner, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0]?.trim() || null;
}

async function readSafariExportArchive(
  archivePath: string,
): Promise<{
  bookmarks: BrowserBookmarkPayload[];
  history: BrowserHistoryEntryPayload[];
}> {
  const zipBuffer = await fs.readFile(archivePath);
  const zip = await JSZip.loadAsync(zipBuffer);

  let bookmarksHtmlContent = "";
  let historyJsonContent = "";
  for (const zipEntry of Object.values(zip.files)) {
    if (zipEntry.dir) {
      continue;
    }
    const basename = zipEntryBasename(zipEntry.name);
    if (!bookmarksHtmlContent && basename === SAFARI_EXPORT_BOOKMARKS_FILE_NAME) {
      bookmarksHtmlContent = await zipEntry.async("string");
      continue;
    }
    if (!historyJsonContent && basename === SAFARI_EXPORT_HISTORY_FILE_NAME) {
      historyJsonContent = await zipEntry.async("string");
    }
  }

  if (!bookmarksHtmlContent && !historyJsonContent) {
    throw new Error(
      "Safari export zip did not include Bookmarks.html or History.json.",
    );
  }

  return {
    bookmarks: bookmarksHtmlContent
      ? parseSafariBookmarksFromHtml(bookmarksHtmlContent)
      : [],
    history: historyJsonContent
      ? parseSafariHistoryEntriesFromJson(historyJsonContent)
      : [],
  };
}

export async function copyCookiesBetweenBrowserSessions(
  sourceSession: Session,
  targetSession: Session,
): Promise<BrowserCookieImportSummary> {
  await targetSession.clearStorageData({ storages: ["cookies"] });

  const sourceCookies = await sourceSession.cookies.get({});
  let importedCount = 0;
  let skippedCount = 0;
  const warnings = new Set<string>();
  const nowEpochSeconds = Date.now() / 1000;
  let expiredCount = 0;

  for (const cookie of sourceCookies) {
    const cookieUrl = importedCookieUrl(
      cookie.domain || "",
      cookie.path || "/",
      Boolean(cookie.secure),
    );
    if (!cookieUrl || !cookie.name?.trim()) {
      skippedCount += 1;
      continue;
    }
    if (
      typeof cookie.expirationDate === "number" &&
      Number.isFinite(cookie.expirationDate) &&
      cookie.expirationDate <= nowEpochSeconds
    ) {
      skippedCount += 1;
      expiredCount += 1;
      continue;
    }
    try {
      await targetSession.cookies.set({
        url: cookieUrl,
        name: cookie.name.trim(),
        value: cookie.value ?? "",
        domain: cookie.domain || undefined,
        path: cookie.path || "/",
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: cookie.sameSite ?? "unspecified",
        expirationDate:
          typeof cookie.expirationDate === "number" &&
            Number.isFinite(cookie.expirationDate)
            ? cookie.expirationDate
            : undefined,
      });
      importedCount += 1;
    } catch (error) {
      skippedCount += 1;
      warnings.add(
        error instanceof Error
          ? error.message
          : "Some cookies could not be copied into the target workspace.",
      );
    }
  }

  if (expiredCount > 0) {
    warnings.add(`Skipped ${expiredCount} expired workspace cookies.`);
  }

  await targetSession.cookies.flushStore();
  return {
    importedCount,
    skippedCount,
    warnings: Array.from(warnings),
  };
}

export function cloneBrowserBookmarkPayload(
  bookmark: BrowserBookmarkPayload,
): BrowserBookmarkPayload {
  const folderPath = normalizeImportedBookmarkFolderPath(bookmark.folderPath);
  return {
    id: `bookmark-import-${randomUUID()}`,
    url: bookmark.url,
    title: bookmark.title,
    faviconUrl: bookmark.faviconUrl,
    ...(folderPath.length > 0 ? { folderPath } : {}),
    createdAt: bookmark.createdAt,
  };
}

export function cloneBrowserHistoryEntryPayload(
  entry: BrowserHistoryEntryPayload,
): BrowserHistoryEntryPayload {
  return {
    id: `history-import-${randomUUID()}`,
    url: entry.url,
    title: entry.title,
    faviconUrl: entry.faviconUrl,
    visitCount: entry.visitCount,
    createdAt: entry.createdAt,
    lastVisitedAt: entry.lastVisitedAt,
  };
}

/**
 * Generic copy of a download payload — uses a structural type because main.ts
 * and the renderer disagree about the `status` enum (electron-native vs
 * protocol). Callers know the concrete shape they're cloning.
 */
export function cloneBrowserDownloadPayload<
  T extends { id: string },
>(download: T): T {
  return {
    ...download,
    id: `download-import-${randomUUID()}`,
  };
}

export function mergeImportedBookmarksIntoWorkspace(
  workspace: BrowserWorkspaceImportTarget,
  importedBookmarks: BrowserBookmarkPayload[],
) {
  const bookmarkByUrl = new Map(
    workspace.bookmarks.map((bookmark) => [bookmark.url, bookmark] as const),
  );
  let changedCount = 0;

  for (const importedBookmark of importedBookmarks) {
    if (!shouldTrackHistoryUrlForImport(importedBookmark.url)) {
      continue;
    }
    const existing = bookmarkByUrl.get(importedBookmark.url);
    if (!existing) {
      bookmarkByUrl.set(importedBookmark.url, importedBookmark);
      changedCount += 1;
      continue;
    }

    const nextTitle = importedBookmark.title?.trim() || existing.title;
    const nextCreatedAt = existing.createdAt || importedBookmark.createdAt;
    const nextFolderPath =
      normalizeImportedBookmarkFolderPath(existing.folderPath).length > 0
        ? normalizeImportedBookmarkFolderPath(existing.folderPath)
        : normalizeImportedBookmarkFolderPath(importedBookmark.folderPath);
    if (
      nextTitle !== existing.title ||
      nextCreatedAt !== existing.createdAt ||
      !sameBookmarkFolderPath(existing.folderPath, nextFolderPath)
    ) {
      bookmarkByUrl.set(importedBookmark.url, {
        ...existing,
        title: nextTitle,
        ...(nextFolderPath.length > 0 ? { folderPath: nextFolderPath } : {}),
        createdAt: nextCreatedAt,
      });
      changedCount += 1;
    }
  }

  workspace.bookmarks = Array.from(bookmarkByUrl.values()).sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
  return changedCount;
}

export function mergeImportedHistoryIntoWorkspace(
  workspace: BrowserWorkspaceImportTarget,
  importedHistoryEntries: BrowserHistoryEntryPayload[],
) {
  const historyByUrl = new Map(
    workspace.history.map((entry) => [entry.url, entry] as const),
  );
  let changedCount = 0;

  for (const importedEntry of importedHistoryEntries) {
    if (!shouldTrackHistoryUrlForImport(importedEntry.url)) {
      continue;
    }
    const existing = historyByUrl.get(importedEntry.url);
    if (!existing) {
      historyByUrl.set(importedEntry.url, importedEntry);
      changedCount += 1;
      continue;
    }

    const nextLastVisitedAt =
      new Date(importedEntry.lastVisitedAt).getTime() >
        new Date(existing.lastVisitedAt).getTime()
        ? importedEntry.lastVisitedAt
        : existing.lastVisitedAt;
    const nextCreatedAt =
      new Date(importedEntry.createdAt).getTime() <
        new Date(existing.createdAt).getTime()
        ? importedEntry.createdAt
        : existing.createdAt;
    const nextVisitCount = Math.max(
      existing.visitCount,
      importedEntry.visitCount,
    );
    const nextTitle = importedEntry.title?.trim() || existing.title;
    if (
      nextLastVisitedAt !== existing.lastVisitedAt ||
      nextCreatedAt !== existing.createdAt ||
      nextVisitCount !== existing.visitCount ||
      nextTitle !== existing.title
    ) {
      historyByUrl.set(importedEntry.url, {
        ...existing,
        title: nextTitle,
        createdAt: nextCreatedAt,
        lastVisitedAt: nextLastVisitedAt,
        visitCount: nextVisitCount,
      });
      changedCount += 1;
    }
  }

  workspace.history = Array.from(historyByUrl.values())
    .sort(
      (left, right) =>
        new Date(right.lastVisitedAt).getTime() -
        new Date(left.lastVisitedAt).getTime(),
    )
    .slice(0, CHROME_HISTORY_IMPORT_LIMIT);
  return changedCount;
}

// =============================================================================
// Public orchestration entrypoints (require deps)
// =============================================================================

/**
 * Dependencies the import / copy orchestration calls back into. main.ts owns
 * the workspace state graph and the renderer-notification surface; this
 * module never reaches into those globals directly.
 */
export interface BrowserImportDeps {
  /**
   * Resolve (creating if necessary) the workspace browser state. Mirrors
   * `ensureBrowserWorkspace(workspaceId, space)` in main.ts.
   */
  ensureBrowserWorkspace: (
    workspaceId: string | null | undefined,
    space?: "user" | "agent" | null,
  ) => Promise<BrowserWorkspaceImportTarget | null>;

  /** Write the workspace's persistence file. */
  persistBrowserWorkspace: (workspaceId: string) => Promise<void> | void;

  /** Notify renderer of bookmarks change (no-arg = active workspace). */
  emitBookmarksState: (workspaceId: string) => void;

  /** Notify renderer of history change. */
  emitHistoryState: (workspaceId: string) => void;

  /** Notify renderer of downloads change. */
  emitDownloadsState: (workspaceId: string) => void;

  /** Notify renderer of browser tab state change for a workspace+space. */
  emitBrowserState: (
    workspaceId: string,
    space: "user" | "agent",
  ) => void;

  /** Currently-attached workspace id (used to decide whether to rebind view). */
  getActiveBrowserWorkspaceId: () => string;

  /** Currently-attached space id (default for ensureBrowserWorkspace). */
  getActiveBrowserSpaceId: () => "user" | "agent";

  /** Re-attach the browser view to the active tab on the active workspace. */
  updateAttachedBrowserView: () => void;

  /** Owner window for native dialogs (Safari archive picker, etc.). */
  getMainWindow: () => BrowserWindow | null;

  /**
   * Hooks for `copyBrowserWorkspaceProfile`'s tab-graph manipulation. main.ts
   * still owns the tab-space data structures, so we proxy through these.
   */
  tabGraph: BrowserImportTabGraphDeps;
}

/**
 * Tab graph manipulation needed for `copyBrowserWorkspaceProfile`. Supplied
 * by main.ts using its existing helpers.
 */
export interface BrowserImportTabGraphDeps {
  /** Iterate the two known browser spaces for a workspace. */
  forEachBrowserSpace: (
    callback: (
      space: "user" | "agent",
      action: BrowserCopySpaceAction,
    ) => void,
  ) => void;

  /** Clear the agent-session-scoped tab spaces on the target workspace. */
  resetAgentSessionSpaces: (targetWorkspaceId: string) => void;

  /** Reset the user-browser lock on the target. */
  clearUserBrowserLock: (targetWorkspaceId: string) => void;

  /** Set `activeAgentSessionId` to null on the target. */
  clearActiveAgentSession: (targetWorkspaceId: string) => void;
}

/**
 * Per-space copy action provided by main.ts when iterating in
 * `forEachBrowserSpace`. main.ts owns the `BrowserTabSpaceState` shape;
 * import-browsers only needs the imperative API.
 */
export interface BrowserCopySpaceAction {
  /** Reset the destination tab space prior to copying tabs in. */
  resetTargetSpace: () => void;
  /**
   * Copy the source space's tabs into the target space, returning the new
   * active tab id (or `""` if no tabs were copied).
   */
  copyTabsAndResolveActive: () => string;
  /** Apply the resolved active-tab id to the target space. */
  setActiveTab: (activeTabId: string) => void;
}

export async function listImportBrowserProfiles(
  source: BrowserImportSource,
): Promise<BrowserImportProfileOptionPayload[]> {
  if (source === "safari") {
    return [];
  }
  const { profiles } = await discoverChromiumFamilyImportProfiles(source);
  return profiles.map((profile) => ({
    profileId: profile.profileId,
    profileLabel: profile.profileLabel,
    profileDir: profile.profileDir,
  }));
}

export async function importChromiumFamilyProfileIntoWorkspace(
  browser: ChromiumFamilyBrowser,
  workspaceId: string | null | undefined,
  profileDir: string | null | undefined,
  deps: BrowserImportDeps,
): Promise<BrowserImportSummary | null> {
  const workspace = await deps.ensureBrowserWorkspace(
    workspaceId,
    deps.getActiveBrowserSpaceId(),
  );
  if (!workspace) {
    throw new Error("Choose a workspace before importing browser data.");
  }
  const browserDisplayName = chromiumFamilyDisplayName(browser);

  const selection = await resolveChromiumFamilyProfileSelection(
    browser,
    profileDir,
    deps.getMainWindow(),
  );
  if (!selection) {
    return null;
  }

  const importedBookmarks = await readChromeBookmarks(selection.profileDir);
  const importedHistoryEntries = await readChromeHistory(selection.profileDir);
  const bookmarkCount = mergeImportedBookmarksIntoWorkspace(
    workspace,
    importedBookmarks,
  );
  const historyCount = mergeImportedHistoryIntoWorkspace(
    workspace,
    importedHistoryEntries,
  );
  const cookieSummary = await importChromiumFamilyCookiesIntoWorkspaceSession(
    browser,
    workspace.session,
    selection.profileDir,
  );
  const warnings = new Set(cookieSummary.warnings);
  if (
    cookieSummary.importedCount === 0 &&
    (bookmarkCount > 0 || historyCount > 0)
  ) {
    warnings.add(
      `No transferable ${browserDisplayName} cookies were imported. Some sites may require signing in again.`,
    );
  }

  if (
    bookmarkCount === 0 &&
    historyCount === 0 &&
    cookieSummary.importedCount === 0 &&
    warnings.size === 0
  ) {
    throw new Error(
      `No importable bookmarks, history, or cookies were found in that ${browserDisplayName} profile.`,
    );
  }

  deps.emitBookmarksState(workspace.workspaceId);
  deps.emitHistoryState(workspace.workspaceId);
  await deps.persistBrowserWorkspace(workspace.workspaceId);

  return {
    sourceKind: browser,
    sourceLabel: `${browserDisplayName} ${selection.profileLabel}`,
    sourcePath: selection.profileDir,
    sourceProfileDir: selection.profileDir,
    sourceProfileLabel: selection.profileLabel,
    importedBookmarks: bookmarkCount,
    importedHistoryEntries: historyCount,
    importedCookies: cookieSummary.importedCount,
    skippedCookies: cookieSummary.skippedCount,
    warnings: Array.from(warnings),
  };
}

export async function importSafariProfileIntoWorkspace(
  workspaceId: string | null | undefined,
  safariArchivePath: string | null | undefined,
  deps: BrowserImportDeps,
): Promise<BrowserImportSummary | null> {
  const workspace = await deps.ensureBrowserWorkspace(
    workspaceId,
    deps.getActiveBrowserSpaceId(),
  );
  if (!workspace) {
    throw new Error("Choose a workspace before importing browser data.");
  }

  const archivePath =
    typeof safariArchivePath === "string" && safariArchivePath.trim()
      ? safariArchivePath.trim()
      : await selectSafariExportArchivePath(deps.getMainWindow());
  if (!archivePath) {
    return null;
  }

  const safariExport = await readSafariExportArchive(archivePath);
  const bookmarkCount = mergeImportedBookmarksIntoWorkspace(
    workspace,
    safariExport.bookmarks,
  );
  const historyCount = mergeImportedHistoryIntoWorkspace(
    workspace,
    safariExport.history,
  );

  if (bookmarkCount === 0 && historyCount === 0) {
    throw new Error(
      "No importable bookmarks or history entries were found in that Safari export.",
    );
  }

  deps.emitBookmarksState(workspace.workspaceId);
  deps.emitHistoryState(workspace.workspaceId);
  await deps.persistBrowserWorkspace(workspace.workspaceId);

  return {
    sourceKind: "safari",
    sourceLabel: `Safari export ${path.basename(archivePath)}`,
    sourcePath: archivePath,
    sourceProfileDir: archivePath,
    sourceProfileLabel: path.basename(archivePath),
    importedBookmarks: bookmarkCount,
    importedHistoryEntries: historyCount,
    importedCookies: 0,
    skippedCookies: 0,
    warnings: [
      "Safari export files include bookmarks and history only. Cookies and login sessions are not included.",
    ],
  };
}

export async function copyBrowserWorkspaceProfile(
  payload: BrowserCopyWorkspaceProfilePayload,
  deps: BrowserImportDeps,
): Promise<BrowserImportSummary> {
  const sourceWorkspaceId = payload.sourceWorkspaceId.trim();
  const targetWorkspaceId = payload.targetWorkspaceId.trim();
  if (!sourceWorkspaceId || !targetWorkspaceId) {
    throw new Error("Both source and target workspaces are required.");
  }
  if (sourceWorkspaceId === targetWorkspaceId) {
    throw new Error("Choose a different source workspace to copy from.");
  }

  const sourceWorkspace = await deps.ensureBrowserWorkspace(
    sourceWorkspaceId,
    "user",
  );
  const targetWorkspace = await deps.ensureBrowserWorkspace(
    targetWorkspaceId,
    "user",
  );
  if (!sourceWorkspace || !targetWorkspace) {
    throw new Error(
      "Could not resolve source and target workspace browser state.",
    );
  }

  targetWorkspace.bookmarks = sourceWorkspace.bookmarks.map(
    cloneBrowserBookmarkPayload,
  );
  targetWorkspace.history = sourceWorkspace.history.map(
    cloneBrowserHistoryEntryPayload,
  );
  targetWorkspace.downloads = (
    sourceWorkspace.downloads as Array<{ id: string }>
  ).map(cloneBrowserDownloadPayload);

  deps.tabGraph.forEachBrowserSpace((_browserSpace, action) => {
    action.resetTargetSpace();
    const nextActiveTabId = action.copyTabsAndResolveActive();
    action.setActiveTab(nextActiveTabId);
  });
  deps.tabGraph.resetAgentSessionSpaces(targetWorkspaceId);
  deps.tabGraph.clearUserBrowserLock(targetWorkspaceId);
  deps.tabGraph.clearActiveAgentSession(targetWorkspaceId);

  const cookieSummary = await copyCookiesBetweenBrowserSessions(
    sourceWorkspace.session,
    targetWorkspace.session,
  );

  if (targetWorkspaceId === deps.getActiveBrowserWorkspaceId()) {
    deps.updateAttachedBrowserView();
    deps.emitBrowserState(targetWorkspaceId, deps.getActiveBrowserSpaceId());
  }
  deps.emitBookmarksState(targetWorkspaceId);
  deps.emitDownloadsState(targetWorkspaceId);
  deps.emitHistoryState(targetWorkspaceId);
  await deps.persistBrowserWorkspace(targetWorkspaceId);

  return {
    sourceKind: "workspace_copy",
    sourceLabel: sourceWorkspaceId,
    sourcePath: sourceWorkspaceId,
    sourceProfileDir: sourceWorkspaceId,
    sourceProfileLabel: sourceWorkspaceId,
    importedBookmarks: targetWorkspace.bookmarks.length,
    importedHistoryEntries: targetWorkspace.history.length,
    importedCookies: cookieSummary.importedCount,
    skippedCookies: cookieSummary.skippedCount,
    warnings: cookieSummary.warnings,
  };
}

export async function importBrowserProfileIntoWorkspace(
  payload: BrowserImportProfilePayload,
  deps: BrowserImportDeps,
): Promise<BrowserImportSummary | null> {
  const source = payload.source;
  const workspaceId = payload.workspaceId;
  if (source === "safari") {
    return importSafariProfileIntoWorkspace(
      workspaceId,
      payload.safariArchivePath,
      deps,
    );
  }
  return importChromiumFamilyProfileIntoWorkspace(
    source,
    workspaceId,
    payload.profileDir,
    deps,
  );
}

export async function importChromeProfileIntoWorkspace(
  workspaceId: string | null | undefined,
  deps: BrowserImportDeps,
): Promise<BrowserImportSummary | null> {
  return importChromiumFamilyProfileIntoWorkspace(
    "chrome",
    workspaceId,
    null,
    deps,
  );
}
