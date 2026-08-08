import { billingRpcFetch } from "@/lib/app-sdk-client";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { listDisplayOutputs } from "@/lib/outputs";
import { remoteApi } from "@/lib/remoteApiClient";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { OutputArtifactIcon } from "@/components/panes/ChatPane/ArtifactBrowserModal";
import { slugifyFilePathForMention } from "@/components/panes/ChatPane/helpers";
import { useReferenceFileInChat } from "./useReferenceFileInChat";
import { SidebarEmployeesSection } from "./SidebarEmployeesSection";
import { selectedEmployeeAtom } from "./state/employees";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RenameDialog } from "@/components/ui/rename-dialog";
import {
  ArrowUpRight,
  BuildingFilled,
  Check,
  ChevronDownFilled,
  ChevronRight,
  ChevronUp,
  CircleDotFilled,
  CircleUserRound,
  CompassFilled,
  FolderFilled,
  GlobeFilled,
  HomeFilled,
  Loader2,
  MessageCircleFilled,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  PlusCircleFilled,
  PlusFilled,
  SearchFilled,
  GridFilled,
  GiftFilled,
  SettingsFilled,
  UsersFilled,
  Users,
  WrenchFilled,
  Trash2,
  XFilled,
  ZapFilled,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { StatusDot } from "@/components/ui/status-dot";
import { FileTypeIcon } from "@/lib/fileIcon";
import { useStoplightCompensation } from "@/lib/StoplightContext";
import { useIntegrationBinding } from "@/lib/useIntegrationBinding";
import { cn } from "@/lib/utils";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { appKind, catalogEntryToOpenParams } from "@/lib/holaAppMarketplace";
import { useQuery } from "@tanstack/react-query";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  acceleratorGlyph,
  modifierKeyLabel,
  SHORTCUT_ACCELERATORS,
} from "./keyboardShortcuts";
import {
  type FavoriteItem,
  favoriteKey,
  favoritesForWorkspaceAtom,
  isFavoriteAtom,
  moveFavoriteAtom,
  toggleFavoriteAtom,
} from "./state/favorites";
import {
  activeInternalTabIdAtom,
  fileNameFromPath,
  type InternalTab,
  internalTabsAtom,
  makeInternalTabId,
} from "./state/internalTabs";
import {
  activeWebAppSurfaceAtom,
  chatPanelViewAtom,
  chatSessionOpenRequestAtom,
  collapsedSessionGroupsAtom,
  customizeTabAtom,
  focusModeAtom,
  orgSwitchingAtom,
  holahubPendingPathAtom,
  projectViewAtom,
  searchOpenAtom,
  selectedSessionIdAtom,
  sessionLastViewedAtAtom,
  settingsOpenAtom,
  settingsSectionAtom,
  SIDEBAR_DEFAULT_WIDTH,
  type CloudSection,
  cloudSectionAtom,
  SIDEBAR_MAX_WIDTH,
  cloudModeEnabledAtom,
  SIDEBAR_MIN_WIDTH,
  sidebarCollapsedAtom,
  type SidebarMode,
  sidebarModeAtom,
  sidebarWidthAtom,
  workspaceOverlayAtom,
  type WorkspaceOverlay,
} from "./state/ui";
import { useStartNewChat } from "./useStartNewChat";
import { HolaAppIcon } from "./HolaAppIcon";
import { UpdateReadyButton } from "./UpdateReadyButton";
import { useHolaAppCatalog } from "./useHolaAppCatalog";
import { useOpenHolaApp } from "./useOpenHolaApp";
import { usePrewarmEmployeeSurface } from "./usePrewarmEmployeeSurface";
import {
  isPersonalOrg,
  orgLabel,
  useOrganizations,
} from "@/lib/auth/useOrganizations";
import { useOpenHolaAppDraftChat } from "./useOpenHolaAppDraftChat";
import { useIssues } from "./useIssues";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";
import {
  useWorkspaceMainSessions,
  useWorkspaceProjects,
} from "./useWorkspaceLists";

export function Sidebar() {
  const collapsed = useAtomValue(sidebarCollapsedAtom);
  const width = useAtomValue(sidebarWidthAtom);
  // Warm the HolaEmployee surface in the background once it's available, so the
  // first open is instant (see usePrewarmEmployeeSurface). Sidebar is always
  // mounted, so this fires regardless of which nav section holds the entry.
  usePrewarmEmployeeSurface();
  return (
    <div
      className="relative flex shrink-0 overflow-hidden transition-[width] duration-stride ease-out-expo"
      style={{ width: collapsed ? 0 : width }}
    >
      <SidebarExpanded />
      {!collapsed ? <SidebarResizeHandle /> : null}
    </div>
  );
}

function SidebarResizeHandle() {
  const [width, setWidth] = useAtom(sidebarWidthAtom);
  const draggingRef = useRef(false);
  const [hovering, setHovering] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const startX = e.clientX;
      const startWidth = width;
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const next = Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, startWidth + (ev.clientX - startX)),
        );
        setWidth(next);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setWidth, width],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onDoubleClick={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
      className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize select-none"
    >
      <div
        className={cn(
          "absolute top-0 right-0 h-full w-px bg-primary/60 transition-opacity duration-snappy ease-emphasized",
          hovering || draggingRef.current ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
// The Local ⇄ Employee segmented switch at the very top of the sidebar. Switching
// leaves a clean slate and lands each mode on its own Home surface; the choice
// persists across launches (sidebarModeAtom).
function SidebarModeToggle() {
  const [mode, setMode] = useAtom(sidebarModeAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setSelectedEmployee = useSetAtom(selectedEmployeeAtom);

  const switchMode = (next: SidebarMode) => {
    if (next === mode) {
      return;
    }
    setSelectedEmployee(null);
    setSelectedSessionId(null);
    setProjectView(null);
    setWorkspaceOverlay(next === "employee" ? "holaemployee" : "holahub");
    setMode(next);
  };

  return (
    <div className="mx-2 my-2 grid grid-cols-2 gap-0.5 rounded-lg bg-foreground/5 p-0.5">
      {(["local", "employee"] as const).map((m) => (
        <button
          className={cn(
            "h-7 rounded-md font-medium text-xs transition-colors",
            mode === m
              ? "bg-sidebar text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          key={m}
          onClick={() => switchMode(m)}
          type="button"
        >
          {m === "local" ? "Local" : "Employee"}
        </button>
      ))}
    </div>
  );
}

// Employee-mode content: a "Home" nav that opens the HolaEmployee page (the old
// standalone HolaEmployee row, relocated here), then the employee roster + threads.
// No workspace "New chat" here — starting an employee chat lives on each employee row.
function SidebarEmployeeMode() {
  const [workspaceOverlay, setWorkspaceOverlay] = useAtom(workspaceOverlayAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const setSelectedEmployee = useSetAtom(selectedEmployeeAtom);
  const [cloudSection, setCloudSection] = useAtom(cloudSectionAtom);
  // Members is a team concern — in a personal space (team of one) there's no one to
  // manage, so the row is hidden until you invite people.
  const { isPersonal } = useOrganizations();
  // Every section is the SAME embedded web surface (holaemployee) at a different
  // ?section= — the web Cloud Home hides its own nav in the desktop and this rail
  // drives it. So each row opens holaemployee and just sets the section.
  const openCloudSection = (next: CloudSection) => {
    setProjectView(null);
    setSelectedEmployee(null);
    setCloudSection(next);
    setWorkspaceOverlay("holaemployee");
  };
  const isActive = (id: CloudSection) =>
    workspaceOverlay === "holaemployee" && cloudSection === id;
  return (
    <>
      <div className="mb-1 flex flex-col gap-0.5 px-2 pt-1">
        <TeamNavRow
          active={isActive("home")}
          icon={<HomeFilled />}
          label="Home"
          onClick={() => openCloudSection("home")}
        />
        <TeamNavRow
          active={isActive("catalog")}
          icon={<GridFilled />}
          label="Marketplace"
          onClick={() => openCloudSection("catalog")}
        />
        {isPersonal ? null : (
          <TeamNavRow
            active={isActive("members")}
            icon={<UsersFilled />}
            label="Members"
            onClick={() => openCloudSection("members")}
          />
        )}
      </div>
      <SidebarEmployeesSection />
    </>
  );
}

function SidebarExpanded() {
  // macOS reserves an empty top band so the search bar clears the traffic-
  // light buttons, with the collapse toggle pinned to that band's right edge.
  // Windows/Linux put their window controls at the top-right over the main
  // area — nothing sits over the sidebar's top — so that band is dead space.
  // There we drop it and fold the collapse toggle into the search row instead.
  const reserveStoplightGutter = useStoplightCompensation();
  // Personal app-store installs are a personal-context concern — shown only in a
  // personal space, not when the desktop is scoped to a real org.
  const { isPersonal } = useOrganizations();
  const cloudModeEnabled = useAtomValue(cloudModeEnabledAtom);
  const storedMode = useAtomValue(sidebarModeAtom);
  // Cloud mode is experimental + off by default. When off, hide the Local/Cloud
  // switcher and pin the sidebar to Local (a persisted "employee" choice must not
  // strand the user in a mode with no way back).
  const mode = cloudModeEnabled ? storedMode : "local";
  return (
    <aside
      data-pane-card="true"
      data-pane-role="sidebar"
      className="flex h-full w-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground backdrop-blur-sm"
    >
      {reserveStoplightGutter ? (
        <SidebarTitleBarSpacer />
      ) : (
        <SidebarSearchBellRow inlineToggle />
      )}
      {/* scrollbar-gutter:stable reserves the scrollbar's width even when the
          list doesn't overflow, so the nav + sticky switcher keep the same
          right inset in Employee mode (short, no scrollbar) as in Local mode
          (long, scrollbar shown) — otherwise the two modes look uneven. */}
      <div className="chat-scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto pb-2 [scrollbar-gutter:stable]">
        {/* Pinned inside the scroll container so it shares the list's scrollbar
            inset — keeping the switcher edge-aligned with the New chat / nav
            pills regardless of the scrollbar width. */}
        {cloudModeEnabled ? (
          <div className="sticky top-0 z-10 flex flex-col bg-sidebar">
            <SidebarModeToggle />
          </div>
        ) : null}
        {mode === "local" ? (
          <>
            <SidebarWorkspaceSection />
            {isPersonal ? <SidebarHolaAppsSection /> : null}
            <SidebarPinnedSection />
            <SidebarPersonalDivider />
            <SidebarSessionsSection />
          </>
        ) : (
          <SidebarEmployeeMode />
        )}
      </div>
      <SidebarGlobalFooter />
    </aside>
  );
}

// DataTransfer MIME carrying a dragged pinned item's id so dropping it on
// another pinned row reorders the flat list.
const PINNED_MOVE_DRAG_TYPE = "application/x-holaboss-pinned-move";

function FavoriteRow({ item }: { item: FavoriteItem }) {
  const toggleFavorite = useSetAtom(toggleFavoriteAtom);
  const moveFavorite = useSetAtom(moveFavoriteAtom);
  const openIssueDetailTab = useOpenIssueDetailTab();
  const { openOutput, openUrlInBrowserTab } = useOpenWorkspaceOutput();
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const [faviconError, setFaviconError] = useState(false);
  const [dropEdge, setDropEdge] = useState<"before" | "after" | null>(null);

  const handleOpen = useCallback(() => {
    if (item.kind === "issue") {
      openIssueDetailTab({
        workspaceId: item.workspaceId,
        issueId: item.issueId,
        title: item.title,
      });
      return;
    }
    if (item.kind === "file") {
      const existing = internalTabs.find(
        (t) => t.kind === "file" && t.filePath === item.filePath,
      );
      if (existing) {
        setActiveInternalTabId(existing.id);
        return;
      }
      const tab = {
        id: makeInternalTabId(),
        kind: "file" as const,
        filePath: item.filePath,
        label: item.label || fileNameFromPath(item.filePath),
      };
      setInternalTabs((prev) => [...prev, tab]);
      setActiveInternalTabId(tab.id);
      return;
    }
    if (item.kind === "output") {
      // Re-fetch the live payload so URL / file resolution uses the
      // current module routes, not the snapshot at star time. If the
      // output has been deleted between star and click, silently no-op
      // — the entry stays in Favorites so the user can prune it.
      void (async () => {
        try {
          const result = await listDisplayOutputs({
            limit: 500,
          });
          const found = result.items?.find((o) => o.id === item.outputId);
          if (found) {
            await openOutput(found);
          }
        } catch {
          // non-fatal
        }
      })();
      return;
    }
    if (item.kind === "app") {
      void (async () => {
        try {
          const url = await window.electronAPI.appSurface.resolveUrl(
            item.workspaceId,
            item.appId,
          );
          await openUrlInBrowserTab(url, { dedupBy: "origin" });
        } catch {
          // app may not be ready; the row stays for a retry
        }
      })();
      return;
    }
    openUrlInBrowserTab(item.url);
  }, [
    item,
    internalTabs,
    openIssueDetailTab,
    openOutput,
    openUrlInBrowserTab,
    setActiveInternalTabId,
    setInternalTabs,
  ]);

  const handleRemove = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (item.kind === "issue") {
        toggleFavorite({
          kind: "issue",
          workspaceId: item.workspaceId,
          issueId: item.issueId,
          title: item.title,
        });
      } else if (item.kind === "file") {
        toggleFavorite({
          kind: "file",
          workspaceId: item.workspaceId,
          filePath: item.filePath,
          label: item.label,
        });
      } else if (item.kind === "output") {
        toggleFavorite({
          kind: "output",
          workspaceId: item.workspaceId,
          outputId: item.outputId,
          title: item.title,
        });
      } else if (item.kind === "app") {
        toggleFavorite({
          kind: "app",
          workspaceId: item.workspaceId,
          appId: item.appId,
          label: item.label,
        });
      } else {
        toggleFavorite({
          kind: "url",
          url: item.url,
          title: item.title,
          faviconUrl: item.faviconUrl,
        });
      }
    },
    [item, toggleFavorite],
  );

  const label =
    item.kind === "issue"
      ? item.title || "Untitled issue"
      : item.kind === "file"
        ? item.label
        : item.kind === "output"
          ? item.title || "Untitled artifact"
          : item.kind === "app"
            ? item.label
            : item.title || item.url;

  const titleAttr =
    item.kind === "issue"
      ? `${item.issueId} · ${item.title || "Untitled"}`
      : item.kind === "file"
        ? item.filePath
        : item.kind === "output"
          ? item.title || item.outputId
          : item.kind === "app"
            ? `App · ${item.label}`
            : item.url;

  return (
    <div
      role="group"
            className="group/fav relative flex items-center rounded transition-colors hover:bg-foreground/6"
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(PINNED_MOVE_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              const edge =
                e.clientY < rect.top + rect.height / 2 ? "before" : "after";
              setDropEdge((cur) => (cur === edge ? cur : edge));
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) {
                return;
              }
              setDropEdge(null);
            }}
            onDrop={(e) => {
              const draggedId = e.dataTransfer.getData(PINNED_MOVE_DRAG_TYPE);
              const edge = dropEdge;
              setDropEdge(null);
              if (!draggedId || !edge) return;
              e.preventDefault();
              moveFavorite({ draggedId, targetId: item.id, place: edge });
            }}
      >
      {dropEdge ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary",
            dropEdge === "before" ? "-top-px" : "-bottom-px",
          )}
        />
      ) : null}
      <button
        type="button"
        onClick={handleOpen}
        title={titleAttr}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(PINNED_MOVE_DRAG_TYPE, item.id);
        }}
        onDragEnd={() => setDropEdge(null)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.25 text-left text-sm text-foreground"
      >
        {item.kind === "app" ? (
          <AppIcon appId={item.appId} label={item.label} size="row" />
        ) : (
          <span
            aria-hidden
            className="grid size-3.5 shrink-0 place-items-center overflow-hidden rounded-xs text-muted-foreground"
          >
            {item.kind === "issue" ? (
              <CircleDotFilled className="size-3" />
            ) : item.kind === "file" ? (
              <FileTypeIcon filePath={item.filePath} size={14} />
            ) : item.kind === "output" ? (
              <FileTypeIcon filePath={item.filePath ?? item.title} size={14} />
            ) : item.faviconUrl && !faviconError ? (
              <img
                src={item.faviconUrl}
                alt=""
                className="size-3.5 rounded-xs object-contain"
                onError={() => setFaviconError(true)}
              />
            ) : (
              <GlobeFilled className="size-3" />
            )}
          </span>
        )}
        <span className="truncate">{label}</span>
      </button>
      <div
        aria-hidden
        className="mr-0 w-0 shrink-0 overflow-hidden transition-[width,margin-right] duration-snappy ease-out-expo group-hover/fav:mr-1 group-hover/fav:w-5"
      >
        <button
          type="button"
          aria-label="Remove from favorites"
          title="Remove from favorites"
          onClick={handleRemove}
          className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
        >
          <XFilled className="size-3" />
        </button>
      </div>
      </div>
  );
}

const ENTERPRISE_URL = "https://www.holaos.ai/enterprise";

// A distinct, card-styled call to action — deliberately NOT a plain nav item —
// sitting just above Settings. Opens the marketing Enterprise page in the user's
// default browser.
function SidebarEnterpriseCta() {
  return (
    <button
      // Solid near-black chip with an inset top highlight + soft drop shadow so
      // it reads as a raised, premium button (works on light and dark sidebars).
      className="group mt-1 flex w-full items-center gap-2.5 rounded-lg border border-white/10 bg-neutral-900 px-2.5 py-1.5 text-left text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_1px_2px_-0.5px_rgba(0,0,0,0.18)] transition-colors hover:bg-neutral-800"
      onClick={() => {
        void window.electronAPI?.ui.openExternalUrl(ENTERPRISE_URL);
      }}
      type="button"
    >
      <span
        aria-hidden
        className="grid size-6 shrink-0 place-items-center rounded-md bg-white/10 [&_svg]:size-3.5"
      >
        <BuildingFilled />
      </span>
      <span className="flex-1 truncate font-medium text-[13px]">Enterprise</span>
      <ArrowUpRight
        aria-hidden
        className="size-3.5 shrink-0 text-white/50 transition-[transform,color] duration-200 ease-out group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-white/80"
      />
    </button>
  );
}

// Settings is an app-global entry point, not a Home-tab item. Rendered as
// a persistent sidebar footer (outside the per-section content block)
// so it stays reachable from any tab — matches Linear / Notion / Slack's
// sidebar pattern. Previously it lived inside SidebarHomeSection, which
// (1) made Settings vanish whenever the user switched away from Home,
// and (2) read like Settings somehow belonged to "Home" semantically.
interface RewardQuestSummary {
  quests: { id: string; loop: string; completed: boolean }[];
  campaigns: { completed: boolean }[];
}

// Completed-vs-total for the progress hint on the Rewards row. Counts exactly
// what the Tasks page shows — the limited-time campaign(s) plus the get-started
// (activation) tasks — so the sidebar and the page never disagree. Shares the
// pane's query key so it's one fetch, and stays null until signed in / loaded so
// the row never flashes a bogus 0/0.
function useRewardTaskProgress(): { completed: number; total: number } | null {
  const session = useDesktopAuthSession();
  const enabled = Boolean(session.data?.user?.id?.trim());
  const { data } = useQuery({
    enabled,
    queryKey: ["rewards", "listQuests"],
    queryFn: () =>
      billingRpcFetch<RewardQuestSummary>("/rpc/rewards/listQuests"),
    staleTime: 60_000,
  });
  if (!data) {
    return null;
  }
  const starters = data.quests.filter(
    (quest) =>
      quest.loop === "activation" && quest.id !== "complete_brand_profile",
  );
  const visible = [...data.campaigns, ...starters];
  return {
    completed: visible.filter((task) => task.completed).length,
    total: visible.length,
  };
}

function SidebarGlobalFooter() {
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setSettingsSection = useSetAtom(settingsSectionAtom);
  const settingsOpen = useAtomValue(settingsOpenAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const [workspaceOverlay, setWorkspaceOverlay] = useAtom(workspaceOverlayAtom);
  const rewardProgress = useRewardTaskProgress();
  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-t border-sidebar-border px-2 py-1.5 [&_button]:w-full">
      <OrgProfileSelector />
      <SidebarEnterpriseCta />
      <NavItem
        icon={<GiftFilled />}
        active={workspaceOverlay === "rewards"}
        onClick={() => {
          setProjectView(null);
          setWorkspaceOverlay("rewards");
        }}
        trailing={
          rewardProgress ? (
            <span className="text-[11px] text-muted-foreground tabular-nums tracking-[-0.02em]">
              {rewardProgress.completed}/{rewardProgress.total}
            </span>
          ) : null
        }
      >
        Rewards
      </NavItem>
      <NavItem
        icon={<SettingsFilled />}
        active={settingsOpen}
        className="font-medium"
        onClick={() => {
          setSettingsSection("settings");
          setSettingsOpen(true);
        }}
      >
        Settings
      </NavItem>
    </div>
  );
}

function SidebarNavRow({
  icon,
  label,
  onClick,
  disabled,
  count,
  attentionCount,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  count?: number;
  /** When > 0, replaces the muted count with an amber chip — used to
   *  surface items that need user input (e.g. issues waiting on reply). */
  attentionCount?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-7 items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-foreground transition-colors",
        "hover:bg-foreground/4 hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
      )}
    >
      <span className="grid place-items-center text-muted-foreground [&>svg]:size-3.5">
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {attentionCount !== undefined && attentionCount > 0 ? (
        <span
          className="grid h-4 min-w-4 place-items-center rounded-full bg-amber-500/15 px-1 text-[10px] font-semibold tabular-nums text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
          aria-label={`${attentionCount} waiting on you`}
        >
          {attentionCount}
        </span>
      ) : count !== undefined ? (
        <span className="tabular-nums text-foreground-tertiary">{count}</span>
      ) : null}
    </button>
  );
}


// Empty title-bar band at the sidebar's top edge (`h-10`, `window-drag`,
// stoplight gutter) so macOS leaves room for the traffic-light buttons above
// the search bar, with the collapse toggle pinned to the right. Only mounted
// on macOS (see SidebarExpanded) — hence the always-on `pl-20` gutter; other
// platforms fold the collapse toggle into the search row instead.
function SidebarTitleBarSpacer() {
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  return (
    <div className="window-drag flex h-10 shrink-0 items-center justify-end gap-1 pr-2 pl-20">
      <UpdateReadyButton />
      <button
        type="button"
        aria-label="Collapse sidebar"
        title={`Collapse sidebar (${modifierKeyLabel()}\\)`}
        onClick={() => setSidebarCollapsed(true)}
        className="window-no-drag grid size-7 place-items-center rounded-md text-foreground/55 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      >
        <PanelLeftClose className="size-3.5" />
      </button>
      <SidebarSearchIconButton />
    </div>
  );
}


function NavItem({
  icon,
  badge,
  trailing,
  indent,
  active,
  onClick,
  className,
  children,
}: {
  icon?: React.ReactNode;
  badge?: number;
  trailing?: React.ReactNode;
  indent?: boolean;
  active?: boolean;
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn(
        "h-auto justify-start gap-2 px-2 py-1.25 text-sm font-normal text-foreground",
        active && "bg-foreground/[0.07] text-foreground",
        !active && "hover:bg-foreground/6",
        indent && "pl-6",
        className,
      )}
    >
      {icon ? (
        <span
          className="grid size-3.5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3.5"
          aria-hidden
        >
          {icon}
        </span>
      ) : null}
      <span className="flex-1 truncate text-left">{children}</span>
      {trailing}
      {badge ? <Badge className="h-4 px-1.5 text-[10px]">{badge}</Badge> : null}
    </Button>
  );
}

// ───────────────────────────────────────────────────────────────────
// New sidebar IA (Team / Artifacts / Pinned / Apps / Recents)
// ───────────────────────────────────────────────────────────────────

const PINNED_PEEK_CAP = 5;
const RECENTS_PEEK_CAP = 5;

// A compact search icon that opens the ⌘K palette. Lives in the sidebar's top
// chrome band next to the collapse toggle — no full-width search field.
function SidebarSearchIconButton() {
  const setSearchOpen = useSetAtom(searchOpenAtom);
  const searchGlyph = acceleratorGlyph(SHORTCUT_ACCELERATORS.search);
  return (
    <button
      aria-label="Search"
      className="window-no-drag grid size-7 shrink-0 place-items-center rounded-md text-foreground/55 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
      onClick={() => setSearchOpen(true)}
      title={`Search (${searchGlyph})`}
      type="button"
    >
      <SearchFilled className="size-3.5" />
    </button>
  );
}

// Windows/Linux top band (no macOS stoplight gutter): the sidebar's top row hosts
// the collapse toggle + search icon (leading, so they align with the collapsed-state
// expand button at the window's top-left) and doubles as the window-drag handle. On
// macOS this renders nothing — the band is SidebarTitleBarSpacer, which carries the
// same icons.
function SidebarSearchBellRow({
  inlineToggle = false,
}: {
  inlineToggle?: boolean;
}) {
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  if (!inlineToggle) {
    return null;
  }
  return (
    <div className="window-drag flex h-10 shrink-0 items-center gap-1 px-2">
      <UpdateReadyButton />
      <button
        aria-label="Collapse sidebar"
        className="window-no-drag grid size-7 shrink-0 place-items-center rounded-md text-foreground/55 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        onClick={() => setSidebarCollapsed(true)}
        title={`Collapse sidebar (${modifierKeyLabel()}\\)`}
        type="button"
      >
        <PanelLeftClose className="size-3.5" />
      </button>
      <SidebarSearchIconButton />
    </div>
  );
}

function CollapsibleSectionLabel({
  label,
  collapsed,
  onToggle,
  actions,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}) {
  if (actions) {
    return (
      <div className="group flex h-7 items-center gap-1 rounded-md text-xs font-medium text-muted-foreground">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-left transition-colors hover:text-foreground"
        >
          <ChevronDownFilled
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-foreground-tertiary transition-[transform,opacity] duration-snappy ease-out-expo group-hover:opacity-100",
              collapsed ? "-rotate-90 opacity-100" : "opacity-0",
            )}
          />
          <span className="truncate">{label}</span>
        </button>
        <span className="shrink-0 pr-2">{actions}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group flex h-7 items-center gap-1 rounded-md px-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronDownFilled
        aria-hidden
        className={cn(
          "size-3 shrink-0 text-foreground-tertiary transition-[transform,opacity] duration-snappy ease-out-expo group-hover:opacity-100",
          collapsed ? "-rotate-90 opacity-100" : "opacity-0",
        )}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

function TeamNavRow({
  icon,
  label,
  count,
  active,
  showDot,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  /** Dot indicator on the trailing edge — used for "needs attention" hints. */
  showDot?: boolean;
  /** Trailing keyboard-shortcut hint (e.g. ⌘T). */
  shortcut?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-2 rounded-md px-2 text-left text-sm font-medium transition-colors",
        active
          ? "bg-foreground/8 text-foreground"
          : "text-foreground hover:bg-foreground/4 hover:text-foreground",
      )}
    >
      <span className="grid place-items-center text-muted-foreground [&>svg]:size-3.5">
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {showDot ? (
        <span
          aria-hidden
          className="inline-block size-1.5 rounded-full bg-amber-500"
        />
      ) : null}
      {typeof count === "number" ? (
        <span className="text-[11px] font-medium tabular-nums text-foreground-tertiary">
          {count}
        </span>
      ) : null}
      {shortcut ? (
        <span className="flex items-center gap-0.5">{shortcut}</span>
      ) : null}
    </button>
  );
}

function SidebarNewChatRow({ workspaceId }: { workspaceId: string | null }) {
  const { startNewChat, starting } = useStartNewChat(workspaceId);

  return (
    <Button
      type="button"
      variant="outline"
      disabled={!workspaceId || starting}
      onClick={() => void startNewChat()}
      className="mb-2 w-full justify-start gap-2 text-foreground"
    >
      <PlusFilled className="size-3.5" />
      <span className="flex-1 text-left">New chat</span>
      <span className="flex items-center gap-0.5">
        <Kbd>{modifierKeyLabel()}</Kbd>
        <Kbd>N</Kbd>
      </span>
    </Button>
  );
}

function SidebarWorkspaceSection() {
  const { selectedWorkspaceId } = useWorkspaceSelection();

  const projectView = useAtomValue(projectViewAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const [workspaceOverlay, setWorkspaceOverlay] = useAtom(workspaceOverlayAtom);
  const projectsActive = projectView !== null;

  const setHolahubPath = useSetAtom(holahubPendingPathAtom);
  const enterWorkspaceOverlay = useCallback(
    (kind: WorkspaceOverlay) => {
      // Workspace-scoped overlays are mutually exclusive with Projects and
      // with each other; clear the others when opening one.
      setProjectView(null);
      // A plain open lands on the community's home feed — never a stale
      // deep-link.
      if (kind === "holahub") {
        setHolahubPath(null);
      }
      setWorkspaceOverlay(kind);
    },
    [setProjectView, setWorkspaceOverlay, setHolahubPath],
  );

  return (
    <div className="mb-1 flex flex-col gap-0.5 px-2 pt-1">
      <SidebarNewChatRow workspaceId={selectedWorkspaceId || null} />
      <TeamNavRow
        icon={<CompassFilled />}
        label="Discover"
        active={workspaceOverlay === "holahub"}
        onClick={() => enterWorkspaceOverlay("holahub")}
      />
      <TeamNavRow
        icon={<FolderFilled />}
        label="Projects"
        active={projectsActive}
        onClick={() => {
          setWorkspaceOverlay(null);
          setProjectView({ mode: "index" });
        }}
      />
      <TeamNavRow
        icon={<ZapFilled />}
        label="Automations"
        active={workspaceOverlay === "automations"}
        onClick={() => enterWorkspaceOverlay("automations")}
      />
      <TeamNavRow
        icon={<MessageCircleFilled />}
        label="Channels"
        active={workspaceOverlay === "channels"}
        onClick={() => enterWorkspaceOverlay("channels")}
      />
      <TeamNavRow
        icon={<GlobeFilled />}
        label="Browsers"
        active={workspaceOverlay === "profiles"}
        onClick={() => enterWorkspaceOverlay("profiles")}
      />
      <TeamNavRow
        icon={<WrenchFilled />}
        label="Customize"
        active={workspaceOverlay === "customize"}
        onClick={() => enterWorkspaceOverlay("customize")}
      />
    </div>
  );
}

// ─── Organization (tenant) context ────────────────────────────────────
// The profile selector = the active org (Better-Auth `setActiveOrganization`).
// "Personal" is the user's team-of-one org (today's experience, unchanged);
// picking a real org re-scopes the desktop to that org — every backend call
// re-scopes because the gateway injects `x-holaboss-org-id` from the session.

function OrgProfileSelector() {
  const { organizations, activeOrg, switching, switchOrg } = useOrganizations();
  const setOrgSwitching = useSetAtom(orgSwitchingAtom);
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
  const setSelectedEmployee = useSetAtom(selectedEmployeeAtom);

  // Switching the active org re-scopes every backend call, so reset the view to a
  // clean, org-scoped base: drop any open web-app surface (whose native BrowserView
  // a DOM overlay can't cover), the HolaApps/marketplace overlay, and any project
  // view — nothing personal-scoped should survive the switch. A full-screen loader
  // covers the whole transition rather than letting panes flicker to the new org.
  const handleSwitch = useCallback(
    async (organizationId: string) => {
      setActiveWebAppSurface(null);
      setWorkspaceOverlay(null);
      setProjectView(null);
      // Close any open session/employee chat too — both are org-scoped and won't
      // appear in the new org's (org-scoped) lists, so leaving them open stranded
      // a foreign session in the chat pane. Land in a fresh General-chat draft for
      // the new org, matching "New chat".
      setSelectedEmployee(null);
      setSelectedSessionId(null);
      setSessionOpenRequest({
        sessionId: "",
        requestKey: Date.now(),
        mode: "draft",
        parentSessionId: null,
        clearComposer: true,
      });
      // Carry the target so the overlay reads "Switching to <Org>…" for a team
      // vs "Returning to your personal workspace…" for personal.
      const target =
        organizations.find((org) => org.id === organizationId) ?? null;
      const toPersonal = !target || isPersonalOrg(target);
      setOrgSwitching({
        toPersonal,
        orgName: toPersonal ? null : (target?.name ?? null),
      });
      try {
        await switchOrg(organizationId);
      } finally {
        setOrgSwitching(null);
      }
    },
    [
      organizations,
      switchOrg,
      setOrgSwitching,
      setActiveWebAppSurface,
      setWorkspaceOverlay,
      setProjectView,
      setSelectedEmployee,
      setSelectedSessionId,
      setSessionOpenRequest,
    ],
  );

  // Only surface the switcher when the user actually belongs to a real org
  // (beyond their personal team-of-one).
  const realOrgs = organizations.filter((org) => !isPersonalOrg(org));
  if (realOrgs.length === 0) {
    return null;
  }
  const personalOrgs = organizations.filter((org) => isPersonalOrg(org));

  const activeId = activeOrg?.id ?? null;
  const activeIsPersonal = !activeOrg || isPersonalOrg(activeOrg);
  const ActiveIcon = activeIsPersonal ? CircleUserRound : Users;

  const renderItem = (org: DesktopOrganizationPayload) => {
    const selected = org.id === activeId;
    const ItemIcon = isPersonalOrg(org) ? CircleUserRound : Users;
    return (
      <DropdownMenuItem
        key={org.id}
        onClick={() => {
          if (!selected) {
            void handleSwitch(org.id);
          }
        }}
        className="gap-2"
      >
        <span className="grid size-4 place-items-center text-muted-foreground [&>svg]:size-3.5">
          <ItemIcon />
        </span>
        <span className="flex-1 truncate">{orgLabel(org)}</span>
        {selected ? <Check className="size-3.5 text-muted-foreground" /> : null}
      </DropdownMenuItem>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            disabled={switching}
            className="flex items-center gap-2 rounded-md px-2 py-1.25 text-left text-sm font-medium text-foreground transition-colors hover:bg-foreground/6 disabled:opacity-60"
            title="Switch profile"
          >
            <span className="grid size-3.5 shrink-0 place-items-center text-muted-foreground [&>svg]:size-3.5">
              {switching ? <Loader2 className="animate-spin" /> : <ActiveIcon />}
            </span>
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate">{orgLabel(activeOrg)}</span>
              <span className="truncate text-[11px] font-normal text-muted-foreground">
                {activeIsPersonal ? "Personal account" : "Organization"}
              </span>
            </span>
            <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      {/* No min-width override: the trigger is forced `w-full` by the footer, so
          the content's default `w-(--anchor-width)` matches the sidebar column and
          stays within its bounds (a min-w-56 here overflowed into the main area). */}
      <DropdownMenuContent align="start" side="top">
        {personalOrgs.length > 0 ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Personal</DropdownMenuLabel>
              {personalOrgs.map(renderItem)}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {realOrgs.map(renderItem)}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Sessions list ────────────────────────────────────────────────────
// One section for General sessions (project_id = NULL) plus one per
// project. Click a row → activate + select that session in chat. Empty
// General + empty projects → renders nothing so the sidebar collapses
// down to nav only.

const RUNNING_SESSION_POLL_MS = 3000;
const EMPTY_RUNNING_SESSION_IDS = new Set<string>();

function runningSessionIdSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

// Poll per-session runtime states so the sidebar can mark sessions that are
// actively working (runtime BUSY) — including ones that aren't the open
// session — with a spinner on their row.
function useRunningSessionIds(workspaceId: string | null): Set<string> {
  const [runningIds, setRunningIds] = useState<Set<string>>(
    EMPTY_RUNNING_SESSION_IDS,
  );
  useEffect(() => {
    if (!workspaceId || !window.electronAPI) {
      setRunningIds((prev) =>
        prev.size === 0 ? prev : EMPTY_RUNNING_SESSION_IDS,
      );
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response =
          await window.electronAPI.workspace.listRuntimeStates(workspaceId);
        if (cancelled) return;
        const next = new Set<string>();
        for (const state of response.items) {
          const sessionId = state.session_id?.trim();
          if (!sessionId) continue;
          const runtimeState = (state.effective_state || state.status || "")
            .trim()
            .toUpperCase();
          if (runtimeState === "BUSY") next.add(sessionId);
        }
        setRunningIds((prev) =>
          runningSessionIdSetsEqual(prev, next) ? prev : next,
        );
      } catch {
        // Transient — keep the last set and retry on the next tick.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(poll, RUNNING_SESSION_POLL_MS);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [workspaceId]);
  return runningIds;
}

function SidebarSessionsSection() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { sessions, setSessions } = useWorkspaceMainSessions(
    selectedWorkspaceId || null,
  );
  const { projects } = useWorkspaceProjects(selectedWorkspaceId || null);
  const runningSessionIds = useRunningSessionIds(selectedWorkspaceId || null);
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const [renameTarget, setRenameTarget] = useState<{
    sessionId: string;
    initial: string;
  } | null>(null);
  const setLastViewedMap = useSetAtom(sessionLastViewedAtAtom);

  // Mark a session read when you leave it (selection moves away). This covers
  // every entry path — new chat, agent-created, sidebar click — not just an
  // explicit sidebar open, so sessions you've actually been in stop flashing
  // the unread dot. Recording on *leave* (rather than on open) also avoids the
  // race where activating a session bumps its updated_at just after we'd stamp
  // the view time.
  const activeSessionId = useAtomValue(selectedSessionIdAtom);
  const prevActiveSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevActiveSessionRef.current;
    if (prev && prev !== activeSessionId) {
      setLastViewedMap((map) => ({
        ...map,
        [prev]: new Date().toISOString(),
      }));
    }
    prevActiveSessionRef.current = activeSessionId;
  }, [activeSessionId, setLastViewedMap]);

  const handleRename = useCallback(
    async (sessionId: string, nextTitle: string) => {
      if (!selectedWorkspaceId) return;
      setSessions((current) =>
        current.map((s) =>
          s.session_id === sessionId ? { ...s, title: nextTitle } : s,
        ),
      );
      try {
        await window.electronAPI.workspace.updateMainSession(
          selectedWorkspaceId,
          sessionId,
          { title: nextTitle },
        );
      } catch {
        // Best-effort; the next list refresh reconciles on failure.
      }
    },
    [selectedWorkspaceId, setSessions],
  );

  const { startNewChat } = useStartNewChat(selectedWorkspaceId || null);
  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (!selectedWorkspaceId) return;
      setSessions((current) =>
        current.filter((s) => s.session_id !== sessionId),
      );
      setLastViewedMap((prev) => {
        if (!(sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      // Deleting the chat you're looking at would leave the pane on a dead
      // session — drop into a fresh New-chat draft instead.
      if (sessionId === activeSessionId) {
        void startNewChat();
      }
      try {
        await window.electronAPI.workspace.deleteMainSession(
          selectedWorkspaceId,
          sessionId,
        );
      } catch {
        // Best-effort; the next list refresh reconciles on failure.
      }
    },
    [
      selectedWorkspaceId,
      setSessions,
      setLastViewedMap,
      activeSessionId,
      startNewChat,
    ],
  );

  const { generalSessions, sessionsByProject, scheduledSessions } = useMemo(() => {
    const general: MainSessionRecordPayload[] = [];
    const scheduled: MainSessionRecordPayload[] = [];
    const byProject = new Map<string, MainSessionRecordPayload[]>();
    for (const session of sessions) {
      if (session.archived_at) continue;
      // Hide empty placeholders. A main session's title is filled from its
      // first user message, so a titleless session has no activity yet — e.g.
      // the fresh "New chat" the app ensures on entry. Don't surface it as an
      // "Untitled session" until it actually has content.
      if (!session.title?.trim()) continue;
      // Sessions originating from an inbound channel message (created_by
      // "im:<platform>", e.g. "im:slack") are managed via the Channels overlay,
      // not the session list. Hide them from the sidebar groups for now so they
      // don't leak into General.
      if (session.created_by?.startsWith("im:")) continue;
      // Sessions spawned by a cronjob fire are grouped under "Scheduled",
      // a peer of General and Projects.
      if (session.created_by === "cronjob") {
        scheduled.push(session);
        continue;
      }
      const projectId = session.project_id ?? null;
      if (!projectId) {
        general.push(session);
        continue;
      }
      const bucket = byProject.get(projectId) ?? [];
      bucket.push(session);
      byProject.set(projectId, bucket);
    }
    return {
      generalSessions: general,
      sessionsByProject: byProject,
      scheduledSessions: scheduled,
    };
  }, [sessions]);

  const handleRequestDelete = useCallback(
    (s: MainSessionRecordPayload) => {
      const label = s.title?.trim() || "Untitled session";
      if (
        !window.confirm(
          `Delete '${label}'?\n\nThis permanently deletes the session and its history. This cannot be undone.`,
        )
      ) {
        return;
      }
      void handleDelete(s.session_id);
    },
    [handleDelete],
  );
  const handleRequestRename = useCallback(
    (s: MainSessionRecordPayload) =>
      setRenameTarget({
        sessionId: s.session_id,
        initial: s.title?.trim() || "",
      }),
    [],
  );

  if (!selectedWorkspaceId) return null;
  if (
    generalSessions.length === 0 &&
    sessionsByProject.size === 0 &&
    scheduledSessions.length === 0
  ) {
    return null;
  }

  return (
    <div className="mt-3 mb-2 flex flex-col gap-2 px-2">
      {projects.map((project) => {
        const projectSessions = sessionsByProject.get(project.project_id);
        if (!projectSessions || projectSessions.length === 0) return null;
        return (
          <SessionsGroup
            key={project.project_id}
            groupKey={project.project_id}
            label={project.name}
            onRequestDelete={handleRequestDelete}
            onRequestRename={handleRequestRename}
            runningSessionIds={runningSessionIds}
            sessions={projectSessions}
            onNewChat={() => {
              setWorkspaceOverlay(null);
              setProjectView({ mode: "landing", projectId: project.project_id });
            }}
          />
        );
      })}
      {generalSessions.length > 0 ? (
        <SessionsGroup
          groupKey="general"
          label="General"
          onRequestDelete={handleRequestDelete}
          onRequestRename={handleRequestRename}
          runningSessionIds={runningSessionIds}
          sessions={generalSessions}
        />
      ) : null}
      {scheduledSessions.length > 0 ? (
        <SessionsGroup
          groupKey="scheduled"
          label="Scheduled"
          onRequestDelete={handleRequestDelete}
          onRequestRename={handleRequestRename}
          runningSessionIds={runningSessionIds}
          sessions={scheduledSessions}
        />
      ) : null}

      <RenameDialog
        initial={renameTarget?.initial ?? ""}
        onConfirm={(next) => {
          if (renameTarget) {
            void handleRename(renameTarget.sessionId, next);
          }
          setRenameTarget(null);
        }}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
        open={!!renameTarget}
        placeholder="Session name"
        title="Rename session"
      />
    </div>
  );
}

function SessionsGroup({
  label,
  groupKey,
  sessions,
  runningSessionIds,
  onRequestRename,
  onRequestDelete,
  onNewChat,
}: {
  label: string;
  groupKey: string;
  sessions: MainSessionRecordPayload[];
  runningSessionIds: Set<string>;
  onRequestRename: (session: MainSessionRecordPayload) => void;
  onRequestDelete: (session: MainSessionRecordPayload) => void;
  /** When set, renders a "New chat" action on the group header (projects). */
  onNewChat?: () => void;
}) {
  const [collapsedGroups, setCollapsedGroups] = useAtom(
    collapsedSessionGroupsAtom,
  );
  const selectedSessionId = useAtomValue(selectedSessionIdAtom);
  const selectedEmployee = useAtomValue(selectedEmployeeAtom);
  const lastViewedMap = useAtomValue(sessionLastViewedAtAtom);
  const collapsed = collapsedGroups.includes(groupKey);
  const toggle = () =>
    setCollapsedGroups((prev) =>
      prev.includes(groupKey)
        ? prev.filter((key) => key !== groupKey)
        : [...prev, groupKey],
    );
  return (
    <div className="flex flex-col gap-0.5">
      <CollapsibleSectionLabel
        label={label}
        collapsed={collapsed}
        onToggle={toggle}
        actions={
          onNewChat ? (
            <button
              type="button"
              aria-label={`New chat in ${label}`}
              title="New chat"
              onClick={onNewChat}
              className="grid size-5 scale-90 place-items-center rounded text-muted-foreground opacity-0 transition-[color,opacity,transform,scale] duration-snappy ease-out-expo group-hover:scale-100 group-hover:opacity-100 hover:text-foreground focus-visible:scale-100 focus-visible:opacity-100 motion-reduce:transition-none motion-reduce:scale-100"
            >
              <PlusCircleFilled className="size-3.5" />
            </button>
          ) : undefined
        }
      />
      {!collapsed ? (
        <div className="flex flex-col gap-0.5">
          {sessions.map((session) => {
            // An open employee chat is the active view, so no General session is
            // "selected" even though selectedSessionId still points at the last one.
            const selected =
              selectedSessionId === session.session_id && !selectedEmployee;
            const lastViewedAt = lastViewedMap[session.session_id];
            // Only badge as unread once a session has actually been viewed AND
            // has newer activity since. A session we've never opened has no
            // baseline, so treat it as read rather than nagging on every old
            // conversation.
            const unread =
              !selected &&
              lastViewedAt != null &&
              Date.parse(session.updated_at) > Date.parse(lastViewedAt);
            return (
              <SessionRow
                key={session.session_id}
                onRequestDelete={onRequestDelete}
                onRequestRename={onRequestRename}
                running={runningSessionIds.has(session.session_id)}
                selected={selected}
                session={session}
                unread={unread}
              />
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const SessionRow = memo(function SessionRow({
  session,
  selected,
  unread,
  running,
  onRequestRename,
  onRequestDelete,
}: {
  session: MainSessionRecordPayload;
  selected: boolean;
  unread: boolean;
  running: boolean;
  onRequestRename: (session: MainSessionRecordPayload) => void;
  onRequestDelete: (session: MainSessionRecordPayload) => void;
}) {
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setChatPanelView = useSetAtom(chatPanelViewAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);
  const setLastViewedMap = useSetAtom(sessionLastViewedAtAtom);
  const setActiveWebAppSurface = useSetAtom(activeWebAppSurfaceAtom);
  const setSelectedEmployee = useSetAtom(selectedEmployeeAtom);

  const handleOpen = useCallback(async () => {
    setProjectView(null);
    setWorkspaceOverlay(null);
    // A sidebar session takes over from the employee chat pane. Clear it here
    // (not only via the value-change effect) so re-opening the ALREADY-active
    // session — which doesn't change selectedSessionId — still leaves the pane.
    setSelectedEmployee(null);
    setChatPanelView("chat");
    setSelectedSessionId(session.session_id);
    // Opening a different session leaves the HolaApp surface context — clear it so
    // its API-key install gate (keyed off activeWebAppSurface) doesn't leak onto
    // this session. (The gated draft→session transition is internal to ChatPane and
    // doesn't run this handler, so that flow keeps its surface + gate.)
    setActiveWebAppSurface(null);
    // Opening a session from the sidebar puts the chat in canvas/focus
    // mode: the middle pane collapses and the chat fills the canvas.
    setFocusMode(true);
    // Tell ChatPane to actually load this session. ChatPane subscribes to
    // chatSessionOpenRequestAtom via ChatPanel and treats each fresh
    // requestKey as "open this session now"; without this nudge the
    // activate IPC alone doesn't swap the visible session.
    setSessionOpenRequest({
      sessionId: session.session_id,
      requestKey: Date.now(),
      readOnly: false,
    });
    // Record the view so the unread dot clears for this session.
    setLastViewedMap((prev) => ({
      ...prev,
      [session.session_id]: new Date().toISOString(),
    }));
    try {
      await window.electronAPI.workspace.activateMainSession(
        session.workspace_id,
        session.session_id,
      );
    } catch {
      // Activation failure surfaces in chat — non-fatal for the selection.
    }
  }, [
    session.session_id,
    session.workspace_id,
    setActiveWebAppSurface,
    setChatPanelView,
    setFocusMode,
    setLastViewedMap,
    setProjectView,
    setSelectedEmployee,
    setSelectedSessionId,
    setSessionOpenRequest,
    setWorkspaceOverlay,
  ]);

  // When this row's session becomes the selected one (e.g. opened via the
  // project landing page or some other code path), mark it viewed so the
  // dot clears even when the user didn't click the row directly.
  useEffect(() => {
    if (!selected) return;
    setLastViewedMap((prev) => {
      const previousAt = prev[session.session_id];
      if (
        previousAt &&
        Date.parse(previousAt) >= Date.parse(session.updated_at)
      ) {
        return prev;
      }
      return {
        ...prev,
        [session.session_id]: new Date().toISOString(),
      };
    });
  }, [
    selected,
    session.session_id,
    session.updated_at,
    setLastViewedMap,
  ]);

  const label = session.title?.trim() || "Untitled session";

  return (
    <div
      className={cn(
        "group/session relative flex h-7 items-center rounded-md text-sm transition-colors",
        selected
          ? "bg-foreground/[0.07] text-foreground"
          : "text-foreground hover:bg-foreground/4",
      )}
    >
      <button
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-7 pl-2 text-left"
        onClick={() => void handleOpen()}
        title={label}
        type="button"
      >
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            // A solid blue dot marks a session with new activity you haven't
            // looked at yet (completed but not viewed); hollow means seen/idle.
            unread ? "bg-blue-500" : "border border-muted-foreground/40",
          )}
          title={unread ? "New activity" : undefined}
        />
        <span className="flex-1 truncate">{label}</span>
      </button>
      {running ? (
        <Loader2
          aria-label="Working"
          className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 animate-spin text-muted-foreground transition-opacity group-hover/session:opacity-0"
        />
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              aria-label={`Actions for ${label}`}
              className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 group-hover/session:opacity-100 data-[popup-open]:opacity-100"
              onClick={(e) => e.stopPropagation()}
              type="button"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onRequestRename(session);
            }}
          >
            <Pencil className="size-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onRequestDelete(session);
            }}
          >
            <Trash2 className="size-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});

function SidebarPersonalDivider() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const selector = useAtomValue(favoritesForWorkspaceAtom);
  const favorites = useMemo(
    () => selector(selectedWorkspaceId || null),
    [selector, selectedWorkspaceId],
  );

  if (favorites.length === 0) return null;

  return <div className="mx-4 my-2 h-px bg-border/60" />;
}

// A HolaApp's own chat sessions, listed under its sidebar row. Mounted only when
// the row is expanded, so we don't poll every app's sessions. Selecting one opens
// the app surface + that session (via onOpenSession).
function SidebarAppSessionList({
  appId,
  workspaceId,
  onOpenSession,
}: {
  appId: string;
  workspaceId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { sessions } = useWorkspaceMainSessions(workspaceId, appId);
  const selectedSessionId = useAtomValue(selectedSessionIdAtom);
  if (sessions.length === 0) {
    return (
      <div className="py-1 pl-9 text-muted-foreground text-xs">No chats yet</div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {sessions.map((session) => {
        const label = session.title?.trim() || "Untitled chat";
        return (
          <button
            className={cn(
              "flex min-w-0 items-center rounded py-1 pr-2 pl-9 text-left text-[13px] transition-colors",
              session.session_id === selectedSessionId
                ? "bg-foreground/[0.07] text-foreground"
                : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
            )}
            key={session.session_id}
            onClick={() => onOpenSession(session.session_id)}
            title={label}
            type="button"
          >
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// One HolaApp row: opens the app on click, and a disclosure chevron reveals the
// app's own chat sessions nested beneath it (archived under the app).
function SidebarHolaAppRow({
  holaAppId,
  title,
  iconUrl,
  selected,
  onOpenApp,
  onOpenSession,
  onUninstall,
}: {
  holaAppId: string;
  title: string;
  iconUrl?: string | null;
  selected: boolean;
  onOpenApp: () => void;
  onOpenSession: (sessionId: string) => void;
  onUninstall: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { selectedWorkspaceId } = useWorkspaceSelection();
  return (
    <div>
      <div
        className={cn(
          "group/app relative flex min-w-0 items-center rounded pr-1 transition-colors",
          selected
            ? "bg-foreground/[0.07] text-foreground"
            : "text-foreground hover:bg-foreground/6",
        )}
      >
        <button
          aria-label={expanded ? `Hide ${title} chats` : `Show ${title} chats`}
          className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-60 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/app:opacity-100"
          onClick={() => setExpanded((v) => !v)}
          type="button"
        >
          <ChevronRight
            className={cn("size-3 transition-transform", expanded && "rotate-90")}
          />
        </button>
        <button
          className="flex min-w-0 flex-1 items-center gap-2 py-1.25 pr-7 text-left text-sm"
          onClick={onOpenApp}
          title={title}
          type="button"
        >
          <HolaAppIcon holaAppId={holaAppId} iconUrl={iconUrl} title={title} />
          <span className="truncate">{title}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                aria-label={`Actions for ${title}`}
                className="absolute top-1/2 right-1 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 group-hover/app:opacity-100 data-[popup-open]:opacity-100"
                onClick={(e) => e.stopPropagation()}
                type="button"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                onUninstall();
              }}
            >
              <Trash2 className="size-3.5" />
              Uninstall
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && selectedWorkspaceId ? (
        <SidebarAppSessionList
          appId={holaAppId}
          onOpenSession={onOpenSession}
          workspaceId={selectedWorkspaceId}
        />
      ) : null}
    </div>
  );
}

function SidebarHolaAppsSection() {
  const openHolaApp = useOpenHolaApp();
  const openHolaAppDraftChat = useOpenHolaAppDraftChat();
  const { installed, refresh, uninstall } = useHolaAppCatalog();
  const setProjectView = useSetAtom(projectViewAtom);
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const setCustomizeTab = useSetAtom(customizeTabAtom);
  // The HolaApp currently occupying the center pane — used to highlight its
  // sidebar row, mirroring how a selected session is marked (see SessionRow).
  const activeWebAppSurface = useAtomValue(activeWebAppSurfaceAtom);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The HolaApps section entry point → Customize's Apps tab, where installed and
  // connected apps are managed. Discovering/browsing the Marketplace is a jump from
  // inside that tab, not a direct sidebar target.
  const openInstalledApps = () => {
    setProjectView(null);
    setCustomizeTab("apps");
    setWorkspaceOverlay("customize");
  };

  const handleRequestUninstall = useCallback(
    (app: { holaAppId: string; title: string }) => {
      if (
        !window.confirm(
          `Uninstall '${app.title}'?\n\nThis removes the app from this workspace. You can reinstall it from the store later.`,
        )
      ) {
        return;
      }
      void uninstall(app.holaAppId);
    },
    [uninstall],
  );

  // The sidebar lists Apps you open — so it needs an openable surface. Exclude two
  // kinds that have none as a personal sidebar row: team-native apps (Need Review,
  // HolaEmployee — org-scoped, surfaced elsewhere) and connection-tier Apps (former
  // "integrations": headless, surface-less, driven by the agent — they live only in
  // the store + Settings, never as a sidebar row).
  const storeApps = installed.filter(
    (app) => !app.teamNative && appKind(app) !== "connection",
  );

  // Always render the section (header + Store entry point) so the marketplace stays
  // reachable even when the catalogue is empty — `catalog` and `installed` may both be
  // empty (nothing installed yet, or the catalogue still loading / unavailable).

  return (
    <div className="mt-3 mb-2 flex flex-col gap-0.5 px-2">
      <div className="group flex items-center justify-between px-2 py-0.5">
        <button
          className="font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
          onClick={openInstalledApps}
          title="Manage installed apps"
          type="button"
        >
          HolaApps
        </button>
        <button
          aria-label="Manage apps"
          className="grid size-5 place-items-center rounded text-muted-foreground opacity-0 transition-[color,opacity] duration-snappy ease-out-expo hover:bg-foreground/6 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 motion-reduce:transition-none"
          onClick={openInstalledApps}
          title="Manage apps"
          type="button"
        >
          <GridFilled className="size-3" />
        </button>
      </div>
      {storeApps.map((app) => (
        <SidebarHolaAppRow
          holaAppId={app.holaAppId}
          iconUrl={app.iconUrl}
          key={app.holaAppId}
          // Opening a HolaApp resumes its most-recent session (or a fresh draft);
          // picking a session from the disclosure opens that exact one.
          onOpenApp={() => {
            openHolaApp(catalogEntryToOpenParams(app));
            openHolaAppDraftChat(app.holaAppId);
          }}
          onOpenSession={(sessionId) => {
            openHolaApp(catalogEntryToOpenParams(app));
            openHolaAppDraftChat(app.holaAppId, sessionId);
          }}
          onUninstall={() =>
            handleRequestUninstall({
              holaAppId: app.holaAppId,
              title: app.title,
            })
          }
          selected={activeWebAppSurface?.holaAppId === app.holaAppId}
          title={app.title}
        />
      ))}
      {storeApps.length === 0 ? (
        <button
          className="px-2 py-1 text-left text-muted-foreground text-xs transition-colors hover:text-foreground"
          onClick={openInstalledApps}
          type="button"
        >
          Browse apps to install…
        </button>
      ) : null}
    </div>
  );
}

function SidebarPinnedSection() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const selector = useAtomValue(favoritesForWorkspaceAtom);
  const favorites = useMemo(
    () => selector(selectedWorkspaceId || null),
    [selector, selectedWorkspaceId],
  );
  const [showAll, setShowAll] = useState(false);

  if (favorites.length === 0) return null;

  const visible = showAll ? favorites : favorites.slice(0, PINNED_PEEK_CAP);
  const overflow = Math.max(0, favorites.length - PINNED_PEEK_CAP);

  return (
    <div className="mt-3 mb-2 flex flex-col gap-0.5 px-2">
      <div className="px-2 py-0.5 text-xs font-medium text-muted-foreground">
        Pinned
      </div>
      {visible.map((item) => (
        <FavoriteRow key={item.id} item={item} />
      ))}
      {overflow > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll((prev) => !prev)}
          className="flex h-6 items-center gap-1 rounded-md px-2 text-left text-sm text-foreground-tertiary transition-colors hover:bg-foreground/6 hover:text-foreground"
        >
          {showAll ? "Show less" : `+${overflow} more`}
        </button>
      ) : null}
    </div>
  );
}
