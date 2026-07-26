import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ProviderActions,
  ProviderRow,
} from "@/components/integration/AppIntegrationsDialog";
import { overlayOpenCountAtom } from "@/components/layout/shell/overlay-presence";
import { Button } from "@/components/ui/button";
import { Check, Download, Link2, Loader2, X } from "@/components/ui/icons";
import { type AppCatalogEntry, appKind } from "@/lib/holaAppMarketplace";
import {
  type IntegrationBindingState,
  useIntegrationBinding,
} from "@/lib/useIntegrationBinding";
import { HolaAppIcon } from "./HolaAppIcon";

// Install-time connect/select gate for a HolaApp that declares required
// integrations (the marketplace contract's `needs_connection`). Two shapes:
//
//   • A single connection-tier App (the App *is* the integration) → a focused
//     hero: one logo, one title, one Connect CTA. No provider row, because the
//     header and the row would be the same entity twice.
//   • A bundle that needs one or more integrations before it lands in the
//     sidebar → a header + a ProviderRow checklist + an "Add to sidebar" gate.
//
// Rendered as a Dialog (portaled above the BrowserView layer) and bumps the
// shell overlay counter so the native web surface detaches and can't paint
// over it — same pattern as AppIntegrationsDialog.
export function HolaAppInstallDialog({
  open,
  onOpenChange,
  entry,
  onConfirm,
  onConnectOnly,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: AppCatalogEntry;
  /** Finalize the install (record install state / add to sidebar). Called once
   * all required providers are bound. */
  onConfirm: () => Promise<void> | void;
  /** For a single-connection App (a HolaApp whose one required integration is
   * the app itself, e.g. Notion): finish with ONLY the connection bound — the
   * agent can use it in chat, but it isn't added to the sidebar. Omitted ⇒ the
   * "keep just the connection" option is hidden (add-to-sidebar is the only
   * completion). */
  onConnectOnly?: () => Promise<void> | void;
}) {
  const setOverlayCount = useSetAtom(overlayOpenCountAtom);
  useEffect(() => {
    if (!open) return;
    setOverlayCount((c) => c + 1);
    return () => {
      setOverlayCount((c) => Math.max(0, c - 1));
    };
  }, [open, setOverlayCount]);

  const integrations = useMemo(() => entry.integrations ?? [], [entry]);
  const isConnection = appKind(entry) === "connection";
  // A focused single-connection flow: exactly one integration, and for an App
  // that integration is the required connection that defines it. A pure
  // connection auto-finishes on connect; an App offers connect → add-to-sidebar.
  const single =
    integrations.length === 1 &&
    (isConnection || Boolean(integrations[0]?.required));
  // An App (any non-connection tier) has a sidebar surface to add.
  const hasSurface = !isConnection;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          className={`fixed top-[20%] left-1/2 z-[100] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 ${single ? "w-[400px]" : "w-[480px]"}`}
        >
          {single ? (
            <SingleConnectBody
              entry={entry}
              hasSurface={hasSurface}
              onClose={() => onOpenChange(false)}
              onConfirm={onConfirm}
              onConnectOnly={onConnectOnly}
            />
          ) : (
            <BundleInstallBody
              entry={entry}
              integrations={integrations}
              isConnection={isConnection}
              onOpenChange={onOpenChange}
              onConfirm={onConfirm}
            />
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// The single-connection hero. The App is one integration, so the whole dialog
// is that integration: connect and it auto-finishes and closes.
function SingleConnectBody({
  entry,
  hasSurface,
  onConfirm,
  onConnectOnly,
  onClose,
}: {
  entry: AppCatalogEntry;
  /** The App has a sidebar surface: once connected, stop and let the user choose
   * "Add to sidebar" vs "Keep just the connection". A pure connection (false)
   * auto-finishes on connect. */
  hasSurface: boolean;
  onConfirm: () => Promise<void> | void;
  onConnectOnly?: () => Promise<void> | void;
  onClose: () => void;
}) {
  const integration = entry.integrations?.[0];
  const provider = integration?.provider ?? entry.title;
  const { state, busy, errorMessage, connect, bind, verify, cancel } =
    useIntegrationBinding({
      appId: entry.holaAppId,
      provider,
      whoami: integration?.whoami ?? null,
      considerWorkspaceDefault: true,
    });

  const [confirming, setConfirming] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");
  const finalizedRef = useRef(false);

  const finalize = useCallback(async () => {
    setConfirming(true);
    setFinalizeError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setFinalizeError(
        err instanceof Error ? err.message : "Couldn't finish connecting",
      );
    } finally {
      setConfirming(false);
    }
  }, [onConfirm, onClose]);

  // "Keep just the connection": the account is already bound, so agents can use
  // it — just ensure the connection is live (onConnectOnly) and close, without
  // adding the app to the sidebar.
  const [keeping, setKeeping] = useState(false);
  const keepConnection = useCallback(async () => {
    setKeeping(true);
    setFinalizeError("");
    try {
      await onConnectOnly?.();
      onClose();
    } catch (err) {
      setFinalizeError(
        err instanceof Error ? err.message : "Couldn't finish connecting",
      );
    } finally {
      setKeeping(false);
    }
  }, [onConnectOnly, onClose]);

  // A pure connection has no surface, so signing in IS the whole install: once
  // the account binds, finalize and close without a second click (the ref fires
  // it at most once so a failing onConfirm can't loop). An App with a surface
  // instead STOPS at the connected state below and lets the user choose.
  useEffect(() => {
    if (hasSurface) return;
    if (state.kind !== "bound" || confirming || finalizedRef.current) return;
    finalizedRef.current = true;
    void finalize();
  }, [hasSurface, state.kind, confirming, finalize]);

  const busyVerb = { connecting: "Authorizing", binding: "Linking", verifying: "Checking" };
  const busyLabel = busy ? `${busyVerb[busy]} ${entry.title}…` : "";
  const message = finalizeError || errorMessage;

  // Connected AND the App has a sidebar surface → don't finish silently; present
  // the two equally-clear paths: add it to the sidebar, or keep just the
  // connection (agents can already use it).
  if (hasSurface && state.kind === "bound") {
    return (
      <div className="relative flex flex-col items-center px-6 pt-9 pb-7 text-center">
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute top-3 right-3 grid size-7 place-items-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <X className="size-3.5" />
        </DialogPrimitive.Close>

        <div className="relative">
          <HolaAppIcon
            hero
            holaAppId={entry.holaAppId}
            iconUrl={entry.iconUrl}
            title={entry.title}
          />
          <span className="-right-1 -bottom-1 absolute grid size-5 place-items-center rounded-full bg-emerald-500 text-white ring-2 ring-popover">
            <Check className="size-3" />
          </span>
        </div>
        <DialogPrimitive.Title className="mt-4 font-semibold text-base text-foreground">
          {entry.title} is connected
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-1 max-w-[300px] text-[13px] text-muted-foreground leading-relaxed">
          Your agent can use {entry.title} now. Add it to your sidebar to open it
          as an app too.
        </DialogPrimitive.Description>

        <div className="mt-6 flex w-full flex-col items-center gap-2">
          <Button
            className="w-full"
            disabled={confirming || keeping}
            onClick={() => void finalize()}
            type="button"
            variant="default"
          >
            {confirming ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Add to sidebar
          </Button>
          {onConnectOnly ? (
            <Button
              className="w-full"
              disabled={confirming || keeping}
              onClick={() => void keepConnection()}
              type="button"
              variant="ghost"
            >
              {keeping ? <Loader2 className="size-4 animate-spin" /> : null}
              Keep just the connection
            </Button>
          ) : null}
          <button
            className="mt-1 text-muted-foreground text-xs transition-colors hover:text-foreground disabled:opacity-50"
            disabled={busy !== null || confirming || keeping}
            onClick={() => void connect()}
            type="button"
          >
            Reconnect
          </button>
          {message ? <p className="text-destructive text-xs">{message}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center px-6 pt-9 pb-7 text-center">
      <DialogPrimitive.Close
        aria-label="Close"
        className="absolute top-3 right-3 grid size-7 place-items-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <X className="size-3.5" />
      </DialogPrimitive.Close>

      <HolaAppIcon
        hero
        holaAppId={entry.holaAppId}
        iconUrl={entry.iconUrl}
        title={entry.title}
      />
      <DialogPrimitive.Title className="mt-4 font-semibold text-base text-foreground">
        Connect {entry.title}
      </DialogPrimitive.Title>
      {/* Auth-agnostic: the connect flow resolves whether this toolkit takes a
          sign-in window or the user's own key, and asks for whichever it needs. */}
      <DialogPrimitive.Description className="mt-1 max-w-[300px] text-[13px] text-muted-foreground leading-relaxed">
        Connect it so your agent can work in {entry.title} on your behalf.
      </DialogPrimitive.Description>

      <div className="mt-6 flex w-full flex-col items-center gap-2.5">
        {state.kind === "needs_binding" ? (
          <ProviderActions
            busy={busy}
            onBind={(id) => void bind(id)}
            onCancel={cancel}
            onConnect={() => void connect()}
            onVerify={() => void verify()}
            providerName={entry.title}
            state={state}
          />
        ) : busy !== null || confirming ? (
          <Button
            className="w-full"
            disabled={confirming}
            onClick={cancel}
            type="button"
            variant="outline"
          >
            <Loader2 className="size-4 animate-spin" />
            {confirming ? "Finishing…" : "Cancel"}
          </Button>
        ) : (
          <Button
            className="w-full"
            disabled={state.kind === "loading"}
            onClick={() => void connect()}
            type="button"
            variant="default"
          >
            <Link2 className="size-4" />
            Connect {entry.title}
          </Button>
        )}

        {busyLabel && !confirming ? (
          <p className="text-muted-foreground text-xs">{busyLabel}</p>
        ) : null}
        {message ? <p className="text-destructive text-xs">{message}</p> : null}
      </div>
    </div>
  );
}

// The multi-integration bundle: a header, a checklist of ProviderRows, and a
// gate that stays disabled until every required provider is bound.
function BundleInstallBody({
  entry,
  integrations,
  isConnection,
  onOpenChange,
  onConfirm,
}: {
  entry: AppCatalogEntry;
  integrations: NonNullable<AppCatalogEntry["integrations"]>;
  isConnection: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void> | void;
}) {
  const [kinds, setKinds] = useState<
    Record<string, IntegrationBindingState["kind"]>
  >({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const onRowState = useMemo(() => {
    const map: Record<string, (kind: IntegrationBindingState["kind"]) => void> =
      {};
    for (const integration of integrations) {
      const key = integration.provider.toLowerCase();
      map[key] = (kind) =>
        setKinds((prev) => (prev[key] === kind ? prev : { ...prev, [key]: kind }));
    }
    return map;
  }, [integrations]);

  const requiredKeys = integrations
    .filter((integration) => integration.required)
    .map((integration) => integration.provider.toLowerCase());
  const allRequiredBound = requiredKeys.every((key) => kinds[key] === "bound");

  const handleConfirm = useCallback(async () => {
    setConfirming(true);
    setError("");
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed");
    } finally {
      setConfirming(false);
    }
  }, [onConfirm, onOpenChange]);

  return (
    <>
      <div className="flex items-center gap-3 border-border border-b px-4 py-3">
        <HolaAppIcon
          holaAppId={entry.holaAppId}
          iconUrl={entry.iconUrl}
          title={entry.title}
        />
        <div className="min-w-0 flex-1">
          <DialogPrimitive.Title className="truncate font-medium text-foreground text-sm">
            {isConnection ? "Connect" : "Install"} {entry.title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-0.5 text-muted-foreground text-xs">
            Connect the required accounts, then add {entry.title} to your
            sidebar.
          </DialogPrimitive.Description>
        </div>
        <DialogPrimitive.Close
          aria-label="Close"
          className="grid size-7 shrink-0 place-items-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <X className="size-3.5" />
        </DialogPrimitive.Close>
      </div>
      <div className="flex flex-col divide-y divide-border">
        {integrations.map((integration) => (
          <ProviderRow
            appId={entry.holaAppId}
            key={integration.provider}
            onStateChange={onRowState[integration.provider.toLowerCase()]}
            provider={integration.provider}
            required={integration.required}
            whoami={integration.whoami ?? null}
          />
        ))}
      </div>
      {error ? (
        <div className="border-border border-t px-4 py-2 text-destructive text-xs">
          {error}
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2 border-border border-t bg-foreground/[0.02] px-4 py-3">
        <span className="mr-auto text-[11px] text-muted-foreground">
          {allRequiredBound
            ? "All set — add it to your sidebar."
            : "Connect the required accounts to continue."}
        </span>
        <Button
          onClick={() => onOpenChange(false)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
        <Button
          disabled={!allRequiredBound || confirming}
          onClick={() => void handleConfirm()}
          size="sm"
          type="button"
          variant="default"
        >
          {confirming ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          Add to sidebar
        </Button>
      </div>
    </>
  );
}
