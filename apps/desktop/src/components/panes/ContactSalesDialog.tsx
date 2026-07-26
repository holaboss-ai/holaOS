/**
 * Contact Sales gate for the fingerprint (cloak) Browser Profiles engine.
 *
 * Shown instead of the fingerprint editor when `FEATURES.fingerprintBrowser` is
 * off (the default) — the anti-detect engine needs the OEM-licensed CloakBrowser
 * binary, so it's positioned as an Enterprise capability. The primary CTA opens
 * the sales URL in the user's default browser.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { ShieldCheck, X } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

// Where "Contact sales" sends the user. Update to the real enterprise/contact page.
const CONTACT_SALES_URL = "https://www.holaos.ai/enterprise";

const BULLETS = [
  "Unique canvas / WebGL / GPU / timezone per profile",
  "Fresh identities that pass bot detection",
  "Reusable fingerprint templates + import",
];

interface ContactSalesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContactSalesDialog({
  open,
  onOpenChange,
}: ContactSalesDialogProps) {
  const contactSales = () => {
    void window.electronAPI?.ui.openExternalUrl(CONTACT_SALES_URL);
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[120] bg-scrim backdrop-blur-sm ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-[121] flex w-[min(460px,calc(100vw-32px))] min-w-0 -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-xl outline-none ease-emphasized data-open:duration-snappy data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97] data-closed:duration-tap data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]">
          <header className="flex items-start justify-between gap-4 border-border border-b px-6 py-5">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-400">
                <ShieldCheck className="size-5" />
              </span>
              <div className="min-w-0">
                <DialogPrimitive.Title className="flex items-center gap-2 font-semibold text-[19px] text-foreground">
                  Fingerprint Browser
                  <span className="rounded bg-violet-500/15 px-1.5 py-0.5 font-medium text-[10px] text-violet-600 uppercase tracking-wide dark:text-violet-400">
                    Enterprise
                  </span>
                </DialogPrimitive.Title>
              </div>
            </div>
            <DialogPrimitive.Close
              render={
                <button
                  aria-label="Close"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "icon" }),
                    "shrink-0 rounded-full",
                  )}
                  type="button"
                >
                  <X size={16} />
                </button>
              }
            />
          </header>

          <div className="px-6 py-5">
            <p className="text-foreground text-sm leading-relaxed">
              Give each profile a distinct, detection‑resistant browser identity —
              a real anti‑detect fingerprint for multi‑account work, with a proxy
              per profile.
            </p>
            <ul className="mt-4 space-y-2">
              {BULLETS.map((bullet) => (
                <li
                  key={bullet}
                  className="flex items-start gap-2 text-muted-foreground text-sm"
                >
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
                  {bullet}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-muted-foreground text-xs">
              Available on holaOS Enterprise.
            </p>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-border border-t px-6 py-4">
            <DialogPrimitive.Close
              render={
                <button
                  className={buttonVariants({ variant: "outline" })}
                  type="button"
                >
                  Maybe later
                </button>
              }
            />
            <Button onClick={contactSales} type="button">
              Contact sales
            </Button>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
