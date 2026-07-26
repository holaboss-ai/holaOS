import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ChannelModelOption,
  ChannelModelPicker,
} from "@/components/harness/ChannelModelPicker";
import { HarnessPicker } from "@/components/harness/HarnessPicker";
import { useAvailableHarnesses } from "@/components/harness/useAvailableHarnesses";
import { ConnectDeviceFlowDialog } from "@/components/integration/ConnectDeviceFlowDialog";
import { ConnectDiscordDialog } from "@/components/integration/ConnectDiscordDialog";
import { ConnectQQDialog } from "@/components/integration/ConnectQQDialog";
import { ConnectSlackDialog } from "@/components/integration/ConnectSlackDialog";
import { ConnectTelegramDialog } from "@/components/integration/ConnectTelegramDialog";
import { ConnectWecomDialog } from "@/components/integration/ConnectWecomDialog";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/ui/page-shell";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ArrowLeft,
  Eye,
  Info,
  Loader2,
  MoreHorizontal,
  Search,
  Plus,
  Send,
  Sun,
  Unplug,
} from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChannelSessionMirror } from "./ChannelSessionMirror";
import { ChannelBrandIcon, hasChannelBrandIcon } from "@/lib/channelBrandIcon";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

/** The platforms a user can connect, in display order. One source of truth for
 *  the provider grid + the connect-dialog state (avoids the old 2× button dup). */
type ConnectKind =
  | "telegram"
  | "feishu"
  | "dingtalk"
  | "discord"
  | "slack"
  | "qq"
  | "wecom"
  | "wechat";

const PROVIDERS: { id: ConnectKind; name: string; hint: string }[] = [
  { id: "telegram", name: "Telegram", hint: "Bot token from @BotFather" },
  { id: "feishu", name: "Feishu / Lark", hint: "Scan a QR — no console" },
  { id: "dingtalk", name: "DingTalk", hint: "Scan a QR — no console" },
  { id: "discord", name: "Discord", hint: "Bot token + invite link" },
  { id: "slack", name: "Slack", hint: "App manifest + tokens" },
  { id: "qq", name: "QQ", hint: "App ID & secret" },
  { id: "wecom", name: "WeCom", hint: "BotID + Secret" },
  { id: "wechat", name: "WeChat", hint: "Scan to log in" },
];

function platformName(platform: string): string {
  return PROVIDERS.find((p) => p.id === platform)?.name ?? platform;
}

function channelLabel(channel: { platform: string; bot_username: string | null }): string {
  if (!channel.bot_username) return `${platformName(channel.platform)} bot`;
  return channel.platform === "telegram" ? `@${channel.bot_username}` : channel.bot_username;
}

/** Abnormal-state pill only — a connected channel stays quiet (the section
 *  header already says "Connected"), so status ink is reserved for problems. */
function StatusPill({ status }: { status: string }) {
  if (status === "connected") return null;
  const error = status === "error";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px]",
        error ? "text-destructive" : "text-amber-600 dark:text-amber-400",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          error ? "bg-destructive" : "bg-amber-500",
        )}
      />
      {error ? "Error" : "Pending"}
    </span>
  );
}

/** Human label for a channel conversation. The runtime's title is chat title
 *  or counterpart name; when neither exists, describe the chat rather than
 *  leaking the raw platform key (wxid/openid-style ids mean nothing here). */
function conversationTitle(session: {
  title: string | null;
  chat_type: string | null;
  conversation_key: string;
}): string {
  if (session.title?.trim()) return session.title;
  const type = session.chat_type?.trim().toLowerCase() ?? "";
  if (type === "dm") return "Direct message";
  if (type === "group" || type === "channel") return "Group chat";
  return `Chat ${session.conversation_key.slice(0, 8)}…`;
}

function relativeActivityTime(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  const diffMin = Math.round((Date.now() - parsed) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

/** Liveness proof on the row: how many conversations this channel has and
 *  when it last spoke. Until the first conversation, carries the "message it
 *  to test" onboarding nudge instead of instructional boilerplate. */
function ChannelActivitySummary({
  connectionId,
  platform,
  enabled,
}: {
  connectionId: string;
  platform: string;
  enabled: boolean;
}) {
  const sessionsQuery = useQuery(
    remoteApiQuery.channels.listSessions.queryOptions({
      input: { connectionId },
      enabled,
      staleTime: 30_000,
    }),
  );
  if (!enabled || sessionsQuery.isLoading || !sessionsQuery.data) return null;
  const sessions = sessionsQuery.data.sessions;
  if (sessions.length === 0) {
    return (
      <span className="truncate text-xs text-muted-foreground">
        Message it on {platformName(platform)} to start
      </span>
    );
  }
  const activeTimes = sessions
    .map((session) => session.last_active_at)
    .filter((v): v is string => Boolean(v))
    .sort();
  const latest = activeTimes[activeTimes.length - 1] ?? null;
  const when = relativeActivityTime(latest);
  // The overwhelmingly common case is a single DM with the bot — there the
  // only interesting fact is freshness, so show just the time. A chat count
  // appears only once there genuinely are several (groups, multiple DMs).
  const parts = [
    sessions.length > 1 ? `${sessions.length} chats` : null,
    when,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <span className="truncate text-xs text-muted-foreground">
      {parts.join(" · ")}
    </span>
  );
}

/**
 * Connectors validated end-to-end against the live platform. Anything NOT in this
 * set — including every newly-added IM — gets a "not yet verified" badge until it
 * is proven out and added here. Deny-by-default on purpose: new connectors flag
 * themselves as unverified automatically.
 */
const VERIFIED_PLATFORMS = new Set([
  "telegram",
  "feishu",
  "lark",
  "discord",
  "wechat",
]);

function isChannelVerified(platform: string): boolean {
  return VERIFIED_PLATFORMS.has(platform);
}

/**
 * The square brand badge used for connected rows, the provider grid, and the
 * empty-state cluster. The "not yet verified" signal lives in a quiet inline
 * {@link BetaTag} next to the platform name — not as a loud corner marker on
 * every icon.
 */
function ChannelBadge({ platform, className }: { platform: string; className?: string }) {
  return (
    <span className={cn("relative shrink-0", className)}>
      {hasChannelBrandIcon(platform) ? (
        <span className="grid size-full place-items-center overflow-hidden rounded-lg border border-border bg-background p-1.5">
          <ChannelBrandIcon className="size-full" platform={platform} />
        </span>
      ) : (
        <span className="grid size-full place-items-center rounded-lg bg-sky-500/10 text-sky-500">
          <Send className="size-4" />
        </span>
      )}
    </span>
  );
}

/** Quiet tag for connectors not yet validated end-to-end against the platform. */
function BetaTag() {
  return (
    <span
      className="shrink-0 rounded border border-border px-1 py-px text-[9px] font-medium uppercase leading-none tracking-wide text-muted-foreground"
      title="Not yet verified end-to-end"
    >
      Beta
    </span>
  );
}

/**
 * The model options + inherited-default label for a channel, keyed by its harness.
 * A CLI harness (claude-code/codex) ships its own model namespace in
 * `supported_models`; pi/Hola has none, so its models come from the runtime's
 * configured provider catalogue and its default from `runtimeConfig.defaultModel`.
 */
function channelModelChoices(
  harnessId: string,
  harnesses: HarnessAvailabilityEntryPayload[],
  runtimeConfig: RuntimeConfigPayload | null | undefined,
): { options: ChannelModelOption[]; defaultLabel: string } {
  const supported = harnesses.find((h) => h.id === harnessId)?.supported_models ?? [];
  if (supported.length > 0) {
    const options = supported.map((m) => ({ id: m.id, label: m.label }));
    const def = supported.find((m) => m.default) ?? supported[0];
    return { options, defaultLabel: def?.label ?? "harness default" };
  }
  const options = (runtimeConfig?.providerModelGroups ?? []).flatMap((group) =>
    group.models.map((m) => ({ id: m.token, label: m.label ?? m.token })),
  );
  const defaultId = runtimeConfig?.defaultModel ?? null;
  const defaultLabel =
    options.find((o) => o.id === defaultId)?.label ?? defaultId ?? "workspace default";
  return { options, defaultLabel };
}

/** The per-channel model picker, scoped to the channel's current harness. */
function ChannelModelControl({
  channel,
  harnesses,
  runtimeConfig,
  disabled,
  onChange,
}: {
  channel: { harness: string | null; model: string | null };
  harnesses: HarnessAvailabilityEntryPayload[];
  runtimeConfig: RuntimeConfigPayload | null | undefined;
  disabled?: boolean;
  onChange: (model: string | null) => void;
}) {
  const { options, defaultLabel } = channelModelChoices(
    channel.harness ?? "pi",
    harnesses,
    runtimeConfig,
  );
  return (
    <ChannelModelPicker
      value={channel.model}
      models={options}
      defaultLabel={defaultLabel}
      disabled={disabled}
      onChange={onChange}
      triggerClassName="text-xs"
    />
  );
}

/**
 * Channels — full-surface page (and embedded settings section). Connect a
 * messaging bot (Telegram, Feishu/Lark, DingTalk, Discord, Slack, QQ) and chat
 * with your agent like any contact. Lists connected channels with live status +
 * a guided per-platform connect wizard.
 */
export function ChannelsPane({ embedded = false }: { embedded?: boolean }) {
  const { selectedWorkspace, runtimeConfig } = useWorkspaceDesktop();
  const workspaceId = selectedWorkspace?.id?.trim() ?? "";
  const queryClient = useQueryClient();
  const [connect, setConnect] = useState<ConnectKind | null>(null);
  // Confirm before switching a channel's agent: the switch rebinds the channel
  // to a fresh harness session, so the ongoing conversation's context is lost
  // (message history is kept). Holds the pending switch until confirmed.
  const [pendingHarnessSwitch, setPendingHarnessSwitch] = useState<{
    connectionId: string;
    current: string;
    harness: string;
  } | null>(null);
  const [viewing, setViewing] = useState<{ connectionId: string; label: string } | null>(null);

  const channelsQuery = useQuery(
    remoteApiQuery.channels.list.queryOptions({
      input: {},
      enabled: Boolean(workspaceId),
    }),
  );
  const deleteMutation = useMutation(remoteApiQuery.channels.delete.mutationOptions());
  const setHarnessMutation = useMutation(
    remoteApiQuery.channels.setHarness.mutationOptions(),
  );
  const setModelMutation = useMutation(
    remoteApiQuery.channels.setModel.mutationOptions(),
  );
  const channels = channelsQuery.data?.channels ?? [];
  const loading = Boolean(workspaceId) && channelsQuery.isLoading;

  // Only offer harnesses actually installed where the runtime runs — a channel
  // can't usefully run under a CLI that isn't there. pi/Hola is always present.
  const { harnesses, isLoading: harnessesLoading } = useAvailableHarnesses(
    workspaceId || null,
  );
  const availableHarnesses = useMemo(
    () => harnesses.filter((entry) => entry.available),
    [harnesses],
  );

  // Keep-awake mirrors Settings › Power (same machine-level preference, applied
  // by the main process). Surfaced here too because connected channels only
  // receive and reply to messages while the machine is awake. Local state
  // hydrates from the persisted value on mount and reconciles with whatever the
  // main process actually applied on write, so it stays consistent with the
  // Settings switch across mounts.
  const [keepAwake, setKeepAwake] = useState(true);
  // Only nudge when the preference was off on mount; keep the row visible
  // after flipping it on so the switch doesn't vanish under the cursor.
  const [showKeepAwakeCard, setShowKeepAwakeCard] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.ui
      .getKeepAwakeEnabled()
      .then((enabled) => {
        if (cancelled) return;
        setKeepAwake(enabled);
        if (!enabled) setShowKeepAwakeCard(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const handleKeepAwakeChange = useCallback((enabled: boolean) => {
    setKeepAwake(enabled);
    void window.electronAPI?.ui
      .setKeepAwakeEnabled(enabled)
      .then((persisted) => setKeepAwake(persisted))
      .catch(() => undefined);
  }, []);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: remoteApiQuery.channels.key() });

  const [pendingDisconnect, setPendingDisconnect] = useState<{
    connectionId: string;
    label: string;
  } | null>(null);

  const disconnect = async (connectionId: string) => {
    await deleteMutation.mutateAsync({ connectionId });
    await invalidate();
  };

  const harnessLabel = (id: string) =>
    harnesses.find((h) => h.id === id)?.display_name ?? id;

  // Selecting a harness doesn't apply immediately — it opens a confirm first,
  // because switching drops the channel conversation's live context. A no-op
  // (same harness) is ignored.
  const requestHarnessChange = (
    connectionId: string,
    current: string,
    harness: string,
  ) => {
    if (harness === current) {
      return;
    }
    setPendingHarnessSwitch({ connectionId, current, harness });
  };

  const changeHarness = async (connectionId: string, harness: string) => {
    await setHarnessMutation.mutateAsync({ connectionId, harness });
    await invalidate();
  };

  // Changing the model — unlike a harness switch — doesn't rebind the session or
  // drop conversation context, so it applies straight to the channel's next run
  // with no confirmation. `model: null` clears the override (inherit the default).
  const changeModel = async (connectionId: string, model: string | null) => {
    await setModelMutation.mutateAsync({ connectionId, model });
    await invalidate();
  };

  const sectionLabel = (text: string) => (
    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
      {text}
    </div>
  );

  // Sort into two sections — verified (non-beta) channels first, then beta —
  // and alphabetically by name within each section.
  const verifiedRank = (platform: string) => (isChannelVerified(platform) ? 0 : 1);
  const sortedProviders = [...PROVIDERS].sort(
    (a, b) => verifiedRank(a.id) - verifiedRank(b.id) || a.name.localeCompare(b.name),
  );
  const sortedChannels = [...channels].sort(
    (a, b) =>
      verifiedRank(a.platform) - verifiedRank(b.platform) ||
      platformName(a.platform).localeCompare(platformName(b.platform)) ||
      channelLabel(a).localeCompare(channelLabel(b)),
  );

  const providerGrid = (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {sortedProviders.map((provider) => (
        <button
          className="group flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-foreground/20 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!workspaceId}
          key={provider.id}
          onClick={() => setConnect(provider.id)}
          type="button"
        >
          <ChannelBadge className="size-9" platform={provider.id} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-foreground">{provider.name}</span>
              {isChannelVerified(provider.id) ? null : <BetaTag />}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{provider.hint}</span>
          </span>
          <Plus className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
        </button>
      ))}
    </div>
  );

  const connectedList = (
    <SettingsCard>
      {sortedChannels.map((channel) => {
        const isConnected = channel.status === "connected";
        const label = channelLabel(channel);
        return (
          <div
            className="relative flex items-center justify-between gap-3 px-4 py-3 transition-colors has-[button.channel-row-open:hover]:bg-accent"
            key={channel.connection_id}
          >
            {isConnected ? (
              <button
                type="button"
                aria-label={`Open activity for ${label}`}
                onClick={() =>
                  setViewing({
                    connectionId: channel.connection_id,
                    label,
                  })
                }
                className="channel-row-open absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            ) : null}
            <div className="pointer-events-none flex min-w-0 items-center gap-3">
              <ChannelBadge className="size-8" platform={channel.platform} />
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <span className="truncate">{label}</span>
                  {isChannelVerified(channel.platform) ? null : <BetaTag />}
                  <StatusPill status={channel.status} />
                </div>
                <div className="pointer-events-auto relative flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="shrink-0">
                    {platformName(channel.platform)}
                  </span>
                  {isConnected ? (
                    <>
                      <span aria-hidden>·</span>
                      <span title="Agent that answers this channel">
                        <HarnessPicker
                          value={channel.harness ?? "pi"}
                          harnesses={availableHarnesses}
                          isLoading={harnessesLoading}
                          disabled={setHarnessMutation.isPending}
                          onChange={(id) =>
                            requestHarnessChange(
                              channel.connection_id,
                              channel.harness ?? "pi",
                              id,
                            )
                          }
                          inline
                          className="text-xs"
                        />
                      </span>
                      <span aria-hidden>·</span>
                      <span title="Model this channel's agent runs use">
                        <ChannelModelControl
                          channel={channel}
                          harnesses={harnesses}
                          runtimeConfig={runtimeConfig}
                          disabled={setModelMutation.isPending}
                          onChange={(model) =>
                            changeModel(channel.connection_id, model)
                          }
                        />
                      </span>
                    </>
                  ) : (
                    <span className="truncate">
                      {channel.status_detail || "Not connected"}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="relative flex shrink-0 items-center gap-2.5">
              <ChannelActivitySummary
                connectionId={channel.connection_id}
                platform={channel.platform}
                enabled={isConnected}
              />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Actions for ${label}`}
                      className="text-muted-foreground hover:text-foreground"
                    />
                  }
                >
                  <MoreHorizontal className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={6} className="w-44">
                  {isConnected ? (
                    <DropdownMenuItem
                      onClick={() =>
                        setViewing({
                          connectionId: channel.connection_id,
                          label,
                        })
                      }
                    >
                      <Eye className="size-3.5" />
                      Open activity
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={deleteMutation.isPending}
                    onClick={() =>
                      setPendingDisconnect({
                        connectionId: channel.connection_id,
                        label,
                      })
                    }
                  >
                    <Unplug className="size-3.5" />
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}
    </SettingsCard>
  );

  const loadingState = (
    <SettingsCard>
      {[0, 1].map((i) => (
        <div className="flex items-center gap-3 px-4 py-3" key={i}>
          <div className="size-8 shrink-0 animate-pulse rounded-lg bg-muted-foreground/15" />
          <div className="grid gap-1.5">
            <div className="h-3 w-32 animate-pulse rounded bg-muted-foreground/15" />
            <div className="h-2.5 w-48 animate-pulse rounded bg-muted-foreground/10" />
          </div>
        </div>
      ))}
    </SettingsCard>
  );

  const emptyState = (
    <div className="rounded-2xl border border-dashed border-border bg-card/40 px-6 py-10 text-center">
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {PROVIDERS.map((provider) => (
          <ChannelBadge className="size-9" key={provider.id} platform={provider.id} />
        ))}
      </div>
      <h3 className="mt-4 text-base font-semibold text-foreground">No channels connected yet</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        Pick an app below to connect a bot. It takes about a minute — then your agent replies right
        there, with images, files, and live status.
      </p>
    </div>
  );

  // Shared by the index body and the detail branch — both can trigger the
  // agent-switch and remove confirmations.
  const confirmDialogs = (
    <>
      <ConfirmDialog
        confirmLabel="Switch agent"
        description={
          pendingHarnessSwitch
            ? `New messages will run on ${harnessLabel(pendingHarnessSwitch.harness)} instead of ${harnessLabel(pendingHarnessSwitch.current)}. This channel keeps its message history, and the new agent is handed a summary of the recent conversation to pick up from — though it may have partial or slightly deprecated context, not the full live thread.`
            : ""
        }
        onConfirm={() => {
          if (pendingHarnessSwitch) {
            void changeHarness(
              pendingHarnessSwitch.connectionId,
              pendingHarnessSwitch.harness,
            );
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setPendingHarnessSwitch(null);
          }
        }}
        open={Boolean(pendingHarnessSwitch)}
        title="Switch this channel's agent?"
      />
      <ConfirmDialog
        confirmLabel="Remove"
        description={
          pendingDisconnect
            ? `${pendingDisconnect.label} will stop receiving and replying to messages until you connect it again.`
            : ""
        }
        destructive
        onConfirm={() => {
          if (pendingDisconnect) {
            void disconnect(pendingDisconnect.connectionId);
          }
          setPendingDisconnect(null);
        }}
        onOpenChange={(open) => {
          if (!open) setPendingDisconnect(null);
        }}
        open={Boolean(pendingDisconnect)}
        title="Remove this channel?"
      />
    </>
  );

  const body = (
    <div className="grid gap-6">
      {/* Full-surface only: the embedded Settings view already carries this
          under Settings › Power, so don't double it up there. */}
      {!embedded && showKeepAwakeCard ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-border bg-fg-2 px-3 py-2">
          <Info className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
            Channels can only receive and reply while your computer is awake.
          </p>
          <span className="flex shrink-0 items-center gap-1.5">
            <Sun
              className={cn(
                "size-3.5 transition-colors",
                keepAwake ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span className="text-xs font-medium text-foreground">
              Keep awake
            </span>
            <Switch
              checked={keepAwake}
              onCheckedChange={handleKeepAwakeChange}
              aria-label="Keep computer awake"
            />
          </span>
        </div>
      ) : null}

      {loading ? (
        loadingState
      ) : channels.length === 0 ? (
        <div className="grid gap-5">
          {emptyState}
          <div className="grid gap-2.5">
            {sectionLabel("Add a channel")}
            {providerGrid}
          </div>
        </div>
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-2.5">
            {sectionLabel(`Connected · ${channels.length}`)}
            {connectedList}
          </div>
          <div className="grid gap-2.5">
            {sectionLabel("Add a channel")}
            {providerGrid}
          </div>
        </div>
      )}

      <ConnectTelegramDialog
        onConnected={invalidate}
        onOpenChange={(o) => setConnect(o ? "telegram" : null)}
        open={connect === "telegram"}
        workspaceId={workspaceId}
      />
      <ConnectDeviceFlowDialog
        onConnected={invalidate}
        onOpenChange={(o) => setConnect(o ? "feishu" : null)}
        open={connect === "feishu"}
        platform="feishu"
        workspaceId={workspaceId}
      />
      <ConnectDeviceFlowDialog
        onConnected={invalidate}
        onOpenChange={(o) => setConnect(o ? "dingtalk" : null)}
        open={connect === "dingtalk"}
        platform="dingtalk"
        workspaceId={workspaceId}
      />
      <ConnectDiscordDialog
        onConnected={invalidate}
        onOpenChange={(o) => setConnect(o ? "discord" : null)}
        open={connect === "discord"}
        workspaceId={workspaceId}
      />
      <ConnectSlackDialog
        onConnected={invalidate}
        onOpenChange={(o) => setConnect(o ? "slack" : null)}
        open={connect === "slack"}
        workspaceId={workspaceId}
      />
      <ConnectQQDialog
        onConnected={invalidate}
        onOpenChange={(o) => setConnect(o ? "qq" : null)}
        open={connect === "qq"}
        workspaceId={workspaceId}
      />
      <ConnectWecomDialog
        onConnected={invalidate}
        onOpenChange={(o) => setConnect(o ? "wecom" : null)}
        open={connect === "wecom"}
        workspaceId={workspaceId}
      />
      <ConnectDeviceFlowDialog
        onConnected={invalidate}
        onOpenChange={(o) => setConnect(o ? "wechat" : null)}
        open={connect === "wechat"}
        platform="wechat"
        workspaceId={workspaceId}
      />
      {confirmDialogs}
    </div>
  );

  const detailChannel = viewing
    ? (channels.find((c) => c.connection_id === viewing.connectionId) ?? null)
    : null;

  if (detailChannel) {
    const detail = (
      <>
        <ChannelDetailView
          channel={detailChannel}
          workspaceId={workspaceId}
          harnesses={availableHarnesses}
          harnessesLoading={harnessesLoading}
          harnessSwitchPending={setHarnessMutation.isPending}
          onHarnessChange={(id) =>
            requestHarnessChange(
              detailChannel.connection_id,
              detailChannel.harness ?? "pi",
              id,
            )
          }
          runtimeConfig={runtimeConfig}
          modelSwitchPending={setModelMutation.isPending}
          onModelChange={(model) =>
            changeModel(detailChannel.connection_id, model)
          }
          onBack={() => setViewing(null)}
          onRemove={() =>
            setPendingDisconnect({
              connectionId: detailChannel.connection_id,
              label: channelLabel(detailChannel),
            })
          }
        />
        {confirmDialogs}
      </>
    );
    if (embedded) {
      return (
        <div className="flex h-[70vh] min-h-[420px] flex-col px-1">{detail}</div>
      );
    }
    return (
      <div className="flex h-full flex-col">
        <div className="mx-auto flex w-full min-h-0 max-w-5xl flex-1 flex-col px-6 py-6">
          {detail}
        </div>
      </div>
    );
  }

  if (embedded) return <div className="px-1">{body}</div>;
  return <PageShell title="Channels">{body}</PageShell>;
}

interface ChannelDetailChannel {
  connection_id: string;
  platform: string;
  bot_username: string | null;
  status: string;
  status_detail: string | null;
  harness: string | null;
  model: string | null;
}

/**
 * In-pane detail for one connected channel: identity header (badge, name,
 * platform · answering agent) above a conversation rail + the full-fidelity
 * read-only session mirror. Replaces the old cramped activity dialog.
 */
function ChannelDetailView({
  channel,
  workspaceId,
  harnesses,
  harnessesLoading,
  harnessSwitchPending,
  onHarnessChange,
  runtimeConfig,
  modelSwitchPending,
  onModelChange,
  onBack,
  onRemove,
}: {
  channel: ChannelDetailChannel;
  workspaceId: string;
  harnesses: HarnessAvailabilityEntryPayload[];
  harnessesLoading: boolean;
  harnessSwitchPending: boolean;
  onHarnessChange: (harnessId: string) => void;
  runtimeConfig: RuntimeConfigPayload | null | undefined;
  modelSwitchPending: boolean;
  onModelChange: (model: string | null) => void;
  onBack: () => void;
  onRemove: () => void;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const sessionsQuery = useQuery(
    remoteApiQuery.channels.listSessions.queryOptions({
      input: { connectionId: channel.connection_id },
      enabled: Boolean(workspaceId),
      refetchInterval: 15_000,
    }),
  );
  const sessions = useMemo(
    () => sessionsQuery.data?.sessions ?? [],
    [sessionsQuery.data],
  );

  // Default to the most-recently-active conversation (list is newest first).
  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      setSelectedSessionId(sessions[0].session_id);
    }
  }, [sessions, selectedSessionId]);
  const activeSession =
    sessions.find((s) => s.session_id === selectedSessionId) ?? null;

  const label = channelLabel(channel);
  const harnessEntry = harnesses.find(
    (h) => h.id === (channel.harness ?? "pi"),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Channels
      </button>

      {/* One card, IM-style: contact header bar on top, transcript below —
          the whole surface reads as a chat window rather than a settings
          page with a preview attached. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <ChannelBadge className="size-9" platform={channel.platform} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {label}
                </h2>
                {isChannelVerified(channel.platform) ? null : <BetaTag />}
                <StatusPill status={channel.status} />
              </div>
              <div className="mt-px flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="shrink-0">
                  {platformName(channel.platform)}
                </span>
                <span aria-hidden>·</span>
                <span title="Agent that answers this channel">
                  <HarnessPicker
                    value={channel.harness ?? "pi"}
                    harnesses={harnesses}
                    isLoading={harnessesLoading}
                    disabled={harnessSwitchPending}
                    onChange={onHarnessChange}
                    inline
                    className="text-xs"
                  />
                </span>
                <span aria-hidden>·</span>
                <span title="Model this channel's agent runs use">
                  <ChannelModelControl
                    channel={channel}
                    harnesses={harnesses}
                    runtimeConfig={runtimeConfig}
                    disabled={modelSwitchPending}
                    onChange={onModelChange}
                  />
                </span>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {activeSession ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Search this conversation"
                      aria-pressed={searchOpen}
                      onClick={() => setSearchOpen((open) => !open)}
                      className={cn(
                        "text-muted-foreground hover:text-foreground",
                        searchOpen && "bg-accent text-foreground",
                      )}
                    />
                  }
                >
                  <Search className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>Search this conversation</TooltipContent>
              </Tooltip>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Actions for ${label}`}
                    className="text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <MoreHorizontal className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="w-44">
                <DropdownMenuItem variant="destructive" onClick={onRemove}>
                  <Unplug className="size-3.5" />
                  Remove channel
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
        {/* The rail only earns its space with something to switch between —
            the overwhelmingly common single-DM case gets a full-width mirror. */}
        {sessions.length > 1 ? (
          <div className="w-56 shrink-0 overflow-y-auto border-r border-border p-2">
            <ul className="grid gap-0.5">
              {sessions.map((session) => (
                <li key={session.session_id}>
                  <button
                    className={cn(
                      "w-full rounded-lg px-2.5 py-2 text-left transition-colors",
                      session.session_id === selectedSessionId
                        ? "bg-accent text-foreground"
                        : "text-foreground/80 hover:bg-accent/60",
                    )}
                    onClick={() => setSelectedSessionId(session.session_id)}
                    type="button"
                  >
                    <span className="block truncate text-sm font-medium">
                      {conversationTitle(session)}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {[
                        session.chat_type,
                        relativeActivityTime(session.last_active_at),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="min-w-0 flex-1 p-3">
          {activeSession ? (
            <ChannelSessionMirror
              key={activeSession.session_id}
              sessionId={activeSession.session_id}
              workspaceId={workspaceId}
              assistantLabel={harnessEntry?.display_name ?? "Agent"}
              harnessId={channel.harness ?? "pi"}
              replySurfaceLabel={platformName(channel.platform)}
              searchOpen={searchOpen}
              onCloseSearch={() => setSearchOpen(false)}
            />
          ) : sessionsQuery.isLoading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="grid h-full place-items-center px-8 text-center text-sm leading-6 text-muted-foreground">
              No conversations yet. Message the bot on{" "}
              {platformName(channel.platform)} and the conversation shows up
              here live.
            </div>
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              Select a conversation to watch it live.
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
