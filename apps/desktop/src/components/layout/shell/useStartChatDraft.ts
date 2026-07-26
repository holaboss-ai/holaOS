import { useSetAtom } from "jotai";
import { useCallback } from "react";
import {
  activeWebAppSurfaceAtom,
  chatComposerPrefillAtom,
  chatReturnTargetAtom,
  focusModeAtom,
  nextComposerPrefillKey,
  projectViewAtom,
  selectedSessionIdAtom,
  type WorkspaceOverlay,
  workspaceOverlayAtom,
} from "./state/ui";

type StartChatDraftOptions = {
  /** Where to send the user back to from the chat (e.g. "customize"). */
  returnTo?: WorkspaceOverlay;
};

/**
 * Opens a fresh draft chat session with the composer pre-filled (not
 * auto-sent), dismissing any overlay. Shared by surfaces that hand the user
 * an editable starting instruction — e.g. "Customize this capability",
 * "New skill", "New capability".
 *
 * Clears the selected session (and any app surface) so the draft is a genuinely
 * blank session, not one overlaid on the currently open chat — which also stops
 * it from inheriting that session's open tabs. The real session is created
 * lazily on the first sent message (same path as the "New chat" button).
 *
 * Pass `returnTo` when handing off from a workspace surface so the chat can
 * offer a one-click way back instead of stranding the user.
 */
export function useStartChatDraft() {
  const setComposerPrefill = useSetAtom(chatComposerPrefillAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const setChatReturnTarget = useSetAtom(chatReturnTargetAtom);
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);

  return useCallback(
    (text: string, options?: StartChatDraftOptions) => {
      setProjectView(null);
      setWorkspaceOverlay(null);
      setActiveWebAppSurface(null);
      setSelectedSessionId(null);
      setFocusMode(true);
      // sessionMode "draft" makes ChatPanel open a fresh blank draft; the
      // seeded text below rides along (not auto-sent).
      setComposerPrefill({
        text,
        requestKey: nextComposerPrefillKey(),
        mode: "replace",
        sessionMode: "draft",
        autoSubmit: false,
      });
      setChatReturnTarget(options?.returnTo ?? null);
    },
    [
      setComposerPrefill,
      setFocusMode,
      setWorkspaceOverlay,
      setProjectView,
      setChatReturnTarget,
      setSelectedSessionId,
      setActiveWebAppSurface,
    ],
  );
}
