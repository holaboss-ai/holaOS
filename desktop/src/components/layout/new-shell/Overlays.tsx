import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAtom, useSetAtom, type PrimitiveAtom } from "jotai";
import { AppWindow, ExternalLink, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { OperationsInboxPane } from "@/components/layout/OperationsDrawer";
import { SettingsScreenRoot } from "@/components/layout/SettingsScreenRoot";
import { ArtifactsPane } from "@/components/panes/ArtifactsPane";
import { AutomationsPane } from "@/components/panes/AutomationsPane";
import { MarketplacePane } from "@/components/panes/MarketplacePane";
import { SubagentSessionsPane } from "@/components/panes/SubagentSessionsPane";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import type { WorkspaceInstalledAppDefinition } from "@/lib/workspaceApps";
import { resolveAppDisplay, useWorkspaceDesktop } from "@/lib/workspaceDesktop";
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
    <PaneOverlay openAtom={inboxOpenAtom} title="Inbox" size="md">
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

type PaneOverlaySize = "md" | "lg" | "xl";

const SIZE_CLASS: Record<PaneOverlaySize, string> = {
  md: "w-[min(640px,calc(100vw-48px))] h-[min(560px,calc(100vh-96px))]",
  lg: "w-[min(880px,calc(100vw-48px))] h-[min(680px,calc(100vh-96px))]",
  xl: "w-[min(1100px,calc(100vw-48px))] h-[min(800px,calc(100vh-96px))]",
};

function PaneOverlay({
  openAtom,
  title,
  size = "lg",
  children,
}: {
  openAtom: PrimitiveAtom<boolean>;
  title: string;
  size?: PaneOverlaySize;
  children: ReactNode;
}) {
  const [open, setOpen] = useAtom(openAtom);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-40 bg-foreground/30 opacity-0 transition-opacity duration-[200ms] data-open:opacity-100"
          style={{ transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)" }}
        />
        <DialogPrimitive.Popup
          className="group fixed inset-0 z-40 grid place-items-center opacity-0 outline-none transition-opacity duration-[220ms] data-open:opacity-100"
          style={{ transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)" }}
        >
          <div
            className={`flex scale-[0.96] flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-2xl ring-1 ring-foreground/5 transition-transform duration-[240ms] group-data-[open]:scale-100 ${SIZE_CLASS[size]}`}
            style={{
              transitionTimingFunction: "cubic-bezier(0.32, 0.72, 0, 1)",
              willChange: "transform",
            }}
          >
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
              <span className="text-sm font-medium">{title}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="text-foreground/60"
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
          </div>
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
    <PaneOverlay
      openAtom={automationsOpenAtom}
      title="Automations"
      size="md"
    >
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
  const {
    installedApps,
    selectedWorkspace,
    appCatalog,
    composioToolkitsByProvider,
  } = useWorkspaceDesktop();
  const setAppsOpen = useSetAtom(appsOpenAtom);
  const setMarketplaceOpen = useSetAtom(marketplaceOpenAtom);

  const openApp = useCallback(
    async (appId: string) => {
      if (!selectedWorkspace) return;
      try {
        const url = await window.electronAPI.appSurface.resolveUrl(
          selectedWorkspace.id,
          appId,
        );
        await window.electronAPI.browser.setActiveWorkspace(
          selectedWorkspace.id,
          "user",
        );
        await window.electronAPI.browser.newTab(url);
        setAppsOpen(false);
      } catch {
        // surfacing this error inline is overkill — the app row's status
        // pip will already reflect a non-ready state.
      }
    },
    [selectedWorkspace, setAppsOpen],
  );

  const browseMarketplace = () => {
    setAppsOpen(false);
    setMarketplaceOpen(true);
  };

  return (
    <PaneOverlay openAtom={appsOpenAtom} title="Apps" size="md">
      <div className="flex h-full min-h-0 flex-col p-5">
        {!selectedWorkspace ? (
          <p className="text-sm text-muted-foreground">
            Select a workspace to manage apps.
          </p>
        ) : installedApps.length === 0 ? (
          <EmptyState
            icon={AppWindow}
            size="md"
            title="No apps installed yet."
            description="Install modules from the Marketplace to add capabilities to this workspace."
            className="mt-6"
            action={
              <Button size="sm" onClick={browseMarketplace}>
                Browse marketplace
              </Button>
            }
          />
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {installedApps.length} installed
              </span>
              <Button variant="ghost" size="sm" onClick={browseMarketplace}>
                Browse marketplace
              </Button>
            </div>
            <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
              <div className="flex flex-col gap-1.5">
                {installedApps.map((app) => {
                  const providerId =
                    appCatalog.find((c) => c.app_id === app.id)
                      ?.provider_id ?? null;
                  const display = resolveAppDisplay(
                    providerId,
                    composioToolkitsByProvider,
                  );
                  return (
                    <InstalledAppRow
                      key={app.id}
                      app={app}
                      label={display.name ?? app.label}
                      iconUrl={display.logo}
                      providerId={providerId}
                      onOpen={() => void openApp(app.id)}
                    />
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </PaneOverlay>
  );
}

function InstalledAppRow({
  app,
  label,
  iconUrl,
  providerId,
  onOpen,
}: {
  app: WorkspaceInstalledAppDefinition;
  label: string;
  iconUrl: string | null;
  providerId: string | null;
  onOpen: () => void;
}) {
  const error = app.error?.trim();
  const status: "ready" | "loading" | "error" = error
    ? "error"
    : app.ready
      ? "ready"
      : "loading";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-accent/40">
      <AppIcon
        iconUrl={iconUrl}
        appId={app.id}
        providerId={providerId}
        label={label}
        size="card"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{label}</span>
          {status === "loading" ? (
            <StatusDot variant="info" pulse title="Starting" />
          ) : null}
          {status === "error" ? (
            <StatusDot variant="destructive" title={error || "Error"} />
          ) : null}
        </div>
        {app.summary ? (
          <p className="truncate text-xs text-muted-foreground">
            {app.summary}
          </p>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={status !== "ready"}
        onClick={onOpen}
      >
        <ExternalLink className="size-3.5" />
        Open
      </Button>
    </div>
  );
}

function MarketplaceOverlay() {
  return (
    <PaneOverlay
      openAtom={marketplaceOpenAtom}
      title="Marketplace"
      size="xl"
    >
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
    <PaneOverlay openAtom={settingsOpenAtom} title="Settings" size="xl">
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
