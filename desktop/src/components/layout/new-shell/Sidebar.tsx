import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Globe,
  Inbox,
  Loader2,
  MoreHorizontal,
  Package,
  Plus,
  RotateCw,
  Search,
  Settings,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { WorkspaceIconPicker } from "@/components/ui/workspace-icon-picker";
import { AppIcon } from "@/components/marketplace/AppIcon";
import type { WorkspaceInstalledAppDefinition } from "@/lib/workspaceApps";
import { resolveAppDisplay, useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { cn } from "@/lib/utils";
import { SectionLabel } from "./shared";
import {
  appsExpandedAtom,
  artifactsOpenAtom,
  automationsOpenAtom,
  createWorkspaceOpenAtom,
  inboxOpenAtom,
  marketplaceOpenAtom,
  publishOpenAtom,
  searchOpenAtom,
  settingsOpenAtom,
  settingsSectionAtom,
  sidebarCollapsedAtom,
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

const SIDEBAR_WIDTH = 260;

export function Sidebar() {
  const collapsed = useAtomValue(sidebarCollapsedAtom);
  return (
    <div
      className="flex shrink-0 overflow-hidden transition-[width] duration-stride ease-out-expo"
      style={{ width: collapsed ? 0 : SIDEBAR_WIDTH }}
    >
      <SidebarExpanded />
    </div>
  );
}

function SidebarExpanded() {
  const { selectedWorkspaceId } = useWorkspaceSelection();

  const setArtifactsOpen = useSetAtom(artifactsOpenAtom);
  const setInboxOpen = useSetAtom(inboxOpenAtom);
  const setAutomationsOpen = useSetAtom(automationsOpenAtom);
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setSearchOpen = useSetAtom(searchOpenAtom);
  const setSettingsSection = useSetAtom(settingsSectionAtom);

  const artifactsOpen = useAtomValue(artifactsOpenAtom);
  const inboxOpen = useAtomValue(inboxOpenAtom);
  const automationsOpen = useAtomValue(automationsOpenAtom);
  const settingsOpen = useAtomValue(settingsOpenAtom);

  const skills = useWorkspaceSkills(selectedWorkspaceId || null);
  const cronjobs = useWorkspaceCronjobs(selectedWorkspaceId || null);
  const recents = useRecentBrowserHistory(7);
  const { proposals } = useTaskProposals(selectedWorkspaceId || null);
  const unreadInbox = proposals.length;

  return (
    <aside
      data-pane-card="true"
      data-pane-role="sidebar"
      className="flex h-full w-[260px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground backdrop-blur-sm"
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
          <AppsSection />
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
    </aside>
  );
}

function AppsSection() {
  const {
    installedApps,
    appCatalog,
    composioToolkitsByProvider,
    removeInstalledApp,
  } = useWorkspaceDesktop();
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const [expanded, setExpanded] = useAtom(appsExpandedAtom);
  const setMarketplaceOpen = useSetAtom(marketplaceOpenAtom);

  const openApp = async (appId: string) => {
    if (!selectedWorkspaceId) return;
    try {
      const url = await window.electronAPI.appSurface.resolveUrl(
        selectedWorkspaceId,
        appId,
      );
      await window.electronAPI.browser.setActiveWorkspace(
        selectedWorkspaceId,
        "user",
      );
      await window.electronAPI.browser.newTab(url);
    } catch {
      // status pip on the row already reflects non-ready apps
    }
  };

  const reloadApp = async (appId: string) => {
    try {
      await window.electronAPI.appSurface.reload(appId);
    } catch {
      // fall through; status pip will re-reflect once lifecycle settles
    }
  };

  const uninstallApp = async (appId: string, label: string) => {
    if (!window.confirm(`Uninstall '${label}'?`)) return;
    try {
      await removeInstalledApp(appId);
    } catch {
      // error surface lives in the workspace context; nothing useful here
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto justify-start gap-2 px-2 py-[5px] text-sm font-normal text-foreground hover:bg-foreground/[0.04]"
      >
        <Wrench className="size-3.5 shrink-0 text-foreground/60" />
        <span className="flex-1 truncate text-left">Apps</span>
        {installedApps.length > 0 ? (
          <span className="text-xs text-foreground/40">
            {installedApps.length}
          </span>
        ) : null}
        <ChevronRight
          className="size-3.5 shrink-0 text-foreground/40 transition-transform duration-snappy ease-emphasized"
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        />
      </Button>

      <div
        aria-hidden={!expanded}
        className="grid transition-[grid-template-rows] duration-base ease-emphasized"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div
            className="flex flex-col gap-0.5 pt-0.5 transition-opacity duration-snappy ease-emphasized"
            style={{ opacity: expanded ? 1 : 0 }}
          >
            {installedApps.map((app) => {
              const providerId =
                appCatalog.find((c) => c.app_id === app.id)?.provider_id ??
                null;
              const display = resolveAppDisplay(
                providerId,
                composioToolkitsByProvider,
              );
              const label = display.name ?? app.label;
              const error = app.error?.trim();
              const status: "ready" | "loading" | "error" = error
                ? "error"
                : app.ready
                  ? "ready"
                  : "loading";
              return (
                <AppRow
                  key={app.id}
                  app={app}
                  label={label}
                  providerId={providerId}
                  iconUrl={display.logo}
                  status={status}
                  errorMessage={error || null}
                  expanded={expanded}
                  onOpen={() => void openApp(app.id)}
                  onReload={() => void reloadApp(app.id)}
                  onUninstall={() => void uninstallApp(app.id, label)}
                />
              );
            })}
            <button
              type="button"
              onClick={() => setMarketplaceOpen(true)}
              tabIndex={expanded ? 0 : -1}
              className="flex items-center gap-2 rounded-[6px] px-2 py-[5px] pl-6 text-left text-xs text-foreground/55 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
            >
              <Plus className="size-3.5 shrink-0" />
              <span className="truncate">Browse marketplace</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function AppRow({
  app,
  label,
  providerId,
  iconUrl,
  status,
  errorMessage,
  expanded,
  onOpen,
  onReload,
  onUninstall,
}: {
  app: WorkspaceInstalledAppDefinition;
  label: string;
  providerId: string | null;
  iconUrl: string | null;
  status: "ready" | "loading" | "error";
  errorMessage: string | null;
  expanded: boolean;
  onOpen: () => void;
  onReload: () => void;
  onUninstall: () => void;
}) {
  const tooltip =
    status === "error" && errorMessage
      ? errorMessage
      : status === "loading"
        ? `${label} — starting…`
        : app.summary || label;
  return (
    <div
      role="group"
      className="group/app-row relative flex items-center rounded-[6px] transition-colors hover:bg-foreground/[0.04]"
    >
      <button
        type="button"
        onClick={() => {
          if (status === "ready") onOpen();
        }}
        tabIndex={expanded ? 0 : -1}
        title={tooltip}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 py-[5px] pl-6 text-left text-xs text-foreground/80 transition-colors disabled:cursor-default"
      >
        <AppIcon
          iconUrl={iconUrl}
          appId={app.id}
          providerId={providerId}
          label={label}
          size="row"
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            status === "error" && "text-foreground/55",
          )}
        >
          {label}
        </span>
        {status === "loading" ? (
          <StatusDot variant="info" pulse title="Starting" />
        ) : null}
        {status === "error" ? (
          <StatusDot
            variant="destructive"
            title={errorMessage || "Error"}
          />
        ) : null}
      </button>
      <div
        aria-hidden
        className="mr-0 w-0 shrink-0 overflow-hidden transition-[width,margin-right] duration-200 ease-out-expo group-hover/app-row:mr-1 group-hover/app-row:w-5 group-has-[[aria-expanded=true]]/app-row:mr-1 group-has-[[aria-expanded=true]]/app-row:w-5"
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="App actions"
                tabIndex={expanded ? 0 : -1}
                onClick={(e) => e.stopPropagation()}
                className="grid size-5 place-items-center rounded text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
            <DropdownMenuItem
              onClick={onOpen}
              disabled={status !== "ready"}
            >
              <Plus className="size-3.5" />
              Open in new tab
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onReload}>
              <RotateCw className="size-3.5" />
              Reload
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onUninstall} variant="destructive">
              <Trash2 className="size-3.5" />
              Uninstall
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function RecentRow({ entry }: { entry: BrowserHistoryEntryPayload }) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const title = entry.title || hostFromUrl(entry.url) || entry.url;
  const [faviconError, setFaviconError] = useState(false);
  const showFavicon = Boolean(entry.faviconUrl) && !faviconError;

  const handleOpen = async () => {
    if (selectedWorkspaceId) {
      await window.electronAPI.browser.setActiveWorkspace(
        selectedWorkspaceId,
        "user",
      );
    }
    await window.electronAPI.browser.newTab(entry.url);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(entry.url);
    } catch {
      // tolerate clipboard rejection — non-fatal
    }
  };

  const handleRemove = async () => {
    try {
      await window.electronAPI.browser.removeHistoryEntry(entry.id);
    } catch {
      // history list will refresh on the next event
    }
  };

  return (
    <div
      role="group"
      className="group/recent relative flex items-center rounded-[6px] transition-colors hover:bg-foreground/[0.04]"
    >
      <button
        type="button"
        onClick={() => void handleOpen()}
        title={title}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-xs text-foreground/70"
      >
        <span
          aria-hidden
          className="grid size-3.5 shrink-0 place-items-center overflow-hidden rounded-[3px] text-foreground/55"
        >
          {showFavicon ? (
            <img
              src={entry.faviconUrl}
              alt=""
              className="size-3.5 rounded-[2px] object-contain"
              onError={() => setFaviconError(true)}
            />
          ) : (
            <Globe className="size-3" />
          )}
        </span>
        <span className="truncate">{title}</span>
      </button>
      <div
        aria-hidden
        className="mr-0 w-0 shrink-0 overflow-hidden transition-[width,margin-right] duration-200 ease-out-expo group-hover/recent:mr-1 group-hover/recent:w-5 group-has-[[aria-expanded=true]]/recent:mr-1 group-has-[[aria-expanded=true]]/recent:w-5"
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="Recent actions"
                onClick={(e) => e.stopPropagation()}
                className="grid size-5 place-items-center rounded text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
            <DropdownMenuItem onClick={() => void handleOpen()}>
              <Plus className="size-3.5" />
              Open in new tab
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleCopy()}>
              <Copy className="size-3.5" />
              Copy URL
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void handleRemove()}
              variant="destructive"
            >
              <Trash2 className="size-3.5" />
              Remove from history
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
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
            animationDuration: "var(--duration-base)",
            animationTimingFunction: "var(--ease-out-expo)",
          }}
        >
          <div className="relative mb-2">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground/40" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search workspaces"
              autoFocus
              className="h-8 rounded-md pl-8 text-xs"
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
        indent && "pl-6",
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

