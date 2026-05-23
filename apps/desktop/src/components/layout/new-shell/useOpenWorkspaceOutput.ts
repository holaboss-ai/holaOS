import { useAtom, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  activeInternalTabIdAtom,
  fileNameFromPath,
  internalTabsAtom,
  makeInternalTabId,
} from "./state/internalTabs";
import { pushRecentFileAtom } from "./state/recentFiles";

/**
 * Shared "open this workspace output" handler. Resolves module-backed
 * outputs to an app-surface URL (opened as a browser tab) and file-backed
 * outputs to an internal file tab. Used by both the chat pane's
 * `onOpenOutput` plumbing and the sidebar Artifacts list.
 */
export function useOpenWorkspaceOutput() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { installedApps } = useWorkspaceDesktop();
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const pushRecentFile = useSetAtom(pushRecentFileAtom);

  const installedAppIds = useMemo(
    () => new Set(installedApps.map((a) => a.id)),
    [installedApps],
  );

  const openUrlInBrowserTab = useCallback(
    async (url: string) => {
      if (!selectedWorkspaceId || !url.trim()) return;
      try {
        setActiveInternalTabId(null);
        await window.electronAPI.browser.setActiveWorkspace(
          selectedWorkspaceId,
          "user",
        );
        await window.electronAPI.browser.newTab(url);
      } catch {
        // non-fatal
      }
    },
    [selectedWorkspaceId, setActiveInternalTabId],
  );

  const openFileInInternalTab = useCallback(
    (rawPath: string) => {
      const normalized = rawPath.replace(/^file:\/\//, "");
      let decoded = normalized;
      try {
        decoded = decodeURI(normalized);
      } catch {
        // tolerate already-decoded inputs
      }
      const label = fileNameFromPath(decoded);
      pushRecentFile({
        filePath: decoded,
        label,
        workspaceId: selectedWorkspaceId ?? null,
      });
      const existing = internalTabs.find(
        (t) => t.kind === "file" && t.filePath === decoded,
      );
      if (existing) {
        setActiveInternalTabId(existing.id);
        return;
      }
      const tab = {
        id: makeInternalTabId(),
        kind: "file" as const,
        filePath: decoded,
        label,
      };
      setInternalTabs((prev) => [...prev, tab]);
      setActiveInternalTabId(tab.id);
    },
    [
      internalTabs,
      pushRecentFile,
      selectedWorkspaceId,
      setActiveInternalTabId,
      setInternalTabs,
    ],
  );

  const openOutput = useCallback(
    async (output: WorkspaceOutputRecordPayload) => {
      if (!selectedWorkspaceId) return;
      const moduleId = (output.module_id || "").trim().toLowerCase();
      if (moduleId && installedAppIds.has(moduleId)) {
        const metadata = (output.metadata ?? {}) as Record<string, unknown>;
        const presentation = metadata.presentation as
          | { kind?: string; view?: string; path?: string }
          | undefined;
        const hasAppPresentation =
          presentation?.kind === "app_resource" && presentation?.view;
        let path: string | undefined =
          hasAppPresentation && presentation?.path
            ? presentation.path
            : undefined;
        if (!path) {
          const view = hasAppPresentation
            ? presentation?.view
            : output.output_type === "post"
              ? "posts"
              : output.output_type || "home";
          const resourceId = output.module_resource_id;
          if (resourceId) {
            const encoded = encodeURIComponent(resourceId);
            path = view === "home" ? `/posts/${encoded}` : `/${view}/${encoded}`;
          } else if (view && view !== "home") {
            path = `/${view}`;
          }
        }
        try {
          const url = await window.electronAPI.appSurface.resolveUrl(
            selectedWorkspaceId,
            moduleId,
            path,
          );
          await openUrlInBrowserTab(url);
        } catch {
          // fall through to file fallback
        }
        return;
      }
      if (output.file_path) {
        openFileInInternalTab(output.file_path);
      }
    },
    [
      selectedWorkspaceId,
      installedAppIds,
      openUrlInBrowserTab,
      openFileInInternalTab,
    ],
  );

  return {
    openOutput,
    openUrlInBrowserTab,
    openFileInInternalTab,
  };
}
