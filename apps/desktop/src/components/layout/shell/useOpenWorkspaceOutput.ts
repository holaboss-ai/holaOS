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
import { pushRecentOutputAtom } from "./state/recentOutputs";
import { markOutputSeenAtom } from "./state/seen-outputs";
import {
  activeWebAppSurfaceAtom,
  focusModeAtom,
  projectViewAtom,
  workspaceOverlayAtom,
} from "./state/ui";

export function findBrowserTabMatch(
  tabs: ReadonlyArray<{ id: string; url: string }>,
  url: string,
  dedupBy: "exact" | "origin",
): { id: string; url: string } | null {
  if (dedupBy === "origin") {
    const targetOrigin = safeOrigin(url);
    if (!targetOrigin) return null;
    return tabs.find((t) => safeOrigin(t.url) === targetOrigin) ?? null;
  }
  return tabs.find((t) => t.url === url) ?? null;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// output.file_path is workspace-relative; convert to absolute by joining
// with the workspace root. Already-absolute paths (with a POSIX leading
// `/` or a Windows drive letter) pass through unchanged.
function resolveWorkspaceRelativePath(
  filePath: string,
  workspaceRoot: string | null,
): string {
  const trimmed = filePath.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }
  const root = (workspaceRoot ?? "").trim().replace(/[\\/]+$/, "");
  if (!root) return trimmed;
  return `${root}/${trimmed}`;
}

/**
 * Shared "open this workspace output" handler. Resolves module-backed
 * outputs to an app-surface URL (opened as a browser tab) and file-backed
 * outputs to an internal file tab. Used by both the chat pane's
 * `onOpenOutput` plumbing and the sidebar Artifacts list.
 */
export function useOpenWorkspaceOutput() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { installedApps, selectedWorkspace } = useWorkspaceDesktop();
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const pushRecentFile = useSetAtom(pushRecentFileAtom);
  const pushRecentOutput = useSetAtom(pushRecentOutputAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);
  const markOutputSeen = useSetAtom(markOutputSeenAtom);

  const installedAppIds = useMemo(
    () => new Set(installedApps.map((a) => a.id)),
    [installedApps],
  );

  const openUrlInBrowserTab = useCallback(
    async (
      url: string,
      _opts?: { forceNewTab?: boolean; dedupBy?: "exact" | "origin" },
    ) => {
      if (!url.trim()) return;
      // Generic (non-HolaApp) links open in the Default Browser Profile's own
      // window — a Holaboss-managed Chrome — NEVER the OS default browser.
      // (HolaApp outputs go to the app-surface; see openOutput.)
      await window.electronAPI.profiles
        .launch("bprofile_default", url)
        .catch(() => {});
    },
    [],
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
      setProjectView(null);
      setWorkspaceOverlay(null);
      setFocusMode(false);
      // Opening a browser tab / file takes the center column — dismiss any
      // web HolaApp surface that was occupying it.
      setActiveWebAppSurface(null);
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
      setActiveWebAppSurface,
      setFocusMode,
      setProjectView,
      setWorkspaceOverlay,
      selectedWorkspaceId,
      setActiveInternalTabId,
      setInternalTabs,
    ],
  );

  const openOutput = useCallback(
    async (output: WorkspaceOutputRecordPayload) => {
      if (!selectedWorkspaceId) return;
      markOutputSeen(output);
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
        // Module/app outputs open in the app-surface (the same native surface
        // HolaApps use), not the retired in-app browser.
        setProjectView(null);
        setWorkspaceOverlay(null);
        setFocusMode(false);
        setActiveInternalTabId(null);
        setActiveWebAppSurface({
          holaAppId: moduleId,
          title: output.title?.trim() || moduleId,
          ...(path ? { path } : {}),
        });
        pushRecentOutput({
          outputId: output.id,
          workspaceId: selectedWorkspaceId,
          label: output.title?.trim() || moduleId,
          moduleId: output.module_id ?? null,
          moduleResourceId: output.module_resource_id ?? null,
          outputType: output.output_type,
          metadata: (output.metadata ?? {}) as Record<string, unknown>,
          updatedAt: output.updated_at,
        });
        return;
      }
      if (output.file_path) {
        // output.file_path is workspace-relative (e.g. "intro.docx").
        // openFileInInternalTab + downstream consumers (recent files,
        // attachment staging) expect an absolute on-disk path. Join with
        // the workspace's root before opening so an `@<file>` mention can
        // round-trip back to a real stat() call later.
        openFileInInternalTab(
          resolveWorkspaceRelativePath(
            output.file_path,
            selectedWorkspace?.workspace_path ?? null,
          ),
        );
      }
    },
    [
      selectedWorkspaceId,
      selectedWorkspace?.workspace_path,
      installedAppIds,
      openFileInInternalTab,
      markOutputSeen,
      pushRecentOutput,
      setActiveWebAppSurface,
      setActiveInternalTabId,
      setProjectView,
      setWorkspaceOverlay,
      setFocusMode,
    ],
  );

  return {
    openOutput,
    openUrlInBrowserTab,
    openFileInInternalTab,
  };
}
