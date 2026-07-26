import fs from "node:fs";
import path from "node:path";
import {
  normalizeHarnessId,
  requireRuntimeHarnessPlugin,
} from "./harness-registry.js";
import { resolveHarnessAvailabilityWithModels } from "./harness-availability.js";

const HOLABOSS_MODEL_PROXY_BASE_URL_ENV = "HOLABOSS_MODEL_PROXY_BASE_URL";
const HOLABOSS_MODEL_PROXY_BASE_URL_DEFAULT_ENV = "HOLABOSS_MODEL_PROXY_BASE_URL_DEFAULT";
const HOLABOSS_SANDBOX_AUTH_TOKEN_ENV = "HOLABOSS_SANDBOX_AUTH_TOKEN";
const HOLABOSS_USER_ID_ENV = "HOLABOSS_USER_ID";
const HOLABOSS_DEFAULT_MODEL_ENV = "HOLABOSS_DEFAULT_MODEL";
const HOLABOSS_RUNTIME_CONFIG_PATH_ENV = "HOLABOSS_RUNTIME_CONFIG_PATH";
const HOLABOSS_DESKTOP_BROWSER_ENABLED_ENV = "HOLABOSS_DESKTOP_BROWSER_ENABLED";
const HOLABOSS_DESKTOP_BROWSER_URL_ENV = "HOLABOSS_DESKTOP_BROWSER_URL";
const HOLABOSS_DESKTOP_BROWSER_AUTH_TOKEN_ENV = "HOLABOSS_DESKTOP_BROWSER_AUTH_TOKEN";
const HOLABOSS_DESKTOP_BROWSER_ALLOWED_DOMAINS_ENV = "HOLABOSS_DESKTOP_BROWSER_ALLOWED_DOMAINS";
const HOLABOSS_DESKTOP_BROWSER_BLOCKED_ACTIONS_ENV = "HOLABOSS_DESKTOP_BROWSER_BLOCKED_ACTIONS";
const HOLABOSS_DESKTOP_BROWSER_CONFIRM_ACTIONS_ENV = "HOLABOSS_DESKTOP_BROWSER_CONFIRM_ACTIONS";
const HOLABOSS_DESKTOP_BROWSER_UNTRUSTED_BOUNDARIES_ENV = "HOLABOSS_DESKTOP_BROWSER_UNTRUSTED_BOUNDARIES";
const HB_SANDBOX_ROOT_ENV = "HB_SANDBOX_ROOT";
const SANDBOX_AGENT_HARNESS_ENV = "SANDBOX_AGENT_HARNESS";

const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_RUNTIME_MODE = "oss";
const HOLABOSS_PROXY_PROVIDER = "holaboss_model_proxy";

type StringMap = Record<string, unknown>;

export type ProductRuntimeConfig = {
  authToken: string;
  userId: string;
  // Org-billing: the active org the desktop is scoped to. Forwarded as
  // X-Holaboss-Org-Id on model-proxy calls so consumption attributes to this org
  // (else the product side falls back to the user's personal org). Attribution
  // only — no wallet is debited by it yet (that's org-billing Slice 3).
  orgId?: string;
  // BYO (bring-your-own-key) org — the org whose stored provider keys this run
  // may use. Distinct from orgId (billing): desktop Personal deliberately keeps
  // orgId null (bills the personal wallet), yet still owns BYO keys under a real
  // personal-org id, which travels here and is forwarded as X-Holaboss-Byo-Org-Id
  // for key lookup only. Falls back to orgId (team orgs) when absent.
  byoOrgId?: string;
  sandboxId: string;
  modelProxyBaseUrl: string;
  defaultModel: string;
  subagentModel?: string;
  runtimeMode: string;
  defaultProvider: string;
  holabossEnabled: boolean;
  desktopBrowserEnabled: boolean;
  desktopBrowserUrl: string;
  desktopBrowserAuthToken: string;
  desktopBrowserAllowedDomains?: string[];
  desktopBrowserBlockedActions?: string[];
  desktopBrowserConfirmActions?: string[];
  desktopBrowserUntrustedBoundariesEnabled?: boolean;
  configPath: string;
  loadedFromFile: boolean;
};

export interface RuntimeConfigServiceLike {
  getConfig(): Promise<Record<string, unknown>>;
  getStatus(): Promise<Record<string, unknown>>;
  updateConfig(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface FileRuntimeConfigServiceOptions {
  fetchImpl?: typeof fetch;
  ensureSelectedHarnessReady?: () => Promise<void>;
}

export class RuntimeConfigServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function firstEnvValue(...names: string[]): string {
  for (const name of names) {
    const value = (process.env[name] ?? "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function runtimeConfigPath(): string {
  const explicit = firstEnvValue(HOLABOSS_RUNTIME_CONFIG_PATH_ENV);
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(sandboxRootPath(), "state", "runtime-config.json");
}

function sandboxRootPath(): string {
  return firstEnvValue(HB_SANDBOX_ROOT_ENV) || "/holaboss";
}

function workspaceRootPath(): string {
  return path.join(sandboxRootPath(), "workspace");
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(token)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(token)) {
      return false;
    }
  }
  return undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== "string") {
        continue;
      }
      const normalized = entry.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  }
  if (typeof value !== "string") {
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(",")) {
    const normalized = part.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function isRecord(value: unknown): value is StringMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): StringMap {
  return isRecord(value) ? value : {};
}

function loadRuntimeConfigDocument(): { document: StringMap; configPath: string; loadedFromFile: boolean } {
  const configPath = runtimeConfigPath();
  if (!fs.existsSync(configPath)) {
    return { document: {}, configPath, loadedFromFile: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new RuntimeConfigServiceError(
      400,
      error instanceof Error ? `invalid runtime config JSON at ${configPath}: ${error.message}` : "invalid runtime config JSON"
    );
  }
  if (!isRecord(parsed)) {
    throw new RuntimeConfigServiceError(400, `runtime config at ${configPath} must be a JSON object`);
  }
  return { document: parsed, configPath, loadedFromFile: true };
}

function writeRuntimeConfigDocument(document: StringMap, configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function loadRuntimeConfigPayload(): {
  payload: Record<string, string>;
  configPath: string;
  loadedFromFile: boolean;
} {
  const { document, configPath, loadedFromFile } = loadRuntimeConfigDocument();
  const runtimePayload = asObject(document.runtime);
  const subagentsPayload = asObject(runtimePayload.subagents ?? runtimePayload.subAgents);
  const providersPayload = asObject(document.providers);
  const integrationsPayload = asObject(document.integrations);
  const capabilitiesPayload = asObject(document.capabilities);
  const holabossIntegration = asObject(integrationsPayload.holaboss);
  const desktopBrowserCapability = asObject(capabilitiesPayload.desktop_browser);
  const holabossProvider = asObject(providersPayload[HOLABOSS_PROXY_PROVIDER]);
  const legacyPayload =
    Object.keys(asObject(document.holaboss)).length > 0 ? asObject(document.holaboss) : document;

  const authToken =
    normalizeString(holabossIntegration.auth_token) ||
    normalizeString(holabossProvider.api_key) ||
    normalizeString(legacyPayload.auth_token) ||
    normalizeString(legacyPayload.model_proxy_api_key);
  const userId = normalizeString(holabossIntegration.user_id) || normalizeString(legacyPayload.user_id);
  // Org-owned sessions / billing: the active org, read from the same places as
  // user_id. Was previously never read here, so resolveProductRuntimeConfig().orgId
  // was always undefined — LLM spend + session stamping fell back to personal.
  const orgId =
    normalizeString(holabossIntegration.org_id) ||
    normalizeString(legacyPayload.org_id);
  // BYO key org — read alongside org_id; personal keeps org_id null but carries a
  // real personal-org id here for BYO key lookup (see ProductRuntimeConfig.byoOrgId).
  const byoOrgId =
    normalizeString(holabossIntegration.byo_org_id) ||
    normalizeString(legacyPayload.byo_org_id);
  const bindingSandboxId =
    normalizeString(holabossIntegration.sandbox_id) ||
    normalizeString(legacyPayload.sandbox_id);
  const sandboxId =
    (authToken && bindingSandboxId) ||
    normalizeString(runtimePayload.sandbox_id) ||
    bindingSandboxId;
  const modelProxyBaseUrl =
    normalizeString(holabossProvider.base_url) || normalizeString(legacyPayload.model_proxy_base_url);
  const defaultModelValue =
    normalizeString(runtimePayload.default_model) || normalizeString(legacyPayload.default_model);
  const subagentModelValue = normalizeString(
    subagentsPayload.model ??
      subagentsPayload.model_id ??
      subagentsPayload.modelId,
  );
  const defaultProvider = normalizeString(runtimePayload.default_provider);
  const explicitHolabossEnabled = normalizeBool(holabossIntegration.enabled);
  const holabossEnabled =
    explicitHolabossEnabled ??
    Boolean(authToken || userId || modelProxyBaseUrl || defaultProvider === HOLABOSS_PROXY_PROVIDER);
  const envDesktopBrowserEnabled = normalizeBool(
    firstEnvValue(HOLABOSS_DESKTOP_BROWSER_ENABLED_ENV)
  );
  const envDesktopBrowserUrl = firstEnvValue(HOLABOSS_DESKTOP_BROWSER_URL_ENV);
  const envDesktopBrowserAuthToken = firstEnvValue(HOLABOSS_DESKTOP_BROWSER_AUTH_TOKEN_ENV);
  const envDesktopBrowserAllowedDomains = normalizeStringList(
    firstEnvValue(HOLABOSS_DESKTOP_BROWSER_ALLOWED_DOMAINS_ENV),
  );
  const envDesktopBrowserBlockedActions = normalizeStringList(
    firstEnvValue(HOLABOSS_DESKTOP_BROWSER_BLOCKED_ACTIONS_ENV),
  );
  const envDesktopBrowserConfirmActions = normalizeStringList(
    firstEnvValue(HOLABOSS_DESKTOP_BROWSER_CONFIRM_ACTIONS_ENV),
  );
  const envDesktopBrowserUntrustedBoundariesEnabled = normalizeBool(
    firstEnvValue(HOLABOSS_DESKTOP_BROWSER_UNTRUSTED_BOUNDARIES_ENV),
  );
  const explicitDesktopBrowserEnabled = normalizeBool(desktopBrowserCapability.enabled);
  const desktopBrowserEnabled =
    envDesktopBrowserEnabled ??
    explicitDesktopBrowserEnabled ??
    Boolean(envDesktopBrowserUrl && envDesktopBrowserAuthToken);
  const desktopBrowserUrl =
    envDesktopBrowserUrl ||
    normalizeString(desktopBrowserCapability.url) ||
    normalizeString(desktopBrowserCapability.mcp_url);
  const desktopBrowserAuthToken =
    envDesktopBrowserAuthToken || normalizeString(desktopBrowserCapability.auth_token);
  const desktopBrowserAllowedDomains =
    envDesktopBrowserAllowedDomains.length > 0
      ? envDesktopBrowserAllowedDomains
      : normalizeStringList(desktopBrowserCapability.allowed_domains);
  const desktopBrowserBlockedActions =
    envDesktopBrowserBlockedActions.length > 0
      ? envDesktopBrowserBlockedActions
      : normalizeStringList(desktopBrowserCapability.blocked_actions);
  const desktopBrowserConfirmActions =
    envDesktopBrowserConfirmActions.length > 0
      ? envDesktopBrowserConfirmActions
      : normalizeStringList(desktopBrowserCapability.confirm_actions);
  const desktopBrowserUntrustedBoundariesEnabled =
    envDesktopBrowserUntrustedBoundariesEnabled ??
    normalizeBool(desktopBrowserCapability.untrusted_boundaries) ??
    true;
  const runtimeMode =
    normalizeString(runtimePayload.mode) || (holabossEnabled ? "product" : DEFAULT_RUNTIME_MODE);

  const payload: Record<string, string> = {
    holaboss_enabled: holabossEnabled ? "true" : "false",
    desktop_browser_enabled: desktopBrowserEnabled ? "true" : "false"
  };
  if (authToken) {
    payload.auth_token = authToken;
  }
  if (userId) {
    payload.user_id = userId;
  }
  if (orgId) {
    payload.org_id = orgId;
  }
  if (byoOrgId) {
    payload.byo_org_id = byoOrgId;
  }
  if (sandboxId) {
    payload.sandbox_id = sandboxId;
  }
  if (modelProxyBaseUrl) {
    payload.model_proxy_base_url = modelProxyBaseUrl;
  }
  if (defaultModelValue) {
    payload.default_model = defaultModelValue;
  }
  if (subagentModelValue) {
    payload.subagent_model = subagentModelValue;
  }
  if (runtimeMode) {
    payload.runtime_mode = runtimeMode;
  }
  if (defaultProvider) {
    payload.default_provider = defaultProvider;
  }
  if (desktopBrowserUrl) {
    payload.desktop_browser_url = desktopBrowserUrl;
  }
  if (desktopBrowserAuthToken) {
    payload.desktop_browser_auth_token = desktopBrowserAuthToken;
  }
  if (desktopBrowserAllowedDomains.length > 0) {
    payload.desktop_browser_allowed_domains = desktopBrowserAllowedDomains.join(",");
  }
  if (desktopBrowserBlockedActions.length > 0) {
    payload.desktop_browser_blocked_actions = desktopBrowserBlockedActions.join(",");
  }
  if (desktopBrowserConfirmActions.length > 0) {
    payload.desktop_browser_confirm_actions = desktopBrowserConfirmActions.join(",");
  }
  payload.desktop_browser_untrusted_boundaries =
    desktopBrowserUntrustedBoundariesEnabled ? "true" : "false";

  return { payload, configPath, loadedFromFile };
}

function modelProxyBaseRootUrl(
  payload: Record<string, string>,
  options?: {
    includeDefault?: boolean;
    required?: boolean;
  }
): string {
  const includeDefault = options?.includeDefault ?? false;
  const required = options?.required ?? true;
  const envNames = [HOLABOSS_MODEL_PROXY_BASE_URL_ENV];
  if (includeDefault) {
    envNames.push(HOLABOSS_MODEL_PROXY_BASE_URL_DEFAULT_ENV);
  }
  const baseRoot = (payload.model_proxy_base_url || firstEnvValue(...envNames)).replace(/\/+$/, "");
  if (!baseRoot) {
    if (required) {
      throw new RuntimeConfigServiceError(400, `${[...envNames, "runtime-config.json:model_proxy_base_url"].join(" or ")} is required`);
    }
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(baseRoot);
  } catch {
    throw new RuntimeConfigServiceError(400, `${HOLABOSS_MODEL_PROXY_BASE_URL_ENV} must be an absolute http(s) URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.host) {
    throw new RuntimeConfigServiceError(400, `${HOLABOSS_MODEL_PROXY_BASE_URL_ENV} must be an absolute http(s) URL`);
  }
  if (parsed.search || parsed.hash) {
    throw new RuntimeConfigServiceError(400, `${HOLABOSS_MODEL_PROXY_BASE_URL_ENV} must not include query or fragment`);
  }
  return baseRoot;
}

function selectedHarness(): string {
  return normalizeHarnessId(firstEnvValue(SANDBOX_AGENT_HARNESS_ENV));
}

function defaultModel(payload: Record<string, string>): string {
  return payload.default_model || firstEnvValue(HOLABOSS_DEFAULT_MODEL_ENV) || DEFAULT_MODEL;
}

function runtimeMode(payload: Record<string, string>): string {
  return payload.runtime_mode || DEFAULT_RUNTIME_MODE;
}

function defaultProvider(payload: Record<string, string>): string {
  return payload.default_provider || "";
}

export function resolveProductRuntimeConfig(params?: {
  requireAuth?: boolean;
  requireUser?: boolean;
  requireBaseUrl?: boolean;
  includeDefaultBaseUrl?: boolean;
}): ProductRuntimeConfig {
  const { payload, configPath, loadedFromFile } = loadRuntimeConfigPayload();
  const requireAuth = params?.requireAuth ?? true;
  const requireUser = params?.requireUser ?? false;
  const requireBaseUrl = params?.requireBaseUrl ?? true;
  const includeDefaultBaseUrl = params?.includeDefaultBaseUrl ?? false;

  const authToken = payload.auth_token || firstEnvValue(HOLABOSS_SANDBOX_AUTH_TOKEN_ENV);
  if (requireAuth && !authToken) {
    throw new RuntimeConfigServiceError(
      400,
      `${HOLABOSS_SANDBOX_AUTH_TOKEN_ENV} or runtime-config.json:auth_token is required`
    );
  }
  const userId = payload.user_id || firstEnvValue(HOLABOSS_USER_ID_ENV);
  if (requireUser && !userId) {
    throw new RuntimeConfigServiceError(400, `${HOLABOSS_USER_ID_ENV} or runtime-config.json:user_id is required`);
  }

  return {
    authToken,
    userId,
    orgId: payload.org_id || undefined,
    byoOrgId: payload.byo_org_id || undefined,
    sandboxId: payload.sandbox_id || "",
    modelProxyBaseUrl: modelProxyBaseRootUrl(payload, {
      includeDefault: includeDefaultBaseUrl,
      required: requireBaseUrl
    }),
    defaultModel: defaultModel(payload),
    subagentModel: payload.subagent_model || "",
    runtimeMode: runtimeMode(payload),
    defaultProvider: defaultProvider(payload),
    holabossEnabled: payload.holaboss_enabled === "true",
    desktopBrowserEnabled: payload.desktop_browser_enabled === "true",
    desktopBrowserUrl: payload.desktop_browser_url || "",
    desktopBrowserAuthToken: payload.desktop_browser_auth_token || "",
    desktopBrowserAllowedDomains: normalizeStringList(payload.desktop_browser_allowed_domains),
    desktopBrowserBlockedActions: normalizeStringList(payload.desktop_browser_blocked_actions),
    desktopBrowserConfirmActions: normalizeStringList(payload.desktop_browser_confirm_actions),
    desktopBrowserUntrustedBoundariesEnabled:
      normalizeBool(payload.desktop_browser_untrusted_boundaries) ?? true,
    configPath,
    loadedFromFile
  };
}

export function runtimeConfigResponse(config: ProductRuntimeConfig): Record<string, unknown> {
  return {
    config_path: config.configPath || null,
    loaded_from_file: config.loadedFromFile,
    auth_token_present: Boolean(config.authToken),
    user_id: config.userId || null,
    sandbox_id: config.sandboxId || null,
    model_proxy_base_url: config.modelProxyBaseUrl || null,
    default_model: config.defaultModel || null,
    subagent_model: config.subagentModel || null,
    runtime_mode: config.runtimeMode || null,
    default_provider: config.defaultProvider || null,
    holaboss_enabled: config.holabossEnabled,
    desktop_browser_enabled: config.desktopBrowserEnabled,
    desktop_browser_url: config.desktopBrowserUrl || null
  };
}

export function runtimeConfigHeaders(params?: {
  requireAuth?: boolean;
  requireUser?: boolean;
}): Record<string, string> {
  const config = resolveProductRuntimeConfig({
    requireAuth: params?.requireAuth ?? true,
    requireUser: params?.requireUser ?? false,
    requireBaseUrl: false
  });
  const headers: Record<string, string> = {};
  if (config.authToken) {
    headers["X-API-Key"] = config.authToken;
  }
  if (config.userId) {
    headers["X-Holaboss-User-Id"] = config.userId;
  }
  if (config.orgId) {
    headers["X-Holaboss-Org-Id"] = config.orgId;
  }
  // BYO key lookup — prefer the dedicated byoOrgId, fall back to the billing org
  // so team orgs (where they're equal) keep working without setting byoOrgId.
  const byoOrgId = config.byoOrgId || config.orgId;
  if (byoOrgId) {
    headers["X-Holaboss-Byo-Org-Id"] = byoOrgId;
  }
  if (config.sandboxId) {
    headers["X-Holaboss-Sandbox-Id"] = config.sandboxId;
  }
  return headers;
}

async function workspaceMcpIsReady(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function runtimeStatus(fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const config = resolveProductRuntimeConfig({
    requireAuth: false,
    requireUser: false,
    requireBaseUrl: false
  });
  const harness = selectedHarness();
  const harnessPlugin = requireRuntimeHarnessPlugin(harness);
  const configPayload = runtimeConfigResponse(config);
  const status = await harnessPlugin.describeRuntimeStatus({
    configLoaded: Boolean(configPayload.loaded_from_file),
    probeBackendReadiness: (target) => workspaceMcpIsReady(target, fetchImpl)
  });
  const browserAvailable = Boolean(config.desktopBrowserEnabled && config.desktopBrowserUrl.trim());
  let browserState = browserAvailable ? "available" : "unavailable";
  if (config.desktopBrowserEnabled && !browserAvailable) {
    browserState = "enabled_unconfigured";
  }
  // Harness inventory drives the per-session picker in the desktop UI and
  // the onboarding flow's auto-bind logic. Each entry tells the client
  // whether the CLI is detectable locally; unavailable harnesses appear
  // disabled with the detection hint so users know how to install them.
  const harnesses = (await resolveHarnessAvailabilityWithModels()).map((entry) => ({
    id: entry.id,
    display_name: entry.displayName,
    capabilities: entry.capabilities,
    available: entry.available,
    detection: entry.detection,
    supported_models: entry.supportedModels,
  }));
  return {
    harness,
    harnesses,
    config_loaded: Boolean(configPayload.loaded_from_file),
    config_path: configPayload.config_path,
    backend_config_present: status.backendConfigPresent,
    harness_ready: status.harnessStatus.ready,
    harness_state: status.harnessStatus.state,
    browser_available: browserAvailable,
    browser_state: browserState,
    browser_url: config.desktopBrowserUrl || null
  };
}

function assignOrRemove(target: StringMap, key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string") {
    return;
  }
  const stripped = value.trim();
  if (stripped) {
    target[key] = stripped;
  } else {
    delete target[key];
  }
}

function assignStringListOrRemove(target: StringMap, key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  const normalized = normalizeStringList(value);
  if (normalized.length > 0) {
    target[key] = normalized;
    return;
  }
  delete target[key];
}

export function updateRuntimeConfigDocument(payload: Record<string, unknown>): ProductRuntimeConfig {
  const { document, configPath } = loadRuntimeConfigDocument();
  const runtimePayload = asObject(document.runtime);
  const subagentsPayload = asObject(runtimePayload.subagents ?? runtimePayload.subAgents);
  const providersPayload = asObject(document.providers);
  const integrationsPayload = asObject(document.integrations);
  const capabilitiesPayload = asObject(document.capabilities);
  const holabossIntegration = asObject(integrationsPayload.holaboss);
  const desktopBrowserCapability = asObject(capabilitiesPayload.desktop_browser);
  const holabossProvider = asObject(providersPayload[HOLABOSS_PROXY_PROVIDER]);
  const legacyPayload = asObject(document.holaboss);

  assignOrRemove(holabossIntegration, "auth_token", payload.auth_token);
  assignOrRemove(holabossIntegration, "user_id", payload.user_id);
  assignOrRemove(holabossIntegration, "org_id", payload.org_id);
  assignOrRemove(holabossIntegration, "byo_org_id", payload.byo_org_id);
  assignOrRemove(holabossIntegration, "sandbox_id", payload.sandbox_id);
  assignOrRemove(holabossProvider, "api_key", payload.auth_token);
  assignOrRemove(holabossProvider, "base_url", payload.model_proxy_base_url);
  assignOrRemove(runtimePayload, "sandbox_id", payload.sandbox_id);
  assignOrRemove(runtimePayload, "default_model", payload.default_model);
  assignOrRemove(subagentsPayload, "model", payload.subagent_model);
  assignOrRemove(runtimePayload, "mode", payload.runtime_mode);
  assignOrRemove(runtimePayload, "default_provider", payload.default_provider);
  assignOrRemove(legacyPayload, "auth_token", payload.auth_token);
  assignOrRemove(legacyPayload, "model_proxy_api_key", payload.auth_token);
  assignOrRemove(legacyPayload, "user_id", payload.user_id);
  assignOrRemove(legacyPayload, "sandbox_id", payload.sandbox_id);
  assignOrRemove(legacyPayload, "model_proxy_base_url", payload.model_proxy_base_url);
  assignOrRemove(legacyPayload, "default_model", payload.default_model);
  assignOrRemove(desktopBrowserCapability, "url", payload.desktop_browser_url);
  assignOrRemove(desktopBrowserCapability, "auth_token", payload.desktop_browser_auth_token);
  assignStringListOrRemove(desktopBrowserCapability, "allowed_domains", payload.desktop_browser_allowed_domains);
  assignStringListOrRemove(desktopBrowserCapability, "blocked_actions", payload.desktop_browser_blocked_actions);
  assignStringListOrRemove(desktopBrowserCapability, "confirm_actions", payload.desktop_browser_confirm_actions);
  const untrustedBoundaries = normalizeBool(payload.desktop_browser_untrusted_boundaries);
  if (untrustedBoundaries !== undefined) {
    desktopBrowserCapability.untrusted_boundaries = untrustedBoundaries;
  }
  if (payload.desktop_browser_url !== undefined && payload.desktop_browser_url !== null) {
    delete desktopBrowserCapability.mcp_url;
  }

  if (Object.keys(holabossProvider).length > 0 && !("kind" in holabossProvider)) {
    holabossProvider.kind = "openai_compatible";
  }
  if (!runtimePayload.mode) {
    runtimePayload.mode = DEFAULT_RUNTIME_MODE;
  }
  delete runtimePayload.subAgents;
  if (Object.keys(subagentsPayload).length > 0) {
    runtimePayload.subagents = subagentsPayload;
  } else {
    delete runtimePayload.subagents;
  }

  const holabossEnabled = normalizeBool(payload.holaboss_enabled);
  if (holabossEnabled !== undefined) {
    holabossIntegration.enabled = holabossEnabled;
  } else if (holabossProvider.api_key || holabossProvider.base_url) {
    if (!runtimePayload.default_provider) {
      runtimePayload.default_provider = HOLABOSS_PROXY_PROVIDER;
    }
    holabossIntegration.enabled = true;
  } else if (!holabossIntegration.auth_token && !holabossIntegration.user_id && !holabossIntegration.sandbox_id) {
    holabossIntegration.enabled = false;
  }

  const desktopBrowserEnabled = normalizeBool(payload.desktop_browser_enabled);
  if (desktopBrowserEnabled !== undefined) {
    desktopBrowserCapability.enabled = desktopBrowserEnabled;
  } else if (!desktopBrowserCapability.url && !desktopBrowserCapability.mcp_url) {
    desktopBrowserCapability.enabled = false;
  }

  document.runtime = runtimePayload;
  document.providers = providersPayload;
  document.integrations = integrationsPayload;
  document.capabilities = capabilitiesPayload;
  document.holaboss = legacyPayload;
  providersPayload[HOLABOSS_PROXY_PROVIDER] = holabossProvider;
  integrationsPayload.holaboss = holabossIntegration;
  capabilitiesPayload.desktop_browser = desktopBrowserCapability;

  writeRuntimeConfigDocument(document, configPath);
  return resolveProductRuntimeConfig({
    requireAuth: false,
    requireUser: false,
    requireBaseUrl: false
  });
}

export class FileRuntimeConfigService implements RuntimeConfigServiceLike {
  readonly #fetch: typeof fetch;
  readonly #ensureSelectedHarnessReady: () => Promise<void>;

  constructor(options: FileRuntimeConfigServiceOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#ensureSelectedHarnessReady =
      options.ensureSelectedHarnessReady ??
      (async () => {
        await requireRuntimeHarnessPlugin(selectedHarness()).ensureReady(this.#fetch);
      });
  }

  async getConfig(): Promise<Record<string, unknown>> {
    try {
      return runtimeConfigResponse(
        resolveProductRuntimeConfig({
          requireAuth: false,
          requireUser: false,
          requireBaseUrl: false
        })
      );
    } catch (error) {
      throw toRuntimeConfigServiceError(error, "runtime config failed");
    }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    try {
      return await runtimeStatus(this.#fetch);
    } catch (error) {
      throw toRuntimeConfigServiceError(error, "runtime status failed");
    }
  }

  async updateConfig(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const config = updateRuntimeConfigDocument(payload);
      const harnessPlugin = requireRuntimeHarnessPlugin(selectedHarness());
      await harnessPlugin.handleRuntimeConfigUpdated({
        productConfig: {
          authToken: config.authToken,
          sandboxId: config.sandboxId,
          modelProxyBaseUrl: config.modelProxyBaseUrl,
          defaultModel: config.defaultModel
        },
        ensureSelectedHarnessReady: this.#ensureSelectedHarnessReady
      });
      return runtimeConfigResponse(config);
    } catch (error) {
      throw toRuntimeConfigServiceError(error, "runtime config update failed");
    }
  }
}

function toRuntimeConfigServiceError(error: unknown, fallbackMessage: string): RuntimeConfigServiceError {
  if (error instanceof RuntimeConfigServiceError) {
    return error;
  }
  if (error instanceof Error) {
    return new RuntimeConfigServiceError(400, error.message);
  }
  return new RuntimeConfigServiceError(400, fallbackMessage);
}
