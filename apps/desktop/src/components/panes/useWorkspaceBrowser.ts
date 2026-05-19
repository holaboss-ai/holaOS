import { useEffect, useMemo, useState } from "react";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

const EMPTY_BROWSER_STATE: BrowserStatePayload = {
  id: "",
  url: "",
  title: "New Tab",
  canGoBack: false,
  canGoForward: false,
  loading: false,
  initialized: false,
  error: "",
};

function initialBrowserState(space: BrowserSpaceId): BrowserTabListPayload {
  return {
    space,
    activeTabId: "",
    tabs: [],
    tabCounts: {
      user: 0,
      agent: 0,
    },
    sessionId: null,
    lifecycleState: null,
    controlMode: "none",
    controlSessionId: null,
  };
}

interface UseWorkspaceBrowserOptions {
  includeDownloads?: boolean;
  includeHistory?: boolean;
  includeSessions?: boolean;
}

const BROWSER_SESSION_POLL_INTERVAL_MS = 2000;

function runtimeStateIndex(
  items: SessionRuntimeRecordPayload[],
): Record<string, SessionRuntimeRecordPayload> {
  return Object.fromEntries(
    items
      .filter((item) => Boolean(item.session_id.trim()))
      .map((item) => [item.session_id, item]),
  );
}

export function useWorkspaceBrowser(
  browserSpace: BrowserSpaceId,
  options?: UseWorkspaceBrowserOptions,
) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const [browserState, setBrowserState] = useState<BrowserTabListPayload>(
    () => initialBrowserState(browserSpace),
  );
  const [bookmarks, setBookmarks] = useState<BrowserBookmarkPayload[]>([]);
  const [downloads, setDownloads] = useState<BrowserDownloadPayload[]>([]);
  const [historyEntries, setHistoryEntries] = useState<
    BrowserHistoryEntryPayload[]
  >([]);
  const [agentSessions, setAgentSessions] = useState<AgentSessionRecordPayload[]>(
    [],
  );
  const [runtimeStatesBySessionId, setRuntimeStatesBySessionId] = useState<
    Record<string, SessionRuntimeRecordPayload>
  >({});

  useEffect(() => {
    let mounted = true;

    const applyState = (state: BrowserTabListPayload) => {
      if (!mounted || state.space !== browserSpace) {
        return;
      }
      setBrowserState(state);
    };

    if (!selectedWorkspaceId) {
      setBrowserState(initialBrowserState(browserSpace));
      return () => {
        mounted = false;
      };
    }

    void window.electronAPI.browser
      .setActiveWorkspace(selectedWorkspaceId, browserSpace)
      .then((state) => {
        if (mounted) {
          applyState(state);
        }
      });
    const unsubscribe = window.electronAPI.browser.onStateChange(applyState);

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [browserSpace, selectedWorkspaceId]);

  useEffect(() => {
    let mounted = true;

    const applyBookmarks = (nextBookmarks: BrowserBookmarkPayload[]) => {
      if (mounted) {
        setBookmarks(nextBookmarks);
      }
    };
    const applyDownloads = (nextDownloads: BrowserDownloadPayload[]) => {
      if (mounted) {
        setDownloads(nextDownloads);
      }
    };
    const applyHistory = (nextHistory: BrowserHistoryEntryPayload[]) => {
      if (mounted) {
        setHistoryEntries(nextHistory);
      }
    };

    if (!selectedWorkspaceId) {
      setBookmarks([]);
      setDownloads([]);
      setHistoryEntries([]);
      return () => {
        mounted = false;
      };
    }

    void window.electronAPI.browser.getBookmarks().then(applyBookmarks);
    const unsubscribeBookmarks =
      window.electronAPI.browser.onBookmarksChange(applyBookmarks);

    let unsubscribeDownloads: () => void = () => {};
    if (options?.includeDownloads) {
      void window.electronAPI.browser.getDownloads().then(applyDownloads);
      unsubscribeDownloads =
        window.electronAPI.browser.onDownloadsChange(applyDownloads);
    } else {
      setDownloads([]);
    }

    let unsubscribeHistory: () => void = () => {};
    if (options?.includeHistory) {
      void window.electronAPI.browser.getHistory().then(applyHistory);
      unsubscribeHistory =
        window.electronAPI.browser.onHistoryChange(applyHistory);
    } else {
      setHistoryEntries([]);
    }

    return () => {
      mounted = false;
      unsubscribeBookmarks();
      unsubscribeDownloads();
      unsubscribeHistory();
    };
  }, [options?.includeDownloads, options?.includeHistory, selectedWorkspaceId]);

  useEffect(() => {
    if (!options?.includeSessions) {
      setAgentSessions([]);
      setRuntimeStatesBySessionId({});
      return;
    }
    if (!selectedWorkspaceId) {
      setAgentSessions([]);
      setRuntimeStatesBySessionId({});
      return;
    }

    let cancelled = false;
    let requestInFlight = false;

    const loadSessionState = async () => {
      if (requestInFlight) {
        return;
      }
      requestInFlight = true;
      try {
        const [sessionsResponse, runtimeStatesResponse] = await Promise.all([
          window.electronAPI.workspace.listAgentSessions(selectedWorkspaceId),
          window.electronAPI.workspace.listRuntimeStates(selectedWorkspaceId),
        ]);
        if (cancelled) {
          return;
        }
        setAgentSessions(sessionsResponse.items);
        setRuntimeStatesBySessionId(runtimeStateIndex(runtimeStatesResponse.items));
      } catch {
        // Keep the last successful browser session snapshot during transient
        // runtime hiccups instead of surfacing an unhandled rejection.
      } finally {
        requestInFlight = false;
      }
    };

    const refreshVisibleSessionState = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      void loadSessionState();
    };

    void loadSessionState();
    const intervalId = window.setInterval(
      refreshVisibleSessionState,
      BROWSER_SESSION_POLL_INTERVAL_MS,
    );
    window.addEventListener("focus", refreshVisibleSessionState);
    document.addEventListener("visibilitychange", refreshVisibleSessionState);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshVisibleSessionState);
      document.removeEventListener("visibilitychange", refreshVisibleSessionState);
    };
  }, [options?.includeSessions, selectedWorkspaceId]);

  const activeTab = useMemo(
    () =>
      browserState.tabs.find((tab) => tab.id === browserState.activeTabId) ??
      browserState.tabs[0] ??
      EMPTY_BROWSER_STATE,
    [browserState],
  );

  const activeBookmark = useMemo(
    () => bookmarks.find((bookmark) => bookmark.url === activeTab.url) ?? null,
    [activeTab.url, bookmarks],
  );

  const currentSessionId = useMemo(
    () => browserState.controlSessionId || browserState.sessionId || null,
    [browserState.controlSessionId, browserState.sessionId],
  );

  const currentSession = useMemo(
    () =>
      currentSessionId
        ? agentSessions.find((session) => session.session_id === currentSessionId) ??
          null
        : null,
    [agentSessions, currentSessionId],
  );

  const currentRuntimeState = useMemo(
    () =>
      currentSessionId ? runtimeStatesBySessionId[currentSessionId] ?? null : null,
    [currentSessionId, runtimeStatesBySessionId],
  );

  return {
    selectedWorkspaceId,
    browserState,
    activeTab,
    bookmarks,
    downloads,
    historyEntries,
    activeBookmark,
    isBookmarked: Boolean(activeBookmark),
    agentSessions,
    runtimeStatesBySessionId,
    currentSessionId,
    currentSession,
    currentRuntimeState,
  };
}
