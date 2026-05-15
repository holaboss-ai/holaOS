import { useAtomValue, useSetAtom } from "jotai";
import {
  ChevronDown,
  Clock3,
  Inbox,
  Loader2,
  Package,
  Plus,
  Search,
  Settings,
  Store,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { WorkspaceIconPicker } from "@/components/ui/workspace-icon-picker";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { cn } from "@/lib/utils";
import { SectionLabel } from "./shared";
import {
  appsOpenAtom,
  artifactsOpenAtom,
  automationsOpenAtom,
  createWorkspaceOpenAtom,
  inboxOpenAtom,
  marketplaceOpenAtom,
  publishOpenAtom,
  searchOpenAtom,
  sessionsOpenAtom,
  settingsOpenAtom,
  settingsSectionAtom,
} from "./state/ui";
import { useTaskProposals } from "./useTaskProposals";
import {
  useRecentBrowserHistory,
  useWorkspaceCronjobs,
  useWorkspaceSkills,
} from "./useWorkspaceLists";

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function Sidebar() {
  const { installedApps } = useWorkspaceDesktop();
  const { selectedWorkspaceId } = useWorkspaceSelection();

  const setArtifactsOpen = useSetAtom(artifactsOpenAtom);
  const setInboxOpen = useSetAtom(inboxOpenAtom);
  const setAutomationsOpen = useSetAtom(automationsOpenAtom);
  const setSessionsOpen = useSetAtom(sessionsOpenAtom);
  const setAppsOpen = useSetAtom(appsOpenAtom);
  const setMarketplaceOpen = useSetAtom(marketplaceOpenAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setSearchOpen = useSetAtom(searchOpenAtom);
  const setSettingsSection = useSetAtom(settingsSectionAtom);

  const artifactsOpen = useAtomValue(artifactsOpenAtom);
  const inboxOpen = useAtomValue(inboxOpenAtom);
  const automationsOpen = useAtomValue(automationsOpenAtom);
  const sessionsOpen = useAtomValue(sessionsOpenAtom);
  const appsOpen = useAtomValue(appsOpenAtom);
  const marketplaceOpen = useAtomValue(marketplaceOpenAtom);
  const settingsOpen = useAtomValue(settingsOpenAtom);

  const skills = useWorkspaceSkills(selectedWorkspaceId || null);
  const cronjobs = useWorkspaceCronjobs(selectedWorkspaceId || null);
  const recents = useRecentBrowserHistory(7);
  const { proposals } = useTaskProposals(selectedWorkspaceId || null);
  const unreadInbox = proposals.length;

  return (
    <aside
      data-pane-card="true"
      className="flex w-[260px] shrink-0 flex-col border-r border-border bg-card backdrop-blur-sm"
    >
      <WorkspaceSwitcher />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
        <SidebarGroup>
          <NavItem
            icon={<Search />}
            onClick={() => setSearchOpen(true)}
          >
            Search
          </NavItem>
          <NavItem
            icon={<Inbox />}
            badge={unreadInbox > 0 ? unreadInbox : undefined}
            active={inboxOpen}
            onClick={() => setInboxOpen(true)}
          >
            Inbox
          </NavItem>
          <NavItem
            icon={<Package />}
            active={artifactsOpen}
            onClick={() => setArtifactsOpen(true)}
          >
            Artifacts
          </NavItem>
        </SidebarGroup>

        {recents.length > 0 ? (
          <SidebarGroup>
            <SectionLabel>Recents</SectionLabel>
            {recents.map((entry) => (
              <RecentRow key={entry.id} entry={entry} />
            ))}
          </SidebarGroup>
        ) : null}

        {skills.length > 0 || cronjobs.length > 0 ? (
          <SidebarGroup>
            {skills.length > 0 ? (
              <SectionLabel>
                Skills
                <span className="ml-auto text-foreground/30">
                  {skills.length}
                </span>
              </SectionLabel>
            ) : null}
            {cronjobs.length > 0 ? (
              <button
                type="button"
                onClick={() => setAutomationsOpen(true)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs font-medium tracking-wide text-foreground/40 uppercase transition-colors hover:bg-foreground/[0.04]",
                  automationsOpen && "bg-foreground/[0.07]",
                )}
              >
                <span>Automations</span>
                <span className="ml-auto text-foreground/30">
                  {cronjobs.length}
                </span>
              </button>
            ) : null}
          </SidebarGroup>
        ) : null}

        <div className="mt-auto" />

        <SidebarGroup>
          <NavItem
            icon={<Wrench />}
            badge={installedApps.length > 0 ? installedApps.length : undefined}
            active={appsOpen}
            onClick={() => setAppsOpen(true)}
          >
            Apps
          </NavItem>
          <NavItem
            icon={<Store />}
            active={marketplaceOpen}
            onClick={() => setMarketplaceOpen(true)}
          >
            Marketplace
          </NavItem>
          <NavItem
            icon={<Clock3 />}
            active={sessionsOpen}
            onClick={() => setSessionsOpen(true)}
          >
            Sessions
          </NavItem>
          <NavItem
            icon={<Settings />}
            active={settingsOpen}
            onClick={() => {
              setSettingsSection("settings");
              setSettingsOpen(true);
            }}
          >
            Settings
          </NavItem>
        </SidebarGroup>
      </div>
      <AccountFoot
        onOpenAccount={() => {
          setSettingsSection("account");
          setSettingsOpen(true);
        }}
      />
    </aside>
  );
}

function RecentRow({ entry }: { entry: BrowserHistoryEntryPayload }) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const title = entry.title || hostFromUrl(entry.url) || entry.url;
  const handleOpen = async () => {
    if (selectedWorkspaceId) {
      await window.electronAPI.browser.setActiveWorkspace(
        selectedWorkspaceId,
        "user",
      );
    }
    await window.electronAPI.browser.newTab(entry.url);
  };
  return (
    <button
      type="button"
      onClick={() => void handleOpen()}
      title={title}
      className="flex items-center gap-2 rounded-[6px] px-2 py-[5px] pl-7 text-left text-xs text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
    >
      <span className="truncate">{title}</span>
    </button>
  );
}

function WorkspaceSwitcher() {
  const { selectedWorkspaceId, setSelectedWorkspaceId } =
    useWorkspaceSelection();
  const {
    workspaces,
    selectedWorkspace,
    deleteWorkspace,
    updateWorkspaceAppearance,
  } = useWorkspaceDesktop();
  const setPublishOpen = useSetAtom(publishOpenAtom);
  const setCreateWorkspaceOpen = useSetAtom(createWorkspaceOpenAtom);

  const [query, setQuery] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return workspaces;
    return workspaces.filter((w) =>
      w.name.toLowerCase().includes(trimmed),
    );
  }, [workspaces, query]);

  const handleDelete = async (workspace: WorkspaceRecordPayload) => {
    if (deletingId) return;
    if (!window.confirm(`Delete workspace '${workspace.name}'?`)) return;
    setDeletingId(workspace.id);
    try {
      await deleteWorkspace(workspace.id);
    } catch {
      // workspaceErrorMessage is already set by WorkspaceDesktopProvider
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="window-drag flex h-10 shrink-0 items-center px-2 pl-20">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="window-no-drag flex h-7 min-w-0 flex-1 justify-start gap-1.5 px-2 text-left"
            >
              {selectedWorkspace ? (
                <WorkspaceIcon
                  workspace={selectedWorkspace}
                  size="xs"
                  className="ring-1 ring-foreground/10"
                />
              ) : (
                <span
                  className="size-4 shrink-0 rounded bg-foreground/10"
                  aria-hidden
                />
              )}
              <span className="ml-1 min-w-0 flex-1 truncate font-sans text-base font-medium">
                {selectedWorkspace?.name ?? "Select workspace"}
              </span>
              <ChevronDown className="size-3 shrink-0 text-foreground/40" />
            </Button>
          }
        />
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[300px] gap-0 p-2"
          style={{
            animationDuration: "220ms",
            animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <div className="relative mb-2">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground/40" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workspaces"
              autoFocus
              className="h-8 rounded-md pl-8 text-xs focus-visible:ring-0"
            />
          </div>

          <div className="max-h-[280px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-xs text-foreground/40">
                {query ? "No matches." : "No workspaces yet."}
              </div>
            ) : (
              filtered.map((w) => {
                const isActive = w.id === selectedWorkspaceId;
                const isDeleting = deletingId === w.id;
                const folderMissing = w.folder_state === "missing";
                return (
                  <div
                    key={w.id}
                    className={cn(
                      "group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors",
                      isActive
                        ? "bg-foreground/[0.07]"
                        : "hover:bg-foreground/[0.04]",
                      isDeleting && "opacity-50",
                    )}
                  >
                    <WorkspaceIconPicker
                      workspace={w}
                      size="xs"
                      disabled={isDeleting}
                      onChange={({ icon, iconColor }) => {
                        void updateWorkspaceAppearance(w.id, {
                          icon,
                          iconColor,
                        });
                      }}
                    />
                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={() => setSelectedWorkspaceId(w.id)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm disabled:cursor-not-allowed"
                    >
                      <span className="truncate">{w.name}</span>
                      {folderMissing ? (
                        <StatusDot
                          variant="warning"
                          className="ml-auto"
                          title={`Folder missing at ${w.workspace_path ?? "unknown"}`}
                        />
                      ) : null}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${w.name}`}
                      disabled={Boolean(deletingId)}
                      onClick={() => void handleDelete(w)}
                      className="grid size-5 shrink-0 place-items-center rounded text-foreground/60 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 disabled:cursor-not-allowed group-hover:opacity-100"
                    >
                      {isDeleting ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
            {selectedWorkspaceId ? (
              <button
                type="button"
                onClick={() => setPublishOpen(true)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-foreground/[0.04]"
              >
                <Upload className="size-3.5 text-foreground/60" />
                Publish to Store
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setCreateWorkspaceOpen(true)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-foreground/[0.04]"
            >
              <Plus className="size-3.5 text-foreground/60" />
              Create new workspace
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SidebarGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 pt-3.5 first:pt-0">{children}</div>
  );
}

function NavItem({
  icon,
  badge,
  indent,
  active,
  onClick,
  children,
}: {
  icon?: React.ReactNode;
  badge?: number;
  indent?: boolean;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn(
        "h-auto justify-start gap-2 px-2 py-[5px] text-sm font-normal text-foreground",
        active && "bg-foreground/[0.07] text-foreground",
        !active && "hover:bg-foreground/[0.04]",
        indent && "pl-7",
      )}
    >
      {icon ? (
        <span
          className="grid size-3.5 shrink-0 place-items-center text-foreground/60 [&_svg]:size-3.5"
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
      <span className="flex-1 truncate text-left">{children}</span>
      {badge ? (
        <Badge className="h-4 px-1.5 text-[10px]">{badge}</Badge>
      ) : null}
    </Button>
  );
}

function AccountFoot({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { data } = useDesktopAuthSession();
  const user = data?.user ?? null;
  const label = user?.name ?? user?.email ?? "Not signed in";

  return (
    <button
      type="button"
      onClick={onOpenAccount}
      title="Open account settings"
      className="flex h-10 shrink-0 items-center gap-2 px-3 text-left transition-colors hover:bg-foreground/[0.04]"
    >
      <div className="size-5 shrink-0 overflow-hidden rounded-full ring-1 ring-inset ring-foreground/10">
        <UserAvatar user={user} />
      </div>
      <span className="flex-1 truncate text-sm">{label}</span>
    </button>
  );
}
