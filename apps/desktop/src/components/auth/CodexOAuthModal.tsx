import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ProviderBrandIcon } from "@/lib/providerBrandIcon";
import { cn } from "@/lib/utils";

type Phase = "starting" | "waiting" | "success" | "error";

export interface CodexOAuthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (config: RuntimeConfigPayload) => void;
}

export function CodexOAuthModal({
  open,
  onOpenChange,
  onSuccess,
}: CodexOAuthModalProps) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [userCode, setUserCode] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runIdRef = useRef(0);
  const onSuccessRef = useRef(onSuccess);
  const onOpenChangeRef = useRef(onOpenChange);

  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onOpenChangeRef.current = onOpenChange;
  });

  useEffect(() => {
    if (!open) return;

    const runId = ++runIdRef.current;
    setPhase("starting");
    setErrorMessage("");
    setUserCode("");
    setCopied(false);

    const api = window.electronAPI?.runtime;
    if (!api) {
      setPhase("error");
      setErrorMessage("Desktop runtime is unavailable.");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const challenge = await api.startCodexOAuth();
        if (cancelled || runIdRef.current !== runId) return;
        setUserCode(challenge.userCode);
        setPhase("waiting");
        const config = await api.awaitCodexOAuth();
        if (cancelled || runIdRef.current !== runId) return;
        setPhase("success");
        onSuccessRef.current(config);
        setTimeout(() => {
          if (runIdRef.current === runId) {
            onOpenChangeRef.current(false);
          }
        }, 600);
      } catch (error) {
        if (cancelled || runIdRef.current !== runId) return;
        const message =
          error instanceof Error ? error.message : "Sign-in failed.";
        if (/cancel/i.test(message)) {
          return;
        }
        setPhase("error");
        setErrorMessage(message);
      }
    })();

    return () => {
      cancelled = true;
      void api.cancelCodexOAuth().catch(() => undefined);
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (!userCode) return;
    try {
      await navigator.clipboard.writeText(userCode);
    } catch {
      // Clipboard write can fail in restricted contexts — still flash the icon
      // so the user knows their click registered.
    }
    setCopied(true);
    if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 1400);
  };

  const handleReopenBrowser = () => {
    void window.electronAPI?.ui.openExternalUrl(
      "https://auth.openai.com/codex/device",
    );
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[1000] bg-background/60 backdrop-blur-md data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 duration-200" />
        <DialogPrimitive.Popup
          className={cn(
            "fixed top-1/2 left-1/2 z-[1000] w-[min(440px,calc(100vw-32px))]",
            "-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl",
            "bg-background/95 backdrop-blur-2xl backdrop-saturate-150",
            "shadow-xl ring-1 ring-foreground/10 outline-none",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.97]",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98]",
            "duration-200 ease-out",
          )}
        >
          <div className="grid gap-5 px-6 py-6">
            <header className="flex items-center gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-card ring-1 ring-border">
                <ProviderBrandIcon
                  brand="openai_codex"
                  className="size-5"
                />
              </div>
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="text-sm font-semibold text-foreground">
                  Sign in to OpenAI Codex
                </DialogPrimitive.Title>
                <p className="pt-0.5 text-xs text-muted-foreground">
                  Authorize holaOS to use your ChatGPT account
                </p>
              </div>
            </header>

            {phase === "starting" ? (
              <div className="flex items-center gap-2.5 rounded-xl bg-card px-3 py-3 ring-1 ring-border">
                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Requesting device code…
                </span>
              </div>
            ) : null}

            {phase === "waiting" ? (
              <>
                <div className="grid gap-2">
                  <p className="text-xs text-muted-foreground">
                    We opened ChatGPT in your browser. Paste this code if it
                    didn't auto-fill:
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleCopy()}
                    className={cn(
                      "group flex items-center justify-between gap-3 rounded-xl bg-card px-4 py-3",
                      "ring-1 ring-border transition-colors hover:bg-accent",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                    aria-label="Copy device code"
                  >
                    <span className="font-mono text-lg font-semibold text-foreground">
                      {userCode}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                      {copied ? (
                        <>
                          <Check className="size-3.5" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="size-3.5" />
                          Copy
                        </>
                      )}
                    </span>
                  </button>
                </div>

                <div className="flex items-center gap-2.5 rounded-xl bg-card px-3 py-2.5 ring-1 ring-border">
                  <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    Waiting for browser authorization…
                  </span>
                </div>
              </>
            ) : null}

            {phase === "success" ? (
              <div className="flex items-center gap-2.5 rounded-xl bg-success/10 px-3 py-2.5 ring-1 ring-success/30">
                <Check className="size-4 shrink-0 text-success" />
                <span className="text-sm font-medium text-success">
                  Connected!
                </span>
              </div>
            ) : null}

            {phase === "error" ? (
              <div className="flex items-start gap-2.5 rounded-xl bg-destructive/10 px-3 py-2.5 ring-1 ring-destructive/30">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-destructive">
                    Sign-in failed
                  </div>
                  <div className="pt-0.5 text-xs text-destructive/90">
                    {errorMessage}
                  </div>
                </div>
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              {phase === "waiting" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleReopenBrowser}
                  className="text-muted-foreground"
                >
                  <ExternalLink className="size-3.5" />
                  Open browser again
                </Button>
              ) : null}
              <div className="ml-auto">
                <Button
                  type="button"
                  variant={phase === "error" ? "default" : "ghost"}
                  size="sm"
                  onClick={handleClose}
                >
                  {phase === "success" ? "Done" : phase === "error" ? "Close" : "Cancel"}
                </Button>
              </div>
            </div>
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
