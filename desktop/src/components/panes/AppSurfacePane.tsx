import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  LoaderCircle,
  MoreHorizontal,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { providerIcon } from "@/components/onboarding/constants";
import {
  accountAvatarFallbackChar,
  accountDisplayLabel,
  useEnrichedConnections,
} from "@/lib/integrationDisplay";
import { resolveAppDisplay, useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  getWorkspaceAppDefinition,
  type WorkspaceAppDefinition,
  type WorkspaceInstalledAppDefinition,
} from "@/lib/workspaceApps";
import { resolveAppSurfacePath } from "./appSurfaceRoute";

interface AppSurfacePaneProps {
  appId: string;
  app?: WorkspaceInstalledAppDefinition | WorkspaceAppDefinition | null;
  path?: string | null;
  resourceId?: string | null;
  view?: string | null;
}

/**
 * Pick the most user-recognisable label for a connection. Backend whoami
 * lookups populate `account_handle` (e.g. "@joshua") and `account_email`;
 * `account_label` is admin-supplied; `account_external_id` and the UUID
 * `connection_id` are last-resort fallbacks that should rarely surface
 * to the user but are kept so the UI never renders empty.
 */
function connectionPrimary(
  conn: IntegrationConnectionPayload | undefined,
  providerName: string,
): string {
  if (!conn) return `Pick an ${providerName} account`;
  const label = conn.account_label?.trim();
  const handle = conn.account_handle?.trim();
  const email = conn.account_email?.trim();
  const external = conn.account_external_id?.trim();
  // Prefer human-readable identity over admin-set labels — handles let the
  // user immediately recognise which account this is.
  return handle || email || label || external || `${providerName} account`;
}

/**
 * Secondary line for the dropdown items — disambiguates when several
 * connections share the same handle (e.g. work + personal email under
 * the same account_label). Returns null when secondary would just
 * duplicate the primary line.
 */
function connectionSecondary(conn: IntegrationConnectionPayload): string | null {
  const primary = conn.account_handle?.trim() || conn.account_email?.trim() || conn.account_label?.trim();
  const candidates = [
    conn.account_email?.trim(),
    conn.account_label?.trim(),
    conn.account_external_id?.trim(),
  ].filter((s): s is string => !!s && s !== primary);
  return candidates[0] ?? null;
}

export function AppSurfacePane({
  appId,
  app: providedApp,
  path,
  resourceId,
  view,
}: AppSurfacePaneProps) {
  const {
    refreshInstalledApps,
    removeInstalledApp,
    appCatalog,
    composioToolkitsByProvider,
  } = useWorkspaceDesktop();
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const app = providedApp || getWorkspaceAppDefinition(appId);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [actionError, setActionError] = useState("");
  const [wasRemoved, setWasRemoved] = useState(false);
  const [frameUrl, setFrameUrl] = useState("");
  const [frameLoading, setFrameLoading] = useState(false);
  const [frameError, setFrameError] = useState("");
  const [paneWidth, setPaneWidth] = useState(0);
  const paneRef = useRef<HTMLDivElement | null>(null);

  // Mirrors BrowserPane's compaction thresholds so toolbar density stays
  // consistent across panes.
  const isCompactPane = paneWidth > 0 && paneWidth <= 360;
  const isNarrowPane = paneWidth > 0 && paneWidth <= 260;

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const sync = () =>
      setPaneWidth(Math.round(pane.getBoundingClientRect().width));
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  const catalogEntry = appCatalog.find((entry) => entry.app_id === appId);
  const providerId = catalogEntry?.provider_id ?? null;
  const display = resolveAppDisplay(providerId, composioToolkitsByProvider);
  const label = display.name ?? app?.label ?? appId;
  const ready = app && "ready" in app ? app.ready : false;
  const error =
    app && "error" in app && typeof app.error === "string" ? app.error : null;

  const routePath = useMemo(
    () => resolveAppSurfacePath({ path, resourceId, view }),
    [path, resourceId, view],
  );

  // Per-app integration binding: which user-global account this workspace's
  // copy of the app should use. Connections are user-global; the binding
  // (target_type="app") is workspace+app scoped.
  const [integrationContext, setIntegrationContext] = useState<{
    providerId: string;
    providerName: string;
    candidates: IntegrationConnectionPayload[];
    currentBindingId: string | null;
    currentConnectionId: string | null;
  } | null>(null);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [avatarFailures, setAvatarFailures] = useState<Set<string>>(
    () => new Set(),
  );

  const candidates = useMemo(
    () => integrationContext?.candidates ?? [],
    [integrationContext],
  );
  const accountMetadata = useEnrichedConnections(candidates);

  const checkIntegration = useCallback(async () => {
    if (!selectedWorkspaceId) return;
    try {
      const [{ connections }, { providers }, bindingsResult] =
        await Promise.all([
          window.electronAPI.workspace.listIntegrationConnections(),
          window.electronAPI.workspace.listIntegrationCatalog(),
          window.electronAPI.workspace.listIntegrationBindings(
            selectedWorkspaceId,
          ),
        ]);

      // Resolve the expected provider for this app: prefer any existing
      // app-level binding (which encodes the integration_key authoritatively),
      // otherwise fall back to a static appId → provider mapping.
      // Fallback when there's no app-level binding yet — used to render
      // the "Connect <provider>" button on the app surface so users can
      // bootstrap the binding from the app view itself. Keys are the
      // app id; values are the Composio toolkit slug (NOT always the
      // app id — Cal.com's app id is "calcom" but its Composio slug is
      // "cal", and the same shape applies to Google sub-toolkits).
      const knownProviders: Record<string, string> = {
        gmail: "gmail",
        sheets: "googlesheets",
        github: "github",
        reddit: "reddit",
        twitter: "twitter",
        linkedin: "linkedin",
        calcom: "cal",
        attio: "attio",
        hubspot: "hubspot",
        apollo: "apollo",
        instantly: "instantly",
        zoominfo: "zoominfo",
      };
      const appBinding = bindingsResult.bindings.find(
        (b) => b.target_type === "app" && b.target_id === appId,
      );
      const providerId =
        appBinding?.integration_key ?? knownProviders[appId.toLowerCase()];
      if (!providerId) {
        setIntegrationContext(null);
        return;
      }

      const provider = providers.find((p) => p.provider_id === providerId);
      const candidates = connections.filter(
        (c) =>
          c.provider_id === providerId &&
          (c.status ?? "").toLowerCase() === "active",
      );

      // Current selection: app-level binding wins; fall back to the
      // workspace-default binding for this provider.
      const workspaceDefault = bindingsResult.bindings.find(
        (b) =>
          b.target_type === "workspace" &&
          b.target_id === "default" &&
          b.integration_key === providerId,
      );
      const currentConnectionId =
        appBinding?.connection_id ?? workspaceDefault?.connection_id ?? null;

      setIntegrationContext({
        providerId,
        providerName: provider?.display_name ?? providerId,
        candidates,
        currentBindingId: appBinding?.binding_id ?? null,
        currentConnectionId,
      });
    } catch {
      // Non-fatal — leave the previous context in place.
    }
  }, [appId, selectedWorkspaceId]);

  useEffect(() => {
    void checkIntegration();
  }, [checkIntegration]);

  // Re-check integration connections when the user returns to the window or
  // this tab becomes visible again. OAuth flows leave Holaboss to the browser
  // and come back, so window-focus is a natural trigger to pick up newly
  // connected accounts without making the user click Reload.
  const lastFocusRefetchRef = useRef(0);
  useEffect(() => {
    const refetch = () => {
      const now = Date.now();
      // Throttle: at most once every 3s to avoid storms when users alt-tab.
      if (now - lastFocusRefetchRef.current < 3000) return;
      lastFocusRefetchRef.current = now;
      void checkIntegration();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refetch();
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [checkIntegration]);

  const handleSelectBinding = useCallback(
    async (connectionId: string) => {
      if (!selectedWorkspaceId || !integrationContext) return;
      setBindingBusy(true);
      try {
        await window.electronAPI.workspace.upsertIntegrationBinding(
          selectedWorkspaceId,
          "app",
          appId,
          integrationContext.providerId,
          { connection_id: connectionId, is_default: false },
        );
        await checkIntegration();
      } catch {
        // Non-fatal — the dropdown will reflect server state on next refresh.
      } finally {
        setBindingBusy(false);
      }
    },
    [appId, checkIntegration, integrationContext, selectedWorkspaceId],
  );

  const handleConnectAccount = useCallback(() => {
    void window.electronAPI.ui.openSettingsPane("integrations");
  }, []);

  // Resolve iframe URL when app is ready
  useEffect(() => {
    if (!ready || !selectedWorkspaceId) {
      setFrameUrl("");
      setFrameLoading(false);
      setFrameError("");
      return;
    }

    let cancelled = false;
    setFrameLoading(true);
    setFrameError("");

    void window.electronAPI.appSurface
      .resolveUrl(selectedWorkspaceId, appId, routePath)
      .then((url) => {
        if (!cancelled) setFrameUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFrameError(
            err instanceof Error ? err.message : "Failed to resolve app URL.",
          );
          setFrameLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [appId, ready, reloadKey, routePath, selectedWorkspaceId]);

  async function handleRemove() {
    if (isRemoving) return;
    setIsRemoving(true);
    setActionError("");
    try {
      await removeInstalledApp(appId);
      setWasRemoved(true);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to remove app.",
      );
    } finally {
      setIsRemoving(false);
      setConfirmRemove(false);
    }
  }

  async function handleRetry() {
    if (isRetrying) return;
    setIsRetrying(true);
    setActionError("");
    setFrameError("");
    try {
      await Promise.all([refreshInstalledApps(), checkIntegration()]);
      setReloadKey((k) => k + 1);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setIsRetrying(false);
    }
  }

  // Removed state — render blank after successful removal
  if (wasRemoved) {
    return <div className="h-full min-h-0" />;
  }

  // One pane, three states. Top bar stays consistent; only the status pill
  // and body area swap. Replaces the previous 260px left card with a thin
  // toolbar modeled after BrowserPane's chrome row.
  const surfaceState: "initializing" | "error" | "ready" =
    !ready && error ? "error" : !ready ? "initializing" : "ready";
  const showIntegration = surfaceState === "ready" && integrationContext;
  const showRetry = surfaceState !== "initializing";
  const onRetry =
    surfaceState === "error"
      ? () => void handleRetry()
      : () => {
          setReloadKey((k) => k + 1);
          void checkIntegration();
        };

  return (
    <div
      ref={paneRef}
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl bg-card shadow-md backdrop-blur-sm"
    >
      {/* Top bar — mirrors BrowserPane chrome row: shrink-0 + border-b,
          ghost icon-buttons for low-frequency ops, outline for the
          destructive overflow trigger. */}
      <div className="shrink-0 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2.5">
          <AppIcon
            iconUrl={display.logo}
            appId={appId}
            providerId={providerId}
            label={label}
            size="toolbar"
          />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-xs font-semibold tracking-wide text-foreground">
              {label}
            </span>
            {surfaceState === "ready" ? (
              <span
                className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-success"
                title="Running"
              >
                <StatusDot variant="success" />
                {!isNarrowPane ? "Running" : null}
              </span>
            ) : surfaceState === "initializing" ? (
              <span
                className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground"
                title="Initializing"
              >
                <LoaderCircle size={11} className="animate-spin" />
                {!isNarrowPane ? "Initializing" : null}
              </span>
            ) : (
              <span
                className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-destructive"
                title="Error"
              >
                <StatusDot variant="destructive" />
                {!isNarrowPane ? "Error" : null}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {showIntegration ? (
              integrationContext.candidates.length === 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size={isNarrowPane ? "icon-sm" : "sm"}
                  onClick={handleConnectAccount}
                  className={isNarrowPane ? "" : "gap-1.5"}
                  title={`Connect ${integrationContext.providerName}`}
                  aria-label={`Connect ${integrationContext.providerName}`}
                >
                  <Plus size={12} />
                  {!isNarrowPane ? (
                    <>Connect {integrationContext.providerName}</>
                  ) : null}
                </Button>
              ) : (
                <Select
                  disabled={bindingBusy}
                  onValueChange={(value) => {
                    if (!value) return;
                    if (value === "__connect_new__") {
                      handleConnectAccount();
                    } else {
                      void handleSelectBinding(value);
                    }
                  }}
                  value={integrationContext.currentConnectionId ?? ""}
                >
                  {(() => {
                    const currentIndex = candidates.findIndex(
                      (c) =>
                        c.connection_id ===
                        integrationContext.currentConnectionId,
                    );
                    const currentConn =
                      currentIndex >= 0 ? candidates[currentIndex] : null;
                    const currentMeta = currentConn
                      ? accountMetadata.get(currentConn.connection_id)
                      : undefined;
                    const currentLabel = currentConn
                      ? accountDisplayLabel(
                          currentConn,
                          currentMeta,
                          currentIndex,
                        )
                      : `Pick an ${integrationContext.providerName} account`;
                    const currentAvatar = currentMeta?.avatarUrl?.trim();
                    const currentAvatarBroken = currentConn
                      ? avatarFailures.has(currentConn.connection_id)
                      : false;
                    const showCurrentAvatar =
                      Boolean(currentAvatar) && !currentAvatarBroken;
                    return (
                      <SelectTrigger
                        className={`h-7 gap-1.5 rounded-md border border-border bg-background/80 px-2 py-0 text-xs hover:bg-accent [&>svg]:size-3 [&>svg]:shrink-0 ${isNarrowPane ? "max-w-[100px]" : isCompactPane ? "max-w-[140px]" : "max-w-[200px]"}`}
                        size="sm"
                        title={currentLabel}
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          {showCurrentAvatar ? (
                            <img
                              alt=""
                              src={currentAvatar}
                              referrerPolicy="no-referrer"
                              className="size-4 shrink-0 rounded-full bg-muted object-cover"
                              onError={() =>
                                currentConn &&
                                setAvatarFailures((prev) => {
                                  if (prev.has(currentConn.connection_id))
                                    return prev;
                                  const next = new Set(prev);
                                  next.add(currentConn.connection_id);
                                  return next;
                                })
                              }
                            />
                          ) : (
                            <span className="grid size-4 shrink-0 place-items-center text-muted-foreground">
                              {providerIcon(integrationContext.providerId, 12) ?? (
                                <Plug size={10} />
                              )}
                            </span>
                          )}
                          {!isNarrowPane ? (
                            <span className="truncate text-xs font-medium text-foreground">
                              {currentLabel}
                            </span>
                          ) : null}
                        </span>
                      </SelectTrigger>
                    );
                  })()}
                  <SelectContent
                    align="end"
                    className="min-w-[240px] gap-0 rounded-lg p-1 shadow-subtle-sm"
                  >
                    {candidates.map((conn, index) => {
                      const meta = accountMetadata.get(conn.connection_id);
                      const itemLabel = accountDisplayLabel(conn, meta, index);
                      const avatarUrl = meta?.avatarUrl?.trim();
                      const avatarBroken = avatarFailures.has(conn.connection_id);
                      const showAvatar = Boolean(avatarUrl) && !avatarBroken;
                      const fallbackChar = accountAvatarFallbackChar(itemLabel);
                      return (
                        <SelectItem
                          className="rounded-md px-2.5 py-1.5 text-xs"
                          key={conn.connection_id}
                          value={conn.connection_id}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            {showAvatar ? (
                              <img
                                alt=""
                                src={avatarUrl}
                                referrerPolicy="no-referrer"
                                className="size-4 shrink-0 rounded-full bg-muted object-cover"
                                onError={() =>
                                  setAvatarFailures((prev) => {
                                    if (prev.has(conn.connection_id))
                                      return prev;
                                    const next = new Set(prev);
                                    next.add(conn.connection_id);
                                    return next;
                                  })
                                }
                              />
                            ) : (
                              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
                                {fallbackChar}
                              </span>
                            )}
                            <span className="truncate font-medium text-foreground">
                              {itemLabel}
                            </span>
                          </span>
                        </SelectItem>
                      );
                    })}
                    <SelectItem
                      className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground"
                      value="__connect_new__"
                    >
                      + Connect new account
                    </SelectItem>
                  </SelectContent>
                </Select>
              )
            ) : null}
            {showRetry ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onRetry}
                disabled={isRetrying}
                title={surfaceState === "error" ? "Retry" : "Reload"}
                aria-label={surfaceState === "error" ? "Retry" : "Reload"}
              >
                {isRetrying ? (
                  <LoaderCircle size={13} className="animate-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="More options"
                    aria-label="More options"
                  />
                }
              >
                <MoreHorizontal size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[160px] rounded-lg p-1 shadow-subtle-sm"
              >
                <DropdownMenuItem
                  variant="destructive"
                  className="gap-2 rounded-md px-2.5 py-1.5 text-xs"
                  onClick={() => setConfirmRemove(true)}
                >
                  <Trash2 size={12} />
                  Remove app
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {confirmRemove ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/25 bg-destructive/5 px-3 py-2 text-xs">
          <span className="flex-1 text-foreground">
            Remove {label}? This will delete the app and its workspace data.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirmRemove(false)}
            disabled={isRemoving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => void handleRemove()}
            disabled={isRemoving}
          >
            {isRemoving ? "Removing..." : "Confirm"}
          </Button>
        </div>
      ) : null}

      {actionError ? (
        <div className="shrink-0 border-b border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {actionError}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-background">
        {surfaceState === "ready" ? (
          <>
            {frameUrl ? (
              <iframe
                key={`${frameUrl}:${reloadKey}`}
                src={frameUrl}
                title={`${label} surface`}
                className="h-full w-full border-0"
                onLoad={() => {
                  setFrameLoading(false);
                  setFrameError("");
                }}
              />
            ) : null}
            {frameLoading ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/80">
                <div className="text-center">
                  <LoaderCircle
                    size={18}
                    className="mx-auto animate-spin text-muted-foreground"
                  />
                  <div className="mt-2 text-xs text-muted-foreground">
                    Loading {label}...
                  </div>
                </div>
              </div>
            ) : null}
            {frameError ? (
              <div className="absolute inset-0 flex items-center justify-center px-6">
                <div className="max-w-sm rounded-lg border border-destructive/25 bg-destructive/5 p-4 text-center">
                  <div className="text-sm font-medium text-foreground">
                    App preview unavailable
                  </div>
                  <div className="mt-2 text-xs leading-5 text-muted-foreground">
                    {frameError}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    onClick={() => setReloadKey((k) => k + 1)}
                    className="mt-3"
                  >
                    <RefreshCw size={12} />
                    Retry
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : surfaceState === "initializing" ? (
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div className="max-w-sm text-center">
              <LoaderCircle
                size={20}
                className="mx-auto animate-spin text-muted-foreground"
              />
              <div className="mt-3 text-sm font-medium text-foreground">
                Initializing {label}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                This may take a few minutes on first setup.
              </div>
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div className="w-full max-w-md">
              <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-4">
                <div className="flex items-center gap-2 text-destructive">
                  <Activity size={14} />
                  <span className="text-[10px] uppercase tracking-widest">
                    App failed to start
                  </span>
                </div>
                <div className="mt-2 text-sm font-medium text-foreground">
                  {label}
                </div>
                <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-destructive/20 bg-background p-3">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
                    {error}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
