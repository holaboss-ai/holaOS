import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { overlayOpenCountAtom } from "@/components/layout/shell/overlay-presence";
import { Button } from "@/components/ui/button";
import { Link2, X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { getIntegrationLogo } from "@/lib/integrationLogo";
import type { IntegrationCredentialRequest } from "@/lib/workspaceDesktop";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";
import { HolaAppIcon } from "./HolaAppIcon";

/**
 * The credential form for toolkits Composio holds no managed credentials for
 * (Pinecone, Firecrawl, …) — they authorize with the user's own API key, so
 * there's no OAuth window to open.
 *
 * Mounted once at the shell root and driven by whatever `connectIntegrationProvider`
 * parks on the context, so EVERY connect entry point (chat proposal card, store
 * install dialog, onboarding) gets the credential branch without knowing it exists.
 */
export function IntegrationCredentialDialog() {
  const { integrationCredentialRequest } = useWorkspaceDesktop();
  return integrationCredentialRequest ? (
    <CredentialForm
      key={integrationCredentialRequest.provider}
      request={integrationCredentialRequest}
    />
  ) : null;
}

function CredentialForm({ request }: { request: IntegrationCredentialRequest }) {
  const { displayName, fields, provider, resolve } = request;
  const [values, setValues] = useState<Record<string, string>>({});
  const setOverlayCount = useSetAtom(overlayOpenCountAtom);
  useEffect(() => {
    setOverlayCount((c) => c + 1);
    return () => {
      setOverlayCount((c) => Math.max(0, c - 1));
    };
  }, [setOverlayCount]);

  const ready = fields.every((f) => !f.required || values[f.name]?.trim());

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(next) => {
        if (!next) {
          resolve(null);
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/20 backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[20%] left-1/2 z-[100] w-[400px] -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-2xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
          <div className="relative flex flex-col items-center px-6 pt-9 pb-7 text-center">
            <DialogPrimitive.Close
              aria-label="Close"
              className="absolute top-3 right-3 grid size-7 place-items-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="size-3.5" />
            </DialogPrimitive.Close>

            <HolaAppIcon
              hero
              holaAppId={provider}
              iconUrl={getIntegrationLogo(provider).url}
              title={displayName}
            />
            <DialogPrimitive.Title className="mt-4 font-semibold text-base text-foreground">
              Connect {displayName}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-1 max-w-[300px] text-[13px] text-muted-foreground leading-relaxed">
              {displayName} signs in with your own key rather than a holaOS
              sign-in window. Paste it here and your agent can work in{" "}
              {displayName} on your behalf.
            </DialogPrimitive.Description>

            <form
              className="mt-6 flex w-full flex-col gap-3 text-left"
              onSubmit={(event) => {
                event.preventDefault();
                if (ready) {
                  resolve(values);
                }
              }}
            >
              {fields.map((field) => (
                <label className="flex flex-col gap-1.5" key={field.name}>
                  <span className="font-medium text-foreground text-xs">
                    {field.displayName || field.name}
                  </span>
                  <Input
                    autoComplete="off"
                    className="h-9"
                    onChange={(event) =>
                      setValues((prev) => ({
                        ...prev,
                        [field.name]: event.target.value,
                      }))
                    }
                    placeholder={
                      field.description || field.displayName || field.name
                    }
                    type={
                      /key|secret|token|password/i.test(field.name)
                        ? "password"
                        : "text"
                    }
                    value={values[field.name] ?? ""}
                  />
                </label>
              ))}
              <Button
                className="mt-1 w-full"
                disabled={!ready}
                type="submit"
                variant="default"
              >
                <Link2 className="size-4" />
                Connect {displayName}
              </Button>
            </form>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
