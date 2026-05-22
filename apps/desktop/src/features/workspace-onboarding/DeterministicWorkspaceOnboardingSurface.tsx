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

const FETCH_TERMINAL_STATUSES = new Set(["completed", "failed", "unsupported"]);

function contextFetchDisplayName(status: IntegrationContextFetchStatusPayload) {
  return status.account_label || status.account_key || status.provider_id;
}

function contextFetchChunkTotal(status: IntegrationContextFetchStatusPayload) {
  if (status.chunks_total > 0) {
    return status.chunks_total;
  }
  if (status.status === "completed") {
    return Math.max(status.chunks_completed, 1);
  }
  return 0;
}

function contextFetchProgressPercent(
  status: IntegrationContextFetchStatusPayload,
) {
  const total = contextFetchChunkTotal(status);
  if (total <= 0) {
    return status.status === "completed" ? 100 : 0;
  }
  return Math.max(
    0,
    Math.min(100, Math.round((status.chunks_completed / total) * 100)),
  );
}

function contextFetchStateLabel(status: IntegrationContextFetchStatusPayload) {
  if (status.status === "completed") {
    return "Completed";
  }
  if (status.status === "failed") {
    return "Failed";
  }
  if (status.status === "unsupported") {
    return "Unsupported";
  }
  return "Running";
}

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
  const [connectionIdByToolkit, setConnectionIdByToolkit] = useState<
    Record<string, string>
  >({});
  const [contextFetchStatusByConnectionId, setContextFetchStatusByConnectionId] =
    useState<Record<string, IntegrationContextFetchStatusPayload>>({});
  const [isContinuing, setIsContinuing] = useState(false);
  const onboardingFlowState = (selectedWorkspace?.onboarding_state || "")
    .trim()
    .toLowerCase();
  const isFetchingContext =
    onboardingFlowState === "deterministic_context_fetching";

  useEffect(() => {
    setPhaseByToolkit({});
    setErrorByToolkit({});
    setConnectionIdByToolkit({});
    setContextFetchStatusByConnectionId({});
  }, [selectedWorkspace?.id]);

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
  const trackedConnectionIds = useMemo(
    () =>
      Object.values(connectionIdByToolkit)
        .map((connectionId) => connectionId.trim())
        .filter((connectionId) => connectionId.length > 0)
        .sort(),
    [connectionIdByToolkit],
  );
  const trackedConnectionIdsKey = trackedConnectionIds.join("|");
  const trackedFetchStatuses = useMemo(
    () =>
      trackedConnectionIds
        .map((connectionId) => contextFetchStatusByConnectionId[connectionId])
        .filter(
          (
            status,
          ): status is IntegrationContextFetchStatusPayload => Boolean(status),
        ),
    [contextFetchStatusByConnectionId, trackedConnectionIds],
  );
  const supportedFetchStatuses = trackedFetchStatuses.filter(
    (status) => status.supported,
  );
  const unsupportedFetchStatuses = trackedFetchStatuses.filter(
    (status) => !status.supported,
  );
  const shouldPollFetchStatuses =
    trackedConnectionIds.length > 0 &&
    (trackedFetchStatuses.length < trackedConnectionIds.length ||
      trackedFetchStatuses.some((status) => status.status === "running"));

  useEffect(() => {
    if (!isFetchingContext || !shouldPollFetchStatuses) {
      return;
    }
    let cancelled = false;
    async function pollStatuses() {
      try {
        const response =
          await window.electronAPI.workspace.listIntegrationContextFetchStatuses(
            trackedConnectionIds,
          );
        if (cancelled) {
          return;
        }
        setContextFetchStatusByConnectionId((prev) => {
          const next = { ...prev };
          for (const status of response.statuses) {
            next[status.connection_id] = status;
          }
          return next;
        });
      } catch {
        // Keep the onboarding surface resilient while background fetches run.
      }
    }
    void pollStatuses();
    const intervalId = window.setInterval(() => {
      void pollStatuses();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isFetchingContext, shouldPollFetchStatuses, trackedConnectionIds, trackedConnectionIdsKey]);

  async function handleConnect(entry: HeroEntry) {
    setPhaseByToolkit((prev) => ({ ...prev, [entry.slug]: "connecting" }));
    setErrorByToolkit((prev) => ({ ...prev, [entry.slug]: null }));
    try {
      const { connectionId } = await connectIntegrationProvider({
        provider: entry.slug,
        accountLabel: `${entry.displayName} (Managed)`,
      });
      setConnectionIdByToolkit((prev) => ({
        ...prev,
        [entry.slug]: connectionId,
      }));
      try {
        const response =
          await window.electronAPI.workspace.fetchIntegrationContext(
            connectionId,
          );
        setContextFetchStatusByConnectionId((prev) => ({
          ...prev,
          [connectionId]: response.status,
        }));
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Context fetch could not be started.";
        setErrorByToolkit((prev) => ({
          ...prev,
          [entry.slug]: `Connected, but context fetch could not be started: ${message}`,
        }));
      }
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
      await continueDeterministicOnboarding();
    } finally {
      setIsContinuing(false);
    }
  }

  const workspaceName = selectedWorkspace?.name?.trim() || "Workspace";
  const fetchingContextMessage =
    connectedCount > 0
      ? `We're importing the first batch of context from your ${connectedCount} connected ${connectedCount === 1 ? "tool" : "tools"} now. You can enter the workspace while that keeps running in the background.`
      : "We're preparing your workspace context now. If you connected tools, they'll keep importing in the background while you enter the workspace.";
  const aggregateChunkTotal = supportedFetchStatuses.reduce(
    (total, status) => total + contextFetchChunkTotal(status),
    0,
  );
  const aggregateChunkCompleted = supportedFetchStatuses.reduce(
    (total, status) =>
      total + Math.min(status.chunks_completed, contextFetchChunkTotal(status)),
    0,
  );
  const aggregateProgressPercent =
    aggregateChunkTotal > 0
      ? Math.max(
          0,
          Math.min(
            100,
            Math.round((aggregateChunkCompleted / aggregateChunkTotal) * 100),
          ),
        )
      : supportedFetchStatuses.every((status) =>
            FETCH_TERMINAL_STATUSES.has(status.status),
          ) && supportedFetchStatuses.length > 0
        ? 100
        : 0;
  const runningFetchStatuses = supportedFetchStatuses.filter(
    (status) => status.status === "running",
  );
  const completedFetchCount = supportedFetchStatuses.filter(
    (status) => status.status === "completed",
  ).length;
  const failedFetchStatuses = supportedFetchStatuses.filter(
    (status) => status.status === "failed",
  );
  const aggregateStatusLine =
    aggregateChunkTotal > 0
      ? `${aggregateChunkCompleted}/${aggregateChunkTotal} chunks complete`
      : runningFetchStatuses.length > 0
        ? "Starting background import"
        : completedFetchCount > 0
          ? `${completedFetchCount} import${completedFetchCount === 1 ? "" : "s"} completed`
          : "Waiting for import status";
  const aggregateDetailLine =
    runningFetchStatuses.length > 0
      ? runningFetchStatuses[0]?.current_chunk_label ||
        "Importing the first chunks now."
      : failedFetchStatuses.length > 0
        ? failedFetchStatuses[0]?.error_message ||
          "One of the background imports failed."
        : completedFetchCount > 0
          ? "Your connected context is ready inside the workspace memory browser."
          : "Context fetch status will appear here as soon as the imports start.";

  return (
    <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center overflow-y-auto px-6 py-10 sm:px-10">
      <div className="flex w-full max-w-2xl flex-col items-center gap-6">
        <div className="w-full rounded-[32px] border border-border/70 bg-background/90 px-8 py-10 shadow-[0_28px_90px_rgba(15,23,42,0.08)] backdrop-blur sm:px-12 sm:py-12">
          {isFetchingContext ? (
            <div className="flex flex-col items-center justify-center gap-6 py-6 text-center">
              <div className="grid size-14 place-items-center rounded-full bg-accent/60 text-foreground">
                <LoaderCircle className="size-6 animate-spin" />
              </div>
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                  Set up {workspaceName}
                </p>
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                  Fetching your context
                </h1>
                <p className="mx-auto max-w-md text-sm leading-7 text-muted-foreground">
                  {fetchingContextMessage}
                </p>
                <p className="mx-auto max-w-md text-sm leading-7 text-muted-foreground">
                  This can take a minute depending on the accounts you linked.
                </p>
              </div>
              {supportedFetchStatuses.length > 0 ? (
                <div className="mx-auto w-full max-w-lg rounded-2xl border border-border/70 bg-background/70 p-4 text-left">
                  <div className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    <span>Overall progress</span>
                    <span>{aggregateStatusLine}</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-foreground transition-[width] duration-300"
                      style={{ width: `${aggregateProgressPercent}%` }}
                    />
                  </div>
                  <p className="mt-3 text-xs leading-5 text-muted-foreground">
                    {aggregateDetailLine}
                  </p>
                </div>
              ) : null}
              {trackedFetchStatuses.length > 0 ? (
                <ul className="w-full space-y-3 text-left">
                  {trackedFetchStatuses.map((status) => {
                    const progressPercent = contextFetchProgressPercent(status);
                    const chunkTotal = contextFetchChunkTotal(status);
                    return (
                      <li
                        className="rounded-2xl border border-border/70 bg-background/70 p-4"
                        key={status.connection_id}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">
                              {contextFetchDisplayName(status)}
                            </p>
                            <p className="text-xs leading-5 text-muted-foreground">
                              {status.current_chunk_label ||
                                (status.supported
                                  ? "Preparing background import."
                                  : status.reason ||
                                    "Context fetch is not supported yet for this integration.")}
                            </p>
                          </div>
                          <p className="shrink-0 text-xs font-medium text-muted-foreground">
                            {contextFetchStateLabel(status)}
                          </p>
                        </div>
                        {status.supported ? (
                          <>
                            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-foreground transition-[width] duration-300"
                                style={{ width: `${progressPercent}%` }}
                              />
                            </div>
                            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                              {chunkTotal > 0
                                ? `${Math.min(status.chunks_completed, chunkTotal)}/${chunkTotal} chunks complete`
                                : "Waiting for chunk progress"}
                              {status.error_message
                                ? ` - ${status.error_message}`
                                : ""}
                            </p>
                          </>
                        ) : (
                          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                            {status.reason ||
                              "Context fetch is not available yet for this provider."}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {unsupportedFetchStatuses.length > 0 ? (
                <p className="mx-auto max-w-lg text-xs leading-5 text-muted-foreground">
                  Some connected tools do not support context import yet. You
                  can still enter the workspace now.
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="space-y-3 text-center">
                <p className="text-xs font-semibold uppercase tracking-[0.32em] text-muted-foreground">
                  Set up {workspaceName}
                </p>
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                  Hook up your tools
                </h1>
                <p className="mx-auto max-w-md text-sm leading-7 text-muted-foreground">
                  Connect anything you want the agent to use. One click each —
                  you can always add more from Settings later.
                </p>
              </div>

              <div className="mt-8">
                {heroEntries === null ? (
                  <HeroGridSkeleton />
                ) : heroEntries.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground">
                    Integration catalog is unavailable right now. You can
                    connect tools from Settings → Integrations after
                    continuing.
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
            </>
          )}
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
              ? isFetchingContext
                ? "Opening workspace..."
                : "Continuing..."
              : isFetchingContext
                ? "Enter workspace now"
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
