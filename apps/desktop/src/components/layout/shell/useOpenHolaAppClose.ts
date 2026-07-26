import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  activeWebAppSurfaceAtom,
  chatSessionOpenRequestAtom,
  focusModeAtom,
  preHolaAppSessionIdAtom,
  selectedSessionIdAtom,
  sidebarCollapsedAtom,
} from "./state/ui";

/**
 * Closes the active HolaApp surface and returns to the workspace chat — the
 * session that was open before the app took over the middle column
 * ({@link preHolaAppSessionIdAtom}, captured by useOpenHolaApp), or a fresh
 * workspace new-chat when the app was opened from a blank slate. A HolaApp owns
 * its own sessions and they never show in the workspace sidebar, so we must
 * navigate OFF the app session on close — leaving it selected would strand the
 * user on a chat they can no longer reach from the sidebar. The sidebar, which
 * auto-collapsed when the app opened, is re-expanded so the workspace is fully
 * back.
 */
export function useOpenHolaAppClose(): () => void {
  const store = useStore();
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
  const setPreHolaAppSession = useSetAtom(preHolaAppSessionIdAtom);
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const { selectedWorkspaceId } = useWorkspaceSelection();

  return useCallback(() => {
    const prevSession = store.get(preHolaAppSessionIdAtom);
    setActiveWebAppSurface(null);
    setPreHolaAppSession(null);
    // Bring the workspace fully back: re-expand the sidebar (collapsed on open)
    // and return to the chat canvas.
    setSidebarCollapsed(false);
    setFocusMode(true);
    if (prevSession && prevSession.trim()) {
      // Restore the workspace session that was open before the app.
      setSessionOpenRequest({
        sessionId: prevSession,
        requestKey: Date.now(),
        readOnly: false,
      });
      if (selectedWorkspaceId) {
        void window.electronAPI.workspace
          .activateMainSession(selectedWorkspaceId, prevSession)
          .catch(() => {
            // Activation failure surfaces in chat — non-fatal for the swap.
          });
      }
      return;
    }
    // No prior session (app opened from a blank new-chat): land on a fresh
    // workspace new-chat rather than stranding the user on the app's session.
    setSelectedSessionId(null);
    setSessionOpenRequest({
      sessionId: "",
      requestKey: Date.now(),
      mode: "draft",
      parentSessionId: null,
      clearComposer: true,
    });
  }, [
    store,
    selectedWorkspaceId,
    setActiveWebAppSurface,
    setFocusMode,
    setPreHolaAppSession,
    setSelectedSessionId,
    setSessionOpenRequest,
    setSidebarCollapsed,
  ]);
}
