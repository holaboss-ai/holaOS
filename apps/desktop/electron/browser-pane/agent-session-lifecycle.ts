/**
 * Agent-session browser lifecycle (BP-AGENT-SESSION).
 *
 * Each agent session has its own per-session BrowserTabSpaceState that
 * lives until the session goes idle, then gets *suspended*: live tabs
 * are torn down and persisted as a payload. When a user revisits the
 * session we *hydrate* it back to live tabs.
 *
 * The reconciliation loop polls runtime state to decide when a session
 * is busy vs idle, schedules the next check, and finally calls suspend.
 */
import type { BrowserSpaceId } from "../../shared/browser-pane-protocol.js";

/** Subset of the full BrowserTabSpaceState this module needs. */
export interface AgentSessionTabSpaceState {
  tabs: Map<string, AgentSessionTabRecord>;
  activeTabId: string;
  persistedTabs: AgentSessionPersistedTab[];
  lifecycleState: "active" | "suspended" | null;
  lastTouchedAt: string;
  suspendTimer: ReturnType<typeof setTimeout> | null;
}

export interface AgentSessionTabRecord {
  /** Opaque per-tab handle; module never reads inside it. */
  view: unknown;
  /** Same — opaque to this module. */
  state: unknown;
}

export interface AgentSessionPersistedTab {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
}

export interface AgentSessionWorkspaceState {
  workspaceId: string;
  agentSessionSpaces: Map<string, AgentSessionTabSpaceState>;
}

export interface AgentSessionPersistencePayload {
  activeTabId: string;
  tabs: AgentSessionPersistedTab[];
}

export interface AgentSessionLifecycleDeps {
  getWorkspace: (workspaceId: string) => AgentSessionWorkspaceState | null;
  browserSessionId: (value?: string | null) => string;
  browserAgentSessionSpaceState: (
    workspace: AgentSessionWorkspaceState | null,
    sessionId?: string | null,
    options?: { createIfMissing?: boolean },
  ) => AgentSessionTabSpaceState | null;

  clearBrowserTabSpaceSuspendTimer: (
    tabSpace: AgentSessionTabSpaceState,
  ) => void;
  browserTabSpaceTouch: (tabSpace: AgentSessionTabSpaceState) => void;
  browserTabSpacePersistencePayload: (
    tabSpace: AgentSessionTabSpaceState,
  ) => AgentSessionPersistencePayload;
  closeBrowserTabRecord: (tab: AgentSessionTabRecord) => void;

  isVisibleAgentBrowserSession: (
    workspaceId: string,
    sessionId?: string | null,
  ) => boolean;

  /** Poll the runtime for the latest session record (used to detect IDLE). */
  fetchSessionRuntimeStatus: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<{ status: string; lastTurnStatus: string } | null>;

  createBrowserTab: (
    workspaceId: string,
    options: {
      browserSpace: BrowserSpaceId;
      sessionId: string;
      id?: string;
      url: string;
      title?: string;
      faviconUrl?: string;
      skipInitialHistoryRecord?: boolean;
    },
  ) => string | null;

  ensureBrowserTabSpaceInitialized: (
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ) => boolean;

  emitBrowserState: (workspaceId: string, space: BrowserSpaceId) => void;
  persistWorkspace: (workspaceId: string) => Promise<void> | void;

  homeUrl: string;
  newTabTitle: string;

  busyCheckMs: number;
  warmTtlMs: number;
  completedGraceMs: number;
}

export interface AgentSessionLifecycle {
  hydrateAgentSessionBrowserSpace: (
    workspaceId: string,
    sessionId?: string | null,
  ) => AgentSessionTabSpaceState | null;
  suspendAgentSessionBrowserSpace: (
    workspaceId: string,
    sessionId?: string | null,
  ) => boolean;
  scheduleAgentSessionBrowserLifecycleCheck: (
    workspaceId: string,
    sessionId?: string | null,
    delayMs?: number,
  ) => void;
  touchAgentSessionBrowserSpace: (
    workspaceId: string,
    sessionId?: string | null,
  ) => void;
  reconcileAgentSessionBrowserSpace: (
    workspaceId: string,
    sessionId?: string | null,
  ) => Promise<void>;
}

export function createAgentSessionLifecycle(
  deps: AgentSessionLifecycleDeps,
): AgentSessionLifecycle {
  function hydrateAgentSessionBrowserSpace(
    workspaceId: string,
    sessionId?: string | null,
  ): AgentSessionTabSpaceState | null {
    const workspace = deps.getWorkspace(workspaceId);
    const normalizedSessionId = deps.browserSessionId(sessionId);
    const tabSpace = deps.browserAgentSessionSpaceState(
      workspace,
      normalizedSessionId,
      { createIfMissing: Boolean(normalizedSessionId) },
    );
    if (!workspace || !tabSpace || !normalizedSessionId) {
      return null;
    }
    deps.clearBrowserTabSpaceSuspendTimer(tabSpace);
    if (tabSpace.lifecycleState !== "suspended") {
      deps.browserTabSpaceTouch(tabSpace);
      return tabSpace;
    }

    const persistedTabs = [...tabSpace.persistedTabs];
    const persistedActiveTabId = tabSpace.activeTabId;
    tabSpace.persistedTabs = [];
    tabSpace.lifecycleState = "active";
    for (const persistedTab of persistedTabs) {
      deps.createBrowserTab(workspaceId, {
        browserSpace: "agent",
        sessionId: normalizedSessionId,
        id: typeof persistedTab.id === "string" ? persistedTab.id : undefined,
        url:
          typeof persistedTab.url === "string" && persistedTab.url.trim()
            ? persistedTab.url.trim()
            : deps.homeUrl,
        title:
          typeof persistedTab.title === "string"
            ? persistedTab.title
            : deps.newTabTitle,
        faviconUrl:
          typeof persistedTab.faviconUrl === "string"
            ? persistedTab.faviconUrl
            : undefined,
        skipInitialHistoryRecord: true,
      });
    }
    tabSpace.activeTabId = tabSpace.tabs.has(persistedActiveTabId)
      ? persistedActiveTabId
      : (Array.from(tabSpace.tabs.keys())[0] ?? "");
    if (tabSpace.tabs.size === 0) {
      deps.ensureBrowserTabSpaceInitialized(
        workspaceId,
        "agent",
        normalizedSessionId,
      );
    }
    deps.browserTabSpaceTouch(tabSpace);
    return tabSpace;
  }

  function suspendAgentSessionBrowserSpace(
    workspaceId: string,
    sessionId?: string | null,
  ): boolean {
    const workspace = deps.getWorkspace(workspaceId);
    const normalizedSessionId = deps.browserSessionId(sessionId);
    const tabSpace = deps.browserAgentSessionSpaceState(
      workspace,
      normalizedSessionId,
    );
    if (!workspace || !tabSpace || !normalizedSessionId) {
      return false;
    }
    deps.clearBrowserTabSpaceSuspendTimer(tabSpace);
    if (deps.isVisibleAgentBrowserSession(workspaceId, normalizedSessionId)) {
      return false;
    }
    if (tabSpace.lifecycleState === "suspended") {
      return true;
    }
    const persisted = deps.browserTabSpacePersistencePayload(tabSpace);
    for (const tab of tabSpace.tabs.values()) {
      deps.closeBrowserTabRecord(tab);
    }
    tabSpace.tabs.clear();
    tabSpace.activeTabId = persisted.activeTabId;
    tabSpace.persistedTabs = persisted.tabs;
    tabSpace.lifecycleState = "suspended";
    deps.emitBrowserState(workspaceId, "agent");
    void deps.persistWorkspace(workspaceId);
    return true;
  }

  function scheduleAgentSessionBrowserLifecycleCheck(
    workspaceId: string,
    sessionId?: string | null,
    delayMs: number = deps.busyCheckMs,
  ): void {
    const workspace = deps.getWorkspace(workspaceId);
    const normalizedSessionId = deps.browserSessionId(sessionId);
    const tabSpace = deps.browserAgentSessionSpaceState(
      workspace,
      normalizedSessionId,
    );
    if (!tabSpace || !normalizedSessionId) {
      return;
    }
    deps.clearBrowserTabSpaceSuspendTimer(tabSpace);
    tabSpace.suspendTimer = setTimeout(() => {
      void reconcileAgentSessionBrowserSpace(workspaceId, normalizedSessionId);
    }, Math.max(1_000, Math.round(delayMs)));
  }

  function touchAgentSessionBrowserSpace(
    workspaceId: string,
    sessionId?: string | null,
  ): void {
    const workspace = deps.getWorkspace(workspaceId);
    const normalizedSessionId = deps.browserSessionId(sessionId);
    const tabSpace = deps.browserAgentSessionSpaceState(
      workspace,
      normalizedSessionId,
    );
    if (!tabSpace || !normalizedSessionId) {
      return;
    }
    tabSpace.lifecycleState = "active";
    deps.browserTabSpaceTouch(tabSpace);
    scheduleAgentSessionBrowserLifecycleCheck(workspaceId, normalizedSessionId);
  }

  async function reconcileAgentSessionBrowserSpace(
    workspaceId: string,
    sessionId?: string | null,
  ): Promise<void> {
    const workspace = deps.getWorkspace(workspaceId);
    const normalizedSessionId = deps.browserSessionId(sessionId);
    const tabSpace = deps.browserAgentSessionSpaceState(
      workspace,
      normalizedSessionId,
    );
    if (!workspace || !tabSpace || !normalizedSessionId) {
      return;
    }
    deps.clearBrowserTabSpaceSuspendTimer(tabSpace);
    if (deps.isVisibleAgentBrowserSession(workspaceId, normalizedSessionId)) {
      scheduleAgentSessionBrowserLifecycleCheck(
        workspaceId,
        normalizedSessionId,
        deps.busyCheckMs,
      );
      return;
    }

    const runtimeStatus = await deps
      .fetchSessionRuntimeStatus(workspaceId, normalizedSessionId)
      .catch(() => null);
    const status = runtimeStatus?.status ?? "";
    const lastTurnStatus = runtimeStatus?.lastTurnStatus ?? "";
    const touchedAtMs = Date.parse(tabSpace.lastTouchedAt);
    const ageMs = Number.isFinite(touchedAtMs)
      ? Math.max(0, Date.now() - touchedAtMs)
      : Number.MAX_SAFE_INTEGER;

    if (status === "BUSY" || status === "QUEUED" || status === "PAUSING") {
      scheduleAgentSessionBrowserLifecycleCheck(
        workspaceId,
        normalizedSessionId,
        deps.busyCheckMs,
      );
      return;
    }

    if (
      (status === "WAITING_USER" || status === "PAUSED") &&
      ageMs < deps.warmTtlMs
    ) {
      scheduleAgentSessionBrowserLifecycleCheck(
        workspaceId,
        normalizedSessionId,
        deps.warmTtlMs - ageMs,
      );
      return;
    }

    if (
      !(status === "WAITING_USER" || status === "PAUSED") &&
      (status === "IDLE" ||
        status === "ERROR" ||
        !runtimeStatus ||
        lastTurnStatus === "completed" ||
        lastTurnStatus === "failed" ||
        lastTurnStatus === "error") &&
      ageMs < deps.completedGraceMs
    ) {
      scheduleAgentSessionBrowserLifecycleCheck(
        workspaceId,
        normalizedSessionId,
        deps.completedGraceMs - ageMs,
      );
      return;
    }

    suspendAgentSessionBrowserSpace(workspaceId, normalizedSessionId);
  }

  return {
    hydrateAgentSessionBrowserSpace,
    suspendAgentSessionBrowserSpace,
    scheduleAgentSessionBrowserLifecycleCheck,
    touchAgentSessionBrowserSpace,
    reconcileAgentSessionBrowserSpace,
  };
}
