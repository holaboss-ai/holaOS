import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import { Check, Link2, Loader2, Plus, RotateCw, X } from "lucide-react";
import { useEffect } from "react";
import { IntegrationLogo } from "@/components/integration/IntegrationLogo";
import { overlayOpenCountAtom } from "@/components/layout/new-shell/overlay-presence";
import { Button } from "@/components/ui/button";
import { useIntegrationBinding } from "@/lib/useIntegrationBinding";
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
  // Bump the new-shell overlay counter while the dialog is open so
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

  const { state, busy, errorMessage, connect, bind, cancel } =
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
        onCancel={cancel}
      />
    </div>
  );
}

function ProviderStatusLine({
  state,
  busy,
  providerName,
}: {
  state: import("@/lib/useIntegrationBinding").IntegrationBindingState;
  busy: import("@/lib/useIntegrationBinding").IntegrationBindingBusy;
  providerName: string;
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
  if (state.kind === "bound") {
    const label = accountLabelFor(state.activeConnection, providerName);
    return (
      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden
          className="size-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400"
        />
        Connected as <span className="text-foreground">{label}</span>
      </div>
    );
  }
  if (state.kind === "needs_binding") {
    return (
      <div className="mt-0.5 text-xs text-muted-foreground">
        Pick an account to bind to this app
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

function ProviderActions({
  state,
  busy,
  providerName,
  onConnect,
  onBind,
  onCancel,
}: {
  state: import("@/lib/useIntegrationBinding").IntegrationBindingState;
  busy: import("@/lib/useIntegrationBinding").IntegrationBindingBusy;
  providerName: string;
  onConnect: () => void;
  onBind: (connectionId: string) => void;
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
    return (
      <Button
        className="shrink-0 self-center"
        onClick={onConnect}
        size="sm"
        type="button"
        variant="outline"
      >
        <RotateCw className="size-3.5" />
        Reconnect
      </Button>
    );
  }
  if (state.kind === "needs_binding") {
    // Inline account picker — vertical list within the row, no popup needed.
    // For a long list this could get tall; we cap the visual area with
    // max-h + overflow-y so the dialog stays a sane size.
    return (
      <div
        className={cn(
          "flex max-h-[120px] w-[180px] shrink-0 flex-col gap-1 overflow-y-auto",
        )}
      >
        {state.candidates.map((conn) => (
          <button
            className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-left text-xs text-foreground transition-colors hover:border-foreground/30 hover:bg-foreground/[0.04]"
            key={conn.connection_id}
            onClick={() => onBind(conn.connection_id)}
            type="button"
          >
            <Check className="size-3 text-foreground/40" />
            <span className="min-w-0 flex-1 truncate">
              {accountLabelFor(conn, providerName)}
            </span>
          </button>
        ))}
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
