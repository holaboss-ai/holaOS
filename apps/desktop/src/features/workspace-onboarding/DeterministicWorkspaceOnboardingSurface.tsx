import { Check, LoaderCircle, Plug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

type HeroEntry = {
  slug: string;
  displayName: string;
  logo: string | null;
};

type ConnectPhase = "idle" | "connecting" | "done" | "error";

const HERO_PRIORITY = [
  "gmail",
  "googlecalendar",
  "slack",
  "notion",
  "linear",
  "github",
  "twitter",
  "linkedin",
];

const FIRST_RUN_STARTERS: Record<string, string> = {
  gmail:
    "Open my Gmail and summarize unread messages from the last 24 hours. Highlight anything urgent or that needs a reply today.",
  googlecalendar:
    "Pull my calendar for this week. Flag conflicts, prep that's needed before any meeting, and gaps where I could deep-work.",
  slack:
    "Scan my Slack DMs and channels — which threads are waiting on me to reply today?",
  notion:
    "Walk through my Notion workspace and tell me which pages I started but never finished, and which ones look like they could use a follow-up.",
  linear:
    "List my Linear issues — what's blocked, what's overdue, and what's been sitting in 'In Progress' the longest.",
  github:
    "Pull my GitHub assigned PRs and review requests. Flag what's been waiting the longest and what's likely blocking someone else.",
  twitter:
    "Look at my Twitter mentions and DMs from the last 24 hours. Surface anything I should reply to.",
  linkedin:
    "Pull my LinkedIn inbox and connection requests. Surface anything worth responding to today.",
  reddit:
    "Check my Reddit inbox and recent post activity. Surface threads I should reply to.",
  googledrive:
    "Look through my recent Google Drive activity. Flag anything shared with me that needs my attention.",
};

export function DeterministicWorkspaceOnboardingSurface() {
  const {
    selectedWorkspace,
    workspaceErrorMessage,
    composioToolkitsByProvider,
    connectIntegrationProvider,
    continueDeterministicOnboarding,
  } = useWorkspaceDesktop();

  const [heroEntries, setHeroEntries] = useState<HeroEntry[] | null>(null);
  const [phaseByToolkit, setPhaseByToolkit] = useState<
    Record<string, ConnectPhase>
  >({});
  const [errorByToolkit, setErrorByToolkit] = useState<
    Record<string, string | null>
  >({});
  const [isContinuing, setIsContinuing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response =
          await window.electronAPI.workspace.listIntegrationStoreCatalog();
        if (cancelled) return;
        const hero = response.entries.filter((e) => e.tier === "hero");
        const sorted = [...hero].sort((a, b) => {
          const ai = HERO_PRIORITY.indexOf(a.slug);
          const bi = HERO_PRIORITY.indexOf(b.slug);
          if (ai === -1 && bi === -1) return a.slug.localeCompare(b.slug);
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return ai - bi;
        });
        setHeroEntries(
          sorted.map((entry) => {
            const toolkit = composioToolkitsByProvider[entry.slug];
            return {
              slug: entry.slug,
              displayName: toolkit?.name ?? entry.slug,
              logo:
                toolkit?.logo ?? `https://logos.composio.dev/api/${entry.slug}`,
            };
          }),
        );
      } catch {
        if (!cancelled) setHeroEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [composioToolkitsByProvider]);

  const connectedSlugs = useMemo(
    () =>
      Object.entries(phaseByToolkit)
        .filter(([, phase]) => phase === "done")
        .map(([slug]) => slug),
    [phaseByToolkit],
  );
  const connectedCount = connectedSlugs.length;

  function pickStarterSlug(): string | null {
    for (const slug of HERO_PRIORITY) {
      if (
        connectedSlugs.includes(slug) &&
        slug in FIRST_RUN_STARTERS
      ) {
        return slug;
      }
    }
    for (const slug of connectedSlugs) {
      if (slug in FIRST_RUN_STARTERS) return slug;
    }
    return null;
  }

  async function handleConnect(entry: HeroEntry) {
    setPhaseByToolkit((prev) => ({ ...prev, [entry.slug]: "connecting" }));
    setErrorByToolkit((prev) => ({ ...prev, [entry.slug]: null }));
    try {
      await connectIntegrationProvider({
        provider: entry.slug,
        accountLabel: `${entry.displayName} (Managed)`,
      });
      setPhaseByToolkit((prev) => ({ ...prev, [entry.slug]: "done" }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection failed.";
      setErrorByToolkit((prev) => ({ ...prev, [entry.slug]: msg }));
      setPhaseByToolkit((prev) => ({ ...prev, [entry.slug]: "error" }));
    }
  }

  async function handleContinue() {
    setIsContinuing(true);
    try {
      const starterSlug = pickStarterSlug();
      const workspaceId = selectedWorkspace?.id ?? null;
      await continueDeterministicOnboarding();
      if (starterSlug && workspaceId) {
        try {
          const ensured =
            await window.electronAPI.workspace.ensureMainSession(workspaceId);
          await window.electronAPI.workspace.queueSessionInput({
            text: FIRST_RUN_STARTERS[starterSlug],
            workspace_id: workspaceId,
            session_id: ensured.session.session_id,
            image_urls: null,
            attachments: [],
          });
        } catch {
          // Starter is a nice-to-have — never block the user from
          // entering the workspace if the queue / session ensure fails.
        }
      }
    } finally {
      setIsContinuing(false);
    }
  }

  const workspaceName = selectedWorkspace?.name?.trim() || "Workspace";

  return (
    <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center overflow-y-auto px-6 py-10 sm:px-10">
      <div className="flex w-full max-w-2xl flex-col items-center gap-6">
        <div className="w-full rounded-[32px] border border-border/70 bg-background/90 px-8 py-10 shadow-[0_28px_90px_rgba(15,23,42,0.08)] backdrop-blur sm:px-12 sm:py-12">
          <div className="space-y-3 text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
              Set up {workspaceName}
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Hook up your tools
            </h1>
            <p className="mx-auto max-w-md text-sm leading-7 text-muted-foreground">
              Connect anything you want the agent to use. One click each — you
              can always add more from Settings later.
            </p>
          </div>

          <div className="mt-8">
            {heroEntries === null ? (
              <HeroGridSkeleton />
            ) : heroEntries.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground">
                Integration catalog is unavailable right now. You can connect
                tools from Settings → Integrations after continuing.
              </p>
            ) : (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {heroEntries.map((entry) => (
                  <HeroConnectCard
                    entry={entry}
                    error={errorByToolkit[entry.slug] ?? null}
                    key={entry.slug}
                    onConnect={() => void handleConnect(entry)}
                    phase={phaseByToolkit[entry.slug] ?? "idle"}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4">
          <Button
            className="min-w-[180px]"
            disabled={isContinuing}
            onClick={() => void handleContinue()}
            size="lg"
            type="button"
          >
            {isContinuing
              ? "Opening..."
              : connectedCount > 0
                ? `Continue (${connectedCount} connected)`
                : "Continue"}
          </Button>
        </div>

        {workspaceErrorMessage ? (
          <p className="max-w-md text-center text-sm text-destructive">
            {workspaceErrorMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function HeroGridSkeleton() {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {Array.from({ length: 6 }).map((_, idx) => (
        <li
          className="h-[68px] animate-pulse rounded-xl border border-border bg-muted/30"
          key={`skel-${idx.toString()}`}
        />
      ))}
    </ul>
  );
}

function HeroConnectCard({
  entry,
  phase,
  error,
  onConnect,
}: {
  entry: HeroEntry;
  phase: ConnectPhase;
  error: string | null;
  onConnect: () => void;
}) {
  const isDone = phase === "done";
  const isConnecting = phase === "connecting";
  return (
    <li
      className={
        "flex flex-col gap-1.5 rounded-xl border border-border bg-card px-3 py-2.5 transition-colors hover:bg-accent/40"
      }
    >
      <div className="flex items-center gap-2.5">
        <div className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-background">
          {entry.logo ? (
            <img
              alt=""
              className="size-full object-contain p-0.5"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
              referrerPolicy="no-referrer"
              src={entry.logo}
            />
          ) : (
            <Plug className="size-3.5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {entry.displayName}
          </div>
        </div>
        {isDone ? (
          <div className="grid size-7 place-items-center rounded-md bg-emerald-500/15 text-emerald-600">
            <Check className="size-3.5" />
          </div>
        ) : (
          <Button
            className="h-7 px-2.5 text-xs"
            disabled={isConnecting}
            onClick={onConnect}
            size="sm"
            type="button"
            variant={phase === "error" ? "outline" : "secondary"}
          >
            {isConnecting ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : phase === "error" ? (
              "Retry"
            ) : (
              "Connect"
            )}
          </Button>
        )}
      </div>
      {error ? (
        <p className="line-clamp-2 text-[11px] leading-4 text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}
