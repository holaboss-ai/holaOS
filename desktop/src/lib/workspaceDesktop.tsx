import { listMarketplaceTemplates as sdkListMarketplaceTemplates } from "@holaboss/app-sdk/core";
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
import { getMarketplaceAppSdkClient } from "@/lib/app-sdk-client";
import { type AuthSession, useDesktopAuthSession } from "@/lib/auth/authClient";
import { hydrateInstalledWorkspaceApps, type WorkspaceInstalledAppDefinition } from "@/lib/workspaceApps";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

/**
 * Each app self-declares its integration provider in `app.runtime.yaml`,
 * which the marketplace catalog API surfaces as `provider_id`. Callers
 * should look up the catalog entry for the app id and read
 * `entry.provider_id` directly — `null` means "no integration needed".
 */
export function getProviderForCatalogEntry(
  entry: AppCatalogEntryPayload | undefined,
): string | undefined {
  const value = entry?.provider_id?.trim();
  return value ? value : undefined;
}

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
  const slug = providerId?.trim().toLowerCase();
  const toolkit = slug ? toolkitsByProvider[slug] : undefined;
  return {
    name: toolkit?.name?.trim() || null,
    logo: toolkit?.logo ?? null,
  };
}

const ONBOARDING_ACTIVE_STATUSES = new Set(["pending", "awaiting_confirmation", "in_progress"]);
const LOCAL_OSS_TEMPLATE_USER_ID = "local-oss";
const DEFAULT_WORKSPACE_HARNESS: WorkspaceHarnessId = "pi";
const BOOTSTRAP_IPC_TIMEOUT_MS = 8_000;
type TemplateSourceMode = "local" | "marketplace" | "empty" | "empty_onboarding";
type LifecycleStepState = "pending" | "current" | "done" | "error";
type WorkspaceListLoadSource = "auto" | "live" | "cached";
type WorkspaceBrowserBootstrapMode = "fresh" | "copy_workspace" | "import_browser";
type WorkspaceCreatePhase =
  | "creating_workspace"
  | "copying_browser_profile"
  | "importing_browser_profile"
  | "finalizing";

export interface WorkspaceHarnessOption {
  id: "pi";
  label: string;
  description: string;
}

type WorkspaceHarnessId = WorkspaceHarnessOption["id"];

const WORKSPACE_HARNESS_OPTIONS: WorkspaceHarnessOption[] = [
  {
    id: "pi",
    label: "Pi",
    description: "Lean harness path without backend bootstrapping."
  }
];

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
  appCatalog: AppCatalogEntryPayload[];
  isLoadingAppCatalog: boolean;
  appCatalogError: string;
  appCatalogSource: "marketplace" | "local";
  setAppCatalogSource: (source: "marketplace" | "local") => void;
  refreshAppCatalog: () => Promise<void>;
  composioToolkitsByProvider: Record<string, ComposioToolkitMetadata>;
  installingAppId: string | null;
  installAppFromCatalog: (
    appId: string,
    options?: { connectionId?: string },
  ) => Promise<void>;
  pendingAppInstall: { appId: string; provider: string } | null;
  clearPendingAppInstall: () => void;
  connectAndInstallApp: () => Promise<void>;
  isConnectingAppIntegration: boolean;
  templateSourceMode: TemplateSourceMode;
  setTemplateSourceMode: (value: TemplateSourceMode) => void;
  createHarnessOptions: WorkspaceHarnessOption[];
  selectedCreateHarness: WorkspaceHarnessId;
  setSelectedCreateHarness: (value: string) => void;
  selectedTemplateFolder: TemplateFolderSelectionPayload | null;
  selectedWorkspaceFolder: WorkspaceRuntimeFolderSelectionPayload | null;
  clearSelectedWorkspaceFolder: () => void;
  chooseWorkspaceFolder: () => Promise<void>;
  relocateWorkspace: (workspaceId: string, newPath: string) => Promise<void>;
  chooseWorkspaceRelocationFolder: (workspaceId: string) => Promise<void>;
  activateWorkspace: (workspaceId: string) => Promise<void>;
  marketplaceTemplates: TemplateMetadataPayload[];
  selectedMarketplaceTemplate: TemplateMetadataPayload | null;
  selectMarketplaceTemplate: (templateName: string) => void;
  newWorkspaceName: string;
  setNewWorkspaceName: (value: string) => void;
  browserBootstrapMode: WorkspaceBrowserBootstrapMode;
  setBrowserBootstrapMode: (value: WorkspaceBrowserBootstrapMode) => void;
  browserBootstrapSourceWorkspaceId: string;
  setBrowserBootstrapSourceWorkspaceId: (workspaceId: string) => void;
  browserImportSource: BrowserImportSource;
  setBrowserImportSource: (source: BrowserImportSource) => void;
  browserImportProfileDir: string;
  setBrowserImportProfileDir: (profileDir: string) => void;
  workspaceCreatePhase: WorkspaceCreatePhase;
  resolvedUserId: string;
  isLoadingBootstrap: boolean;
  isRefreshing: boolean;
  isCreatingWorkspace: boolean;
  deletingWorkspaceId: string | null;
  isLoadingMarketplaceTemplates: boolean;
  canUseMarketplaceTemplates: boolean;
  marketplaceTemplatesError: string;
  retryMarketplaceTemplates: () => void;
  workspaceErrorMessage: string;
  statusSummary: string;
  lifecycleSteps: DesktopLifecycleStep[];
  setupStatus: {
    tone: "info" | "success" | "warning";
    message: string;
  } | null;
  onboardingModeActive: boolean;
  sessionModeLabel: string;
  sessionTargetId: string;
  refreshWorkspaceData: () => Promise<void>;
  chooseTemplateFolder: () => Promise<void>;
  createWorkspace: () => Promise<void>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  removeInstalledApp: (appId: string) => Promise<void>;
  selectedApps: Set<string>;
  setSelectedApps: (value: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  pendingIntegrations: ResolveTemplateIntegrationsResult | null;
  isResolvingIntegrations: boolean;
  resolveIntegrationsBeforeCreate: () => Promise<ResolveTemplateIntegrationsResult | null>;
  clearPendingIntegrations: () => void;
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

function normalizeWorkspaceHarness(value: string | null | undefined): WorkspaceHarnessId {
  void value;
  return "pi";
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

function normalizedOnboardingStatus(workspace: WorkspaceRecordPayload | null): string {
  return (workspace?.onboarding_status || "").trim().toLowerCase();
}

function isOnboardingMode(workspace: WorkspaceRecordPayload | null): boolean {
  if (!workspace) {
    return false;
  }
  const onboardingSessionId = (workspace.onboarding_session_id || "").trim();
  if (!onboardingSessionId) {
    return false;
  }
  return ONBOARDING_ACTIVE_STATUSES.has(normalizedOnboardingStatus(workspace));
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
  const [appCatalog, setAppCatalog] = useState<AppCatalogEntryPayload[]>([]);
  const [isLoadingAppCatalog, setIsLoadingAppCatalog] = useState(false);
  const [appCatalogError, setAppCatalogError] = useState("");
  const [appCatalogSource, setAppCatalogSourceState] = useState<"marketplace" | "local">("marketplace");
  const [installingAppId, setInstallingAppId] = useState<string | null>(null);
  const [templateSourceMode, setTemplateSourceModeState] = useState<TemplateSourceMode>("local");
  const [selectedCreateHarness, setSelectedCreateHarnessState] = useState<WorkspaceHarnessId>(DEFAULT_WORKSPACE_HARNESS);
  const [selectedTemplateFolder, setSelectedTemplateFolder] = useState<TemplateFolderSelectionPayload | null>(null);
  const [selectedWorkspaceFolder, setSelectedWorkspaceFolder] = useState<WorkspaceRuntimeFolderSelectionPayload | null>(null);
  const [marketplaceTemplates, setMarketplaceTemplates] = useState<TemplateMetadataPayload[]>([]);
  const [selectedMarketplaceTemplateName, setSelectedMarketplaceTemplateName] = useState("");
  const [selectedApps, setSelectedApps] = useState<Set<string>>(new Set());
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [browserBootstrapMode, setBrowserBootstrapModeState] =
    useState<WorkspaceBrowserBootstrapMode>("fresh");
  const [browserBootstrapSourceWorkspaceId, setBrowserBootstrapSourceWorkspaceIdState] =
    useState("");
  const [browserImportSource, setBrowserImportSourceState] =
    useState<BrowserImportSource>("chrome");
  const [browserImportProfileDir, setBrowserImportProfileDirState] = useState("");
  const [workspaceCreatePhase, setWorkspaceCreatePhase] =
    useState<WorkspaceCreatePhase>("creating_workspace");
  const [isLoadingBootstrap, setIsLoadingBootstrap] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
  const [isLoadingMarketplaceTemplates, setIsLoadingMarketplaceTemplates] = useState(false);
  const [marketplaceTemplatesError, setMarketplaceTemplatesError] = useState("");
  const [marketplaceTemplatesRefreshKey, setMarketplaceTemplatesRefreshKey] = useState(0);
  const [workspaceErrorMessage, setWorkspaceErrorMessage] = useState("");
  const [isLoadingInstalledApps, setIsLoadingInstalledApps] = useState(false);
  const [isActivatingWorkspace, setIsActivatingWorkspace] = useState(false);
  const [workspaceLifecycleWorkspaceId, setWorkspaceLifecycleWorkspaceId] = useState("");
  const [workspaceAppsReadyState, setWorkspaceAppsReadyState] = useState(false);
  const [workspaceBlockingReasonState, setWorkspaceBlockingReasonState] = useState("");
  const [recentAuthCompletedAt, setRecentAuthCompletedAt] = useState<number | null>(null);
  const [pendingIntegrations, setPendingIntegrations] = useState<ResolveTemplateIntegrationsResult | null>(null);
  const [isResolvingIntegrations, setIsResolvingIntegrations] = useState(false);
  const [pendingAppInstall, setPendingAppInstall] = useState<{ appId: string; provider: string } | null>(null);
  const [isConnectingAppIntegration, setIsConnectingAppIntegration] = useState(false);
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
  const canUseMarketplaceTemplates = Boolean(runtimeConfig?.authTokenPresent) && Boolean((resolvedUserId || "").trim());
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces]
  );
  const selectedWorkspaceExists = Boolean(selectedWorkspaceId) && selectedWorkspace !== null;
  const selectedMarketplaceTemplate = useMemo(
    () => marketplaceTemplates.find((template) => template.name === selectedMarketplaceTemplateName) ?? null,
    [marketplaceTemplates, selectedMarketplaceTemplateName]
  );

  useEffect(() => {
    const currentSourceWorkspaceId = browserBootstrapSourceWorkspaceId.trim();
    if (
      currentSourceWorkspaceId &&
      workspaces.some((workspace) => workspace.id === currentSourceWorkspaceId)
    ) {
      return;
    }
    setBrowserBootstrapSourceWorkspaceIdState(workspaces[0]?.id ?? "");
  }, [browserBootstrapSourceWorkspaceId, workspaces]);

  useEffect(() => {
    setBrowserImportProfileDirState("");
  }, [browserImportSource]);

  // Auto-load the marketplace app catalog once the runtime is running,
  // even if the user hasn't opened the marketplace pane yet. The
  // workspace sidebar uses `appCatalog[].provider_id` to map an installed
  // app id (e.g. "gcalendar") to its Composio toolkit slug
  // ("googlecalendar") for display name + logo lookup; without this
  // eager load the sidebar would render the bare slug for any app
  // surface entered before marketplace is visited.
  const appCatalogAutoLoadAttemptedRef = useRef(false);
  useEffect(() => {
    if (runtimeStatus?.status !== "running") return;
    if (appCatalogAutoLoadAttemptedRef.current) return;
    appCatalogAutoLoadAttemptedRef.current = true;
    void refreshAppCatalog();
    // refreshAppCatalog is stable enough for this one-shot use; we
    // intentionally don't list it as a dep to avoid re-firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeStatus?.status]);

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

  const onboardingModeActive = useMemo(() => isOnboardingMode(selectedWorkspace), [selectedWorkspace]);
  const sessionModeLabel = onboardingModeActive ? "onboarding" : "session";
  const sessionTargetId = onboardingModeActive
    ? (selectedWorkspace?.onboarding_session_id || "").trim()
    : "";
  const runtimeReadyForWorkspaceData = runtimeStatus?.status === "running";
  const workspaceLifecycleMatchesSelection = Boolean(selectedWorkspaceId) && workspaceLifecycleWorkspaceId === selectedWorkspaceId;
  const workspaceAppsReady = workspaceLifecycleMatchesSelection && workspaceAppsReadyState;
  const workspaceBlockingReason = workspaceLifecycleMatchesSelection ? workspaceBlockingReasonState : "";

  function setTemplateSourceMode(value: TemplateSourceMode) {
    setWorkspaceErrorMessage("");
    setTemplateSourceModeState(value);
  }

  function setBrowserBootstrapMode(value: WorkspaceBrowserBootstrapMode) {
    setWorkspaceErrorMessage("");
    setBrowserBootstrapModeState(value);
  }

  function setBrowserBootstrapSourceWorkspaceId(workspaceId: string) {
    setWorkspaceErrorMessage("");
    setBrowserBootstrapSourceWorkspaceIdState(workspaceId);
  }

  function setBrowserImportSource(source: BrowserImportSource) {
    setWorkspaceErrorMessage("");
    setBrowserImportSourceState(source);
  }

  function setBrowserImportProfileDir(profileDir: string) {
    setWorkspaceErrorMessage("");
    setBrowserImportProfileDirState(profileDir);
  }

  function setSelectedCreateHarness(value: string) {
    setWorkspaceErrorMessage("");
    setSelectedCreateHarnessState(normalizeWorkspaceHarness(value));
  }

  function setAppCatalogSource(source: "marketplace" | "local") {
    setAppCatalogSourceState(source);
    setAppCatalogError("");
    setAppCatalog([]);
  }

  function selectMarketplaceTemplate(templateName: string) {
    setWorkspaceErrorMessage("");
    setSelectedMarketplaceTemplateName(templateName);
    // Initialize selected apps: all apps selected by default
    const tpl = marketplaceTemplates.find((t) => t.name === templateName);
    if (tpl) {
      setSelectedApps(new Set(tpl.apps.map((a) => a.name)));
    } else {
      setSelectedApps(new Set());
    }
  }

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
    setWorkspaces((current) => {
      const nextWorkspace = lifecycle.workspace;
      const existingIndex = current.findIndex((workspace) => workspace.id === nextWorkspace.id);
      if (existingIndex === -1) {
        return [nextWorkspace, ...current];
      }
      const next = [...current];
      next[existingIndex] = { ...next[existingIndex], ...nextWorkspace };
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
        ? runtimeReadyForWorkspaceData
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
        nextRuntimeStatus.status === "running" ? "live" : "cached";
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

  async function createWorkspace() {
    setIsCreatingWorkspace(true);
    setWorkspaceCreatePhase("creating_workspace");
    setWorkspaceErrorMessage("");
    try {
      const trimmedWorkspaceName = newWorkspaceName.trim() || "Desktop Workspace";
      const customWorkspacePath = selectedWorkspaceFolder?.rootPath?.trim() || "";
      let response: WorkspaceResponsePayload;
      if (templateSourceMode === "marketplace") {
        if (!canUseMarketplaceTemplates) {
          throw new Error("Runtime binding is required to use marketplace templates.");
        }
        if (!resolvedUserId) {
          throw new Error("A runtime user id is required for marketplace templates.");
        }
        if (!selectedMarketplaceTemplate) {
          throw new Error("Choose a marketplace template first.");
        }
        // Without template_apps the main process skips install_template_apps
        // entirely and apps stay stuck at "Initializing" forever. Fall back to
        // ALL template apps when the per-app selection state is empty —
        // selectedApps is only populated by selectMarketplaceTemplate, so an
        // HMR reset / deeplink can leave it empty even though the user picked
        // a template.
        const submittedApps =
          selectedApps.size > 0
            ? [...selectedApps]
            : selectedMarketplaceTemplate.apps.map((a) => a.name);
        response = await window.electronAPI.workspace.createWorkspace({
          holaboss_user_id: resolvedUserId,
          harness: selectedCreateHarness,
          name: trimmedWorkspaceName,
          template_mode: "template",
          template_name: selectedMarketplaceTemplate.name,
          template_apps: submittedApps,
          ...(customWorkspacePath ? { workspace_path: customWorkspacePath } : {})
        });
      } else if (templateSourceMode === "empty" || templateSourceMode === "empty_onboarding") {
        response = await window.electronAPI.workspace.createWorkspace({
          holaboss_user_id: resolvedUserId || LOCAL_OSS_TEMPLATE_USER_ID,
          harness: selectedCreateHarness,
          name: trimmedWorkspaceName,
          template_mode: templateSourceMode === "empty_onboarding" ? "empty_onboarding" : "empty",
          ...(customWorkspacePath ? { workspace_path: customWorkspacePath } : {})
        });
      } else {
        if (!selectedTemplateFolder?.rootPath) {
          throw new Error("Choose a template folder first.");
        }
        response = await window.electronAPI.workspace.createWorkspace({
          holaboss_user_id: resolvedUserId || LOCAL_OSS_TEMPLATE_USER_ID,
          harness: selectedCreateHarness,
          name: trimmedWorkspaceName,
          template_mode: "template",
          template_root_path: selectedTemplateFolder.rootPath,
          ...(customWorkspacePath ? { workspace_path: customWorkspacePath } : {})
        });
      }
      setNewWorkspaceName("");
      setSelectedWorkspaceFolder(null);
      await loadWorkspaceData({ preserveSelection: false, allowEmpty: true });
      const createdWorkspaceId = response.workspace.id;
      setSelectedWorkspaceId(createdWorkspaceId);

      let postCreateWarning = "";
      if (browserBootstrapMode === "copy_workspace") {
        const sourceWorkspaceId = browserBootstrapSourceWorkspaceId.trim();
        if (sourceWorkspaceId) {
          setWorkspaceCreatePhase("copying_browser_profile");
          try {
            await window.electronAPI.workspace.copyBrowserWorkspaceProfile({
              sourceWorkspaceId,
              targetWorkspaceId: createdWorkspaceId,
            });
          } catch (error) {
            postCreateWarning = `Workspace created, but browser profile copy failed: ${normalizeErrorMessage(error)}`;
          }
        }
      } else if (browserBootstrapMode === "import_browser") {
        setWorkspaceCreatePhase("importing_browser_profile");
        try {
          await window.electronAPI.workspace.importBrowserProfile({
            workspaceId: createdWorkspaceId,
            source: browserImportSource,
            profileDir:
              browserImportSource === "safari"
                ? undefined
                : (browserImportProfileDir.trim() || undefined),
          });
        } catch (error) {
          postCreateWarning = `Workspace created, but browser import failed: ${normalizeErrorMessage(error)}`;
        }
      }

      if (postCreateWarning) {
        setWorkspaceErrorMessage(postCreateWarning);
      }

      setWorkspaceCreatePhase("finalizing");
      // Keep the creating view alive for one more task so panel-based creation
      // can hand off cleanly to the newly selected workspace without flashing
      // the configuration screen again before the panel closes.
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
      });
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
    } finally {
      setIsCreatingWorkspace(false);
      setWorkspaceCreatePhase("creating_workspace");
    }
  }

  async function deleteWorkspace(workspaceId: string) {
    const trimmedWorkspaceId = workspaceId.trim();
    if (!trimmedWorkspaceId) {
      throw new Error("workspaceId is required");
    }
    setDeletingWorkspaceId(trimmedWorkspaceId);
    setWorkspaceErrorMessage("");
    try {
      if (selectedWorkspaceId === trimmedWorkspaceId) {
        const fallbackWorkspaceId =
          workspaces.find((workspace) => workspace.id !== trimmedWorkspaceId)?.id ??
          "";
        setSelectedWorkspaceId(fallbackWorkspaceId);
        setInstalledApps([]);
        setIsLoadingInstalledApps(false);
        setWorkspaceLifecycleWorkspaceId("");
        setWorkspaceAppsReadyState(false);
        setWorkspaceBlockingReasonState("");
      }
      await window.electronAPI.workspace.deleteWorkspace(trimmedWorkspaceId);
      await loadWorkspaceData({ preserveSelection: true, allowEmpty: true });
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
      throw error;
    } finally {
      setDeletingWorkspaceId((current) => (current === trimmedWorkspaceId ? null : current));
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

  async function refreshAppCatalog() {
    setIsLoadingAppCatalog(true);
    setAppCatalogError("");
    try {
      await window.electronAPI.workspace.syncAppCatalog({ source: appCatalogSource });
      const response = await window.electronAPI.workspace.listAppCatalog({
        source: appCatalogSource,
      });
      setAppCatalog(response.entries);
    } catch (error) {
      setAppCatalog([]);
      setAppCatalogError(normalizeErrorMessage(error));
    } finally {
      setIsLoadingAppCatalog(false);
    }
  }

  function providerForApp(appId: string): string | undefined {
    const entry = appCatalog.find((e) => e.app_id === appId);
    return getProviderForCatalogEntry(entry);
  }

  async function installAppFromCatalog(
    appId: string,
    options?: { connectionId?: string },
  ) {
    if (!selectedWorkspaceId) {
      setAppCatalogError("Select a workspace first.");
      return;
    }
    if (installingAppId) {
      return;
    }
    setAppCatalogError("");

    // Check if this app requires an integration that isn't connected yet
    const provider = providerForApp(appId);
    if (provider) {
      try {
        const { connections } = await window.electronAPI.workspace.listIntegrationConnections();
        const hasActive = connections.some(
          (c) => c.provider_id === provider && c.status === "active",
        );
        if (!hasActive) {
          setPendingAppInstall({ appId, provider });
          return;
        }
      } catch {
        // If we can't check integrations, proceed with install anyway
      }
    }

    await doInstallApp(appId, options?.connectionId ?? null);
  }

  async function doInstallApp(appId: string, requestedConnectionId: string | null) {
    if (!selectedWorkspaceId) return;
    setInstallingAppId(appId);
    setPendingAppInstall(null);
    setAppCatalogError("");
    try {
      await window.electronAPI.workspace.installAppFromCatalog({
        workspaceId: selectedWorkspaceId,
        appId,
        source: appCatalogSource,
      });
      // Resolve the connection to bind for this app:
      //   1. caller explicitly chose one (multi-account picker on the
      //      install card) → use that, validating it still exists +
      //      matches the expected provider before writing.
      //   2. otherwise — auto-pick the most-recently-updated active
      //      connection on the expected provider. This is the silent
      //      single-account happy path; with the dedupe work in place
      //      "first match" is now stable.
      const provider = providerForApp(appId);
      if (provider && selectedWorkspaceId) {
        try {
          const { connections } = await window.electronAPI.workspace.listIntegrationConnections();
          const requested = requestedConnectionId
            ? connections.find(
                (c) =>
                  c.connection_id === requestedConnectionId &&
                  c.status === "active" &&
                  c.provider_id === provider,
              )
            : null;
          const fallback = requested
            ? null
            : connections.find(
                (c) => c.provider_id === provider && c.status === "active",
              );
          const conn = requested ?? fallback;
          if (conn) {
            await window.electronAPI.workspace.upsertIntegrationBinding(
              selectedWorkspaceId,
              "app",
              appId,
              provider,
              { connection_id: conn.connection_id },
            );
          }
        } catch {
          // Non-fatal — binding can be set up later
        }
      }
      await refreshInstalledApps();
    } catch (error) {
      setAppCatalogError(normalizeErrorMessage(error));
    } finally {
      setInstallingAppId(null);
    }
  }

  function clearPendingAppInstall() {
    setPendingAppInstall(null);
  }

  async function connectAndInstallApp() {
    if (!pendingAppInstall) return;
    const { appId, provider } = pendingAppInstall;
    setIsConnectingAppIntegration(true);
    setAppCatalogError("");
    try {
      const runtimeConfig = await window.electronAPI.runtime.getConfig();
      const userId = runtimeConfig.userId ?? (resolvedUserId || "local");

      // Snapshot existing connection ids before initiating — see
      // IntegrationsPane comment: poll the list and look for a new id,
      // since the id from /link isn't reliably queryable.
      let beforeIds = new Set<string>();
      try {
        const before =
          await window.electronAPI.workspace.composioListConnections();
        beforeIds = new Set(before.connections.map((c) => c.id));
      } catch {
        // tolerate snapshot failure
      }

      const link = await window.electronAPI.workspace.composioConnect({
        provider,
        owner_user_id: userId,
      });
      await window.electronAPI.ui.openExternalUrl(link.redirect_url);

      const COMPOSIO_POLL_INTERVAL_MS = 3000;
      const COMPOSIO_POLL_MAX_TICKS = 100;
      const MAX_CONSECUTIVE_ERRORS = 20;
      let consecutiveErrors = 0;
      let connected = false;
      for (let tick = 0; tick < COMPOSIO_POLL_MAX_TICKS; tick++) {
        await new Promise((r) => setTimeout(r, COMPOSIO_POLL_INTERVAL_MS));
        let current;
        try {
          current =
            await window.electronAPI.workspace.composioListConnections();
          consecutiveErrors = 0;
        } catch (pollError) {
          consecutiveErrors += 1;
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw pollError;
          }
          continue;
        }
        const newConnection = current.connections.find(
          (c) =>
            !beforeIds.has(c.id) &&
            c.toolkitSlug.toLowerCase() === provider.toLowerCase(),
        );
        if (newConnection) {
          await window.electronAPI.workspace.composioFinalize({
            connected_account_id: newConnection.id,
            provider,
            owner_user_id: userId,
            account_label: `${provider} (Managed)`,
          });
          // First-time connect → no requested connectionId; doInstallApp
          // falls through to its "auto-pick first active" path which now
          // sees the freshly-stored connection.
          await doInstallApp(appId, null);
          connected = true;
          return;
        }
      }
      if (!connected) {
        setAppCatalogError(
          `Connection to ${provider} timed out after ${
            (COMPOSIO_POLL_MAX_TICKS * COMPOSIO_POLL_INTERVAL_MS) / 1000
          }s. Please try again.`,
        );
      }
    } catch (error) {
      setAppCatalogError(normalizeErrorMessage(error));
    } finally {
      setIsConnectingAppIntegration(false);
    }
  }

  function retryMarketplaceTemplates() {
    setMarketplaceTemplatesRefreshKey((k) => k + 1);
  }

  async function chooseTemplateFolder() {
    setWorkspaceErrorMessage("");
    try {
      const selection = await window.electronAPI.workspace.pickTemplateFolder();
      if (!selection.canceled && selection.rootPath) {
        setSelectedTemplateFolder(selection);
        setTemplateSourceModeState("local");
      }
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
    }
  }

  async function chooseWorkspaceFolder() {
    setWorkspaceErrorMessage("");
    try {
      const selection = await window.electronAPI.workspace.pickWorkspaceRuntimeFolder();
      if (!selection.canceled && selection.rootPath) {
        setSelectedWorkspaceFolder(selection);
      }
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
    }
  }

  function clearSelectedWorkspaceFolder() {
    setSelectedWorkspaceFolder(null);
  }

  async function relocateWorkspace(workspaceId: string, newPath: string) {
    setWorkspaceErrorMessage("");
    try {
      await window.electronAPI.workspace.relocate(workspaceId, newPath);
      await loadWorkspaceData({ preserveSelection: true });
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
      throw error;
    }
  }

  async function chooseWorkspaceRelocationFolder(workspaceId: string) {
    setWorkspaceErrorMessage("");
    try {
      const selection = await window.electronAPI.workspace.pickWorkspaceRelocationFolder(workspaceId);
      if (!selection.canceled && selection.rootPath) {
        await relocateWorkspace(workspaceId, selection.rootPath);
      }
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
    }
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

  async function resolveIntegrationsBeforeCreate(): Promise<ResolveTemplateIntegrationsResult | null> {
    if (templateSourceMode === "empty" || templateSourceMode === "empty_onboarding") {
      return null;
    }
    setIsResolvingIntegrations(true);
    try {
      const trimmedName = newWorkspaceName.trim() || "Desktop Workspace";
      let payload: HolabossCreateWorkspacePayload;
      if (templateSourceMode === "marketplace" && selectedMarketplaceTemplate) {
        payload = {
          holaboss_user_id: resolvedUserId,
          harness: selectedCreateHarness,
          name: trimmedName,
          template_mode: "template",
          template_name: selectedMarketplaceTemplate.name,
          template_apps: [...selectedApps]
        };
      } else if (selectedTemplateFolder?.rootPath) {
        payload = {
          holaboss_user_id: resolvedUserId || "local-oss",
          harness: selectedCreateHarness,
          name: trimmedName,
          template_mode: "template",
          template_root_path: selectedTemplateFolder.rootPath
        };
      } else {
        return null;
      }
      const result = await window.electronAPI.workspace.resolveTemplateIntegrations(payload);
      setPendingIntegrations(result);
      return result.missing_providers.length > 0 ? result : null;
    } catch (error) {
      setWorkspaceErrorMessage(normalizeErrorMessage(error));
      return null;
    } finally {
      setIsResolvingIntegrations(false);
    }
  }

  function clearPendingIntegrations() {
    setPendingIntegrations(null);
  }

  useEffect(() => {
    let cancelled = false;
    async function loadMarketplaceTemplates() {
      setIsLoadingMarketplaceTemplates(true);
      setMarketplaceTemplatesError("");
      try {
        // Renderer-direct call to Hono's @holaboss/app-sdk surface (no IPC
        // round-trip). The SDK targets the same `/api/marketplace/templates`
        // endpoint the main process used and returns the same shape.
        const client = getMarketplaceAppSdkClient();
        const data = await sdkListMarketplaceTemplates({ client });
        if (cancelled) {
          return;
        }
        // Community-source templates can omit the array fields. Normalize
        // here at the read boundary so downstream UI can rely on them
        // being present — same behaviour the main-process helper had.
        const rawTemplates = (data.templates ?? []) as TemplateMetadataPayload[];
        const visibleTemplates = rawTemplates
          .filter((template) => !template.is_hidden)
          .map((template) => ({
            ...template,
            apps: (template.apps ?? []).map((a: unknown) =>
              typeof a === "string" ? { name: a, required: true } : a
            ) as TemplateAppEntryPayload[],
            agents: template.agents ?? [],
            views: template.views ?? [],
            tags: template.tags ?? [],
            min_optional_apps: template.min_optional_apps ?? 0,
          }));
        setMarketplaceTemplates(visibleTemplates);
        setSelectedMarketplaceTemplateName((current) => {
          if (current && visibleTemplates.some((template) => template.name === current)) {
            return current;
          }
          return visibleTemplates.find((template) => !template.is_coming_soon)?.name || visibleTemplates[0]?.name || "";
        });
      } catch (error) {
        if (!cancelled) {
          setMarketplaceTemplates([]);
          setSelectedMarketplaceTemplateName("");
          setMarketplaceTemplatesError(normalizeErrorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingMarketplaceTemplates(false);
        }
      }
    }

    void loadMarketplaceTemplates();
    return () => {
      cancelled = true;
    };
  }, [canUseMarketplaceTemplates, resolvedUserId, marketplaceTemplatesRefreshKey]);

  useEffect(() => {
    let cancelled = false;

    // Workspace summaries can now hydrate from either the live runtime
    // (`listWorkspaces`) or the cached control-plane-like local registry
    // (`listWorkspacesCached`). That lets the desktop render the workspace
    // list before the runtime is fully ready, while still reconciling
    // against the live runtime once it reaches `running`.
    const workspaceListSource =
      runtimeReadyForWorkspaceData ? "live" : "cached";

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
  }, [resolvedUserId, runtimeReadyForWorkspaceData, runtimeStatus?.lastError, runtimeStatus?.status, workspaces.length]);

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
    if (!selectedWorkspaceId || !selectedWorkspaceExists || !runtimeReadyForWorkspaceData) {
      setInstalledApps([]);
      setIsLoadingInstalledApps(false);
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
  }, [runtimeReadyForWorkspaceData, selectedWorkspaceExists, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedWorkspaceExists || !runtimeReadyForWorkspaceData) {
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
  }, [runtimeReadyForWorkspaceData, selectedWorkspaceExists, selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId || !onboardingModeActive) {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(() => {
      void window.electronAPI.workspace
        .listWorkspaces()
        .then((response) => {
          if (!cancelled) {
            setWorkspaces(response.items);
          }
        })
        .catch(() => undefined);
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedWorkspaceId, onboardingModeActive]);

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
        message: "Local template import is available without sign-in. Sign in only for synced Holaboss product settings."
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
      void refreshInstalledApps();
    }, 3000);
    return () => clearInterval(timer);
  }, [installedApps, selectedWorkspaceId]);

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
      appCatalog,
      isLoadingAppCatalog,
      appCatalogError,
      appCatalogSource,
      setAppCatalogSource,
      refreshAppCatalog,
      composioToolkitsByProvider,
      installingAppId,
      installAppFromCatalog,
      pendingAppInstall,
      clearPendingAppInstall,
      connectAndInstallApp,
      isConnectingAppIntegration,
      templateSourceMode,
      setTemplateSourceMode,
      createHarnessOptions: WORKSPACE_HARNESS_OPTIONS,
      selectedCreateHarness,
      setSelectedCreateHarness,
      selectedTemplateFolder,
      selectedWorkspaceFolder,
      clearSelectedWorkspaceFolder,
      chooseWorkspaceFolder,
      relocateWorkspace,
      chooseWorkspaceRelocationFolder,
      activateWorkspace,
      marketplaceTemplates,
      selectedMarketplaceTemplate,
      selectMarketplaceTemplate,
      newWorkspaceName,
      setNewWorkspaceName,
      browserBootstrapMode,
      setBrowserBootstrapMode,
      browserBootstrapSourceWorkspaceId,
      setBrowserBootstrapSourceWorkspaceId,
      browserImportSource,
      setBrowserImportSource,
      browserImportProfileDir,
      setBrowserImportProfileDir,
      workspaceCreatePhase,
      resolvedUserId,
      isLoadingBootstrap,
      isRefreshing,
      isCreatingWorkspace,
      deletingWorkspaceId,
      isLoadingMarketplaceTemplates,
      canUseMarketplaceTemplates,
      marketplaceTemplatesError,
      retryMarketplaceTemplates,
      workspaceErrorMessage,
      statusSummary,
      lifecycleSteps,
      setupStatus,
      onboardingModeActive,
      sessionModeLabel,
      sessionTargetId,
      refreshWorkspaceData,
      chooseTemplateFolder,
      createWorkspace,
      deleteWorkspace,
      removeInstalledApp,
      selectedApps,
      setSelectedApps,
      pendingIntegrations,
      isResolvingIntegrations,
      resolveIntegrationsBeforeCreate,
      clearPendingIntegrations
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
      appCatalog,
      isLoadingAppCatalog,
      appCatalogError,
      appCatalogSource,
      setAppCatalogSource,
      refreshAppCatalog,
      composioToolkitsByProvider,
      installingAppId,
      installAppFromCatalog,
      pendingAppInstall,
      isConnectingAppIntegration,
      templateSourceMode,
      selectedCreateHarness,
      selectedTemplateFolder,
      selectedWorkspaceFolder,
      marketplaceTemplates,
      selectedMarketplaceTemplate,
      newWorkspaceName,
      browserBootstrapMode,
      browserBootstrapSourceWorkspaceId,
      browserImportSource,
      browserImportProfileDir,
      workspaceCreatePhase,
      resolvedUserId,
      isLoadingBootstrap,
      isRefreshing,
      isCreatingWorkspace,
      deletingWorkspaceId,
      isLoadingMarketplaceTemplates,
      canUseMarketplaceTemplates,
      marketplaceTemplatesError,
      workspaceErrorMessage,
      statusSummary,
      lifecycleSteps,
      setupStatus,
      onboardingModeActive,
      sessionModeLabel,
      sessionTargetId,
      workspaceAppsReady,
      workspaceBlockingReason,
      retryMarketplaceTemplates,
      refreshWorkspaceData,
      chooseTemplateFolder,
      chooseWorkspaceFolder,
      relocateWorkspace,
      chooseWorkspaceRelocationFolder,
      activateWorkspace,
      createWorkspace,
      deleteWorkspace,
      removeInstalledApp,
      selectedApps,
      pendingIntegrations,
      isResolvingIntegrations,
      resolveIntegrationsBeforeCreate,
      clearPendingIntegrations
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
