import { Check, ChevronRight, CircleAlert, RotateCw } from "lucide-react";
import { useState } from "react";
import { OAuthWaitIndicator } from "@/components/integration/OAuthWaitIndicator";
import {
  type IntegrationErrorCopy,
  resolveIntegrationError,
} from "@/lib/integrationErrorMessages";
import { toolkitDisplayName } from "@/lib/toolkitDisplay";
import { useIntegrationConnect } from "@/lib/useIntegrationConnect";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { rebindWorkspaceAppsForProvider } from "@/lib/rebindWorkspaceAppsForProvider";

export function HistoryRestoreSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading conversation"
      className="absolute inset-0 z-30 overflow-hidden bg-card px-6 pb-5 pt-5"
    >
      <div className="flex h-full flex-col">
        <div className="animate-pulse space-y-6">
          <div className="flex items-start justify-between gap-6">
            <div className="h-5 w-28 rounded-md bg-muted" />
            <div className="h-11 w-52 rounded-2xl bg-muted" />
          </div>
          <div className="space-y-3 px-3">
            <div className="flex items-center gap-2">
              <div className="h-5 w-6 rounded-md bg-muted" />
              <div className="h-5 w-14 rounded-md bg-muted" />
            </div>
            <div className="h-5 w-full rounded-md bg-muted" />
            <div className="h-5 w-full rounded-md bg-muted" />
            <div className="h-5 w-[42%] rounded-md bg-muted" />
          </div>
        </div>

        <div className="mt-auto">
          <div className="rounded-2xl border border-border bg-muted p-4">
            <div className="animate-pulse space-y-3">
              <div className="h-6 w-full rounded-lg bg-muted" />
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <div className="size-8 rounded-full bg-muted" />
                  <div className="size-8 rounded-full bg-muted" />
                </div>
                <div className="flex items-center gap-2">
                  <div className="size-8 rounded-full bg-muted" />
                  <div className="size-8 rounded-full bg-muted" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ParsedIntegrationError {
  /** Resolved from the structured marker or legacy regex; "" when unknown. */
  slug: string;
  /** "connection_expired" | "rate_limited" | "tool_failed" | "unknown" etc. */
  code: string;
}

/**
 * Top-level error presentation for a TraceStep with status === "error".
 * Prefers IntegrationErrorBanner (typed actionable copy + inline reconnect)
 * when the error text identifies an integration; falls back to a generic
 * failure shell with a "Show technical details" disclosure otherwise.
 *
 * Suppresses the legacy collapsed details box in TraceStepEntry so the raw
 * JSON dump doesn't appear twice when expanded.
 */
export function TraceStepErrorPresentation({
  details,
}: {
  details: string[];
}) {
  const errorText = details.join(" ");
  const parsed = parseStructuredMarker(errorText) ?? matchLegacyPattern(errorText);
  if (parsed) {
    return <IntegrationErrorBannerBody errorText={errorText} parsed={parsed} />;
  }
  return <GenericToolFailureBanner details={details} />;
}

// Kept for backward compat — some non-status callers still render the
// pure banner. Returns null when the text isn't an integration error.
export function IntegrationErrorBanner({ details }: { details: string[] }) {
  const errorText = details.join(" ");
  const parsed = parseStructuredMarker(errorText) ?? matchLegacyPattern(errorText);
  if (!parsed) return null;
  return <IntegrationErrorBannerBody errorText={errorText} parsed={parsed} />;
}

export function hasIntegrationMarker(details: string[]): boolean {
  const errorText = details.join(" ");
  return Boolean(parseStructuredMarker(errorText) ?? matchLegacyPattern(errorText));
}

function GenericToolFailureBanner({ details }: { details: string[] }) {
  const summary = (details[0] ?? "Tool failed").trim();
  const rawDetails = details.slice(1).join("\n").trim();
  return (
    <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/[0.04] px-3 py-2.5">
      <div className="flex items-start gap-2.5 text-xs">
        <CircleAlert
          className="mt-px size-3.5 shrink-0 text-destructive"
          strokeWidth={2}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="font-medium leading-tight text-foreground">
            Tool failed
          </div>
          {summary ? (
            <div className="line-clamp-2 leading-relaxed text-muted-foreground">
              {summary}
            </div>
          ) : null}
        </div>
      </div>
      {rawDetails ? (
        <details className="group mt-2 ml-[26px]">
          <summary className="flex w-fit cursor-pointer select-none items-center gap-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-muted-foreground">
            <ChevronRight
              className="size-2.5 transition-transform group-open:rotate-90"
              strokeWidth={2.5}
            />
            Technical details
          </summary>
          <div className="mt-1.5 max-h-40 overflow-auto rounded-md border border-border/60 bg-muted/40 px-2.5 py-1.5 font-mono text-[10.5px] leading-[1.5] whitespace-pre-wrap break-words text-muted-foreground">
            {rawDetails}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function IntegrationErrorBannerBody({
  errorText,
  parsed,
}: {
  errorText: string;
  parsed: ParsedIntegrationError;
}) {
  const displayName = toolkitDisplayName(parsed.slug);
  const copy = resolveIntegrationError({
    provider: displayName,
    code: parsed.code === "unknown" ? undefined : parsed.code,
    error: errorText,
  });

  const { selectedWorkspaceId } = useWorkspaceSelection();
  const [reconnectError, setReconnectError] = useState<IntegrationErrorCopy | null>(
    null,
  );
  const { status, connect, cancel, reset } = useIntegrationConnect({
    onDone: async (connectionId) => {
      // OAuth alone isn't enough: workspace apps capture HOLABOSS_APP_GRANT
      // at boot pointing at the OLD (now-expired) connection. The agent's
      // direct Composio path is restarted automatically via
      // onConnectionActive, but per-app bindings are NOT — apps that were
      // bound to the previous connection keep using a dead grant until
      // someone rebinds them. Mirror what useIntegrationBinding does for
      // every app binding in this workspace that matches the failing slug.
      if (selectedWorkspaceId && parsed.slug) {
        await rebindWorkspaceAppsForProvider({
          workspaceId: selectedWorkspaceId,
          provider: parsed.slug,
          connectionId,
        });
      }
    },
  });
  // Connecting / done flow straight through. Error only renders when we've
  // resolved a user-facing copy block — raw cancel / silent errors collapse
  // back to idle so the row doesn't hold an empty error slot.
  const phase: "idle" | "connecting" | "done" | "error" =
    status.kind === "connecting"
      ? "connecting"
      : status.kind === "done"
        ? "done"
        : reconnectError
          ? "error"
          : "idle";

  if (copy.action === "silent") return null;

  const canReconnect = copy.action === "reconnect" && Boolean(parsed.slug);

  const startReconnect = async () => {
    if (!parsed.slug) return;
    setReconnectError(null);
    const outcome = await connect({
      provider: parsed.slug,
      accountLabel: displayName,
    });
    if (outcome.kind === "error") {
      const errorCopy = resolveIntegrationError({
        provider: displayName,
        error: outcome.error,
      });
      if (errorCopy.action === "silent") {
        reset();
        return;
      }
      setReconnectError(errorCopy);
    }
  };

  const cancelReconnect = () => {
    cancel();
  };

  if (phase === "done") {
    return (
      <div className="mt-2 flex items-center gap-2.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
        <span className="grid size-4 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
        <span className="text-foreground">
          <span className="font-medium">{displayName}</span> reconnected — send
          your next message to retry.
        </span>
      </div>
    );
  }

  if (phase === "connecting") {
    return (
      <div className="mt-2 rounded-lg border border-border bg-card/60 px-3 py-2.5">
        <OAuthWaitIndicator
          compact
          displayName={displayName}
          onCancel={cancelReconnect}
        />
      </div>
    );
  }

  if (phase === "error" && reconnectError) {
    return (
      <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/[0.04] px-3 py-2.5 text-xs">
        <CircleAlert
          className="mt-px size-3.5 shrink-0 text-destructive"
          strokeWidth={2}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="font-medium leading-tight text-foreground">
            {reconnectError.headline}
          </div>
          {reconnectError.detail ? (
            <div className="leading-relaxed text-muted-foreground">
              {reconnectError.detail}
            </div>
          ) : null}
        </div>
        <button
          className="shrink-0 self-center inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
          onClick={() => void startReconnect()}
          type="button"
        >
          <RotateCw className="size-3" strokeWidth={2} />
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2.5 text-xs">
      <CircleAlert
        className="mt-px size-3.5 shrink-0 text-warning"
        strokeWidth={2}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-medium leading-tight text-foreground">
          {copy.headline}
        </div>
        {copy.detail ? (
          <div className="leading-relaxed text-muted-foreground">
            {copy.detail}
          </div>
        ) : null}
      </div>
      {canReconnect ? (
        <button
          className="shrink-0 self-center rounded-md px-2 py-0.5 text-xs font-medium text-warning transition-colors hover:bg-warning/10"
          onClick={() => void startReconnect()}
          type="button"
        >
          Reconnect
        </button>
      ) : null}
    </div>
  );
}

// Format emitted by composio-mcp-host.ts: [composio_error:CODE:SLUG]
function parseStructuredMarker(text: string): ParsedIntegrationError | null {
  const match = /\[composio_error:([a-z_]+)(?::([a-z0-9_-]+))?\]/i.exec(text);
  if (!match) return null;
  const code = (match[1] ?? "").toLowerCase();
  const slug = (match[2] ?? "").toLowerCase();
  return { code, slug };
}

// Fallback regex for non-Composio integration failures (legacy backend errors,
// app crashes that name the provider, etc.).
function matchLegacyPattern(text: string): ParsedIntegrationError | null {
  const patterns: Array<{ pattern: RegExp; slug: string }> = [
    { pattern: /no\s+google\s+token/i, slug: "google" },
    { pattern: /no\s+gmail\s+token/i, slug: "gmail" },
    { pattern: /no\s+github\s+token/i, slug: "github" },
    { pattern: /no\s+reddit\s+token/i, slug: "reddit" },
    { pattern: /no\s+twitter\s+token/i, slug: "twitter" },
    { pattern: /no\s+linkedin\s+token/i, slug: "linkedin" },
    { pattern: /PLATFORM_INTEGRATION_TOKEN/i, slug: "" },
    { pattern: /integration.*not.*connected/i, slug: "" },
    { pattern: /integration.*not.*bound/i, slug: "" },
    { pattern: /connect\s+via\s+(settings|integrations)/i, slug: "" },
  ];
  for (const { pattern, slug } of patterns) {
    if (pattern.test(text)) {
      return { code: "connection_not_authorized", slug };
    }
  }
  return null;
}
