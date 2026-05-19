import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Bot,
  ChevronRight,
  FolderOpen,
  Globe,
  Plus,
  Star,
  User,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  browserSessionStatusLabel,
  browserSessionTitle,
  browserSurfaceStatusSummary,
  compareBrowserSessionOptions,
} from "@/components/panes/browserSessionUi";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { buildBrowserBookmarkTree } from "@/lib/browserBookmarks";
import { cn } from "@/lib/utils";

interface SpaceBrowserExplorerPaneProps {
  browserSpace: BrowserSpaceId;
  onBrowserSpaceChange: (space: BrowserSpaceId) => void;
  onActivateDisplay: () => void;
  hasPendingAgentJump?: boolean;
}

type SessionStatusTone = "active" | "waiting" | "paused" | "error" | "idle";

// Module-level cache so favicon error state survives remounts (e.g. when
// switching scopes). The browser's HTTP cache handles "successfully loaded"
// images for free; we only need to remember the ones that failed so we
// don't flash broken-image glyphs or re-trigger network requests to 404s.
const faviconErrorCache = new Set<string>();

interface FaviconProps {
  url?: string | null;
  fallback: ReactNode;
  className?: string;
}

function Favicon({ url, fallback, className }: FaviconProps) {
  const [errored, setErrored] = useState(
    () => !url || faviconErrorCache.has(url),
  );

  useEffect(() => {
    if (!url) {
      setErrored(true);
      return;
    }
    setErrored(faviconErrorCache.has(url));
  }, [url]);

  if (!url || errored) {
    return <>{fallback}</>;
  }

  return (
    <img
      src={url}
      alt=""
      className={className}
      decoding="async"
      onError={() => {
        faviconErrorCache.add(url);
        setErrored(true);
      }}
    />
  );
}

function sessionDotVariant(
  tone: SessionStatusTone,
): "success" | "warning" | "info" | "destructive" | "muted" {
  switch (tone) {
    case "active":
      return "success";
    case "waiting":
      return "warning";
    case "paused":
      return "info";
    case "error":
      return "destructive";
    default:
      return "muted";
  }
}

function toneFromRuntimeStatus(
  runtime: SessionRuntimeRecordPayload | null | undefined,
): { tone: SessionStatusTone; flashing: boolean } {
  const status =
    runtime?.effective_state?.trim().toUpperCase() ||
    runtime?.status?.trim().toUpperCase() ||
    "";
  if (status === "BUSY" || status === "QUEUED" || status === "PAUSING") {
    return { tone: "active", flashing: true };
  }
  if (status === "WAITING_USER") {
    return { tone: "waiting", flashing: false };
  }
  if (status === "PAUSED") {
    return { tone: "paused", flashing: false };
  }
  if (status === "ERROR") {
    return { tone: "error", flashing: false };
  }
  return { tone: "idle", flashing: false };
}

export function SpaceBrowserExplorerPane({
  browserSpace,
  onBrowserSpaceChange,
  onActivateDisplay,
  hasPendingAgentJump = false,
}: SpaceBrowserExplorerPaneProps) {
  const {
    selectedWorkspaceId,
    browserState,
    activeTab,
    bookmarks,
    agentSessions,
    runtimeStatesBySessionId,
    currentSession,
    currentRuntimeState,
  } = useWorkspaceBrowser(browserSpace, { includeSessions: true });

  const sortedAgentSessions = useMemo(
    () =>
      [...agentSessions].sort((left, right) =>
        compareBrowserSessionOptions(left, right, runtimeStatesBySessionId),
      ),
    [agentSessions, runtimeStatesBySessionId],
  );
  const bookmarkTree = useMemo(
    () => buildBrowserBookmarkTree(bookmarks),
    [bookmarks],
  );
  const [collapsedBookmarkFolderKeys, setCollapsedBookmarkFolderKeys] =
    useState<Set<string>>(() => new Set());
  const hasAgentSessionBrowsers = sortedAgentSessions.length > 0;

  const sessionBrowserStatus = useMemo(
    () =>
      browserSurfaceStatusSummary({
        browserSpace,
        controlMode: browserState.controlMode,
        lifecycleState: browserState.lifecycleState,
        runtimeState: currentRuntimeState,
      }),
    [
      browserSpace,
      browserState.controlMode,
      browserState.lifecycleState,
      currentRuntimeState,
    ],
  );

  const currentSessionLabel = browserSessionTitle(
    currentSession,
    browserState.controlSessionId || browserState.sessionId,
  );

  const openBrowserSpace = (space: BrowserSpaceId) => {
    if (!selectedWorkspaceId || space === browserSpace) {
      return;
    }
    onBrowserSpaceChange(space);
    onActivateDisplay();
  };

  const openBookmark = (bookmark: BrowserBookmarkPayload) => {
    onActivateDisplay();
    void window.electronAPI.browser.navigate(bookmark.url);
  };

  const openNewTab = () => {
    onActivateDisplay();
    void window.electronAPI.browser.newTab();
  };

  const selectAgentSessionBrowser = (value: string | null) => {
    if (!selectedWorkspaceId || !value) {
      return;
    }
    onActivateDisplay();
    void window.electronAPI.browser.setActiveWorkspace(
      selectedWorkspaceId,
      "agent",
      value,
    );
  };

  const hasBookmarks =
    bookmarkTree.rootBookmarks.length > 0 || bookmarkTree.folders.length > 0;
  const hasTabs = browserState.tabs.length > 0;

  // Slide direction mirrors the switcher button position — scopes slide in
  // from their own side, giving clicks a spatial "pushed-from-here" feel.
  const slideInClass =
    browserSpace === "user"
      ? "slide-in-from-left-3"
      : "slide-in-from-right-3";

  const renderBookmarkButton = (
    bookmark: BrowserBookmarkPayload,
    depth = 0,
  ) => (
    <Button
      key={bookmark.id}
      variant="ghost"
      size="sm"
      onClick={() => openBookmark(bookmark)}
      className="h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent"
      style={depth > 0 ? { paddingLeft: `${10 + depth * 14}px` } : undefined}
    >
      <Favicon
        url={bookmark.faviconUrl}
        className="size-4 shrink-0 rounded-sm"
        fallback={
          <div className="grid size-4 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
            <Star className="size-2.5" />
          </div>
        }
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">
          {bookmark.title}
        </div>
      </div>
    </Button>
  );

  const renderBookmarkFolder = (
    folder: ReturnType<typeof buildBrowserBookmarkTree>["folders"][number],
    depth = 0,
  ): ReactNode => {
    const isExpanded = !collapsedBookmarkFolderKeys.has(folder.key);
    return (
      <div key={folder.key} className="space-y-0.5">
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-label={`${isExpanded ? "Collapse" : "Expand"} bookmark folder ${folder.name}`}
          onClick={() => {
            setCollapsedBookmarkFolderKeys((current) => {
              const next = new Set(current);
              if (next.has(folder.key)) {
                next.delete(folder.key);
              } else {
                next.add(folder.key);
              }
              return next;
            });
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            depth === 0
              ? "text-[10px] font-medium uppercase tracking-[0.08em]"
              : "text-xs",
          )}
          style={depth > 0 ? { paddingLeft: `${10 + depth * 14}px` } : undefined}
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 transition-transform duration-150",
              isExpanded ? "rotate-90" : "",
            )}
          />
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="truncate">{folder.name}</span>
        </button>
        {isExpanded ? (
          <>
            {folder.bookmarks.map((bookmark) =>
              renderBookmarkButton(bookmark, depth + 1),
            )}
            {folder.folders.map((childFolder) =>
              renderBookmarkFolder(childFolder, depth + 1),
            )}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      {/* Animated content region — remounts on scope change to replay
          the slide-in; the bottom switcher below stays stable. */}
      <div
        key={browserSpace}
        className={`flex min-h-0 flex-1 flex-col animate-in fade-in-0 duration-200 ease-out ${slideInClass}`}
      >
      {/* Agent session line — single-row indicator. Dot color carries
          status; chevron only when there are multiple sessions to switch
          between. Sits flush with the content below, no border. */}
      {browserSpace === "agent" ? (
        <div className="shrink-0 px-2 pt-2">
          {sortedAgentSessions.length === 0 ? (
            <div className="px-2.5 py-1 text-xs text-muted-foreground">
              No agent sessions
            </div>
          ) : sortedAgentSessions.length === 1 ? (
            <div
              className="flex items-center gap-2 px-2.5 py-1 text-xs leading-none"
              title={sessionBrowserStatus?.label ?? "Agent session"}
            >
              <StatusDot
                variant={sessionDotVariant(
                  (sessionBrowserStatus?.tone as SessionStatusTone) ?? "idle",
                )}
                pulse={sessionBrowserStatus?.flashing ?? false}
              />
              <span className="min-w-0 flex-1 truncate text-foreground">
                {currentSessionLabel}
              </span>
            </div>
          ) : (
            <Select
              value={browserState.sessionId ?? undefined}
              onValueChange={selectAgentSessionBrowser}
            >
              <SelectTrigger
                className="h-7 w-full gap-2 rounded-md border-transparent bg-transparent px-2.5 text-xs leading-none shadow-none hover:bg-accent data-[popup-open]:bg-accent dark:bg-transparent dark:hover:bg-accent"
                title={sessionBrowserStatus?.label ?? "Agent session"}
              >
                <SelectValue>
                  <StatusDot
                    variant={sessionDotVariant(
                      (sessionBrowserStatus?.tone as SessionStatusTone) ??
                        "idle",
                    )}
                    pulse={sessionBrowserStatus?.flashing ?? false}
                  />
                  <span className="min-w-0 flex-1 truncate leading-none text-foreground">
                    {currentSessionLabel}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                sideOffset={6}
                className="p-1"
              >
                {sortedAgentSessions.map((session) => {
                  const runtimeState =
                    runtimeStatesBySessionId[session.session_id] ?? null;
                  const { tone, flashing } =
                    toneFromRuntimeStatus(runtimeState);
                  return (
                    <SelectItem
                      key={session.session_id}
                      value={session.session_id}
                      className="items-start gap-2 rounded-md px-2.5 py-1.5 text-xs"
                    >
                      <StatusDot
                        variant={sessionDotVariant(tone)}
                        pulse={flashing}
                        className="mt-1"
                      />
                      <span
                        className="min-w-0 flex-1 whitespace-normal leading-snug text-foreground line-clamp-2"
                        title={browserSessionStatusLabel(runtimeState)}
                      >
                        {browserSessionTitle(session, session.session_id)}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          )}
        </div>
      ) : null}

      {/* Scrollable content: bookmarks (when any) + tabs */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {hasBookmarks ? (
          <div className="mb-3 space-y-0.5">
            <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Bookmarks
            </div>
            {bookmarkTree.folders.map((folder) => renderBookmarkFolder(folder))}
            {bookmarkTree.rootBookmarks.length > 0 ? (
              bookmarkTree.folders.length > 0 ? (
                <div className="pt-1">
                  <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    Saved
                  </div>
                  {bookmarkTree.rootBookmarks.map((bookmark) =>
                    renderBookmarkButton(bookmark),
                  )}
                </div>
              ) : (
                bookmarkTree.rootBookmarks.map((bookmark) =>
                  renderBookmarkButton(bookmark),
                )
              )
            ) : null}
          </div>
        ) : null}

        <div className="space-y-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={openNewTab}
            aria-label="Open new tab"
            className="h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <div className="grid size-4 shrink-0 place-items-center">
              <Plus className="size-3.5" />
            </div>
            <span className="text-sm">New tab</span>
          </Button>

          {hasTabs ? (
            browserState.tabs.map((tab) => {
              const isActive = tab.id === activeTab.id;
              return (
                <div
                  key={tab.id}
                  className={`group relative flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors ${
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onActivateDisplay();
                      void window.electronAPI.browser.setActiveTab(tab.id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    title={tab.title || tab.url}
                  >
                    <Favicon
                      url={tab.faviconUrl}
                      className="size-4 shrink-0 rounded-sm"
                      fallback={
                        <div className="grid size-4 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground">
                          {browserSpace === "agent" ? (
                            <Bot className="size-2.5" />
                          ) : (
                            <Globe className="size-2.5" />
                          )}
                        </div>
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">
                        {tab.title || "New Tab"}
                      </div>
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => {
                      onActivateDisplay();
                      void window.electronAPI.browser.closeTab(tab.id);
                    }}
                    aria-label={`Close ${tab.title || "tab"}`}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              );
            })
          ) : (
            <EmptyState
              icon={Globe}
              size="md"
              title={`No open tabs in the ${browserSpace} browser.`}
            />
          )}
        </div>
      </div>
      </div>

      {/* Bottom scope switcher */}
      <div className="flex shrink-0 gap-1 border-t border-border p-1">
        {(
          [
            {
              value: "user" as const,
              label: "User",
              icon: User,
              count: browserState.tabCounts.user,
              showPending: false,
            },
            {
              value: "agent" as const,
              label: "Agent",
              icon: Bot,
              count: browserState.tabCounts.agent,
              showPending: hasPendingAgentJump && browserSpace !== "agent",
            },
          ] as const
        ).map(({ value, label, icon: Icon, count, showPending }) => {
          const isActive = browserSpace === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => openBrowserSpace(value)}
              aria-pressed={isActive}
              className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.98] ${
                isActive
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Icon className="size-3.5" />
              <span>{label}</span>
              <span className="text-muted-foreground tabular-nums">
                {count}
              </span>
              {showPending ? (
                <StatusDot
                  variant="primary"
                  pulse
                  className="absolute right-1 top-1"
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
