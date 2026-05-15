import { useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { ChatPane } from "@/components/panes/ChatPane";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { sessionsOpenAtom } from "./state/ui";

export function ChatPanel() {
  const setSessionsOpen = useSetAtom(sessionsOpenAtom);
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { installedApps } = useWorkspaceDesktop();

  const installedAppIds = useMemo(
    () => new Set(installedApps.map((a) => a.id)),
    [installedApps],
  );

  const openInTab = useCallback(
    async (url: string) => {
      if (!selectedWorkspaceId || !url.trim()) return;
      try {
        await window.electronAPI.browser.setActiveWorkspace(
          selectedWorkspaceId,
          "user",
        );
        await window.electronAPI.browser.newTab(url);
      } catch {
        // non-fatal; user can retry
      }
    },
    [selectedWorkspaceId],
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
          await openInTab(url);
        } catch {
          // fall through to file_path fallback
        }
        return;
      }
      if (output.file_path) {
        await openInTab(`file://${encodeURI(output.file_path)}`);
      }
    },
    [selectedWorkspaceId, installedAppIds, openInTab],
  );

  const handleOpenLocalLink = useCallback(
    async (href: string) => {
      let raw = href.trim();
      if (!raw) return;
      if (raw.toLowerCase().startsWith("file://")) raw = raw.slice(7);
      let decoded = raw;
      try {
        decoded = decodeURI(raw);
      } catch {
        // tolerate already-decoded inputs
      }
      await openInTab(`file://${encodeURI(decoded)}`);
    },
    [openInTab],
  );

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-border bg-background">
      <ChatPane
        variant="embedded"
        onOpenSessions={() => setSessionsOpen(true)}
        onOpenOutput={handleOpenOutput}
        onOpenLinkInBrowser={openInTab}
        onOpenLocalLink={handleOpenLocalLink}
      />
    </aside>
  );
}
