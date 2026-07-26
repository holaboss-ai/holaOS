import { CircleAlert, Loader2, RotateCcw } from "@/components/ui/icons";

import { Button } from "@/components/ui/button";

import { ModelCombobox } from "./Composer/ModelCombobox";
import type { ChatModelOption, ChatModelOptionGroup } from "./types";

export type ModelErrorKind = "upstream_5xx" | "proxy_not_configured";

export interface ParsedModelError {
  kind: ModelErrorKind;
  failedModelToken: string | null;
  statusCode: number | null;
}

// "openai/gpt-5.5: 502 error code: 502" — proxy passes upstream status through.
const PROXY_5XX_PATTERN =
  /([a-z0-9_-]+\/[\w./-]+):\s*(5\d{2})\s+error\s+code:\s*(5\d{2})/i;

export function parseModelError(text: string): ParsedModelError | null {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(PROXY_5XX_PATTERN);
  if (match) {
    const statusFromCode = Number.parseInt(match[3] ?? "", 10);
    const statusFromHeader = Number.parseInt(match[2] ?? "", 10);
    const statusCode =
      Number.isFinite(statusFromCode) && statusFromCode >= 500
        ? statusFromCode
        : Number.isFinite(statusFromHeader)
          ? statusFromHeader
          : null;
    return {
      kind: "upstream_5xx",
      failedModelToken: match[1] ?? null,
      statusCode,
    };
  }
  if (trimmed.includes("Sandbox model proxy is not configured")) {
    return {
      kind: "proxy_not_configured",
      failedModelToken: null,
      statusCode: null,
    };
  }
  return null;
}

interface ModelErrorRecoveryCardProps {
  error: ParsedModelError;
  selectedModel: string;
  selectedModelLabel: string;
  fallbackModelToken: string | null;
  fallbackModelLabel: string | null;
  runtimeDefaultModelLabel: string;
  runtimeDefaultModelAvailable: boolean;
  modelOptions: ChatModelOption[];
  modelOptionGroups: ChatModelOptionGroup[];
  onModelChange: (modelToken: string) => void;
  onSwitchAndRetry: (modelToken: string) => void;
  isRetrying: boolean;
  retryDisabled: boolean;
  retryDisabledReason: string | null;
  onDismiss: () => void;
}

export function ModelErrorRecoveryCard({
  error,
  selectedModel,
  selectedModelLabel,
  fallbackModelToken,
  fallbackModelLabel,
  runtimeDefaultModelLabel,
  runtimeDefaultModelAvailable,
  modelOptions,
  modelOptionGroups,
  onModelChange,
  onSwitchAndRetry,
  isRetrying,
  retryDisabled,
  retryDisabledReason,
  onDismiss,
}: ModelErrorRecoveryCardProps) {
  const failedLabel = error.failedModelToken ?? "The selected model";
  const headline =
    error.kind === "upstream_5xx"
      ? `${failedLabel} is temporarily unavailable`
      : "Model proxy credentials didn't propagate";
  const subline =
    error.kind === "upstream_5xx"
      ? `Upstream returned ${error.statusCode ?? "5xx"}. Switching providers usually clears it on the next run.`
      : "This usually clears by switching to a different provider — the retry path didn't carry the proxy credentials.";

  const canQuickSwitch =
    Boolean(fallbackModelToken) && fallbackModelToken !== selectedModel;

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-warning/40 bg-warning/[0.04] px-4 py-3">
      <div className="flex items-start gap-2.5">
        <CircleAlert
          className="mt-0.5 size-4 shrink-0 text-warning"
          strokeWidth={2}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{headline}</div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {subline}
          </div>
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mt-1 -mr-1 text-muted-foreground"
        >
          ×
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {canQuickSwitch && fallbackModelToken ? (
          <Button
            type="button"
            size="sm"
            className="rounded-full"
            disabled={isRetrying || retryDisabled}
            title={retryDisabled ? retryDisabledReason ?? undefined : undefined}
            onClick={() => onSwitchAndRetry(fallbackModelToken)}
          >
            {isRetrying ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
            Switch to {fallbackModelLabel ?? fallbackModelToken} & retry
          </Button>
        ) : null}

        <div className="min-w-0">
          <ModelCombobox
            selectedModel={selectedModel}
            selectedModelLabel={selectedModelLabel}
            runtimeDefaultModelLabel={runtimeDefaultModelLabel}
            runtimeDefaultModelAvailable={runtimeDefaultModelAvailable}
            modelOptions={modelOptions}
            modelOptionGroups={modelOptionGroups}
            disabled={isRetrying}
            compact
            onModelChange={onModelChange}
          />
        </div>
      </div>

      {retryDisabledReason && retryDisabled ? (
        <div className="text-[11px] leading-4 text-muted-foreground">
          {retryDisabledReason}
        </div>
      ) : null}
    </div>
  );
}
