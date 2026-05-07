import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, FileUp, LoaderCircle } from "lucide-react";
import {
  getProviderForCatalogEntry,
  resolveAppDisplay,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { AppCatalogCard } from "./AppCatalogCard";

function AppCatalogCardSkeleton() {
  return (
    <Card size="sm" className="animate-pulse">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="size-9 shrink-0 rounded-lg bg-muted-foreground/15" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3.5 w-24 rounded bg-muted-foreground/15" />
            <div className="h-2.5 w-10 rounded bg-muted-foreground/10" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-1.5">
        <div className="h-2 w-full rounded bg-muted-foreground/15" />
        <div className="h-2 w-[92%] rounded bg-muted-foreground/15" />
        <div className="h-2 w-[70%] rounded bg-muted-foreground/15" />
      </CardContent>
      <CardFooter className="justify-end">
        <div className="h-7 w-20 rounded-md bg-muted-foreground/15" />
      </CardFooter>
    </Card>
  );
}

export function AppsGallery() {
  const {
    appCatalog,
    isLoadingAppCatalog,
    appCatalogError,
    appCatalogSource,
    refreshAppCatalog,
    composioToolkitsByProvider,
    installingAppId,
    installAppFromCatalog,
    installedApps,
    selectedWorkspace,
    pendingAppInstall,
    clearPendingAppInstall,
    connectAndInstallApp,
    isConnectingAppIntegration,
    refreshInstalledApps,
  } = useWorkspaceDesktop();

  const [isInstallingFromFile, setIsInstallingFromFile] = useState(false);
  const [installFromFileError, setInstallFromFileError] = useState<
    string | null
  >(null);

  const handleInstallFromArchive = useCallback(async () => {
    if (!selectedWorkspace) return;
    setInstallFromFileError(null);
    setIsInstallingFromFile(true);
    try {
      const result =
        await window.electronAPI.workspace.installAppFromArchiveFile({
          workspaceId: selectedWorkspace.id,
        });
      // null = user cancelled the file picker; not an error.
      if (result) {
        await refreshInstalledApps();
      }
    } catch (err) {
      setInstallFromFileError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setIsInstallingFromFile(false);
    }
  }, [selectedWorkspace, refreshInstalledApps]);

  useEffect(() => {
    void refreshAppCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appCatalogSource]);

  const installedIds = useMemo(
    () => new Set(installedApps.map((app) => app.id)),
    [installedApps],
  );
  const workspaceGated = !selectedWorkspace;
  const anyInstalling = Boolean(installingAppId);

  // Active integration connections, indexed by provider id, used to
  // surface the multi-account picker on cards that have ≥2 accounts for
  // the app's expected provider. Refreshed when the gallery mounts and
  // after any install completes (so a connection added via the
  // "connect first → install" flow shows up immediately).
  const [accountsByProvider, setAccountsByProvider] = useState<
    Record<string, IntegrationConnectionPayload[]>
  >({});
  const refreshAccounts = useCallback(async () => {
    try {
      const { connections } =
        await window.electronAPI.workspace.listIntegrationConnections();
      const grouped: Record<string, IntegrationConnectionPayload[]> = {};
      for (const conn of connections) {
        if (conn.status !== "active") continue;
        const key = conn.provider_id.toLowerCase();
        const list = grouped[key] ?? [];
        list.push(conn);
        grouped[key] = list;
      }
      setAccountsByProvider(grouped);
    } catch {
      // Non-fatal — without account data, cards just don't show the
      // picker (auto-bind path still works).
    }
  }, []);
  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);
  useEffect(() => {
    if (!installingAppId) {
      // Refresh once an install has cleared so newly-connected accounts
      // become available to other cards.
      void refreshAccounts();
    }
  }, [installingAppId, refreshAccounts]);

  // Per-card selected connection. Local-only — not persisted; the user's
  // pick gets written into integration_bindings when they actually click
  // Install. Falls back to the most-recently-updated active account if
  // they never touch the dropdown.
  const [selectedAccountByApp, setSelectedAccountByApp] = useState<
    Record<string, string>
  >({});
  const handleSelectAccount = useCallback(
    (appId: string, connectionId: string) => {
      setSelectedAccountByApp((prev) => ({ ...prev, [appId]: connectionId }));
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {workspaceGated ? (
        <p className="text-xs text-muted-foreground">
          Select a workspace to install apps.
        </p>
      ) : (
        <div className="mb-1 flex items-center justify-end">
          <Button
            variant="ghost"
            size="sm"
            disabled={
              isInstallingFromFile || anyInstalling || Boolean(pendingAppInstall)
            }
            onClick={() => void handleInstallFromArchive()}
            title="Pick a .tar.gz built by hola-boss-apps/scripts/build-archive.sh"
          >
            {isInstallingFromFile ? (
              <LoaderCircle size={13} className="animate-spin" />
            ) : (
              <FileUp size={13} />
            )}
            Install from file…
          </Button>
        </div>
      )}

      {appCatalogError ? (
        <div className="mt-3 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {appCatalogError}
        </div>
      ) : null}

      {installFromFileError ? (
        <div className="mt-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {installFromFileError}
        </div>
      ) : null}

      {pendingAppInstall ? (
        <div className="fixed inset-0 z-[60] grid place-items-center px-4 py-6">
          <button
            type="button"
            aria-label="Cancel connect account"
            onClick={clearPendingAppInstall}
            disabled={isConnectingAppIntegration}
            className="absolute inset-0 bg-scrim backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Connect account"
            className="relative z-10 w-[min(440px,calc(100vw-32px))] rounded-2xl border border-border/55 bg-background p-5 shadow-2xl"
          >
            <p className="text-base font-semibold text-foreground">
              Connect{" "}
              {composioToolkitsByProvider[pendingAppInstall.provider.toLowerCase()]
                ?.name ?? pendingAppInstall.provider}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {pendingAppInstall.appId} requires a connected{" "}
              {composioToolkitsByProvider[pendingAppInstall.provider.toLowerCase()]
                ?.name ?? pendingAppInstall.provider}{" "}
              account to work. Connect it first, then the app will be installed
              automatically.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={isConnectingAppIntegration}
                onClick={clearPendingAppInstall}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={isConnectingAppIntegration}
                onClick={() => void connectAndInstallApp()}
              >
                {isConnectingAppIntegration ? (
                  <>
                    <LoaderCircle size={13} className="animate-spin" />
                    Waiting for authorization…
                  </>
                ) : (
                  <>
                    <ExternalLink size={13} />
                    Connect account
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {isLoadingAppCatalog && appCatalog.length === 0 ? (
        <div className="mt-4 grid grid-cols-1 gap-2 pb-6 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton count
            <AppCatalogCardSkeleton key={i} />
          ))}
        </div>
      ) : appCatalog.length === 0 ? (
        <div className="mt-8 text-center text-xs text-muted-foreground">
          No apps available.
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-2 pb-6 md:grid-cols-2 xl:grid-cols-3">
          {appCatalog.map((entry) => {
            const isInstalled = installedIds.has(entry.app_id);
            const isInstalling = installingAppId === entry.app_id;
            const state = isInstalled
              ? "installed"
              : isInstalling
                ? "installing"
                : "available";
            const provider = getProviderForCatalogEntry(entry);
            const candidates = provider
              ? accountsByProvider[provider.toLowerCase()] ?? []
              : [];
            const sortedCandidates = candidates
              .slice()
              .sort((a, b) =>
                (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
              );
            const selected =
              selectedAccountByApp[entry.app_id] ??
              sortedCandidates[0]?.connection_id;
            const display = resolveAppDisplay(
              entry.provider_id,
              composioToolkitsByProvider,
            );
            return (
              <AppCatalogCard
                key={`${entry.source}:${entry.app_id}`}
                entry={entry}
                state={state}
                disabled={
                  workspaceGated ||
                  (anyInstalling && !isInstalling) ||
                  Boolean(pendingAppInstall)
                }
                displayName={display.name}
                logoUrl={display.logo}
                availableAccounts={sortedCandidates}
                selectedConnectionId={selected ?? null}
                onSelectAccount={(connectionId) =>
                  handleSelectAccount(entry.app_id, connectionId)
                }
                onInstall={() =>
                  void installAppFromCatalog(entry.app_id, {
                    connectionId: selected,
                  })
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
