import { useSetAtom } from "jotai";
import { useCallback } from "react";

import {
  focusModeAtom,
  projectViewAtom,
  type ShareMode,
  type ShareSessionPayload,
  shareInitialModeAtom,
  shareSessionPayloadAtom,
  workspaceOverlayAtom,
} from "./state/ui";

/**
 * Open the full-page "Share to HolaHub" composer for a conversation. Stages the
 * messages (+ workspace + active model) so the overlay pane can render a WYSIWYG
 * preview, then flips the workspace overlay. `mode` sets which tab it opens on
 * (whole conversation vs just the outputs). Mirrors `useOpenDiscover`.
 */
export function useOpenSharePreview() {
  const setPayload = useSetAtom(shareSessionPayloadAtom);
  const setMode = useSetAtom(shareInitialModeAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  return useCallback(
    (payload: ShareSessionPayload, mode: ShareMode = "conversation") => {
      setPayload(payload);
      setMode(mode);
      setProjectView(null);
      setFocusMode(false);
      setWorkspaceOverlay("holahub-share");
    },
    [setPayload, setMode, setProjectView, setFocusMode, setWorkspaceOverlay]
  );
}
