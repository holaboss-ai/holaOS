import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ChatPane } from "@/components/panes/ChatPane";
import type { AttachmentListItem } from "@/components/panes/ChatPane/types";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { sessionsOpenAtom } from "./state/ui";
import {
  activeInternalTabIdAtom,
  fileNameFromPath,
  internalTabsAtom,
  makeInternalTabId,
} from "./state/internalTabs";
import { pushRecentFileAtom } from "./state/recentFiles";

export function ChatPanel() {
  const setSessionsOpen = useSetAtom(sessionsOpenAtom);
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

  // Blob URLs we minted for ephemeral-image tabs, keyed by tab id. Revoke
  // them once the tab is closed (and on unmount) so we don't leak.
  const ephemeralImageBlobUrlsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const map = ephemeralImageBlobUrlsRef.current;
    if (map.size === 0) return;
    const liveIds = new Set(internalTabs.map((t) => t.id));
    for (const [tabId, url] of map.entries()) {
      if (!liveIds.has(tabId)) {
        URL.revokeObjectURL(url);
        map.delete(tabId);
      }
    }
  }, [internalTabs]);

  useEffect(() => {
    return () => {
      const map = ephemeralImageBlobUrlsRef.current;
      for (const url of map.values()) {
        URL.revokeObjectURL(url);
      }
      map.clear();
    };
  }, []);

  const handlePreviewImageAttachment = useCallback(
    (attachment: AttachmentListItem) => {
      const workspacePath = attachment.workspace_path?.trim() || "";
      if (workspacePath) {
        openFileInInternalTab(workspacePath);
        return;
      }
      const file = attachment.file;
      if (!file) return;

      const existing = internalTabs.find(
        (t) => t.kind === "image" && t.id === `att-${attachment.id}`,
      );
      if (existing) {
        setActiveInternalTabId(existing.id);
        return;
      }

      const url = URL.createObjectURL(file);
      const id = `att-${attachment.id}`;
      ephemeralImageBlobUrlsRef.current.set(id, url);
      const tab = {
        id,
        kind: "image" as const,
        dataUrl: url,
        label: attachment.name || file.name || "Image",
        revokeOnClose: true,
      };
      setInternalTabs((prev) => [...prev, tab]);
      setActiveInternalTabId(id);
    },
    [internalTabs, openFileInInternalTab, setActiveInternalTabId, setInternalTabs],
  );

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-border bg-background">
      <ChatPane
        variant="embedded"
        onOpenSessions={() => setSessionsOpen(true)}
        onOpenOutput={handleOpenOutput}
        onOpenLinkInBrowser={openUrlInBrowserTab}
        onOpenLocalLink={handleOpenLocalLink}
        onPreviewImageAttachment={handlePreviewImageAttachment}
      />
    </aside>
  );
}
