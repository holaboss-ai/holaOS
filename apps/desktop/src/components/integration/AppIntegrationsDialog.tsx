import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Link2,
  Loader2,
  Plus,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect } from "react";
import { IntegrationLogo } from "@/components/integration/IntegrationLogo";
import { overlayOpenCountAtom } from "@/components/layout/shell/overlay-presence";
import { Button } from "@/components/ui/button";
import {
  type IntegrationBindingVerifyOutcome,
  useIntegrationBinding,
} from "@/lib/useIntegrationBinding";
import { cn } from "@/lib/utils";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

/**
 * Modal-style integration manager for a workspace app — opened from the
 * sidebar's app row dropdown when an app declares multiple integrations.
 *
 * Why a Dialog instead of a nested submenu: the workspace browser pane
 * (right half of NewShell) is an independent renderer layer that occludes
 * popover content positioned over it. The previous `DropdownMenuSub` for
 * each provider rendered fine in the DOM but every click landed on the
 * webview instead of the menu item. Dialog + backdrop sits above the
 * webview layer because it's portaled to document.body with an explicit
 * z-index and full-viewport backdrop.
 */
export interface AppIntegrationsDialogIntegration {
  provider: string;
  required: boolean;
  whoami: PendingIntegrationWhoami | null;
}

export function AppIntegrationsDialog({
  open,
  onOpenChange,
  appId,
  appName,
  integrations,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: string;
  appName: string;
  integrations: AppIntegrationsDialogIntegration[];
}) {
  // Bump the shell overlay counter while the dialog is open so
  // BrowserPane detaches its native BrowserView (collapses to 0x0). The
  // OS-level webview composites above the renderer and would otherwise
  // paint over the dialog, swallowing clicks — same pattern as
  // SuspendingPopover / SuspendingDropdownMenu wrappers.
  const setOverlayCount = useSetAtom(overlayOpenCountAtom);
  useEffect(() => {
    if (!open) return;
    setOverlayCount((c) => c + 1);
    return () => {
      setOverlayCount((c) => Math.max(0, c - 1));
    };
  }, [open, setOverlayCount]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          style={{
            animationDuration: "var(--duration-snappy)",
            animationTimingFunction: "var(--ease-out-expo)",
          }}
        />
        <DialogPrimitive.Popup
          className="fixed top-[20%] left-1/2 z-[100] w-[480px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          style={{
            animationDuration: "var(--duration-base)",
            animationTimingFunction: "var(--ease-out-expo)",
          }}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-sm font-medium text-foreground">
                {appName} integrations
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-xs text-muted-foreground">
                {integrations.length} provider
                {integrations.length === 1 ? "" : "s"} declared by this app
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              className="grid size-7 shrink-0 place-items-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              aria-label="Close"
            >
              <X className="size-3.5" />
            </DialogPrimitive.Close>
          </div>
          <div className="flex flex-col divide-y divide-border">
            {integrations.map((integration) => (
              <ProviderRow
                key={integration.provider}
                appId={appId}
                provider={integration.provider}
                whoami={integration.whoami}
                required={integration.required}
              />
            ))}
          </div>
          <div className="border-t border-border bg-foreground/[0.02] px-4 py-2.5 text-[11px] text-muted-foreground">
            Manage all accounts in Settings → Integrations.
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function ProviderRow({
  appId,
  provider,
  whoami,
  required,
}: {
  appId: string;
  provider: string;
  whoami: PendingIntegrationWhoami | null;
  required: boolean;
}) {
  const { composioToolkitsByProvider } = useWorkspaceDesktop();
  const toolkit = composioToolkitsByProvider[provider.toLowerCase()];
  const providerName = toolkit?.name ?? provider;
  const overrideLogo = toolkit?.logo ?? null;

  const { state, busy, errorMessage, lastVerify, connect, bind, verify, cancel } =
    useIntegrationBinding({
      appId,
      provider,
      whoami,
      considerWorkspaceDefault: true,
    });

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <IntegrationLogo
        alt={providerName}
        overrideUrl={overrideLogo}
        size="md"
        slug={provider}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {providerName}
          </span>
          {required ? (
            <span className="rounded-sm bg-foreground/[0.06] px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-foreground/55">
              required
            </span>
          ) : null}
        </div>
        <ProviderStatusLine
          state={state}
          busy={busy}
          providerName={providerName}
          lastVerify={lastVerify}
        />
        {errorMessage ? (
          <div className="mt-1 text-xs text-destructive">{errorMessage}</div>
        ) : null}
      </div>
      <ProviderActions
        state={state}
        busy={busy}
        providerName={providerName}
        onConnect={() => void connect()}
        onBind={(connectionId) => void bind(connectionId)}
        onVerify={() => void verify()}
        onCancel={cancel}
      />
    </div>
  );
}

function ProviderStatusLine({
  state,
  busy,
  providerName,
  lastVerify,
}: {
  state: import("@/lib/useIntegrationBinding").IntegrationBindingState;
  busy: import("@/lib/useIntegrationBinding").IntegrationBindingBusy;
  providerName: string;
  lastVerify: IntegrationBindingVerifyOutcome | null;
}) {
  if (busy === "connecting") {
    return (
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Authorizing {providerName}…
      </div>
    );
  }
  if (busy === "binding") {
    return (
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Binding {providerName}…
      </div>
    );
  }
  if (busy === "verifying") {
    return (
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Checking {providerName} connection…
      </div>
    );
  }
  if (state.kind === "bound") {
    const label = accountLabelFor(state.activeConnection, providerName);
    // After a failed verify, replace the green/connected line with a clear
    // warning — the optimistic "Connected as" badge is what makes #3
    // (silent dead credentials) feel like a bug.
    if (lastVerify && !lastVerify.ok) {
      return (
        <>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle aria-hidden className="size-3 shrink-0" />
            <span className="min-w-0 truncate">
              <span className="text-foreground">{label}</span> — {lastVerify.reason}
            </span>
          </div>
        </>
      );
    }
    return (
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400"
        />
        Connected as <span className="text-foreground">{label}</span>
        {lastVerify?.ok ? (
          <span
            className="ml-1 inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400"
            title={`Verified at ${new Date(lastVerify.at).toLocaleTimeString()}`}
          >
            <CheckCircle2 aria-hidden className="size-3" />
            verified {relativeTime(lastVerify.at)}
          </span>
        ) : null}
      </div>
    );
  }
  if (state.kind === "needs_binding") {
    return (
      <div className="mt-0.5 text-xs text-muted-foreground">
        <span className="text-foreground">No account bound yet</span> — pick one
        on the right
        {state.candidates.length > 1
          ? ` (${state.candidates.length} available)`
          : ""}
        .
      </div>
    );
  }
  if (state.kind === "no_connection") {
    return (
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-amber-500 dark:bg-amber-400"
        />
        Not connected
      </div>
    );
  }
  return (
    <div className="mt-0.5 text-xs text-muted-foreground/70">Loading…</div>
  );
}

function relativeTime(at: number): string {
  const diff = Math.max(0, Date.now() - at);
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

function ProviderActions({
  state,
  busy,
  providerName,
  onConnect,
  onBind,
  onVerify,
  onCancel,
}: {
  state: import("@/lib/useIntegrationBinding").IntegrationBindingState;
  busy: import("@/lib/useIntegrationBinding").IntegrationBindingBusy;
  providerName: string;
  onConnect: () => void;
  onBind: (connectionId: string) => void;
  onVerify: () => void;
  onCancel: () => void;
}) {
  if (busy !== null) {
    return (
      <Button
        className="shrink-0 self-center"
        onClick={onCancel}
        size="sm"
        type="button"
        variant="ghost"
      >
        <X className="size-3.5" />
        Cancel
      </Button>
    );
  }
  if (state.kind === "bound") {
    // Two affordances when bound: Verify (cheap, in-place check that the
    // stored token still works) and Reconnect (full OAuth restart). The
    // Verify button is the missing piece that lets users confirm a
    // suspicious-looking row without launching the OAuth window — see #3
    // in the integrations UX audit.
    return (
      <div className="flex shrink-0 items-center gap-1 self-center">
        <Button
          aria-label={`Verify ${providerName} connection`}
          className="h-8 px-2"
          onClick={onVerify}
          size="sm"
          title={`Verify ${providerName} connection`}
          type="button"
          variant="ghost"
        >
          <ShieldCheck className="size-3.5" />
          Verify
        </Button>
        <Button
          className="h-8"
          onClick={onConnect}
          size="sm"
          type="button"
          variant="outline"
        >
          <RotateCw className="size-3.5" />
          Reconnect
        </Button>
      </div>
    );
  }
  if (state.kind === "needs_binding") {
    // Inline account picker. For long lists we cap height and surface a
    // subtle hint so the user knows there's more below the fold (mac
    // overlay scrollbars can be invisible until hovered, and missing
    // accounts is exactly the kind of bug that erodes trust in this
    // surface).
    const overflowing = state.candidates.length > 3;
    return (
      <div
        className={cn(
          "flex w-[200px] shrink-0 flex-col gap-1",
          overflowing &&
            "rounded-md ring-1 ring-border/60 [mask-image:linear-gradient(to_bottom,black_calc(100%-12px),transparent)]",
        )}
      >
        <div className={cn(
          "flex flex-col gap-1",
          overflowing && "max-h-[140px] overflow-y-auto pr-0.5",
        )}>
          {state.candidates.map((conn) => {
            const accountLabel = accountLabelFor(conn, providerName);
            // Split the label so the identity (handle/email) is the
            // prominent thing and the autogenerated suffix (if any) shrinks
            // into a secondary line. Users complained the dialog showed
            // "Account 3" with no way to tell which Gmail it is.
            const identity =
              conn.account_handle?.trim() || conn.account_email?.trim() || "";
            const showSubLabel =
              identity && accountLabel !== identity ? accountLabel : "";
            return (
              <button
                className="group flex items-start gap-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/[0.04]"
                key={conn.connection_id}
                onClick={() => onBind(conn.connection_id)}
                type="button"
              >
                <Check className="mt-0.5 size-3 shrink-0 text-foreground/30 transition-colors group-hover:text-foreground/70" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {identity || accountLabel}
                  </span>
                  {showSubLabel ? (
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {showSubLabel}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
        <button
          className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/[0.04] hover:text-foreground"
          onClick={onConnect}
          type="button"
        >
          <Plus className="size-3" />
          Add another account
        </button>
      </div>
    );
  }
  if (state.kind === "no_connection") {
    return (
      <Button
        className="shrink-0 self-center"
        onClick={onConnect}
        size="sm"
        type="button"
        variant="default"
      >
        <Link2 className="size-3.5" />
        Connect
      </Button>
    );
  }
  return null;
}

function accountLabelFor(
  connection: IntegrationConnectionPayload,
  providerName: string,
): string {
  const candidates = [
    connection.account_handle,
    connection.account_email,
    connection.account_label,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const id = connection.connection_id;
  const suffix = id.length > 6 ? id.slice(-6) : id;
  return providerName ? `${providerName} · ${suffix}` : suffix;
}
