import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { ChannelBrandIcon } from "@/lib/channelBrandIcon";
import { remoteApiQuery } from "@/lib/remoteApiQuery";

/**
 * Guided Discord connect wizard. The user creates a bot application, enables the
 * Message Content intent, and pastes the bot token. We validate it server-side
 * (confirming "Connected as <bot>") and return a one-click invite URL so the user
 * can add the bot to a server without hunting through the developer portal.
 */
export function ConnectDiscordDialog({
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
  const [token, setToken] = useState("");
  const [allowFrom, setAllowFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connectedAs, setConnectedAs] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const validateMutation = useMutation(remoteApiQuery.channels.validate.mutationOptions());
  const createMutation = useMutation(remoteApiQuery.channels.create.mutationOptions());
  const busy = validateMutation.isPending || createMutation.isPending;

  useEffect(() => {
    if (open) {
      setToken("");
      setAllowFrom("");
      setError(null);
      setConnectedAs(null);
      setInviteUrl(null);
    }
  }, [open]);

  const openDevPortal = () => {
    void window.electronAPI?.ui.openExternalUrl("https://discord.com/developers/applications");
  };
  const openInvite = () => {
    if (inviteUrl) void window.electronAPI?.ui.openExternalUrl(inviteUrl);
  };

  const connect = async () => {
    const trimmed = token.trim();
    if (!trimmed || !workspaceId) return;
    setError(null);
    try {
      const validation = await validateMutation.mutateAsync({
        platform: "discord",
        token: trimmed,
      });
      if (!validation.ok) {
        setError(
          validation.error || "That token didn't work — double-check you pasted the whole thing.",
        );
        return;
      }
      const allow = allowFrom
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      await createMutation.mutateAsync({
        platform: "discord",
        token: trimmed,
        allowFrom: allow.length > 0 ? allow : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: remoteApiQuery.channels.key() });
      setConnectedAs(validation.bot_username ?? null);
      setInviteUrl(validation.invite_url ?? null);
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
          {connectedAs !== null ? (
            <div className="grid place-items-center gap-3 py-4 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-500">
                <Check className="size-6" />
              </span>
              <div className="text-base font-semibold text-foreground">
                Connected{connectedAs ? ` as ${connectedAs}` : ""}
              </div>
              <p className="max-w-xs text-sm text-muted-foreground">
                Add the bot to a server, then DM it or @mention it there — your agent will reply
                right in Discord.
              </p>
              {inviteUrl ? (
                <Button className="mt-1" onClick={openInvite} size="sm" variant="outline">
                  Add bot to a server
                </Button>
              ) : null}
              <Button className="mt-1" onClick={() => onOpenChange(false)} size="sm">
                Done
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="grid size-8 place-items-center overflow-hidden rounded-lg border border-border bg-background p-1.5">
                  <ChannelBrandIcon className="size-full" platform="discord" />
                </span>
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  Connect Discord
                </DialogPrimitive.Title>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Create a free Discord bot, then paste its token here. Takes a couple of minutes.
              </p>
              <ol className="mt-3 grid gap-1.5 text-sm text-foreground/90">
                <li>
                  1. Open the Discord <span className="font-medium">Developer Portal</span> and create
                  a New Application.
                </li>
                <li>
                  2. Open the <span className="font-medium">Bot</span> tab, click{" "}
                  <span className="font-medium">Reset Token</span>, and copy the token.
                </li>
                <li>3. Paste it below — that's it. No privileged intents to toggle.</li>
              </ol>
              <Button className="mt-2" onClick={openDevPortal} size="xs" variant="outline">
                Open Discord Developer Portal
              </Button>
              <div className="mt-4 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="discord-token">
                  Bot token
                </label>
                <Input
                  autoFocus
                  id="discord-token"
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void connect();
                    }
                  }}
                  placeholder="Paste your bot token"
                  value={token}
                />
              </div>
              <div className="mt-3 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="discord-allow">
                  Who can message it <span className="text-muted-foreground/70">(optional)</span>
                </label>
                <Input
                  id="discord-allow"
                  onChange={(e) => setAllowFrom(e.target.value)}
                  placeholder="username or user id — leave empty to allow anyone"
                  value={allowFrom}
                />
              </div>
              {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
                  Cancel
                </Button>
                <Button
                  disabled={!token.trim() || busy}
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
