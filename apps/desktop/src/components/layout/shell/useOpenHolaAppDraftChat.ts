import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import {
  chatPanelHiddenAtom,
  chatPanelViewAtom,
  chatSessionOpenRequestAtom,
  selectedSessionIdAtom,
  selectedWorkspaceIdAtom,
} from "./state/ui";

/**
 * Opens the chat beside a just-opened HolaApp surface. A HolaApp owns its own
 * sessions (tagged with `owning_app_id`), so opening an app RESUMES that app's
 * most-recent session — you land back where you left off, not in whatever
 * workspace session happened to be open. When the app has no session yet, it
 * falls back to a FRESH DRAFT (unsaved until the first message, which ChatPane
 * then persists tagged with this app's id). For API-key apps (OmniSocials,
 * Publora) the draft is additionally blocked by the surface-based gate
 * (ChatPane reads `activeWebAppSurface.apiKeyInstall`) until the key is entered.
 * Deliberately does NOT touch focus mode, so the surface + chat split stays
 * (openHolaApp turned focus off before this runs).
 */
export function useOpenHolaAppDraftChat(): (
  appId: string,
  sessionId?: string,
) => void {
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setChatPanelHidden = useSetAtom(chatPanelHiddenAtom);
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
  const workspaceId = useAtomValue(selectedWorkspaceIdAtom);

  return useCallback(
    (appId: string, sessionId?: string) => {
      setChatPanelHidden(false);
      setChatPanelView("chat");

      const openFreshDraft = () => {
        setSelectedSessionId(null);
        setSessionOpenRequest({
          sessionId: "",
          requestKey: Date.now(),
          mode: "draft",
          parentSessionId: null,
          clearComposer: true,
        });
      };

      // An explicit session (e.g. picked from the sidebar's per-app list) opens
      // directly — skip the resume-latest lookup.
      const explicitSessionId = sessionId?.trim();
      if (explicitSessionId) {
        setSelectedSessionId(explicitSessionId);
        setSessionOpenRequest({
          sessionId: explicitSessionId,
          requestKey: Date.now(),
          mode: "session",
          parentSessionId: null,
          clearComposer: true,
        });
        return;
      }

      const scopedWorkspaceId = workspaceId.trim();
      const scopedAppId = appId.trim();
      if (!scopedWorkspaceId || !scopedAppId) {
        openFreshDraft();
        return;
      }

      // Resume the app's most-recent session (the runtime returns app-owned
      // sessions newest-first). Fall back to a fresh draft on empty/error so
      // opening an app never dead-ends.
      void window.electronAPI.workspace
        .listMainSessions(scopedWorkspaceId, scopedAppId)
        .then((response) => {
          const latest = response.sessions?.[0]?.session_id?.trim();
          if (latest) {
            setSelectedSessionId(latest);
            setSessionOpenRequest({
              sessionId: latest,
              requestKey: Date.now(),
              mode: "session",
              parentSessionId: null,
              clearComposer: true,
            });
            return;
          }
          openFreshDraft();
        })
        .catch(() => {
          openFreshDraft();
        });
    },
    [
      workspaceId,
      setChatPanelHidden,
      setChatPanelView,
      setSelectedSessionId,
      setSessionOpenRequest,
    ],
  );
}
