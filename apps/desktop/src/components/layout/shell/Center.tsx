import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Globe, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { BrowserPane } from "@/components/panes/BrowserPane";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { FileTypeIcon } from "@/lib/fileIcon";
import { cn } from "@/lib/utils";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { FilePreviewPane } from "./FilePreviewPane";
import { IssueDetailPane } from "./IssueDetailPane";
import { IssuesBoardPane } from "./IssuesBoardPane";
import { TeammatesPane } from "./TeammatesPane";
import { WorkspaceDashboardPane } from "./WorkspaceDashboardPane";
import {
  activeInternalTabIdAtom,
  fileNameFromPath,
  internalTabsAtom,
  makeInternalTabId,
} from "./state/internalTabs";
import { recentFilesAtom } from "./state/recentFiles";
import {
  browserViewSuspendedAtom,
  newTabOpenAtom,
  searchOpenAtom,
} from "./state/ui";
import { useRecentBrowserHistory } from "./useWorkspaceLists";

export function Center() {
  const { browserState } = useWorkspaceBrowser("user");
  const hasActiveTab = browserState.tabs.length > 0;
  const suspendNativeView = useAtomValue(browserViewSuspendedAtom);
  const [activeInternalTabId, setActiveInternalTabId] = useAtom(
    activeInternalTabIdAtom,
  );
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const activeInternal = activeInternalTabId
    ? internalTabs.find((t) => t.id === activeInternalTabId) ?? null
    : null;

  // Fall back to an internal tab when browser tabs are empty so we don't
  // land on NewTabLanding while file/image tabs still exist in the top bar.
  useEffect(() => {
    if (
      !hasActiveTab &&
      activeInternalTabId === null &&
      internalTabs.length > 0
    ) {
      const fallback = internalTabs[internalTabs.length - 1];
      setActiveInternalTabId(fallback.id);
    }
  }, [hasActiveTab, activeInternalTabId, internalTabs, setActiveInternalTabId]);

  const closeActiveInternalTab = useCallback(() => {
    if (!activeInternalTabId) return;
    setInternalTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === activeInternalTabId);
      const next = prev.filter((t) => t.id !== activeInternalTabId);
      const fallback = next[idx - 1] ?? next[0] ?? null;
      setActiveInternalTabId(fallback?.id ?? null);
      return next;
    });
  }, [activeInternalTabId, setActiveInternalTabId, setInternalTabs]);

  return (
    <main className="flex min-w-[480px] flex-1 flex-col overflow-hidden">
      {activeInternal ? (
        activeInternal.kind === "image" ? (
          <EphemeralImagePane
            dataUrl={activeInternal.dataUrl}
            name={activeInternal.label}
          />
        ) : activeInternal.kind === "file" ? (
          <FilePreviewPane
            filePath={activeInternal.filePath}
            onClose={closeActiveInternalTab}
          />
        ) : activeInternal.kind === "issue_detail" ? (
          <IssueDetailPane
            workspaceId={activeInternal.workspaceId}
            issueId={activeInternal.issueId}
          />
        ) : activeInternal.kind === "issues_board" ? (
          <IssuesBoardPane workspaceId={activeInternal.workspaceId} />
        ) : activeInternal.kind === "teammates" ? (
          <TeammatesPane workspaceId={activeInternal.workspaceId} />
        ) : activeInternal.kind === "workspace_dashboard" ? (
          <WorkspaceDashboardPane workspaceId={activeInternal.workspaceId} />
        ) : (
          <NewTabLanding />
        )
      ) : hasActiveTab ? (
        <BrowserPane
          variant="embedded"
          suspendNativeView={suspendNativeView}
        />
      ) : (
        <NewTabLanding />
      )}
    </main>
  );
}

function EphemeralImagePane({
  dataUrl,
  name,
}: {
  dataUrl: string;
  name: string;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-muted p-6">
      <img
        src={dataUrl}
        alt={name}
        className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
      />
    </div>
  );
}

function NewTabLanding() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { workspaces } = useWorkspaceDesktop();
  const openNewTab = useSetAtom(newTabOpenAtom);
  const openSearch = useSetAtom(searchOpenAtom);
  const setInternalTabs = useSetAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const recentFiles = useAtomValue(recentFilesAtom);
  const recentHistory = useRecentBrowserHistory(8);

  const workspaceName = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId)?.name ?? "",
    [selectedWorkspaceId, workspaces],
  );

  const workspaceRecentFiles = useMemo(() => {
    return recentFiles
      .filter((f) => f.workspaceId === selectedWorkspaceId)
      .slice(0, 5);
  }, [recentFiles, selectedWorkspaceId]);

  const recentSites = useMemo(() => recentHistory.slice(0, 5), [recentHistory]);

  const openFileTab = useCallback(
    (filePath: string, label: string) => {
      const tab = {
        id: makeInternalTabId(),
        kind: "file" as const,
        filePath,
        label,
      };
      setInternalTabs((prev) => {
        const existing = prev.find((t) => t.kind === "file" && t.filePath === filePath);
        if (existing) {
          setActiveInternalTabId(existing.id);
          return prev;
        }
        setActiveInternalTabId(tab.id);
        return [...prev, tab];
      });
    },
    [setActiveInternalTabId, setInternalTabs],
  );

  const openBrowserTab = useCallback(async (url: string) => {
    try {
      await window.electronAPI.browser.newTab(url);
    } catch {
      // non-fatal
    }
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full justify-center overflow-auto">
      <div className="flex w-full max-w-xl flex-col gap-10 px-8 pt-[22vh] pb-16">
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-foreground/40">
            Workspace
          </div>
          <div className="truncate text-xl font-medium text-foreground">
            {workspaceName || "Untitled workspace"}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <ActionTile
            icon={<Plus className="size-3.5" strokeWidth={1.75} />}
            label="New tab"
            hint="⌘T"
            onClick={() => openNewTab(true)}
          />
          <ActionTile
            icon={<Search className="size-3.5" strokeWidth={1.75} />}
            label="Search"
            hint="⌘K"
            onClick={() => openSearch(true)}
          />
        </div>

        {workspaceRecentFiles.length > 0 || recentSites.length > 0 ? (
          <div className="space-y-6">
            {workspaceRecentFiles.length > 0 ? (
              <RecentSection title="Recent files">
                {workspaceRecentFiles.map((file) => (
                  <RecentRow
                    key={file.id}
                    icon={
                      <FileTypeIcon
                        filePath={file.filePath}
                        size={14}
                        className="shrink-0 text-foreground/55"
                      />
                    }
                    primary={file.label || fileNameFromPath(file.filePath)}
                    secondary={file.filePath}
                    onClick={() =>
                      openFileTab(
                        file.filePath,
                        file.label || fileNameFromPath(file.filePath),
                      )
                    }
                  />
                ))}
              </RecentSection>
            ) : null}

            {recentSites.length > 0 ? (
              <RecentSection title="Recently visited">
                {recentSites.map((entry) => (
                  <RecentRow
                    key={entry.id}
                    icon={
                      entry.faviconUrl ? (
                        <img
                          src={entry.faviconUrl}
                          alt=""
                          className="size-3.5 shrink-0 rounded-[3px]"
                        />
                      ) : (
                        <Globe
                          className="size-3.5 shrink-0 text-foreground/45"
                          strokeWidth={1.75}
                        />
                      )
                    }
                    primary={entry.title || hostFromUrl(entry.url) || entry.url}
                    secondary={hostFromUrl(entry.url) || entry.url}
                    onClick={() => void openBrowserTab(entry.url)}
                  />
                ))}
              </RecentSection>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActionTile({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex items-center gap-2.5 rounded-md border border-border/70 bg-background px-3 py-2.5 text-left transition-colors duration-snappy ease-out-expo",
        "hover:border-border hover:bg-foreground/[0.025]",
      )}
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-foreground/[0.06] text-foreground/65 transition-colors group-hover:bg-foreground/[0.09] group-hover:text-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground/85">
        {label}
      </span>
      {hint ? (
        <span className="shrink-0 text-[10px] font-medium tracking-wide text-foreground/35">
          {hint}
        </span>
      ) : null}
    </button>
  );
}

function RecentSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="px-1 text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/40">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function RecentRow({
  icon,
  primary,
  secondary,
  onClick,
}: {
  icon: React.ReactNode;
  primary: string;
  secondary: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-snappy ease-out-expo hover:bg-foreground/[0.04]"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85">
        {primary}
      </span>
      <span className="hidden shrink-0 truncate text-[11px] text-foreground/40 sm:inline-block sm:max-w-[40%]">
        {secondary}
      </span>
    </button>
  );
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}
