/**
 * Browser-pane tab state (BP-TAB-STATE).
 *
 * The whole tab subsystem in one module: read+emit
 * (getActiveBrowserTab, currentBrowserTabPageTitle/Url, hasVisibleBounds,
 * applyBoundsToTab, updateAttachedBrowserView, emit{Browser,History}State,
 * syncBrowserState, captureVisibleSnapshot, setBounds, recordHistoryVisit,
 * browserPagePayload, closeBrowserTabRecord), lifecycle
 * (focusBrowserTabInSpace, setActiveBrowserTab, closeBrowserTab,
 * navigateActiveBrowserTab, handleBrowserWindowOpenAsTab,
 * showBrowserViewContextMenu, createBrowserTab, initialBrowserTabSeed,
 * ensureBrowserTabSpaceInitialized), and download-prompt helpers
 * (browserContextSuggestedFilename, queueBrowserDownloadPrompt,
 * consumeBrowserDownloadOverride).
 *
 * Pattern: factory `createBrowserPaneTabState(deps)` returns a closure-
 * bound object. Module-level state in main.ts (mainWindow,
 * attachedBrowserTabView, browserBounds, active workspace/space/session)
 * is reached through getter/setter deps so this module never imports
 * any mutable globals.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  BrowserWindow,
  BrowserView,
  Menu,
  clipboard,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from "electron";

import type {
  BrowserBoundsPayload,
  BrowserHistoryEntryPayload,
  BrowserSpaceId,
  BrowserVisibleSnapshotPayload,
} from "../../shared/browser-pane-protocol.js";

function isDisposedWebFrameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /render frame was disposed before webframemain could be accessed/i.test(
      error.message,
    )
  );
}

/** Structural opaque types — main's versions are richer; this module
 * only stores them on the workspace record without inspecting fields. */
export type BrowserBookmarkPayload = unknown;
export type BrowserDownloadPayload = unknown;

/**
 * Local BrowserStatePayload matching main.ts's stricter shape
 * (error: string, not error?: string | null from the shared protocol).
 * Both forms are wire-compatible — main is just stricter on the
 * server side.
 */
export interface BrowserStatePayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  initialized: boolean;
  error: string;
}

export interface BrowserTabCountsPayload {
  user: number;
  agent: number;
}

export interface BrowserTabListPayload {
  space: BrowserSpaceId;
  activeTabId: string;
  tabs: BrowserStatePayload[];
  tabCounts: BrowserTabCountsPayload;
  sessionId: string | null;
  lifecycleState: "active" | "suspended" | null;
  controlMode: "none" | "user_locked" | "session_owned";
  controlSessionId: string | null;
}

import {
  BROWSER_OBSERVABILITY_ENTRY_LIMIT,
  appendBoundedEntry,
  browserConsoleLevelValue,
  type BrowserConsoleEntry,
  type BrowserObservedError,
  type BrowserRequestRecord,
} from "./observability.js";

import {
  browserContextSuggestedFilename as browserContextSuggestedFilenameUtil,
  oppositeBrowserSpaceId,
} from "./utils.js";

const BACKGROUND_RENDER_HOST_WIDTH = 1280;
const BACKGROUND_RENDER_HOST_HEIGHT = 900;
const BACKGROUND_RENDER_VIEWPORT_POLL_ATTEMPTS = 10;
const BACKGROUND_RENDER_VIEWPORT_POLL_DELAY_MS = 50;
const BACKGROUND_RENDER_FRAME_TIMEOUT_MS = 1_000;
const BACKGROUND_INPUT_HOST_OPACITY = 0.01;
const SHARED_AGENT_INPUT_HOST_IDLE_MS = 30_000;

interface SharedAgentInputHostState {
  host: BrowserWindow | null;
  activeView: BrowserView | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface BrowserTabRecord {
  view: BrowserView;
  state: BrowserStatePayload;
  popupFrameName?: string;
  popupOpenedAtMs?: number;
  consoleEntries: BrowserConsoleEntry[];
  errorEntries: BrowserObservedError[];
  requests: Map<string, BrowserRequestRecord>;
  requestOrder: string[];
}

export interface BrowserPersistedTab {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

export interface BrowserTabSpaceState {
  tabs: Map<string, BrowserTabRecord>;
  activeTabId: string;
  persistedTabs: BrowserPersistedTab[];
  lifecycleState: "active" | "suspended" | null;
  lastTouchedAt: string;
  suspendTimer: ReturnType<typeof setTimeout> | null;
}

export interface BrowserSessionIdentity {
  userAgent: string;
  acceptLanguages: string;
}

export interface BrowserDownloadOverride {
  url: string;
  defaultPath: string;
  dialogTitle: string;
  buttonLabel: string;
}

export interface BrowserUserLockState {
  sessionId: string;
  acquiredAt: string;
  heartbeatAt: string;
  reason: string | null;
}

export interface BrowserWorkspaceState {
  workspaceId: string;
  history: BrowserHistoryEntryPayload[];
  session: import("electron").Session;
  browserIdentity: BrowserSessionIdentity;
  pendingDownloadOverrides: BrowserDownloadOverride[];
  userBrowserLock: BrowserUserLockState | null;
  activeAgentSessionId: string | null;
  bookmarks: BrowserBookmarkPayload[];
  downloads: BrowserDownloadPayload[];
}

export interface BrowserPaneTabStateDeps {
  getMainWindow: () => BrowserWindow | null;
  getActiveWorkspaceId: () => string;
  getActiveSpaceId: () => BrowserSpaceId;
  getActiveSessionId: () => string;
  getAttachedView: () => BrowserView | null;
  setAttachedView: (view: BrowserView | null) => void;
  getBrowserBounds: () => BrowserBoundsPayload;
  setBrowserBounds: (bounds: BrowserBoundsPayload) => void;
  getWorkspace: (workspaceId: string) => BrowserWorkspaceState | null;
  getWorkspaceOrEmpty: (
    workspaceId?: string | null,
  ) => BrowserWorkspaceState | null;
  persistWorkspace: (workspaceId: string) => Promise<void> | void;
  browserSpaceId: (value?: string | null) => BrowserSpaceId;
  browserSessionId: (value?: string | null) => string;
  browserTabSpaceState: (
    workspace: BrowserWorkspaceState | null | undefined,
    space: BrowserSpaceId,
    sessionId?: string | null,
    options?: { createIfMissing?: boolean; useVisibleAgentSession?: boolean },
  ) => BrowserTabSpaceState | null;
  browserTabSpaceTouch: (tabSpace: BrowserTabSpaceState) => void;
  browserWorkspaceSnapshot: (
    workspaceId?: string | null,
    space?: BrowserSpaceId | null,
    sessionId?: string | null,
    options?: { useVisibleAgentSession?: boolean },
  ) => BrowserTabListPayload;
  emptyBrowserTabListPayload: (space: BrowserSpaceId) => BrowserTabListPayload;
  browserVisibleAgentSessionId: (
    workspace: BrowserWorkspaceState | null | undefined,
  ) => string;
  createBrowserState: (state: Partial<BrowserStatePayload>) => BrowserStatePayload;
  scheduleAgentSessionBrowserLifecycleCheck: (
    workspaceId: string,
    sessionId?: string | null,
  ) => void;
  setVisibleAgentBrowserSession: (
    workspace: BrowserWorkspaceState,
    sessionId: string,
  ) => void;
  seedVisibleAgentBrowserSession: (
    workspace: BrowserWorkspaceState,
    sessionId: string,
  ) => void;
  shouldTrackHistoryUrl: (url: string) => boolean;
  hasOpenHistoryPopup: () => boolean;
  sendHistoryToPopup: (history: BrowserHistoryEntryPayload[]) => void;
  reserveMainWindowClosedListenerBudget: (
    additionalClosedListeners?: number,
  ) => void;
  homeUrl: string;
  newTabTitle: string;
  duplicateBrowserPopupTabWindowMs: number;
  shouldAllowBrowserPopupWindow: (
    url: string,
    frameName: string,
    features: string,
  ) => boolean;
  normalizeBrowserPopupFrameName: (frameName?: string | null) => string;
  isAbortedBrowserLoadError: (error: unknown) => boolean;
  isAbortedBrowserLoadFailure: (
    errorCode: number,
    errorDescription: string,
  ) => boolean;
  openExternalUrlFromMain: (url: string, reason: string) => void;
  appendBrowserObservedError: (
    tab: BrowserTabRecord,
    entry: BrowserObservedError,
  ) => void;
  isProgrammaticBrowserInput: (webContents: WebContents) => boolean;
  maybePromptBrowserInterrupt: (
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ) => boolean;
  sanitizeAttachmentName: (name: string) => string;
  resolveWorkspaceDir: (workspaceId: string) => string;
  preloadDir: string;
}

export interface BrowserPaneTabState {
  hasVisibleBounds: () => boolean;
  setBounds: (bounds: BrowserBoundsPayload) => void;
  captureVisibleSnapshot: () => Promise<BrowserVisibleSnapshotPayload | null>;
  closeBrowserTabRecord: (tab: BrowserTabRecord) => void;
  focusBrowserTabInSpace: (
    workspaceId: string,
    tabSpace: BrowserTabSpaceState,
    tabId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ) => void;
  setActiveBrowserTab: (
    tabId: string,
    options?: {
      workspaceId?: string | null;
      space?: BrowserSpaceId | null;
      sessionId?: string | null;
      useVisibleAgentSession?: boolean;
    },
  ) => Promise<BrowserTabListPayload>;
  closeBrowserTab: (
    tabId: string,
    options?: {
      workspaceId?: string | null;
      space?: BrowserSpaceId | null;
      sessionId?: string | null;
      useVisibleAgentSession?: boolean;
    },
  ) => Promise<BrowserTabListPayload>;
  navigateActiveBrowserTab: (
    workspaceId: string,
    targetUrl: string,
    space?: BrowserSpaceId,
    sessionId?: string | null,
  ) => Promise<BrowserTabListPayload>;
  handleBrowserWindowOpenAsTab: (
    workspaceId: string,
    targetUrl: string,
    disposition: string,
    frameName: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ) => void;
  showBrowserViewContextMenu: (params: {
    workspaceId: string;
    space: BrowserSpaceId;
    sessionId?: string | null;
    view: BrowserView;
    context: ContextMenuParams;
  }) => void;
  createBrowserTab: (
    workspaceId: string,
    options?: {
      browserSpace?: BrowserSpaceId;
      sessionId?: string | null;
      id?: string;
      url?: string;
      title?: string;
      faviconUrl?: string;
      popupFrameName?: string;
      popupOpenedAtMs?: number;
      skipInitialHistoryRecord?: boolean;
    },
  ) => string | null;
  initialBrowserTabSeed: (
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ) => {
    url: string;
    title?: string;
    faviconUrl?: string;
    skipInitialHistoryRecord: boolean;
  };
  ensureBrowserTabSpaceInitialized: (
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ) => boolean;
  queueBrowserDownloadPrompt: (
    workspaceId: string,
    targetUrl: string,
    options: { defaultFilename: string; dialogTitle: string; buttonLabel: string },
  ) => void;
  consumeBrowserDownloadOverride: (
    workspace: BrowserWorkspaceState,
    targetUrl: string,
  ) => BrowserDownloadOverride | null;
  browserContextSuggestedFilename: (context: ContextMenuParams) => string;
  getActiveBrowserTab: (
    workspaceId?: string | null,
    space?: BrowserSpaceId | null,
    sessionId?: string | null,
    options?: { useVisibleAgentSession?: boolean },
  ) => BrowserTabRecord | null;
  activeVisibleBrowserTarget: () => {
    workspaceId: string;
    space: BrowserSpaceId;
    sessionId: string | null;
  };
  currentBrowserTabPageTitle: (tab: BrowserTabRecord) => string;
  currentBrowserTabUrl: (tab: BrowserTabRecord) => string;
  applyBoundsToTab: (
    workspaceId: string,
    tabId: string,
    space?: BrowserSpaceId,
    sessionId?: string | null,
  ) => void;
  updateAttachedBrowserView: () => void;
  syncBrowserState: (
    workspaceId: string,
    tabId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ) => void;
  emitBrowserState: (
    workspaceId?: string | null,
    space?: BrowserSpaceId | null,
  ) => void;
  emitHistoryState: (workspaceId?: string | null) => void;
  recordHistoryVisit: (
    workspaceId: string,
    entry: Pick<BrowserHistoryEntryPayload, "url" | "title" | "faviconUrl">,
  ) => Promise<void>;
  browserPagePayload: (tab: BrowserTabRecord) => Record<string, unknown>;
  withTemporarilyRenderedBrowserTab: <T>(
    tab: BrowserTabRecord,
    callback: () => Promise<T>,
    options?: {
      requireFocusedWindow?: boolean;
      workspaceId?: string | null;
      waitForRenderedFrame?: boolean;
    },
  ) => Promise<T>;
}

export function createBrowserPaneTabState(
  deps: BrowserPaneTabStateDeps,
): BrowserPaneTabState {
  const sharedAgentInputHosts = new Map<string, SharedAgentInputHostState>();
  let focusedAgentInputQueue = Promise.resolve();

  function hasVisibleBounds(): boolean {
    const b = deps.getBrowserBounds();
    return b.width > 0 && b.height > 0;
  }

  function getActiveBrowserTab(
    workspaceId?: string | null,
    space?: BrowserSpaceId | null,
    sessionId?: string | null,
    options?: { useVisibleAgentSession?: boolean },
  ): BrowserTabRecord | null {
    const browserSpace = deps.browserSpaceId(space);
    const workspace = deps.getWorkspaceOrEmpty(workspaceId);
    const tabSpace = deps.browserTabSpaceState(
      workspace,
      browserSpace,
      sessionId,
      options,
    );
    if (!tabSpace || !tabSpace.activeTabId) {
      return null;
    }
    return tabSpace.tabs.get(tabSpace.activeTabId) ?? null;
  }

  function activeVisibleBrowserTarget(): {
    workspaceId: string;
    space: BrowserSpaceId;
    sessionId: string | null;
  } {
    const space = deps.getActiveSpaceId();
    return {
      workspaceId: deps.getActiveWorkspaceId(),
      space,
      sessionId: space === "agent" ? deps.getActiveSessionId() : null,
    };
  }

  function currentBrowserTabPageTitle(tab: BrowserTabRecord): string {
    return tab.view.webContents.getTitle() || tab.state.title || "";
  }

  function currentBrowserTabUrl(tab: BrowserTabRecord): string {
    return tab.view.webContents.getURL() || tab.state.url || "";
  }

  function applyBoundsToTab(
    workspaceId: string,
    tabId: string,
    space: BrowserSpaceId = deps.getActiveSpaceId(),
    sessionId?: string | null,
  ): void {
    const workspace = deps.getWorkspace(workspaceId);
    const tab = deps.browserTabSpaceState(workspace, space, sessionId, {
      useVisibleAgentSession: !deps.browserSessionId(sessionId),
    })?.tabs.get(tabId);
    if (!tab) {
      return;
    }
    tab.view.setBounds(deps.getBrowserBounds());
  }

  function updateAttachedBrowserView(): void {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    const activeTab = getActiveBrowserTab(
      deps.getActiveWorkspaceId(),
      deps.getActiveSpaceId(),
      null,
      { useVisibleAgentSession: true },
    );
    if (!activeTab || !hasVisibleBounds()) {
      if (deps.getAttachedView()) {
        win.setBrowserView(null);
        deps.setAttachedView(null);
      }
      return;
    }
    if (deps.getAttachedView() !== activeTab.view) {
      deps.reserveMainWindowClosedListenerBudget(1);
      win.setBrowserView(activeTab.view);
      deps.setAttachedView(activeTab.view);
    }
    const space = deps.getActiveSpaceId();
    applyBoundsToTab(
      deps.getActiveWorkspaceId(),
      activeTab.state.id,
      space,
      space === "agent" ? deps.getActiveSessionId() : null,
    );
  }

  function setBounds(bounds: BrowserBoundsPayload): void {
    deps.setBrowserBounds({
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    });
    const target = activeVisibleBrowserTarget();
    const activeTab = getActiveBrowserTab(
      target.workspaceId,
      target.space,
      target.sessionId,
      { useVisibleAgentSession: true },
    );
    if (!activeTab || !hasVisibleBounds()) {
      const win = deps.getMainWindow();
      win?.setBrowserView(null);
      deps.setAttachedView(null);
      return;
    }
    updateAttachedBrowserView();
  }

  function backgroundRenderHostBounds(): BrowserBoundsPayload {
    const bounds = deps.getBrowserBounds();
    return {
      x: 0,
      y: 0,
      width:
        bounds.width > 0 ? bounds.width : BACKGROUND_RENDER_HOST_WIDTH,
      height:
        bounds.height > 0 ? bounds.height : BACKGROUND_RENDER_HOST_HEIGHT,
    };
  }

  function invisibleInputHostWindowBounds(
    viewBounds: BrowserBoundsPayload,
  ): BrowserBoundsPayload {
    const mainWindow = deps.getMainWindow();
    const mainWindowBounds =
      mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
    return {
      x: mainWindowBounds ? Math.round(mainWindowBounds.x) : 0,
      y: mainWindowBounds ? Math.round(mainWindowBounds.y) : 0,
      width: viewBounds.width,
      height: viewBounds.height,
    };
  }

  function ensureSharedAgentInputHostState(
    workspaceId: string,
  ): SharedAgentInputHostState {
    const normalizedWorkspaceId = workspaceId.trim();
    const existing = sharedAgentInputHosts.get(normalizedWorkspaceId);
    if (existing) {
      return existing;
    }
    const created: SharedAgentInputHostState = {
      host: null,
      activeView: null,
      idleTimer: null,
    };
    sharedAgentInputHosts.set(normalizedWorkspaceId, created);
    return created;
  }

  function clearSharedAgentInputHostIdleTimer(
    hostState: SharedAgentInputHostState,
  ): void {
    if (!hostState.idleTimer) {
      return;
    }
    clearTimeout(hostState.idleTimer);
    hostState.idleTimer = null;
  }

  function destroySharedAgentInputHost(
    workspaceId: string,
    hostState?: SharedAgentInputHostState,
  ): void {
    const normalizedWorkspaceId = workspaceId.trim();
    const state =
      hostState ?? sharedAgentInputHosts.get(normalizedWorkspaceId) ?? null;
    if (!state) {
      return;
    }
    clearSharedAgentInputHostIdleTimer(state);
    state.activeView = null;
    const host = state.host;
    state.host = null;
    if (host && !host.isDestroyed()) {
      host.setBrowserView(null);
      host.destroy();
    }
    sharedAgentInputHosts.delete(normalizedWorkspaceId);
  }

  function scheduleSharedAgentInputHostDestroy(
    workspaceId: string,
    hostState: SharedAgentInputHostState,
  ): void {
    clearSharedAgentInputHostIdleTimer(hostState);
    hostState.idleTimer = setTimeout(() => {
      destroySharedAgentInputHost(workspaceId, hostState);
    }, SHARED_AGENT_INPUT_HOST_IDLE_MS);
  }

  function ensureSharedAgentInputHostWindow(
    workspaceId: string,
    viewBounds: BrowserBoundsPayload,
  ): SharedAgentInputHostState {
    const hostState = ensureSharedAgentInputHostState(workspaceId);
    clearSharedAgentInputHostIdleTimer(hostState);
    const windowBounds = invisibleInputHostWindowBounds(viewBounds);
    if (hostState.host && !hostState.host.isDestroyed()) {
      hostState.host.setBounds(windowBounds);
      return hostState;
    }

    const host = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      useContentSize: true,
      x: windowBounds.x,
      y: windowBounds.y,
      width: windowBounds.width,
      height: windowBounds.height,
      backgroundColor: "#00000000",
      transparent: true,
      opacity: BACKGROUND_INPUT_HOST_OPACITY,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      movable: false,
      webPreferences: {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    host.setIgnoreMouseEvents(true);
    host.on("closed", () => {
      if (hostState.host === host) {
        hostState.host = null;
        hostState.activeView = null;
        clearSharedAgentInputHostIdleTimer(hostState);
        sharedAgentInputHosts.delete(workspaceId.trim());
      }
    });
    hostState.host = host;
    hostState.activeView = null;
    return hostState;
  }

  async function waitForBrowserWindowFocus(host: BrowserWindow): Promise<void> {
    for (
      let attempt = 0;
      attempt < BACKGROUND_RENDER_VIEWPORT_POLL_ATTEMPTS;
      attempt += 1
    ) {
      if (host.isDestroyed() || host.isFocused()) {
        return;
      }
      if (attempt < BACKGROUND_RENDER_VIEWPORT_POLL_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, BACKGROUND_RENDER_VIEWPORT_POLL_DELAY_MS),
        );
      }
    }
  }

  async function waitForRenderedBrowserViewport(
    tab: BrowserTabRecord,
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt < BACKGROUND_RENDER_VIEWPORT_POLL_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const viewport = await tab.view.webContents.executeJavaScript(
          "({ width: window.innerWidth, height: window.innerHeight })",
          true,
        );
        if (
          viewport &&
          typeof viewport === "object" &&
          typeof (viewport as { width?: unknown }).width === "number" &&
          (viewport as { width: number }).width > 0 &&
          typeof (viewport as { height?: unknown }).height === "number" &&
          (viewport as { height: number }).height > 0
        ) {
          return;
        }
      } catch {
        // Ignore transient renderer timing failures and keep polling.
      }
      if (attempt < BACKGROUND_RENDER_VIEWPORT_POLL_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, BACKGROUND_RENDER_VIEWPORT_POLL_DELAY_MS),
        );
      }
    }
  }

  async function waitForRenderedBrowserFrame(
    tab: BrowserTabRecord,
  ): Promise<boolean> {
    await waitForRenderedBrowserViewport(tab);
    const webContents = tab.view.webContents;
    if (webContents.isDestroyed()) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let subscribed = false;
      const timeout = setTimeout(() => {
        finish(false);
      }, BACKGROUND_RENDER_FRAME_TIMEOUT_MS);

      const finish = (rendered: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (subscribed) {
          try {
            webContents.endFrameSubscription();
          } catch {
            // Ignore teardown errors while unwinding a temporary host.
          }
        }
        resolve(rendered);
      };

      try {
        webContents.beginFrameSubscription(() => {
          finish(true);
        });
        subscribed = true;
      } catch {
        finish(false);
        return;
      }

      try {
        webContents.invalidate();
      } catch {
        finish(false);
      }
    });
  }

  async function withBrowserTabHostedInWindow<T>(
    tab: BrowserTabRecord,
    callback: () => Promise<T>,
    host: BrowserWindow,
    bounds: BrowserBoundsPayload,
    options: {
      requireFocusedWindow?: boolean;
      waitForRenderedFrame?: boolean;
      destroyHostOnComplete?: boolean;
      sharedHostState?: SharedAgentInputHostState | null;
    } = {},
  ): Promise<T> {
    const attachedView = deps.getAttachedView();
    const mainWindow = deps.getMainWindow();
    const wasAttachedToMainWindow = attachedView === tab.view;

    if (
      wasAttachedToMainWindow &&
      mainWindow &&
      !mainWindow.isDestroyed()
    ) {
      mainWindow.setBrowserView(null);
      deps.setAttachedView(null);
    }

    if (options.sharedHostState?.activeView && options.sharedHostState.activeView !== tab.view) {
      host.setBrowserView(null);
      options.sharedHostState.activeView = null;
    }

    host.setBrowserView(tab.view);
    if (options.sharedHostState) {
      options.sharedHostState.activeView = tab.view;
    }
    tab.view.setBounds(bounds);

    if (options.requireFocusedWindow === true) {
      host.show();
      host.focus();
      await waitForBrowserWindowFocus(host);
      tab.view.webContents.focus();
    }

    await waitForRenderedBrowserViewport(tab);
    if (options.waitForRenderedFrame === true) {
      await waitForRenderedBrowserFrame(tab);
    }

    try {
      return await callback();
    } finally {
      if (options.sharedHostState?.activeView === tab.view) {
        options.sharedHostState.activeView = null;
      }
      if (!host.isDestroyed()) {
        host.setBrowserView(null);
        if (options.destroyHostOnComplete === true) {
          host.destroy();
        }
      }
      if (wasAttachedToMainWindow && hasVisibleBounds()) {
        updateAttachedBrowserView();
      }
    }
  }

  async function withQueuedAgentInputHost<T>(
    workspaceId: string,
    tab: BrowserTabRecord,
    callback: () => Promise<T>,
  ): Promise<T> {
    const previousQueue = focusedAgentInputQueue;
    let releaseQueue!: () => void;
    focusedAgentInputQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previousQueue.catch(() => undefined);

    let hostState: SharedAgentInputHostState | null = null;
    try {
      const bounds = backgroundRenderHostBounds();
      hostState = ensureSharedAgentInputHostWindow(workspaceId, bounds);
      const host = hostState.host;
      if (!host) {
        throw new Error("Shared agent browser input host could not be created.");
      }
      return await withBrowserTabHostedInWindow(tab, callback, host, bounds, {
        requireFocusedWindow: true,
        sharedHostState: hostState,
      });
    } finally {
      if (hostState) {
        scheduleSharedAgentInputHostDestroy(workspaceId, hostState);
      }
      releaseQueue();
    }
  }

  async function withTemporarilyRenderedBrowserTab<T>(
    tab: BrowserTabRecord,
    callback: () => Promise<T>,
    options: {
      requireFocusedWindow?: boolean;
      workspaceId?: string | null;
      waitForRenderedFrame?: boolean;
    } = {},
  ): Promise<T> {
    const attachedView = deps.getAttachedView();
    if (
      !options.requireFocusedWindow &&
      attachedView === tab.view &&
      hasVisibleBounds()
    ) {
      return callback();
    }

    const normalizedWorkspaceId =
      typeof options.workspaceId === "string" ? options.workspaceId.trim() : "";
    if (options.requireFocusedWindow && normalizedWorkspaceId) {
      return withQueuedAgentInputHost(normalizedWorkspaceId, tab, callback);
    }

    const bounds = backgroundRenderHostBounds();
    const host = new BrowserWindow({
      show: options.requireFocusedWindow === true,
      paintWhenInitiallyHidden: true,
      skipTaskbar: true,
      useContentSize: true,
      width: bounds.width,
      height: bounds.height,
      backgroundColor: "#050907",
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      movable: false,
      webPreferences: {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    return withBrowserTabHostedInWindow(tab, callback, host, bounds, {
      requireFocusedWindow: options.requireFocusedWindow,
      destroyHostOnComplete: true,
    });
  }

  async function captureVisibleSnapshot(): Promise<BrowserVisibleSnapshotPayload | null> {
    const target = activeVisibleBrowserTarget();
    const activeTab = getActiveBrowserTab(
      target.workspaceId,
      target.space,
      target.sessionId,
      { useVisibleAgentSession: true },
    );
    if (!activeTab || !hasVisibleBounds()) {
      return null;
    }
    const image = await activeTab.view.webContents.capturePage();
    return {
      bounds: { ...deps.getBrowserBounds() },
      dataUrl: `data:image/png;base64,${image.toPNG().toString("base64")}`,
    };
  }

  function emitBrowserState(
    workspaceId?: string | null,
    space?: BrowserSpaceId | null,
  ): void {
    const win = deps.getMainWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      return;
    }
    const activeId = deps.getActiveWorkspaceId();
    const normalized =
      typeof workspaceId === "string" ? workspaceId.trim() : activeId;
    const browserSpace = deps.browserSpaceId(space);
    if (normalized !== activeId || browserSpace !== deps.getActiveSpaceId()) {
      return;
    }
    try {
      win.webContents.send(
        "browser:state",
        deps.browserWorkspaceSnapshot(normalized, browserSpace, null, {
          useVisibleAgentSession: true,
        }),
      );
    } catch (error) {
      if (isDisposedWebFrameError(error)) {
        return;
      }
      throw error;
    }
  }

  function emitHistoryState(workspaceId?: string | null): void {
    const win = deps.getMainWindow();
    const activeId = deps.getActiveWorkspaceId();
    const normalized =
      typeof workspaceId === "string" ? workspaceId.trim() : activeId;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      if (!deps.hasOpenHistoryPopup()) {
        return;
      }
      return;
    }
    if (normalized !== activeId) {
      return;
    }
    const workspace = deps.getWorkspaceOrEmpty(normalized);
    const history = workspace?.history ?? [];
    try {
      win.webContents.send("browser:history", history);
    } catch (error) {
      if (!isDisposedWebFrameError(error)) {
        throw error;
      }
    }
    deps.sendHistoryToPopup(history);
  }

  function closeBrowserTabRecord(tab: BrowserTabRecord): void {
    for (const hostState of sharedAgentInputHosts.values()) {
      if (hostState.activeView !== tab.view || !hostState.host) {
        continue;
      }
      if (!hostState.host.isDestroyed()) {
        hostState.host.setBrowserView(null);
      }
      hostState.activeView = null;
    }
    tab.view.webContents.removeAllListeners();
    void (
      tab.view.webContents as unknown as { close?: () => void }
    ).close?.();
  }

  function syncBrowserState(
    workspaceId: string,
    tabId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ): void {
    const workspace = deps.getWorkspace(workspaceId);
    const tabSpace = deps.browserTabSpaceState(workspace, space, sessionId);
    const tab = tabSpace?.tabs.get(tabId);
    if (!workspace || !tab) {
      return;
    }
    if (tabSpace) {
      deps.browserTabSpaceTouch(tabSpace);
    }
    if (space === "agent" && deps.browserSessionId(sessionId)) {
      deps.scheduleAgentSessionBrowserLifecycleCheck(workspaceId, sessionId);
    }
    const viewContents = tab.view.webContents;
    if (viewContents.isDestroyed()) {
      return;
    }
    tab.state = {
      ...tab.state,
      url: viewContents.getURL() || tab.state.url,
      title: viewContents.getTitle() || tab.state.title,
      faviconUrl: tab.state.faviconUrl,
      canGoBack: viewContents.navigationHistory.canGoBack(),
      canGoForward: viewContents.navigationHistory.canGoForward(),
    };
    emitBrowserState(workspaceId, space);
    void deps.persistWorkspace(workspaceId);
  }

  async function recordHistoryVisit(
    workspaceId: string,
    entry: Pick<BrowserHistoryEntryPayload, "url" | "title" | "faviconUrl">,
  ): Promise<void> {
    const workspace = deps.getWorkspace(workspaceId);
    const url = entry.url.trim();
    if (!workspace || !deps.shouldTrackHistoryUrl(url)) {
      return;
    }
    const now = new Date().toISOString();
    const existing = workspace.history.find((item) => item.url === url);
    if (existing) {
      workspace.history = workspace.history
        .map((item) =>
          item.id === existing.id
            ? {
                ...item,
                title: entry.title?.trim() || item.title || url,
                faviconUrl: entry.faviconUrl || item.faviconUrl,
                visitCount: item.visitCount + 1,
                lastVisitedAt: now,
              }
            : item,
        )
        .sort(
          (a, b) =>
            new Date(b.lastVisitedAt).getTime() -
            new Date(a.lastVisitedAt).getTime(),
        );
    } else {
      workspace.history = [
        {
          id: `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          url,
          title: entry.title?.trim() || url,
          faviconUrl: entry.faviconUrl,
          visitCount: 1,
          createdAt: now,
          lastVisitedAt: now,
        },
        ...workspace.history,
      ]
        .sort(
          (a, b) =>
            new Date(b.lastVisitedAt).getTime() -
            new Date(a.lastVisitedAt).getTime(),
        )
        .slice(0, 500);
    }
    emitHistoryState(workspaceId);
    await deps.persistWorkspace(workspaceId);
  }

  function browserPagePayload(tab: BrowserTabRecord): Record<string, unknown> {
    const wc = tab.view.webContents;
    return {
      tabId: tab.state.id,
      url: wc.getURL() || tab.state.url,
      title: wc.getTitle() || tab.state.title,
      loading: tab.state.loading,
      initialized: tab.state.initialized,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      error: tab.state.error || "",
    };
  }

  function focusBrowserTabInSpace(
    workspaceId: string,
    tabSpace: BrowserTabSpaceState,
    tabId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ): void {
    tabSpace.activeTabId = tabId;
    deps.browserTabSpaceTouch(tabSpace);
    if (space === "agent" && deps.browserSessionId(sessionId)) {
      deps.scheduleAgentSessionBrowserLifecycleCheck(workspaceId, sessionId);
    }
    if (
      workspaceId === deps.getActiveWorkspaceId() &&
      space === deps.getActiveSpaceId()
    ) {
      updateAttachedBrowserView();
    }
    emitBrowserState(workspaceId, space);
    void deps.persistWorkspace(workspaceId);
  }

  async function setActiveBrowserTab(
    tabId: string,
    options: {
      workspaceId?: string | null;
      space?: BrowserSpaceId | null;
      sessionId?: string | null;
      useVisibleAgentSession?: boolean;
    } = {},
  ): Promise<BrowserTabListPayload> {
    const browserSpace = deps.browserSpaceId(options.space);
    const normalizedSessionId =
      browserSpace === "agent" ? deps.browserSessionId(options.sessionId) : "";
    const useVisibleAgentSession =
      browserSpace === "agent"
        ? options.useVisibleAgentSession ?? !normalizedSessionId
        : false;
    const workspace = deps.getWorkspaceOrEmpty(options.workspaceId);
    const tabSpace = deps.browserTabSpaceState(
      workspace,
      browserSpace,
      normalizedSessionId,
      { useVisibleAgentSession },
    );
    if (!workspace || !tabSpace || !tabSpace.tabs.has(tabId)) {
      return deps.browserWorkspaceSnapshot(
        workspace?.workspaceId ?? options.workspaceId,
        browserSpace,
        normalizedSessionId,
        { useVisibleAgentSession },
      );
    }
    tabSpace.activeTabId = tabId;
    deps.browserTabSpaceTouch(tabSpace);
    if (browserSpace === "agent" && normalizedSessionId) {
      deps.setVisibleAgentBrowserSession(workspace, normalizedSessionId);
      deps.scheduleAgentSessionBrowserLifecycleCheck(
        workspace.workspaceId,
        normalizedSessionId,
      );
    } else if (browserSpace === "agent" && useVisibleAgentSession) {
      const visibleSessionId = deps.browserVisibleAgentSessionId(workspace);
      if (visibleSessionId) {
        deps.scheduleAgentSessionBrowserLifecycleCheck(
          workspace.workspaceId,
          visibleSessionId,
        );
      }
    }
    if (
      workspace.workspaceId === deps.getActiveWorkspaceId() &&
      browserSpace === deps.getActiveSpaceId()
    ) {
      updateAttachedBrowserView();
    }
    emitBrowserState(workspace.workspaceId, browserSpace);
    await deps.persistWorkspace(workspace.workspaceId);
    return deps.browserWorkspaceSnapshot(
      workspace.workspaceId,
      browserSpace,
      normalizedSessionId,
      { useVisibleAgentSession },
    );
  }

  async function closeBrowserTab(
    tabId: string,
    options: {
      workspaceId?: string | null;
      space?: BrowserSpaceId | null;
      sessionId?: string | null;
      useVisibleAgentSession?: boolean;
    } = {},
  ): Promise<BrowserTabListPayload> {
    const browserSpace = deps.browserSpaceId(options.space);
    const normalizedSessionId =
      browserSpace === "agent" ? deps.browserSessionId(options.sessionId) : "";
    const useVisibleAgentSession =
      browserSpace === "agent"
        ? options.useVisibleAgentSession ?? !normalizedSessionId
        : false;
    const workspace = deps.getWorkspaceOrEmpty(options.workspaceId);
    const tabSpace = deps.browserTabSpaceState(
      workspace,
      browserSpace,
      normalizedSessionId,
      { useVisibleAgentSession },
    );
    const tab = tabSpace?.tabs.get(tabId);
    if (!workspace || !tabSpace || !tab) {
      return deps.browserWorkspaceSnapshot(
        workspace?.workspaceId ?? options.workspaceId,
        browserSpace,
        normalizedSessionId,
        { useVisibleAgentSession },
      );
    }
    const resolvedSessionId =
      browserSpace === "agent" &&
      !normalizedSessionId &&
      useVisibleAgentSession
        ? deps.browserVisibleAgentSessionId(workspace)
        : normalizedSessionId;
    const tabIds = Array.from(tabSpace.tabs.keys());
    const closedIndex = tabIds.indexOf(tabId);
    tabSpace.tabs.delete(tabId);
    closeBrowserTabRecord(tab);
    deps.browserTabSpaceTouch(tabSpace);
    if (tabSpace.tabs.size === 0) {
      const replacementTabId = createBrowserTab(workspace.workspaceId, {
        url: deps.homeUrl,
        browserSpace,
        sessionId: resolvedSessionId,
      });
      tabSpace.activeTabId = replacementTabId ?? "";
    } else if (tabSpace.activeTabId === tabId) {
      const remainingIds = Array.from(tabSpace.tabs.keys());
      tabSpace.activeTabId =
        remainingIds[Math.max(0, closedIndex - 1)] ?? remainingIds[0] ?? "";
    }
    if (
      workspace.workspaceId === deps.getActiveWorkspaceId() &&
      browserSpace === deps.getActiveSpaceId()
    ) {
      updateAttachedBrowserView();
    }
    if (browserSpace === "agent" && normalizedSessionId) {
      deps.scheduleAgentSessionBrowserLifecycleCheck(
        workspace.workspaceId,
        normalizedSessionId,
      );
    } else if (browserSpace === "agent" && useVisibleAgentSession) {
      const visibleSessionId = deps.browserVisibleAgentSessionId(workspace);
      if (visibleSessionId) {
        deps.scheduleAgentSessionBrowserLifecycleCheck(
          workspace.workspaceId,
          visibleSessionId,
        );
      }
    }
    emitBrowserState(workspace.workspaceId, browserSpace);
    await deps.persistWorkspace(workspace.workspaceId);
    return deps.browserWorkspaceSnapshot(
      workspace.workspaceId,
      browserSpace,
      normalizedSessionId,
      { useVisibleAgentSession },
    );
  }

  async function navigateActiveBrowserTab(
    workspaceId: string,
    targetUrl: string,
    space: BrowserSpaceId = deps.getActiveSpaceId(),
    sessionId?: string | null,
  ): Promise<BrowserTabListPayload> {
    const normalizedSessionId =
      space === "agent" ? deps.browserSessionId(sessionId) : "";
    const useVisibleAgentSession = space === "agent" && !normalizedSessionId;
    const activeTab = getActiveBrowserTab(workspaceId, space, normalizedSessionId, {
      useVisibleAgentSession,
    });
    if (!activeTab) {
      throw new Error("No active browser tab is available.");
    }
    try {
      activeTab.state = { ...activeTab.state, error: "" };
      await activeTab.view.webContents.loadURL(targetUrl);
    } catch (error) {
      if (deps.isAbortedBrowserLoadError(error)) {
        return deps.browserWorkspaceSnapshot(
          workspaceId,
          space,
          normalizedSessionId,
          { useVisibleAgentSession },
        );
      }
      activeTab.state = {
        ...activeTab.state,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load URL.",
      };
      emitBrowserState(workspaceId, space);
      throw error;
    }
    return deps.browserWorkspaceSnapshot(
      workspaceId,
      space,
      normalizedSessionId,
      { useVisibleAgentSession },
    );
  }

  function handleBrowserWindowOpenAsTab(
    workspaceId: string,
    targetUrl: string,
    disposition: string,
    frameName: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ): void {
    const normalizedUrl = targetUrl.trim();
    if (!normalizedUrl) {
      return;
    }
    try {
      const parsed = new URL(normalizedUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        deps.openExternalUrlFromMain(normalizedUrl, "browser tab creation");
        return;
      }
    } catch {
      return;
    }
    const workspace = deps.getWorkspace(workspaceId);
    const tabSpace = deps.browserTabSpaceState(workspace, space, sessionId, {
      createIfMissing: true,
    });
    if (!workspace || !tabSpace) {
      return;
    }
    const normalizedFrameName = deps.normalizeBrowserPopupFrameName(frameName);
    const now = Date.now();
    const existingPopupTab = Array.from(tabSpace.tabs.entries()).find(
      ([, tab]) =>
        (normalizedFrameName && tab.popupFrameName === normalizedFrameName) ||
        (!normalizedFrameName &&
          tab.state.url === normalizedUrl &&
          typeof tab.popupOpenedAtMs === "number" &&
          now - tab.popupOpenedAtMs <= deps.duplicateBrowserPopupTabWindowMs),
    );
    if (existingPopupTab) {
      const [existingTabId, existingTab] = existingPopupTab;
      existingTab.popupFrameName =
        normalizedFrameName || existingTab.popupFrameName;
      existingTab.popupOpenedAtMs = now;
      if (existingTab.state.url !== normalizedUrl) {
        existingTab.state = { ...existingTab.state, error: "" };
        void existingTab.view.webContents
          .loadURL(normalizedUrl)
          .catch((error: unknown) => {
            if (deps.isAbortedBrowserLoadError(error)) {
              return;
            }
            existingTab.state = {
              ...existingTab.state,
              loading: false,
              error:
                error instanceof Error ? error.message : "Failed to load URL.",
            };
            emitBrowserState(workspaceId, space);
            void deps.persistWorkspace(workspaceId);
          });
      }
      if (disposition !== "background-tab") {
        focusBrowserTabInSpace(
          workspaceId,
          tabSpace,
          existingTabId,
          space,
          sessionId,
        );
      }
      return;
    }
    const nextTabId = createBrowserTab(workspaceId, {
      url: normalizedUrl,
      browserSpace: space,
      sessionId,
      popupFrameName: normalizedFrameName,
      popupOpenedAtMs: now,
    });
    if (!nextTabId) {
      return;
    }
    if (disposition !== "background-tab") {
      focusBrowserTabInSpace(workspaceId, tabSpace, nextTabId, space, sessionId);
      return;
    }
    emitBrowserState(workspaceId, space);
    void deps.persistWorkspace(workspaceId);
  }

  function browserContextSuggestedFilename(
    context: ContextMenuParams,
  ): string {
    return browserContextSuggestedFilenameUtil(
      context,
      deps.sanitizeAttachmentName,
    );
  }

  function queueBrowserDownloadPrompt(
    workspaceId: string,
    targetUrl: string,
    options: {
      defaultFilename: string;
      dialogTitle: string;
      buttonLabel: string;
    },
  ): void {
    const workspace = deps.getWorkspace(workspaceId);
    if (!workspace) {
      return;
    }
    workspace.pendingDownloadOverrides.push({
      url: targetUrl.trim(),
      defaultPath: path.join(
        deps.resolveWorkspaceDir(workspaceId),
        "Downloads",
        deps.sanitizeAttachmentName(options.defaultFilename),
      ),
      dialogTitle: options.dialogTitle,
      buttonLabel: options.buttonLabel,
    });
  }

  function consumeBrowserDownloadOverride(
    workspace: BrowserWorkspaceState,
    targetUrl: string,
  ): BrowserDownloadOverride | null {
    const normalizedTargetUrl = targetUrl.trim();
    const overrideIndex = workspace.pendingDownloadOverrides.findIndex(
      (override) => override.url === normalizedTargetUrl,
    );
    if (overrideIndex < 0) {
      return null;
    }
    const [override] = workspace.pendingDownloadOverrides.splice(
      overrideIndex,
      1,
    );
    return override ?? null;
  }

  function browserTabSpaceStates(
    tabSpace: BrowserTabSpaceState | null | undefined,
  ): BrowserStatePayload[] {
    if (!tabSpace) {
      return [];
    }
    if (tabSpace.tabs.size > 0 || tabSpace.lifecycleState === "active") {
      return Array.from(tabSpace.tabs.values(), ({ state }) => state);
    }
    return tabSpace.persistedTabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      faviconUrl: tab.faviconUrl,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      initialized: true,
      error: "",
    }));
  }

  function initialBrowserTabSeed(
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ): {
    url: string;
    title?: string;
    faviconUrl?: string;
    skipInitialHistoryRecord: boolean;
  } {
    const workspace = deps.getWorkspace(workspaceId);
    const sourceSpaceId = oppositeBrowserSpaceId(space);
    const sourceSessionId =
      sourceSpaceId === "agent" ? deps.browserSessionId(sessionId) : "";
    const sourceSpace = deps.browserTabSpaceState(
      workspace,
      sourceSpaceId,
      sourceSessionId,
      {
        useVisibleAgentSession: sourceSpaceId === "agent" && !sourceSessionId,
      },
    );
    const sourceTab =
      (sourceSpace?.activeTabId
        ? sourceSpace.tabs.get(sourceSpace.activeTabId)
        : null) ??
      (sourceSpace ? Array.from(sourceSpace.tabs.values())[0] ?? null : null);
    const sourceState =
      sourceTab?.state ??
      (sourceSpace?.activeTabId
        ? browserTabSpaceStates(sourceSpace).find(
            (state) => state.id === sourceSpace.activeTabId,
          ) ?? null
        : browserTabSpaceStates(sourceSpace)[0] ?? null);
    if (!sourceState) {
      return {
        url: deps.homeUrl,
        title: deps.newTabTitle,
        skipInitialHistoryRecord: false,
      };
    }
    return {
      url:
        sourceTab?.view.webContents.getURL() ||
        sourceState.url ||
        deps.homeUrl,
      title:
        sourceTab?.view.webContents.getTitle() ||
        sourceState.title ||
        deps.newTabTitle,
      faviconUrl: sourceState.faviconUrl,
      skipInitialHistoryRecord: true,
    };
  }

  function ensureBrowserTabSpaceInitialized(
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ): boolean {
    const workspace = deps.getWorkspace(workspaceId);
    const normalizedSessionId = deps.browserSessionId(sessionId);
    const tabSpace = deps.browserTabSpaceState(
      workspace,
      space,
      normalizedSessionId,
      {
        createIfMissing: Boolean(normalizedSessionId),
        useVisibleAgentSession: !normalizedSessionId,
      },
    );
    if (
      !workspace ||
      !tabSpace ||
      tabSpace.tabs.size > 0 ||
      tabSpace.persistedTabs.length > 0
    ) {
      return false;
    }
    const seed = initialBrowserTabSeed(workspaceId, space, normalizedSessionId);
    const initialTabId = createBrowserTab(workspaceId, {
      ...seed,
      browserSpace: space,
      sessionId: normalizedSessionId,
    });
    tabSpace.activeTabId = initialTabId ?? "";
    if (space === "agent" && normalizedSessionId) {
      deps.seedVisibleAgentBrowserSession(workspace, normalizedSessionId);
    }
    return true;
  }

  function showBrowserViewContextMenu(params: {
    workspaceId: string;
    space: BrowserSpaceId;
    sessionId?: string | null;
    view: BrowserView;
    context: ContextMenuParams;
  }): void {
    const { workspaceId, space, sessionId, view, context } = params;
    const template: MenuItemConstructorOptions[] = [];
    const selectionText = context.selectionText.trim();
    const linkUrl = context.linkURL.trim();
    const canGoBack = view.webContents.navigationHistory.canGoBack();
    const canGoForward = view.webContents.navigationHistory.canGoForward();
    const browserBounds = deps.getBrowserBounds();
    const popupX = browserBounds.x + context.x;
    const popupY = browserBounds.y + context.y;
    const imageUrl = context.srcURL.trim();

    if (linkUrl) {
      template.push(
        {
          label: "Open Link in New Tab",
          click: () =>
            handleBrowserWindowOpenAsTab(
              workspaceId,
              linkUrl,
              "foreground-tab",
              "",
              space,
              sessionId,
            ),
        },
        {
          label: "Open Link Externally",
          click: () => {
            deps.openExternalUrlFromMain(linkUrl, "browser context menu");
          },
        },
        {
          label: "Copy Link Address",
          click: () => {
            clipboard.writeText(linkUrl);
          },
        },
        { type: "separator" },
      );
    }

    if (context.mediaType === "image" && imageUrl) {
      template.push(
        {
          label: "Open Image in New Tab",
          click: () =>
            handleBrowserWindowOpenAsTab(
              workspaceId,
              imageUrl,
              "foreground-tab",
              "",
              space,
              sessionId,
            ),
        },
        {
          label: "Copy Image Address",
          click: () => {
            clipboard.writeText(imageUrl);
          },
        },
        {
          label: "Save Image As...",
          click: () => {
            queueBrowserDownloadPrompt(workspaceId, imageUrl, {
              defaultFilename: browserContextSuggestedFilename(context),
              dialogTitle: "Save Image As",
              buttonLabel: "Save Image",
            });
            void view.webContents.downloadURL(imageUrl);
          },
        },
        { type: "separator" },
      );
    }

    if (context.isEditable) {
      template.push(
        { label: "Undo", role: "undo", enabled: context.editFlags.canUndo },
        { label: "Redo", role: "redo", enabled: context.editFlags.canRedo },
        { type: "separator" },
        { label: "Cut", role: "cut", enabled: context.editFlags.canCut },
        { label: "Copy", role: "copy", enabled: context.editFlags.canCopy },
        { label: "Paste", role: "paste", enabled: context.editFlags.canPaste },
        {
          label: "Select All",
          role: "selectAll",
          enabled: context.editFlags.canSelectAll,
        },
      );
    } else if (selectionText) {
      template.push(
        { label: "Copy", role: "copy", enabled: context.editFlags.canCopy },
        {
          label: "Select All",
          role: "selectAll",
          enabled: context.editFlags.canSelectAll,
        },
      );
    } else {
      template.push(
        {
          label: "Back",
          enabled: canGoBack,
          click: () => view.webContents.navigationHistory.goBack(),
        },
        {
          label: "Forward",
          enabled: canGoForward,
          click: () => view.webContents.navigationHistory.goForward(),
        },
        {
          label: "Reload",
          click: () => view.webContents.reload(),
        },
        {
          label: "Select All",
          role: "selectAll",
          enabled: context.editFlags.canSelectAll,
        },
      );
    }

    if (template.length === 0) {
      return;
    }

    Menu.buildFromTemplate(template).popup({
      window: deps.getMainWindow() ?? undefined,
      frame: context.frame ?? undefined,
      x: popupX,
      y: popupY,
      sourceType: context.menuSourceType,
    });
  }

  function createBrowserTab(
    workspaceId: string,
    options: {
      browserSpace?: BrowserSpaceId;
      sessionId?: string | null;
      id?: string;
      url?: string;
      title?: string;
      faviconUrl?: string;
      popupFrameName?: string;
      popupOpenedAtMs?: number;
      skipInitialHistoryRecord?: boolean;
    } = {},
  ): string | null {
    const win = deps.getMainWindow();
    const workspace = deps.getWorkspace(workspaceId);
    const browserSpace = deps.browserSpaceId(options.browserSpace);
    const normalizedSessionId = deps.browserSessionId(options.sessionId);
    const tabSpace = deps.browserTabSpaceState(
      workspace,
      browserSpace,
      normalizedSessionId,
      { createIfMissing: Boolean(normalizedSessionId) },
    );
    if (!win || !workspace || !tabSpace) {
      return null;
    }
    tabSpace.lifecycleState = "active";
    deps.browserTabSpaceTouch(tabSpace);

    const tabId =
      options.id?.trim() ||
      `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const initialUrl = options.url?.trim() || "";
    const hasInitialUrl = initialUrl.length > 0;
    let suppressNextHistoryEntry = Boolean(options.skipInitialHistoryRecord);
    const view = new BrowserView({
      webPreferences: {
        session: workspace.session,
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    view.webContents.setUserAgent(workspace.browserIdentity.userAgent);
    const state = deps.createBrowserState({
      id: tabId,
      url: initialUrl,
      title: options.title || deps.newTabTitle,
      faviconUrl: options.faviconUrl,
      initialized: !hasInitialUrl,
    });
    tabSpace.tabs.set(tabId, {
      view,
      state,
      popupFrameName: options.popupFrameName?.trim() || undefined,
      popupOpenedAtMs:
        typeof options.popupOpenedAtMs === "number"
          ? options.popupOpenedAtMs
          : undefined,
      consoleEntries: [],
      errorEntries: [],
      requests: new Map<string, BrowserRequestRecord>(),
      requestOrder: [],
    });

    view.setBounds(deps.getBrowserBounds());
    view.setAutoResize({
      width: false,
      height: false,
      horizontal: false,
      vertical: false,
    });
    view.webContents.setWindowOpenHandler(
      ({ url, disposition, frameName, features }) => {
        const normalizedUrl = url.trim();
        if (!normalizedUrl) {
          return { action: "deny" };
        }
        if (deps.shouldAllowBrowserPopupWindow(normalizedUrl, frameName, features)) {
          // OAuth popups (Google sign-in, etc.) must NOT be fullscreenable.
          // On macOS, a fullscreen-capable child of a fullscreen parent will
          // open into the parent's fullscreen space with its chrome hidden,
          // leaving the user no way to close the popup without exiting the
          // parent's fullscreen entirely. Once that happens, the parent often
          // can't re-enter fullscreen until the popup is fully torn down.
          const mainWindow = deps.getMainWindow();
          const parentIsFullscreen =
            process.platform === "darwin" &&
            Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen());
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              parent: parentIsFullscreen ? undefined : (mainWindow ?? undefined),
              autoHideMenuBar: true,
              backgroundColor: "#050907",
              width: 520,
              height: 760,
              minWidth: 420,
              minHeight: 620,
              fullscreenable: false,
              webPreferences: {
                session: workspace.session,
                preload: path.join(deps.preloadDir, "browserPopupPreload.cjs"),
              },
            },
          };
        }
        try {
          const parsed = new URL(normalizedUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            deps.openExternalUrlFromMain(normalizedUrl, "browser window open");
            return { action: "deny" };
          }
        } catch {
          return { action: "deny" };
        }
        const shouldOpenAsTab =
          disposition === "foreground-tab" ||
          disposition === "background-tab" ||
          disposition === "new-window";
        if (shouldOpenAsTab) {
          handleBrowserWindowOpenAsTab(
            workspaceId,
            normalizedUrl,
            disposition,
            frameName,
            browserSpace,
            normalizedSessionId,
          );
        }
        return { action: "deny" };
      },
    );
    view.webContents.setZoomFactor(1);
    view.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);

    const currentTabRecord = () =>
      deps
        .browserTabSpaceState(
          deps.getWorkspace(workspaceId),
          browserSpace,
          normalizedSessionId,
        )
        ?.tabs.get(tabId);

    view.webContents.on(
      "console-message",
      ({ level, message, lineNumber, sourceId, frame }) => {
        const currentTab = currentTabRecord();
        if (!currentTab) {
          return;
        }
        const consoleLevel = browserConsoleLevelValue(level);
        const entry: BrowserConsoleEntry = {
          id: randomUUID(),
          level: consoleLevel,
          message:
            typeof message === "string" ? message : String(message ?? ""),
          sourceId: typeof sourceId === "string" ? sourceId : "",
          lineNumber:
            typeof lineNumber === "number" && Number.isFinite(lineNumber)
              ? Math.floor(lineNumber)
              : null,
          timestamp: new Date().toISOString(),
          frameUrl: frame && typeof frame.url === "string" ? frame.url : "",
        };
        appendBoundedEntry(
          currentTab.consoleEntries,
          entry,
          BROWSER_OBSERVABILITY_ENTRY_LIMIT,
        );
        if (consoleLevel === "warning" || consoleLevel === "error") {
          deps.appendBrowserObservedError(currentTab, {
            id: `runtime-console-${entry.id}`,
            source: "runtime",
            kind: "console_message",
            level: consoleLevel,
            message: entry.message,
            timestamp: entry.timestamp,
            url: currentBrowserTabUrl(currentTab),
            ...(entry.lineNumber !== null
              ? { lineNumber: entry.lineNumber }
              : {}),
            ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
          });
        }
      },
    );

    view.webContents.on("before-input-event", (event, input) => {
      if (deps.isProgrammaticBrowserInput(view.webContents)) {
        return;
      }
      if (
        (input.type === "keyDown" ||
          input.type === "keyUp" ||
          input.type === "char" ||
          input.type === "rawKeyDown") &&
        deps.maybePromptBrowserInterrupt(
          workspaceId,
          browserSpace,
          normalizedSessionId,
        )
      ) {
        event.preventDefault();
      }
    });

    view.webContents.on("before-mouse-event", (event, mouse) => {
      if (deps.isProgrammaticBrowserInput(view.webContents)) {
        return;
      }
      if (
        mouse.type !== "mouseMove" &&
        mouse.type !== "mouseEnter" &&
        mouse.type !== "mouseLeave" &&
        deps.maybePromptBrowserInterrupt(
          workspaceId,
          browserSpace,
          normalizedSessionId,
        )
      ) {
        event.preventDefault();
      }
    });

    view.webContents.on("dom-ready", () => {
      const currentTab = currentTabRecord();
      if (!currentTab) {
        return;
      }
      currentTab.state = { ...currentTab.state, initialized: true, error: "" };
      syncBrowserState(workspaceId, tabId, browserSpace, normalizedSessionId);
    });

    view.webContents.on("did-start-loading", () => {
      const currentTab = currentTabRecord();
      if (!currentTab) {
        return;
      }
      currentTab.state = { ...currentTab.state, loading: true, error: "" };
      syncBrowserState(workspaceId, tabId, browserSpace, normalizedSessionId);
    });

    view.webContents.on("did-stop-loading", () => {
      const currentTab = currentTabRecord();
      if (!currentTab) {
        return;
      }
      currentTab.state = { ...currentTab.state, loading: false, error: "" };
      syncBrowserState(workspaceId, tabId, browserSpace, normalizedSessionId);
      if (suppressNextHistoryEntry) {
        suppressNextHistoryEntry = false;
        return;
      }
      void recordHistoryVisit(workspaceId, {
        url: currentTab.view.webContents.getURL() || currentTab.state.url,
        title: currentTab.view.webContents.getTitle() || currentTab.state.title,
        faviconUrl: currentTab.state.faviconUrl,
      });
    });

    view.webContents.on("page-title-updated", () => {
      syncBrowserState(workspaceId, tabId, browserSpace, normalizedSessionId);
    });

    view.webContents.on("page-favicon-updated", (_event, favicons) => {
      const currentTab = currentTabRecord();
      if (!currentTab) {
        return;
      }
      currentTab.state = {
        ...currentTab.state,
        faviconUrl: favicons[0] || currentTab.state.faviconUrl,
      };
      emitBrowserState(workspaceId, browserSpace);
      void deps.persistWorkspace(workspaceId);
    });

    view.webContents.on("did-navigate", () => {
      syncBrowserState(workspaceId, tabId, browserSpace, normalizedSessionId);
    });

    view.webContents.on("did-navigate-in-page", () => {
      syncBrowserState(workspaceId, tabId, browserSpace, normalizedSessionId);
    });

    view.webContents.on("context-menu", (_event, params) => {
      showBrowserViewContextMenu({
        workspaceId,
        space: browserSpace,
        sessionId: normalizedSessionId,
        view,
        context: params,
      });
    });

    view.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (
          !isMainFrame ||
          deps.isAbortedBrowserLoadFailure(errorCode, errorDescription)
        ) {
          return;
        }
        const currentTab = currentTabRecord();
        if (!currentTab) {
          return;
        }
        currentTab.state = {
          ...currentTab.state,
          loading: false,
          error: `${errorDescription} (${errorCode})`,
          url: validatedURL || currentTab.state.url,
        };
        deps.appendBrowserObservedError(currentTab, {
          id: `page-load-${randomUUID()}`,
          source: "page",
          kind: "load_failed",
          level: "error",
          message: errorDescription || "Page load failed.",
          timestamp: new Date().toISOString(),
          url:
            validatedURL ||
            currentTab.state.url ||
            currentBrowserTabUrl(currentTab),
          errorCode,
        });
        emitBrowserState(workspaceId, browserSpace);
        void deps.persistWorkspace(workspaceId);
      },
    );

    view.webContents.on("render-process-gone", (_event, details) => {
      const currentTab = currentTabRecord();
      if (!currentTab) {
        return;
      }
      const reason =
        typeof details.reason === "string" ? details.reason : "gone";
      const exitCode =
        typeof details.exitCode === "number" &&
        Number.isFinite(details.exitCode)
          ? details.exitCode
          : null;
      const message =
        exitCode !== null
          ? `Browser render process exited: ${reason} (${exitCode})`
          : `Browser render process exited: ${reason}`;
      currentTab.state = {
        ...currentTab.state,
        loading: false,
        error: message,
      };
      deps.appendBrowserObservedError(currentTab, {
        id: `runtime-render-${randomUUID()}`,
        source: "runtime",
        kind: "render_process_gone",
        level: "error",
        message,
        timestamp: new Date().toISOString(),
        url: currentBrowserTabUrl(currentTab),
      });
      emitBrowserState(workspaceId, browserSpace);
      void deps.persistWorkspace(workspaceId);
    });

    if (hasInitialUrl) {
      void view.webContents.loadURL(initialUrl).catch((error: unknown) => {
        if (deps.isAbortedBrowserLoadError(error)) {
          return;
        }
        const currentTab = currentTabRecord();
        if (!currentTab) {
          return;
        }
        currentTab.state = {
          ...currentTab.state,
          loading: false,
          error:
            error instanceof Error ? error.message : "Failed to load page.",
        };
        emitBrowserState(workspaceId, browserSpace);
        void deps.persistWorkspace(workspaceId);
      });
    }

    if (browserSpace === "agent" && normalizedSessionId) {
      deps.scheduleAgentSessionBrowserLifecycleCheck(
        workspaceId,
        normalizedSessionId,
      );
    }

    return tabId;
  }

  return {
    hasVisibleBounds,
    setBounds,
    captureVisibleSnapshot,
    closeBrowserTabRecord,
    focusBrowserTabInSpace,
    setActiveBrowserTab,
    closeBrowserTab,
    navigateActiveBrowserTab,
    handleBrowserWindowOpenAsTab,
    showBrowserViewContextMenu,
    createBrowserTab,
    initialBrowserTabSeed,
    ensureBrowserTabSpaceInitialized,
    queueBrowserDownloadPrompt,
    consumeBrowserDownloadOverride,
    browserContextSuggestedFilename,
    getActiveBrowserTab,
    activeVisibleBrowserTarget,
    currentBrowserTabPageTitle,
    currentBrowserTabUrl,
    applyBoundsToTab,
    updateAttachedBrowserView,
    syncBrowserState,
    emitBrowserState,
    emitHistoryState,
    recordHistoryVisit,
    browserPagePayload,
    withTemporarilyRenderedBrowserTab,
  };
}
