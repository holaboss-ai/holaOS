import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";
import { remoteApi } from "@/lib/remoteApiClient";
import { remoteApiQuery } from "@/lib/remoteApiQuery";

type Phase = "loading" | "awaiting" | "connected" | "error";
type DeviceFlowPlatform = "feishu" | "dingtalk" | "wechat";

/**
 * QR "scan-to-create" device-flow connect, shared by Feishu/Lark and DingTalk. The
 * user scans a QR with the platform's mobile app, which auto-creates a
 * pre-configured app and returns its credentials — no console, scopes, or admin
 * approval.
 *
 * There is deliberately no Feishu-vs-Lark choice: the runtime always begins on the
 * Feishu hub, which serves both Feishu (China) and Lark (international) tenants and
 * auto-detects which one the user actually has. Asking a non-technical operator to
 * know that distinction was a footgun (scanning a Feishu account against the Lark
 * endpoint hangs forever).
 */
export function ConnectDeviceFlowDialog({
  platform,
  open,
  workspaceId,
  onOpenChange,
  onConnected,
}: {
  platform: DeviceFlowPlatform;
  open: boolean;
  workspaceId: string;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
}) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>("loading");
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [botName, setBotName] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const runRef = useRef(0);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const isFeishu = platform === "feishu";
  const isWechat = platform === "wechat";
  const appName = isFeishu ? "Feishu / Lark" : isWechat ? "WeChat" : "DingTalk";

  useEffect(() => {
    if (!open || !workspaceId) return;
    const runId = ++runRef.current;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    void (async () => {
      setPhase("loading");
      setError(null);
      setQr(null);
      setBotName(null);
      try {
        const start = await remoteApi.channels.startDeviceAuth({ platform });
        if (runRef.current !== runId) return;
        const dataUrl = await QRCode.toDataURL(start.qr_url, { width: 224, margin: 1 });
        if (runRef.current !== runId) return;
        setQr(dataUrl);
        setPhase("awaiting");

        const deadline = Date.now() + start.expires_in_sec * 1000;
        const intervalMs = Math.max(2000, start.interval_sec * 1000);
        while (runRef.current === runId && Date.now() < deadline) {
          await sleep(intervalMs);
          if (runRef.current !== runId) return;
          const result = await remoteApi.channels.pollDeviceAuth({
            platform,
            deviceCode: start.device_code,
          });
          if (runRef.current !== runId) return;
          if (result.status === "success") {
            setBotName((result.connection?.bot_username as string | null) ?? null);
            setPhase("connected");
            await queryClient.invalidateQueries({ queryKey: remoteApiQuery.channels.key() });
            onConnectedRef.current?.();
            return;
          }
          if (result.status === "denied") {
            setError("Authorization was declined in the app.");
            setPhase("error");
            return;
          }
          if (result.status === "expired") {
            setError("The QR code expired — tap Try again.");
            setPhase("error");
            return;
          }
        }
        if (runRef.current === runId) {
          setError("The QR code expired — tap Try again.");
          setPhase("error");
        }
      } catch (err) {
        if (runRef.current !== runId) return;
        setError(err instanceof Error ? err.message : "Couldn't start. Please try again.");
        setPhase("error");
      }
    })();

    return () => {
      runRef.current += 1; // cancel any in-flight loop on close / retry
    };
  }, [open, platform, workspaceId, nonce, queryClient]);

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/25 backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[10%] left-1/2 z-[100] w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl border border-border bg-popover p-5 shadow-2xl outline-none">
          {phase === "connected" ? (
            <div className="grid place-items-center gap-3 py-4 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-500">
                <Check className="size-6" />
              </span>
              <div className="text-base font-semibold text-foreground">
                Connected{botName ? ` as ${botName}` : ""}
              </div>
              <p className="max-w-xs text-sm text-muted-foreground">
                Open {appName} and message your bot — your agent will reply right there.
              </p>
              <Button className="mt-1" onClick={() => onOpenChange(false)} size="sm">
                Done
              </Button>
            </div>
          ) : (
            <>
              <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                Connect {appName}
              </DialogPrimitive.Title>
              <p className="mt-1 text-sm text-muted-foreground">
                {isWechat
                  ? "Scan the code with the WeChat app to log your account in. No console, no setup."
                  : "Scan the code with your phone — it creates & connects a bot for you. No console, no setup."}
              </p>
              {isWechat ? (
                <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-500">
                  Heads up: personal WeChat uses an unofficial bot identity — direct messages work
                  best; group messages can be unreliable, and you may need to re-scan if the session
                  expires.
                </p>
              ) : null}

              <div className="mt-4 grid place-items-center gap-3">
                <div className="grid size-[224px] place-items-center rounded-xl border border-border bg-white">
                  {qr ? (
                    <img alt={`${appName} QR code`} className="size-[208px]" src={qr} />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {phase === "error" ? "—" : "Generating code…"}
                    </span>
                  )}
                </div>
                {phase === "awaiting" ? (
                  <p className="text-center text-xs text-muted-foreground">
                    Open the <span className="font-medium">{appName}</span> app → scan → tap{" "}
                    <span className="font-medium">Authorize</span>. Waiting…
                  </p>
                ) : null}
                {error ? <p className="text-center text-sm text-destructive">{error}</p> : null}
              </div>

              <div className="mt-4 flex items-center justify-end gap-2">
                <Button onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
                  Cancel
                </Button>
                {phase === "error" ? (
                  <Button onClick={() => setNonce((n) => n + 1)} size="sm" type="button">
                    Try again
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
