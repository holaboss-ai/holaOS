import { Check, LoaderCircle, Plug, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { rebindWorkspaceAppsForProvider } from "@/lib/rebindWorkspaceAppsForProvider";
import { useIntegrationConnect } from "@/lib/useIntegrationConnect";

export interface AssistantTurnProposedIntegration {
  toolkit_slug: string;
  tier?: "hero" | "supported";
  category?: string;
  reason?: string | null;
}

export function AssistantTurnIntegrationProposals({
  proposals,
  workspaceId,
  onAfterConnect,
}: {
  proposals: AssistantTurnProposedIntegration[];
  workspaceId: string | null;
  onAfterConnect?: (toolkitSlug: string) => void;
}) {
  if (proposals.length === 0) return null;
  const seen = new Set<string>();
  const unique = proposals.filter((p) => {
    const key = p.toolkit_slug.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div className="mt-3 flex flex-col gap-2">
      {unique.map((proposal) => (
        <IntegrationProposalCard
          key={proposal.toolkit_slug}
          onAfterConnect={onAfterConnect}
          proposal={proposal}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  );
}

function IntegrationProposalCard({
  proposal,
  workspaceId,
  onAfterConnect,
}: {
  proposal: AssistantTurnProposedIntegration;
  workspaceId: string | null;
  onAfterConnect?: (toolkitSlug: string) => void;
}) {
  const { composioToolkitsByProvider } = useWorkspaceDesktop();
  const slug = proposal.toolkit_slug.trim().toLowerCase();
  const toolkit = composioToolkitsByProvider[slug];
  const displayName = toolkit?.name ?? proposal.toolkit_slug;
  const logo = toolkit?.logo ?? `https://logos.composio.dev/api/${slug}`;

  const { status, connect, cancel } = useIntegrationConnect({
    onDone: async (connectionId) => {
      if (workspaceId) {
        await rebindWorkspaceAppsForProvider({
          workspaceId,
          provider: slug,
          connectionId,
        });
      }
    },
  });
  // Cancelled state maps to idle for the UI — the user actively backed
  // out, no need to render a "Cancelled" badge.
  const phase = status.kind === "cancelled" ? "idle" : status.kind;
  const errorMessage =
    status.kind === "error"
      ? status.error instanceof Error
        ? status.error.message
        : "Connection failed."
      : null;

  // Local `phase` resets to "idle" on every mount, so the post-connect "done"
  // confirmation would vanish on app restart. Source the connected-state from
  // the live integration_connections store instead — the table is the single
  // truth, and the card stays consistent across restarts, sessions, and
  // out-of-band disconnects.
  const [alreadyConnected, setAlreadyConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { connections } =
          await window.electronAPI.workspace.listIntegrationConnections();
        if (cancelled) return;
        const active = connections.some(
          (c) =>
            c.provider_id.trim().toLowerCase() === slug &&
            c.status === "active",
        );
        setAlreadyConnected(active);
      } catch {
        if (!cancelled) setAlreadyConnected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const handleConnect = async () => {
    if (!workspaceId) return;
    const outcome = await connect({ provider: slug, accountLabel: displayName });
    if (outcome.kind === "done") {
      onAfterConnect?.(slug);
    }
  };

  const handleCancel = () => {
    cancel();
  };

  // Wait for the readiness check before rendering, otherwise the Connect
  // button flashes before flipping to the connected state.
  if (alreadyConnected === null) return null;

  // After a failed reconnect attempt, fall through to the Connect card so
  // the error message is visible — the green card has nowhere to put it.
  if ((phase === "done" || alreadyConnected) && phase !== "error") {
    const reconnecting = phase === "connecting";
    return (
      <button
        type="button"
        // Always clickable: our local `integration_connections.status` lags
        // behind real-world auth (tokens get revoked externally, scopes
        // change, refresh quietly fails) — if the agent told the user to
        // re-authorize, the green "connected" badge can be lying, and we
        // need to give them a way out from this card itself.
        onClick={() => void handleConnect()}
        disabled={reconnecting || !workspaceId}
        className="group/proposal flex max-w-[420px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/40 disabled:cursor-default disabled:opacity-70"
      >
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-emerald-600">
          {reconnecting ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {displayName} connected
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {reconnecting
              ? `Re-authorizing ${displayName}…`
              : `Send your next message — the agent can now use ${displayName}.`}
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover/proposal:opacity-100">
          Reconnect
        </span>
      </button>
    );
  }

  return (
    <div className="flex max-w-[420px] flex-col gap-2 rounded-xl border border-border bg-card px-3 py-2.5 text-sm">
      <div className="flex items-start gap-3">
        <div className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background">
          {logo ? (
            <img
              alt=""
              className="size-full object-contain p-0.5"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
              referrerPolicy="no-referrer"
              src={logo}
            />
          ) : (
            <Plug className="size-3.5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            Connect {displayName}
          </div>
          {proposal.reason ? (
            <div className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {proposal.reason}
            </div>
          ) : (
            <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Authorize once. The agent will use it in this workspace.
            </div>
          )}
        </div>
        {phase === "connecting" ? (
          <div className="flex shrink-0 items-center gap-1">
            <div className="inline-flex h-7 items-center gap-1 px-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              Connecting…
            </div>
            <Button
              aria-label="Cancel connection"
              className="h-7 w-7 p-0"
              onClick={handleCancel}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            className="h-7 px-3 text-xs"
            disabled={!workspaceId}
            onClick={() => void handleConnect()}
            size="sm"
            type="button"
            variant="default"
          >
            Connect
          </Button>
        )}
      </div>
      {errorMessage ? (
        <div className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
