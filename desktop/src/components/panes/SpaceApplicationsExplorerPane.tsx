import { AppWindow, Plus } from "lucide-react";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import type { WorkspaceInstalledAppDefinition } from "@/lib/workspaceApps";
import { resolveAppDisplay, useWorkspaceDesktop } from "@/lib/workspaceDesktop";

interface SpaceApplicationsExplorerPaneProps {
  installedApps: WorkspaceInstalledAppDefinition[];
  activeAppId?: string | null;
  onSelectApp: (appId: string) => void;
  onAddApp: () => void;
}

type AppStatusTone = "ready" | "loading" | "error";

function appStatusTone(app: WorkspaceInstalledAppDefinition): AppStatusTone {
  if (app.error?.trim()) {
    return "error";
  }
  if (app.ready) {
    return "ready";
  }
  return "loading";
}

function statusPipVariant(tone: AppStatusTone): "destructive" | "info" {
  return tone === "error" ? "destructive" : "info";
}

function statusPipLabel(tone: AppStatusTone): string {
  if (tone === "error") {
    return "Error";
  }
  if (tone === "ready") {
    return "Ready";
  }
  return "Starting";
}

export function SpaceApplicationsExplorerPane({
  installedApps,
  activeAppId = null,
  onSelectApp,
  onAddApp,
}: SpaceApplicationsExplorerPaneProps) {
  const { appCatalog, composioToolkitsByProvider } = useWorkspaceDesktop();
  const isEmpty = installedApps.length === 0;

  function lookupProviderId(appId: string): string | null {
    const entry = appCatalog.find((candidate) => candidate.app_id === appId);
    return entry?.provider_id ?? null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onAddApp}
            aria-label="Add application"
            className="h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <div className="grid size-4 shrink-0 place-items-center">
              <Plus className="size-3.5" />
            </div>
            <span className="text-sm">Add application</span>
          </Button>

          {isEmpty ? null : (
            installedApps.map((app) => {
              const isActive = activeAppId === app.id;
              const tone = appStatusTone(app);
              const showStatus = tone !== "ready";
              const providerId = lookupProviderId(app.id);
              const display = resolveAppDisplay(
                providerId,
                composioToolkitsByProvider,
              );
              const label = display.name ?? app.label;
              return (
                <Button
                  key={app.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onSelectApp(app.id)}
                  aria-current={isActive ? "page" : undefined}
                  aria-label={`${label} — ${statusPipLabel(tone)}`}
                  title={app.summary || label}
                  className={`h-auto w-full justify-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                    isActive
                      ? "bg-accent text-foreground"
                      : "text-foreground hover:bg-accent"
                  }`}
                >
                  <AppIcon
                    iconUrl={display.logo}
                    appId={app.id}
                    providerId={providerId}
                    label={label}
                    size="row"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {label}
                  </span>
                  {showStatus ? (
                    <StatusDot
                      variant={statusPipVariant(tone)}
                      pulse={tone !== "error"}
                      title={statusPipLabel(tone)}
                    />
                  ) : null}
                </Button>
              );
            })
          )}
        </div>

        {isEmpty ? (
          <EmptyState
            icon={AppWindow}
            size="md"
            title="No apps installed yet."
            className="mt-6"
          />
        ) : null}
      </div>
    </div>
  );
}
