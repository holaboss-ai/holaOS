import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Check,
  Loader2,
  MoreHorizontal,
  Plug,
  RefreshCw,
  Unplug,
} from "@/components/ui/icons";
import { disconnectConnection } from "@/lib/disconnectConnection";
import { useIntegrationAccountMetadata } from "@/lib/integrationAccountStore";
import {
  accountAvatarFallbackChar,
  accountDisplayLabel,
} from "@/lib/integrationDisplay";
import {
  invalidateAllIntegrationConnections,
  listAllIntegrationConnections,
} from "@/lib/listAllIntegrationConnections";
import { useIntegrationConnect } from "@/lib/useIntegrationConnect";
import { composioToolkitSlugForProvider } from "@/lib/workspaceDesktop";

// Manage the account(s) that power a Composio connection for a given provider:
// which are connected (real identity via whoami — avatar + @handle / email),
// which one this workspace defaults to when a provider has several, and per-account
// actions (reconnect / set default / refresh / disconnect) plus connect / add. Shared
// by the connection-tier App detail and the surface-app detail's Connections section.

// Stable empty array so the metadata hook's effect doesn't re-fire on every
// render while connections are still loading.
const NO_CONNECTIONS: IntegrationConnectionPayload[] = [];

export function ConnectionAccounts({
  provider,
  appTitle,
  workspaceId,
  onChanged,
  className = "mt-8",
}: {
  /** Toolkit/provider slug (matched via composioToolkitSlugForProvider). */
  provider: string;
  /** For toasts / confirm copy. */
  appTitle: string;
  /** Active workspace — needed to read/set the per-workspace default account. */
  workspaceId: string | null;
  /** Fired after a change so the parent can refresh derived state. */
  onChanged?: () => void | Promise<void>;
  /** Outer section spacing — tighten when embedded under a provider header. */
  className?: string;
}) {
  const [accounts, setAccounts] = useState<
    IntegrationConnectionPayload[] | null
  >(null);
  // Connection ids that are the workspace default for their provider.
  const [defaultIds, setDefaultIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failedAvatars, setFailedAvatars] = useState<Set<string>>(new Set());
  const metadata = useIntegrationAccountMetadata(accounts ?? NO_CONNECTIONS);
  const { connect } = useIntegrationConnect();

  const load = useCallback(async (): Promise<void> => {
    try {
      const { connections } = await listAllIntegrationConnections();
      const matched = connections.filter(
        (connection) =>
          composioToolkitSlugForProvider(
            (connection.provider_id ?? "").trim().toLowerCase(),
          ) === provider,
      );
      setAccounts(matched);
      if (workspaceId && matched.length > 0) {
        const providerIds = [
          ...new Set(matched.map((c) => c.provider_id).filter(Boolean)),
        ];
        const resolved = await Promise.all(
          providerIds.map((providerId) =>
            window.electronAPI.workspace
              .getWorkspaceDefaultAccount(workspaceId, providerId)
              .then((r) => r.connection_id)
              .catch(() => null),
          ),
        );
        setDefaultIds(
          new Set(resolved.filter((id): id is string => Boolean(id))),
        );
      } else {
        setDefaultIds(new Set());
      }
    } catch {
      setAccounts([]);
      setDefaultIds(new Set());
    }
  }, [provider, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleConnect = useCallback(async (): Promise<void> => {
    const outcome = await connect({ provider });
    if (outcome.kind === "done") {
      invalidateAllIntegrationConnections();
      await load();
      await onChanged?.();
    } else if (outcome.kind === "error") {
      toast.error(`Couldn't connect ${appTitle}`, {
        description:
          outcome.error instanceof Error
            ? outcome.error.message
            : "Try again in a moment.",
      });
    }
  }, [connect, provider, load, onChanged, appTitle]);

  const handleSetDefault = useCallback(
    async (conn: IntegrationConnectionPayload): Promise<void> => {
      if (!workspaceId) {
        return;
      }
      setBusyId(conn.connection_id);
      try {
        await window.electronAPI.workspace.setWorkspaceDefaultAccount(
          workspaceId,
          conn.provider_id,
          conn.connection_id,
        );
        await load();
      } catch (error) {
        toast.error("Couldn't set the default account", {
          description:
            error instanceof Error ? error.message : "Try again in a moment.",
        });
      } finally {
        setBusyId(null);
      }
    },
    [workspaceId, load],
  );

  const handleRefresh = useCallback(
    async (conn: IntegrationConnectionPayload): Promise<void> => {
      setBusyId(conn.connection_id);
      try {
        // Composio accounts are remote-only — dropping the whoami cache + reload
        // re-probes them. Bot-token rows re-validate through the runtime first.
        if (conn.auth_mode !== "composio") {
          await window.electronAPI.workspace.composioRefreshConnection(
            conn.connection_id,
          );
        }
        invalidateAllIntegrationConnections();
        await load();
        toast.success("Account refreshed");
      } catch (error) {
        toast.error("Refresh failed", {
          description:
            error instanceof Error ? error.message : "Try again in a moment.",
        });
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const handleDisconnect = useCallback(
    async (conn: IntegrationConnectionPayload, label: string): Promise<void> => {
      if (
        !window.confirm(
          `Disconnect ${label} from ${appTitle}?\n\nThis revokes the account's authorization. You can reconnect it anytime.`,
        )
      ) {
        return;
      }
      setBusyId(conn.connection_id);
      try {
        await disconnectConnection({
          connectionId: conn.connection_id,
          externalId: conn.account_external_id,
          authMode: conn.auth_mode,
        });
        await load();
        await onChanged?.();
      } catch (error) {
        toast.error(`Couldn't disconnect ${appTitle}`, {
          description:
            error instanceof Error ? error.message : "Try again in a moment.",
        });
      } finally {
        setBusyId(null);
      }
    },
    [appTitle, load, onChanged],
  );

  // Re-authorize an account: run the OAuth connect flow, then drop the stale row
  // it replaces. Composio can keep reporting a revoked account "active" (provider
  // 401s), so a fresh account + removing the old one is the reliable fix. If the
  // old row survives, the runtime resolver prefers the newest connection anyway.
  const handleReconnect = useCallback(
    async (conn: IntegrationConnectionPayload): Promise<void> => {
      setBusyId(conn.connection_id);
      try {
        const outcome = await connect({ provider: conn.provider_id });
        if (outcome.kind === "done") {
          try {
            await disconnectConnection({
              connectionId: conn.connection_id,
              externalId: conn.account_external_id,
              authMode: conn.auth_mode,
            });
          } catch {
            // Best-effort: leave the old row; the resolver still prefers the new one.
          }
          invalidateAllIntegrationConnections();
          await load();
          await onChanged?.();
          toast.success(`Reconnected ${appTitle}`);
        } else if (outcome.kind === "error") {
          toast.error(`Couldn't reconnect ${appTitle}`, {
            description:
              outcome.error instanceof Error
                ? outcome.error.message
                : "Try again in a moment.",
          });
        }
      } finally {
        setBusyId(null);
      }
    },
    [connect, load, onChanged, appTitle],
  );

  const connected = (accounts?.length ?? 0) > 0;
  const multiple = (accounts?.length ?? 0) > 1;

  return (
    <section className={className}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-foreground text-sm">
          {connected ? "Connected accounts" : "Status"}
        </h3>
        {connected ? (
          <Button
            className="shrink-0"
            onClick={() => void handleConnect()}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plug className="size-4" />
            Add account
          </Button>
        ) : null}
      </div>
      {accounts === null ? (
        <div className="mt-2 flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" /> Checking connection…
        </div>
      ) : connected ? (
        <div className="mt-3 flex flex-col gap-2">
          {accounts.map((conn, index) => {
            const meta = metadata.get(conn.connection_id);
            const label = accountDisplayLabel(conn, meta, index);
            const generic =
              label === appTitle || /^Account \d+$/.test(label);
            const rowLabel = generic ? "Connected account" : label;
            const active =
              (conn.status ?? "").trim().toLowerCase() === "active";
            const avatarUrl = meta?.avatarUrl?.trim();
            const showAvatar =
              Boolean(avatarUrl) && !failedAvatars.has(conn.connection_id);
            const isDefault = defaultIds.has(conn.connection_id);
            const busy = busyId === conn.connection_id;
            return (
              <div
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-3"
                key={conn.connection_id}
              >
                {showAvatar ? (
                  // biome-ignore lint/performance/noImgElement: remote provider avatar, not a bundled asset
                  <img
                    alt=""
                    className="size-8 shrink-0 rounded-full bg-muted object-cover"
                    onError={() =>
                      setFailedAvatars((prev) => {
                        if (prev.has(conn.connection_id)) {
                          return prev;
                        }
                        const next = new Set(prev);
                        next.add(conn.connection_id);
                        return next;
                      })
                    }
                    referrerPolicy="no-referrer"
                    src={avatarUrl}
                  />
                ) : (
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted font-semibold text-muted-foreground text-xs">
                    {accountAvatarFallbackChar(label)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-foreground text-sm">
                      {rowLabel}
                    </span>
                    {isDefault ? (
                      <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 font-medium text-[10px] text-foreground uppercase tracking-wider">
                        Default
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span
                      className={
                        active
                          ? "size-1.5 shrink-0 rounded-full bg-emerald-500"
                          : "size-1.5 shrink-0 rounded-full bg-amber-500"
                      }
                    />
                    <span
                      className={
                        active
                          ? "text-muted-foreground text-xs"
                          : "text-amber-600 text-xs dark:text-amber-400"
                      }
                    >
                      {active ? "Connected" : "Reconnect required"}
                    </span>
                  </div>
                </div>
                {busy ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        aria-label={`Options for ${rowLabel}`}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        disabled={busy}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="min-w-[200px]">
                    <DropdownMenuItem onClick={() => void handleReconnect(conn)}>
                      <Plug className="size-3.5" />
                      Reconnect
                    </DropdownMenuItem>
                    {multiple && workspaceId && !isDefault && active ? (
                      <DropdownMenuItem
                        onClick={() => void handleSetDefault(conn)}
                      >
                        <Check className="size-3.5" />
                        Set as default
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onClick={() => void handleRefresh(conn)}>
                      <RefreshCw className="size-3.5" />
                      Refresh account info
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void handleDisconnect(conn, rowLabel)}
                      variant="destructive"
                    >
                      <Unplug className="size-3.5" />
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-2">
          <p className="text-muted-foreground text-sm leading-relaxed">
            Not connected yet. Connect an account and your agent can use{" "}
            {appTitle} in this workspace.
          </p>
          <Button
            className="mt-3"
            onClick={() => void handleConnect()}
            type="button"
            variant="default"
          >
            <Plug className="size-4" />
            Connect
          </Button>
        </div>
      )}
    </section>
  );
}
