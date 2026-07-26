import { useSetAtom } from "jotai";
import { useEffect } from "react";
import { selectedEmployeeAtom } from "./state/employees";
import {
  activeWebAppSurfaceAtom,
  chatPanelViewAtom,
  chatSessionOpenRequestAtom,
  focusModeAtom,
  projectViewAtom,
  selectedSessionIdAtom,
  sessionLastViewedAtAtom,
  workspaceOverlayAtom,
} from "./state/ui";

/**
 * Clicking a native OS notification (a session completed while the window was
 * away) should land the user IN that session — not just focus the window on
 * Home. Main forwards the click as `ui:notificationActivated` with the session's
 * { workspaceId, sessionId }; here we open it, mirroring a sidebar session-row
 * click (SidebarSessionRow.handleOpen). Without this subscriber the payload was
 * delivered to no one, so the click only ever focused the window. Mount once at
 * the shell root.
 */
export function useNotificationActivated(): void {
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
  const setLastViewedMap = useSetAtom(sessionLastViewedAtAtom);
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);
  const setSelectedEmployee = useSetAtom(selectedEmployeeAtom);

  useEffect(() => {
    const off = window.electronAPI?.ui?.onNotificationActivated?.(
      async ({ workspaceId, sessionId }) => {
        // No specific session (e.g. a system notification) — the window is
        // already focused; leave the user where they are.
        if (!sessionId) {
          return;
        }
        // Same takeover a sidebar session click performs: drop any overlay /
        // project / employee / app surface so the chat fills the canvas.
        setProjectView(null);
        setWorkspaceOverlay(null);
        setSelectedEmployee(null);
        setActiveWebAppSurface(null);
        setChatPanelView("chat");
        setSelectedSessionId(sessionId);
        setFocusMode(true);
        // Nudge ChatPane to actually load this session (fresh requestKey).
        setSessionOpenRequest({
          sessionId,
          requestKey: Date.now(),
          readOnly: false,
        });
        // Record the view so the unread dot clears.
        setLastViewedMap((prev) => ({
          ...prev,
          [sessionId]: new Date().toISOString(),
        }));
        try {
          await window.electronAPI.workspace.activateMainSession(
            workspaceId,
            sessionId,
          );
        } catch {
          // Activation failure surfaces in chat — non-fatal for the selection.
        }
      },
    );
    return off;
  }, [
    setActiveWebAppSurface,
    setChatPanelView,
    setFocusMode,
    setLastViewedMap,
    setProjectView,
    setSelectedEmployee,
    setSelectedSessionId,
    setSessionOpenRequest,
    setWorkspaceOverlay,
  ]);
}
