import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { FirstWorkspacePane } from "@/components/onboarding/FirstWorkspacePane";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { PublishScreen } from "@/components/publish/PublishScreen";
import { WorkspaceOnboardingSurface } from "@/features/workspace-onboarding/WorkspaceOnboardingSurface";
import { DesktopBillingProvider } from "@/lib/billing/useDesktopBilling";
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
  createWorkspaceOpenAtom,
  focusModeAtom,
  newTabOpenAtom,
  publishOpenAtom,
  searchOpenAtom,
  sidebarCollapsedAtom,
} from "./state/ui";
import { TopChrome } from "./TopChrome";
import { useChatLayout } from "./useChatLayout";

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
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { onboardingModeActive, workspaces, hasHydratedWorkspaceList } =
    useWorkspaceDesktop();
  const [publishOpen, setPublishOpen] = useAtom(publishOpenAtom);
  const createWorkspaceOpen = useAtomValue(createWorkspaceOpenAtom);
  const setCreateWorkspaceOpen = useSetAtom(createWorkspaceOpenAtom);
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
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setNewTabOpen, setSearchOpen, setSidebarCollapsed]);

  if (hasHydratedWorkspaceList && !hasWorkspaces) {
    return (
      <div className="flex h-screen w-screen overflow-hidden text-foreground antialiased">
        <FirstWorkspacePane variant="full" />
      </div>
    );
  }

  const showMiddle = layout === "split";

  return (
    <div className="flex h-screen w-screen overflow-hidden text-foreground antialiased">
      <Sidebar />
      {onboardingModeActive ? (
        <div className="flex min-w-0 flex-1 flex-col bg-background">
          <ExperimentalWorkspaceOnboardingTakeover />
        </div>
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
