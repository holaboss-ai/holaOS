import { Check, ChevronDown, ExternalLink, LoaderCircle, Plug, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIntegrationBinding } from "@/lib/useIntegrationBinding";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

export type AssistantTurnPendingIntegration = {
  app_id: string;
  provider_id: string;
  credential_source?: string | null;
  // See PendingIntegrationWhoami in electron.d.ts. Forwarded verbatim to
  // Hono via composioConnect so the per-toolkit profile fetch doesn't need
  // a Hono-side constant.
  whoami?: PendingIntegrationWhoami | null;
};

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
  const { composioToolkitsByProvider } = useWorkspaceDesktop();

  const provider = integration.provider_id.trim();
  const providerKey = provider.toLowerCase();
  const appId = integration.app_id.trim();
  const toolkit = composioToolkitsByProvider[providerKey];
  const displayName = toolkit?.name ?? provider;

  const {
    state,
    busy,
    errorMessage,
    connect: handleConnect,
    bind: handleBind,
    cancel: handleCancelConnect,
  } = useIntegrationBinding({
    appId,
    provider,
    whoami: integration.whoami ?? null,
    onAfterBind,
  });

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
            {displayName} · {accountLabelFor(state.activeConnection, displayName)}
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
                  Switch to {accountLabelFor(conn, displayName)}
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
    const connections = state.candidates;
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
              Use {accountLabelFor(connections[0]!, displayName)}
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
                    {accountLabelFor(conn, displayName)}
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
      <div className="flex items-center justify-end gap-2">
        {busy === "connecting" ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <LoaderCircle size={13} className="animate-spin" />
              Waiting for authorization…
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => handleCancelConnect()}
              title="Cancel connection"
              aria-label="Cancel connection"
            >
              <X size={13} />
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() => void handleConnect()}
          >
            <ExternalLink size={13} />
            Connect {displayName}
          </Button>
        )}
      </div>
      {errorMessage ? (
        <p className="text-xs text-destructive">{errorMessage}</p>
      ) : null}
    </div>
  );
}

// Toolkits without a whoami-resolved handle/email/label used to render as a
// raw connection-id slice ("a1b2c3d4"). Now we fall back to the toolkit's
// display name + the last 6 chars of the id, so e.g. "Discord · a1b2c3" —
// indistinct against multiple accounts of the same toolkit, but at least
// names the platform.
function accountLabelFor(
  connection: IntegrationConnectionPayload,
  toolkitDisplayName: string,
): string {
  const candidates = [
    connection.account_handle,
    connection.account_email,
    connection.account_label,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const id = connection.connection_id;
  const suffix = id.length > 6 ? id.slice(-6) : id;
  const name = toolkitDisplayName.trim();
  return name ? `${name} · ${suffix}` : suffix;
}
