import { AppIntegrationsDialog } from "@/components/integration/AppIntegrationsDialog";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { useOpenWorkspaceOutput } from "@/components/layout/shell/useOpenWorkspaceOutput";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  favoriteKey,
  isFavoriteAtom,
  toggleFavoriteAtom,
} from "@/components/layout/shell/state/favorites";
import { useAtomValue, useSetAtom } from "jotai";
import {
  FolderOpen,
  Link2,
  Loader2,
  MoreHorizontal,
  Plus,
  RotateCw,
  Star,
  Trash2,
  Cancel as X,
} from "@/components/ui/icons";
import { StatusDot } from "@/components/ui/status-dot";
import { useIntegrationBinding } from "@/lib/useIntegrationBinding";
import { cn } from "@/lib/utils";
import type { WorkspaceInstalledAppDefinition } from "@/lib/workspaceApps";
import { resolveAppDisplay, useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { useCallback, useEffect, useMemo, useState } from "react";

interface AppRowProps {
  app: WorkspaceInstalledAppDefinition;
  label: string;
  providerId: string | null;
  iconUrl: string | null;
  expanded: boolean;
  onOpen: (opts?: { forceNewTab?: boolean }) => void;
  onReload: () => void;
  onUninstall: () => void;
}

function AppRow(props: AppRowProps) {
  // Bucket the app's declared integrations into "providers we care about".
  // Apps with no integrations (UI-only, data-only) skip the binding hook
  // entirely; apps with one keep the existing single-binding row; apps with
  // two or more (e.g. X Engagement: twitter + gmail) need the multi-binding
  // variant so each provider gets its own status / Reconnect path in the
  // dropdown — the legacy single-provider row silently dropped everything
  // beyond the first required entry.
  const integrations: AppRowMultiIntegration[] = (props.app.integrations ?? [])
    .filter((entry) => Boolean(entry.provider))
    .map((entry) => ({
      provider: entry.provider,
      required: entry.required,
      whoami: entry.whoami ?? null,
    }));
  if (integrations.length === 0) {
    return <AppRowPlain {...props} />;
  }
  // Prefer required > first declared for the "primary" provider whose state
  // drives the row's status dot when collapsed.
  const primary =
    integrations.find((entry) => entry.required) ?? integrations[0]!;
  if (integrations.length === 1) {
    return (
      <AppRowWithBinding
        {...props}
        providerSlug={primary.provider}
        whoami={primary.whoami}
      />
    );
  }
  return (
    <AppRowWithMultiBinding
      {...props}
      integrations={integrations}
      primaryProvider={primary.provider}
    />
  );
}

type RowTone = "ready" | "loading" | "error" | "needs_connect" | "connecting";

function AppRowPlain({
  app,
  label,
  providerId,
  iconUrl,
  expanded,
  onOpen,
  onReload,
  onUninstall,
}: AppRowProps) {
  const errorMessage = app.error?.trim() || null;
  const tone: RowTone = errorMessage
    ? "error"
    : app.ready
      ? "ready"
      : "loading";
  const tooltip =
    tone === "error" && errorMessage
      ? errorMessage
      : tone === "loading"
        ? `${label} — starting…`
        : label;
  return (
    <AppRowShell
      app={app}
      label={label}
      providerId={providerId}
      iconUrl={iconUrl}
      expanded={expanded}
      tone={tone}
      tooltip={tooltip}
      onRowClick={() => {
        if (tone === "ready") onOpen();
      }}
      renderTrailing={() => {
        if (tone === "loading") {
          return <StatusDot variant="info" pulse title="Starting" />;
        }
        if (tone === "error") {
          return (
            <StatusDot variant="destructive" title={errorMessage ?? "Error"} />
          );
        }
        return null;
      }}
      menuItems={
        <>
          <DropdownMenuItem
            onClick={() => onOpen({ forceNewTab: true })}
            disabled={tone !== "ready"}
          >
            <Plus className="size-3.5" />
            Open in new tab
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onReload}>
            <RotateCw className="size-3.5" />
            Reload
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onUninstall} variant="destructive">
            <Trash2 className="size-3.5" />
            Uninstall
          </DropdownMenuItem>
        </>
      }
    />
  );
}

function AppRowWithBinding({
  app,
  label,
  providerId,
  iconUrl,
  expanded,
  onOpen,
  onReload,
  onUninstall,
  providerSlug,
  whoami,
}: AppRowProps & {
  providerSlug: string;
  whoami: PendingIntegrationWhoami | null;
}) {
  const { composioToolkitsByProvider } = useWorkspaceDesktop();
  const providerName =
    composioToolkitsByProvider[providerSlug.toLowerCase()]?.name ??
    providerSlug;

  const {
    state: bindingState,
    busy,
    connect,
    cancel,
  } = useIntegrationBinding({
    appId: app.id,
    provider: providerSlug,
    whoami,
    considerWorkspaceDefault: true,
  });

  const errorMessage = app.error?.trim() || null;
  const tone: RowTone = errorMessage
    ? "error"
    : busy === "connecting" || busy === "binding"
      ? "connecting"
      : bindingState.kind === "no_connection" ||
          bindingState.kind === "needs_binding"
        ? "needs_connect"
        : !app.ready
          ? "loading"
          : "ready";

  const tooltip =
    tone === "error" && errorMessage
      ? errorMessage
      : tone === "connecting"
        ? `Authorizing ${providerName}…`
        : tone === "needs_connect"
          ? `${providerName} not connected — click to authorize`
          : tone === "loading"
            ? `${label} — starting…`
            : label;

  const handleRowClick = () => {
    if (tone === "ready") {
      onOpen();
      return;
    }
    if (tone === "needs_connect") {
      void connect();
    }
  };

  return (
    <AppRowShell
      app={app}
      label={label}
      providerId={providerId}
      iconUrl={iconUrl}
      expanded={expanded}
      tone={tone}
      tooltip={tooltip}
      onRowClick={handleRowClick}
      renderTrailing={() => {
        if (tone === "connecting") {
          return (
            <span className="flex items-center gap-1">
              <Loader2
                className="size-3 animate-spin text-muted-foreground"
                aria-hidden
              />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  cancel();
                }}
                aria-label="Cancel"
                className="grid size-4 place-items-center rounded text-foreground-tertiary transition-colors hover:bg-foreground/8 hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          );
        }
        if (tone === "needs_connect") {
          return (
            <StatusDot
              variant="warning"
              title={`${providerName} needs a connection`}
            />
          );
        }
        if (tone === "loading") {
          return <StatusDot variant="info" pulse title="Starting" />;
        }
        if (tone === "error") {
          return (
            <StatusDot variant="destructive" title={errorMessage ?? "Error"} />
          );
        }
        return null;
      }}
      menuItems={
        <>
          {tone === "needs_connect" ? (
            <DropdownMenuItem
              onClick={() => void connect()}
              disabled={busy !== null}
            >
              <Link2 className="size-3.5" />
              Connect {providerName}…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onClick={() => onOpen({ forceNewTab: true })}
            disabled={tone !== "ready"}
          >
            <Plus className="size-3.5" />
            Open in new tab
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onReload}>
            <RotateCw className="size-3.5" />
            Reload
          </DropdownMenuItem>
          {bindingState.kind === "bound" ? (
            <DropdownMenuItem
              onClick={() => void connect()}
              disabled={busy !== null}
            >
              <Link2 className="size-3.5" />
              Reconnect {providerName}…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={onUninstall} variant="destructive">
            <Trash2 className="size-3.5" />
            Uninstall
          </DropdownMenuItem>
        </>
      }
    />
  );
}

interface AppRowMultiIntegration {
  provider: string;
  required: boolean;
  whoami: PendingIntegrationWhoami | null;
}

type ProviderRowStateSummary = {
  kind:
    | "loading"
    | "no_connection"
    | "needs_binding"
    | "bound"
    | "no_workspace";
  busy: "connecting" | "binding" | "verifying" | null;
  hasError: boolean;
};

function AppRowWithMultiBinding({
  app,
  label,
  providerId,
  iconUrl,
  expanded,
  onOpen,
  onReload,
  onUninstall,
  integrations,
}: AppRowProps & {
  integrations: AppRowMultiIntegration[];
  primaryProvider: string;
}) {
  // The popover-style nested dropdown got physically occluded by the
  // workspace browser pane (it's a separate render layer that the renderer
  // can't position popovers above). The dialog approach uses a top-level
  // backdrop portaled to document.body, which sits above the webview's
  // stacking context. The hidden ProviderStateReporter children run the
  // binding hook so the row's status dot stays informative without forcing
  // the user to open the dialog first.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [byProvider, setByProvider] = useState<
    Record<string, ProviderRowStateSummary>
  >({});
  const updateProviderState = useCallback(
    (slug: string, summary: ProviderRowStateSummary) => {
      setByProvider((prev) => {
        const existing = prev[slug];
        if (
          existing &&
          existing.kind === summary.kind &&
          existing.busy === summary.busy &&
          existing.hasError === summary.hasError
        ) {
          return prev;
        }
        return { ...prev, [slug]: summary };
      });
    },
    [],
  );

  const errorMessage = app.error?.trim() || null;
  const summaries = Object.values(byProvider);
  const anyConnecting = summaries.some((s) => s.busy !== null);
  const anyNeedsConnect = summaries.some(
    (s) => s.kind === "no_connection" || s.kind === "needs_binding",
  );
  const tone: RowTone = errorMessage
    ? "error"
    : anyConnecting
      ? "connecting"
      : anyNeedsConnect
        ? "needs_connect"
        : !app.ready
          ? "loading"
          : "ready";

  const pendingProviderNames = useMemo(
    () =>
      integrations
        .filter((entry) => {
          const summary = byProvider[entry.provider];
          if (!summary) return false;
          return (
            summary.kind === "no_connection" || summary.kind === "needs_binding"
          );
        })
        .map((entry) => entry.provider),
    [integrations, byProvider],
  );

  const tooltip =
    tone === "error" && errorMessage
      ? errorMessage
      : tone === "connecting"
        ? `Authorizing integrations…`
        : tone === "needs_connect"
          ? pendingProviderNames.length > 0
            ? `${pendingProviderNames.join(", ")} not connected — open menu to authorize`
            : `Connectors need attention`
          : tone === "loading"
            ? `${label} — starting…`
            : label;

  const handleRowClick = () => {
    if (tone === "ready") {
      onOpen();
      return;
    }
    if (tone === "needs_connect") {
      setDialogOpen(true);
    }
  };

  return (
    <>
      {integrations.map((integration) => (
        <ProviderStateReporter
          key={integration.provider}
          appId={app.id}
          provider={integration.provider}
          whoami={integration.whoami}
          onState={updateProviderState}
        />
      ))}
      <AppRowShell
        app={app}
        label={label}
        providerId={providerId}
        iconUrl={iconUrl}
        expanded={expanded}
        tone={tone}
        tooltip={tooltip}
        onRowClick={handleRowClick}
        renderTrailing={() => {
          if (tone === "connecting") {
            return (
              <Loader2
                className="size-3 animate-spin text-muted-foreground"
                aria-hidden
              />
            );
          }
          if (tone === "needs_connect") {
            return (
              <StatusDot
                variant="warning"
                title={`${pendingProviderNames.length} integration${
                  pendingProviderNames.length === 1 ? "" : "s"
                } need attention`}
              />
            );
          }
          if (tone === "loading") {
            return <StatusDot variant="info" pulse title="Starting" />;
          }
          if (tone === "error") {
            return (
              <StatusDot
                variant="destructive"
                title={errorMessage ?? "Error"}
              />
            );
          }
          return null;
        }}
        menuItems={
          <>
            <DropdownMenuItem
              onClick={() => onOpen({ forceNewTab: true })}
              disabled={tone !== "ready"}
            >
              <Plus className="size-3.5" />
              Open in new tab
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onReload}>
              <RotateCw className="size-3.5" />
              Reload
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setDialogOpen(true)}>
              <Link2 className="size-3.5" />
              Manage integrations
              {pendingProviderNames.length > 0 ? (
                <span className="ml-auto rounded-full bg-warning/15 px-1.5 py-px text-[10px] font-medium text-warning">
                  {pendingProviderNames.length}
                </span>
              ) : null}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onUninstall} variant="destructive">
              <Trash2 className="size-3.5" />
              Uninstall
            </DropdownMenuItem>
          </>
        }
      />
      <AppIntegrationsDialog
        appId={app.id}
        appName={label}
        integrations={integrations.map((entry) => ({
          provider: entry.provider,
          required: entry.required,
          whoami: entry.whoami,
        }))}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}

/**
 * Headless companion to AppIntegrationsDialog: subscribes to each declared
 * provider's binding state via useIntegrationBinding and reports a summary
 * up to the parent so the row's status dot can show "warning" even before
 * the user opens the dialog. Renders nothing.
 */
function ProviderStateReporter({
  appId,
  provider,
  whoami,
  onState,
}: {
  appId: string;
  provider: string;
  whoami: PendingIntegrationWhoami | null;
  onState: (slug: string, summary: ProviderRowStateSummary) => void;
}) {
  const { state, busy, errorMessage } = useIntegrationBinding({
    appId,
    provider,
    whoami,
    considerWorkspaceDefault: true,
  });
  useEffect(() => {
    onState(provider, {
      kind: state.kind,
      busy,
      hasError: Boolean(errorMessage),
    });
  }, [state.kind, busy, errorMessage, provider, onState]);
  return null;
}

function AppRowShell({
  app,
  label,
  providerId,
  iconUrl,
  expanded,
  tone,
  tooltip,
  onRowClick,
  renderTrailing,
  menuItems,
}: {
  app: WorkspaceInstalledAppDefinition;
  label: string;
  providerId: string | null;
  iconUrl: string | null;
  expanded: boolean;
  tone: RowTone;
  tooltip: string;
  onRowClick: () => void;
  renderTrailing: () => React.ReactNode;
  menuItems: React.ReactNode;
}) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const toggleFavorite = useSetAtom(toggleFavoriteAtom);
  const isFavoriteFn = useAtomValue(isFavoriteAtom);
  const pinned = selectedWorkspaceId
    ? isFavoriteFn(
        favoriteKey({
          kind: "app",
          workspaceId: selectedWorkspaceId,
          appId: app.id,
        }),
      )
    : false;
  const togglePinned = () => {
    if (!selectedWorkspaceId) return;
    toggleFavorite({
      kind: "app",
      workspaceId: selectedWorkspaceId,
      appId: app.id,
      label,
    });
  };
  const viewSource = async () => {
    if (!selectedWorkspaceId) return;
    try {
      await window.electronAPI.fs.revealInFolder(
        `apps/${app.id}`,
        selectedWorkspaceId,
      );
    } catch {
      // path may not exist if the app failed to materialize — best-effort
    }
  };
  return (
    <div
      role="group"
      className="group/app-row relative flex items-center rounded transition-colors hover:bg-foreground/6"
    >
      <button
        type="button"
        onClick={onRowClick}
        tabIndex={expanded ? 0 : -1}
        title={tooltip}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.25 pl-6 text-left text-xs text-foreground transition-colors disabled:cursor-default"
      >
        <AppIcon
          iconUrl={iconUrl}
          appId={app.id}
          providerId={providerId}
          label={label}
          size="row"
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            (tone === "error" || tone === "needs_connect") &&
              "text-muted-foreground",
          )}
        >
          {label}
        </span>
        {renderTrailing()}
      </button>
      <div
        aria-hidden
        className="mr-0 w-0 shrink-0 overflow-hidden transition-[width,margin-right] duration-200 ease-out-expo group-hover/app-row:mr-1 group-hover/app-row:w-5 group-has-aria-expanded/app-row:mr-1 group-has-aria-expanded/app-row:w-5"
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="App actions"
                tabIndex={expanded ? 0 : -1}
                onClick={(e) => e.stopPropagation()}
                className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            }
          />
          <DropdownMenuContent align="end" side="bottom" sideOffset={4}>
            <DropdownMenuItem onClick={togglePinned}>
              <Star className={cn("size-3.5", pinned && "fill-current")} />
              {pinned ? "Unpin from sidebar" : "Pin to sidebar"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void viewSource()}>
              <FolderOpen className="size-3.5" />
              View source code
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {menuItems}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function InstalledAppsList() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { installedApps, composioToolkitsByProvider, removeInstalledApp } =
    useWorkspaceDesktop();
  const { openUrlInBrowserTab } = useOpenWorkspaceOutput();

  const openApp = async (appId: string, opts?: { forceNewTab?: boolean }) => {
    if (!selectedWorkspaceId) return;
    try {
      const url = await window.electronAPI.appSurface.resolveUrl(
        selectedWorkspaceId,
        appId,
      );
      await openUrlInBrowserTab(url, {
        forceNewTab: opts?.forceNewTab,
        dedupBy: "origin",
      });
    } catch {
      // status pip on the row already reflects non-ready apps
    }
  };

  const reloadApp = async (appId: string) => {
    try {
      await window.electronAPI.appSurface.reload(appId);
    } catch {
      // fall through; status pip re-reflects once lifecycle settles
    }
  };

  const uninstallApp = async (appId: string, label: string) => {
    if (!window.confirm(`Uninstall '${label}'?`)) return;
    try {
      await removeInstalledApp(appId);
    } catch {
      // workspace context surfaces the error
    }
  };

  if (!selectedWorkspaceId || installedApps.length === 0) {
    return (
      <div className="grid place-items-center px-6 py-10 text-center text-xs text-muted-foreground">
        No apps installed in this workspace yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 px-2 py-2">
      {installedApps.map((app) => {
        const providerId: string | null = null;
        const display = resolveAppDisplay(providerId, composioToolkitsByProvider);
        const label = display.name ?? app.label;
        return (
          <AppRow
            key={app.id}
            app={app}
            label={label}
            providerId={providerId}
            iconUrl={display.logo}
            expanded={true}
            onOpen={(opts) => void openApp(app.id, opts)}
            onReload={() => void reloadApp(app.id)}
            onUninstall={() => void uninstallApp(app.id, label)}
          />
        );
      })}
    </div>
  );
}

