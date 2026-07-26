import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { waitForComposioConnectionInvalidation } from "@/lib/composioConnectionEvents";
import { type AuthSession, useDesktopAuthSession } from "@/lib/auth/authClient";
import { hydrateInstalledWorkspaceApps, type WorkspaceInstalledAppDefinition } from "@/lib/workspaceApps";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { toolkitDisplayName } from "@/lib/toolkitDisplay";

/**
 * Subset of the Composio toolkit shape we need across the desktop shell —
 * display name + logo + categories. The full payload comes from
 * `composioListToolkits()`; we keep the locally-typed alias narrow on
 * purpose so app surfaces don't accidentally couple to fields we may
 * later choose not to expose globally.
 */
export interface ComposioToolkitMetadata {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
}

const COMPOSIO_PROVIDER_TOOLKIT_ALIASES: Record<string, string> = {
  x: "twitter",
};

export function composioToolkitSlugForProvider(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  return COMPOSIO_PROVIDER_TOOLKIT_ALIASES[normalized] ?? normalized;
}

export function composioToolkitMatchesProvider(
  toolkitSlug: string,
  providerId: string,
): boolean {
  return (
    toolkitSlug.trim().toLowerCase() ===
    composioToolkitSlugForProvider(providerId)
  );
}

/**
 * Resolves the display name + logo for an app by combining the catalog
 * entry's `provider_id` (self-declared in app.runtime.yaml) with the
 * shared Composio toolkit map. Returns `null` fields when no toolkit
 * data is available, so callers can fall back to their own defaults.
 */
export function resolveAppDisplay(
  providerId: string | null | undefined,
  toolkitsByProvider: Record<string, ComposioToolkitMetadata>,
): { name: string | null; logo: string | null } {
  const slug = providerId
    ? composioToolkitSlugForProvider(providerId)
    : "";
  const toolkit = slug ? toolkitsByProvider[slug] : undefined;
  return {
    name: toolkit?.name?.trim() || null,
    logo: toolkit?.logo ?? null,
  };
}

export class IntegrationConnectCancelled extends Error {
  constructor() {
    super("Integration connect cancelled by user");
    this.name = "IntegrationConnectCancelled";
  }
}

export type IntegrationCredentialField = ComposioToolkitAuth["fields"][number];

/** A toolkit Composio holds no managed credentials for (Pinecone, Firecrawl, …)
 *  authorizes with the user's OWN key, so there's no OAuth window to open. The
 *  connect flow parks one of these on the context; the shell's credential dialog
 *  collects the fields and resolves it (null ⇒ the user backed out). */
export interface IntegrationCredentialRequest {
  provider: string;
  displayName: string;
  scheme: string;
  fields: IntegrationCredentialField[];
  resolve: (credentials: Record<string, string> | null) => void;
}

export const COMPOSIO_POLL_INTERVAL_MS = 3000;
// 30 ticks × 3s = 90s hard cap. Was 100 (5min); OAuth completes in
// 5-30s in practice, so a long absolute timeout no longer earns its keep.
export const COMPOSIO_POLL_MAX_TICKS = 30;
export const COMPOSIO_POLL_TIMEOUT_MS =
  COMPOSIO_POLL_INTERVAL_MS * COMPOSIO_POLL_MAX_TICKS;

// Progressive poll cadence — OAuth typically completes 5-30s after
// open, so the first few polls hit at high density to catch fast
// completions, then back off to the steady 3s baseline. Total tick
// count still respects COMPOSIO_POLL_MAX_TICKS.
const COMPOSIO_POLL_INTERVAL_PROGRESSION_MS = [800, 1200, 1800, 2400] as const;

function composioPollIntervalForTick(tick: number): number {
  return (
    COMPOSIO_POLL_INTERVAL_PROGRESSION_MS[tick] ?? COMPOSIO_POLL_INTERVAL_MS
  );
}

/** Sleep for `ms` OR until the desktop window regains focus — whichever
 *  comes first. Used by the OAuth poll loop so the moment the user
 *  switches back from the browser after authorizing, we poll immediately
 *  instead of waiting up to one full interval for the next tick. */
function sleepUntilFocusOrTimeout(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const onAbort = () => finish();
    const onFocus = () => finish();
    const timer = setTimeout(() => finish(), ms);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    window.addEventListener("focus", onFocus, { once: true });
    if (signal) {
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

const BOOTSTRAP_IPC_TIMEOUT_MS = 8_000;
type LifecycleStepState = "pending" | "current" | "done" | "error";
type WorkspaceListLoadSource = "auto" | "live" | "cached";

export interface DesktopLifecycleStep {
  id: "signed_in" | "runtime_provisioned" | "sandbox_assigned" | "desktop_browser_ready" | "workspace_ready";
  label: string;
  state: LifecycleStepState;
  detail: string;
}

interface WorkspaceDesktopContextValue {
  runtimeConfig: RuntimeConfigPayload | null;
  runtimeStatus: RuntimeStatusPayload | null;
  clientConfig: HolabossClientConfigPayload | null;
  workspaces: WorkspaceRecordPayload[];
  hasHydratedWorkspaceList: boolean;
  selectedWorkspace: WorkspaceRecordPayload | null;
  installedApps: WorkspaceInstalledAppDefinition[];
  isLoadingInstalledApps: boolean;
  isActivatingWorkspace: boolean;
  workspaceAppsReady: boolean;
  workspaceBlockingReason: string;
  refreshInstalledApps: () => Promise<void>;
  composioToolkitsByProvider: Record<string, ComposioToolkitMetadata>;
  connectIntegrationProvider: (params: {
    provider: string;
    appId?: string | null;
    accountLabel?: string | null;
    signal?: AbortSignal;
    whoami?: PendingIntegrationWhoami | null;
  }) => Promise<{ connectionId: string }>;
  connectIntegrationProviderWithCredentials: (params: {
    provider: string;
    authScheme: string;
    credentials: Record<string, string>;
    accountLabel?: string | null;
    whoami?: PendingIntegrationWhoami | null;
  }) => Promise<{ connectionId: string }>;
  /** True while at least one `connectIntegrationProvider(...)` call is
   *  mid-OAuth (browser tab open, poll loop running). Drives the chat
   *  composer disable so users don't fire messages into the agent before
   *  the integration is wired in — half-connected accounts otherwise fail
   *  noisily on the next tool call. */
  isIntegrationConnectInFlight: boolean;
  /** Display names of the providers currently being connected, in start
   *  order. Empty when nothing is in flight. Used to compose the disabled
   *  reason ("Connecting Gmail…"). */
  inFlightIntegrationProviderNames: string[];
  /** Set while a credential-auth toolkit's connect is waiting on the user's own
   *  key. The shell's IntegrationCredentialDialog renders it and resolves. */
  integrationCredentialRequest: IntegrationCredentialRequest | null;
  activateWorkspace: (workspaceId: string) => Promise<void>;
  resolvedUserId: string;
  isLoadingBootstrap: boolean;
  isRefreshing: boolean;
  workspaceErrorMessage: string;
  statusSummary: string;
  lifecycleSteps: DesktopLifecycleStep[];
  setupStatus: {
    tone: "info" | "success" | "warning";
    message: string;
  } | null;
  refreshWorkspaceData: () => Promise<void>;
  removeInstalledApp: (appId: string) => Promise<void>;
}

const WorkspaceDesktopContext = createContext<WorkspaceDesktopContextValue | null>(null);

function sessionUserId(session: AuthSession | null): string {
  if (!session || typeof session !== "object") {
    return "";
  }

  const maybeUser = "user" in session ? session.user : null;
  if (!maybeUser || typeof maybeUser !== "object") {
    return "";
  }

  return typeof maybeUser.id === "string" ? maybeUser.id : "";
}

function normalizeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed.";
  const ipcMatch = message.match(
    /^Error invoking remote method '[^']+': Error: (.+)$/s,
  );
  const unwrappedMessage = ipcMatch ? ipcMatch[1].trim() : message.trim();
  const normalized = unwrappedMessage.toLowerCase();
  const rawNormalized = message.trim().toLowerCase();

  if (normalized.includes("workspace:listworkspaces")) {
    return "Couldn't load workspace state right now. The local runtime may still be starting.";
  }

  if (normalized.includes("internal server error")) {
    return "The local runtime hit an internal error. Try again in a moment.";
  }

  if (rawNormalized.includes("error invoking remote method") && !ipcMatch) {
    return "The desktop app couldn't complete that request. Try again in a moment.";
  }

  // Path-overlap errors from the runtime (400 "workspacePath overlaps another
  // workspace...") propagate through runtimeErrorFromBody → IPC → here as the
  // raw detail string. No special-casing needed — the runtime message is clear
  // enough ("That folder is already in use by another workspace. Delete that
  // workspace first, then try again."). If the runtime changes the wording, add
  // a normalized.includes("overlaps") branch here to rephrase it.

  return unwrappedMessage;
}

function withBootstrapTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`Timed out loading ${label}.`));
    }, BOOTSTRAP_IPC_TIMEOUT_MS);

    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function WorkspaceDesktopProvider({ children }: { children: ReactNode }) {
  const sessionState = useDesktopAuthSession();
  const session = sessionState.data;
  const { selectedWorkspaceId, setSelectedWorkspaceId } = useWorkspaceSelection();
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfigPayload | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusPayload | null>(null);
  const [clientConfig, setClientConfig] = useState<HolabossClientConfigPayload | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecordPayload[]>([]);
  const [hasHydratedWorkspaceList, setHasHydratedWorkspaceList] = useState(false);
  const [installedApps, setInstalledApps] = useState<WorkspaceInstalledAppDefinition[]>([]);
  const [isLoadingBootstrap, setIsLoadingBootstrap] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [workspaceErrorMessage, setWorkspaceErrorMessage] = useState("");
  const [isLoadingInstalledApps, setIsLoadingInstalledApps] = useState(false);
  const [isActivatingWorkspace, setIsActivatingWorkspace] = useState(false);
  const [workspaceLifecycleWorkspaceId, setWorkspaceLifecycleWorkspaceId] = useState("");
  const [workspaceAppsReadyState, setWorkspaceAppsReadyState] = useState(false);
  const [workspaceBlockingReasonState, setWorkspaceBlockingReasonState] = useState("");
  const [recentAuthCompletedAt, setRecentAuthCompletedAt] = useState<number | null>(null);
  // Stack of provider display names currently mid-OAuth via
  // connectIntegrationProvider(). Stack (not boolean) because multiple
  // connects can overlap — e.g. agent emits two pending_integrations
  // back-to-back, both cards started before the first resolves.
  //
  // Source of truth is the ref Map (immune to React batching), and we
  // mirror it into state after every mutation so consumers can subscribe
  // via the normal context value. Token-based bookkeeping (vs index-
  // based splice) keeps overlapping connects from removing the wrong
  // entry on exit.
  const inFlightConnectsRef = useRef<Map<number, string>>(new Map());
  const inFlightConnectIdRef = useRef(0);
  const [inFlightIntegrationProviderNames, setInFlightIntegrationProviderNames] =
    useState<string[]>([]);
  // The credential form a non-OAuth toolkit is waiting on. One at a time: the
  // connect that parks it is itself awaiting the answer.
  const [integrationCredentialRequest, setIntegrationCredentialRequest] =
    useState<IntegrationCredentialRequest | null>(null);
  // Composio toolkit metadata (name + logo + categories) keyed by toolkit
  // slug. Single source of truth for app display name + icon across the
  // shell — both the marketplace gallery and the workspace sidebar look
  // up by `provider_id` (declared in app.runtime.yaml). Fetched once when
  // the provider mounts; failures degrade silently to manifest names +
  // CDN-by-app_id.
  const [composioToolkitsByProvider, setComposioToolkitsByProvider] = useState<
    Record<string, ComposioToolkitMetadata>
  >({});

  const signedInUserId = sessionUserId(session);
  const isSignedIn = Boolean(signedInUserId);
  const runtimeBoundUserId = runtimeConfig?.authTokenPresent ? runtimeConfig?.userId?.trim() || "" : "";
  const resolvedUserId = runtimeBoundUserId || signedInUserId;
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces]
  );
  const selectedWorkspaceExists = Boolean(selectedWorkspaceId) && selectedWorkspace !== null;
  // One-shot fetch of the Composio toolkit catalog. The shape lives in the
  // shared context so app surfaces (marketplace gallery + workspace
  // sidebar + onboarding) all derive display name + logo from the same
  // source of truth and we never need a local app→display table.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { toolkits } =
          await window.electronAPI.workspace.composioListToolkits();
        if (cancelled) return;
        const indexed: Record<string, ComposioToolkitMetadata> = {};
        for (const toolkit of toolkits) {
          const slug = toolkit.slug?.trim().toLowerCase();
          if (!slug) continue;
          indexed[slug] = {
            slug,
            name: toolkit.name ?? "",
            description: toolkit.description ?? "",
            logo: toolkit.logo ?? null,
            categories: Array.isArray(toolkit.categories)
              ? toolkit.categories
              : [],
          };
        }
        setComposioToolkitsByProvider(indexed);
      } catch {
        // Non-fatal — surfaces fall back to manifest names + CDN-by-app_id.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runtimeReadyForWorkspaceData = runtimeStatus?.status === "running";
  const canLoadLiveWorkspaceList = runtimeReadyForWorkspaceData || isSignedIn;
  const selectedWorkspaceNeedsLocalRuntime = selectedWorkspace?.location !== "cloud";
  const workspaceLifecycleMatchesSelection = Boolean(selectedWorkspaceId) && workspaceLifecycleWorkspaceId === selectedWorkspaceId;
  const workspaceAppsReady = workspaceLifecycleMatchesSelection && workspaceAppsReadyState;
  const workspaceBlockingReason = workspaceLifecycleMatchesSelection ? workspaceBlockingReasonState : "";

  function applyWorkspaceLifecycle(lifecycle: WorkspaceLifecyclePayload) {
    const hydratedApps = hydrateInstalledWorkspaceApps(lifecycle.applications);
    const workspaceStatus = (lifecycle.workspace.status || "").trim().toLowerCase();
    const noAppsRequireStartup =
      hydratedApps.length === 0 &&
      workspaceStatus !== "provisioning" &&
      workspaceStatus !== "error" &&
      workspaceStatus !== "deleted";

    setInstalledApps(hydratedApps);
    setWorkspaceLifecycleWorkspaceId(lifecycle.workspace.id);
    setWorkspaceAppsReadyState(noAppsRequireStartup || lifecycle.ready);
    setWorkspaceBlockingReasonState(noAppsRequireStartup ? "" : (lifecycle.phase_detail || lifecycle.reason || "").trim());
    upsertWorkspaceRecord(lifecycle.workspace);
  }

  function upsertWorkspaceRecord(nextWorkspace: WorkspaceRecordPayload) {
    setWorkspaces((current) => {
      const existingIndex = current.findIndex((workspace) => workspace.id === nextWorkspace.id);
      if (existingIndex === -1) {
        return [nextWorkspace, ...current];
      }
      const next = [...current];
      const existing = next[existingIndex];
      next[existingIndex] = { ...existing, ...nextWorkspace };
      return next;
    });
  }

  async function refreshInstalledApps() {
    if (!selectedWorkspaceId || !selectedWorkspaceExists) {
      setInstalledApps([]);
      setIsLoadingInstalledApps(false);
      setWorkspaceLifecycleWorkspaceId("");
      setWorkspaceAppsReadyState(false);
      setWorkspaceBlockingReasonState("");
      return;
    }

    setIsLoadingInstalledApps(true);
    try {
      const response = await window.electronAPI.workspace.getWorkspaceLifecycle(selectedWorkspaceId);
      applyWorkspaceLifecycle(response);
    } catch (error) {
      setInstalledApps([]);
      setWorkspaceLifecycleWorkspaceId("");
      setWorkspaceAppsReadyState(false);
      setWorkspaceBlockingReasonState("");
      setWorkspaceErrorMessage((current) => current || normalizeErrorMessage(error));
    } finally {
      setIsLoadingInstalledApps(false);
    }
  }

  useLayoutEffect(() => {
    setInstalledApps([]);
    setWorkspaceLifecycleWorkspaceId("");
    setWorkspaceAppsReadyState(false);
    setWorkspaceBlockingReasonState("");
  }, [selectedWorkspaceId]);

  // Optimistic splash hydration — read the cached workspace registry
  // from control-plane.db on the desktop side, without waiting for the
  // sidecar to spawn or run schema-ensure. Sidecar takes 2-4s on cold
  // launch; this synchronous local read is 5-15ms. If we get any
  // rows, we hydrate the splash immediately; the sidecar's later
  // listWorkspaces (via the regular workspace-load effect) reconciles.
  // First-launch / fresh-install case has no rows → falls through to
  // the sidecar-gated path, no behaviour change.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cached =
          await window.electronAPI.workspace.listWorkspacesCached();
        if (cancelled) return;
        if (cached.items.length === 0) return;
        setWorkspaces(cached.items);
        setSelectedWorkspaceId((current) => {
          if (current && cached.items.some((w) => w.id === current)) {
            return current;
          }
          return cached.items[0]?.id ?? "";
        });
        setHasHydratedWorkspaceList(true);
        setIsRefreshing(false);
        // Splash unmounts now — sidecar can finish booting in the
        // background; the regular workspace-load effect will reconcile
        // when it finally resolves.
      } catch {
        // Silent fallback — let the regular sidecar-gated path run.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadBootstrap() {
      setIsLoadingBootstrap(true);
      setWorkspaceErrorMessage("");

      try {
        const [runtimeConfigResult, runtimeStatusResult, clientConfigResult] = await Promise.allSettled([
          withBootstrapTimeout(window.electronAPI.runtime.getConfig(), "runtime configuration"),
          withBootstrapTimeout(window.electronAPI.runtime.getStatus(), "runtime status"),
          withBootstrapTimeout(window.electronAPI.workspace.getClientConfig(), "desktop client configuration")
        ]);
        if (cancelled) {
          return;
        }

        const bootstrapErrors: string[] = [];

        if (runtimeConfigResult.status === "fulfilled") {
          setRuntimeConfig(runtimeConfigResult.value);
        } else {
          bootstrapErrors.push(normalizeErrorMessage(runtimeConfigResult.reason));
        }

        if (runtimeStatusResult.status === "fulfilled") {
          setRuntimeStatus(runtimeStatusResult.value);
        } else {
          bootstrapErrors.push(normalizeErrorMessage(runtimeStatusResult.reason));
        }

        if (clientConfigResult.status === "fulfilled") {
          setClientConfig(clientConfigResult.value);
        } else {
          bootstrapErrors.push(normalizeErrorMessage(clientConfigResult.reason));
        }

        if (bootstrapErrors.length > 0) {
          setWorkspaceErrorMessage(bootstrapErrors[0]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingBootstrap(false);
        }
      }
    }

    void loadBootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.electronAPI.runtime.onStateChange((status) => {
      if (mounted) {
        setRuntimeStatus(status);
      }
    });

    void window.electronAPI.runtime.getStatus().then((status) => {
      if (mounted) {
        setRuntimeStatus(status);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // (Removed) — there used to be a 1s polling loop here that re-queried
  // runtime:getStatus while the sidecar was "starting". The push event
  // `runtime:state` (fired from emitRuntimeState() on every transition,
  // including the starting → running flip) covers the same state with
  // zero latency, and the redundant poll could only *delay* observed
  // ready by up to a full tick (caller waits for next 1s boundary).
  // Boot timing measured ~1s recovery on the splash by removing this.

  useEffect(() => {
    let mounted = true;
    void window.electronAPI.runtime.getConfig().then((config) => {
      if (mounted) {
        setRuntimeConfig(config);
      }
    });

    const unsubscribe = window.electronAPI.runtime.onConfigChange((config) => {
      if (mounted) {
        setRuntimeConfig(config);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  async function loadWorkspaceData(
    options: { preserveSelection?: boolean; allowEmpty?: boolean; source?: WorkspaceListLoadSource } = {},
  ) {
    const { preserveSelection = true, allowEmpty = false, source = "auto" } = options;
    const workspaceListSource =
      source === "auto"
        ? canLoadLiveWorkspaceList
          ? "live"
          : "cached"
        : source;
    const workspaceResponse = workspaceListSource === "live"
      ? await window.electronAPI.workspace.listWorkspaces()
      : await window.electronAPI.workspace.listWorkspacesCached();
    const nextWorkspaces = workspaceResponse.items;
    const shouldKeepPreviousWorkspaces = !allowEmpty && nextWorkspaces.length === 0 && workspaces.length > 0;
    const resolvedWorkspaces = shouldKeepPreviousWorkspaces ? workspaces : nextWorkspaces;

    setWorkspaces(resolvedWorkspaces);

    setSelectedWorkspaceId((current) => {
      const stored = preserveSelection ? current : "";
      if (stored && resolvedWorkspaces.some((workspace) => workspace.id === stored)) {
        return stored;
      }
      return resolvedWorkspaces[0]?.id ?? "";
    });

    return {
      source: workspaceListSource,
      fetchedCount: nextWorkspaces.length,
      resolvedCount: resolvedWorkspaces.length,
    };
  }

  async function refreshWorkspaceData() {
    setIsRefreshing(true);
    setWorkspaceErrorMessage("");
    try {
      const [nextRuntimeConfig, nextRuntimeStatus] = await Promise.all([
        window.electronAPI.runtime.getConfig(),
        window.electronAPI.runtime.getStatus()
      ]);
      setRuntimeConfig(nextRuntimeConfig);
      setRuntimeStatus(nextRuntimeStatus);
      const workspaceListSource =
        nextRuntimeStatus.status === "running" || isSignedIn ? "live" : "cached";
      const result = await loadWorkspaceData({
        preserveSelection: true,
        allowEmpty: workspaceListSource === "live",
        source: workspaceListSource,
      });
      setHasHydratedWorkspaceList(
        (current) =>
          current || result.source === "live" || result.resolvedCount > 0,
      );
      if (nextRuntimeStatus.status === "error" && nextRuntimeStatus.lastError.trim()) {
        setWorkspaceErrorMessage(nextRuntimeStatus.lastError.trim());
      }
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
    } finally {
      setHasHydratedWorkspaceList((current) => current || workspaces.length > 0);
      setIsRefreshing(false);
    }
  }

  async function removeInstalledApp(appId: string) {
    if (!selectedWorkspaceId) {
      return;
    }
    try {
      await window.electronAPI.workspace.removeInstalledApp(selectedWorkspaceId, appId);
      await refreshInstalledApps();
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
    }
  }

  // Park a credential form for the shell dialog and await the user's answer.
  // Resolves null when they cancel or the caller aborts mid-form.
  function requestIntegrationCredentials({
    provider,
    displayName,
    scheme,
    fields,
    signal,
  }: {
    provider: string;
    displayName: string;
    scheme: string;
    fields: IntegrationCredentialField[];
    signal?: AbortSignal;
  }): Promise<Record<string, string> | null> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (credentials: Record<string, string> | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        setIntegrationCredentialRequest(null);
        resolve(credentials);
      };
      function onAbort() {
        settle(null);
      }
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      signal?.addEventListener("abort", onAbort);
      setIntegrationCredentialRequest({
        provider,
        displayName,
        scheme,
        fields,
        resolve: settle,
      });
    });
  }

  async function connectIntegrationProvider({
    provider,
    accountLabel,
    signal,
    whoami,
  }: {
    provider: string;
    appId?: string | null;
    accountLabel?: string | null;
    signal?: AbortSignal;
    whoami?: PendingIntegrationWhoami | null;
  }): Promise<{ connectionId: string }> {
    const throwIfAborted = () => {
      if (signal?.aborted) {
        throw new IntegrationConnectCancelled();
      }
    };

    const MAX_CONSECUTIVE_ERRORS = 20;

    // Register this connect in the in-flight map BEFORE any awaits so the
    // chat composer flips disabled the moment the user clicks Connect,
    // not after the first round-trip lands ~300ms later. The token-based
    // remove (vs splice by index) survives overlapping connects.
    const entryId = inFlightConnectIdRef.current++;
    const displayName = toolkitDisplayName(provider);
    inFlightConnectsRef.current.set(entryId, displayName);
    setInFlightIntegrationProviderNames(
      Array.from(inFlightConnectsRef.current.values()),
    );

    try {
    // Parallelize the independent pre-OAuth round-trips. Before this
    // was serial — getConfig → snapshot → composioConnect — adding ~300-800ms
    // of latency before the browser even opens. The snapshot only needs
    // to complete before we start polling, not before composioConnect.
    const toolkitSlug = composioToolkitSlugForProvider(provider);
    const [runtimeConfig, beforeSnapshot, toolkitAuth] = await Promise.all([
      window.electronAPI.runtime.getConfig(),
      window.electronAPI.workspace
        // Force-fresh: a stale cached snapshot that misses an existing account
        // makes that account look "new" mid-poll, so its EXPIRED state throws a
        // false failure. An accurate before-set keeps beforeIds complete.
        .composioListConnections(true)
        .catch(() => ({ connections: [] as Array<{ id: string }> })),
      // Which authorization this toolkit actually takes. Composio is the only
      // truth here — a curated list would drift the moment Composio adds or
      // drops managed credentials for a toolkit. On lookup failure assume
      // managed, which is the pre-existing behaviour.
      window.electronAPI.workspace
        .composioToolkitAuth(toolkitSlug)
        .catch(
          () =>
            ({ managed: true, scheme: null, fields: [] }) as ComposioToolkitAuth,
        ),
    ]);
    const userId = runtimeConfig.userId ?? (resolvedUserId || "local");
    const beforeIds = new Set(beforeSnapshot.connections.map((c) => c.id));

    throwIfAborted();

    // No managed credentials ⇒ there is no OAuth window to open and /connect
    // would 400 with Auth_Config_DefaultAuthConfigNotFound. Collect the user's
    // own key and take the synchronous credential path instead.
    if (!toolkitAuth.managed && toolkitAuth.scheme) {
      const credentials = await requestIntegrationCredentials({
        provider: toolkitSlug,
        displayName,
        scheme: toolkitAuth.scheme,
        fields: toolkitAuth.fields,
        signal,
      });
      if (!credentials) {
        throw new IntegrationConnectCancelled();
      }
      return await connectIntegrationProviderWithCredentials({
        provider,
        authScheme: toolkitAuth.scheme,
        credentials,
        ...(accountLabel === undefined ? {} : { accountLabel }),
        ...(whoami ? { whoami } : {}),
      });
    }
    const link = await window.electronAPI.workspace.composioConnect({
      provider: toolkitSlug,
      owner_user_id: userId,
      ...(whoami ? { whoami } : {}),
    });

    throwIfAborted();

    await window.electronAPI.ui.openExternalUrl(link.redirect_url);

    // Poll the exact account /connect created, by id. This is the ONLY reliable
    // signal: /composio/connections is filtered to rows already in our DB (they
    // land only once a webhook writes them), so a freshly-authorized account is
    // invisible to a list-diff and the connect would time out even though it
    // went ACTIVE upstream. /composio/account/:id reads Composio directly (and
    // bootstraps the row), so it sees the ACTIVE flip immediately. The list-diff
    // below is a fallback for the rare response that carries no id.
    let knownNewConnectionId: string | null = link.connected_account_id || null;
    let consecutiveErrors = 0;
    for (let tick = 0; tick < COMPOSIO_POLL_MAX_TICKS; tick++) {
      // Race the polling tick against a webhook-fed SSE invalidation for
      // this specific connected_account. If the cloud BFF fires before the
      // next focus tick, we wake immediately and skip the wait. The SSE
      // wait only attaches once we've discovered the ca_xxx — earlier
      // ticks still need the list call to find it.
      if (knownNewConnectionId) {
        await Promise.race([
          sleepUntilFocusOrTimeout(
            composioPollIntervalForTick(tick),
            signal,
          ),
          waitForComposioConnectionInvalidation({
            externalId: knownNewConnectionId,
            signal,
          }).catch(() => undefined),
        ]);
      } else {
        await sleepUntilFocusOrTimeout(
          composioPollIntervalForTick(tick),
          signal,
        );
      }
      throwIfAborted();
      if (knownNewConnectionId === null) {
        let current;
        try {
          // Force-fresh every poll tick: the connect POST invalidates the
          // cache once, but the first post-connect read lands while the account
          // is still INITIATED (absent from the list), caching an empty result
          // for its full TTL — so the later ACTIVE flip is never seen and the
          // connect spuriously times out. Bypassing the cache fixes that.
          current =
            await window.electronAPI.workspace.composioListConnections(true);
          consecutiveErrors = 0;
        } catch (pollError) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw pollError;
          }
          continue;
        }
        const found = current.connections.find(
          (c) =>
            !beforeIds.has(c.id) &&
            composioToolkitMatchesProvider(c.toolkitSlug, provider),
        );
        if (found) {
          knownNewConnectionId = found.id;
        }
      }
      if (knownNewConnectionId) {
        // Composio creates the row at /connect time in INITIATED state —
        // its mere presence in the list is NOT proof that OAuth completed.
        // Read the account's real status before finalizing.
        let accountStatus;
        try {
          accountStatus =
            await window.electronAPI.workspace.composioAccountStatus(
              knownNewConnectionId,
              provider,
            );
        } catch {
          continue;
        }
        throwIfAborted();
        const status = (accountStatus.status ?? "").toUpperCase();
        if (status === "ACTIVE") {
          // Composio's connected_account_id (ca_xxx) is NOT the runtime's
          // connection_id. composioFinalize writes a runtime row whose
          // connection_id is a fresh randomUUID; that's the id callers need
          // to pass to upsertIntegrationBinding. Returning ca_xxx here led
          // to "integration connection ca_xxx not found" 404s the moment
          // anyone tried to bind the result.
          const finalized = await window.electronAPI.workspace.composioFinalize({
            connected_account_id: knownNewConnectionId,
            provider,
            owner_user_id: userId,
            account_label: accountLabel ?? toolkitDisplayName(provider),
          });
          throwIfAborted();
          return { connectionId: finalized.connection_id };
        }
        if (status === "FAILED") {
          throw new Error(
            `Authorization for ${provider} failed. Please try again.`,
          );
        }
        // EXPIRED / INACTIVE / INITIATED / INITIATING / UNKNOWN — keep polling.
        // We're watching the exact account /connect created, and a fresh row can
        // briefly read as expired/unknown before the OAuth round-trip lands — so
        // only ACTIVE (above) or the 90s hard timeout are terminal. This is what
        // stops a completed authorization from surfacing as "expired". The old
        // path also bailed early via an "abandoned" heuristic that produced far
        // more false positives than real early exits (slow-flipping providers
        // like Slack/Gmail), so the hard timeout is the sole floor.
      }
    }
    throw new Error(
      `Connection to ${provider} timed out after ${
        (COMPOSIO_POLL_MAX_TICKS * COMPOSIO_POLL_INTERVAL_MS) / 1000
      }s. Please try again.`,
    );
    } finally {
      // Always pop — success, throw, and cancel paths all land here so the
      // chat composer can't get stuck in a "Connecting…" disabled state
      // after the connect resolves.
      inFlightConnectsRef.current.delete(entryId);
      setInFlightIntegrationProviderNames(
        Array.from(inFlightConnectsRef.current.values()),
      );
    }
  }

  // Credential connect (API-key / basic) — toolkits with no managed OAuth.
  // No browser window and no poll loop: Hono creates the connected account
  // synchronously from the user's own credentials, so we finalize straight
  // to a runtime connection_id.
  async function connectIntegrationProviderWithCredentials({
    provider,
    authScheme,
    credentials,
    accountLabel,
    whoami,
  }: {
    provider: string;
    authScheme: string;
    credentials: Record<string, string>;
    accountLabel?: string | null;
    whoami?: PendingIntegrationWhoami | null;
  }): Promise<{ connectionId: string }> {
    const toolkitSlug = composioToolkitSlugForProvider(provider);
    const runtimeConfig = await window.electronAPI.runtime.getConfig();
    const userId = runtimeConfig.userId ?? (resolvedUserId || "local");
    const result = await window.electronAPI.workspace.composioConnect({
      provider: toolkitSlug,
      owner_user_id: userId,
      auth_scheme: authScheme,
      credentials,
      ...(whoami ? { whoami } : {}),
    });
    if (!(result.connected && result.connected_account_id)) {
      throw new Error(`Could not connect ${toolkitDisplayName(provider)}.`);
    }
    const finalized = await window.electronAPI.workspace.composioFinalize({
      connected_account_id: result.connected_account_id,
      provider,
      owner_user_id: userId,
      account_label: accountLabel ?? toolkitDisplayName(provider),
    });
    return { connectionId: finalized.connection_id };
  }

  async function activateWorkspace(workspaceId: string) {
    setWorkspaceErrorMessage("");
    try {
      await window.electronAPI.workspace.activate(workspaceId);
      await loadWorkspaceData({ preserveSelection: true });
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
      throw error;
    }
  }

  useEffect(() => {
    let cancelled = false;

    // Workspace summaries can now hydrate from either the live desktop
    // control plane (`listWorkspaces`) or the cached local registry
    // (`listWorkspacesCached`). That lets the desktop render signed-in
    // cloud workspaces without waiting for the embedded runtime, while
    // still reconciling local state once the sidecar reaches `running`.
    const workspaceListSource =
      canLoadLiveWorkspaceList ? "live" : "cached";

    async function refresh() {
      setIsRefreshing(true);
      if (workspaceListSource === "live") {
        setWorkspaceErrorMessage("");
      }
      try {
        const result = await loadWorkspaceData({
          preserveSelection: true,
          allowEmpty: workspaceListSource === "live",
          source: workspaceListSource,
        });
        if (!cancelled) {
          setHasHydratedWorkspaceList(
            (current) =>
              current || result.source === "live" || result.resolvedCount > 0,
          );
          if (runtimeStatus?.status === "error" && runtimeStatus.lastError.trim()) {
            setWorkspaceErrorMessage((current) => current || runtimeStatus.lastError.trim());
          }
        }
      } catch (error) {
        if (!cancelled) {
          setWorkspaceErrorMessage(normalizeErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsRefreshing(false);
        }
      }
    }

    void refresh();
    return () => {
      cancelled = true;
    };
  }, [canLoadLiveWorkspaceList, resolvedUserId, runtimeStatus?.lastError, runtimeStatus?.status, workspaces.length]);

  useEffect(() => {
    let cancelled = false;

    async function syncAfterAuthChange() {
      try {
        const [nextRuntimeConfig, nextRuntimeStatus] = await Promise.all([
          window.electronAPI.runtime.getConfig(),
          window.electronAPI.runtime.getStatus()
        ]);
        if (cancelled) {
          return;
        }
        setRuntimeConfig(nextRuntimeConfig);
        setRuntimeStatus(nextRuntimeStatus);

        const sessionUser = sessionUserId(session);
        if (sessionUser) {
          setRecentAuthCompletedAt(Date.now());
        }
      } catch {
        // best effort; status surface will continue to use last known values
      }
    }

    void syncAfterAuthChange();
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (
      !selectedWorkspaceId ||
      !selectedWorkspaceExists ||
      (selectedWorkspaceNeedsLocalRuntime && !runtimeReadyForWorkspaceData)
    ) {
      setInstalledApps([]);
      setIsLoadingInstalledApps(false);
      setIsActivatingWorkspace(false);
      setWorkspaceLifecycleWorkspaceId("");
      setWorkspaceAppsReadyState(false);
      setWorkspaceBlockingReasonState("");
      return;
    }

    let cancelled = false;

    async function activateSelectedWorkspace() {
      setIsLoadingInstalledApps(true);
      setIsActivatingWorkspace(true);
      try {
        const response = await window.electronAPI.workspace.activateWorkspace(selectedWorkspaceId);
        if (!cancelled) {
          applyWorkspaceLifecycle(response);
        }
      } catch (error) {
        if (!cancelled) {
          setInstalledApps([]);
          setWorkspaceLifecycleWorkspaceId("");
          setWorkspaceAppsReadyState(false);
          setWorkspaceBlockingReasonState("");
          setWorkspaceErrorMessage((current) => current || normalizeErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingInstalledApps(false);
          setIsActivatingWorkspace(false);
        }
      }
    }

    void activateSelectedWorkspace();
    return () => {
      cancelled = true;
    };
  }, [runtimeReadyForWorkspaceData, selectedWorkspaceExists, selectedWorkspaceId, selectedWorkspaceNeedsLocalRuntime]);

  useEffect(() => {
    if (
      !selectedWorkspaceId ||
      !selectedWorkspaceExists ||
      (selectedWorkspaceNeedsLocalRuntime && !runtimeReadyForWorkspaceData)
    ) {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(() => {
      void window.electronAPI.workspace
        .getWorkspaceLifecycle(selectedWorkspaceId)
        .then((response) => {
          if (!cancelled) {
            applyWorkspaceLifecycle(response);
          }
        })
        .catch(() => undefined);
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runtimeReadyForWorkspaceData, selectedWorkspaceExists, selectedWorkspaceId, selectedWorkspaceNeedsLocalRuntime]);

  const statusSummary = useMemo(() => {
    const parts = [];
    if (runtimeConfig) {
      parts.push(runtimeConfig.authTokenPresent ? "runtime binding ready" : "runtime binding missing");
    }
    if (resolvedUserId) {
      parts.push(`user ${resolvedUserId}`);
    }
    return parts.join(" - ");
  }, [clientConfig, resolvedUserId, runtimeConfig]);

  const lifecycleSteps = useMemo<DesktopLifecycleStep[]>(() => {
    const signedIn = isSignedIn;
    const runtimeProvisioned = Boolean(runtimeConfig?.authTokenPresent);
    const sandboxAssigned = Boolean(runtimeConfig?.sandboxId?.trim());
    const desktopBrowserReady = Boolean(runtimeStatus?.desktopBrowserReady);
    const workspaceReady = Boolean(selectedWorkspace && workspaceAppsReady);
    const runtimeFailed = runtimeStatus?.status === "error";
    const workspaceFailed = Boolean(selectedWorkspace && selectedWorkspace.status.trim().toLowerCase() === "error");

    return [
      {
        id: "signed_in",
        label: "Signed in",
        state: signedIn ? "done" : "current",
        detail: signedIn ? "Desktop auth session is available." : "Sign in to sync product-backed desktop state."
      },
      {
        id: "runtime_provisioned",
        label: "Runtime provisioned",
        state: runtimeFailed ? "error" : runtimeProvisioned ? "done" : signedIn ? "current" : "pending",
        detail: runtimeFailed
          ? runtimeStatus?.lastError || "Embedded runtime failed to start."
          : runtimeProvisioned
            ? "Runtime token and binding are loaded."
            : "Waiting for runtime token provisioning."
      },
      {
        id: "sandbox_assigned",
        label: "Sandbox assigned",
        state: sandboxAssigned ? "done" : runtimeProvisioned ? "current" : "pending",
        detail: sandboxAssigned
          ? "Sandbox is assigned for this runtime."
          : "Waiting for a sandbox assignment in runtime config."
      },
      {
        id: "desktop_browser_ready",
        label: "Desktop browser ready",
        state: desktopBrowserReady ? "done" : runtimeStatus?.status === "starting" ? "current" : "pending",
        detail: desktopBrowserReady
          ? "Desktop browser service is registered for agent-triggered browsing."
          : "Desktop browser service has not finished registering yet."
      },
      {
        id: "workspace_ready",
        label: "Workspace ready",
        state: workspaceFailed ? "error" : workspaceReady ? "done" : selectedWorkspace ? "current" : "pending",
        detail: workspaceFailed
          ? selectedWorkspace?.error_message || "Workspace provisioning failed."
          : workspaceReady
            ? `${selectedWorkspace?.name || "Workspace"} is active and apps are running.`
            : selectedWorkspace
              ? workspaceBlockingReason || `Current workspace status: ${selectedWorkspace.status}.`
              : "Create or select a workspace to finish desktop routing."
      }
    ];
  }, [isSignedIn, runtimeConfig, runtimeStatus, selectedWorkspace, workspaceAppsReady, workspaceBlockingReason]);

  const setupStatus = useMemo(() => {
    if (!clientConfig && !runtimeConfig && !runtimeStatus) {
      return null;
    }

    if (!isSignedIn) {
      return {
        tone: "info" as const,
        message: "Local template import is available without sign-in. Sign in only for synced holaOS product settings."
      };
    }

    if (runtimeConfig && !runtimeConfig.authTokenPresent) {
      return {
        tone: "info" as const,
        message:
          runtimeStatus?.status === "starting"
            ? "Signed in. Runtime is restarting and waiting for the workspace token to load."
            : "Signed in. Waiting for runtime token provisioning to complete."
      };
    }

    if (runtimeStatus?.status === "starting") {
      return {
        tone: "info" as const,
        message: "Runtime config loaded. Restarting runtime with your account configuration."
      };
    }

    if (runtimeStatus?.status === "error") {
      return {
        tone: "warning" as const,
        message: runtimeStatus.lastError || "Runtime failed to start with the current configuration."
      };
    }

    if (runtimeConfig?.authTokenPresent && runtimeStatus?.status === "running" && recentAuthCompletedAt) {
      const ageMs = Date.now() - recentAuthCompletedAt;
      if (ageMs < 45000) {
        return {
          tone: "success" as const,
          message: "Signed in successfully. Runtime config loaded and ready."
        };
      }
    }

    return null;
  }, [clientConfig, recentAuthCompletedAt, runtimeConfig, runtimeStatus, session]);

  // Auto-poll installed apps when any app is not yet ready.
  useEffect(() => {
    const hasInitializing = installedApps.some((app) => !app.ready);
    if (!hasInitializing || !selectedWorkspaceId) {
      return;
    }
    const timer = setInterval(() => {
      void window.electronAPI.workspace
        .activateWorkspace(selectedWorkspaceId)
        .then((response) => {
          applyWorkspaceLifecycle(response);
        })
        .catch(() => {
          void refreshInstalledApps();
        });
    }, 3000);
    return () => clearInterval(timer);
  }, [installedApps, refreshInstalledApps, selectedWorkspaceId]);

  const value = useMemo(
    () => ({
      runtimeConfig,
      runtimeStatus,
      clientConfig,
      workspaces,
      hasHydratedWorkspaceList,
      selectedWorkspace,
      installedApps,
      isLoadingInstalledApps,
      isActivatingWorkspace,
      workspaceAppsReady,
      workspaceBlockingReason,
      refreshInstalledApps,
      composioToolkitsByProvider,
      connectIntegrationProvider,
      connectIntegrationProviderWithCredentials,
      isIntegrationConnectInFlight: inFlightIntegrationProviderNames.length > 0,
      inFlightIntegrationProviderNames,
      integrationCredentialRequest,
      activateWorkspace,
      resolvedUserId,
      isLoadingBootstrap,
      isRefreshing,
      workspaceErrorMessage,
      statusSummary,
      lifecycleSteps,
      setupStatus,
      refreshWorkspaceData,
      removeInstalledApp,
    }),
    [
      runtimeConfig,
      runtimeStatus,
      clientConfig,
      workspaces,
      hasHydratedWorkspaceList,
      selectedWorkspace,
      installedApps,
      isLoadingInstalledApps,
      isActivatingWorkspace,
      workspaceAppsReady,
      workspaceBlockingReason,
      refreshInstalledApps,
      composioToolkitsByProvider,
      inFlightIntegrationProviderNames,
      integrationCredentialRequest,
      resolvedUserId,
      isLoadingBootstrap,
      isRefreshing,
      workspaceErrorMessage,
      statusSummary,
      lifecycleSteps,
      setupStatus,
      refreshWorkspaceData,
      activateWorkspace,
      removeInstalledApp,
    ]
  );

  return <WorkspaceDesktopContext.Provider value={value}>{children}</WorkspaceDesktopContext.Provider>;
}

export function useWorkspaceDesktop() {
  const context = useContext(WorkspaceDesktopContext);
  if (!context) {
    throw new Error("useWorkspaceDesktop must be used within WorkspaceDesktopProvider.");
  }
  return context;
}
