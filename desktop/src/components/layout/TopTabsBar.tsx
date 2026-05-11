import {
  AlertTriangle,
  BookText,
  ChevronDown,
  CircleUserRound,
  Copy,
  FolderKanban,
  House,
  LayoutGrid,
  Loader2,
  Minus,
  PanelRight,
  PanelRightDashed,
  Plus,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { NotificationInbox } from "@/components/layout/NotificationInbox";
import {
  RuntimeStatusIndicator,
  runtimeStatusVisual,
} from "@/components/layout/RuntimeStatusIndicator";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { WorkspaceIcon } from "@/components/ui/workspace-icon";
import { WorkspaceIconPicker } from "@/components/ui/workspace-icon-picker";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { useDesktopBilling } from "@/lib/billing/useDesktopBilling";
import {
  STOPLIGHT_PAD_PX,
  useStoplightCompensation,
} from "@/lib/StoplightContext";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

interface TopTabsBarProps {
  integratedTitleBar?: boolean;
  desktopPlatform?: string | null;
  runtimeStatus?: RuntimeStatusPayload | null;
  controlCenterActive?: boolean;
  chatPanelHidden?: boolean;
  showChatPanelToggle?: boolean;
  onToggleChatPanel?: () => void;
  inboxNotifications?: RuntimeNotificationRecordPayload[];
  inboxWorkspacesById?: Map<string, WorkspaceRecordPayload>;
  onActivateInboxNotification?: (notificationId: string) => void;
  onDismissInboxNotification?: (notificationId: string) => void;
  onMarkAllInboxNotificationsRead?: () => void;
  onOpenControlCenter?: () => void;
  onWorkspaceSwitcherVisibilityChange?: (open: boolean) => void;
  onOpenWorkspaceCreatePanel?: () => void;
  onOpenSettings?: () => void;
  onOpenAccount?: () => void;
  onOpenBilling?: () => void;
  onOpenExternalUrl?: (url: string) => void;
  onPublish?: () => void;
}

export function TopTabsBar({
  integratedTitleBar = false,
  desktopPlatform = null,
  runtimeStatus = null,
  controlCenterActive = false,
  chatPanelHidden = false,
  showChatPanelToggle = false,
  onToggleChatPanel,
  inboxNotifications,
  inboxWorkspacesById,
  onActivateInboxNotification,
  onDismissInboxNotification,
  onMarkAllInboxNotificationsRead,
  onOpenControlCenter,
  onWorkspaceSwitcherVisibilityChange,
  onOpenWorkspaceCreatePanel,
  onOpenSettings,
  onOpenAccount,
  onOpenBilling,
  onOpenExternalUrl,
  onPublish,
}: TopTabsBarProps) {
  const [inboxOpen, setInboxOpen] = useState(false);
  // Mac stoplight compensation now flows through StoplightContext (set in
  // AppShell); the hook returns true only on darwin AND when the provider
  // says we have an integrated title bar. We still keep the platform prop
  // for the Windows-only chrome adjustments below.
  const compensateForStoplight = useStoplightCompensation();
  const isWindowsIntegratedTitleBar =
    integratedTitleBar && desktopPlatform === "win32";
  const {
    isAvailable: isBillingAvailable,
    overview,
    isLoading: isBillingLoading,
    isLowBalance,
  } = useDesktopBilling();
  const { data: authSession } = useDesktopAuthSession();
  const currentUser = authSession?.user ?? null;
  const userButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceSwitcherRef = useRef<HTMLDivElement | null>(null);
  const workspaceSwitcherButtonRef = useRef<HTMLButtonElement | null>(null);
  const workspaceSwitcherPopupRef = useRef<HTMLDivElement | null>(null);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [windowState, setWindowState] = useState<DesktopWindowStatePayload>({
    isFullScreen: false,
    isMaximized: false,
    isMinimized: false,
  });
  const [workspaceSwitcherPosition, setWorkspaceSwitcherPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const { selectedWorkspaceId, setSelectedWorkspaceId } =
    useWorkspaceSelection();
  const {
    workspaces,
    selectedWorkspace,
    deletingWorkspaceId,
    workspaceErrorMessage,
    deleteWorkspace,
    updateWorkspaceAppearance,
  } = useWorkspaceDesktop();

  const onDeleteWorkspace = async (workspace: WorkspaceRecordPayload) => {
    if (deletingWorkspaceId) {
      return;
    }
    const confirmed = window.confirm(`Delete workspace '${workspace.name}'?`);
    if (!confirmed) {
      return;
    }
    try {
      await deleteWorkspace(workspace.id);
    } catch {
      // workspaceErrorMessage is already set by the shared desktop state
    }
  };

  const closeWorkspaceSwitcher = () => {
    setWorkspaceSwitcherOpen(false);
    setWorkspaceQuery("");
  };

  const updateWorkspaceSwitcherPosition = useCallback(() => {
    if (!workspaceSwitcherButtonRef.current || typeof window === "undefined") {
      return;
    }

    const rect = workspaceSwitcherButtonRef.current.getBoundingClientRect();
    const width = Math.min(320, Math.max(rect.width + 56, 280));
    const left = Math.min(
      Math.max(24, rect.left),
      Math.max(24, window.innerWidth - width - 24),
    );
    const top = rect.bottom + 8;
    const maxHeight = Math.max(220, window.innerHeight - top - 24);

    setWorkspaceSwitcherPosition({ top, left, width, maxHeight });
  }, []);

  const filteredWorkspaces = useMemo(() => {
    const query = workspaceQuery.trim().toLowerCase();
    if (!query) {
      return workspaces;
    }

    return workspaces.filter((workspace) => {
      return (
        workspace.name.toLowerCase().includes(query) ||
        workspace.status.toLowerCase().includes(query) ||
        (workspace.harness || "").toLowerCase().includes(query)
      );
    });
  }, [workspaceQuery, workspaces]);

  const handleTitleBarDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (!integratedTitleBar) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (
      target.closest(
        "button, input, select, textarea, a, [role='button'], .window-no-drag",
      )
    ) {
      return;
    }
    void window.electronAPI.ui.toggleWindowSize();
  };

  useEffect(() => {
    onWorkspaceSwitcherVisibilityChange?.(workspaceSwitcherOpen);
  }, [onWorkspaceSwitcherVisibilityChange, workspaceSwitcherOpen]);

  useEffect(() => {
    if (!controlCenterActive || !workspaceSwitcherOpen) {
      return;
    }
    closeWorkspaceSwitcher();
  }, [controlCenterActive, workspaceSwitcherOpen]);

  useEffect(() => {
    if (!isWindowsIntegratedTitleBar) {
      return;
    }

    let mounted = true;
    void window.electronAPI.ui.getWindowState().then((nextState) => {
      if (mounted) {
        setWindowState(nextState);
      }
    });

    const unsubscribe = window.electronAPI.ui.onWindowStateChange(
      (nextState) => {
        if (mounted) {
          setWindowState(nextState);
        }
      },
    );

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [isWindowsIntegratedTitleBar]);

  useEffect(() => {
    if (!workspaceSwitcherOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (workspaceSwitcherRef.current?.contains(target)) {
        return;
      }
      if (workspaceSwitcherPopupRef.current?.contains(target)) {
        return;
      }
      closeWorkspaceSwitcher();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [workspaceSwitcherOpen]);

  useEffect(() => {
    if (!workspaceSwitcherOpen) {
      return;
    }

    updateWorkspaceSwitcherPosition();

    let rafId: number | null = null;
    const syncPosition = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        updateWorkspaceSwitcherPosition();
      });
    };
    window.addEventListener("resize", syncPosition);
    window.addEventListener("scroll", syncPosition, true);

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      window.removeEventListener("resize", syncPosition);
      window.removeEventListener("scroll", syncPosition, true);
    };
  }, [updateWorkspaceSwitcherPosition, workspaceSwitcherOpen]);

  const headerClassName = integratedTitleBar
    ? isWindowsIntegratedTitleBar
      ? "window-drag relative h-[32px] px-2 pt-0.5"
      : "window-drag relative h-[32px] px-2"
    : "rounded-xl border border-border bg-card px-2.5 py-1 shadow-2xs backdrop-blur-sm sm:px-4";
  const headerGridClassName =
    "relative z-10 grid min-w-0 items-center gap-1.5 sm:gap-2 lg:h-full lg:grid-cols-[minmax(0,1fr)_auto]";
  const headerGridStyle = compensateForStoplight
    ? { paddingLeft: STOPLIGHT_PAD_PX }
    : undefined;

  const windowControlButtonClassName =
    "window-no-drag flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors duration-150 hover:bg-fg-6 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
  const workspaceSwitcherContainerClassName = `${integratedTitleBar ? "window-no-drag " : ""}relative w-40 shrink-0`;
  const workspaceSwitcherButtonClassName = "w-full justify-start";

  return (
    <header
      onDoubleClick={handleTitleBarDoubleClick}
      className={headerClassName}
    >
      <div className={headerGridClassName} style={headerGridStyle}>
        {/* LEFT: layout controls — VSCode-style panel toggle anchors the
            top-left corner; future view-mode toggles slot in here too. */}
        <div
          className={`${integratedTitleBar ? "window-no-drag " : ""}hidden min-w-0 items-center gap-1.5 lg:flex`}
        >
          {showChatPanelToggle && onToggleChatPanel ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      chatPanelHidden ? "Show chat panel" : "Hide chat panel"
                    }
                    aria-pressed={chatPanelHidden}
                    onClick={() => onToggleChatPanel()}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {chatPanelHidden ? <PanelRightDashed /> : <PanelRight />}
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                {chatPanelHidden ? "Show chat panel" : "Hide chat panel"}
                <span className="ml-1.5 text-muted-foreground">
                  {desktopPlatform === "darwin" ? "⌘\\" : "Ctrl+\\"}
                </span>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>

        <div
          className={`${integratedTitleBar ? "window-no-drag " : ""}flex min-w-0 items-center justify-self-end gap-1.5`}
        >
          {/* Workspace navigation: control center toggle + workspace switcher */}
          {!controlCenterActive ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="bordered"
                    size="icon-sm"
                    aria-label="Open control center"
                    onClick={() => onOpenControlCenter?.()}
                  >
                    <LayoutGrid />
                  </Button>
                }
              />
              <TooltipContent side="bottom">Control center</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="bordered"
                    size="icon-sm"
                    aria-label="Create new workspace"
                    onClick={() => onOpenWorkspaceCreatePanel?.()}
                  >
                    <Plus />
                  </Button>
                }
              />
              <TooltipContent side="bottom">Create new workspace</TooltipContent>
            </Tooltip>
          )}
          {!controlCenterActive ? (
            <div
              ref={workspaceSwitcherRef}
              className={workspaceSwitcherContainerClassName}
            >
              <Button
                ref={workspaceSwitcherButtonRef}
                variant="bordered"
                size="sm"
                aria-expanded={workspaceSwitcherOpen}
                onClick={() => {
                  setWorkspaceSwitcherOpen((open) => {
                    const nextOpen = !open;
                    if (!nextOpen) {
                      setWorkspaceQuery("");
                    } else {
                      requestAnimationFrame(() => {
                        updateWorkspaceSwitcherPosition();
                      });
                    }
                    return nextOpen;
                  });
                }}
                className={workspaceSwitcherButtonClassName}
              >
                {selectedWorkspace ? (
                  <WorkspaceIcon workspace={selectedWorkspace} size="sm" />
                ) : (
                  <FolderKanban />
                )}
                <span className="min-w-0 truncate text-left">
                  {selectedWorkspace?.name || "Select workspace"}
                </span>
                <ChevronDown
                  className={`ml-auto transition-transform ${workspaceSwitcherOpen ? "rotate-180" : ""}`}
                />
              </Button>
            </div>
          ) : null}
          {/* Runtime indicator self-hides when status === "running"; only
              shows when there's something the user might need to react to. */}
          <RuntimeStatusIndicator status={runtimeStatus} />
          {inboxNotifications &&
          inboxWorkspacesById &&
          onActivateInboxNotification &&
          onDismissInboxNotification &&
          onMarkAllInboxNotificationsRead ? (
            <NotificationInbox
              open={inboxOpen}
              onOpenChange={setInboxOpen}
              notifications={inboxNotifications}
              workspacesById={inboxWorkspacesById}
              onActivate={(id) => {
                setInboxOpen(false);
                onActivateInboxNotification(id);
              }}
              onDismiss={onDismissInboxNotification}
              onMarkAllRead={() => {
                onMarkAllInboxNotificationsRead();
                setInboxOpen(false);
              }}
            />
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={userButtonRef}
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Open account menu"
                  className="size-7 shrink-0 overflow-hidden rounded-full border border-border bg-fg-6 p-0"
                />
              }
            >
              <UserAvatar user={currentUser} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8} className="w-72 p-1">
              {/* Profile header — identity on the left, status badges on the
                  right (credits acts like a PRO/plan chip in the reference).
                  items-center keeps the avatar visually centered against
                  whatever number of text rows we end up rendering. */}
              <div className="flex items-center gap-3 px-2 pt-2 pb-2.5">
                <div className="size-9 shrink-0 overflow-hidden rounded-full border border-border bg-fg-6">
                  <UserAvatar user={currentUser} />
                </div>
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {currentUser?.name?.trim() ||
                    currentUser?.email?.split("@")[0] ? (
                      <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
                        {currentUser?.name?.trim() ||
                          currentUser?.email?.split("@")[0]}
                      </div>
                    ) : (
                      <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
                        Not signed in
                      </div>
                    )}
                    {currentUser?.email ? (
                      <div className="mt-1 truncate text-[11px] leading-tight text-muted-foreground">
                        {currentUser.email}
                      </div>
                    ) : !currentUser ? (
                      <div className="mt-1 truncate text-[11px] leading-tight text-muted-foreground">
                        Open Account to sign in
                      </div>
                    ) : null}
                  </div>
                  {isBillingAvailable ? (
                    <button
                      type="button"
                      onClick={() => onOpenBilling?.()}
                      aria-label={
                        isLowBalance
                          ? "Credits balance low — open billing"
                          : "Open billing"
                      }
                      className={cn(
                        "shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors",
                        isLowBalance
                          ? "bg-warning/10 text-warning hover:bg-warning/15"
                          : "bg-fg-6 text-foreground hover:bg-fg-12",
                      )}
                    >
                      {isLowBalance ? (
                        <AlertTriangle className="size-3" />
                      ) : (
                        <Sparkles className="size-3 opacity-70" />
                      )}
                      {isBillingLoading ? (
                        <span className="h-2.5 w-8 animate-pulse rounded bg-muted" />
                      ) : (
                        (overview?.creditsBalance ?? 0).toLocaleString()
                      )}
                    </button>
                  ) : null}
                </div>
              </div>

              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => onOpenAccount?.()}>
                  <CircleUserRound className="opacity-60 size-3.5" />
                  Account
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenSettings?.()}>
                  <Settings className="opacity-60 size-3.5" />
                  Settings
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onClick={() => onOpenExternalUrl?.("https://www.holaos.ai")}
                >
                  <House className="opacity-60 size-3.5" />
                  Homepage
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    onOpenExternalUrl?.("https://www.holaboss.ai/docs")
                  }
                >
                  <BookText className="opacity-60 size-3.5" />
                  Docs
                </DropdownMenuItem>
              </DropdownMenuGroup>

              {/* Footer: passive runtime status — always visible here even
                  when the bar button auto-hides during healthy state */}
              {runtimeStatus ? (
                <>
                  <DropdownMenuSeparator />
                  <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-1 text-[10px] text-muted-foreground/80">
                    <StatusDot
                      variant={
                        runtimeStatusVisual(runtimeStatus.status).dotVariant
                      }
                      pulse={runtimeStatusVisual(runtimeStatus.status).dotPulse}
                      size="sm"
                    />
                    <span>{runtimeStatusVisual(runtimeStatus.status).label}</span>
                  </div>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {isWindowsIntegratedTitleBar ? (
            <div className="window-no-drag ml-1 -mr-1.5 flex items-center gap-0.5 sm:-mr-2">
              <button
                type="button"
                aria-label="Minimize window"
                className={windowControlButtonClassName}
                onClick={() => {
                  void window.electronAPI.ui.minimizeWindow();
                }}
              >
                <Minus className="size-3.5" strokeWidth={2.1} />
              </button>
              <button
                type="button"
                aria-label={
                  windowState.isMaximized || windowState.isFullScreen
                    ? "Restore window"
                    : "Maximize window"
                }
                className={windowControlButtonClassName}
                onClick={() => {
                  void window.electronAPI.ui.toggleWindowSize();
                }}
              >
                {windowState.isMaximized || windowState.isFullScreen ? (
                  <Copy className="size-3.5" strokeWidth={1.9} />
                ) : (
                  <Square className="size-3.5" strokeWidth={1.9} />
                )}
              </button>
              <button
                type="button"
                aria-label="Close window"
                className={`${windowControlButtonClassName} hover:bg-destructive/12 hover:text-destructive`}
                onClick={() => {
                  void window.electronAPI.ui.closeWindow();
                }}
              >
                <X className="size-3.5" strokeWidth={2.1} />
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {workspaceErrorMessage ? (
        <div
          className={`${integratedTitleBar ? "window-no-drag " : ""}theme-chat-system-bubble mt-2 rounded-2xl border px-3 py-2 text-xs leading-6`}
        >
          {workspaceErrorMessage}
        </div>
      ) : null}

      {!controlCenterActive &&
      workspaceSwitcherOpen &&
      workspaceSwitcherPosition &&
      typeof document !== "undefined"
        ? createPortal(
            <div
              ref={workspaceSwitcherPopupRef}
              className={`${integratedTitleBar ? "window-no-drag " : ""}fixed z-[80] rounded-xl border border-border bg-popover p-3 shadow-xs`}
              style={{
                top: workspaceSwitcherPosition.top,
                left: workspaceSwitcherPosition.left,
                width: workspaceSwitcherPosition.width,
                maxHeight: workspaceSwitcherPosition.maxHeight,
              }}
            >
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={workspaceQuery}
                  onChange={(event) => setWorkspaceQuery(event.target.value)}
                  placeholder="Search workspaces"
                  className="embedded-input h-8 rounded-full pl-8 text-xs focus-visible:ring-0"
                />
              </div>

              <div className="max-h-[240px] overflow-y-auto">
                {filteredWorkspaces.length ? (
                  <div className="flex flex-col">
                    {filteredWorkspaces.map((workspace) => {
                      const isActive = workspace.id === selectedWorkspaceId;
                      const isDeleting = deletingWorkspaceId === workspace.id;
                      const folderMissing =
                        workspace.folder_state === "missing";
                      return (
                        <div
                          key={workspace.id}
                          className={cn(
                            "group flex items-center gap-2 px-2 py-1.5 transition-colors",
                            isActive ? "bg-fg-6" : "hover:bg-fg-2",
                            isDeleting && "opacity-50",
                          )}
                        >
                          <WorkspaceIconPicker
                            workspace={workspace}
                            size="md"
                            disabled={isDeleting}
                            onChange={({ icon, iconColor }) => {
                              void updateWorkspaceAppearance(workspace.id, {
                                icon,
                                iconColor,
                              });
                            }}
                          />
                          <button
                            type="button"
                            disabled={isDeleting}
                            onClick={() => {
                              setSelectedWorkspaceId(workspace.id);
                              closeWorkspaceSwitcher();
                            }}
                            className="flex min-w-0 flex-1 items-center gap-2 px-1 text-left text-sm font-medium disabled:cursor-not-allowed"
                          >
                            <span className="truncate">{workspace.name}</span>
                            {folderMissing ? (
                              <StatusDot
                                variant="warning"
                                className="ml-auto"
                                title={`Folder missing at ${workspace.workspace_path ?? "unknown"}`}
                              />
                            ) : null}
                          </button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Delete workspace ${workspace.name}`}
                            disabled={Boolean(deletingWorkspaceId)}
                            onClick={() => void onDeleteWorkspace(workspace)}
                            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
                          >
                            {isDeleting ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-lg border border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    No workspaces matched your search.
                  </div>
                )}
              </div>

              <div className="mt-3 border-t border-border pt-3">
                {selectedWorkspaceId && onPublish ? (
                  <Button
                    variant="outline"
                    size="default"
                    onClick={() => {
                      closeWorkspaceSwitcher();
                      onPublish();
                    }}
                    className="mb-2 w-full justify-start gap-2"
                  >
                    <Upload className="size-3.5" />
                    <span>Publish to Store</span>
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="default"
                  onClick={() => {
                    closeWorkspaceSwitcher();
                    onOpenWorkspaceCreatePanel?.();
                  }}
                  className="w-full justify-start gap-2"
                >
                  <Plus className="size-3.5" />
                  Create new workspace
                </Button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </header>
  );
}
