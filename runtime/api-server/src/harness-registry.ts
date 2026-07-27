import {
  browserToolsEnabledForSessionKind,
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
  // Single source of truth shared with pi's in-process wiring and the CLI
  // harnesses' MCP bridge (see browser-session-gate). Keeping staging (what the
  // manifest advertises) on the same predicate as wiring (what's actually
  // callable) is what stops the model being told about tools it can't use — or
  // handed tools it was told it lacks.
  return browserToolsEnabledForSessionKind(sessionKind);
}

/**
 * Browser tools stage identically for every harness: gated by session kind and
 * only when the desktop browser capability is actually configured. pi wires the
 * staged ids into its in-process toolset; CLI harnesses reach the same tools
 * over the runtime-tools MCP bridge, but both advertise them through this same
 * staged set so the capability manifest stays consistent.
 */
function stageDesktopBrowserToolIds(params: {
  sessionKind?: string | null;
  browserConfig: RuntimeHarnessBrowserConfig;
}): { changed: boolean; toolIds: string[] } {
  const browserEnabled = Boolean(
    browserToolsAllowedForSession(params.sessionKind) &&
    params.browserConfig.desktopBrowserEnabled &&
    params.browserConfig.desktopBrowserUrl.trim() &&
    params.browserConfig.desktopBrowserAuthToken.trim()
  );
  return { changed: false, toolIds: browserEnabled ? [...DESKTOP_BROWSER_TOOL_IDS] : [] };
}

function normalizeSessionKind(value: string | null | undefined): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "task_proposal") {
    return "subagent";
  }
  return normalized;
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
  return baseTimeoutSeconds;
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
    return stageDesktopBrowserToolIds(params);
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

// CLI-based harnesses (Claude Code, Codex, …) bring their own tools and
// auth. The api-server-side plugin is a thin shell: no tool injection,
// no backend, no proxy. The host-side runner spawns the CLI and parses
// its protocol; MCP servers reach the CLI via its native config (e.g.
// --mcp-config for Claude, $CODEX_HOME/config.toml for Codex).
function buildCliRuntimeHarnessPlugin(adapter: RuntimeHarnessAdapter): RuntimeHarnessPlugin {
  return {
    id: adapter.id,
    adapter,
    // CLI harnesses reach the browser tools over the runtime-tools MCP bridge,
    // but still stage them here so the capability manifest advertises what the
    // bridge makes callable — same gate as pi.
    stageBrowserTools(params) {
      return stageDesktopBrowserToolIds(params);
    },
    stageRuntimeTools() {
      return { changed: false, toolIds: [] };
    },
    stageCommands() {
      return { changed: false, commandIds: [] };
    },
    stageSkills() {
      return { changed: false, skillIds: [] };
    },
    async prepareRun() {
      // CLI harnesses don't share the pi backend lifecycle — the host
      // runner does its own per-invocation setup.
    },
    async describeRuntimeStatus() {
      return {
        backendConfigPresent: false,
        harnessStatus: { ready: true, state: "ready" },
      };
    },
    async handleRuntimeConfigUpdated() {
      // No persistent backend to reconfigure.
    },
    async ensureReady() {
      // No persistent backend to warm up.
    },
    backendBaseUrl() {
      return "";
    },
    timeoutSeconds(params) {
      return defaultHarnessTimeoutSeconds(params.request.session_kind);
    },
  };
}

const claudeCodeRuntimeHarnessPlugin = buildCliRuntimeHarnessPlugin(requireBaseAdapter("claude-code"));
const codexRuntimeHarnessPlugin = buildCliRuntimeHarnessPlugin(requireBaseAdapter("codex"));

const HARNESS_PLUGINS = [
  piRuntimeHarnessPlugin,
  claudeCodeRuntimeHarnessPlugin,
  codexRuntimeHarnessPlugin,
] as const;
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
  return requireRuntimeHarnessPlugin(harnessId).adapter;
}

export function requireRuntimeHarnessPlugin(harnessId: unknown): RuntimeHarnessPlugin {
  const plugin = resolveRuntimeHarnessPlugin(harnessId);
  if (plugin) {
    return plugin;
  }
  // Graceful fallback for sessions/bindings/workspaces still pinned to a
  // harness that has since been removed from the registry (e.g. legacy
  // removed-harness bindings). Rather than crash the
  // run with `unsupported harness`, fall back to the built-in default (pi).
  const fallback = resolveRuntimeHarnessPlugin(DEFAULT_HARNESS_ID);
  if (!fallback) {
    throw new Error(`unsupported harness: ${normalizeHarnessIdInternal(harnessId)}`);
  }
  const requested = normalizeHarnessIdInternal(harnessId);
  if (requested !== DEFAULT_HARNESS_ID) {
    console.warn(
      `[harness-registry] harness "${requested}" is not registered; falling back to "${DEFAULT_HARNESS_ID}"`,
    );
  }
  return fallback;
}
