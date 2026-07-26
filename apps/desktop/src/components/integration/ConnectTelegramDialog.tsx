import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Send } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { remoteApiQuery } from "@/lib/remoteApiQuery";

/**
 * Guided Telegram connect wizard for non-technical users: walks through creating
 * a bot in Telegram, takes the pasted token, validates it server-side (so it can
 * confirm "Connected as @bot"), and persists the connection. No terminal, no env.
 */
export function ConnectTelegramDialog({
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

  const validateMutation = useMutation(remoteApiQuery.channels.validate.mutationOptions());
  const createMutation = useMutation(remoteApiQuery.channels.create.mutationOptions());
  const busy = validateMutation.isPending || createMutation.isPending;

  useEffect(() => {
    if (open) {
      setToken("");
      setAllowFrom("");
      setError(null);
      setConnectedAs(null);
    }
  }, [open]);

  const openBotFather = () => {
    void window.electronAPI?.ui.openExternalUrl("https://t.me/BotFather");
  };

  const connect = async () => {
    const trimmed = token.trim();
    if (!trimmed || !workspaceId) return;
    setError(null);
    try {
      const validation = await validateMutation.mutateAsync({ token: trimmed });
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
        token: trimmed,
        allowFrom: allow.length > 0 ? allow : undefined,
      });
      await queryClient.invalidateQueries({ queryKey: remoteApiQuery.channels.key() });
      setConnectedAs(validation.bot_username ?? null);
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
                Connected{connectedAs ? ` as @${connectedAs}` : ""}
              </div>
              <p className="max-w-xs text-sm text-muted-foreground">
                Open Telegram and send your bot a message — your agent will reply right there.
              </p>
              <Button className="mt-1" onClick={() => onOpenChange(false)} size="sm">
                Done
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="grid size-8 place-items-center rounded-lg bg-sky-500/10 text-sky-500">
                  <Send className="size-4" />
                </span>
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  Connect Telegram
                </DialogPrimitive.Title>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Create a free Telegram bot, then paste its token here. Takes about a minute.
              </p>
              <ol className="mt-3 grid gap-1.5 text-sm text-foreground/90">
                <li>
                  1. Open Telegram and message <span className="font-medium">@BotFather</span>.
                </li>
                <li>
                  2. Send <code className="rounded bg-muted px-1 py-0.5 text-xs">/newbot</code> and
                  follow the prompts.
                </li>
                <li>
                  3. Copy the token it gives you (looks like{" "}
                  <span className="text-muted-foreground">123456:ABC-…</span>).
                </li>
              </ol>
              <Button className="mt-2" onClick={openBotFather} size="xs" variant="outline">
                Open @BotFather in Telegram
              </Button>
              <div className="mt-4 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="tg-token">
                  Bot token
                </label>
                <Input
                  autoFocus
                  id="tg-token"
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
                <label className="text-xs font-medium text-muted-foreground" htmlFor="tg-allow">
                  Who can message it{" "}
                  <span className="text-muted-foreground/70">(optional)</span>
                </label>
                <Input
                  id="tg-allow"
                  onChange={(e) => setAllowFrom(e.target.value)}
                  placeholder="@yourusername — leave empty to allow anyone"
                  value={allowFrom}
                />
              </div>
              {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button
                  onClick={() => onOpenChange(false)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
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
