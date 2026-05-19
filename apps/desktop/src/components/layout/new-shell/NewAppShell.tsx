import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { FirstWorkspacePane } from "@/components/onboarding/FirstWorkspacePane";
import { PublishScreen } from "@/components/publish/PublishScreen";
import { DesktopBillingProvider } from "@/lib/billing/useDesktopBilling";
import { WorkspaceDesktopProvider } from "@/lib/workspaceDesktop";
import {
  useWorkspaceSelection,
  WorkspaceSelectionProvider,
} from "@/lib/workspaceSelection";
import { Center } from "./Center";
import { ChatPanel } from "./ChatPanel";
import { NewTabDialog } from "./NewTabDialog";
import { Overlays } from "./Overlays";
import { SearchDialog } from "./SearchDialog";
import { Sidebar } from "./Sidebar";
import {
  createWorkspaceOpenAtom,
  newTabOpenAtom,
  publishOpenAtom,
  searchOpenAtom,
  sidebarCollapsedAtom,
} from "./state/ui";
import { TopChrome } from "./TopChrome";

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
  const [publishOpen, setPublishOpen] = useAtom(publishOpenAtom);
  const createWorkspaceOpen = useAtomValue(createWorkspaceOpenAtom);
  const setCreateWorkspaceOpen = useSetAtom(createWorkspaceOpenAtom);

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

  return (
    <div className="flex h-screen w-screen overflow-hidden text-foreground antialiased">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <TopChrome />
        <div className="flex min-h-0 flex-1">
          <Center />
          <ChatPanel />
        </div>
      </div>
      <NewTabDialog />
      <SearchDialog />
      <Overlays />
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
