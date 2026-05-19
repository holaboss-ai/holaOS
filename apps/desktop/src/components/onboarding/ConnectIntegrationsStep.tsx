import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { providerDisplayName, providerIcon } from "./constants";
import { WorkspaceWizardLayout } from "./WorkspaceWizardLayout";

interface ConnectIntegrationsStepProps {
  stepIndex: number;
  stepTotal: number;
  pendingIntegrations: ResolveTemplateIntegrationsResult;
  connectingProvider: string | null;
  connectStatus: string;
  onConnect: (provider: string) => void;
  onBack: () => void;
}

export function ConnectIntegrationsStep({
  stepIndex,
  stepTotal,
  pendingIntegrations,
  connectingProvider,
  connectStatus,
  onConnect,
  onBack,
}: ConnectIntegrationsStepProps) {
  const logos = pendingIntegrations.provider_logos ?? {};
  const allConnected = pendingIntegrations.missing_providers.length === 0;

  return (
    <WorkspaceWizardLayout
      description="The selected template needs access to these accounts. Connect them to continue."
      primary={{
        label: "Continue",
        onClick: onBack,
        disabled: !allConnected,
      }}
      secondary={{ label: "Back", onClick: onBack }}
      stepIndex={stepIndex}
      stepTotal={stepTotal}
      title="Connect your accounts"
      width="md"
    >
      <div className="space-y-1.5">
        {pendingIntegrations.missing_providers.map((provider) => (
          <ProviderRow
            connected={false}
            connecting={connectingProvider === provider}
            disabled={connectingProvider !== null}
            key={provider}
            logoUrl={logos[provider]}
            onAction={() => onConnect(provider)}
            provider={provider}
          />
        ))}
        {pendingIntegrations.connected_providers.map((provider) => (
          <ProviderRow
            connected
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
        <p className="mt-4 text-xs text-muted-foreground">{connectStatus}</p>
      ) : null}
    </WorkspaceWizardLayout>
  );
}

function ProviderRow({
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
    <div className="flex items-center gap-3 rounded-lg bg-fg-2 px-3.5 py-3 shadow-2xs">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background shadow-2xs">
        {logoUrl ? (
          <img
            alt=""
            className="size-5 rounded-sm"
            height={20}
            src={logoUrl}
            width={20}
          />
        ) : (
          providerIcon(provider, 20)
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
