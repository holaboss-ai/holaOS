import { useAtom, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { ChatPane } from "@/components/panes/ChatPane";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { sessionsOpenAtom } from "./state/ui";
import {
  activeInternalTabIdAtom,
  fileNameFromPath,
  internalTabsAtom,
  makeInternalTabId,
} from "./state/internalTabs";

export function ChatPanel() {
  const setSessionsOpen = useSetAtom(sessionsOpenAtom);
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { installedApps } = useWorkspaceDesktop();
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);

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
      const existing = internalTabs.find((t) => t.filePath === decoded);
      if (existing) {
        setActiveInternalTabId(existing.id);
        return;
      }
      const tab = {
        id: makeInternalTabId(),
        kind: "file" as const,
        filePath: decoded,
        label: fileNameFromPath(decoded),
      };
      setInternalTabs((prev) => [...prev, tab]);
      setActiveInternalTabId(tab.id);
    },
    [internalTabs, setActiveInternalTabId, setInternalTabs],
  );

  const handleOpenOutput = useCallback(
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

  const handleOpenLocalLink = useCallback(
    (href: string) => {
      if (!href.trim()) return;
      openFileInInternalTab(href);
    },
    [openFileInInternalTab],
  );

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-border bg-background">
      <ChatPane
        variant="embedded"
        onOpenSessions={() => setSessionsOpen(true)}
        onOpenOutput={handleOpenOutput}
        onOpenLinkInBrowser={openUrlInBrowserTab}
        onOpenLocalLink={handleOpenLocalLink}
      />
    </aside>
  );
}
