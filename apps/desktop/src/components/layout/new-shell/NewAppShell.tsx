import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { FirstWorkspacePane } from "@/components/onboarding/FirstWorkspacePane";
import { WorkspaceControlCenter } from "@/components/layout/WorkspaceControlCenter";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { PublishScreen } from "@/components/publish/PublishScreen";
import { WorkspaceOnboardingSurface } from "@/features/workspace-onboarding/WorkspaceOnboardingSurface";
import { DesktopBillingProvider } from "@/lib/billing/useDesktopBilling";
import { useControlCenterCardSignals } from "@/lib/controlCenterLifecycle";
import { useDesktopPlatform } from "@/lib/desktopPlatform";
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
import { NewTabDialog } from "./NewTabDialog";
import { NotificationStack } from "./NotificationStack";
import { Overlays } from "./Overlays";
import { SearchDialog } from "./SearchDialog";
import { Sidebar } from "./Sidebar";
import { internalTabsAtom } from "./state/internalTabs";
import {
  controlCenterOpenAtom,
  createWorkspaceOpenAtom,
  focusModeAtom,
  newTabOpenAtom,
  publishOpenAtom,
  searchOpenAtom,
  sidebarCollapsedAtom,
} from "./state/ui";
import { TopChrome } from "./TopChrome";
import { useChatLayout } from "./useChatLayout";
import { WindowControls } from "./WindowControls";

export function NewAppShell() {
  return (
    <WorkspaceSelectionProvider>
      <WorkspaceDesktopProvider>
        <DesktopBillingProvider>
          <NewAppShellContent />
        </DesktopBillingProvider>
      </WorkspaceDesktopProvider>
    </WorkspaceSelectionProvider>
  );
}

function NewAppShellContent() {
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
  const { browserState } = useWorkspaceBrowser("user");
  const internalTabs = useAtomValue(internalTabsAtom);
  const totalTabs = browserState.tabs.length + internalTabs.length;
  const prevTotalTabsRef = useRef(totalTabs);

  // Auto-exit focus when a new tab appears (⌘T, chat link, sidebar app).
  // Opening a tab is an explicit "show me this" signal; staying hidden
  // would be confusing.
  useEffect(() => {
    if (focusMode && totalTabs > prevTotalTabsRef.current) {
      setFocusMode(false);
    }
    prevTotalTabsRef.current = totalTabs;
  }, [focusMode, totalTabs, setFocusMode]);

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
    <div className="flex h-screen w-screen overflow-hidden text-foreground antialiased">
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
      <NewTabDialog />
      <SearchDialog />
      <Overlays />
      <NotificationStack />
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
  const platform = useDesktopPlatform();
  const isWin = platform === "win32";

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-background">
      {/* Mini top bar: drag region (so the frameless window remains
          movable now that TopChrome is hidden) + close at top-right.
          We pin close to the right because macOS traffic lights own the
          top-left corner. On Windows the platform caption controls sit
          flush right, with the CC close button just to their left. */}
      <div
        className={cn(
          "window-drag flex h-10 shrink-0 items-center",
          isWin ? "pr-0" : "pr-2",
        )}
      >
        <div className="flex-1" aria-hidden />
        <button
          type="button"
          aria-label="Close all workspaces"
          title="Close (Esc / ⌘0)"
          onClick={props.onClose}
          className="window-no-drag grid size-7 place-items-center rounded-md text-foreground/55 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
        {isWin ? <WindowControls /> : null}
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
