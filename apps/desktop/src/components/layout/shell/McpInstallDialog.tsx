import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { overlayOpenCountAtom } from "@/components/layout/shell/overlay-presence";
import { Button } from "@/components/ui/button";
import { Download, ExternalLink, Loader2, Server, X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { McpCatalogEntry } from "@/lib/mcpMarketplace";
import { HolaAppIcon } from "./HolaAppIcon";

// Generic install-time gate for an MCP server: one input per declared `requiredKey`
// (label + optional help; `secret` → masked). The keys are credentials that MUST stay on
// this machine — onConfirm hands them to installMcp, which stores them in localStorage and
// passes them to the Electron main process to write into the local workspace.yaml. Nothing
// here touches a `/gateway/*` endpoint. Confirm is blocked until every required key is
// non-empty.
//
// Rendered as a Dialog (portaled above the native BrowserView layer) and bumps the shell
// overlay counter so the native surface detaches — same pattern as HolaAppInstallDialog.
export function McpInstallDialog({
  open,
  onOpenChange,
  entry,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: McpCatalogEntry;
  /** Finalize the install with the entered key values (keyed by `requiredKey.name`). */
  onConfirm: (values: Record<string, string>) => Promise<void> | void;
}) {
  const setOverlayCount = useSetAtom(overlayOpenCountAtom);
  useEffect(() => {
    if (!open) {
      return;
    }
    setOverlayCount((c) => c + 1);
    return () => {
      setOverlayCount((c) => Math.max(0, c - 1));
    };
  }, [open, setOverlayCount]);

  const [values, setValues] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const allRequiredFilled = entry.requiredKeys.every(
    (key) => (values[key.name] ?? "").trim().length > 0,
  );

  const handleConfirm = async () => {
    setConfirming(true);
    setError("");
    try {
      // Trim each value so a stray space can't slip into a header/token.
      const trimmed: Record<string, string> = {};
      for (const key of entry.requiredKeys) {
        trimmed[key.name] = (values[key.name] ?? "").trim();
      }
      await onConfirm(trimmed);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Install failed");
    } finally {
      setConfirming(false);
    }
  };

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[16%] left-1/2 z-[100] w-[480px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <div className="flex items-center gap-3 border-border border-b px-4 py-3">
            <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-background">
              {entry.iconUrl ? (
                <HolaAppIcon
                  iconUrl={entry.iconUrl}
                  sizeClass="size-5"
                  title={entry.name}
                />
              ) : (
                <Server className="size-5 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate font-medium text-foreground text-sm">
                Install {entry.name}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-muted-foreground text-xs">
                Enter your credentials — they stay on this device and are never
                sent to holaOS.
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="grid size-7 shrink-0 place-items-center rounded-md text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="size-3.5" />
            </DialogPrimitive.Close>
          </div>

          <div className="flex flex-col gap-4 px-4 py-4">
            {entry.requiredKeys.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                No credentials needed — click Install to attach this server.
              </p>
            ) : (
              entry.requiredKeys.map((key) => (
                <div className="flex flex-col gap-1.5" key={key.name}>
                  <Label className="text-foreground text-xs" htmlFor={`mcp-${key.name}`}>
                    {key.label}
                  </Label>
                  <Input
                    autoComplete="off"
                    id={`mcp-${key.name}`}
                    onChange={(event) =>
                      setValues((prev) => ({
                        ...prev,
                        [key.name]: event.target.value,
                      }))
                    }
                    placeholder={key.label}
                    type={key.secret ? "password" : "text"}
                    value={values[key.name] ?? ""}
                  />
                  {key.help ? (
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {key.help}
                    </p>
                  ) : null}
                </div>
              ))
            )}
            {entry.surfaceUrl ? (
              <button
                className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                onClick={() =>
                  entry.surfaceUrl
                    ? void window.electronAPI.profiles.launch(
                        "bprofile_default",
                        entry.surfaceUrl,
                      )
                    : undefined
                }
                type="button"
              >
                <ExternalLink className="size-3" />
                Open {entry.name} to get your credentials
              </button>
            ) : null}
          </div>

          {error ? (
            <div className="border-border border-t px-4 py-2 text-destructive text-xs">
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-2 border-border border-t bg-foreground/[0.02] px-4 py-3">
            <span className="text-[11px] text-muted-foreground">
              {allRequiredFilled
                ? "Ready to install."
                : "Fill in every field to continue."}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                onClick={() => onOpenChange(false)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                disabled={!allRequiredFilled || confirming}
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
                Install
              </Button>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
