import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  activeInternalTabIdAtom,
  internalTabsAtom,
  issueDetailTab,
  pendingIssueComposerFocusAtom,
  upsertInternalTab,
} from "./state/internalTabs";

export function useOpenIssueDetailTab() {
  const { setSelectedWorkspaceId } = useWorkspaceSelection();
  const setInternalTabs = useSetAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const setPendingComposerFocus = useSetAtom(pendingIssueComposerFocusAtom);

  return useCallback(
    (params: {
      workspaceId: string;
      issueId: string;
      title?: string | null;
      /** Auto-focus the reply composer once the detail tab finishes
       *  loading. One-shot — only the first mount after this call
       *  triggers focus. Used by the "Reply" button on blocked board
       *  cards so the user lands cursor-in-input. */
      focusComposer?: boolean;
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
      if (params.focusComposer) {
        setPendingComposerFocus((prev) => {
          if (prev.has(tab.id)) return prev;
          const next = new Set(prev);
          next.add(tab.id);
          return next;
        });
      }
    },
    [
      setActiveInternalTabId,
      setInternalTabs,
      setPendingComposerFocus,
      setSelectedWorkspaceId,
    ],
  );
}
