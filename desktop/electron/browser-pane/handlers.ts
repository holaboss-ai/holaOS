/**
 * Browser-pane IPC handlers (BP-HANDLERS).
 *
 * Registers every `browser:*` IPC channel the renderer talks to. The
 * handler bodies are mostly orchestration over already-extracted
 * subsystems (tab-state, popups, bookmarks, downloads, user-lock); this
 * deps blob is wide because the handlers are the integration point
 * between renderer intent and the modular browser pane.
 *
 * Each handler is a thin wrapper over a domain function — no business
 * logic lives here. Mutations go through the dep callbacks that own
 * persistence, lifecycle, and event emission.
 */
import {
  type BrowserView,
  type BrowserWindow,
  type IpcMain,
  type IpcMainInvokeEvent,
  clipboard,
  dialog,
  shell,
} from "electron";

import type {
  AddressSuggestionPayload,
  BrowserAnchorBoundsPayload,
  BrowserBoundsPayload,
  BrowserClipboardScreenshotPayload,
  BrowserSpaceId,
  BrowserVisibleSnapshotPayload,
} from "../../shared/browser-pane-protocol.js";

/**
 * Local widened shapes — the shared protocol versions are stricter
 * (sessionId: string), but this module receives main.ts's broader values
 * (sessionId: string | null). Keep wire-compatible by being permissive on
 * the read side.
 */
export interface BrowserBookmarkPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  folderPath?: string[];
  createdAt: string;
}
export interface BrowserDownloadPayload {
  id?: string;
  targetPath?: string | null;
}
export interface BrowserHistoryEntryPayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  visitCount: number;
  createdAt: string;
  lastVisitedAt: string;
}
export interface BrowserTabListPayload {
  space: BrowserSpaceId;
  activeTabId: string;
  tabs: unknown[];
  tabCounts: { user: number; agent: number };
  sessionId: string | null;
  lifecycleState: "active" | "suspended" | null;
  controlMode: "none" | "user_locked" | "session_owned";
  controlSessionId: string | null;
}

export interface HandlersTabRecord {
  view: { webContents: import("electron").WebContents };
  state: {
    id: string;
    url: string;
    title: string;
    faviconUrl?: string;
    error?: string | null;
  };
}

export interface HandlersTabSpaceState {
  activeTabId: string;
}

export interface HandlersWorkspaceState {
  workspaceId: string;
  bookmarks: BrowserBookmarkPayload[];
  downloads: BrowserDownloadPayload[];
  history: BrowserHistoryEntryPayload[];
}

export interface BrowserChromeImportSummary {
  sourceProfileLabel: string;
  sourceProfileDir: string;
  importedBookmarks: number;
  importedHistoryEntries: number;
  importedCookies: number;
  skippedCookies: number;
  warnings: string[];
}

export interface BrowserPanePopupsHandle {
  showAddressSuggestionsPopup: (
    anchorBounds: BrowserAnchorBoundsPayload,
    suggestions: AddressSuggestionPayload[],
    selectedIndex: number,
  ) => void;
  hideAddressSuggestionsPopup: () => void;
  toggleOverflowPopup: (anchorBounds: BrowserAnchorBoundsPayload) => void;
  hideOverflowPopup: () => void;
  getOverflowAnchorBounds: () => BrowserAnchorBoundsPayload | null;
  toggleHistoryPopup: (anchorBounds: BrowserAnchorBoundsPayload) => void;
  hideHistoryPopup: () => void;
  toggleDownloadsPopup: (anchorBounds: BrowserAnchorBoundsPayload) => void;
  hideDownloadsPopup: () => void;
}

export interface BrowserPaneIpcDeps {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;

  getActiveWorkspaceId: () => string;
  getActiveSpaceId: () => BrowserSpaceId;
  getActiveSessionId: () => string;

  ensureBrowserWorkspace: (
    workspaceId?: string | null,
    space?: BrowserSpaceId | null,
    sessionId?: string | null,
  ) => Promise<HandlersWorkspaceState | null>;
  setActiveBrowserWorkspace: (
    workspaceId?: string | null,
    space?: BrowserSpaceId | null,
    sessionId?: string | null,
  ) => Promise<unknown>;
  browserWorkspaceSnapshot: (
    workspaceId?: string | null,
    space?: BrowserSpaceId | null,
    sessionId?: string | null,
    options?: { useVisibleAgentSession?: boolean },
  ) => BrowserTabListPayload;
  emptyBrowserTabListPayload: (space: BrowserSpaceId) => BrowserTabListPayload;
  browserTabSpaceState: (
    workspace: HandlersWorkspaceState | null,
    space: BrowserSpaceId,
    sessionId: string | null,
    options: { useVisibleAgentSession?: boolean },
  ) => HandlersTabSpaceState | null;

  setBrowserBounds: (bounds: BrowserBoundsPayload) => void;
  captureVisibleBrowserSnapshot: () => Promise<BrowserVisibleSnapshotPayload | null>;
  navigateActiveBrowserTab: (
    workspaceId: string,
    targetUrl: string,
    space: BrowserSpaceId,
    sessionId: string | null,
  ) => Promise<BrowserTabListPayload>;
  getActiveBrowserTab: (
    workspaceId: string | undefined,
    space: BrowserSpaceId,
    sessionId: string | null,
    options: { useVisibleAgentSession: boolean },
  ) => HandlersTabRecord | null;
  activeVisibleBrowserTarget: () => {
    workspaceId: string;
    space: BrowserSpaceId;
    sessionId: string | null;
  };
  currentBrowserTabPageTitle: (tab: HandlersTabRecord) => string;
  currentBrowserTabUrl: (tab: HandlersTabRecord) => string;
  createBrowserTab: (
    workspaceId: string,
    options: {
      url?: string;
      browserSpace: BrowserSpaceId;
      sessionId: string | null;
    },
  ) => string | null;
  setActiveBrowserTab: (
    tabId: string,
    options: {
      space: BrowserSpaceId;
      sessionId: string | null;
      useVisibleAgentSession: boolean;
    },
  ) => Promise<BrowserTabListPayload>;
  closeBrowserTab: (
    tabId: string,
    options: {
      space: BrowserSpaceId;
      sessionId: string | null;
      useVisibleAgentSession: boolean;
    },
  ) => Promise<BrowserTabListPayload>;
  setVisibleAgentBrowserSession: (
    workspace: HandlersWorkspaceState,
    sessionId: string,
  ) => void;
  updateAttachedBrowserView: () => void;
  emitBrowserState: (workspaceId: string, space: BrowserSpaceId) => void;
  persistWorkspace: (workspaceId: string) => Promise<void>;

  maybePromptBrowserInterrupt: (
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId: string | null,
  ) => boolean;
  emitBookmarksState: (workspaceId: string) => void;
  emitDownloadsState: (workspaceId?: string | null) => void;
  emitHistoryState: (workspaceId?: string | null) => void;

  popups: BrowserPanePopupsHandle;
  importChromeProfileIntoWorkspace: (
    workspaceId: string,
  ) => Promise<BrowserChromeImportSummary | null>;
  isAbortedBrowserLoadError: (error: unknown) => boolean;
}

export function installBrowserPaneIpcHandlers(deps: BrowserPaneIpcDeps): void {
  const {
    ipcMain,
    getMainWindow,
    getActiveWorkspaceId,
    getActiveSpaceId,
    getActiveSessionId,
    ensureBrowserWorkspace,
    setActiveBrowserWorkspace,
    browserWorkspaceSnapshot,
    emptyBrowserTabListPayload,
    browserTabSpaceState,
    setBrowserBounds,
    captureVisibleBrowserSnapshot,
    navigateActiveBrowserTab,
    getActiveBrowserTab,
    activeVisibleBrowserTarget,
    currentBrowserTabPageTitle,
    currentBrowserTabUrl,
    createBrowserTab,
    setActiveBrowserTab,
    closeBrowserTab,
    setVisibleAgentBrowserSession,
    updateAttachedBrowserView,
    emitBrowserState,
    persistWorkspace,
    maybePromptBrowserInterrupt,
    emitBookmarksState,
    emitDownloadsState,
    emitHistoryState,
    popups,
    importChromeProfileIntoWorkspace,
    isAbortedBrowserLoadError,
  } = deps;

  const agentSessionForSpace = (): string | null =>
    getActiveSpaceId() === "agent" ? getActiveSessionId() : null;

  const interruptOrSnapshot = (): BrowserTabListPayload | null => {
    const workspaceId = getActiveWorkspaceId();
    if (!workspaceId) return null;
    if (
      maybePromptBrowserInterrupt(
        workspaceId,
        getActiveSpaceId(),
        agentSessionForSpace(),
      )
    ) {
      return browserWorkspaceSnapshot(
        workspaceId,
        getActiveSpaceId(),
        agentSessionForSpace(),
        { useVisibleAgentSession: true },
      );
    }
    return null;
  };

  ipcMain.handle(
    "browser:setActiveWorkspace",
    async (
      _event: IpcMainInvokeEvent,
      workspaceId?: string | null,
      space?: BrowserSpaceId | null,
      sessionId?: string | null,
    ) => setActiveBrowserWorkspace(workspaceId, space, sessionId),
  );

  ipcMain.handle("browser:getState", async () => {
    await ensureBrowserWorkspace(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
    );
    return browserWorkspaceSnapshot(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
      { useVisibleAgentSession: true },
    );
  });

  ipcMain.handle(
    "browser:setBounds",
    async (_event: IpcMainInvokeEvent, bounds: BrowserBoundsPayload) => {
      setBrowserBounds(bounds);
      return browserWorkspaceSnapshot(
        undefined,
        getActiveSpaceId(),
        agentSessionForSpace(),
        { useVisibleAgentSession: true },
      );
    },
  );

  ipcMain.handle("browser:captureVisibleSnapshot", async () =>
    captureVisibleBrowserSnapshot(),
  );

  ipcMain.handle(
    "browser:navigate",
    async (_event: IpcMainInvokeEvent, targetUrl: string) => {
      const workspaceId = getActiveWorkspaceId();
      if (!workspaceId) return emptyBrowserTabListPayload(getActiveSpaceId());
      const interrupted = interruptOrSnapshot();
      if (interrupted) return interrupted;
      return navigateActiveBrowserTab(
        workspaceId,
        targetUrl,
        getActiveSpaceId(),
        agentSessionForSpace(),
      );
    },
  );

  ipcMain.handle("browser:back", async () => {
    const interrupted = interruptOrSnapshot();
    if (interrupted) return interrupted;
    await ensureBrowserWorkspace(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
    );
    const activeTab = getActiveBrowserTab(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
      { useVisibleAgentSession: true },
    );
    if (activeTab?.view.webContents.navigationHistory.canGoBack()) {
      activeTab.view.webContents.navigationHistory.goBack();
    }
    return browserWorkspaceSnapshot(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
      { useVisibleAgentSession: true },
    );
  });

  ipcMain.handle("browser:forward", async () => {
    const interrupted = interruptOrSnapshot();
    if (interrupted) return interrupted;
    await ensureBrowserWorkspace(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
    );
    const activeTab = getActiveBrowserTab(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
      { useVisibleAgentSession: true },
    );
    if (activeTab?.view.webContents.navigationHistory.canGoForward()) {
      activeTab.view.webContents.navigationHistory.goForward();
    }
    return browserWorkspaceSnapshot(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
      { useVisibleAgentSession: true },
    );
  });

  ipcMain.handle("browser:reload", async () => {
    const interrupted = interruptOrSnapshot();
    if (interrupted) return interrupted;
    await ensureBrowserWorkspace(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
    );
    getActiveBrowserTab(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
      { useVisibleAgentSession: true },
    )?.view.webContents.reload();
    return browserWorkspaceSnapshot(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
      { useVisibleAgentSession: true },
    );
  });

  ipcMain.handle("browser:stopLoading", async () => {
    const interrupted = interruptOrSnapshot();
    if (interrupted) return interrupted;
    await ensureBrowserWorkspace(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
    );
    const activeTab = getActiveBrowserTab(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
      { useVisibleAgentSession: true },
    );
    if (activeTab?.view.webContents.isLoadingMainFrame()) {
      activeTab.view.webContents.stop();
    }
    return browserWorkspaceSnapshot(
      undefined,
      getActiveSpaceId(),
      agentSessionForSpace(),
      { useVisibleAgentSession: true },
    );
  });

  ipcMain.handle("browser:captureScreenshotToClipboard", async () => {
    const target = activeVisibleBrowserTarget();
    if (!target.workspaceId) {
      throw new Error("No active browser tab is available.");
    }
    const interrupted = maybePromptBrowserInterrupt(
      target.workspaceId,
      target.space,
      target.sessionId,
    );
    await ensureBrowserWorkspace(undefined, target.space, target.sessionId);
    const activeTab = getActiveBrowserTab(
      undefined,
      target.space,
      target.sessionId,
      { useVisibleAgentSession: true },
    );
    if (!activeTab) {
      throw new Error("No active browser tab is available.");
    }
    if (interrupted) {
      return {
        tabId: activeTab.state.id,
        pageTitle: currentBrowserTabPageTitle(activeTab),
        url: currentBrowserTabUrl(activeTab),
        width: 0,
        height: 0,
        copied: false,
      } satisfies BrowserClipboardScreenshotPayload;
    }
    const image = await activeTab.view.webContents.capturePage();
    clipboard.writeImage(image);
    const size = image.getSize();
    return {
      tabId: activeTab.state.id,
      pageTitle: currentBrowserTabPageTitle(activeTab),
      url: currentBrowserTabUrl(activeTab),
      width: size.width,
      height: size.height,
      copied: true,
    } satisfies BrowserClipboardScreenshotPayload;
  });

  ipcMain.handle(
    "browser:newTab",
    async (_event: IpcMainInvokeEvent, targetUrl?: string) => {
      const interrupted = interruptOrSnapshot();
      if (interrupted) return interrupted;
      const workspace = await ensureBrowserWorkspace(
        undefined,
        getActiveSpaceId(),
        agentSessionForSpace(),
      );
      const tabSpace = browserTabSpaceState(
        workspace,
        getActiveSpaceId(),
        agentSessionForSpace(),
        { useVisibleAgentSession: true },
      );
      if (!workspace) {
        return emptyBrowserTabListPayload(getActiveSpaceId());
      }
      const sessionId = agentSessionForSpace();
      const nextTabId = createBrowserTab(workspace.workspaceId, {
        url: targetUrl,
        browserSpace: getActiveSpaceId(),
        sessionId,
      });
      if (nextTabId && tabSpace) {
        tabSpace.activeTabId = nextTabId;
        if (getActiveSpaceId() === "agent" && sessionId) {
          setVisibleAgentBrowserSession(workspace, sessionId);
        }
        updateAttachedBrowserView();
        emitBrowserState(workspace.workspaceId, getActiveSpaceId());
        await persistWorkspace(workspace.workspaceId);
      }
      return browserWorkspaceSnapshot(
        workspace.workspaceId,
        getActiveSpaceId(),
        agentSessionForSpace(),
        { useVisibleAgentSession: true },
      );
    },
  );

  ipcMain.handle(
    "browser:setActiveTab",
    async (_event: IpcMainInvokeEvent, tabId: string) => {
      const interrupted = interruptOrSnapshot();
      if (interrupted) return interrupted;
      await ensureBrowserWorkspace(
        undefined,
        getActiveSpaceId(),
        agentSessionForSpace(),
      );
      return setActiveBrowserTab(tabId, {
        space: getActiveSpaceId(),
        sessionId: agentSessionForSpace(),
        useVisibleAgentSession: true,
      });
    },
  );

  ipcMain.handle(
    "browser:closeTab",
    async (_event: IpcMainInvokeEvent, tabId: string) => {
      const interrupted = interruptOrSnapshot();
      if (interrupted) return interrupted;
      await ensureBrowserWorkspace(
        undefined,
        getActiveSpaceId(),
        agentSessionForSpace(),
      );
      return closeBrowserTab(tabId, {
        space: getActiveSpaceId(),
        sessionId: agentSessionForSpace(),
        useVisibleAgentSession: true,
      });
    },
  );

  ipcMain.handle("browser:getBookmarks", async () => {
    const workspace = await ensureBrowserWorkspace();
    return workspace?.bookmarks ?? [];
  });

  ipcMain.handle(
    "browser:addBookmark",
    async (
      _event: IpcMainInvokeEvent,
      payload: { url: string; title?: string },
    ) => {
      const workspace = await ensureBrowserWorkspace();
      const url = payload.url.trim();
      if (!workspace || !url) return workspace?.bookmarks ?? [];
      const activeTab = getActiveBrowserTab(
        undefined,
        getActiveSpaceId(),
        agentSessionForSpace(),
        { useVisibleAgentSession: true },
      );
      const faviconUrl =
        activeTab?.state.url === url ? activeTab.state.faviconUrl : undefined;
      const existing = workspace.bookmarks.find(
        (bookmark) => bookmark.url === url,
      );
      if (existing) {
        const nextTitle = payload.title?.trim() || existing.title;
        const nextFaviconUrl = faviconUrl || existing.faviconUrl;
        if (
          nextTitle !== existing.title ||
          nextFaviconUrl !== existing.faviconUrl
        ) {
          workspace.bookmarks = workspace.bookmarks.map((bookmark) =>
            bookmark.id === existing.id
              ? { ...bookmark, title: nextTitle, faviconUrl: nextFaviconUrl }
              : bookmark,
          );
          emitBookmarksState(workspace.workspaceId);
          await persistWorkspace(workspace.workspaceId);
        }
        return workspace.bookmarks;
      }
      workspace.bookmarks = [
        {
          id: `bookmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          url,
          title: payload.title?.trim() || url,
          faviconUrl,
          createdAt: new Date().toISOString(),
        },
        ...workspace.bookmarks,
      ];
      emitBookmarksState(workspace.workspaceId);
      await persistWorkspace(workspace.workspaceId);
      return workspace.bookmarks;
    },
  );

  ipcMain.handle(
    "browser:removeBookmark",
    async (_event: IpcMainInvokeEvent, bookmarkId: string) => {
      const workspace = await ensureBrowserWorkspace();
      if (!workspace) return [];
      workspace.bookmarks = workspace.bookmarks.filter(
        (bookmark) => bookmark.id !== bookmarkId,
      );
      emitBookmarksState(workspace.workspaceId);
      await persistWorkspace(workspace.workspaceId);
      return workspace.bookmarks;
    },
  );

  ipcMain.handle("browser:getDownloads", async () => {
    const workspace = await ensureBrowserWorkspace();
    return workspace?.downloads ?? [];
  });

  ipcMain.handle("browser:getHistory", async () => {
    const workspace = await ensureBrowserWorkspace();
    return workspace?.history ?? [];
  });

  ipcMain.handle(
    "browser:showAddressSuggestions",
    (
      _event: IpcMainInvokeEvent,
      anchorBounds: BrowserAnchorBoundsPayload,
      suggestions: AddressSuggestionPayload[],
      selectedIndex: number,
    ) => {
      popups.showAddressSuggestionsPopup(anchorBounds, suggestions, selectedIndex);
    },
  );

  ipcMain.handle("browser:hideAddressSuggestions", () => {
    popups.hideAddressSuggestionsPopup();
  });

  ipcMain.handle(
    "browser:chooseAddressSuggestion",
    (_event: IpcMainInvokeEvent, index: number) => {
      popups.hideAddressSuggestionsPopup();
      getMainWindow()?.webContents.send("browser:addressSuggestionChosen", index);
    },
  );

  ipcMain.handle(
    "browser:toggleOverflowPopup",
    (_event: IpcMainInvokeEvent, anchorBounds: BrowserAnchorBoundsPayload) => {
      popups.toggleOverflowPopup(anchorBounds);
    },
  );

  ipcMain.handle("browser:overflowOpenHistory", () => {
    popups.hideOverflowPopup();
    const overflowAnchorBounds = popups.getOverflowAnchorBounds();
    if (overflowAnchorBounds) {
      popups.toggleHistoryPopup(overflowAnchorBounds);
      emitHistoryState();
    }
  });

  ipcMain.handle("browser:overflowOpenDownloads", () => {
    popups.hideOverflowPopup();
    const overflowAnchorBounds = popups.getOverflowAnchorBounds();
    if (overflowAnchorBounds) {
      popups.toggleDownloadsPopup(overflowAnchorBounds);
      emitDownloadsState();
    }
  });

  ipcMain.handle("browser:overflowImportChrome", async () => {
    popups.hideOverflowPopup();
    try {
      const summary = await importChromeProfileIntoWorkspace(
        getActiveWorkspaceId(),
      );
      if (!summary) return;
      const detailLines = [
        `Profile: ${summary.sourceProfileLabel}`,
        `Location: ${summary.sourceProfileDir}`,
        `Bookmarks imported: ${summary.importedBookmarks}`,
        `History entries imported: ${summary.importedHistoryEntries}`,
        `Cookies imported: ${summary.importedCookies}`,
      ];
      if (summary.skippedCookies > 0) {
        detailLines.push(`Cookies skipped: ${summary.skippedCookies}`);
      }
      if (summary.warnings.length > 0) {
        detailLines.push(
          "",
          "Warnings:",
          ...summary.warnings.map((warning) => `- ${warning}`),
        );
      }
      const mainWindow = getMainWindow();
      const ownerWindow =
        mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const messageBoxOptions = {
        type: summary.warnings.length > 0 ? "warning" : "info",
        title: "Chrome Import Complete",
        message: "Chrome data was imported into this workspace browser.",
        detail: detailLines.join("\n"),
      } as const;
      if (ownerWindow) {
        await dialog.showMessageBox(ownerWindow, messageBoxOptions);
      } else {
        await dialog.showMessageBox(messageBoxOptions);
      }
    } catch (error) {
      const mainWindow = getMainWindow();
      const ownerWindow =
        mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const messageBoxOptions = {
        type: "error",
        title: "Chrome Import Failed",
        message: "Could not import data from Chrome.",
        detail:
          error instanceof Error
            ? error.message
            : "The Chrome import did not complete.",
      } as const;
      if (ownerWindow) {
        await dialog.showMessageBox(ownerWindow, messageBoxOptions);
      } else {
        await dialog.showMessageBox(messageBoxOptions);
      }
    }
  });

  ipcMain.handle(
    "browser:toggleHistoryPopup",
    (_event: IpcMainInvokeEvent, anchorBounds: BrowserAnchorBoundsPayload) => {
      popups.toggleHistoryPopup(anchorBounds);
      emitHistoryState();
    },
  );

  ipcMain.handle("browser:closeHistoryPopup", () => {
    popups.hideHistoryPopup();
  });

  ipcMain.handle(
    "browser:openHistoryUrl",
    async (_event: IpcMainInvokeEvent, targetUrl: string) => {
      const interrupted = interruptOrSnapshot();
      if (interrupted) return interrupted;
      const workspace = await ensureBrowserWorkspace(
        undefined,
        getActiveSpaceId(),
        agentSessionForSpace(),
      );
      const activeTab = getActiveBrowserTab(
        undefined,
        getActiveSpaceId(),
        agentSessionForSpace(),
        { useVisibleAgentSession: true },
      );
      if (!workspace || !activeTab) {
        return browserWorkspaceSnapshot(
          undefined,
          getActiveSpaceId(),
          agentSessionForSpace(),
          { useVisibleAgentSession: true },
        );
      }
      try {
        popups.hideHistoryPopup();
        activeTab.state = { ...activeTab.state, error: "" };
        await activeTab.view.webContents.loadURL(targetUrl);
      } catch (error) {
        if (isAbortedBrowserLoadError(error)) {
          return browserWorkspaceSnapshot(
            workspace.workspaceId,
            getActiveSpaceId(),
            agentSessionForSpace(),
            { useVisibleAgentSession: true },
          );
        }
        activeTab.state = {
          ...activeTab.state,
          loading: false,
          error:
            error instanceof Error ? error.message : "Failed to load URL.",
        } as typeof activeTab.state;
        emitBrowserState(workspace.workspaceId, getActiveSpaceId());
      }
      return browserWorkspaceSnapshot(
        workspace.workspaceId,
        getActiveSpaceId(),
        agentSessionForSpace(),
        { useVisibleAgentSession: true },
      );
    },
  );

  ipcMain.handle(
    "browser:removeHistoryEntry",
    async (_event: IpcMainInvokeEvent, historyId: string) => {
      const workspace = await ensureBrowserWorkspace();
      if (!workspace) return [];
      workspace.history = workspace.history.filter(
        (entry) => entry.id !== historyId,
      );
      emitHistoryState(workspace.workspaceId);
      await persistWorkspace(workspace.workspaceId);
      return workspace.history;
    },
  );

  ipcMain.handle("browser:clearHistory", async () => {
    const workspace = await ensureBrowserWorkspace();
    if (!workspace) return [];
    workspace.history = [];
    emitHistoryState(workspace.workspaceId);
    await persistWorkspace(workspace.workspaceId);
    return workspace.history;
  });

  ipcMain.handle(
    "browser:toggleDownloadsPopup",
    (_event: IpcMainInvokeEvent, anchorBounds: BrowserAnchorBoundsPayload) => {
      popups.toggleDownloadsPopup(anchorBounds);
      emitDownloadsState();
    },
  );

  ipcMain.handle("browser:closeDownloadsPopup", () => {
    popups.hideDownloadsPopup();
  });

  ipcMain.handle(
    "browser:showDownloadInFolder",
    async (_event: IpcMainInvokeEvent, downloadId: string) => {
      const workspace = await ensureBrowserWorkspace();
      const download = workspace?.downloads.find(
        (item) => (item as { id?: string }).id === downloadId,
      );
      const targetPath = (download as { targetPath?: string } | undefined)
        ?.targetPath;
      if (!targetPath) return false;
      return shell.showItemInFolder(targetPath);
    },
  );

  ipcMain.handle(
    "browser:openDownload",
    async (_event: IpcMainInvokeEvent, downloadId: string) => {
      const workspace = await ensureBrowserWorkspace();
      const download = workspace?.downloads.find(
        (item) => (item as { id?: string }).id === downloadId,
      );
      const targetPath = (download as { targetPath?: string } | undefined)
        ?.targetPath;
      if (!targetPath) return "Download not found.";
      return shell.openPath(targetPath);
    },
  );
}
