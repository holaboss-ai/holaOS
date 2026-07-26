import { useSetAtom } from "jotai";
import { useCallback } from "react";
import {
  activeWebAppSurfaceAtom,
  chatPanelViewAtom,
  chatSessionOpenRequestAtom,
  focusModeAtom,
  projectViewAtom,
  selectedSessionIdAtom,
  workspaceOverlayAtom,
} from "./state/ui";

/**
 * Opens a fresh General chat as an unsaved draft: the composer appears in
 * canvas mode but no session is created yet. ChatPane lazily creates and
 * activates the session on the first sent message, so abandoned "New chat"
 * clicks never leave empty session rows behind. Shared by the sidebar "New
 * chat" button and the ⌘N global shortcut so both paths stay in lockstep.
 */
export function useStartNewChat(workspaceId: string | null): {
  startNewChat: () => Promise<void>;
  starting: boolean;
} {
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);

  const startNewChat = useCallback(async () => {
    if (!workspaceId) return;
    setProjectView(null);
    setWorkspaceOverlay(null);
    // Leave any open HolaApp surface — a New chat isn't tied to an app, so this
    // also clears the surface-based API-key gate (OmniSocials/Publora); otherwise
    // the gate would follow you into an unrelated fresh chat.
    setActiveWebAppSurface(null);
    setChatPanelView("chat");
    setSelectedSessionId(null);
    setFocusMode(true);
    setSessionOpenRequest({
      sessionId: "",
      requestKey: Date.now(),
      mode: "draft",
      parentSessionId: null,
      clearComposer: true,
    });
  }, [
    workspaceId,
    setProjectView,
    setWorkspaceOverlay,
    setActiveWebAppSurface,
    setChatPanelView,
    setSelectedSessionId,
    setFocusMode,
    setSessionOpenRequest,
  ]);

  return { startNewChat, starting: false };
}
