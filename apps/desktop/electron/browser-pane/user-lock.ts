/**
 * User-lock + agent-interrupt prompts (BP-USER-LOCK).
 *
 * Two pieces of state:
 *
 *   1. `userBrowserLock` (per workspace) — when the user explicitly
 *      takes control of the browser, the lock points to the agent
 *      session being interrupted. Heartbeats keep the lock fresh; a
 *      stale heartbeat releases it automatically.
 *   2. `programmaticBrowserInputDepth` (per WebContents) — re-entrant
 *      counter set during programmatic input. Input events generated
 *      while depth > 0 are not treated as user activity (so they don't
 *      trigger the interrupt prompt).
 *
 * The interrupt-prompt logic shows a confirmation dialog the moment the
 * user tries to type/click while an agent owns the browser, and
 * deduplicates prompts by workspace.
 */
import { type BrowserWindow, type WebContents, dialog } from "electron";

import type { BrowserSpaceId } from "../../shared/browser-pane-protocol.js";

export interface BrowserUserLockState {
  sessionId: string;
  acquiredAt: string;
  heartbeatAt: string;
  reason: string | null;
}

export interface UserLockWorkspaceState {
  userBrowserLock: BrowserUserLockState | null;
  activeAgentSessionId: string | null;
}

export interface BrowserUserLockDeps {
  getMainWindow: () => BrowserWindow | null;
  getWorkspace: (workspaceId: string) => UserLockWorkspaceState | null;
  browserSessionId: (value?: string | null) => string;

  /** Lock is treated as released after this many ms without a heartbeat. */
  lockTimeoutMs: number;

  /** Pause an agent session run when the user takes over. */
  pauseSessionRun: (params: {
    workspace_id: string;
    session_id: string;
  }) => Promise<unknown>;

  /** Whether the agent session for this workspace is busy/queued/pausing. */
  isAgentSessionBusy: (workspaceId: string, sessionId: string) => boolean;
}

export interface BrowserUserLock {
  activeUserBrowserLock: (
    workspace: UserLockWorkspaceState | null | undefined,
  ) => BrowserUserLockState | null;
  releaseUserBrowserLock: (
    workspaceId: string,
    sessionId?: string | null,
  ) => boolean;
  ensureUserBrowserLock: (
    workspaceId: string,
    sessionId?: string | null,
    reason?: string | null,
  ) =>
    | { ok: true; lock: BrowserUserLockState }
    | { ok: false; lockHolderSessionId: string };
  pauseBrowserControlSession: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<void>;
  agentBrowserSessionNeedsInterrupt: (
    workspaceId: string,
    sessionId?: string | null,
  ) => boolean;
  confirmBrowserInterrupt: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<void>;
  maybePromptBrowserInterrupt: (
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ) => boolean;
  isProgrammaticBrowserInput: (webContents: WebContents) => boolean;
  withProgrammaticBrowserInput: <T>(
    webContents: WebContents,
    callback: () => Promise<T>,
  ) => Promise<T>;
}

export function createBrowserUserLock(
  deps: BrowserUserLockDeps,
): BrowserUserLock {
  const userBrowserInterruptPrompts = new Set<string>();
  const programmaticBrowserInputDepth = new WeakMap<WebContents, number>();

  function activeUserBrowserLock(
    workspace: UserLockWorkspaceState | null | undefined,
  ): BrowserUserLockState | null {
    if (!workspace?.userBrowserLock) {
      return null;
    }
    const heartbeatAtMs = Date.parse(workspace.userBrowserLock.heartbeatAt);
    if (
      !Number.isFinite(heartbeatAtMs) ||
      Date.now() - heartbeatAtMs > deps.lockTimeoutMs
    ) {
      workspace.userBrowserLock = null;
      return null;
    }
    return workspace.userBrowserLock;
  }

  function releaseUserBrowserLock(
    workspaceId: string,
    sessionId?: string | null,
  ): boolean {
    const workspace = deps.getWorkspace(workspaceId);
    const activeLock = activeUserBrowserLock(workspace);
    const normalizedSessionId = deps.browserSessionId(sessionId);
    if (
      !workspace ||
      !activeLock ||
      (normalizedSessionId && activeLock.sessionId !== normalizedSessionId)
    ) {
      return false;
    }
    workspace.userBrowserLock = null;
    return true;
  }

  function ensureUserBrowserLock(
    workspaceId: string,
    sessionId?: string | null,
    reason?: string | null,
  ):
    | { ok: true; lock: BrowserUserLockState }
    | { ok: false; lockHolderSessionId: string } {
    const workspace = deps.getWorkspace(workspaceId);
    const normalizedSessionId = deps.browserSessionId(sessionId);
    if (!workspace || !normalizedSessionId) {
      return { ok: false, lockHolderSessionId: "" };
    }
    const existing = activeUserBrowserLock(workspace);
    if (existing && existing.sessionId !== normalizedSessionId) {
      return { ok: false, lockHolderSessionId: existing.sessionId };
    }
    const now = new Date().toISOString();
    workspace.userBrowserLock = existing
      ? {
          ...existing,
          heartbeatAt: now,
          reason:
            typeof reason === "string" && reason.trim()
              ? reason.trim()
              : existing.reason,
        }
      : {
          sessionId: normalizedSessionId,
          acquiredAt: now,
          heartbeatAt: now,
          reason:
            typeof reason === "string" && reason.trim() ? reason.trim() : null,
        };
    return { ok: true, lock: workspace.userBrowserLock };
  }

  async function pauseBrowserControlSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      await deps.pauseSessionRun({
        workspace_id: workspaceId,
        session_id: sessionId,
      });
    } finally {
      releaseUserBrowserLock(workspaceId, sessionId);
    }
  }

  function agentBrowserSessionNeedsInterrupt(
    workspaceId: string,
    sessionId?: string | null,
  ): boolean {
    const workspace = deps.getWorkspace(workspaceId);
    const normalizedSessionId =
      deps.browserSessionId(sessionId) ||
      deps.browserSessionId(workspace?.activeAgentSessionId);
    if (!workspaceId.trim() || !normalizedSessionId) {
      return false;
    }
    return deps.isAgentSessionBusy(workspaceId, normalizedSessionId);
  }

  async function confirmBrowserInterrupt(
    workspaceId: string,
    sessionId: string,
  ): Promise<void> {
    if (userBrowserInterruptPrompts.has(workspaceId)) {
      return;
    }
    userBrowserInterruptPrompts.add(workspaceId);
    try {
      const mainWindow = deps.getMainWindow();
      const ownerWindow =
        mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const messageBoxOptions = {
        type: "warning" as const,
        buttons: ["Let agent continue", "Interrupt and take over"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: "Agent Controlling Browser",
        message: "The agent is currently controlling this browser.",
        detail:
          "Your input will only go through if you interrupt. Interrupting will pause the active agent session and return control to you.",
      };
      const { response } = ownerWindow
        ? await dialog.showMessageBox(ownerWindow, messageBoxOptions)
        : await dialog.showMessageBox(messageBoxOptions);
      if (response !== 1) {
        return;
      }
      await pauseBrowserControlSession(workspaceId, sessionId);
    } catch (error) {
      const mainWindow = deps.getMainWindow();
      const ownerWindow =
        mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      const errorOptions = {
        type: "error" as const,
        title: "Could Not Interrupt Agent",
        message: "The agent session could not be paused.",
        detail:
          error instanceof Error
            ? error.message
            : "The browser remained under agent control.",
      };
      if (ownerWindow) {
        await dialog.showMessageBox(ownerWindow, errorOptions);
      } else {
        await dialog.showMessageBox(errorOptions);
      }
    } finally {
      userBrowserInterruptPrompts.delete(workspaceId);
    }
  }

  function maybePromptBrowserInterrupt(
    workspaceId: string,
    space: BrowserSpaceId,
    sessionId?: string | null,
  ): boolean {
    if (space === "user") {
      const workspace = deps.getWorkspace(workspaceId);
      const lock = activeUserBrowserLock(workspace);
      if (!lock) {
        return false;
      }
      void confirmBrowserInterrupt(workspaceId, lock.sessionId);
      return true;
    }

    const controllingSessionId = deps.browserSessionId(sessionId);
    if (!agentBrowserSessionNeedsInterrupt(workspaceId, controllingSessionId)) {
      return false;
    }
    void confirmBrowserInterrupt(workspaceId, controllingSessionId);
    return true;
  }

  function isProgrammaticBrowserInput(webContents: WebContents): boolean {
    return (programmaticBrowserInputDepth.get(webContents) ?? 0) > 0;
  }

  async function withProgrammaticBrowserInput<T>(
    webContents: WebContents,
    callback: () => Promise<T>,
  ): Promise<T> {
    programmaticBrowserInputDepth.set(
      webContents,
      (programmaticBrowserInputDepth.get(webContents) ?? 0) + 1,
    );
    try {
      return await callback();
    } finally {
      const nextDepth =
        (programmaticBrowserInputDepth.get(webContents) ?? 1) - 1;
      if (nextDepth > 0) {
        programmaticBrowserInputDepth.set(webContents, nextDepth);
      } else {
        programmaticBrowserInputDepth.delete(webContents);
      }
    }
  }

  return {
    activeUserBrowserLock,
    releaseUserBrowserLock,
    ensureUserBrowserLock,
    pauseBrowserControlSession,
    agentBrowserSessionNeedsInterrupt,
    confirmBrowserInterrupt,
    maybePromptBrowserInterrupt,
    isProgrammaticBrowserInput,
    withProgrammaticBrowserInput,
  };
}
