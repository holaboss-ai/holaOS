import {
  DEFAULT_HARNESS_ID,
  DESKTOP_BROWSER_TOOL_IDS,
  HARNESS_DEFINITIONS,
  RUNTIME_AGENT_TOOL_IDS,
  type HarnessBackendRestartRequest,
  type HarnessBootstrapPayload,
  type HarnessEnsureReadyContext,
  type HarnessHostRequestBuildParams,
  type HarnessModelConfigSyncRequest,
  type HarnessModelConfigSyncResult,
  type HarnessPrepareRunParams,
  type HarnessRuntimeConfigPayload,
  type HarnessRuntimeConfigUpdateContext,
  type HarnessRuntimeStatus,
  type HarnessRuntimeStatusContext,
  type HarnessToolRefPayload,
  type HarnessRunnerRequestLike,
  type RuntimeHarnessAdapter,
} from "../../harnesses/src/index.js";

export {
  DEFAULT_HARNESS_ID,
  type HarnessBackendRestartRequest,
  type HarnessBootstrapPayload,
  type HarnessEnsureReadyContext,
  type HarnessHostRequestBuildParams,
  type HarnessModelConfigSyncRequest,
  type HarnessModelConfigSyncResult,
  type HarnessPrepareRunParams,
  type HarnessRuntimeConfigPayload,
  type HarnessRuntimeConfigUpdateContext,
  type HarnessRuntimeStatus,
  type HarnessRuntimeStatusContext,
  type HarnessToolRefPayload,
  type HarnessRunnerRequestLike,
  type RuntimeHarnessAdapter,
};

export interface RuntimeHarnessBrowserConfig {
  desktopBrowserEnabled: boolean;
  desktopBrowserUrl: string;
  desktopBrowserAuthToken: string;
}

export interface RuntimeHarnessProductConfig {
  authToken: string;
  sandboxId: string;
  modelProxyBaseUrl: string;
  defaultModel: string;
}

export interface RuntimeHarnessPrepareRunContext {
  request: HarnessRunnerRequestLike;
  bootstrap: HarnessBootstrapPayload;
  runtimeConfig: HarnessRuntimeConfigPayload;
  stagedSkillsChanged: boolean;
}

export interface RuntimeHarnessPluginStatus {
  backendConfigPresent: boolean;
  harnessStatus: HarnessRuntimeStatus;
}

export interface RuntimeHarnessPlugin {
  id: string;
  adapter: RuntimeHarnessAdapter;
  stageBrowserTools: (params: {
    workspaceDir: string;
    sessionKind?: string | null;
    browserConfig: RuntimeHarnessBrowserConfig;
  }) => { changed: boolean; toolIds: string[] };
  stageRuntimeTools: (params: { workspaceDir: string }) => { changed: boolean; toolIds: string[] };
  stageCommands: (params: { workspaceDir: string }) => { changed: boolean; commandIds: string[] };
  stageSkills: (params: { workspaceDir: string; runtimeRoot: string }) => {
    changed: boolean;
    skillIds: string[];
  };
  prepareRun: (params: RuntimeHarnessPrepareRunContext) => Promise<void>;
  describeRuntimeStatus: (params: {
    configLoaded: boolean;
    probeBackendReadiness: (target: string) => Promise<boolean>;
  }) => Promise<RuntimeHarnessPluginStatus>;
  handleRuntimeConfigUpdated: (params: {
    productConfig: RuntimeHarnessProductConfig;
    ensureSelectedHarnessReady: () => Promise<void>;
  }) => Promise<void>;
  ensureReady: (fetchImpl: typeof fetch) => Promise<void>;
  backendBaseUrl: (params: { workspaceId: string; workspaceDir: string }) => string;
  timeoutSeconds: (params: { request: HarnessRunnerRequestLike }) => number;
}

function normalizeHarnessIdInternal(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized || DEFAULT_HARNESS_ID;
}

function browserToolsAllowedForSession(sessionKind: string | null | undefined): boolean {
  const normalized = normalizeSessionKind(sessionKind);
  return normalized === "subagent";
}

function normalizeSessionKind(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function timeoutSecondsFromEnv(envName: string, defaultValue: number): number {
  const raw = (process.env[envName] ?? String(defaultValue)).trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }
  return Math.max(1, Math.min(parsed, 7200));
}

function defaultHarnessTimeoutSeconds(sessionKind: string | null | undefined): number {
  const baseTimeoutSeconds = timeoutSecondsFromEnv("HOLABOSS_HARNESS_RUN_TIMEOUT_S", 1800);
  const normalizedSessionKind = normalizeSessionKind(sessionKind);
  if (normalizedSessionKind === "subagent") {
    return timeoutSecondsFromEnv(
      "HOLABOSS_SUBAGENT_HARNESS_RUN_TIMEOUT_S",
      Math.max(baseTimeoutSeconds, 7200)
    );
  }
  if (normalizedSessionKind !== "task_proposal") {
    return baseTimeoutSeconds;
  }
  return timeoutSecondsFromEnv(
    "HOLABOSS_TASK_PROPOSAL_HARNESS_RUN_TIMEOUT_S",
    Math.max(baseTimeoutSeconds, 7200)
  );
}

const adapterById = new Map(HARNESS_DEFINITIONS.map((definition) => [definition.id, definition.runtimeAdapter]));

function requireBaseAdapter(harnessId: string): RuntimeHarnessAdapter {
  const adapter = adapterById.get(harnessId);
  if (!adapter) {
    throw new Error(`unsupported harness: ${harnessId}`);
  }
  return adapter;
}

const piAdapter = requireBaseAdapter("pi");

const piRuntimeHarnessPlugin: RuntimeHarnessPlugin = {
  id: "pi",
  adapter: piAdapter,
  stageBrowserTools(params) {
    const browserEnabled = Boolean(
      browserToolsAllowedForSession(params.sessionKind) &&
      params.browserConfig.desktopBrowserEnabled &&
      params.browserConfig.desktopBrowserUrl.trim() &&
      params.browserConfig.desktopBrowserAuthToken.trim()
    );
    return { changed: false, toolIds: browserEnabled ? [...DESKTOP_BROWSER_TOOL_IDS] : [] };
  },
  stageRuntimeTools() {
    return { changed: false, toolIds: [...RUNTIME_AGENT_TOOL_IDS] };
  },
  stageCommands() {
    return { changed: false, commandIds: [] };
  },
  stageSkills() {
    return { changed: false, skillIds: [] };
  },
  async prepareRun(params) {
    await piAdapter.prepareRun?.({
      ...params,
      syncModelConfig: () => ({
        path: "",
        backend_config_changed: false,
        model_selection_changed: false
      }),
      restartBackend: async () => {},
      backendBaseUrl: "",
      backendHost: "",
      backendPort: 0,
      backendReadyTimeoutSeconds: 0,
      buildBackendFingerprint: () => ""
    });
  },
  async describeRuntimeStatus(params) {
    const harnessStatus = await piAdapter.describeRuntimeStatus({
      configLoaded: params.configLoaded,
      backendConfigPresent: false,
      backendReadinessTarget: null,
      probeBackendReadiness: params.probeBackendReadiness
    });
    return {
      backendConfigPresent: false,
      harnessStatus
    };
  },
  async handleRuntimeConfigUpdated(params) {
    await piAdapter.handleRuntimeConfigUpdated?.({
      writeBootstrapConfigIfAvailable: () => {
        void params.productConfig;
      },
      ensureSelectedHarnessReady: params.ensureSelectedHarnessReady
    });
  },
  async ensureReady(fetchImpl) {
    await piAdapter.ensureReady?.({
      ensureHarnessBackendReady: async () => {
        void fetchImpl;
      }
    });
  },
  backendBaseUrl(_params) {
    return "";
  },
  timeoutSeconds(params) {
    return defaultHarnessTimeoutSeconds(params.request.session_kind);
  }
};

const HARNESS_PLUGINS = [piRuntimeHarnessPlugin] as const;
const HARNESS_ADAPTERS = HARNESS_PLUGINS.map((plugin) => plugin.adapter);

export function normalizeHarnessId(value: unknown): string {
  return normalizeHarnessIdInternal(value);
}

export function listRuntimeHarnessAdapters(): readonly RuntimeHarnessAdapter[] {
  return HARNESS_ADAPTERS;
}

export function listRuntimeHarnessPlugins(): readonly RuntimeHarnessPlugin[] {
  return HARNESS_PLUGINS;
}

export function resolveRuntimeHarnessAdapter(harnessId: unknown): RuntimeHarnessAdapter | null {
  return resolveRuntimeHarnessPlugin(harnessId)?.adapter ?? null;
}

export function resolveRuntimeHarnessPlugin(harnessId: unknown): RuntimeHarnessPlugin | null {
  const normalized = normalizeHarnessIdInternal(harnessId);
  return HARNESS_PLUGINS.find((plugin) => plugin.id === normalized) ?? null;
}

export function requireRuntimeHarnessAdapter(harnessId: unknown): RuntimeHarnessAdapter {
  const adapter = resolveRuntimeHarnessAdapter(harnessId);
  if (!adapter) {
    throw new Error(`unsupported harness: ${normalizeHarnessIdInternal(harnessId)}`);
  }
  return adapter;
}

export function requireRuntimeHarnessPlugin(harnessId: unknown): RuntimeHarnessPlugin {
  const plugin = resolveRuntimeHarnessPlugin(harnessId);
  if (!plugin) {
    throw new Error(`unsupported harness: ${normalizeHarnessIdInternal(harnessId)}`);
  }
  return plugin;
}
