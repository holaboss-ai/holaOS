import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FirstWorkspacePane } from "@/components/onboarding/FirstWorkspacePane";
import { WorkspaceControlCenter } from "@/components/layout/WorkspaceControlCenter";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { PublishScreen } from "@/components/publish/PublishScreen";
import { WorkspaceOnboardingSurface } from "@/features/workspace-onboarding/WorkspaceOnboardingSurface";
import { DesktopBillingProvider } from "@/lib/billing/useDesktopBilling";
import { useControlCenterCardSignals } from "@/lib/controlCenterLifecycle";
import {
  STOPLIGHT_PAD_PX,
  StoplightProvider,
} from "@/lib/StoplightContext";
import { cn } from "@/lib/utils";
import {
  useWorkspaceDesktop,
  WorkspaceDesktopProvider,
} from "@/lib/workspaceDesktop";
import {
  useWorkspaceSelection,
  WorkspaceSelectionProvider,
} from "@/lib/workspaceSelection";
import { Center } from "./Center";
import { ChatPanel } from "./ChatPanel";
import { NewIssueDialog } from "./NewIssueDialog";
import { NewTabDialog } from "./NewTabDialog";
import { NotificationStack } from "./NotificationStack";
import { Overlays } from "./Overlays";
import { SearchDialog } from "./SearchDialog";
import { Sidebar } from "./Sidebar";
import {
  activeInternalTabIdAtom,
  internalTabsAtom,
} from "./state/internalTabs";
import {
  controlCenterOpenAtom,
  createWorkspaceOpenAtom,
  focusModeAtom,
  newTabOpenAtom,
  publishOpenAtom,
  searchOpenAtom,
  sidebarCollapsedAtom,
  workspaceMainViewModeMapAtom,
} from "./state/ui";
import { TopChrome } from "./TopChrome";
import { useChatLayout } from "./useChatLayout";

export function AppShell() {
  return (
    <WorkspaceSelectionProvider>
      <WorkspaceDesktopProvider>
        <DesktopBillingProvider>
          <StoplightProvider value={true}>
            <AppShellContent />
          </StoplightProvider>
        </DesktopBillingProvider>
      </WorkspaceDesktopProvider>
    </WorkspaceSelectionProvider>
  );
}

function AppShellContent() {
  const setNewTabOpen = useSetAtom(newTabOpenAtom);
  const setSearchOpen = useSetAtom(searchOpenAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const { selectedWorkspaceId, setSelectedWorkspaceId } =
    useWorkspaceSelection();
  const { onboardingModeActive, workspaces, hasHydratedWorkspaceList } =
    useWorkspaceDesktop();
  const [publishOpen, setPublishOpen] = useAtom(publishOpenAtom);
  const createWorkspaceOpen = useAtomValue(createWorkspaceOpenAtom);
  const setCreateWorkspaceOpen = useSetAtom(createWorkspaceOpenAtom);
  const [controlCenterOpen, setControlCenterOpen] = useAtom(
    controlCenterOpenAtom,
  );
  const hasWorkspaces = workspaces.length > 0;
  const layout = useChatLayout();
  const [focusMode, setFocusMode] = useAtom(focusModeAtom);
  const workspaceMainViewMap = useAtomValue(workspaceMainViewModeMapAtom);
  const { browserState } = useWorkspaceBrowser("user");
  const internalTabs = useAtomValue(internalTabsAtom);
  const setInternalTabs = useSetAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const totalTabs = browserState.tabs.length + internalTabs.length;
  const prevTotalTabsRef = useRef(totalTabs);
  const seededMainViewWorkspaceIdRef = useRef<string | null>(null);
  const prevSelectedWorkspaceIdRef = useRef<string | null>(selectedWorkspaceId);
  const desktopPlatform = window.electronAPI?.platform ?? null;
  const isWindowsTitleBar = desktopPlatform === "win32";

  // Seed focusMode from the workspace's stored main-view preference whenever
  // the user switches to a workspace we haven't seeded yet this session.
  // Re-seeding on every activation would clobber the in-session focus toggle,
  // so we track which workspace id we've already applied. The choice itself
  // is set at workspace creation (FirstWorkspacePane) and persisted in
  // workspaceMainViewModeMapAtom keyed by workspace id.
  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (seededMainViewWorkspaceIdRef.current === selectedWorkspaceId) return;
    seededMainViewWorkspaceIdRef.current = selectedWorkspaceId;
    const preference = workspaceMainViewMap[selectedWorkspaceId];
    if (preference === "chat" && !focusMode) {
      setFocusMode(true);
    } else if (preference === "workspace" && focusMode) {
      setFocusMode(false);
    }
    // Workspaces with no recorded preference (created before this feature
    // shipped) inherit whatever focusMode currently is — no surprises.
  }, [selectedWorkspaceId, workspaceMainViewMap, focusMode, setFocusMode]);

  // Internal (file/image) tabs live in a global atom; clear on every
  // workspace switch so a brand-new or freshly-selected workspace doesn't
  // inherit the previous workspace's open file tabs.
  useEffect(() => {
    setInternalTabs([]);
    setActiveInternalTabId(null);
  }, [selectedWorkspaceId, setInternalTabs, setActiveInternalTabId]);

  // Auto-exit focus when a new tab appears (⌘T, chat link, sidebar app).
  // Opening a tab is an explicit "show me this" signal; staying hidden
  // would be confusing. Re-baseline on workspace switch — a cross-workspace
  // tab-count comparison would falsely trip auto-exit on any newly-created
  // chat-mode workspace whose tab list differs from the previous one.
  useEffect(() => {
    if (prevSelectedWorkspaceIdRef.current !== selectedWorkspaceId) {
      prevSelectedWorkspaceIdRef.current = selectedWorkspaceId;
      prevTotalTabsRef.current = totalTabs;
      return;
    }
    if (focusMode && totalTabs > prevTotalTabsRef.current) {
      setFocusMode(false);
    }
    prevTotalTabsRef.current = totalTabs;
  }, [focusMode, totalTabs, selectedWorkspaceId, setFocusMode]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "t") {
        e.preventDefault();
        setNewTabOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        setControlCenterOpen((prev) => !prev);
      } else if (e.key === "Escape") {
        // Only swallow Escape when CC is open; other consumers (composers,
        // dialogs) keep their own ESC handling intact.
        setControlCenterOpen((prev) => {
          if (prev) return false;
          return prev;
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    setNewTabOpen,
    setSearchOpen,
    setSidebarCollapsed,
    setControlCenterOpen,
  ]);

  if (hasHydratedWorkspaceList && !hasWorkspaces) {
    return (
      <div className="flex h-screen w-screen overflow-hidden text-foreground antialiased">
        <FirstWorkspacePane variant="full" />
      </div>
    );
  }

  const showMiddle = layout === "split";
  const showControlCenter = controlCenterOpen;

  return (
    <div className="relative flex h-screen w-screen overflow-hidden text-foreground antialiased">
      {showControlCenter ? null : <Sidebar />}
      {onboardingModeActive ? (
        <div className="flex min-w-0 flex-1 flex-col bg-background">
          <ExperimentalWorkspaceOnboardingTakeover />
        </div>
      ) : showControlCenter ? (
        <ControlCenterTakeover
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          onClose={() => setControlCenterOpen(false)}
          onSelectWorkspace={(id) => setSelectedWorkspaceId(id)}
          onEnterWorkspace={(id) => {
            setSelectedWorkspaceId(id);
            setControlCenterOpen(false);
          }}
          onCreateWorkspace={() => {
            setControlCenterOpen(false);
            setCreateWorkspaceOpen(true);
          }}
        />
      ) : (
        <>
          <div
            className={cn(
              "flex min-w-0 flex-col bg-background",
              showMiddle ? "flex-1" : "hidden",
            )}
          >
            <TopChrome />
            <Center />
          </div>
          <ChatPanel layout={layout} />
        </>
      )}
      <NewIssueDialog />
      <NewTabDialog />
      <SearchDialog />
      <Overlays />
      <NotificationStack />
      {isWindowsTitleBar ? <WindowsTitlebarControls /> : null}
      {selectedWorkspaceId ? (
        <PublishScreen
          open={publishOpen}
          onOpenChange={setPublishOpen}
          onViewSubmission={() => {
            // Settings flow not wired in new shell yet; deferred to a
            // later step when SettingsScreenRoot is shared between shells.
          }}
          workspaceId={selectedWorkspaceId}
        />
      ) : null}
      {createWorkspaceOpen ? (
        <FirstWorkspacePane
          variant="panel"
          onClose={() => setCreateWorkspaceOpen(false)}
        />
      ) : null}
    </div>
  );
}

function WindowsTitlebarControls() {
  const [windowState, setWindowState] = useState<DesktopWindowStatePayload>({
    isFullScreen: false,
    isMaximized: false,
    isMinimized: false,
  });

  useEffect(() => {
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
  }, []);

  const windowControlButtonClassName =
    "window-no-drag flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-foreground/55 transition-colors duration-150 hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

  return (
    <div className="window-drag absolute top-0 right-0 z-40 flex h-10 items-center pr-2 pl-6">
      <div className="window-no-drag flex items-center gap-0.5">
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
    </div>
  );
}

function ExperimentalWorkspaceOnboardingTakeover() {
  return (
    <section className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_16%,rgba(247,90,84,0.1),transparent_28%),radial-gradient(circle_at_88%_10%,rgba(247,170,126,0.08),transparent_24%),radial-gradient(circle_at_50%_100%,rgba(247,90,84,0.06),transparent_34%)]" />
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <WorkspaceOnboardingSurface />
      </div>
    </section>
  );
}

// Wraps WorkspaceControlCenter for the new shell. Drag-reorder, density,
// and completion highlights are deferred to a follow-up that lifts those
// state slices out of legacy AppShell into shared atoms/hooks.
function ControlCenterTakeover(props: {
  workspaces: WorkspaceRecordPayload[];
  selectedWorkspaceId: string | null;
  onClose: () => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onEnterWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: () => void;
}) {
  const visibleWorkspaceIdsRef = useRef<string[]>([]);
  const cardSignals = useControlCenterCardSignals(
    visibleWorkspaceIdsRef.current,
    true,
  );

  // macOS traffic lights sit at fixed window coords (x:14 y:16); we'd
  // overlap them if we pinned the close button to the actual top-left.
  // Reserve their footprint with the shared STOPLIGHT_PAD_PX so the X
  // lands just past the rightmost stoplight glyph. Other platforms get a
  // tight inset.
  const platform = window.electronAPI?.platform ?? "";
  const isMac = platform === "darwin";
  const headerLeftPad = isMac ? STOPLIGHT_PAD_PX : 12;

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      {/* Drag handle + close. CC takes over the whole right side, so this
          replaces TopChrome as the window-drag region — without it the
          frameless window can't be moved while CC is open. */}
      <div
        className="window-drag flex h-10 shrink-0 items-center pr-2"
        style={{ paddingLeft: headerLeftPad }}
      >
        <button
          type="button"
          aria-label="Close all workspaces"
          title="Close (Esc / ⌘0)"
          onClick={props.onClose}
          className="window-no-drag grid size-7 place-items-center rounded-md text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <WorkspaceControlCenter
        workspaces={props.workspaces}
        selectedWorkspaceId={props.selectedWorkspaceId}
        cardsPerRow={3}
        orderedWorkspaceIds={[]}
        highlightedWorkspaceIds={[]}
        cardSignals={cardSignals}
        onOpenWorkspaceRunningTasks={props.onEnterWorkspace}
        onOpenWorkspaceAppsExplorer={props.onEnterWorkspace}
        onSelectWorkspace={props.onSelectWorkspace}
        onEnterWorkspace={props.onEnterWorkspace}
        onOpenOutput={(workspaceId) => props.onEnterWorkspace(workspaceId)}
        onWorkspaceOrderChange={() => {
          /* drag reorder deferred to a follow-up */
        }}
        onVisibleWorkspaceIdsChange={(ids) => {
          visibleWorkspaceIdsRef.current = ids;
        }}
        onCardComposerSubmit={() => {
          /* highlight suppression handled by AppShell; no-op here */
        }}
        onWorkspaceCompletion={() => {
          /* completion highlights deferred to a follow-up */
        }}
        onCreateWorkspace={props.onCreateWorkspace}
      />
    </div>
  );
}
