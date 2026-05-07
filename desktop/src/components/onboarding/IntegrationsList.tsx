import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { providerDisplayName, providerIcon } from "./constants";

interface IntegrationsListProps {
  pendingIntegrations: ResolveTemplateIntegrationsResult | null;
  isResolvingIntegrations: boolean;
  connectingProvider: string | null;
  connectStatus: string;
  onConnect: (provider: string) => void;
}

export function IntegrationsList({
  pendingIntegrations,
  isResolvingIntegrations,
  connectingProvider,
  connectStatus,
  onConnect,
}: IntegrationsListProps) {
  if (isResolvingIntegrations) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Checking integrations…
      </div>
    );
  }

  if (!pendingIntegrations || pendingIntegrations.requirements.length === 0) {
    return null;
  }

  const logos = pendingIntegrations.provider_logos ?? {};

  return (
    <div>
      <div className="mb-2 text-sm font-medium text-foreground">
        Integrations
      </div>
      <div className="grid gap-1.5">
        {pendingIntegrations.connected_providers.map((provider) => (
          <IntegrationRow
            connected
            connecting={connectingProvider === provider}
            disabled={connectingProvider !== null}
            key={provider}
            logoUrl={logos[provider]}
            onAction={() => onConnect(provider)}
            provider={provider}
          />
        ))}
        {pendingIntegrations.missing_providers.map((provider) => (
          <IntegrationRow
            connected={false}
            connecting={connectingProvider === provider}
            disabled={connectingProvider !== null}
            key={provider}
            logoUrl={logos[provider]}
            onAction={() => onConnect(provider)}
            provider={provider}
          />
        ))}
      </div>
      {connectStatus ? (
        <p className="mt-2 text-xs text-muted-foreground">{connectStatus}</p>
      ) : null}
    </div>
  );
}

function IntegrationRow({
  provider,
  logoUrl,
  connected,
  connecting,
  disabled,
  onAction,
}: {
  provider: string;
  logoUrl?: string;
  connected: boolean;
  connecting: boolean;
  disabled: boolean;
  onAction: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-fg-2 px-3 py-2 shadow-subtle-xs">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background shadow-subtle-xs">
        {logoUrl ? (
          <img
            alt=""
            className="size-4 rounded-sm"
            height={16}
            src={logoUrl}
            width={16}
          />
        ) : (
          providerIcon(provider, 16)
        )}
      </div>
      <span className="flex-1 truncate text-sm font-medium text-foreground">
        {providerDisplayName(provider)}
      </span>
      {connected ? (
        <div className="flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot variant="success" />
            Connected
          </span>
          <Button
            disabled={disabled}
            onClick={onAction}
            size="xs"
            type="button"
            variant="link"
          >
            {connecting ? "Reconnecting…" : "Reconnect"}
          </Button>
        </div>
      ) : (
        <Button
          className="shrink-0"
          disabled={disabled}
          onClick={onAction}
          size="sm"
          type="button"
          variant="bordered"
        >
          {connecting ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              Connecting…
            </>
          ) : (
            "Connect"
          )}
        </Button>
      )}
    </div>
  );
}
