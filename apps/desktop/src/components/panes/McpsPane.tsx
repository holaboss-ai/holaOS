import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  SettingsCard,
  SettingsRow,
  SettingsStatusBadge,
} from "@/components/settings";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ArrowUpRight,
  ChevronDown,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from "@/components/ui/icons";
import { McpInstallDialog } from "@/components/layout/shell/McpInstallDialog";
import { McpMarketplaceCard } from "@/components/layout/shell/McpMarketplaceCard";
import { useMcpCatalog } from "@/components/layout/shell/useMcpCatalog";
import type { McpCatalogEntry } from "@/lib/mcpMarketplace";

// The MCP tab. Mirrors the Integrations tab's store/connected split:
//   mode="browse"  → the MCP marketplace (install standalone MCP servers)
//   default        → the MCPs connected to this workspace, grouped by owner
//                    (standalone pool + per-app containers)
// CustomizePane owns the store/connected nav header + search; this renders the
// content for the active view.
export function McpsPane({
  workspaceId,
  mode,
  browseQuery,
  onAddMcpServer,
  onSeeInstalled,
  installRef,
  onInstallHandled,
  onBrowseMarketplace,
}: {
  workspaceId: string | null;
  mode?: "browse";
  browseQuery?: string;
  onAddMcpServer?: () => void;
  /** Browse mode: open the connected view (the full installed list). */
  onSeeInstalled?: () => void;
  /** Browse mode: a catalog id to auto-install (HolaHub install hand-off). */
  installRef?: string | null;
  onInstallHandled?: () => void;
  /** Open the HolaHub Marketplace — renders a link in the connected header. */
  onBrowseMarketplace?: () => void;
}) {
  if (mode === "browse") {
    return (
      <McpsBrowse
        browseQuery={browseQuery}
        installRef={installRef}
        onInstallHandled={onInstallHandled}
        onSeeInstalled={onSeeInstalled}
        workspaceId={workspaceId}
      />
    );
  }
  return (
    <McpsConnected
      onAddMcpServer={onAddMcpServer}
      onBrowseMarketplace={onBrowseMarketplace}
      workspaceId={workspaceId}
    />
  );
}

// ── Store: the MCP marketplace ───────────────────────────────────────────────
function McpsBrowse({
  browseQuery,
  onSeeInstalled,
  workspaceId,
  installRef,
  onInstallHandled,
}: {
  browseQuery?: string;
  onSeeInstalled?: () => void;
  workspaceId: string | null;
  installRef?: string | null;
  onInstallHandled?: () => void;
}) {
  const { catalog, install, uninstall, refresh } = useMcpCatalog();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [installEntry, setInstallEntry] = useState<McpCatalogEntry | null>(null);
  const [consentEntry, setConsentEntry] = useState<McpCatalogEntry | null>(null);
  // The MCPs actually attached to this workspace (workspace.yaml's standalone
  // pool) — the real "connected" state. It includes servers with NO catalog
  // entry (locally-added / custom, e.g. a local stdio server), which the
  // catalog's `installed` flag can't see. The preview reads the workspace so it
  // shows everything that's connected, not just installed catalog servers.
  const [connected, setConnected] = useState<WorkspaceMcpServerEntryPayload[]>(
    []
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reloadConnected = useCallback(async () => {
    if (!workspaceId) {
      setConnected([]);
      return;
    }
    try {
      const result =
        await window.electronAPI.workspace.listMcpServers(workspaceId);
      setConnected(result.servers.filter((server) => !server.ownerAppId));
    } catch {
      setConnected([]);
    }
  }, [workspaceId]);
  useEffect(() => {
    void reloadConnected();
  }, [reloadConnected]);

  // Preview the servers connected to this workspace (catalog-named when known,
  // else the raw server id), with a "See all" link into the full connected view.
  const INSTALLED_PREVIEW = 6;
  const catalogById = new Map(
    catalog.map((entry) => [entry.id, entry] as const)
  );
  const connectedItems = connected.map((server) => ({
    id: server.id,
    name: catalogById.get(server.id)?.name ?? server.id,
    entry: catalogById.get(server.id) ?? null,
  }));
  const installedPreview = connectedItems.slice(0, INSTALLED_PREVIEW);
  const namedHidden = connectedItems
    .slice(INSTALLED_PREVIEW, INSTALLED_PREVIEW + 2)
    .map((item) => item.name);
  const hiddenCount = connectedItems.length - installedPreview.length;
  const seeMoreLabel =
    namedHidden.length > 0
      ? `See ${namedHidden.join(", ")}${
          hiddenCount - namedHidden.length > 0
            ? `, and ${hiddenCount - namedHidden.length} more`
            : ""
        }`
      : `See all ${connectedItems.length} connected`;

  const removeConnected = async (item: {
    id: string;
    name: string;
    entry: McpCatalogEntry | null;
  }) => {
    setPending((prev) => new Set(prev).add(item.id));
    try {
      if (item.entry) {
        await uninstall(item.entry.id);
      } else if (workspaceId) {
        await window.electronAPI.workspace.deleteMcpServer(
          workspaceId,
          item.id
        );
      }
      await reloadConnected();
    } catch (error) {
      toast.error(`Couldn't remove ${item.name}`, {
        description: error instanceof Error ? error.message : "Request failed.",
      });
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    }
  };

  const q = (browseQuery ?? "").trim().toLowerCase();
  const visible = q
    ? catalog.filter((entry) =>
        [
          entry.name,
          entry.description ?? "",
          entry.category ?? "",
          ...(entry.tags ?? []),
        ].some((field) => field.toLowerCase().includes(q)),
      )
    : catalog;

  const toggle = async (entry: McpCatalogEntry, consented = false) => {
    if (!entry.installed && entry.comingSoon) {
      return;
    }
    // Community (unverified) servers require an explicit consent acknowledgement
    // first — their tools run inside the agent.
    if (!entry.installed && !entry.verified && !consented) {
      setConsentEntry(entry);
      return;
    }
    // Servers that need keys open the gate first; keyless ones install directly.
    if (!entry.installed && entry.requiredKeys.length > 0) {
      setInstallEntry(entry);
      return;
    }
    setPending((prev) => new Set(prev).add(entry.id));
    try {
      if (entry.installed) {
        await uninstall(entry.id);
      } else {
        await install(entry, {});
      }
    } catch (error) {
      toast.error(
        `Couldn't ${entry.installed ? "uninstall" : "install"} ${entry.name}`,
        {
          description: error instanceof Error ? error.message : "Request failed.",
        },
      );
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
      void reloadConnected();
    }
  };

  // HolaHub "Install" hand-off: auto-trigger install of a specific catalog MCP
  // once the catalog has loaded (keyless attaches directly; keyed opens the key
  // dialog; unverified opens the consent gate — same as clicking its card).
  // Skips an already-installed server so we never toggle it back off.
  useEffect(() => {
    if (!installRef) {
      return;
    }
    const entry = catalog.find((e) => e.id === installRef);
    if (!entry) {
      return; // catalog not loaded yet — a later render will pick it up
    }
    onInstallHandled?.();
    if (!entry.installed) {
      void toggle(entry);
    }
  }, [installRef, catalog, onInstallHandled, toggle]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto w-full max-w-5xl space-y-6 px-6">
        {onSeeInstalled && installedPreview.length > 0 ? (
          <section className="flex flex-col gap-2.5">
            <h3 className="font-medium text-foreground text-sm">Installed</h3>
            <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              {installedPreview.map((item) => (
                <div
                  className="group/card flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
                  key={item.id}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-muted">
                    <Server className="size-4 text-muted-foreground" />
                  </span>
                  <p className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
                    {item.name}
                  </p>
                  <Button
                    aria-label={`Remove ${item.name}`}
                    className="h-7 shrink-0 whitespace-nowrap px-2 text-muted-foreground text-xs hover:text-destructive"
                    disabled={pending.has(item.id)}
                    onClick={() => void removeConnected(item)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {pending.has(item.id) ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <>
                        <span className="group-hover/card:hidden">Installed</span>
                        <span className="hidden group-hover/card:inline">
                          Uninstall
                        </span>
                      </>
                    )}
                  </Button>
                </div>
              ))}
            </div>
            <button
              className="self-start text-muted-foreground text-sm transition-colors hover:text-foreground"
              onClick={onSeeInstalled}
              type="button"
            >
              {seeMoreLabel}
            </button>
          </section>
        ) : null}

        {catalog.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground text-sm">
            No MCP servers available yet.
          </div>
        ) : visible.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground text-sm">
            No MCP servers match your search.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((entry) => (
              <McpMarketplaceCard
                busy={pending.has(entry.id)}
                entry={entry}
                key={entry.id}
                onToggle={() => void toggle(entry)}
              />
            ))}
          </div>
        )}
      </div>
      {installEntry ? (
        <McpInstallDialog
          entry={installEntry}
          onConfirm={(values) => install(installEntry, values)}
          onOpenChange={(next) => {
            if (!next) {
              setInstallEntry(null);
            }
          }}
          open
        />
      ) : null}
      {consentEntry ? (
        <ConfirmDialog
          confirmLabel="Install anyway"
          description={`${consentEntry.name} is community-contributed and hasn't been vetted by holaOS — its tools run inside your agent. Only install servers you trust.`}
          destructive
          onConfirm={() => void toggle(consentEntry, true)}
          onOpenChange={(next) => {
            if (!next) {
              setConsentEntry(null);
            }
          }}
          open
          title="Install an unverified server?"
        />
      ) : null}
    </div>
  );
}

// ── Connected: MCPs attached to this workspace, grouped by owner ──────────────
function McpsConnected({
  workspaceId,
  onAddMcpServer,
  onBrowseMarketplace,
}: {
  workspaceId: string | null;
  onAddMcpServer?: () => void;
  onBrowseMarketplace?: () => void;
}) {
  const [servers, setServers] = useState<WorkspaceMcpServerEntryPayload[]>([]);
  const [pendingDelete, setPendingDelete] =
    useState<WorkspaceMcpServerEntryPayload | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [authorizeBusyId, setAuthorizeBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!workspaceId) {
      setServers([]);
      return;
    }
    try {
      const result =
        await window.electronAPI.workspace.listMcpServers(workspaceId);
      setServers(result.servers);
    } catch {
      setServers([]);
    }
  }, [workspaceId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const deleteServer = useCallback(
    async (server: WorkspaceMcpServerEntryPayload) => {
      if (!workspaceId) {
        return;
      }
      setDeleteBusyId(server.id);
      try {
        await window.electronAPI.workspace.deleteMcpServer(
          workspaceId,
          server.id,
        );
        setServers((previous) =>
          previous.filter((entry) => entry.id !== server.id),
        );
        toast.success(`Removed MCP server "${server.id}"`, {
          description: "Its tools disappear from the agent on the next turn.",
        });
        void reload();
      } catch (error) {
        toast.error(`Couldn't remove "${server.id}"`, {
          description: error instanceof Error ? error.message : "Request failed.",
        });
      } finally {
        setDeleteBusyId(null);
      }
    },
    [workspaceId, reload],
  );

  // Kick off the interactive OAuth flow for a remote MCP server that needs it
  // (e.g. HeyGen). The runtime opens the system browser and waits for consent,
  // then persists a token the agent replays on later turns — so this call is
  // long-lived. Its tools appear on the next message once authorized.
  const authorizeServer = useCallback(
    async (server: WorkspaceMcpServerEntryPayload, reauthorize = false) => {
      if (!workspaceId) {
        return;
      }
      setAuthorizeBusyId(server.id);
      toast.info(
        reauthorize ? `Re-authorizing "${server.id}"…` : `Authorizing "${server.id}"…`,
        {
          description: reauthorize
            ? "A browser window will open — sign in with the account you want. (Sign out of the current account there first to switch.)"
            : "A browser window will open — complete the sign-in there.",
        },
      );
      try {
        const result = await window.electronAPI.workspace.authorizeMcpServer(
          workspaceId,
          server.id,
          reauthorize,
        );
        if (result.ok) {
          const count = result.tool_count;
          toast.success(
            reauthorize ? `Re-authorized "${server.id}"` : `Authorized "${server.id}"`,
            {
              description: `${count} tool${count === 1 ? "" : "s"} available — send one more message to use them.`,
            },
          );
        } else {
          toast.error(`Couldn't authorize "${server.id}"`, {
            description: result.detail || "Authorization failed.",
          });
        }
        void reload();
      } catch (error) {
        toast.error(`Couldn't authorize "${server.id}"`, {
          description: error instanceof Error ? error.message : "Request failed.",
        });
      } finally {
        setAuthorizeBusyId(null);
      }
    },
    [workspaceId, reload],
  );

  const refreshTools = useCallback(async () => {
    if (!workspaceId) {
      return;
    }
    setRefreshBusy(true);
    try {
      await window.electronAPI.workspace.refreshMcpTools(workspaceId);
      toast.success("Refreshing MCP tools", {
        description:
          "Connected servers are re-discovered on the next turn — send one more message.",
      });
    } catch (error) {
      toast.error("Couldn't refresh MCP tools", {
        description: error instanceof Error ? error.message : "Request failed.",
      });
    } finally {
      setRefreshBusy(false);
    }
  }, [workspaceId]);

  const renderRow = (server: WorkspaceMcpServerEntryPayload) => (
    <SettingsRow
      key={server.id}
      leading={<Server className="size-4 text-muted-foreground" />}
      label={
        <span className="flex items-center gap-2">
          <span className="truncate">{server.id}</span>
          {server.enabled ? null : (
            <SettingsStatusBadge tone="muted">Disabled</SettingsStatusBadge>
          )}
        </span>
      }
      description={
        server.url ??
        (server.command && server.command.length > 0
          ? server.command.join(" ")
          : "Connected MCP server")
      }
    >
      <div className="flex items-center gap-2">
        <SettingsStatusBadge tone="muted">{server.transport}</SettingsStatusBadge>
        {!server.appManaged && server.transport === "remote" ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={`Authorize MCP server ${server.id}`}
                  disabled={authorizeBusyId === server.id}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {authorizeBusyId === server.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="size-3.5" />
                  )}
                  Authorize
                  <ChevronDown className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-[240px]">
              <DropdownMenuItem onClick={() => void authorizeServer(server, false)}>
                Sign in
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void authorizeServer(server, true)}>
                Switch account (re-authorize)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {server.appManaged ? null : (
          <Button
            aria-label={`Remove MCP server ${server.id}`}
            className="text-muted-foreground hover:text-destructive"
            disabled={deleteBusyId === server.id}
            onClick={() => setPendingDelete(server)}
            size="icon-sm"
            variant="ghost"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </SettingsRow>
  );

  // Standalone MCPs only — app-owned MCPs are managed via their app's lifecycle.
  const standalone = servers.filter((server) => !server.ownerAppId);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-6">
      <div className="mx-auto w-full max-w-5xl space-y-4 px-6">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium text-foreground text-sm">Installed</h3>
          <div className="flex shrink-0 items-center gap-2">
            {servers.length > 0 ? (
              <Button
                disabled={refreshBusy}
                onClick={() => void refreshTools()}
                size="sm"
                type="button"
                variant="outline"
              >
                {refreshBusy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                Refresh tools
              </Button>
            ) : null}
            {onAddMcpServer ? (
              <Button
                onClick={onAddMcpServer}
                size="sm"
                type="button"
                variant="outline"
              >
                <Plus className="size-3.5" />
                Add MCP server
              </Button>
            ) : null}
          </div>
        </div>

        {standalone.length === 0 ? (
          <EmptyState
            action={
              onBrowseMarketplace ? (
                <Button
                  onClick={onBrowseMarketplace}
                  size="sm"
                  type="button"
                >
                  Browse the Marketplace
                  <ArrowUpRight className="size-3.5" />
                </Button>
              ) : null
            }
            decorated
            description="MCP servers give your agent extra tools. Add one, or browse the Marketplace — app-owned servers come with their app."
            icon={Server}
            size="md"
            title="No MCP servers connected yet"
          />
        ) : (
          <SettingsCard>{standalone.map(renderRow)}</SettingsCard>
        )}
      </div>

      <ConfirmDialog
        confirmLabel="Remove"
        description={
          pendingDelete
            ? `"${pendingDelete.id}" is removed from this workspace and the agent loses its tools on the next turn.`
            : undefined
        }
        destructive
        onConfirm={() => {
          if (pendingDelete) {
            void deleteServer(pendingDelete);
          }
          setPendingDelete(null);
        }}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
        open={pendingDelete !== null}
        title="Remove this MCP server?"
      />
    </div>
  );
}
