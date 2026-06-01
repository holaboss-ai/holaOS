import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom, useSetAtom } from "jotai";
import {
  AppWindow,
  Bot,
  CalendarClock,
  Check,
  CircleDot,
  CornerDownLeft,
  FileText,
  FolderPlus,
  Globe,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  type LucideIcon,
  Package,
  PanelLeftClose,
  Plus,
  Settings,
  Store,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  activeInternalTabIdAtom,
  internalTabsAtom,
  upsertInternalTab,
  workspaceSurfaceTab,
} from "./state/internalTabs";
import {
  automationsOpenAtom,
  chatPanelViewAtom,
  controlCenterOpenAtom,
  createWorkspaceOpenAtom,
  marketplaceOpenAtom,
  newTabOpenAtom,
  searchOpenAtom,
  settingsOpenAtom,
  sidebarCollapsedAtom,
  sidebarSectionAtom,
} from "./state/ui";
import { useIssues } from "./useIssues";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function SearchDialog() {
  const [open, setOpen] = useAtom(searchOpenAtom);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          style={{
            animationDuration: "var(--duration-snappy)",
            animationTimingFunction: "var(--ease-out-expo)",
          }}
        />
        <DialogPrimitive.Popup
          className="fixed top-[18%] left-1/2 z-[100] w-[600px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl outline-none backdrop-blur-2xl data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          style={{
            animationDuration: "var(--duration-base)",
            animationTimingFunction: "var(--ease-out-expo)",
          }}
        >
          {open ? <SearchContent onSelect={() => setOpen(false)} /> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SearchContent({ onSelect }: { onSelect: () => void }) {
  const { workspaces, selectedWorkspace } = useWorkspaceDesktop();
  const { selectedWorkspaceId, setSelectedWorkspaceId } =
    useWorkspaceSelection();
  const { browserState: userBrowser } = useWorkspaceBrowser("user");
  const { issues } = useIssues(selectedWorkspaceId || null);
  const openIssueDetailTab = useOpenIssueDetailTab();
  const setNewTabOpen = useSetAtom(newTabOpenAtom);
  const setSidebarSection = useSetAtom(sidebarSectionAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const setAutomationsOpen = useSetAtom(automationsOpenAtom);
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setMarketplaceOpen = useSetAtom(marketplaceOpenAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setControlCenterOpen = useSetAtom(controlCenterOpenAtom);
  const setCreateWorkspaceOpen = useSetAtom(createWorkspaceOpenAtom);
  const setInternalTabs = useSetAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);

  const openWorkspaceSurface = (
    kind: "workspace_dashboard" | "issues_board" | "teammates",
  ) => {
    if (!selectedWorkspaceId) return;
    const tab = workspaceSurfaceTab(kind, selectedWorkspaceId);
    setInternalTabs((prev) => upsertInternalTab(prev, tab));
    setActiveInternalTabId(tab.id);
  };

  const close = onSelect;
  const wrap = (action: () => void) => () => {
    close();
    action();
  };

  const agentTabCount = userBrowser.tabCounts.agent;

  // Active issues first so the open work surfaces above the long tail of
  // completed/cancelled rows. Cap to keep the dialog scannable — anything
  // beyond this is better found via the board view.
  const searchableIssues = useMemo(() => {
    const sorted = [...issues].sort((a, b) => {
      const aDone = a.issue.status === "done" ? 1 : 0;
      const bDone = b.issue.status === "done" ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      return 0;
    });
    return sorted.slice(0, 25);
  }, [issues]);

  return (
    <Command className="bg-transparent">
      <CommandInput placeholder="Search issues, tabs, workspaces, or actions…" />
      <CommandList className="max-h-[460px] px-1.5 pt-1 pb-2">
        <CommandEmpty>
          <div className="px-3 py-6 text-center text-sm text-foreground/55">
            No matches.
            <span className="ml-1 text-foreground/40">
              Try a different keyword.
            </span>
          </div>
        </CommandEmpty>

        {userBrowser.tabs.length > 0 ? (
          <CommandGroup heading="Tabs">
            {userBrowser.tabs.map((tab) => (
              <TabRow
                key={`user-${tab.id}`}
                tab={tab}
                onSelect={wrap(async () => {
                  if (selectedWorkspaceId) {
                    await window.electronAPI.browser.setActiveWorkspace(
                      selectedWorkspaceId,
                      "user",
                    );
                  }
                  await window.electronAPI.browser.setActiveTab(tab.id);
                })}
              />
            ))}
          </CommandGroup>
        ) : null}

        {agentTabCount > 0 ? (
          <AgentTabsGroup
            onClose={close}
            workspaceId={selectedWorkspaceId || null}
          />
        ) : null}

        {searchableIssues.length > 0 ? (
          <CommandGroup heading="Issues">
            {searchableIssues.map(({ issue, assignee }) => (
              <IssueRow
                key={`issue-${issue.issue_id}`}
                issueId={issue.issue_id}
                title={issue.title}
                status={issue.status}
                assigneeName={assignee?.name ?? null}
                onSelect={wrap(() => {
                  if (!selectedWorkspaceId) return;
                  openIssueDetailTab({
                    workspaceId: selectedWorkspaceId,
                    issueId: issue.issue_id,
                    title: issue.title,
                  });
                })}
              />
            ))}
          </CommandGroup>
        ) : null}

        {workspaces.length > 1 ? (
          <CommandGroup heading="Workspaces">
            {workspaces.map((w) => (
              <CommandItem
                key={`ws-${w.id}`}
                value={`workspace:${w.id} ${w.name}`}
                onSelect={wrap(() => setSelectedWorkspaceId(w.id))}
                className="group/cmd-item gap-2.5 py-1.5"
              >
                <WorkspaceIcon
                  workspace={w}
                  size="xs"
                  className="ring-1 ring-foreground/10"
                />
                <span className="flex-1 truncate text-sm">{w.name}</span>
                {w.id === selectedWorkspace?.id ? (
                  <Check className="size-3.5 text-foreground/50" />
                ) : (
                  <CornerDownLeft className="size-3 text-foreground/40 opacity-0 transition-opacity duration-fast ease-out group-data-[selected=true]/cmd-item:opacity-100" />
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        <CommandGroup heading="Go to">
          <ActionItem
            label="Dashboard"
            icon={LayoutDashboard}
            onSelect={wrap(() => {
              setSidebarSection("home");
              openWorkspaceSurface("workspace_dashboard");
            })}
          />
          <ActionItem
            label="Board"
            icon={CircleDot}
            onSelect={wrap(() => {
              setSidebarSection("issues");
              openWorkspaceSurface("issues_board");
            })}
          />
          <ActionItem
            label="Teammates"
            icon={Bot}
            onSelect={wrap(() => {
              setSidebarSection("issues");
              openWorkspaceSurface("teammates");
            })}
          />
          <ActionItem
            label="Inbox"
            icon={Inbox}
            onSelect={wrap(() => setSidebarSection("inbox"))}
          />
          <ActionItem
            label="Artifacts"
            icon={Package}
            onSelect={wrap(() => setSidebarSection("artifacts"))}
          />
          <ActionItem
            label="Sessions"
            icon={FileText}
            onSelect={wrap(() => setChatPanelView("sessions"))}
          />
        </CommandGroup>

        <CommandGroup heading="Actions">
          <ActionItem
            label="New tab"
            shortcut="⌘T"
            icon={Plus}
            onSelect={wrap(() => setNewTabOpen(true))}
          />
          <ActionItem
            label="Toggle sidebar"
            shortcut="⌘\\"
            icon={PanelLeftClose}
            onSelect={wrap(() => setSidebarCollapsed((prev) => !prev))}
          />
          <ActionItem
            label="Open Control Center"
            shortcut="⌘0"
            icon={LayoutGrid}
            onSelect={wrap(() => setControlCenterOpen(true))}
          />
          <ActionItem
            label="Automations"
            icon={CalendarClock}
            onSelect={wrap(() => setAutomationsOpen(true))}
          />
          <ActionItem
            label="Marketplace"
            icon={Store}
            onSelect={wrap(() => setMarketplaceOpen(true))}
          />
          <ActionItem
            label="Settings"
            shortcut="⌘,"
            icon={Settings}
            onSelect={wrap(() => setSettingsOpen(true))}
          />
          <ActionItem
            label="Create new workspace"
            icon={FolderPlus}
            onSelect={wrap(() => setCreateWorkspaceOpen(true))}
          />
        </CommandGroup>
      </CommandList>

      <div className="flex items-center justify-between border-t border-border bg-foreground/[0.02] px-3 py-2 text-xs text-foreground/55">
        <span className="flex items-center gap-1.5">
          <span className="inline-flex gap-0.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
          navigate
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          open
          <span className="mx-1 text-foreground/35">·</span>
          <Kbd>esc</Kbd>
          close
        </span>
      </div>
    </Command>
  );
}

function AgentTabsGroup({
  onClose,
  workspaceId,
}: {
  onClose: () => void;
  workspaceId: string | null;
}) {
  const { browserState } = useWorkspaceBrowser("agent");
  if (browserState.tabs.length === 0) return null;
  return (
    <CommandGroup heading="Agent tabs">
      {browserState.tabs.map((tab) => (
        <TabRow
          key={`agent-${tab.id}`}
          tab={tab}
          driverLabel="agent"
          onSelect={async () => {
            onClose();
            if (workspaceId) {
              await window.electronAPI.browser.setActiveWorkspace(
                workspaceId,
                "agent",
              );
            }
            await window.electronAPI.browser.setActiveTab(tab.id);
          }}
        />
      ))}
    </CommandGroup>
  );
}

function isLocalHost(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1" ||
      u.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function TabFavicon({
  faviconUrl,
  url,
}: {
  faviconUrl: string | null | undefined;
  url: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [faviconUrl]);

  const Fallback = isLocalHost(url) ? AppWindow : Globe;
  if (!faviconUrl || failed) {
    return <Fallback />;
  }
  return (
    <img
      src={faviconUrl}
      alt=""
      className="size-3.5 rounded-[2px] object-contain"
      onError={() => setFailed(true)}
    />
  );
}

// Shared chip surface for any row that needs a square icon-on-tinted-
// surface lead glyph (tabs, actions). Issues use StatusDot + bare title
// instead so they read like a list of work, not a list of buttons.
function RowIconChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-[5px] bg-foreground/[0.06] text-foreground/55 ring-1 ring-inset ring-foreground/5 [&_svg]:size-3"
    >
      {children}
    </span>
  );
}

function TabRow({
  tab,
  driverLabel,
  onSelect,
}: {
  tab: BrowserStatePayload;
  driverLabel?: "agent";
  onSelect: () => void;
}) {
  const title = tab.title || hostFromUrl(tab.url) || "New Tab";
  const host = hostFromUrl(tab.url) || tab.url;
  return (
    <CommandItem
      value={`${driverLabel ?? "user"}-tab:${tab.id} ${title} ${host}`}
      onSelect={() => void onSelect()}
      className="group/cmd-item gap-2.5 py-1.5"
    >
      <RowIconChip>
        <TabFavicon faviconUrl={tab.faviconUrl} url={tab.url} />
      </RowIconChip>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-sm">{title}</span>
        <span className="truncate text-xs text-foreground/55">{host}</span>
      </span>
      {driverLabel === "agent" ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-primary"
          title="Agent driving"
        />
      ) : null}
      <CornerDownLeft className="size-3 text-foreground/40 opacity-0 transition-opacity duration-fast ease-out group-data-[selected=true]/cmd-item:opacity-100" />
    </CommandItem>
  );
}

function IssueRow({
  issueId,
  title,
  status,
  assigneeName,
  onSelect,
}: {
  issueId: string;
  title: string;
  status: IssueStatusPayload;
  assigneeName: string | null;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`issue:${issueId} ${title} ${assigneeName ?? ""}`}
      onSelect={onSelect}
      className="group/cmd-item gap-2.5 py-1.5"
    >
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center"
      >
        <StatusDot
          variant={issueStatusVariant(status)}
          size="md"
          pulse={status === "in_progress"}
        />
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2 leading-tight">
        <span className="shrink-0 text-xs tabular-nums text-foreground/45">
          {issueId}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">
          {title || "Untitled issue"}
        </span>
      </span>
      {assigneeName ? (
        <span className="shrink-0 text-xs text-foreground/55">
          {assigneeName}
        </span>
      ) : null}
      <CornerDownLeft className="size-3 text-foreground/40 opacity-0 transition-opacity duration-fast ease-out group-data-[selected=true]/cmd-item:opacity-100" />
    </CommandItem>
  );
}

function ActionItem({
  label,
  shortcut,
  icon: Icon,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  icon: LucideIcon;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`action ${label}`}
      onSelect={onSelect}
      className="group/cmd-item gap-2.5 py-1.5"
    >
      <RowIconChip>
        <Icon />
      </RowIconChip>
      <span className="flex-1 truncate text-sm">{label}</span>
      {shortcut ? (
        <span className="text-xs text-foreground/55">{shortcut}</span>
      ) : null}
      <CornerDownLeft className="size-3 text-foreground/40 opacity-0 transition-opacity duration-fast ease-out group-data-[selected=true]/cmd-item:opacity-100" />
    </CommandItem>
  );
}

// Same mapping as Sidebar's IssueListRow. Kept local so SearchDialog
// doesn't reach into Sidebar internals; both are 5-case switches and
// will rarely diverge.
function issueStatusVariant(
  status: IssueStatusPayload,
): "success" | "warning" | "info" | "primary" | "muted" {
  switch (status) {
    case "done":
      return "success";
    case "blocked":
      return "warning";
    case "in_progress":
      return "primary";
    case "in_review":
      return "info";
    case "backlog":
      return "muted";
    default:
      return "info";
  }
}
