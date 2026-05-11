import { useEffect, useState } from "react";
import { Check, ExternalLink, LoaderCircle, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

export type AssistantTurnPendingIntegration = {
  app_id: string;
  provider_id: string;
  credential_source?: string | null;
};

type ConnectionState = "checking" | "active" | "needs_connect" | "connecting" | "connected" | "error";

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
}: {
  pendingIntegrations: AssistantTurnPendingIntegration[];
}) {
  if (pendingIntegrations.length === 0) {
    return null;
  }
  // Dedupe by provider — multiple installs of same provider in one turn
  // should still only show one Connect card.
  const seen = new Set<string>();
  const unique = pendingIntegrations.filter((entry) => {
    const key = entry.provider_id.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div className="mt-3 flex flex-col gap-2">
      {unique.map((entry) => (
        <IntegrationConnectCard key={entry.provider_id} integration={entry} />
      ))}
    </div>
  );
}

function IntegrationConnectCard({
  integration,
}: {
  integration: AssistantTurnPendingIntegration;
}) {
  const { composioToolkitsByProvider, connectIntegrationProvider } =
    useWorkspaceDesktop();
  const [state, setState] = useState<ConnectionState>("checking");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const provider = integration.provider_id.trim();
  const providerKey = provider.toLowerCase();
  const toolkit = composioToolkitsByProvider[providerKey];
  const displayName = toolkit?.name ?? provider;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { connections } =
          await window.electronAPI.workspace.listIntegrationConnections();
        if (cancelled) return;
        const hasActive = connections.some(
          (c) =>
            c.provider_id.toLowerCase() === providerKey &&
            c.status === "active",
        );
        setState(hasActive ? "active" : "needs_connect");
      } catch (error) {
        if (cancelled) return;
        // If we can't check, assume needs connect — better to show a button
        // the user can ignore than to silently swallow.
        setState("needs_connect");
        setErrorMessage(normalizeErrorMessage(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providerKey]);

  if (state === "checking") {
    return null;
  }

  // When the user already has an active connection for this provider, render
  // a small "Already connected" confirmation rather than hiding silently.
  // The agent told the user to click Connect; if no card appears at all it
  // looks broken. This makes the state explicit.
  if (state === "active") {
    return (
      <div className="flex max-w-[380px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-emerald-600">
          <Check className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {displayName} already connected
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Send your next message and the agent will use it.
          </div>
        </div>
      </div>
    );
  }

  async function handleConnect() {
    setState("connecting");
    setErrorMessage("");
    try {
      await connectIntegrationProvider({
        provider,
        appId: integration.app_id,
      });
      setState("connected");
    } catch (error) {
      setState("needs_connect");
      setErrorMessage(normalizeErrorMessage(error));
    }
  }

  if (state === "connected") {
    return (
      <div className="flex max-w-[380px] items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground">
        <div className="grid size-7 shrink-0 place-items-center rounded-md bg-emerald-500/15 text-emerald-600">
          <Check className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {displayName} connected
          </div>
          <div className="truncate text-xs text-muted-foreground">
            Send your next message to continue.
          </div>
        </div>
      </div>
    );
  }

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
            {integration.app_id} needs your {displayName} account to work.
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end">
        <Button
          size="sm"
          disabled={state === "connecting"}
          onClick={() => void handleConnect()}
        >
          {state === "connecting" ? (
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
      {errorMessage && state !== "connecting" ? (
        <p className="text-xs text-destructive">{errorMessage}</p>
      ) : null}
    </div>
  );
}
