import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Copy } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { ChannelBrandIcon } from "@/lib/channelBrandIcon";
import { remoteApiQuery } from "@/lib/remoteApiQuery";

/**
 * App manifest the user pastes into Slack's "Create app from manifest" flow. It
 * pre-declares every scope + event + Socket Mode, so the only manual step left is
 * copying the two tokens — the lowest-friction Slack onboarding path.
 */
const SLACK_APP_MANIFEST = {
  display_information: { name: "holaOS Agent" },
  features: {
    bot_user: { display_name: "holaboss", always_online: true },
  },
  oauth_config: {
    scopes: {
      bot: [
        "app_mentions:read",
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
        "chat:write",
        "files:read",
        "reactions:read",
        "reactions:write",
        "users:read",
      ],
    },
  },
  settings: {
    event_subscriptions: {
      bot_events: [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
      ],
    },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
  },
};

/**
 * Guided Slack connect wizard. The user creates a Slack app from the prefilled
 * manifest (one paste → all scopes + Socket Mode), then pastes the bot token
 * (`xoxb-…`) and app-level token (`xapp-…`). We validate both server-side before
 * persisting.
 */
export function ConnectSlackDialog({
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
  const [appToken, setAppToken] = useState("");
  const [allowFrom, setAllowFrom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [connectedAs, setConnectedAs] = useState<string | null>(null);

  const validateMutation = useMutation(remoteApiQuery.channels.validate.mutationOptions());
  const createMutation = useMutation(remoteApiQuery.channels.create.mutationOptions());
  const busy = validateMutation.isPending || createMutation.isPending;

  useEffect(() => {
    if (open) {
      setToken("");
      setAppToken("");
      setAllowFrom("");
      setError(null);
      setCopied(false);
      setConnectedAs(null);
    }
  }, [open]);

  const copyManifest = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(SLACK_APP_MANIFEST, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy — select the manifest in Slack and paste manually.");
    }
  };
  const openSlackApps = () => {
    void window.electronAPI?.ui.openExternalUrl("https://api.slack.com/apps?new_app=1");
  };

  const connect = async () => {
    const bot = token.trim();
    const app = appToken.trim();
    if (!bot || !app || !workspaceId) return;
    setError(null);
    try {
      const validation = await validateMutation.mutateAsync({
        platform: "slack",
        token: bot,
        appToken: app,
      });
      if (!validation.ok) {
        setError(validation.error || "Those tokens didn't work — double-check both of them.");
        return;
      }
      const allow = allowFrom
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      await createMutation.mutateAsync({
        platform: "slack",
        token: bot,
        appToken: app,
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
        <DialogPrimitive.Popup className="fixed top-[8%] left-1/2 z-[100] max-h-[84vh] w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-y-auto rounded-2xl border border-border bg-popover p-5 shadow-2xl outline-none">
          {connectedAs !== null ? (
            <div className="grid place-items-center gap-3 py-4 text-center">
              <span className="grid size-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-500">
                <Check className="size-6" />
              </span>
              <div className="text-base font-semibold text-foreground">
                Connected{connectedAs ? ` as ${connectedAs}` : ""}
              </div>
              <p className="max-w-xs text-sm text-muted-foreground">
                DM the app in Slack, or @mention it in a channel it's been added to — your agent
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
                  <ChannelBrandIcon className="size-full" platform="slack" />
                </span>
                <DialogPrimitive.Title className="text-base font-semibold text-foreground">
                  Connect Slack
                </DialogPrimitive.Title>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                Create a Slack app from our manifest — it sets up everything except the two tokens.
              </p>
              <ol className="mt-3 grid gap-1.5 text-sm text-foreground/90">
                <li>1. Copy the app manifest, then open Slack and create a new app from it.</li>
                <li>
                  2. Click <span className="font-medium">Install to Workspace</span>, then copy the
                  Bot User OAuth Token (<span className="text-muted-foreground">xoxb-…</span>).
                </li>
                <li>
                  3. In Basic Information → App-Level Tokens, generate a token with{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">connections:write</code> (
                  <span className="text-muted-foreground">xapp-…</span>).
                </li>
              </ol>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button onClick={() => void copyManifest()} size="xs" variant="outline">
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? "Copied" : "Copy app manifest"}
                </Button>
                <Button onClick={openSlackApps} size="xs" variant="outline">
                  Open Slack → Create app
                </Button>
              </div>
              <div className="mt-4 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="slack-bot">
                  Bot token (xoxb-…)
                </label>
                <Input
                  autoFocus
                  id="slack-bot"
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste the Bot User OAuth Token"
                  value={token}
                />
              </div>
              <div className="mt-3 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="slack-app">
                  App-level token (xapp-…)
                </label>
                <Input
                  id="slack-app"
                  onChange={(e) => setAppToken(e.target.value)}
                  placeholder="Paste the App-Level Token"
                  value={appToken}
                />
              </div>
              <div className="mt-3 grid gap-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="slack-allow">
                  Who can message it <span className="text-muted-foreground/70">(optional)</span>
                </label>
                <Input
                  id="slack-allow"
                  onChange={(e) => setAllowFrom(e.target.value)}
                  placeholder="Slack user id — leave empty to allow anyone"
                  value={allowFrom}
                />
              </div>
              {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
                  Cancel
                </Button>
                <Button
                  disabled={!token.trim() || !appToken.trim() || busy}
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
