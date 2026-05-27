import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  activeInternalTabIdAtom,
  internalTabsAtom,
  issueDetailTab,
  upsertInternalTab,
} from "./state/internalTabs";

export function useOpenIssueDetailTab() {
  const { setSelectedWorkspaceId } = useWorkspaceSelection();
  const setInternalTabs = useSetAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);

  return useCallback(
    (params: {
      workspaceId: string;
      issueId: string;
      title?: string | null;
    }) => {
      const workspaceId = params.workspaceId.trim();
      const issueId = params.issueId.trim();
      if (!workspaceId || !issueId) {
        return;
      }

      setSelectedWorkspaceId(workspaceId);
      const tab = issueDetailTab({
        workspaceId,
        issueId,
        label: params.title?.trim() || issueId,
      });
      setInternalTabs((prev) => upsertInternalTab(prev, tab));
      setActiveInternalTabId(tab.id);
    },
    [setActiveInternalTabId, setInternalTabs, setSelectedWorkspaceId],
  );
}
