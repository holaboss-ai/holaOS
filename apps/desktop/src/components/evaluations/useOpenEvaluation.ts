import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { selectedEmployeeAtom } from "@/components/layout/shell/state/employees";
import {
  activeInternalTabIdAtom,
  evaluationTab,
  internalTabsAtom,
} from "@/components/layout/shell/state/internalTabs";
import {
  activeWebAppSurfaceAtom,
  centerFullscreenAtom,
  chatPanelHiddenAtom,
  chatPanelViewAtom,
  chatSessionOpenRequestAtom,
  focusModeAtom,
  projectViewAtom,
  selectedSessionIdAtom,
  sessionLastViewedAtAtom,
  workspaceOverlayAtom,
} from "@/components/layout/shell/state/ui";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

export interface OpenableEvaluation {
  eval_id: string;
  title: string;
  session_id: string | null;
}

// Tabs are per session, so switch the session before adding the tab.
export function useOpenEvaluation() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);
  const setSelectedEmployee = useSetAtom(selectedEmployeeAtom);
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setChatPanelHidden = useSetAtom(chatPanelHiddenAtom);
  const setCenterFullscreen = useSetAtom(centerFullscreenAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
  const setLastViewedMap = useSetAtom(sessionLastViewedAtAtom);
  const setInternalTabs = useSetAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);

  return useCallback(
    (evaluation: OpenableEvaluation) => {
      const evalId = evaluation.eval_id.trim();
      if (!evalId) {
        return;
      }
      const sessionId = evaluation.session_id?.trim() || "";

      setProjectView(null);
      setWorkspaceOverlay(null);
      setActiveWebAppSurface(null);
      setSelectedEmployee(null);
      setChatPanelView("chat");
      if (sessionId) {
        setSelectedSessionId(sessionId);
      }

      const tab = evaluationTab({ evalId, label: evaluation.title });
      setInternalTabs((prev) =>
        prev.some((entry) => entry.id === tab.id)
          ? prev.map((entry) => (entry.id === tab.id ? tab : entry))
          : [...prev, tab],
      );
      setActiveInternalTabId(tab.id);
      setFocusMode(false);
      setChatPanelHidden(false);
      setCenterFullscreen(false);

      if (!sessionId) {
        return;
      }
      setSessionOpenRequest({
        sessionId,
        requestKey: Date.now(),
        readOnly: false,
      });
      setLastViewedMap((prev) => ({
        ...prev,
        [sessionId]: new Date().toISOString(),
      }));
      const workspaceId = selectedWorkspaceId?.trim();
      if (workspaceId) {
        void window.electronAPI?.workspace
          ?.activateMainSession(workspaceId, sessionId)
          .catch(() => undefined);
      }
    },
    [
      selectedWorkspaceId,
      setActiveInternalTabId,
      setActiveWebAppSurface,
      setCenterFullscreen,
      setChatPanelHidden,
      setChatPanelView,
      setFocusMode,
      setInternalTabs,
      setLastViewedMap,
      setProjectView,
      setSelectedEmployee,
      setSelectedSessionId,
      setSessionOpenRequest,
      setWorkspaceOverlay,
    ],
  );
}
