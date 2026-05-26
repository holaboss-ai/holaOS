import { AppIntegrationsDialog } from "@/components/integration/AppIntegrationsDialog";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { WorkspaceIconPicker } from "@/components/ui/workspace-icon-picker";
import {
  OutputArtifactIcon,
  outputBrowserFilterForOutput,
  outputKindLabel,
  sortOutputsLatestFirst,
} from "@/components/panes/ChatPane/ArtifactBrowserModal";
import type { ArtifactBrowserFilter } from "@/components/panes/ChatPane/types";
import { FileTypeIcon } from "@/lib/fileIcon";
import { useIntegrationBinding } from "@/lib/useIntegrationBinding";
import { cn } from "@/lib/utils";
import type { WorkspaceInstalledAppDefinition } from "@/lib/workspaceApps";
import { resolveAppDisplay, useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Globe,
  Home,
  Inbox,
  Link2,
  Loader2,
  MoreHorizontal,
  Package,
  Plus,
  RotateCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SectionLabel } from "./shared";
import {
  activeInternalTabIdAtom,
  fileNameFromPath,
  internalTabsAtom,
  makeInternalTabId,
} from "./state/internalTabs";
import {
  type RecentFile,
  recentFilesAtom,
  removeRecentFileAtom,
} from "./state/recentFiles";
import {
  appsExpandedAtom,
  automationsOpenAtom,
  chatComposerPrefillAtom,
  createWorkspaceOpenAtom,
  focusModeAtom,
  publishOpenAtom,
  searchOpenAtom,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type SidebarSection,
  sidebarSectionAtom,
  sidebarWidthAtom,
  settingsOpenAtom,
  settingsSectionAtom,
  sidebarCollapsedAtom,
} from "./state/ui";
import { useTaskProposals } from "./useTaskProposals";
import {
  useRecentBrowserHistory,
  useWorkspaceArtifacts,
  useWorkspaceCronjobs,
  useWorkspaceOutputFolders,
  useWorkspaceSkills,
} from "./useWorkspaceLists";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";

type RecentItem =
  | { kind: "url"; ts: string; entry: BrowserHistoryEntryPayload }
  | { kind: "file"; ts: string; entry: RecentFile };

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function Sidebar() {
  const collapsed = useAtomValue(sidebarCollapsedAtom);
  const width = useAtomValue(sidebarWidthAtom);
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
      onDoubleClick={() => setWidth(260)}
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
function SidebarExpanded() {
  const section = useAtomValue(sidebarSectionAtom);
  return (
    <aside
      data-pane-card="true"
      data-pane-role="sidebar"
      className="flex h-full w-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground backdrop-blur-sm"
    >
      <WorkspaceSwitcher />
      <SidebarSectionNav />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AnimatePresence initial={false}>
          <motion.div
            key={section}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{
              opacity: { duration: 0.12, ease: [0.16, 1, 0.3, 1] },
              y: { duration: 0.16, ease: [0.16, 1, 0.3, 1] },
            }}
            className="absolute inset-0 flex flex-col"
          >
            {section === "home" ? <SidebarHomeSection /> : null}
            {section === "inbox" ? <SidebarInboxSection /> : null}
            {section === "artifacts" ? <SidebarArtifactsSection /> : null}
            {section === "automations" ? <SidebarAutomationsSection /> : null}
          </motion.div>
        </AnimatePresence>
      </div>
      <SidebarGlobalFooter />
    </aside>
  );
}

const SECTION_NAV_ITEMS: Array<{
  key: SidebarSection;
  label: string;
  icon: React.ReactNode;
}> = [
  { key: "home", label: "Home", icon: <Home /> },
  { key: "inbox", label: "Inbox", icon: <Inbox /> },
  { key: "artifacts", label: "Artifacts", icon: <Package /> },
  { key: "automations", label: "Automations", icon: <Zap /> },
];

// One shared spring for the pill slide and the button width morph.
// stiffness 380 + damping 32 lands without overshoot but keeps the
// motion lively — Linear-style.
const SECTION_NAV_SPRING = {
  type: "spring" as const,
  stiffness: 380,
  damping: 32,
  mass: 0.6,
};

function SidebarSectionNav() {
  const [section, setSection] = useAtom(sidebarSectionAtom);
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { proposals } = useTaskProposals(selectedWorkspaceId || null);
  const unreadInbox = proposals.length;

  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-sidebar-border bg-sidebar px-2 py-1.5">
      {SECTION_NAV_ITEMS.map((item) => {
        const active = section === item.key;
        const badge = item.key === "inbox" && unreadInbox > 0 ? unreadInbox : 0;
        return (
          <motion.button
            key={item.key}
            type="button"
            aria-label={item.label}
            aria-pressed={active}
            title={item.label}
            onClick={() => setSection(item.key)}
            // `layout="position"` only animates the button's position
            // (its x shifts as siblings resize). The size itself snaps
            // instantly — that's fine because the visible morph is the
            // shared layoutId pill, not the button's bg. Avoids the
            // FLIP scale-transform that was making the label look like
            // it flew in from the right.
            layout="position"
            transition={SECTION_NAV_SPRING}
            className={cn(
              // `isolate` so the layoutId pill `motion.div` (z-0 absolute)
              // doesn't escape; icon + label sit on z-10 above it.
              "group/sec-nav relative isolate flex h-7 shrink-0 items-center rounded-md text-foreground/55 transition-colors duration-150 ease-out hover:text-foreground",
              "[&_svg]:relative [&_svg]:z-10 [&_svg]:size-4",
              active
                ? "gap-1.5 pr-2 pl-1.5 text-foreground"
                : "w-7 px-1.5 hover:bg-foreground/[0.05]",
            )}
          >
            {active ? (
              <motion.span
                aria-hidden
                layoutId="sidebar-section-pill"
                transition={SECTION_NAV_SPRING}
                className="absolute inset-0 z-0 rounded-md bg-foreground/[0.1]"
              />
            ) : null}
            {item.icon}
            <AnimatePresence initial={false} mode="popLayout">
              {active ? (
                <motion.span
                  key="label"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{
                    duration: 0.18,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                  className="relative z-10 whitespace-nowrap text-[12px] font-medium leading-none"
                >
                  {item.label}
                </motion.span>
              ) : null}
            </AnimatePresence>
            {badge > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "relative z-10 grid h-3 min-w-3 shrink-0 place-items-center rounded-full bg-primary px-0.5 text-[9px] font-medium leading-none text-primary-foreground",
                  active ? "-mr-0.5 ml-0" : "absolute top-0.5 right-0.5",
                )}
              >
                {badge > 9 ? "9+" : badge}
              </span>
            ) : null}
          </motion.button>
        );
      })}
    </div>
  );
}

function SidebarHomeSection() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const setSearchOpen = useSetAtom(searchOpenAtom);

  const skills = useWorkspaceSkills(selectedWorkspaceId || null);
  const cronjobs = useWorkspaceCronjobs(selectedWorkspaceId || null);
  const setAutomationsOpen = useSetAtom(automationsOpenAtom);
  const automationsOpen = useAtomValue(automationsOpenAtom);
  const urlRecents = useRecentBrowserHistory(20);
  const allFileRecents = useAtomValue(recentFilesAtom);
  const fileRecents = useMemo(
    () =>
      allFileRecents.filter(
        (entry) => entry.workspaceId === (selectedWorkspaceId ?? null),
      ),
    [allFileRecents, selectedWorkspaceId],
  );
  const recents = useMemo<RecentItem[]>(() => {
    const merged: RecentItem[] = [
      ...urlRecents.map((entry) => ({
        kind: "url" as const,
        ts: entry.lastVisitedAt || entry.createdAt,
        entry,
      })),
      ...fileRecents.map((entry) => ({
        kind: "file" as const,
        ts: entry.openedAt,
        entry,
      })),
    ];
    merged.sort((a, b) => b.ts.localeCompare(a.ts));
    return merged.slice(0, 7);
  }, [urlRecents, fileRecents]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
      <SidebarGroup>
        <NavItem icon={<Search />} onClick={() => setSearchOpen(true)}>
          Search
        </NavItem>
        <AppsSection />
      </SidebarGroup>

      {recents.length > 0 ? (
        <SidebarGroup>
          <SectionLabel>Recents</SectionLabel>
          {recents.map((item) =>
            item.kind === "url" ? (
              <RecentRow key={`u:${item.entry.id}`} entry={item.entry} />
            ) : (
              <RecentFileRow key={`f:${item.entry.id}`} entry={item.entry} />
            ),
          )}
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
    </div>
  );
}

// Settings is an app-global entry point, not a Home-tab item. Rendered as
// a persistent sidebar footer (outside the per-section content block)
// so it stays reachable from any tab — matches Linear / Notion / Slack's
// sidebar pattern. Previously it lived inside SidebarHomeSection, which
// (1) made Settings vanish whenever the user switched away from Home,
// and (2) read like Settings somehow belonged to "Home" semantically.
function SidebarGlobalFooter() {
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setSettingsSection = useSetAtom(settingsSectionAtom);
  const settingsOpen = useAtomValue(settingsOpenAtom);
  return (
    <div className="shrink-0 border-t border-sidebar-border px-2 py-1.5">
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
    </div>
  );
}

function SidebarInboxSection() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { proposals, isLoading, statusMessage, action, accept, dismiss } =
    useTaskProposals(selectedWorkspaceId || null);
  const [expandedProposalId, setExpandedProposalId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (
      expandedProposalId &&
      !proposals.some((p) => p.proposal_id === expandedProposalId)
    ) {
      setExpandedProposalId(null);
    }
  }, [expandedProposalId, proposals]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-3">
      <SectionLabel>
        Inbox
        {proposals.length > 0 ? (
          <span className="ml-auto text-foreground/30">{proposals.length}</span>
        ) : null}
      </SectionLabel>
      {statusMessage ? (
        <AnimatePresence initial={false}>
          <motion.div
            key={statusMessage}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: INBOX_EASE }}
            className="mx-0.5 mt-1 mb-1.5 rounded-md border border-border bg-foreground/[0.03] px-2 py-1.5 text-[11px] leading-snug text-foreground/65"
          >
            {statusMessage}
          </motion.div>
        </AnimatePresence>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && proposals.length === 0 ? (
          <div className="grid place-items-center py-8">
            <Loader2 className="size-4 animate-spin text-foreground/40" />
          </div>
        ) : proposals.length === 0 ? (
          <div className="grid place-items-center px-3 py-12 text-center">
            <div className="flex flex-col items-center gap-2">
              <Inbox className="size-5 text-foreground/30" />
              <div className="text-xs text-foreground/55">
                You're all caught up
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 px-0.5 pt-1">
            <AnimatePresence initial={false} mode="popLayout">
              {proposals.map((proposal) => (
                <InboxProposalCard
                  key={proposal.proposal_id}
                  proposal={proposal}
                  expanded={expandedProposalId === proposal.proposal_id}
                  onToggleExpand={() =>
                    setExpandedProposalId((current) =>
                      current === proposal.proposal_id
                        ? null
                        : proposal.proposal_id,
                    )
                  }
                  pendingAction={
                    action?.proposalId === proposal.proposal_id
                      ? action.action
                      : null
                  }
                  onAccept={() => void accept(proposal)}
                  onDismiss={() => void dismiss(proposal)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}

// Linear's signature ease — flat tail, no overshoot. Keeps card motion
// restrained instead of the spring-y feel of easeOutExpo's [0.16, 1, 0.3, 1].
const INBOX_EASE = [0.32, 0.72, 0, 1] as const;

interface InboxProposalCardProps {
  proposal: TaskProposalRecordPayload;
  expanded: boolean;
  pendingAction: "accept" | "dismiss" | null;
  onToggleExpand: () => void;
  onAccept: () => void;
  onDismiss: () => void;
}

function InboxProposalCard({
  proposal,
  expanded,
  pendingAction,
  onToggleExpand,
  onAccept,
  onDismiss,
}: InboxProposalCardProps) {
  const isActing = pendingAction !== null;
  const sourceLabel =
    proposal.proposal_source === "evolve" ? "Evolve" : "Proactive";
  const sourceIcon =
    proposal.proposal_source === "evolve" ? (
      <Sparkles className="size-2.5" />
    ) : (
      <Inbox className="size-2.5" />
    );

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{
        opacity: 0,
        transition: { duration: 0.12, ease: INBOX_EASE },
      }}
      transition={{
        layout: { duration: 0.2, ease: INBOX_EASE },
        default: { duration: 0.16, ease: INBOX_EASE },
      }}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <button
        type="button"
        onClick={onToggleExpand}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors hover:bg-foreground/[0.025]"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-foreground/[0.06] px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wide text-foreground/55">
              {sourceIcon}
              {sourceLabel}
            </span>
            <span className="shrink-0 text-[10px] text-foreground/40">
              {inboxRelativeTime(proposal.created_at)}
            </span>
          </div>
          <div className="mt-1 truncate text-xs font-medium text-foreground">
            {proposal.task_name || "Untitled proposal"}
          </div>
          {proposal.task_generation_rationale ? (
            <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-foreground/55">
              {proposal.task_generation_rationale}
            </div>
          ) : null}
        </div>
        <ChevronRight
          className="mt-0.5 size-3 shrink-0 text-foreground/30 transition-transform duration-snappy ease-emphasized"
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          }}
        />
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.16, ease: INBOX_EASE },
              opacity: { duration: 0.12, ease: INBOX_EASE },
            }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/60 px-2.5 py-1.5">
              {proposal.task_prompt ? (
                <div className="max-h-24 overflow-y-auto rounded-md bg-foreground/[0.04] px-2 py-1 font-mono text-[10.5px] leading-snug whitespace-pre-wrap break-words text-foreground/75">
                  {proposal.task_prompt}
                </div>
              ) : null}
              <div className="mt-1.5 flex items-center gap-1.5">
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  disabled={isActing}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAccept();
                  }}
                  className="h-6 px-2 text-[11px]"
                >
                  {pendingAction === "accept" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Check className="size-3" />
                  )}
                  Accept
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={isActing}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDismiss();
                  }}
                  className="h-6 px-2 text-[11px] text-foreground/55 hover:text-foreground"
                >
                  {pendingAction === "dismiss" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <X className="size-3" />
                  )}
                  Dismiss
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

function inboxRelativeTime(value: string): string {
  const ms = Date.now() - Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const ARTIFACT_FILTER_OPTIONS: ReadonlyArray<{
  id: ArtifactBrowserFilter;
  label: string;
}> = [
  { id: "all", label: "All" },
  { id: "documents", label: "Docs" },
  { id: "images", label: "Images" },
  { id: "code", label: "Code" },
  { id: "links", label: "Links" },
  { id: "apps", label: "Apps" },
];

const UNCATEGORIZED_FOLDER_KEY = "__uncategorized__";

function SidebarArtifactsSection() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const outputs = useWorkspaceArtifacts(selectedWorkspaceId || null);
  const folders = useWorkspaceOutputFolders(selectedWorkspaceId || null);
  const { openOutput } = useOpenWorkspaceOutput();
  const [filter, setFilter] = useState<ArtifactBrowserFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );

  const folderNamesById = useMemo(() => {
    const map = new Map<string, string>();
    for (const folder of folders) {
      map.set(folder.id, folder.name || "Untitled folder");
    }
    return map;
  }, [folders]);

  const folderOrderById = useMemo(() => {
    const map = new Map<string, number>();
    folders.forEach((folder, index) => {
      map.set(folder.id, folder.position ?? index);
    });
    return map;
  }, [folders]);

  const sortedOutputs = useMemo(
    () => sortOutputsLatestFirst(outputs),
    [outputs],
  );

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredOutputs = useMemo(() => {
    let result =
      filter === "all"
        ? sortedOutputs
        : sortedOutputs.filter(
            (output) => outputBrowserFilterForOutput(output) === filter,
          );
    if (normalizedSearchQuery) {
      result = result.filter((output) => {
        const title = (output.title ?? "").toLowerCase();
        const kind = outputKindLabel(output).toLowerCase();
        return (
          title.includes(normalizedSearchQuery) ||
          kind.includes(normalizedSearchQuery)
        );
      });
    }
    return result;
  }, [sortedOutputs, filter, normalizedSearchQuery]);

  // Bucket outputs by folder, then order folders by their server `position`
  // with the unfoldered bucket last so explicit folders win the top slots.
  const groupedOutputs = useMemo(() => {
    const buckets = new Map<string, WorkspaceOutputRecordPayload[]>();
    for (const output of filteredOutputs) {
      const key = output.folder_id || UNCATEGORIZED_FOLDER_KEY;
      const existing = buckets.get(key);
      if (existing) {
        existing.push(output);
      } else {
        buckets.set(key, [output]);
      }
    }
    return Array.from(buckets.entries())
      .map(([key, items]) => ({
        key,
        label:
          key === UNCATEGORIZED_FOLDER_KEY
            ? "Uncategorized"
            : (folderNamesById.get(key) ?? "Untitled folder"),
        order:
          key === UNCATEGORIZED_FOLDER_KEY
            ? Number.POSITIVE_INFINITY
            : (folderOrderById.get(key) ?? Number.POSITIVE_INFINITY - 1),
        items,
      }))
      .sort((left, right) => left.order - right.order);
  }, [filteredOutputs, folderNamesById, folderOrderById]);

  const totalCount = sortedOutputs.length;
  const isFiltering = filter !== "all" || normalizedSearchQuery.length > 0;
  const visibleCount = filteredOutputs.length;

  const toggleFolder = useCallback((key: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-3">
      <SectionLabel>
        Artifacts
        {totalCount > 0 ? (
          <span className="ml-auto text-foreground/30">{totalCount}</span>
        ) : null}
      </SectionLabel>

      {totalCount > 0 ? (
        <>
          <div className="relative mb-1.5 mt-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-foreground/40" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search artifacts"
              aria-label="Search artifacts"
              className="h-7 rounded-md pl-6.5 pr-6 text-xs focus-visible:ring-0"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-foreground/40 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
          <div className="-mx-0.5 mb-1.5 flex flex-wrap gap-0.5 px-0.5">
            {ARTIFACT_FILTER_OPTIONS.map((option) => {
              const active = filter === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFilter(option.id)}
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10.5px] font-medium transition-colors",
                    active
                      ? "bg-foreground text-background"
                      : "text-foreground/55 hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {totalCount === 0 ? (
          <div className="grid place-items-center px-3 py-12 text-center">
            <div className="flex flex-col items-center gap-2">
              <Package className="size-5 text-foreground/30" />
              <div className="text-xs text-foreground/55">
                Artifacts from your agent runs will appear here.
              </div>
            </div>
          </div>
        ) : visibleCount === 0 ? (
          <div className="px-2 py-6 text-center text-xs text-foreground/45">
            {isFiltering
              ? "No artifacts match this view."
              : "No artifacts yet."}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {groupedOutputs.map((group) => {
              const collapsed = collapsedFolders.has(group.key);
              return (
                <div key={group.key} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => toggleFolder(group.key)}
                    aria-expanded={!collapsed}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[10.5px] font-medium uppercase tracking-wide text-foreground/50 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/70"
                  >
                    <ChevronRight
                      className="size-3 shrink-0 transition-transform duration-snappy ease-emphasized"
                      style={{
                        transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {group.label}
                    </span>
                    <span className="text-foreground/30">{group.items.length}</span>
                  </button>
                  {collapsed ? null : (
                    <div className="flex flex-col gap-0.5 pt-0.5">
                      {group.items.map((output) => {
                        const kindLabel = outputKindLabel(output);
                        return (
                          <button
                            key={output.id}
                            type="button"
                            onClick={() => void openOutput(output)}
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/80 transition-colors hover:bg-foreground/[0.04]"
                          >
                            <OutputArtifactIcon
                              output={output}
                              variant="bare"
                            />
                            <span className="min-w-0 flex-1 truncate text-foreground">
                              {output.title || "Untitled artifact"}
                            </span>
                            <span className="shrink-0 text-foreground/45">
                              {kindLabel}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function SidebarAutomationsSection() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const cronjobs = useWorkspaceCronjobs(selectedWorkspaceId || null);
  const setAutomationsOpen = useSetAtom(automationsOpenAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const setComposerPrefill = useSetAtom(chatComposerPrefillAtom);
  const prefillKeyRef = useRef(0);

  const handleCreateSchedule = useCallback(() => {
    prefillKeyRef.current += 1;
    setComposerPrefill({
      text: "Create a schedule for ",
      requestKey: prefillKeyRef.current,
      mode: "replace",
    });
    setFocusMode(false);
  }, [setComposerPrefill, setFocusMode]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
      <SectionLabel>
        Automations
        {cronjobs.length > 0 ? (
          <span className="ml-2 text-foreground/30">{cronjobs.length}</span>
        ) : null}
        <button
          type="button"
          onClick={handleCreateSchedule}
          aria-label="New schedule"
          title="New schedule"
          className="ml-auto grid size-5 place-items-center rounded text-foreground/45 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      </SectionLabel>
      {cronjobs.length === 0 ? (
        <div className="grid place-items-center px-3 py-12 text-center">
          <div className="flex flex-col items-center gap-2">
            <Clock className="size-5 text-foreground/30" />
            <div className="text-xs text-foreground/55">
              No scheduled automations yet.
            </div>
            <button
              type="button"
              onClick={handleCreateSchedule}
              className="mt-1 inline-flex items-center gap-1 rounded-md bg-foreground/[0.05] px-2 py-1 text-[11px] text-foreground/70 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
            >
              <Plus className="size-3" strokeWidth={1.75} />
              New schedule
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {cronjobs.slice(0, 12).map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => setAutomationsOpen(true)}
              className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs text-foreground/80 transition-colors hover:bg-foreground/[0.04]"
            >
              <span className="truncate font-medium text-foreground">
                {job.name || "Untitled automation"}
              </span>
              <span className="truncate font-mono text-[10px] text-foreground/45">
                {job.cron}
              </span>
            </button>
          ))}
          {cronjobs.length > 12 ? (
            <button
              type="button"
              onClick={() => setAutomationsOpen(true)}
              className="mt-1 rounded-md px-2 py-1 text-left text-xs text-foreground/55 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
            >
              See all {cronjobs.length} →
            </button>
          ) : null}
        </div>
      )}
    </div>
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
  const { openUrlInBrowserTab } = useOpenWorkspaceOutput();

  const openApp = async (
    appId: string,
    opts?: { forceNewTab?: boolean },
  ) => {
    if (!selectedWorkspaceId) return;
    try {
      const url = await window.electronAPI.appSurface.resolveUrl(
        selectedWorkspaceId,
        appId,
      );
      await openUrlInBrowserTab(url, {
        forceNewTab: opts?.forceNewTab,
        dedupBy: "origin",
      });
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
              return (
                <AppRow
                  key={app.id}
                  app={app}
                  label={label}
                  providerId={providerId}
                  iconUrl={display.logo}
                  expanded={expanded}
                  onOpen={(opts) => void openApp(app.id, opts)}
                  onReload={() => void reloadApp(app.id)}
                  onUninstall={() => void uninstallApp(app.id, label)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

interface AppRowProps {
  app: WorkspaceInstalledAppDefinition;
  label: string;
  providerId: string | null;
  iconUrl: string | null;
  expanded: boolean;
  onOpen: (opts?: { forceNewTab?: boolean }) => void;
  onReload: () => void;
  onUninstall: () => void;
}

function AppRow(props: AppRowProps) {
  // Bucket the app's declared integrations into "providers we care about".
  // Apps with no integrations (UI-only, data-only) skip the binding hook
  // entirely; apps with one keep the existing single-binding row; apps with
  // two or more (e.g. X Engagement: twitter + gmail) need the multi-binding
  // variant so each provider gets its own status / Reconnect path in the
  // dropdown — the legacy single-provider row silently dropped everything
  // beyond the first required entry.
  const integrations: AppRowMultiIntegration[] = (props.app.integrations ?? [])
    .filter((entry) => Boolean(entry.provider))
    .map((entry) => ({
      provider: entry.provider,
      required: entry.required,
      whoami: entry.whoami ?? null,
    }));
  if (integrations.length === 0) {
    return <AppRowPlain {...props} />;
  }
  // Prefer required > first declared for the "primary" provider whose state
  // drives the row's status dot when collapsed.
  const primary =
    integrations.find((entry) => entry.required) ?? integrations[0]!;
  if (integrations.length === 1) {
    return (
      <AppRowWithBinding
        {...props}
        providerSlug={primary.provider}
        whoami={primary.whoami}
      />
    );
  }
  return (
    <AppRowWithMultiBinding
      {...props}
      integrations={integrations}
      primaryProvider={primary.provider}
    />
  );
}

type RowTone =
  | "ready"
  | "loading"
  | "error"
  | "needs_connect"
  | "connecting";

function AppRowPlain({
  app,
  label,
  providerId,
  iconUrl,
  expanded,
  onOpen,
  onReload,
  onUninstall,
}: AppRowProps) {
  const errorMessage = app.error?.trim() || null;
  const tone: RowTone = errorMessage
    ? "error"
    : app.ready
      ? "ready"
      : "loading";
  const tooltip =
    tone === "error" && errorMessage
      ? errorMessage
      : tone === "loading"
        ? `${label} — starting…`
        : label;
  return (
    <AppRowShell
      app={app}
      label={label}
      providerId={providerId}
      iconUrl={iconUrl}
      expanded={expanded}
      tone={tone}
      tooltip={tooltip}
      onRowClick={() => {
        if (tone === "ready") onOpen();
      }}
      renderTrailing={() => {
        if (tone === "loading") {
          return <StatusDot variant="info" pulse title="Starting" />;
        }
        if (tone === "error") {
          return (
            <StatusDot
              variant="destructive"
              title={errorMessage ?? "Error"}
            />
          );
        }
        return null;
      }}
      menuItems={
        <>
          <DropdownMenuItem
            onClick={() => onOpen({ forceNewTab: true })}
            disabled={tone !== "ready"}
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
        </>
      }
    />
  );
}

function AppRowWithBinding({
  app,
  label,
  providerId,
  iconUrl,
  expanded,
  onOpen,
  onReload,
  onUninstall,
  providerSlug,
  whoami,
}: AppRowProps & {
  providerSlug: string;
  whoami: PendingIntegrationWhoami | null;
}) {
  const { composioToolkitsByProvider } = useWorkspaceDesktop();
  const providerName =
    composioToolkitsByProvider[providerSlug.toLowerCase()]?.name ??
    providerSlug;

  const {
    state: bindingState,
    busy,
    connect,
    cancel,
  } = useIntegrationBinding({
    appId: app.id,
    provider: providerSlug,
    whoami,
    considerWorkspaceDefault: true,
  });

  const errorMessage = app.error?.trim() || null;
  const tone: RowTone = errorMessage
    ? "error"
    : busy === "connecting" || busy === "binding"
      ? "connecting"
      : bindingState.kind === "no_connection" ||
          bindingState.kind === "needs_binding"
        ? "needs_connect"
        : !app.ready
          ? "loading"
          : "ready";

  const tooltip =
    tone === "error" && errorMessage
      ? errorMessage
      : tone === "connecting"
        ? `Authorizing ${providerName}…`
        : tone === "needs_connect"
          ? `${providerName} not connected — click to authorize`
          : tone === "loading"
            ? `${label} — starting…`
            : label;

  const handleRowClick = () => {
    if (tone === "ready") {
      onOpen();
      return;
    }
    if (tone === "needs_connect") {
      void connect();
    }
  };

  return (
    <AppRowShell
      app={app}
      label={label}
      providerId={providerId}
      iconUrl={iconUrl}
      expanded={expanded}
      tone={tone}
      tooltip={tooltip}
      onRowClick={handleRowClick}
      renderTrailing={() => {
        if (tone === "connecting") {
          return (
            <span className="flex items-center gap-1">
              <Loader2
                className="size-3 animate-spin text-foreground/55"
                aria-hidden
              />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  cancel();
                }}
                aria-label="Cancel"
                className="grid size-4 place-items-center rounded text-foreground/45 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        }
        if (tone === "needs_connect") {
          return (
            <StatusDot
              variant="warning"
              title={`${providerName} needs a connection`}
            />
          );
        }
        if (tone === "loading") {
          return <StatusDot variant="info" pulse title="Starting" />;
        }
        if (tone === "error") {
          return (
            <StatusDot
              variant="destructive"
              title={errorMessage ?? "Error"}
            />
          );
        }
        return null;
      }}
      menuItems={
        <>
          {tone === "needs_connect" ? (
            <DropdownMenuItem
              onClick={() => void connect()}
              disabled={busy !== null}
            >
              <Link2 className="size-3.5" />
              Connect {providerName}…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onClick={() => onOpen({ forceNewTab: true })}
            disabled={tone !== "ready"}
          >
            <Plus className="size-3.5" />
            Open in new tab
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onReload}>
            <RotateCw className="size-3.5" />
            Reload
          </DropdownMenuItem>
          {bindingState.kind === "bound" ? (
            <DropdownMenuItem
              onClick={() => void connect()}
              disabled={busy !== null}
            >
              <Link2 className="size-3.5" />
              Reconnect {providerName}…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={onUninstall} variant="destructive">
            <Trash2 className="size-3.5" />
            Uninstall
          </DropdownMenuItem>
        </>
      }
    />
  );
}

interface AppRowMultiIntegration {
  provider: string;
  required: boolean;
  whoami: PendingIntegrationWhoami | null;
}

type ProviderRowStateSummary = {
  kind: "loading" | "no_connection" | "needs_binding" | "bound" | "no_workspace";
  busy: "connecting" | "binding" | null;
  hasError: boolean;
};

function AppRowWithMultiBinding({
  app,
  label,
  providerId,
  iconUrl,
  expanded,
  onOpen,
  onReload,
  onUninstall,
  integrations,
}: AppRowProps & {
  integrations: AppRowMultiIntegration[];
  primaryProvider: string;
}) {
  // The popover-style nested dropdown got physically occluded by the
  // workspace browser pane (it's a separate render layer that the renderer
  // can't position popovers above). The dialog approach uses a top-level
  // backdrop portaled to document.body, which sits above the webview's
  // stacking context. The hidden ProviderStateReporter children run the
  // binding hook so the row's status dot stays informative without forcing
  // the user to open the dialog first.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [byProvider, setByProvider] = useState<
    Record<string, ProviderRowStateSummary>
  >({});
  const updateProviderState = useCallback(
    (slug: string, summary: ProviderRowStateSummary) => {
      setByProvider((prev) => {
        const existing = prev[slug];
        if (
          existing &&
          existing.kind === summary.kind &&
          existing.busy === summary.busy &&
          existing.hasError === summary.hasError
        ) {
          return prev;
        }
        return { ...prev, [slug]: summary };
      });
    },
    [],
  );

  const errorMessage = app.error?.trim() || null;
  const summaries = Object.values(byProvider);
  const anyConnecting = summaries.some((s) => s.busy !== null);
  const anyNeedsConnect = summaries.some(
    (s) => s.kind === "no_connection" || s.kind === "needs_binding",
  );
  const tone: RowTone = errorMessage
    ? "error"
    : anyConnecting
      ? "connecting"
      : anyNeedsConnect
        ? "needs_connect"
        : !app.ready
          ? "loading"
          : "ready";

  const pendingProviderNames = useMemo(
    () =>
      integrations
        .filter((entry) => {
          const summary = byProvider[entry.provider];
          if (!summary) return false;
          return (
            summary.kind === "no_connection" || summary.kind === "needs_binding"
          );
        })
        .map((entry) => entry.provider),
    [integrations, byProvider],
  );

  const tooltip =
    tone === "error" && errorMessage
      ? errorMessage
      : tone === "connecting"
        ? `Authorizing integrations…`
        : tone === "needs_connect"
          ? pendingProviderNames.length > 0
            ? `${pendingProviderNames.join(", ")} not connected — open menu to authorize`
            : `Integrations need attention`
          : tone === "loading"
            ? `${label} — starting…`
            : label;

  const handleRowClick = () => {
    if (tone === "ready") {
      onOpen();
      return;
    }
    if (tone === "needs_connect") {
      setDialogOpen(true);
    }
  };

  return (
    <>
      {integrations.map((integration) => (
        <ProviderStateReporter
          key={integration.provider}
          appId={app.id}
          provider={integration.provider}
          whoami={integration.whoami}
          onState={updateProviderState}
        />
      ))}
      <AppRowShell
        app={app}
        label={label}
        providerId={providerId}
        iconUrl={iconUrl}
        expanded={expanded}
        tone={tone}
        tooltip={tooltip}
        onRowClick={handleRowClick}
        renderTrailing={() => {
          if (tone === "connecting") {
            return (
              <Loader2
                className="size-3 animate-spin text-foreground/55"
                aria-hidden
              />
            );
          }
          if (tone === "needs_connect") {
            return (
              <StatusDot
                variant="warning"
                title={`${pendingProviderNames.length} integration${
                  pendingProviderNames.length === 1 ? "" : "s"
                } need attention`}
              />
            );
          }
          if (tone === "loading") {
            return <StatusDot variant="info" pulse title="Starting" />;
          }
          if (tone === "error") {
            return (
              <StatusDot
                variant="destructive"
                title={errorMessage ?? "Error"}
              />
            );
          }
          return null;
        }}
        menuItems={
          <>
            <DropdownMenuItem
              onClick={() => onOpen({ forceNewTab: true })}
              disabled={tone !== "ready"}
            >
              <Plus className="size-3.5" />
              Open in new tab
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onReload}>
              <RotateCw className="size-3.5" />
              Reload
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDialogOpen(true)}>
              <Link2 className="size-3.5" />
              Manage integrations
              {pendingProviderNames.length > 0 ? (
                <span className="ml-auto rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning">
                  {pendingProviderNames.length}
                </span>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onUninstall} variant="destructive">
              <Trash2 className="size-3.5" />
              Uninstall
            </DropdownMenuItem>
          </>
        }
      />
      <AppIntegrationsDialog
        appId={app.id}
        appName={label}
        integrations={integrations.map((entry) => ({
          provider: entry.provider,
          required: entry.required,
          whoami: entry.whoami,
        }))}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}

/**
 * Headless companion to AppIntegrationsDialog: subscribes to each declared
 * provider's binding state via useIntegrationBinding and reports a summary
 * up to the parent so the row's status dot can show "warning" even before
 * the user opens the dialog. Renders nothing.
 */
function ProviderStateReporter({
  appId,
  provider,
  whoami,
  onState,
}: {
  appId: string;
  provider: string;
  whoami: PendingIntegrationWhoami | null;
  onState: (slug: string, summary: ProviderRowStateSummary) => void;
}) {
  const { state, busy, errorMessage } = useIntegrationBinding({
    appId,
    provider,
    whoami,
    considerWorkspaceDefault: true,
  });
  useEffect(() => {
    onState(provider, {
      kind: state.kind,
      busy,
      hasError: Boolean(errorMessage),
    });
  }, [state.kind, busy, errorMessage, provider, onState]);
  return null;
}

function AppRowShell({
  app,
  label,
  providerId,
  iconUrl,
  expanded,
  tone,
  tooltip,
  onRowClick,
  renderTrailing,
  menuItems,
}: {
  app: WorkspaceInstalledAppDefinition;
  label: string;
  providerId: string | null;
  iconUrl: string | null;
  expanded: boolean;
  tone: RowTone;
  tooltip: string;
  onRowClick: () => void;
  renderTrailing: () => React.ReactNode;
  menuItems: React.ReactNode;
}) {
  return (
    <div
      role="group"
      className="group/app-row relative flex items-center rounded-[6px] transition-colors hover:bg-foreground/[0.04]"
    >
      <button
        type="button"
        onClick={onRowClick}
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
            (tone === "error" || tone === "needs_connect") &&
              "text-foreground/55",
          )}
        >
          {label}
        </span>
        {renderTrailing()}
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
            {menuItems}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function RecentRow({ entry }: { entry: BrowserHistoryEntryPayload }) {
  const title = entry.title || hostFromUrl(entry.url) || entry.url;
  const [faviconError, setFaviconError] = useState(false);
  const showFavicon = Boolean(entry.faviconUrl) && !faviconError;
  const { openUrlInBrowserTab } = useOpenWorkspaceOutput();

  const handleOpen = (opts?: { forceNewTab?: boolean }) =>
    openUrlInBrowserTab(entry.url, opts);

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
            <DropdownMenuItem
              onClick={() => void handleOpen({ forceNewTab: true })}
            >
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

function RecentFileRow({ entry }: { entry: RecentFile }) {
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const removeRecentFile = useSetAtom(removeRecentFileAtom);

  const handleOpen = () => {
    const existing = internalTabs.find(
      (t) => t.kind === "file" && t.filePath === entry.filePath,
    );
    if (existing) {
      setActiveInternalTabId(existing.id);
      return;
    }
    const tab = {
      id: makeInternalTabId(),
      kind: "file" as const,
      filePath: entry.filePath,
      label: entry.label || fileNameFromPath(entry.filePath),
    };
    setInternalTabs((prev) => [...prev, tab]);
    setActiveInternalTabId(tab.id);
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(entry.filePath);
    } catch {
      // tolerate clipboard rejection
    }
  };

  return (
    <div
      role="group"
      className="group/recent relative flex items-center rounded-[6px] transition-colors hover:bg-foreground/[0.04]"
    >
      <button
        type="button"
        onClick={handleOpen}
        title={entry.filePath}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-xs text-foreground/70"
      >
        <span
          aria-hidden
          className="grid size-3.5 shrink-0 place-items-center overflow-hidden rounded-[3px]"
        >
          <FileTypeIcon filePath={entry.filePath} size={14} />
        </span>
        <span className="truncate">{entry.label}</span>
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
                aria-label="File actions"
                onClick={(e) => e.stopPropagation()}
                className="grid size-5 place-items-center rounded text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
            <DropdownMenuItem onClick={handleOpen}>
              <Plus className="size-3.5" />
              Open
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleCopyPath()}>
              <Copy className="size-3.5" />
              Copy path
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => removeRecentFile(entry.id)}
              variant="destructive"
            >
              <Trash2 className="size-3.5" />
              Remove from recents
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// Horizontal inset of the WorkspaceSwitcher's trigger inside the
// sidebar (the `pl-20` reserves space for the macOS traffic lights).
// Used to pull the popover leftward so it aligns with the sidebar's
// inner edge instead of starting from the trigger button — keeping
// the popover entirely within the sidebar so it never overflows onto
// the BrowserView.
const WORKSPACE_POPOVER_LEFT_INSET = 72;

function WorkspaceSwitcher() {
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
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
  const [popoverOpen, setPopoverOpen] = useState(false);

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
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
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
          alignOffset={-WORKSPACE_POPOVER_LEFT_INSET}
          sideOffset={6}
          className="gap-0 p-2"
          style={{
            width: `${sidebarWidth - 16}px`,
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
                      onClick={() => {
                        setSelectedWorkspaceId(w.id);
                        setPopoverOpen(false);
                      }}
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
                onClick={() => {
                  setPopoverOpen(false);
                  setPublishOpen(true);
                }}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-foreground/[0.04]"
              >
                <Upload className="size-3.5 text-foreground/60" />
                Publish to Store
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setPopoverOpen(false);
                setCreateWorkspaceOpen(true);
              }}
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
