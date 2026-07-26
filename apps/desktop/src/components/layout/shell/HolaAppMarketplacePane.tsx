import { useAtom, useSetAtom } from "jotai";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ArrowUpRight, GridFilled } from "@/components/ui/icons";
import {
  type AppCatalogEntry,
  appKind,
  categoryLabel,
  catalogEntryToOpenParams,
} from "@/lib/holaAppMarketplace";
import { invalidateAllIntegrationConnections } from "@/lib/listAllIntegrationConnections";
import { useIntegrationHygiene } from "@/lib/useIntegrationHygiene";
import {
  attachAppOwnedMcp,
  hostedMcpInstallToEntry,
} from "@/lib/mcpMarketplace";
import { cn } from "@/lib/utils";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { ConnectionAppDetail } from "./ConnectionAppDetail";
import { HolaAppDetailView } from "./HolaAppDetailView";
import { HolaAppIcon } from "./HolaAppIcon";
import { HolaAppInstallDialog } from "./HolaAppInstallDialog";
import { McpInstallDialog } from "./McpInstallDialog";
import {
  apiKeyConnectedAppsAtom,
  pendingHubAppDetailAtom,
  pendingHubAppInstallAtom,
} from "./state/ui";
import { useHolaAppCatalog } from "./useHolaAppCatalog";
import { useOpenDiscover } from "./useOpenDiscover";
import { useOpenHolaApp } from "./useOpenHolaApp";
import { useOpenHolaAppDraftChat } from "./useOpenHolaAppDraftChat";

/** An install must first connect a required integration (hard gate). */
function needsConnectGate(entry: AppCatalogEntry): boolean {
  return (
    !entry.installed &&
    (entry.integrations ?? []).some((integration) => integration.required)
  );
}

// The native Apps page, rendered as a full-window workspace overlay (like Channels /
// Customize) — NOT a DOM dialog. A modal can't be used here: the native browser / app
// BrowserView paints over the DOM layer, so a dialog is hidden behind it. The overlay
// replaces the center pane entirely, which detaches that native view.
//
// This page MANAGES installed + connected apps only. Discovering and browsing new apps
// lives in the HolaHub Marketplace (a jump from here); the install/uninstall + connect-gate
// machinery stays because HeadlessInstaller routes gated hub installs through this pane.
//
// `embedded` drops the standalone page title (it renders as the Apps tab inside
// Customize, which frames it); `onBrowseMarketplace` overrides the Marketplace jump so
// Customize can route it through its own per-tab handler.
export function HolaAppMarketplacePane({
  embedded = false,
  onBrowseMarketplace,
}: {
  embedded?: boolean;
  onBrowseMarketplace?: () => void;
} = {}) {
  // Background integration hygiene, formerly hosted by Settings → Integrations —
  // runs the dedup / zombie / abandoned-connect sweeps while the page is open.
  useIntegrationHygiene();
  const { catalog, install, uninstall, refresh } = useHolaAppCatalog();
  const openHolaApp = useOpenHolaApp();
  const openHolaAppDraftChat = useOpenHolaAppDraftChat();
  const openDiscover = useOpenDiscover();
  const setConnectedApps = useSetAtom(apiKeyConnectedAppsAtom);
  const [pending, setPending] = useState<Set<string>>(new Set());
  // The app whose install is blocked on a connection — drives the gate dialog.
  const [installEntry, setInstallEntry] = useState<AppCatalogEntry | null>(null);
  // The hostedMcpInstall app (jianguoyun) whose install gates on its BYO
  // credentials — drives the shared McpInstallDialog, then attaches the app's
  // hosted MCP tagged app-owned (grouped under the app).
  const [hostedMcpGateApp, setHostedMcpGateApp] =
    useState<AppCatalogEntry | null>(null);
  // The app whose detail page is open. Clicking an installed app sets it; null shows
  // the Installed grid. Resolved against the live catalog so state stays in sync.
  const [detailAppId, setDetailAppId] = useState<string | null>(null);
  const detailEntry = detailAppId
    ? (catalog.find((entry) => entry.holaAppId === detailAppId) ?? null)
    : null;
  // Synthetic MCP-catalog entry for the hosted-MCP gate (jianguoyun): its
  // hostedMcpInstall block reused through the shared McpInstallDialog.
  const hostedMcpGateEntry = hostedMcpGateApp?.hostedMcpInstall
    ? hostedMcpInstallToEntry({
        holaAppId: hostedMcpGateApp.holaAppId,
        title: hostedMcpGateApp.title,
        iconUrl: hostedMcpGateApp.iconUrl,
        hostedMcpInstall: hostedMcpGateApp.hostedMcpInstall,
      })
    : null;
  const { selectedWorkspace } = useWorkspaceDesktop();
  const workspaceId = selectedWorkspace?.id ?? null;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Discover / browse more apps → the HolaHub Marketplace, opened at the Apps category.
  const browseMarketplace = () => {
    if (onBrowseMarketplace) {
      onBrowseMarketplace();
      return;
    }
    openDiscover("/marketplace?type=holaapp");
  };

  // Make a just-bound connection usable in chat: ensure the shared Composio MCP
  // is registered for the workspace, then refresh so cards reflect the new state.
  const ensureConnectionLive = async () => {
    if (workspaceId) {
      try {
        await window.electronAPI.workspace.composioMcpEnsureRunning(workspaceId);
      } catch {
        // Runtime re-ensures on the next tool invocation.
      }
    }
    invalidateAllIntegrationConnections();
    await refresh();
  };

  const toggle = async (entry: AppCatalogEntry) => {
    // Coming-soon apps aren't installable yet (server rejects install too) —
    // the card/detail render a disabled control, but guard here as well.
    if (!entry.installed && entry.status === "coming_soon") {
      return;
    }
    // Connection-tier Apps (former "integrations"): add = the connect gate
    // (ProviderRow connects + binds), finalize just ensures the Composio MCP —
    // no backend install. An already-connected one opens its detail; disconnect
    // still lives in Settings → Integrations, so we never hit a backend uninstall
    // for a synthesized slug.
    if (appKind(entry) === "connection") {
      if (entry.installed) {
        setDetailAppId(entry.holaAppId);
      } else {
        setInstallEntry(entry);
      }
      return;
    }
    // API-key apps (OmniSocials, Publora): record the install, open the app
    // surface, and open a FRESH DRAFT chat beside it. The chat is BLOCKED by the
    // surface-based gate until the user enters the key (which attaches the app's
    // MCP). Not the OAuth/one-click paths. (These bundles declare no
    // integrations, so needsConnectGate is false anyway; branch first.)
    if (!entry.installed && entry.apiKeyInstall) {
      try {
        await install(entry.holaAppId);
        openHolaApp(catalogEntryToOpenParams(entry));
        openHolaAppDraftChat(entry.holaAppId);
      } catch (err) {
        console.error(
          `[holaapps] api-key install ${entry.holaAppId} failed`,
          err,
        );
      }
      return;
    }
    // Command/stdio MCP apps (drawio): one-click install with no key and no
    // connect gate. Record the install, attach the LOCAL MCP server (the runtime
    // spawns it) + bring the local editor up, then open the app's live surface.
    if (!entry.installed && entry.commandMcpInstall) {
      setPending((prev) => new Set(prev).add(entry.holaAppId));
      try {
        await install(entry.holaAppId);
        await window.electronAPI.holaApps?.attachCommandMcp?.({
          holaAppId: entry.holaAppId,
          command: entry.commandMcpInstall.command,
          env: entry.commandMcpInstall.env ?? {},
        });
        openHolaApp(catalogEntryToOpenParams(entry));
      } catch (err) {
        console.error(
          `[holaapps] command-mcp install ${entry.holaAppId} failed`,
          err,
        );
      } finally {
        setPending((prev) => {
          const next = new Set(prev);
          next.delete(entry.holaAppId);
          return next;
        });
      }
      return;
    }
    // Hosted-MCP apps (jianguoyun): a Holaboss-hosted MCP that ALSO needs BYO
    // credentials. Gate for the required keys (shared McpInstallDialog), then
    // attach the hosted MCP tagged app-owned so it groups under the app.
    if (!entry.installed && entry.hostedMcpInstall) {
      setHostedMcpGateApp(entry);
      return;
    }
    // Apps that require a connection install through the connect/select gate,
    // not the one-click path: the install only completes once bound.
    if (needsConnectGate(entry)) {
      setInstallEntry(entry);
      return;
    }
    setPending((prev) => new Set(prev).add(entry.holaAppId));
    try {
      if (entry.installed) {
        await uninstall(entry.holaAppId);
        // API-key apps: forget the "connected" flag so a reinstall gates again.
        if (entry.apiKeyInstall) {
          setConnectedApps((prev) => {
            if (!(entry.holaAppId in prev)) {
              return prev;
            }
            const next = { ...prev };
            delete next[entry.holaAppId];
            return next;
          });
        }
      } else {
        await install(entry.holaAppId);
      }
    } catch (err) {
      console.error(
        `[holaapps] ${entry.installed ? "uninstall" : "install"} ${entry.holaAppId} failed`,
        err,
      );
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(entry.holaAppId);
        return next;
      });
    }
  };

  // Consume a HolaHub "install" intent for a gated app (routed here by the
  // HeadlessInstaller for the connection / hosted-MCP flavors it can't complete
  // headlessly): open that app's own install gate, then clear the intent. Uses a
  // ref so the effect needn't depend on the re-created `toggle`.
  const [pendingHubApp, setPendingHubApp] = useAtom(pendingHubAppInstallAtom);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    if (!pendingHubApp || catalog.length === 0) {
      return;
    }
    const entry = catalog.find((app) => app.holaAppId === pendingHubApp);
    setPendingHubApp(null);
    if (entry && !entry.installed) {
      void toggleRef.current(entry);
    }
  }, [pendingHubApp, catalog, setPendingHubApp]);

  // Consume a HolaHub "open" intent for a connection-tier app (its Manage jump):
  // land straight on that app's detail instead of the bare installed list.
  const [pendingHubAppDetail, setPendingHubAppDetail] = useAtom(
    pendingHubAppDetailAtom,
  );
  useEffect(() => {
    if (!pendingHubAppDetail) {
      return;
    }
    // Set the id, not the entry: `detailEntry` resolves against the live catalog,
    // so a ref this pane hasn't fetched yet renders the list and flips to the
    // detail on the next refresh instead of being dropped.
    setDetailAppId(pendingHubAppDetail);
    setPendingHubAppDetail(null);
  }, [pendingHubAppDetail, setPendingHubAppDetail]);

  // The page never shows team-native apps (Need Review, HolaEmployee) — they live in
  // the org left column (SidebarOrgAppsSection), not here. What remains is installed
  // apps + connected integrations (connection-tier entries flip to installed once bound).
  const installedApps = catalog.filter(
    (entry) => !entry.teamNative && (entry.installed || entry.connectionBound),
  );
  // Two kinds live here: apps you open (a surface) and headless connections the
  // agent drives. Splitting them makes the list tell you what each thing is.
  // An app whose connection is bound but which was kept out of the sidebar
  // ("Keep just the connection") IS a connection here — the agent uses it, so it
  // has to stay visible and manageable.
  const isOpenableSurface = (entry: AppCatalogEntry) =>
    entry.installed && appKind(entry) !== "connection";
  const installedSurfaces = installedApps.filter(isOpenableSurface);
  const installedConnections = installedApps.filter(
    (entry) => !isOpenableSurface(entry),
  );

  const openAppSurface = (entry: AppCatalogEntry) => {
    openHolaApp(catalogEntryToOpenParams(entry));
    openHolaAppDraftChat(entry.holaAppId);
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        {detailEntry ? (
          appKind(detailEntry) === "connection" ? (
            <ConnectionAppDetail
              entry={detailEntry}
              onBack={() => setDetailAppId(null)}
              onChanged={refresh}
              workspaceId={workspaceId}
            />
          ) : (
            <HolaAppDetailView
              busy={pending.has(detailEntry.holaAppId)}
              entry={detailEntry}
              onBack={() => setDetailAppId(null)}
              onOpen={() => {
                openHolaApp(catalogEntryToOpenParams(detailEntry));
                openHolaAppDraftChat(detailEntry.holaAppId);
              }}
              onToggle={() => toggle(detailEntry)}
              workspaceId={workspaceId}
            />
          )
        ) : (
          <>
            {/* Header — only in the standalone overlay; embedded in Customize the
                page title + Marketplace jump are provided by Customize's own chrome. */}
            {embedded ? null : (
              <div className="mx-auto w-full max-w-5xl shrink-0 px-6 pt-8 pb-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h1 className="font-semibold text-2xl text-foreground tracking-tight">
                      Apps
                    </h1>
                    <p className="mt-1 max-w-xl text-muted-foreground text-sm">
                      Apps and connections your agent uses from chat. Manage
                      what's installed here.
                    </p>
                  </div>
                  <button
                    className="inline-flex shrink-0 items-center gap-1 font-medium text-primary text-sm transition-colors hover:text-primary/80"
                    onClick={browseMarketplace}
                    type="button"
                  >
                    Browse the Marketplace
                    <ArrowUpRight className="size-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Body — scrolls beneath the header, same centered column. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div
                className={cn(
                  "mx-auto w-full max-w-5xl px-6 pb-10",
                  embedded ? "pt-4" : "pt-2",
                )}
              >
                {installedApps.length > 0 ? (
                  <div className="flex flex-col gap-6">
                    {installedSurfaces.length > 0 ? (
                      <InstalledGroup
                        count={installedSurfaces.length}
                        title="Apps"
                      >
                        {installedSurfaces.map((entry) => (
                          <div
                            className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:bg-accent"
                            key={entry.holaAppId}
                          >
                            <button
                              className="flex min-w-0 flex-1 items-center gap-3 text-left"
                              onClick={() => setDetailAppId(entry.holaAppId)}
                              type="button"
                            >
                              <HolaAppIcon
                                holaAppId={entry.holaAppId}
                                iconUrl={entry.iconUrl}
                                sizeClass="size-7"
                                title={entry.title}
                              />
                              <span className="min-w-0">
                                <span className="block truncate font-medium text-foreground text-sm">
                                  {entry.title}
                                </span>
                                {entry.category ? (
                                  <span className="block truncate text-muted-foreground text-xs">
                                    {categoryLabel(entry.category)}
                                  </span>
                                ) : null}
                              </span>
                            </button>
                            <Button
                              className="h-7 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                              onClick={() => openAppSurface(entry)}
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              Open
                            </Button>
                          </div>
                        ))}
                      </InstalledGroup>
                    ) : null}

                    {installedConnections.length > 0 ? (
                      <InstalledGroup
                        count={installedConnections.length}
                        title="Connections"
                      >
                        {installedConnections.map((entry) => (
                          <button
                            className="group flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:bg-accent"
                            key={entry.holaAppId}
                            onClick={() => setDetailAppId(entry.holaAppId)}
                            type="button"
                          >
                            <HolaAppIcon
                              holaAppId={entry.holaAppId}
                              iconUrl={entry.iconUrl}
                              sizeClass="size-7"
                              title={entry.title}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium text-foreground text-sm">
                                {entry.title}
                              </span>
                              {entry.category ? (
                                <span className="block truncate text-muted-foreground text-xs">
                                  {categoryLabel(entry.category)}
                                </span>
                              ) : null}
                            </span>
                            <span className="shrink-0 text-muted-foreground text-xs opacity-0 transition-opacity group-hover:opacity-100">
                              Manage
                            </span>
                          </button>
                        ))}
                      </InstalledGroup>
                    ) : null}
                  </div>
                ) : (
                  <EmptyState
                    action={
                      <button
                        className="inline-flex items-center gap-1 font-medium text-primary text-sm transition-colors hover:text-primary/80"
                        onClick={browseMarketplace}
                        type="button"
                      >
                        Browse the Marketplace
                        <ArrowUpRight className="size-4" />
                      </button>
                    }
                    decorated
                    description="Apps and connections give your agent new abilities — install one from the Marketplace to get started."
                    icon={GridFilled}
                    size="md"
                    title="No apps installed yet"
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {installEntry ? (
        <HolaAppInstallDialog
          open
          entry={installEntry}
          onOpenChange={(next) => {
            if (!next) setInstallEntry(null);
          }}
          onConfirm={async () => {
            // Connection-tier: ProviderRow already connected + bound the account.
            // There's no backend App to install — just ensure the shared Composio
            // MCP is registered, then refresh so the card flips to Installed.
            if (appKind(installEntry) === "connection") {
              await ensureConnectionLive();
              return;
            }
            // App: add it to the sidebar. If it required a connection (now
            // bound), also ensure the shared Composio MCP so the agent can use it
            // in chat — the same access the connect-only path grants.
            await install(installEntry.holaAppId);
            if ((installEntry.integrations ?? []).length > 0) {
              await ensureConnectionLive();
            }
          }}
          onConnectOnly={
            // Single-connection App only: finish with just the connection bound —
            // agent access in chat, no sidebar app.
            appKind(installEntry) !== "connection" &&
            needsConnectGate(installEntry)
              ? async () => {
                  await ensureConnectionLive();
                }
              : undefined
          }
        />
      ) : null}
      {hostedMcpGateApp && hostedMcpGateEntry ? (
        <McpInstallDialog
          entry={hostedMcpGateEntry}
          onConfirm={async (values) => {
            // Mark the app installed first (its plain attach discovers 0 tools
            // without creds and skips); then attach the hosted MCP WITH creds via
            // the dedicated app-owned path — that write wins and isn't touched by
            // the marketplace sync.
            await install(hostedMcpGateApp.holaAppId).catch(() => {
              // best-effort — the MCP attach below is the critical step
            });
            await attachAppOwnedMcp(
              hostedMcpGateEntry,
              values,
              hostedMcpGateApp.holaAppId,
            );
            openHolaApp(catalogEntryToOpenParams(hostedMcpGateApp));
          }}
          onOpenChange={(next) => {
            if (!next) setHostedMcpGateApp(null);
          }}
          open
        />
      ) : null}
    </>
  );
}

function InstalledGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2 px-2">
        <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {title}
        </h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {count}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>
    </section>
  );
}
