import { useQuery } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AtSign,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Feather,
  Gift,
  GiftFilled,
  Loader2,
  type IconType,
} from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  settingsOpenAtom,
  settingsSectionAtom,
} from "@/components/layout/shell/state/ui";
import { useStartChatDraft } from "@/components/layout/shell/useStartChatDraft";
import { billingRpcFetch } from "@/lib/app-sdk-client";
import { useDesktopAuthSession } from "@/lib/auth/authClient";
import { deriveAppBaseUrl } from "@/lib/billing/billing-links";
import { cn } from "@/lib/utils";

// The server sets these, and can change them without a desktop release. Kept as a
// fallback for a server that predates them in the response, so the explainer copy
// never renders a blank amount.
const FALLBACK_REFERRER_REWARD_CREDITS = 1000;
const FALLBACK_REFEREE_REWARD_CREDITS = 500;
const MS_PER_DAY = 86_400_000;

interface QuestView {
  id: string;
  loop: string;
  title: string;
  description: string;
  rewardCredits: number;
  completed: boolean;
  earnedCredits: number;
  endsAt?: string;
  limitedTime?: boolean;
}

interface ListQuestsResponse {
  quests: QuestView[];
  campaigns: QuestView[];
}

interface MyReferralLink {
  code: string;
  path: string;
  referrerCredits?: number;
  refereeCredits?: number;
}

interface ReferralView {
  id: string;
  state: string;
  vested: boolean;
  createdAt: string;
}

interface MyReferrals {
  pending: ReferralView[];
  vested: ReferralView[];
}

function useRewardsAuthEnabled(): boolean {
  const session = useDesktopAuthSession();
  return Boolean(session.data?.user?.id?.trim());
}

function useQuests(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["rewards", "listQuests"],
    queryFn: () => billingRpcFetch<ListQuestsResponse>("/rpc/rewards/listQuests"),
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
}

function useReferralShareLink(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["rewards", "referralLink"],
    queryFn: async () => {
      const [link, apiBaseUrl] = await Promise.all([
        billingRpcFetch<MyReferralLink>("/rpc/referral/myLink"),
        window.electronAPI.auth.getApiBaseUrl(),
      ]);
      const appBaseUrl = deriveAppBaseUrl(apiBaseUrl ?? "");
      return {
        url: new URL(link.path, appBaseUrl).toString(),
        referrerCredits:
          link.referrerCredits ?? FALLBACK_REFERRER_REWARD_CREDITS,
        refereeCredits: link.refereeCredits ?? FALLBACK_REFEREE_REWARD_CREDITS,
      };
    },
  });
}

function useMyReferrals(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["rewards", "myReferrals"],
    queryFn: () => billingRpcFetch<MyReferrals>("/rpc/referral/myReferrals"),
    refetchOnWindowFocus: true,
  });
}

function endsLabel(endsAt: string): string {
  const daysLeft = Math.ceil((new Date(endsAt).getTime() - Date.now()) / MS_PER_DAY);
  if (daysLeft <= 0) {
    return "Limited-time · Ends today";
  }
  if (daysLeft <= 7) {
    return `Limited-time · ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`;
  }
  const date = new Date(endsAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `Limited-time · Ends ${date}`;
}

function taskGlyph(quest: QuestView): IconType {
  if (isConnectAccountTask(quest)) {
    return AtSign;
  }
  if (quest.id === "first_published_post") {
    return Feather;
  }
  return Gift;
}

function ctaLabel(quest: QuestView): string {
  if (isConnectAccountTask(quest)) {
    return "Connect";
  }
  if (quest.id === "first_published_post") {
    return "Publish";
  }
  return "Start";
}

function QuestRow({
  quest,
  onAction,
  onViewEarned,
}: {
  quest: QuestView;
  onAction?: () => void;
  onViewEarned?: () => void;
}) {
  const done = quest.completed;
  const Glyph = taskGlyph(quest);

  let trailing: ReactNode;
  if (done && onViewEarned) {
    trailing = (
      <button
        aria-label="View in usage record"
        className="rounded-full transition-opacity hover:opacity-80"
        onClick={onViewEarned}
        type="button"
      >
        <Badge className="border-transparent bg-success/15 text-success" variant="outline">
          <Check aria-hidden />
          Earned
          <ChevronRight aria-hidden />
        </Badge>
      </button>
    );
  } else if (done) {
    trailing = (
      <Badge className="border-transparent bg-success/15 text-success" variant="outline">
        <Check aria-hidden />
        Earned
      </Badge>
    );
  } else {
    trailing = (
      <Button onClick={onAction} size="sm" type="button" variant="secondary">
        {ctaLabel(quest)}
      </Button>
    );
  }

  let toneClass = "border-border bg-card";
  if (done) {
    toneClass = "border-success/25 bg-success/[0.05]";
  } else if (quest.limitedTime) {
    toneClass = "border-primary/25 bg-primary/[0.05]";
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3.5 rounded-xl border p-4 transition-colors",
        toneClass,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-11 shrink-0 place-items-center rounded-xl [&_svg]:size-5",
          done ? "bg-success/15 text-success" : "bg-primary/10 text-primary",
        )}
      >
        {done ? <Check /> : <Glyph />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold text-foreground text-sm">{quest.title}</span>
        <span className="text-fg-64 text-xs">{quest.description}</span>
        <span className="mt-0.5 font-medium text-fg-72 text-xs tabular-nums tracking-[-0.02em]">
          +{quest.rewardCredits.toLocaleString()} credits
        </span>
        {quest.limitedTime && quest.endsAt ? (
          <span className="flex items-center gap-1 font-medium text-primary text-xs">
            <Clock aria-hidden className="size-3" />
            {endsLabel(quest.endsAt)}
          </span>
        ) : null}
      </div>
      {trailing}
    </div>
  );
}

// The reward engine's "channel" means a social posting account (a Composio
// integration), NOT the desktop's chat "Channels". Connecting an integration is
// agent-driven here, so this task — like the others — opens a fresh chat seeded
// with a concrete instruction that gets the agent to surface the connect card.
function isConnectAccountTask(quest: QuestView): boolean {
  return (
    quest.id === "connect_first_channel" ||
    quest.description === "Connect an account"
  );
}

function chatPromptFor(quest: QuestView): string {
  if (isConnectAccountTask(quest)) {
    return "Help me connect a social account — like X, LinkedIn, or Instagram — so you can post content for me. Walk me through connecting it.";
  }
  if (quest.id === "first_published_post") {
    return "Help me create and publish my first post. Ask me which connected channel to post to and what it should be about, then draft it and publish it for me.";
  }
  return `Help me complete this reward task: "${quest.title}". ${quest.description}`;
}

// Relabel the connect task for the desktop: "Channels" here means chat channels,
// so calling it "Connect a channel" sends people to the wrong place.
function displayQuest(quest: QuestView): QuestView {
  if (!isConnectAccountTask(quest)) {
    return quest;
  }
  return {
    ...quest,
    title: "Connect a social account",
    description: "Link X, LinkedIn, or another platform so your agent can post.",
  };
}

// The desktop has no brand-profile screen, and it's the weakest-fit get-started
// task, so it's hidden here (it still auto-pays server-side if ever earned).
const HIDDEN_QUEST_IDS = new Set(["complete_brand_profile"]);

// First version stays deliberately short: the limited-time campaign(s) plus the
// handful of get-started tasks. The habit loops (daily / streak / weekly) still
// pay out automatically server-side — they're just not surfaced here yet.
function TasksTab({ enabled }: { enabled: boolean }) {
  const { data, isLoading } = useQuests(enabled);
  const startChatDraft = useStartChatDraft();
  const setSettingsOpen = useSetAtom(settingsOpenAtom);
  const setSettingsSection = useSetAtom(settingsSectionAtom);

  const campaigns = data?.campaigns ?? [];
  const starters = (data?.quests ?? []).filter(
    (quest) => quest.loop === "activation" && !HIDDEN_QUEST_IDS.has(quest.id),
  );
  const tasks = [...campaigns, ...starters];

  const actionFor = (quest: QuestView) => () =>
    startChatDraft(chatPromptFor(quest), { returnTo: "rewards" });

  const openUsageRecord = () => {
    setSettingsSection("billing");
    setSettingsOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 pt-4">
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-4">
      {tasks.map((quest) => (
        <QuestRow
          key={quest.id}
          onAction={actionFor(quest)}
          onViewEarned={openUsageRecord}
          quest={displayQuest(quest)}
        />
      ))}
    </div>
  );
}

function InviteTab({ enabled }: { enabled: boolean }) {
  const { data: shareLink } = useReferralShareLink(enabled);
  const { data: referrals } = useMyReferrals(enabled);
  const [copied, setCopied] = useState(false);

  const pending = referrals?.pending ?? [];
  const vested = referrals?.vested ?? [];

  const copy = async () => {
    if (!shareLink) {
      return;
    }
    await navigator.clipboard.writeText(shareLink.url);
    setCopied(true);
    toast.success("Referral link copied");
    setTimeout(() => setCopied(false), 2000);
  };

  let copyIcon = <Loader2 aria-hidden className="size-4 animate-spin" />;
  if (shareLink) {
    copyIcon = copied ? (
      <Check aria-hidden className="size-4" />
    ) : (
      <Copy aria-hidden className="size-4" />
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-4">
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-2 font-medium text-foreground text-sm">
            <Gift aria-hidden className="size-4 text-primary" />
            Bring a friend
          </span>
          <span className="text-muted-foreground text-sm">
            Share your link. When a friend publishes their first post, you get{" "}
            {(
              shareLink?.referrerCredits ?? FALLBACK_REFERRER_REWARD_CREDITS
            ).toLocaleString()}{" "}
            and they get{" "}
            {(
              shareLink?.refereeCredits ?? FALLBACK_REFEREE_REWARD_CREDITS
            ).toLocaleString()}{" "}
            reward credits.
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Input
            aria-label="Your referral link"
            className="font-mono text-sm"
            readOnly
            value={shareLink?.url ?? ""}
          />
          <Button
            aria-label="Copy referral link"
            disabled={!shareLink}
            onClick={copy}
            type="button"
            variant="outline"
          >
            {copyIcon}
          </Button>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1.5">
            <Badge variant="secondary">{pending.length}</Badge>
            <span className="text-muted-foreground">Pending</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Badge>{vested.length}</Badge>
            <span className="text-muted-foreground">Vested</span>
          </span>
        </div>

        {pending.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Pending friends have signed up but not published yet — the reward vests on
            their first post.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function RewardsTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={cn(
        "relative rounded-full px-3.5 py-1.5 font-medium text-sm transition-colors",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      {active ? (
        <motion.span
          className="absolute inset-0 rounded-full bg-foreground/[0.08]"
          layoutId="rewardsTabPill"
          transition={{ type: "spring", stiffness: 500, damping: 38 }}
        />
      ) : null}
      <span className="relative">{children}</span>
    </button>
  );
}

export function RewardsPane() {
  const enabled = useRewardsAuthEnabled();
  const [tab, setTab] = useState("tasks");

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <PageHeader
        description="All the ways to earn credits in holaOS."
        maxWidth="3xl"
        title={
          <span className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-primary/12 text-primary [&_svg]:size-5">
              <GiftFilled aria-hidden />
            </span>
            Rewards
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 pb-12">
          {enabled ? (
            <>
              <div className="flex items-center gap-1">
                <RewardsTabButton
                  active={tab === "tasks"}
                  onClick={() => setTab("tasks")}
                >
                  Tasks
                </RewardsTabButton>
                <RewardsTabButton
                  active={tab === "invite"}
                  onClick={() => setTab("invite")}
                >
                  Invite
                </RewardsTabButton>
              </div>
              <AnimatePresence initial={false} mode="wait">
                <motion.div
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  initial={{ opacity: 0, y: 4 }}
                  key={tab}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  {tab === "tasks" ? (
                    <TasksTab enabled={enabled} />
                  ) : (
                    <InviteTab enabled={enabled} />
                  )}
                </motion.div>
              </AnimatePresence>
            </>
          ) : (
            <p className="pt-4 text-muted-foreground text-sm">
              Sign in to view your rewards and referral link.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
