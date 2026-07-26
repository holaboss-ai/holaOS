import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

import {
  discoverEnabledAtom,
  focusModeAtom,
  holahubPendingPathAtom,
  projectViewAtom,
  workspaceOverlayAtom,
} from "./state/ui";

// Soft launch: when the community is off the hosted surface must drop the feed
// nav (see lib/community.ts on the web). Carry `?community=0` on whatever path we
// open so every entry point (Marketplace, integration install, …) stays feed-less.
function withCommunityOff(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}community=0`;
}

/**
 * Open the HolaHub workspace overlay, optionally navigated to a specific path
 * (e.g. `/threads/<postId>` to jump to a post an agent just published, or
 * `/marketplace?type=holaapp` for install). When the community is off, a bare
 * open lands on the Marketplace and every path is flagged feed-less.
 */
export function useOpenDiscover() {
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setHolahubPath = useSetAtom(holahubPendingPathAtom);
  const discoverEnabled = useAtomValue(discoverEnabledAtom);
  return useCallback(
    (path?: string) => {
      setProjectView(null);
      setFocusMode(false);
      setHolahubPath(
        discoverEnabled ? (path ?? null) : withCommunityOff(path ?? "/marketplace")
      );
      setWorkspaceOverlay("holahub");
    },
    [
      setProjectView,
      setFocusMode,
      setHolahubPath,
      setWorkspaceOverlay,
      discoverEnabled,
    ]
  );
}
