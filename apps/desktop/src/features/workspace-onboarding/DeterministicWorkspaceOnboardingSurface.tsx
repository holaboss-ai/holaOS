import {
  AlertCircle,
  Check,
  ChevronDown,
  LoaderCircle,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IntegrationLogo } from "@/components/integration/IntegrationLogo";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { bindConnectionToWorkspace } from "@/lib/bindConnectionToWorkspace";
import { toolkitDisplayName } from "@/lib/toolkitDisplay";
import {
  IntegrationConnectCancelled,
  useWorkspaceDesktop,
} from "@/lib/workspaceDesktop";

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

// "<Platform> (Managed)" / "<slug> (managed)" / bare slug — labels we
// set ourselves during connect as a stand-in until whoami populates the
// real account info. Treat them as missing for display purposes so the
// row falls back to the canonical platform name (e.g. "Notion") instead
// of leaking our internal placeholder.
function isPlaceholderLabel(label: string, slug: string): boolean {
  const cleaned = label.trim().toLowerCase();
  if (!cleaned) return true;
  const slugLower = slug.trim().toLowerCase();
  if (cleaned === slugLower) return true;
  if (cleaned === `${slugLower} (managed)`) return true;
  const platform = toolkitDisplayName(slug).trim().toLowerCase();
  if (cleaned === platform) return true;
  if (cleaned === `${platform} (managed)`) return true;
  return false;
}

function formatAccountHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function contextFetchDisplayName(status: IntegrationContextFetchStatusPayload) {
  const slug = status.provider_id;
  const label = status.account_label?.trim() ?? "";
  if (label && !isPlaceholderLabel(label, slug)) return label;
  const key = status.account_key?.trim() ?? "";
  if (key && key.toLowerCase() !== slug.toLowerCase()) return key;
  return toolkitDisplayName(slug);
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

type FetchErrorCategory =
  | "auth_revoked"
  | "permission_denied"
  | "server_error"
  | "rate_limit"
  | "unknown";

function categorizeFetchError(message: string | null | undefined): FetchErrorCategory {
  const text = (message || "").toLowerCase();
  if (!text) return "unknown";
  if (
    text.includes("revoked") ||
    text.includes("active state") ||
    text.includes("expired") ||
    text.includes("invalid_grant") ||
    text.includes("unauthorized") ||
    text.includes("401")
  ) {
    return "auth_revoked";
  }
  if (text.includes("permission") || text.includes("scope") || text.includes("403")) {
    return "permission_denied";
  }
  if (text.includes("rate limit") || text.includes("429") || text.includes("too many requests")) {
    return "rate_limit";
  }
  if (
    text.includes("internal server") ||
    text.includes("500") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504") ||
    text.includes("timeout")
  ) {
    return "server_error";
  }
  return "unknown";
}

function humanizeFetchError(
  category: FetchErrorCategory,
  rawMessage: string,
): string {
  switch (category) {
    case "auth_revoked":
      return "Access was revoked — reconnect to retry.";
    case "permission_denied":
      return "Missing permissions — reconnect with full access.";
    case "rate_limit":
      return "Hit a rate limit — we'll retry shortly.";
    case "server_error":
      return "The provider returned a server error — we'll retry shortly.";
    default:
      return rawMessage.length > 120
        ? `${rawMessage.slice(0, 117)}…`
        : rawMessage;
  }
}

interface FetchToneTokens {
  /** Background tint + text color for a status pill. */
  pill: string;
  /** Filled dot color (small bg circle). */
  dot: string;
  /** Filled bar color (legacy horizontal progress fill). */
  bar: string;
  /** Text color class used by CircularProgress via `stroke-current`. */
  ring: string;
}

function CircularProgress({
  value,
  size = 14,
  strokeWidth = 2,
  className,
  trackClassName = "stroke-fg-4",
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  className?: string;
  trackClassName?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const safeValue = Math.max(0, Math.min(100, value));
  const offset = circumference - (safeValue / 100) * circumference;
  return (
    <svg
      aria-hidden="true"
      className={`shrink-0 ${className ?? ""}`}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        strokeWidth={strokeWidth}
        className={trackClassName}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        fill="none"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        strokeWidth={strokeWidth}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        className="stroke-current transition-[stroke-dashoffset] duration-300"
      />
    </svg>
  );
}

function fetchTone(status: string): FetchToneTokens {
  switch (status) {
    case "completed":
      return {
        pill: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        dot: "bg-emerald-500",
        bar: "bg-emerald-500",
        ring: "text-emerald-500",
      };
    case "failed":
      return {
        pill: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
        dot: "bg-amber-500",
        bar: "bg-amber-500",
        ring: "text-amber-500",
      };
    case "unsupported":
      return {
        pill: "bg-muted text-muted-foreground",
        dot: "bg-muted-foreground/60",
        bar: "bg-muted-foreground/40",
        ring: "text-muted-foreground/50",
      };
    default:
      return {
        pill: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
        dot: "bg-blue-500",
        bar: "bg-blue-500",
        ring: "text-blue-500",
      };
  }
}

function makeContextFetchStartFailureStatus(params: {
  connectionId: string;
  providerId: string;
  accountKey?: string | null;
  accountLabel?: string | null;
  errorMessage: string;
}): IntegrationContextFetchStatusPayload {
  const now = new Date().toISOString();
  return {
    connection_id: params.connectionId,
    provider_id: params.providerId,
    run_id: `local-start-failure-${params.connectionId}`,
    supported: true,
    status: "failed",
    account_key: params.accountKey?.trim() || null,
    account_label: params.accountLabel?.trim() || null,
    tree_id: null,
    current_chunk_label: `Context fetch failed for ${params.providerId}`,
    chunks_total: 0,
    chunks_completed: 0,
    messages_seen: 0,
    messages_persisted: 0,
    leaves_created: 0,
    leaves_superseding: 0,
    leaves_unchanged: 0,
    summary_nodes: 0,
    actions: [],
    started_at: now,
    updated_at: now,
    completed_at: now,
    fetched_at: null,
    error_message: params.errorMessage,
    reason: null,
  };
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
  // All existing active connections the user already has across all
  // workspaces, keyed by provider slug. Stored as an ARRAY (not just the
  // most-recent one) so the Switch-account menu can list every alternate
  // the user can pick between — without this we'd be back to forcing a
  // fresh OAuth for users who happen to have two Gmails already
  // authorized. Ordered newest-first by `updated_at`.
  const [existingConnectionsBySlug, setExistingConnectionsBySlug] = useState<
    Record<string, IntegrationConnectionPayload[]>
  >({});
  const [contextFetchStatusByConnectionId, setContextFetchStatusByConnectionId] =
    useState<Record<string, IntegrationContextFetchStatusPayload>>({});
  const [isContinuing, setIsContinuing] = useState(false);
  const [reconnectingProvider, setReconnectingProvider] = useState<
    string | null
  >(null);
  const [dismissedWorkspaceError, setDismissedWorkspaceError] = useState<
    string | null
  >(null);

  // Per-toolkit AbortControllers so each card's Cancel button can short-
  // circuit `connectIntegrationProvider`'s ~5-minute timeout. One entry
  // per slug; new attempts replace the prior controller. Cleared on
  // workspace switch + on unmount.
  const connectControllersRef = useRef<Record<string, AbortController>>({});
  useEffect(() => {
    return () => {
      for (const controller of Object.values(connectControllersRef.current)) {
        controller.abort();
      }
      connectControllersRef.current = {};
    };
  }, []);
  const onboardingFlowState = (selectedWorkspace?.onboarding_state || "")
    .trim()
    .toLowerCase();
  const isFetchingContext =
    onboardingFlowState === "deterministic_context_fetching";
  // Sticky latch — once the workspace has crossed into the fetching
  // step, keep the fetching view visible even if `onboarding_state`
  // briefly reads as something else (workspace re-fetch race, transient
  // selectedWorkspace=null, etc.). Without this, the page occasionally
  // flickers back to the connect grid mid-import. Resets only when the
  // active workspace itself changes.
  const [hasReachedFetching, setHasReachedFetching] = useState(false);
  useEffect(() => {
    if (isFetchingContext) {
      setHasReachedFetching(true);
    }
  }, [isFetchingContext]);
  const showFetchingView = isFetchingContext || hasReachedFetching;

  useEffect(() => {
    setPhaseByToolkit({});
    setErrorByToolkit({});
    setConnectionIdByToolkit({});
    setContextFetchStatusByConnectionId({});
    setExistingConnectionsBySlug({});
    setHasReachedFetching(false);
    for (const controller of Object.values(connectControllersRef.current)) {
      controller.abort();
    }
    connectControllersRef.current = {};
  }, [selectedWorkspace?.id]);

  // Pull the user's existing active connections (across all workspaces)
  // so we can recognize tiles the user has already authorized. Without
  // this, onboarding renders the same "Connect" button for every hero
  // entry and re-OAuthing duplicates the Composio connected_account row.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { connections } =
          await window.electronAPI.workspace.listIntegrationConnections();
        if (cancelled) return;
        // Index by lowercase provider slug, keeping ALL active connections
        // sorted newest-first. Multiple accounts surface in the Switch-
        // account menu so the user can pick between e.g. work + personal
        // Gmail without being forced through a fresh OAuth.
        const byProvider: Record<string, IntegrationConnectionPayload[]> = {};
        for (const conn of connections) {
          if (conn.status !== "active") continue;
          const slug = conn.provider_id.trim().toLowerCase();
          if (!slug) continue;
          (byProvider[slug] ??= []).push(conn);
        }
        for (const list of Object.values(byProvider)) {
          list.sort(
            (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
          );
        }
        setExistingConnectionsBySlug(byProvider);
      } catch {
        // Onboarding can still function without the pre-existing scan —
        // user just sees the legacy "Connect everything fresh" UX.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace?.id]);

  // Once both `heroEntries` and `existingConnectionsBySlug` have loaded,
  // mark any already-connected hero as `done` and seed the FIRST (newest)
  // connection id into the tracked map. The continue step then binds
  // those connections to the new workspace — without this seeding, the
  // collected map would be empty for unchanged tiles and Phase 2 would
  // skip them entirely. The user can still flip the selection via the
  // Switch-account menu before clicking Continue.
  useEffect(() => {
    if (!heroEntries || heroEntries.length === 0) return;
    if (Object.keys(existingConnectionsBySlug).length === 0) return;
    setPhaseByToolkit((prev) => {
      const next = { ...prev };
      for (const entry of heroEntries) {
        const existing = existingConnectionsBySlug[entry.slug]?.[0];
        if (existing && !next[entry.slug]) {
          next[entry.slug] = "done";
        }
      }
      return next;
    });
    setConnectionIdByToolkit((prev) => {
      const next = { ...prev };
      for (const entry of heroEntries) {
        const existing = existingConnectionsBySlug[entry.slug]?.[0];
        if (existing && !next[entry.slug]) {
          next[entry.slug] = existing.connection_id;
        }
      }
      return next;
    });
  }, [heroEntries, existingConnectionsBySlug]);

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
              displayName: toolkitDisplayName(entry.slug),
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
  // Render a row for every connection we're tracking — even before the
  // first status poll returns — so the user immediately sees the tools
  // they connected (with a "Preparing" placeholder) instead of an empty
  // card during the network round-trip.
  const trackedEntries = useMemo(() => {
    return Object.entries(connectionIdByToolkit)
      .map(([slug, connectionId]) => {
        const id = connectionId.trim();
        if (!id) return null;
        const connection =
          existingConnectionsBySlug[slug]?.find(
            (c) => c.connection_id === id,
          ) ?? null;
        return { slug, connectionId: id, connection };
      })
      .filter(
        (entry): entry is { slug: string; connectionId: string; connection: IntegrationConnectionPayload | null } =>
          entry !== null,
      )
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }, [connectionIdByToolkit, existingConnectionsBySlug]);
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

  async function startContextFetch(params: {
    connectionId: string;
    providerId: string;
    accountKey?: string | null;
    accountLabel?: string | null;
    errorToolkitSlug?: string;
  }) {
    try {
      const response =
        await window.electronAPI.workspace.fetchIntegrationContext(
          params.connectionId,
        );
      setContextFetchStatusByConnectionId((prev) => ({
        ...prev,
        [params.connectionId]: response.status,
      }));
      return response.status;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Context fetch could not be started.";
      setContextFetchStatusByConnectionId((prev) => ({
        ...prev,
        [params.connectionId]: makeContextFetchStartFailureStatus({
          connectionId: params.connectionId,
          providerId: params.providerId,
          accountKey: params.accountKey,
          accountLabel: params.accountLabel,
          errorMessage: message,
        }),
      }));
      if (params.errorToolkitSlug) {
        const toolkitSlug = params.errorToolkitSlug;
        setErrorByToolkit((prev) => ({
          ...prev,
          [toolkitSlug]: `Connected, but context fetch could not be started: ${message}`,
        }));
      }
      return null;
    }
  }

  async function handleConnect(
    entry: HeroEntry,
    opts?: { force?: boolean },
  ) {
    // Short-circuit when this provider is already connected and the caller
    // didn't explicitly ask for a fresh OAuth ("Add another account…" in
    // the Switch-account menu sets force=true). Avoids creating a duplicate
    // Composio connected_account row for users who already authorized
    // Gmail in a previous workspace — they should be able to just click
    // Continue.
    const existing = existingConnectionsBySlug[entry.slug]?.[0];
    if (existing && !opts?.force) {
      setConnectionIdByToolkit((prev) => ({
        ...prev,
        [entry.slug]: existing.connection_id,
      }));
      setPhaseByToolkit((prev) => ({ ...prev, [entry.slug]: "done" }));
      return;
    }

    setPhaseByToolkit((prev) => ({ ...prev, [entry.slug]: "connecting" }));
    setErrorByToolkit((prev) => ({ ...prev, [entry.slug]: null }));
    connectControllersRef.current[entry.slug]?.abort();
    const controller = new AbortController();
    connectControllersRef.current[entry.slug] = controller;
    try {
      const { connectionId } = await connectIntegrationProvider({
        provider: entry.slug,
        accountLabel: entry.displayName,
        signal: controller.signal,
      });
      setConnectionIdByToolkit((prev) => ({
        ...prev,
        [entry.slug]: connectionId,
      }));
      // OAuth is done — flip the tile to "Connected" immediately so the
      // spinner stops as soon as the runtime returns a connection_id.
      // Context fetch (Gmail history scan, Notion page crawl, etc.) is
      // best-effort background work; gating the UI on it makes the
      // spinner appear stuck for the 30s–minutes that the runtime takes
      // to enqueue/start the fetch, which the user reads as "broken".
      setPhaseByToolkit((prev) => ({ ...prev, [entry.slug]: "done" }));
      void startContextFetch({
        connectionId,
        providerId: entry.slug,
        accountLabel: `${entry.displayName} (Managed)`,
        errorToolkitSlug: entry.slug,
      });
    } catch (err) {
      // User cancelled — drop back to idle silently (no error, the user
      // intended this).
      if (
        err instanceof IntegrationConnectCancelled ||
        controller.signal.aborted
      ) {
        setPhaseByToolkit((prev) => ({ ...prev, [entry.slug]: "idle" }));
        return;
      }
      const msg = err instanceof Error ? err.message : "Connection failed.";
      setErrorByToolkit((prev) => ({ ...prev, [entry.slug]: msg }));
      setPhaseByToolkit((prev) => ({ ...prev, [entry.slug]: "error" }));
    } finally {
      if (connectControllersRef.current[entry.slug] === controller) {
        delete connectControllersRef.current[entry.slug];
      }
    }
  }

  function handleCancelConnect(slug: string) {
    connectControllersRef.current[slug]?.abort();
  }

  // Trigger a fresh OAuth for a provider whose context fetch failed (e.g.
  // Notion access revoked), then explicitly kick off the context fetch
  // for the new connection. Without the fetchIntegrationContext call the
  // runtime never re-enqueues the import — matches the post-OAuth path
  // in handleConnect above.
  async function handleReconnectFailed(providerId: string) {
    if (!providerId || reconnectingProvider === providerId) return;
    setReconnectingProvider(providerId);
    connectControllersRef.current[providerId]?.abort();
    const controller = new AbortController();
    connectControllersRef.current[providerId] = controller;
    try {
      const { connectionId } = await connectIntegrationProvider({
        provider: providerId,
        accountLabel: toolkitDisplayName(providerId),
        signal: controller.signal,
      });
      await startContextFetch({
        connectionId,
        providerId,
        accountLabel: `${toolkitDisplayName(providerId)} (Managed)`,
      });
    } catch {
      // OAuth itself failed (user closed popup, network, etc.) — leave
      // the failed row visible so they can try again. Cancellation drops
      // back silently for the same reason.
    } finally {
      if (connectControllersRef.current[providerId] === controller) {
        delete connectControllersRef.current[providerId];
      }
      setReconnectingProvider((current) =>
        current === providerId ? null : current,
      );
    }
  }

  async function handleContinue() {
    setIsContinuing(true);
    try {
      // Phase 2: persist every (slug → connection_id) we collected during
      // onboarding — whether the user freshly OAuth'd or we reused a
      // pre-existing connection — into this workspace's binding state.
      // Without this the IDs sit dead in React state and the workspace
      // has no idea which integrations the user "chose" during setup.
      const workspaceId = selectedWorkspace?.id;
      if (workspaceId) {
        const entries = Object.entries(connectionIdByToolkit).filter(
          ([, connectionId]) => connectionId.trim().length > 0,
        );
        await Promise.allSettled(
          entries.map(([slug, connectionId]) =>
            bindConnectionToWorkspace({
              workspaceId,
              providerSlug: slug,
              connectionId,
            }),
          ),
        );
        await Promise.allSettled(
          entries.map(async ([slug, connectionId]) => {
            const existingConnection =
              existingConnectionsBySlug[slug]?.find(
                (connection) => connection.connection_id === connectionId,
              ) ?? null;
            await startContextFetch({
              connectionId,
              providerId: slug,
              accountKey:
                existingConnection?.account_handle ||
                existingConnection?.account_email ||
                existingConnection?.account_external_id ||
                null,
              accountLabel:
                existingConnection?.account_label ||
                `${toolkitDisplayName(slug)} (Managed)`,
            });
          }),
        );
      }
      await continueDeterministicOnboarding();
    } finally {
      setIsContinuing(false);
    }
  }

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
    <div className="flex h-full min-h-0 w-full flex-1 justify-center overflow-y-auto px-6 py-10 sm:px-10">
      <div className="my-auto flex w-full max-w-3xl flex-col items-center gap-4">
        <div className="w-full rounded-3xl border border-border bg-background px-8 py-8 sm:px-10 sm:py-10">
          {showFetchingView && trackedConnectionIds.length === 0 ? (
            // Skip the full fetching panel when the user continued with
            // zero connections — there's nothing to render rows for, and
            // showing an empty progress card reads as "broken". Hold a
            // minimal loading state until the workspace transitions out
            // and the parent unmounts us.
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
              <div className="space-y-1">
                <h1 className="text-xl font-semibold text-foreground">
                  Setting up your workspace
                </h1>
                <p className="text-sm text-muted-foreground">
                  Almost ready…
                </p>
              </div>
            </div>
          ) : showFetchingView ? (
            <div className="flex flex-col gap-5">
              <div className="text-xs font-medium text-muted-foreground">
                Importing in background
              </div>

              <div className="space-y-3">
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                  Your workspace is being prepared
                </h1>
                <p className="max-w-xl text-sm text-muted-foreground">
                  {fetchingContextMessage}
                </p>
              </div>

              {supportedFetchStatuses.length > 0 ? (
                <div className="rounded-2xl border border-border bg-fg-2 p-5">
                  <div className="flex items-baseline justify-between gap-4">
                    <div className="flex items-baseline gap-2.5">
                      <span className="text-2xl font-semibold leading-none tabular-nums text-foreground">
                        {aggregateProgressPercent}%
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {aggregateChunkCompleted.toLocaleString()}/
                        {aggregateChunkTotal.toLocaleString()} chunks
                      </span>
                    </div>
                  </div>
                  <div className="mt-4 h-1 overflow-hidden rounded-full bg-fg-4">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                      style={{ width: `${aggregateProgressPercent}%` }}
                    />
                  </div>
                  <div className="mt-2.5 line-clamp-1 text-xs text-muted-foreground">
                    {aggregateDetailLine}
                  </div>
                </div>
              ) : null}

              {trackedEntries.length > 0 ? (
                <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-background">
                  {trackedEntries.map((entry) => {
                    const status =
                      contextFetchStatusByConnectionId[entry.connectionId];
                    if (!status) {
                      const handle = entry.connection?.account_handle?.trim();
                      const email = entry.connection?.account_email?.trim();
                      const label = entry.connection?.account_label?.trim();
                      const pendingName = handle
                        ? formatAccountHandle(handle)
                        : email
                          ? email
                          : label && !isPlaceholderLabel(label, entry.slug)
                            ? label
                            : toolkitDisplayName(entry.slug);
                      return (
                        <li
                          className="flex items-center gap-3 px-3.5 py-2.5"
                          key={entry.connectionId}
                        >
                          <IntegrationLogo
                            alt={pendingName}
                            size="sm"
                            slug={entry.slug}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground">
                              {pendingName}
                            </div>
                            <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                              Preparing import…
                            </p>
                          </div>
                          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                        </li>
                      );
                    }
                    const progressPercent =
                      contextFetchProgressPercent(status);
                    const chunkTotal = contextFetchChunkTotal(status);
                    const tone = fetchTone(status.status);
                    const isFailed = status.status === "failed";
                    const errorCategory = isFailed
                      ? categorizeFetchError(status.error_message)
                      : "unknown";
                    const canReconnect =
                      isFailed &&
                      (errorCategory === "auth_revoked" ||
                        errorCategory === "permission_denied");
                    const isReconnectingThis =
                      reconnectingProvider === status.provider_id;
                    const detailLine = isFailed
                      ? humanizeFetchError(
                          errorCategory,
                          status.error_message || "Context fetch failed.",
                        )
                      : !status.supported
                        ? status.reason || "Not supported yet."
                        : null;
                    const countLabel =
                      chunkTotal > 0
                        ? `${Math.min(status.chunks_completed, chunkTotal)}/${chunkTotal}`
                        : "—";
                    return (
                      <li
                        className={`flex items-center gap-3 px-3.5 py-2.5 ${isFailed ? "bg-amber-500/[0.03]" : ""}`}
                        key={status.connection_id}
                      >
                        <IntegrationLogo
                          alt={contextFetchDisplayName(status)}
                          size="sm"
                          slug={status.provider_id}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">
                            {contextFetchDisplayName(status)}
                          </div>
                          {detailLine ? (
                            <p
                              className={`mt-0.5 line-clamp-1 text-[11px] ${isFailed ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}
                            >
                              {detailLine}
                            </p>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {canReconnect ? (
                            <button
                              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={isReconnectingThis}
                              onClick={() =>
                                void handleReconnectFailed(status.provider_id)
                              }
                              type="button"
                            >
                              {isReconnectingThis ? (
                                <>
                                  <LoaderCircle className="size-3 animate-spin" />
                                  Connecting…
                                </>
                              ) : (
                                <>
                                  <RotateCw className="size-3" />
                                  Reconnect
                                </>
                              )}
                            </button>
                          ) : (
                            <>
                              <span className="text-[11px] tabular-nums text-muted-foreground">
                                {countLabel}
                              </span>
                              {status.supported ? (
                                <CircularProgress
                                  className={tone.ring}
                                  size={14}
                                  strokeWidth={1.75}
                                  value={progressPercent}
                                />
                              ) : (
                                <span
                                  className={`size-1.5 rounded-full ${tone.dot}`}
                                />
                              )}
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}

              {unsupportedFetchStatuses.length > 0 ? (
                <p className="text-xs leading-5 text-muted-foreground">
                  Some connected tools don't support context import yet —
                  they'll still work once you're inside.
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="space-y-4 text-center">
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                  Hook up your tools
                </h1>
                <p className="mx-auto max-w-md text-sm text-muted-foreground">
                  Connect anything you want the agent to use. One click each —
                  you can always add more from Settings later.
                </p>
                {heroEntries && heroEntries.length > 0 ? (
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {connectedCount} of {heroEntries.length} connected
                  </p>
                ) : null}
              </div>

              <div className="mt-10">
                {heroEntries === null ? (
                  <HeroGridSkeleton />
                ) : heroEntries.length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground">
                    Integration catalog is unavailable right now. You can
                    connect tools from Settings → Integrations after
                    continuing.
                  </p>
                ) : (
                  <ul className="grid auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-3">
                    {heroEntries.map((entry) => {
                      const accounts =
                        existingConnectionsBySlug[entry.slug] ?? [];
                      const selectedConnectionId =
                        connectionIdByToolkit[entry.slug] ?? null;
                      return (
                        <HeroConnectCard
                          accounts={accounts}
                          entry={entry}
                          error={errorByToolkit[entry.slug] ?? null}
                          key={entry.slug}
                          onAddNewAccount={() =>
                            void handleConnect(entry, { force: true })
                          }
                          onCancel={() => handleCancelConnect(entry.slug)}
                          onConnect={() => void handleConnect(entry)}
                          onSelectAccount={(connectionId) => {
                            setConnectionIdByToolkit((prev) => ({
                              ...prev,
                              [entry.slug]: connectionId,
                            }));
                            setPhaseByToolkit((prev) => ({
                              ...prev,
                              [entry.slug]: "done",
                            }));
                          }}
                          phase={phaseByToolkit[entry.slug] ?? "idle"}
                          selectedConnectionId={selectedConnectionId}
                        />
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>

        {workspaceErrorMessage &&
        workspaceErrorMessage !== dismissedWorkspaceError ? (
          <div className="flex w-full max-w-md items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1 text-sm leading-5 text-foreground">
              {workspaceErrorMessage}
            </div>
            <button
              aria-label="Dismiss error"
              className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-amber-500/10 hover:text-foreground"
              onClick={() =>
                setDismissedWorkspaceError(workspaceErrorMessage)
              }
              type="button"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}

        <div className="flex flex-col items-center gap-2">
          <Button
            className="min-w-[180px]"
            disabled={
              isContinuing ||
              (showFetchingView && trackedConnectionIds.length === 0)
            }
            onClick={() => void handleContinue()}
            size="lg"
            type="button"
          >
            {isContinuing
              ? showFetchingView
                ? "Opening workspace..."
                : "Continuing..."
              : showFetchingView
                ? trackedConnectionIds.length === 0
                  ? "Opening workspace..."
                  : "Enter workspace now"
                : connectedCount > 0
                  ? `Continue (${connectedCount} connected)`
                  : "Skip for now"}
          </Button>
          {showFetchingView && trackedConnectionIds.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Imports continue in the background while you work.
            </p>
          ) : null}
        </div>
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
  onCancel,
  accounts,
  selectedConnectionId,
  onSelectAccount,
  onAddNewAccount,
}: {
  entry: HeroEntry;
  phase: ConnectPhase;
  error: string | null;
  onConnect: () => void;
  /** Abort the in-flight OAuth poll. Wired to the inline Cancel affordance
   *  on the connecting state so the user doesn't have to wait through the
   *  ~5-minute timeout after closing the OAuth browser. */
  onCancel: () => void;
  /** Every active connection the user has for this provider, newest-first.
   *  Empty array when no pre-existing connections — the tile renders a
   *  plain Connect button in that case. */
  accounts: IntegrationConnectionPayload[];
  /** Which connection (from `accounts`) is currently chosen for this
   *  workspace's binding. Null until the user picks one or accepts the
   *  default-seeded newest entry. Drives the checkmark in the menu. */
  selectedConnectionId: string | null;
  /** Switch the workspace binding to a different already-authorized
   *  connection — no OAuth, no new Composio row. */
  onSelectAccount: (connectionId: string) => void;
  /** Pop fresh OAuth to create a NEW connected_account for this provider.
   *  The "Add another account…" menu item. */
  onAddNewAccount: () => void;
}) {
  const isDone = phase === "done";
  const isConnecting = phase === "connecting";
  const selectedAccount =
    accounts.find((acct) => acct.connection_id === selectedConnectionId) ??
    accounts[0] ??
    null;
  return (
    <li
      className={
        "group flex h-full flex-col gap-2 rounded-xl border border-border bg-card px-3.5 py-3 transition-colors hover:bg-accent/40"
      }
    >
      <div className="flex items-start gap-3">
        <IntegrationLogo
          slug={entry.slug}
          overrideUrl={entry.logo}
          alt={entry.displayName}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-sm font-medium leading-tight text-foreground">
            {entry.displayName}
          </div>
          {isDone && selectedAccount ? (
            <div className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">
              {accountDisplayHandle(selectedAccount)}
            </div>
          ) : null}
        </div>
      </div>
      {!isDone && isConnecting ? (
        <div className="mt-auto inline-flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" />
          <span>Connecting…</span>
          <button
            aria-label="Cancel connection"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-fg-4 hover:text-foreground"
            onClick={onCancel}
            type="button"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : !isDone ? (
        <button
          className="mt-auto inline-flex w-fit items-center gap-1 text-[11px] leading-4 font-medium text-foreground transition-colors hover:text-primary"
          onClick={onConnect}
          type="button"
        >
          {phase === "error" ? "Retry" : "Connect"}
        </button>
      ) : null}
      {isDone && accounts.length > 0 ? (
        // Power users with multiple Gmails / GitHubs need a way to point
        // this workspace at a specific one (or add a new one). The menu
        // lists every active connection the user has for this provider —
        // picking one is a pure binding swap (no OAuth), and "Add another
        // account…" pops a fresh OAuth that creates a new Composio row.
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                className="mt-auto inline-flex w-fit items-center gap-1 text-[11px] leading-4 text-muted-foreground opacity-0 transition-[opacity,color] duration-150 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                type="button"
              >
                Switch account
                <ChevronDown className="size-3" />
              </button>
            }
          />
          <DropdownMenuContent align="start" className="min-w-[220px]">
            {accounts.map((acct) => {
              const isSelected = acct.connection_id === selectedConnectionId;
              return (
                <DropdownMenuItem
                  key={acct.connection_id}
                  onClick={() => {
                    if (isSelected) return;
                    onSelectAccount(acct.connection_id);
                  }}
                >
                  <Check
                    className={
                      isSelected
                        ? "size-3.5 text-foreground"
                        : "size-3.5 opacity-0"
                    }
                  />
                  <span className="truncate">{accountDisplayHandle(acct)}</span>
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onAddNewAccount}>
              <Plus className="size-3.5" />
              <span>Add another account…</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {error ? (
        <p className="line-clamp-2 text-[11px] leading-4 text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  );
}

// Pick the most-recognizable string from a connection for inline display
// on the onboarding tile. Falls back through handle → email → label →
// "Connected" so we always render something useful.
function accountDisplayHandle(
  connection: IntegrationConnectionPayload,
): string {
  const handle = connection.account_handle?.trim();
  if (handle) {
    return handle.startsWith("@") ? handle : `@${handle}`;
  }
  const email = connection.account_email?.trim();
  if (email) return email;
  const label = connection.account_label?.trim();
  if (label) return label;
  return "Connected";
}
