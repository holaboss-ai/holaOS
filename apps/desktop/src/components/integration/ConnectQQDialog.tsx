import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { ChannelBrandIcon } from "@/lib/channelBrandIcon";
import { remoteApiQuery } from "@/lib/remoteApiQuery";

/**
 * Guided QQ connect wizard. The user registers a bot on the QQ Open Platform
 * (q.qq.com), then pastes its App ID + App Secret. We validate the pair by
 * fetching an app access token before persisting. (On the wire QQ reuses the
 * shared token fields: `token` = App ID, `appToken` = App Secret.)
 */
export function ConnectQQDialog({
  open,
  workspaceId,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  workspaceId: string;
  onOpenChange: (open: boolean) => void;
  onConnected?: () => void;
}) {
  const queryClient = useQueryClient();
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [allowFrom, setAllowFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const validateMutation = useMutation(remoteApiQuery.channels.validate.mutationOptions());
  const createMutation = useMutation(remoteApiQuery.channels.create.mutationOptions());
  const busy = validateMutation.isPending || createMutation.isPending;

  useEffect(() => {
    if (open) {
      setAppId("");
      setAppSecret("");
      setAllowFrom("");
      setError(null);
      setConnected(false);
    }
  }, [open]);

  const openQQPortal = () => {
    void window.electronAPI?.ui.openExternalUrl("https://q.qq.com");
  };

  const connect = async () => {
    const id = appId.trim();
    const secret = appSecret.trim();
    if (!id || !secret || !workspaceId) return;
    setError(null);
    try {
      const validation = await validateMutation.mutateAsync({
        platform: "qq",
        token: id,
        appToken: secret,
      });
      if (!validation.ok) {
        setError(validation.error || "Those credentials didn't work — double-check both values.");
        return;
      }
      const allow = allowFrom
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      await createMutation.mutateAsync({
        platform: "qq",
        token: id,
        appToken: secret,
        allowFrom: allow.length > 0 ? allow : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: remoteApiQuery.channels.key() });
      setConnected(true);
      onConnected?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect. Please try again.");
    }
  };

  return (
    <DialogPrimitive.Root onOpenChange={onOpenChange} open={open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[90] bg-foreground/25 backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed top-[12%] left-1/2 z-[100] w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl border border-border bg-popover p-5 shadow-2xl outline-none">
          {connected ? (
            <div className="grid place-items-center gap-3 py-4 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-500">
                <Check className="size-6" />
              </span>
              <div className="text-base font-semibold text-foreground">Connected</div>
              <p className="max-w-xs text-sm text-muted-foreground">
                Add the bot in QQ and message it (or @mention it in a group it's in) — your agent
                will reply right there.
              </p>
              <Button className="mt-1" onClick={() => onOpenChange(false)} size="sm">
                Done
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="grid size-8 place-items-center overflow-hidden rounded-lg border border-border bg-background p-1.5">
                  <ChannelBrandIcon className="size-full" platform="qq" />
                </span>
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  Connect QQ
                </DialogPrimitive.Title>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Register a bot on the QQ Open Platform, then paste its App ID and App Secret.
              </p>
              <ol className="mt-3 grid gap-1.5 text-sm text-foreground/90">
                <li>
                  1. Open the QQ Open Platform (<span className="font-medium">q.qq.com</span>) and
                  create a bot (机器人).
                </li>
                <li>
                  2. In 开发设置 (Development Settings), copy the{" "}
                  <span className="font-medium">AppID</span> and{" "}
                  <span className="font-medium">AppSecret</span>.
                </li>
                <li>3. Make sure group / single-chat messaging is enabled for the bot.</li>
              </ol>
              <Button className="mt-2" onClick={openQQPortal} size="xs" variant="outline">
                Open QQ Open Platform
              </Button>
              <div className="mt-4 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="qq-appid">
                  App ID
                </label>
                <Input
                  autoFocus
                  id="qq-appid"
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="Paste the bot AppID"
                  value={appId}
                />
              </div>
              <div className="mt-3 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="qq-secret">
                  App Secret
                </label>
                <Input
                  id="qq-secret"
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder="Paste the bot AppSecret"
                  value={appSecret}
                />
              </div>
              <div className="mt-3 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="qq-allow">
                  Who can message it <span className="text-muted-foreground/70">(optional)</span>
                </label>
                <Input
                  id="qq-allow"
                  onChange={(e) => setAllowFrom(e.target.value)}
                  placeholder="QQ user id — leave empty to allow anyone"
                  value={allowFrom}
                />
              </div>
              {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
                  Cancel
                </Button>
                <Button
                  disabled={!appId.trim() || !appSecret.trim() || busy}
                  onClick={() => void connect()}
                  size="sm"
                  type="button"
                >
                  {busy ? "Connecting…" : "Connect"}
                </Button>
              </div>
            </>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
