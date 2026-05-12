import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ExternalLink, LoaderCircle, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

export type AssistantTurnPendingIntegration = {
  app_id: string;
  provider_id: string;
  credential_source?: string | null;
};

type CardState =
  | { kind: "loading" }
  | { kind: "no_workspace" }
  | { kind: "no_connection" }
  | {
      kind: "needs_binding";
      connections: IntegrationConnectionPayload[];
    }
  | {
      kind: "bound";
      activeConnection: IntegrationConnectionPayload;
      otherActiveConnections: IntegrationConnectionPayload[];
    };

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message?.trim();
    if (message) return message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Unknown error";
}

export function AssistantTurnIntegrationConnects({
  pendingIntegrations,
  onAfterBind,
}: {
  pendingIntegrations: AssistantTurnPendingIntegration[];
  onAfterBind?: () => void;
}) {
  if (pendingIntegrations.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  const unique = pendingIntegrations.filter((entry) => {
    const key = `${entry.provider_id.trim().toLowerCase()}|${entry.app_id.trim()}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div className="mt-3 flex flex-col gap-2">
      {unique.map((entry) => (
        <IntegrationConnectCard
          key={`${entry.provider_id}|${entry.app_id}`}
          integration={entry}
          onAfterBind={onAfterBind}
        />
      ))}
    </div>
  );
}

function IntegrationConnectCard({
  integration,
  onAfterBind,
}: {
  integration: AssistantTurnPendingIntegration;
  onAfterBind?: () => void;
}) {
  const { composioToolkitsByProvider, connectIntegrationProvider } =
    useWorkspaceDesktop();
  const { selectedWorkspaceId } = useWorkspaceSelection();

  const provider = integration.provider_id.trim();
  const providerKey = provider.toLowerCase();
  const appId = integration.app_id.trim();
  const toolkit = composioToolkitsByProvider[providerKey];
  const displayName = toolkit?.name ?? provider;

  const [state, setState] = useState<CardState>({ kind: "loading" });
  const [busy, setBusy] = useState<"connecting" | "binding" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>("");

  const refresh = useCallback(async () => {
    if (!selectedWorkspaceId) {
      setState({ kind: "no_workspace" });
      return;
    }
    try {
      const [connectionsResp, bindingsResp] = await Promise.all([
        window.electronAPI.workspace.listIntegrationConnections(),
        window.electronAPI.workspace.listIntegrationBindings(selectedWorkspaceId),
      ]);
      const activeConnections = connectionsResp.connections.filter(
        (c) =>
          c.provider_id.toLowerCase() === providerKey && c.status === "active",
      );
      if (activeConnections.length === 0) {
        setState({ kind: "no_connection" });
        return;
      }
      const binding = bindingsResp.bindings.find(
        (b) =>
          b.target_type === "app" &&
          b.target_id === appId &&
          b.integration_key.toLowerCase() === providerKey,
      );
      if (binding) {
        const active = activeConnections.find(
          (c) => c.connection_id === binding.connection_id,
        );
        if (active) {
          setState({
            kind: "bound",
            activeConnection: active,
            otherActiveConnections: activeConnections.filter(
              (c) => c.connection_id !== active.connection_id,
            ),
          });
          return;
        }
      }
      setState({ kind: "needs_binding", connections: activeConnections });
    } catch (error) {
      setErrorMessage(normalizeErrorMessage(error));
      setState({ kind: "no_connection" });
    }
  }, [selectedWorkspaceId, providerKey, appId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleConnect() {
    if (!selectedWorkspaceId) return;
    setBusy("connecting");
    setErrorMessage("");
    try {
      await connectIntegrationProvider({ provider, appId });
      const { connections } =
        await window.electronAPI.workspace.listIntegrationConnections();
      const candidate = connections
        .filter(
          (c) =>
            c.provider_id.toLowerCase() === providerKey && c.status === "active",
        )
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
      if (candidate) {
        await window.electronAPI.workspace.upsertIntegrationBinding(
          selectedWorkspaceId,
          "app",
          appId,
          provider,
          { connection_id: candidate.connection_id },
        );
      }
      await refresh();
      onAfterBind?.();
    } catch (error) {
      setErrorMessage(normalizeErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function handleBind(connectionId: string) {
    if (!selectedWorkspaceId) return;
    setBusy("binding");
    setErrorMessage("");
    try {
      await window.electronAPI.workspace.upsertIntegrationBinding(
        selectedWorkspaceId,
        "app",
        appId,
        provider,
        { connection_id: connectionId },
      );
      await refresh();
      onAfterBind?.();
    } catch (error) {
      setErrorMessage(normalizeErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  if (state.kind === "loading") {
    return null;
  }
  if (state.kind === "no_workspace") {
    return null;
  }

  if (state.kind === "bound") {
    const otherConnections = state.otherActiveConnections;
    return (
      <div className="flex max-w-[380px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-emerald-600">
          <Check className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {displayName} · {accountLabelFor(state.activeConnection)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Bound to {appId}. Send your next message to use it.
          </div>
        </div>
        {otherConnections.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" disabled={busy !== null}>
                  <ChevronDown className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-[220px]">
              {otherConnections.map((conn) => (
                <DropdownMenuItem
                  key={conn.connection_id}
                  onClick={() => void handleBind(conn.connection_id)}
                >
                  Switch to {accountLabelFor(conn)}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => void handleConnect()}
                disabled={busy !== null}
              >
                <ExternalLink className="size-3.5" /> Add another account
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    );
  }

  if (state.kind === "needs_binding") {
    const connections = state.connections;
    return (
      <div className="flex max-w-[380px] flex-col gap-2 rounded-xl border border-border bg-card px-3 py-3">
        <div className="flex items-center gap-3">
          <div className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Plug className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              Pick a {displayName} account for {appId}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {connections.length === 1
                ? "One account is already authorized — bind it to this app."
                : `${connections.length} accounts are authorized. Pick which one this app should use.`}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {connections.length === 1 ? (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void handleBind(connections[0]!.connection_id)}
            >
              {busy === "binding" ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <Check size={13} />
              )}
              Use {accountLabelFor(connections[0]!)}
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="sm" disabled={busy !== null}>
                    {busy === "binding" ? (
                      <LoaderCircle size={13} className="animate-spin" />
                    ) : null}
                    Pick account
                    <ChevronDown size={13} />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-[220px]">
                {connections.map((conn) => (
                  <DropdownMenuItem
                    key={conn.connection_id}
                    onClick={() => void handleBind(conn.connection_id)}
                  >
                    {accountLabelFor(conn)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => void handleConnect()}
          >
            Add another
          </Button>
        </div>
        {errorMessage ? (
          <p className="text-xs text-destructive">{errorMessage}</p>
        ) : null}
      </div>
    );
  }

  // no_connection: zero authorized accounts for this provider
  return (
    <div className="flex max-w-[380px] flex-col gap-2 rounded-xl border border-border bg-card px-3 py-3">
      <div className="flex items-center gap-3">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <Plug className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            Connect {displayName}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {appId} needs your {displayName} account to work.
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => void handleConnect()}
        >
          {busy === "connecting" ? (
            <>
              <LoaderCircle size={13} className="animate-spin" />
              Waiting for authorization…
            </>
          ) : (
            <>
              <ExternalLink size={13} />
              Connect {displayName}
            </>
          )}
        </Button>
      </div>
      {errorMessage ? (
        <p className="text-xs text-destructive">{errorMessage}</p>
      ) : null}
    </div>
  );
}

function accountLabelFor(connection: IntegrationConnectionPayload): string {
  const candidates = [
    connection.account_handle,
    connection.account_email,
    connection.account_label,
    connection.account_external_id,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return connection.connection_id.slice(0, 8);
}
