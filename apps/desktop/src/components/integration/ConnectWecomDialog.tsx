import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { ChannelBrandIcon } from "@/lib/channelBrandIcon";
import { remoteApiQuery } from "@/lib/remoteApiQuery";

/**
 * Guided WeCom (企业微信) Smart Bot connect wizard. The user creates a Smart Bot
 * in the WeCom admin console, switches it to API mode → long-connection, and
 * pastes its BotID + Secret. We validate the pair via a short WebSocket auth
 * handshake before persisting. (On the wire WeCom reuses the shared token fields:
 * `token` = BotID, `appToken` = Secret.)
 */
export function ConnectWecomDialog({
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
  const [botId, setBotId] = useState("");
  const [secret, setSecret] = useState("");
  const [allowFrom, setAllowFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const validateMutation = useMutation(remoteApiQuery.channels.validate.mutationOptions());
  const createMutation = useMutation(remoteApiQuery.channels.create.mutationOptions());
  const busy = validateMutation.isPending || createMutation.isPending;

  useEffect(() => {
    if (open) {
      setBotId("");
      setSecret("");
      setAllowFrom("");
      setError(null);
      setConnected(false);
    }
  }, [open]);

  const openWecomConsole = () => {
    void window.electronAPI?.ui.openExternalUrl("https://work.weixin.qq.com/wework_admin/");
  };

  const connect = async () => {
    const id = botId.trim();
    const sec = secret.trim();
    if (!id || !sec || !workspaceId) return;
    setError(null);
    try {
      const validation = await validateMutation.mutateAsync({
        platform: "wecom",
        token: id,
        appToken: sec,
      });
      if (!validation.ok) {
        setError(validation.error || "Those credentials didn't work — double-check the BotID and Secret.");
        return;
      }
      const allow = allowFrom
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      await createMutation.mutateAsync({
        platform: "wecom",
        token: id,
        appToken: sec,
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
                Message the bot in WeCom — DM it, or @mention it in a group it's in — and your agent
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
                  <ChannelBrandIcon className="size-full" platform="wecom" />
                </span>
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  Connect WeCom
                </DialogPrimitive.Title>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Create a Smart Bot in your WeCom (企业微信) admin console, then paste its BotID and
                Secret. Reaches your WeCom contacts.
              </p>
              <ol className="mt-3 grid gap-1.5 text-sm text-foreground/90">
                <li>1. In the WeCom admin console, open 管理工具 → 智能机器人 and create a bot.</li>
                <li>
                  2. Switch it to <span className="font-medium">API 模式</span> →{" "}
                  <span className="font-medium">长连接</span> (long connection).
                </li>
                <li>3. Copy the BotID and Secret it shows.</li>
              </ol>
              <Button className="mt-2" onClick={openWecomConsole} size="xs" variant="outline">
                Open WeCom admin console
              </Button>
              <div className="mt-4 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="wecom-botid">
                  BotID
                </label>
                <Input
                  autoFocus
                  id="wecom-botid"
                  onChange={(e) => setBotId(e.target.value)}
                  placeholder="Paste the bot's BotID"
                  value={botId}
                />
              </div>
              <div className="mt-3 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="wecom-secret">
                  Secret
                </label>
                <Input
                  id="wecom-secret"
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="Paste the bot's Secret"
                  value={secret}
                />
              </div>
              <div className="mt-3 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="wecom-allow">
                  Who can message it <span className="text-muted-foreground/70">(optional)</span>
                </label>
                <Input
                  id="wecom-allow"
                  onChange={(e) => setAllowFrom(e.target.value)}
                  placeholder="WeCom user id — leave empty to allow anyone"
                  value={allowFrom}
                />
              </div>
              {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
                  Cancel
                </Button>
                <Button
                  disabled={!botId.trim() || !secret.trim() || busy}
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
