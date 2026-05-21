import { Check, LoaderCircle, Plug } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

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
  const { composioToolkitsByProvider, connectIntegrationProvider } =
    useWorkspaceDesktop();
  const slug = proposal.toolkit_slug.trim().toLowerCase();
  const toolkit = composioToolkitsByProvider[slug];
  const displayName = toolkit?.name ?? proposal.toolkit_slug;
  const logo = toolkit?.logo ?? `https://logos.composio.dev/api/${slug}`;

  const [phase, setPhase] = useState<"idle" | "connecting" | "done" | "error">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleConnect = async () => {
    if (!workspaceId) {
      setErrorMessage("Open a workspace before connecting.");
      setPhase("error");
      return;
    }
    setPhase("connecting");
    setErrorMessage(null);
    try {
      await connectIntegrationProvider({
        provider: slug,
        accountLabel: `${displayName} (Managed)`,
      });
      setPhase("done");
      onAfterConnect?.(slug);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection failed.";
      setErrorMessage(msg);
      setPhase("error");
    }
  };

  if (phase === "done") {
    return (
      <div className="flex max-w-[420px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-emerald-600">
          <Check className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {displayName} connected
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Send your next message — the agent can now use {displayName}.
          </div>
        </div>
      </div>
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
        <Button
          className="h-7 px-3 text-xs"
          disabled={phase === "connecting" || !workspaceId}
          onClick={() => void handleConnect()}
          size="sm"
          type="button"
          variant="default"
        >
          {phase === "connecting" ? (
            <>
              <LoaderCircle className="mr-1 size-3 animate-spin" />
              Connecting…
            </>
          ) : (
            "Connect"
          )}
        </Button>
      </div>
      {errorMessage ? (
        <div className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {errorMessage}
        </div>
      ) : null}
    </div>
  );
}
