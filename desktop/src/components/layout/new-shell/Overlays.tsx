import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom, useSetAtom, type PrimitiveAtom } from "jotai";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { AppsGallery } from "@/components/marketplace/AppsGallery";
import { OperationsInboxPane } from "@/components/layout/OperationsDrawer";
import { SettingsScreenRoot } from "@/components/layout/SettingsScreenRoot";
import { ArtifactsPane } from "@/components/panes/ArtifactsPane";
import { AutomationsPane } from "@/components/panes/AutomationsPane";
import { MarketplacePane } from "@/components/panes/MarketplacePane";
import { SubagentSessionsPane } from "@/components/panes/SubagentSessionsPane";
import { Button } from "@/components/ui/button";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  appsOpenAtom,
  artifactsOpenAtom,
  automationsOpenAtom,
  inboxOpenAtom,
  marketplaceOpenAtom,
  sessionsOpenAtom,
  settingsOpenAtom,
  settingsSectionAtom,
} from "./state/ui";
import { useSettingsState } from "./useSettingsState";
import { useTaskProposals } from "./useTaskProposals";

export function Overlays() {
  return (
    <>
      <InboxOverlay />
      <ArtifactsOverlay />
      <AutomationsOverlay />
      <SessionsOverlay />
      <AppsOverlay />
      <MarketplaceOverlay />
      <SettingsOverlay />
    </>
  );
}

function InboxOverlay() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { proposals, isLoading, statusMessage, action, accept, dismiss } =
    useTaskProposals(selectedWorkspaceId || null);
  return (
    <PaneOverlay openAtom={inboxOpenAtom} title="Inbox">
      <div className="h-full overflow-y-auto">
        <OperationsInboxPane
          proposals={proposals}
          isLoadingProposals={isLoading}
          proposalStatusMessage={statusMessage}
          proposalAction={action}
          onAcceptProposal={accept}
          onDismissProposal={dismiss}
          hasWorkspace={Boolean(selectedWorkspaceId)}
        />
      </div>
    </PaneOverlay>
  );
}

function PaneOverlay({
  openAtom,
  title,
  children,
}: {
  openAtom: PrimitiveAtom<boolean>;
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useAtom(openAtom);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Popup
          className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-background outline-none data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-2"
          style={{
            animationDuration: "220ms",
            animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <div className="window-drag flex h-10 shrink-0 items-center justify-between border-b border-border pr-3 pl-20">
            <span className="text-sm font-medium">{title}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="window-no-drag text-foreground/60"
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ArtifactsOverlay() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  return (
    <PaneOverlay openAtom={artifactsOpenAtom} title="Artifacts">
      <ArtifactsPane workspaceId={selectedWorkspaceId || null} />
    </PaneOverlay>
  );
}

function AutomationsOverlay() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  return (
    <PaneOverlay openAtom={automationsOpenAtom} title="Automations">
      <AutomationsPane workspaceId={selectedWorkspaceId || null} />
    </PaneOverlay>
  );
}

function SessionsOverlay() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  return (
    <PaneOverlay openAtom={sessionsOpenAtom} title="Sessions">
      <SubagentSessionsPane workspaceId={selectedWorkspaceId || null} />
    </PaneOverlay>
  );
}

function AppsOverlay() {
  return (
    <PaneOverlay openAtom={appsOpenAtom} title="Apps">
      <div className="h-full overflow-y-auto">
        <AppsGallery />
      </div>
    </PaneOverlay>
  );
}

function MarketplaceOverlay() {
  return (
    <PaneOverlay openAtom={marketplaceOpenAtom} title="Marketplace">
      <div className="h-full overflow-y-auto">
        <MarketplacePane />
      </div>
    </PaneOverlay>
  );
}

function SettingsOverlay() {
  const setOpen = useSetAtom(settingsOpenAtom);
  const [section, setSection] = useAtom(settingsSectionAtom);
  const settings = useSettingsState();
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.appUpdate
      ?.getStatus()
      .then((status) => {
        if (!cancelled) setAppVersion(status?.currentVersion ?? "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PaneOverlay openAtom={settingsOpenAtom} title="Settings">
      <SettingsScreenRoot
        activeSection={section}
        appVersion={appVersion}
        onSectionChange={setSection}
        onBackToApp={() => setOpen(false)}
        colorScheme={settings.colorScheme}
        onColorSchemeChange={settings.onColorSchemeChange}
        themeVariant={settings.themeVariant}
        themeVariants={settings.themeVariants}
        onThemeVariantChange={settings.onThemeVariantChange}
        workspaceCardsPerRow={settings.cardsPerRow}
        onWorkspaceCardsPerRowChange={settings.onCardsPerRowChange}
        desktopNotificationsEnabled={settings.notificationsEnabled}
        onDesktopNotificationsChange={settings.onNotificationsChange}
        onOpenExternalUrl={settings.onOpenExternalUrl}
      />
    </PaneOverlay>
  );
}
