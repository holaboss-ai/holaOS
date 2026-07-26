import { toast } from "sonner";
import { AppIcon } from "@/components/marketplace/AppIcon";
import { connectionAppEntry } from "@/lib/addApp";
import {
  invalidateAllIntegrationConnections,
  listAllIntegrationConnections,
} from "@/lib/listAllIntegrationConnections";
import {
  ArrowUp,
  Check,
  Loader2,
  Plus,
  Wand2,
} from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { useAddApp } from "@/lib/useAddApp";
import {
  composioToolkitSlugForProvider,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { OnboardingStageLayout } from "./OnboardingStageLayout";

// Curated first-touch integrations — the four that almost every holaOS
// user benefits from immediately. Keep this list short; the whole point
// of this stage is to NOT be a marketplace.
const HERO_INTEGRATIONS: Array<{
  slug: string;
  fallbackName: string;
  valueProp: string;
}> = [
  {
    slug: "gmail",
    fallbackName: "Gmail",
    valueProp: "Read your inbox and draft replies on your behalf.",
  },
  {
    slug: "github",
    fallbackName: "GitHub",
    valueProp: "Pull repos, review PRs, and triage issues with you.",
  },
  {
    slug: "notion",
    fallbackName: "Notion",
    valueProp: "Read and write across your workspace docs.",
  },
  {
    slug: "slack",
    fallbackName: "Slack",
    valueProp: "Catch up on threads and send messages for you.",
  },
];

interface IntegrationsOnboardingStageProps {
  stageIndex: number;
  totalStages: number;
  onBack?: () => void;
  onSkip: () => void;
  onNext: () => void;
  workspaceHint?: string | null;
}

export function IntegrationsOnboardingStage({
  stageIndex,
  totalStages,
  onBack,
  onSkip,
  onNext,
  workspaceHint,
}: IntegrationsOnboardingStageProps) {
  const { composioToolkitsByProvider } = useWorkspaceDesktop();

  const [connections, setConnections] = useState<
    IntegrationConnectionPayload[]
  >([]);
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result =
        await listAllIntegrationConnections();
      setConnections(result.connections);
    } catch {
      toast.error("Couldn't load your integrations", {
        description: "Check your connection and try again.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { add } = useAddApp();

  const connectedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const c of connections) {
      if (c.status === "active") {
        set.add(composioToolkitSlugForProvider(c.provider_id));
      }
    }
    return set;
  }, [connections]);

  const hasAnyConnection = connectedSlugs.size > 0;

  const heroItems = useMemo(
    () =>
      HERO_INTEGRATIONS.map((hero) => {
        const toolkit = composioToolkitsByProvider[hero.slug];
        return {
          slug: hero.slug,
          name: toolkit?.name ?? hero.fallbackName,
          logo: toolkit?.logo ?? null,
          valueProp: hero.valueProp,
        };
      }),
    [composioToolkitsByProvider],
  );

  const handleConnect = useCallback(
    async (slug: string, name: string) => {
      if (connectingSlug || connectedSlugs.has(slug)) return;
      setConnectingSlug(slug);
      try {
        const outcome = await add(connectionAppEntry(slug));
        if (outcome.kind === "connected") {
          invalidateAllIntegrationConnections();
          await refresh();
        }
      } finally {
        setConnectingSlug(null);
      }
    },
    [add, connectedSlugs, connectingSlug, refresh],
  );

  return (
    <OnboardingStageLayout
      left={
        <>
          <div className="space-y-2.5">
            <h2 className="font-serif text-[26px] leading-[1.15] tracking-tight text-foreground">
              Connect your tools
            </h2>
            <p className="max-w-[440px] text-[13.5px] text-muted-foreground leading-[1.55]">
              holaOS works best when it can read and act on the tools you
              already use. Connect the ones you use — or continue and add them
              from the Marketplace any time.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            {heroItems.map((item) => (
              <IntegrationCard
                isBusy={connectingSlug === item.slug}
                isConnected={connectedSlugs.has(item.slug)}
                key={item.slug}
                logo={item.logo}
                name={item.name}
                onConnect={() => void handleConnect(item.slug, item.name)}
                slug={item.slug}
                valueProp={item.valueProp}
              />
            ))}
          </div>
        </>
      }
      onBack={onBack}
      onPrimaryAction={onNext}
      onSkip={onSkip}
      // Optional — you can connect tools now or add them later from the Marketplace.
      primaryActionDisabled={false}
      primaryActionLabel={hasAnyConnection ? "Continue" : "Continue without tools"}
      right={<ComposerPreview />}
      stageIndex={stageIndex}
      totalStages={totalStages}
    />
  );
}

// ──────────────────────────────────────────────────────────────────────
// Integration card — left-side row

interface IntegrationCardProps {
  slug: string;
  name: string;
  logo: string | null;
  valueProp: string;
  isConnected: boolean;
  isBusy: boolean;
  onConnect: () => void;
}

function IntegrationCard({
  slug,
  name,
  logo,
  valueProp,
  isConnected,
  isBusy,
  onConnect,
}: IntegrationCardProps) {
  return (
    <motion.button
      aria-label={isConnected ? `${name} — connected` : `Connect ${name}`}
      className={cn(
        "group/integration-card relative flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
        isConnected
          ? "border-border/40 bg-muted/40"
          : "border-border bg-background hover:border-foreground/15 hover:bg-fg-2",
        isBusy && "cursor-progress opacity-90",
      )}
      disabled={isConnected || isBusy}
      onClick={onConnect}
      transition={{ type: "spring", stiffness: 420, damping: 28, mass: 0.5 }}
      type="button"
      whileHover={isConnected || isBusy ? undefined : { y: -1 }}
      whileTap={isConnected || isBusy ? undefined : { scale: 0.985 }}
    >
      <AppIcon
        appId={slug}
        iconUrl={logo}
        label={name}
        providerId={slug}
        size="card"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-foreground">
          {name}
        </div>
        <div className="truncate text-[11.5px] text-muted-foreground">
          {valueProp}
        </div>
      </div>
      <div className="shrink-0">
        <AnimatePresence initial={false} mode="wait">
          {isBusy ? (
            <motion.span
              animate={{ opacity: 1 }}
              className="grid size-7 place-items-center text-muted-foreground"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              key="busy"
              transition={{ duration: 0.18 }}
            >
              <Loader2 className="size-3.5 animate-spin" />
            </motion.span>
          ) : isConnected ? (
            <motion.span
              animate={{ opacity: 1, scale: 1 }}
              className="inline-flex items-center gap-1 rounded-md bg-success/12 px-2 py-0.5 text-[10.5px] font-medium text-success"
              exit={{ opacity: 0, scale: 0.9 }}
              initial={{ opacity: 0, scale: 0.9 }}
              key="connected"
              transition={{ type: "spring", stiffness: 520, damping: 26 }}
            >
              <Check className="size-3" />
              Connected
            </motion.span>
          ) : (
            <motion.span
              animate={{ opacity: 1 }}
              className="text-[11.5px] text-muted-foreground/70 transition-colors group-hover/integration-card:text-foreground"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              key="idle"
              transition={{ duration: 0.18 }}
            >
              Connect
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </motion.button>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Composer preview — composer skeleton

function ComposerPreview() {
  return (
    <div
      aria-hidden
      className="relative w-full overflow-hidden rounded-2xl bg-muted"
    >
      <div className="rounded-2xl border border-border/70 bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-8px_rgba(0,0,0,0.06)]">
        <div className="space-y-1.5 px-4 pt-4 pb-3.5">
          <div className="h-1.5 w-3/5 rounded-full bg-fg-8" />
          <div className="h-1.5 w-2/5 rounded-full bg-fg-6" />
          <div className="h-3" />
        </div>
        <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-1 text-muted-foreground">
          <ToolbarIconButton>
            <Plus className="size-3.5" strokeWidth={1.75} />
          </ToolbarIconButton>
          <ToolbarIconButton>
            <Wand2 className="size-3.5" strokeWidth={1.75} />
          </ToolbarIconButton>
          <div className="ml-auto flex items-center gap-1.5">
            <SkeletonPill width="w-16" withDot />
            <SkeletonPill width="w-11" />
            <span className="grid size-6 place-items-center rounded-full bg-primary text-primary-foreground">
              <ArrowUp className="size-3" strokeWidth={2} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolbarIconButton({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-6 place-items-center rounded ring-1 ring-border/60 text-muted-foreground/70">
      {children}
    </span>
  );
}

function SkeletonPill({
  width,
  withDot = false,
}: {
  width: string;
  withDot?: boolean;
}) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-1 rounded-md bg-fg-6 px-1.5 ${width}`}
    >
      {withDot ? (
        <span className="block size-2 shrink-0 rounded-full bg-fg-24" />
      ) : null}
      <span className="block h-1.5 flex-1 rounded-full bg-fg-12" />
    </span>
  );
}
