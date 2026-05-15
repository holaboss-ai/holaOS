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
import { Sidebar } from "./Sidebar";
import {
  createWorkspaceOpenAtom,
  newTabOpenAtom,
  publishOpenAtom,
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
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const [publishOpen, setPublishOpen] = useAtom(publishOpenAtom);
  const createWorkspaceOpen = useAtomValue(createWorkspaceOpenAtom);
  const setCreateWorkspaceOpen = useSetAtom(createWorkspaceOpenAtom);

  // Cmd/Ctrl + T → new tab palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "t") {
        e.preventDefault();
        setNewTabOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setNewTabOpen]);

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
