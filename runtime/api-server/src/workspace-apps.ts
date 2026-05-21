import fs from "node:fs";
import path from "node:path";

import type { RuntimeStateStore } from "@holaboss/runtime-state-store";
import yaml from "js-yaml";

import {
  parseResolvedIntegrationRequirements,
  type ResolvedIntegrationRequirement
} from "./integration-types.js";
import { validateCanonicalIntegrationProviderId } from "./integration-catalog.js";

const APP_HTTP_PORT_BASE = 18080;
const APP_MCP_PORT_BASE = 13100;
const EMBEDDED_RUNTIME_FLAG = "HOLABOSS_EMBEDDED_RUNTIME";

type StringMap = Record<string, unknown>;

export type ParsedInstalledApp = {
  appId: string;
  configPath: string;
  lifecycle: {
    setup: string;
    start: string;
    stop: string;
  };
  mcpTools: string[];
};

export type ResolvedApplicationRuntime = {
  appId: string;
  mcp: {
    transport: string;
    port: number;
    path: string;
  };
  mcpTools: string[];
  healthCheck: {
    target?: "api" | "mcp";
    path: string;
    timeoutS: number;
    intervalS: number;
  };
  envContract: string[];
  integrations?: ResolvedIntegrationRequirement[];
  startCommand: string;
  baseDir: string;
  lifecycle: {
    setup: string;
    start: string;
    stop: string;
  };
  /** Raw `data_schema:` block from app.runtime.yaml when the app
   *  declares one (Tier 2 of the workspace data layer). The runtime
   *  parses + applies it before spawning the app. Apps without this
   *  block continue to manage schema in their own `db.ts` (Tier 0/1
   *  behaviour); both can coexist during rollout. */
  dataSchemaRaw?: unknown;
};

export type ResolvedWorkspaceApp = {
  appId: string;
  configPath: string;
  appDir: string;
  index: number;
  ports: {
    http: number;
    mcp: number;
  };
};

export type ResolvedWorkspaceAppRuntime = ResolvedWorkspaceApp & {
  resolvedApp: ResolvedApplicationRuntime;
};

export type WorkspaceComposeShutdownTarget = {
  appId: string;
  appDir: string;
};

export class WorkspaceAppsError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isRecord(value: unknown): value is StringMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateResolvedIntegrationProviders(
  integrations: ResolvedIntegrationRequirement[],
  configPath: string,
): void {
  for (const [index, integration] of integrations.entries()) {
    try {
      validateCanonicalIntegrationProviderId(integration.provider);
    } catch (error) {
      throw new Error(
        `${configPath}: integrations[${index}].provider ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function embeddedRuntimePortIsolationEnabled(): boolean {
  return (process.env[EMBEDDED_RUNTIME_FLAG] ?? "").trim() === "1";
}

export function portsForAppIndex(index: number): { http: number; mcp: number } {
  return {
    http: APP_HTTP_PORT_BASE + index,
    mcp: APP_MCP_PORT_BASE + index
  };
}

function appPortAllocationKey(appId: string, kind: "http" | "mcp"): string {
  return `${appId}__${kind}`;
}

export function portsForWorkspaceApp(params: {
  appId: string;
  fallbackIndex: number;
  store?: RuntimeStateStore | null;
  workspaceId?: string | null;
  allocate?: boolean;
}): { http: number; mcp: number } {
  if (!embeddedRuntimePortIsolationEnabled() || !params.store || !params.workspaceId) {
    return portsForAppIndex(params.fallbackIndex);
  }

  const resolvePort = (kind: "http" | "mcp"): number | null => {
    const key = appPortAllocationKey(params.appId, kind);
    if (params.allocate) {
      return params.store!.allocateAppPort({ workspaceId: params.workspaceId!, appId: key }).port;
    }
    return params.store!.getAppPort({ workspaceId: params.workspaceId!, appId: key })?.port ?? null;
  };

  const http = resolvePort("http");
  const mcp = resolvePort("mcp");
  if (http && mcp) {
    return { http, mcp };
  }
  return portsForAppIndex(params.fallbackIndex);
}

export function releaseWorkspaceAppPorts(params: {
  appId: string;
  store?: RuntimeStateStore | null;
  workspaceId?: string | null;
}): void {
  if (!embeddedRuntimePortIsolationEnabled() || !params.store || !params.workspaceId) {
    return;
  }
  params.store.deleteAppPort({
    workspaceId: params.workspaceId,
    appId: appPortAllocationKey(params.appId, "http")
  });
  params.store.deleteAppPort({
    workspaceId: params.workspaceId,
    appId: appPortAllocationKey(params.appId, "mcp")
  });
}

export function readWorkspaceYamlDocument(workspaceDir: string): Record<string, unknown> {
  const workspaceYamlPath = path.join(workspaceDir, "workspace.yaml");
  if (!fs.existsSync(workspaceYamlPath)) {
    return {};
  }
  const loaded = yaml.load(fs.readFileSync(workspaceYamlPath, "utf8"));
  return isRecord(loaded) ? loaded : {};
}

export function writeWorkspaceYamlDocument(workspaceDir: string, document: Record<string, unknown>): void {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, "workspace.yaml"),
    yaml.dump(document, { sortKeys: false, noRefs: true }),
    "utf8"
  );
}

export function updateWorkspaceApplications(
  workspaceDir: string,
  updater: (applications: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
): void {
  const document = readWorkspaceYamlDocument(workspaceDir);
  const currentApplications = Array.isArray(document.applications) ? document.applications.filter(isRecord) : [];
  document.applications = updater([...currentApplications]);
  writeWorkspaceYamlDocument(workspaceDir, document);
}

export function removeWorkspaceApplication(workspaceDir: string, appId: string): void {
  updateWorkspaceApplications(workspaceDir, (applications) =>
    applications.filter((entry) => entry.app_id !== appId)
  );
}

export function listWorkspaceApplications(workspaceDir: string): Array<Record<string, unknown>> {
  const document = readWorkspaceYamlDocument(workspaceDir);
  return Array.isArray(document.applications) ? document.applications.filter(isRecord) : [];
}

export function readWorkspaceMcpRegistryServerNames(workspaceDir: string): Set<string> {
  const document = readWorkspaceYamlDocument(workspaceDir);
  const registry = isRecord(document.mcp_registry) ? document.mcp_registry : {};
  const servers = isRecord(registry.servers) ? registry.servers : {};
  return new Set(Object.keys(servers));
}

export function parseInstalledAppRuntime(
  rawYaml: string,
  declaredAppId: string,
  configPath: string
): ParsedInstalledApp {
  let loaded: unknown;
  try {
    loaded = yaml.load(rawYaml);
  } catch (error) {
    throw new Error(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(loaded)) {
    throw new Error("app.runtime.yaml must be a mapping");
  }
  const yamlAppId = String(loaded.app_id ?? "");
  if (yamlAppId !== declaredAppId) {
    throw new Error(`app_id in yaml ('${yamlAppId}') does not match declared app_id ('${declaredAppId}')`);
  }
  const integrations = parseResolvedIntegrationRequirements(loaded);
  validateResolvedIntegrationProviders(integrations, configPath);
  const lifecycle = isRecord(loaded.lifecycle) ? loaded.lifecycle : {};

  const mcpRaw = loaded.mcp;
  const rawTools = isRecord(mcpRaw) && Array.isArray(mcpRaw.tools) ? mcpRaw.tools : [];
  const mcpTools = rawTools.filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0
  );

  return {
    appId: declaredAppId,
    configPath,
    lifecycle: {
      setup: typeof lifecycle.setup === "string" ? lifecycle.setup : "",
      start: typeof lifecycle.start === "string" ? lifecycle.start : "",
      stop: typeof lifecycle.stop === "string" ? lifecycle.stop : ""
    },
    mcpTools
  };
}

export function parseResolvedAppRuntime(
  rawYaml: string,
  declaredAppId: string,
  configPath: string
): ResolvedApplicationRuntime {
  let loaded: unknown;
  try {
    loaded = yaml.load(rawYaml);
  } catch (error) {
    throw new Error(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(loaded)) {
    throw new Error("app.runtime.yaml must be a mapping");
  }
  const yamlAppId = String(loaded.app_id ?? "");
  if (yamlAppId !== declaredAppId) {
    throw new Error(`app_id in yaml ('${yamlAppId}') does not match declared app_id ('${declaredAppId}')`);
  }
  const mcp = isRecord(loaded.mcp) ? loaded.mcp : null;
  if (mcp?.port === undefined || mcp.port === null || Number.isNaN(Number(mcp.port))) {
    throw new Error(`mcp.port is required (${configPath})`);
  }
  const rawMcpTools = mcp && Array.isArray(mcp.tools) ? mcp.tools : [];
  const mcpTools = rawMcpTools.filter(
    (t): t is string => typeof t === "string" && t.trim().length > 0
  );
  const healthchecks = isRecord(loaded.healthchecks) ? loaded.healthchecks : null;
  const preferredHealthcheckTarget =
    healthchecks && isRecord(healthchecks.mcp)
      ? "mcp"
      : healthchecks && isRecord(healthchecks.api)
        ? "api"
        : "mcp";
  const preferredHealthcheck =
    (healthchecks && (isRecord(healthchecks.mcp) ? healthchecks.mcp : null)) ||
    (healthchecks && (isRecord(healthchecks.api) ? healthchecks.api : null)) ||
    (healthchecks
      ? Object.values(healthchecks).find((entry) => isRecord(entry)) as StringMap | undefined
      : undefined);
  const lifecycle = isRecord(loaded.lifecycle) ? loaded.lifecycle : {};
  const envContract = Array.isArray(loaded.env_contract) ? loaded.env_contract.filter((value) => typeof value === "string") : [];
  const integrations = parseResolvedIntegrationRequirements(loaded);
  validateResolvedIntegrationProviders(integrations, configPath);
  const configDir = path.posix.dirname(configPath);
  return {
    appId: declaredAppId,
    mcp: {
      transport: typeof mcp.transport === "string" ? mcp.transport : "http-sse",
      port: Number(mcp.port),
      path: typeof mcp.path === "string" ? mcp.path : "/mcp"
    },
    mcpTools,
    healthCheck: {
      target: preferredHealthcheckTarget,
      path: preferredHealthcheck && typeof preferredHealthcheck.path === "string" ? preferredHealthcheck.path : "/health",
      timeoutS:
        preferredHealthcheck && preferredHealthcheck.timeout_s !== undefined && !Number.isNaN(Number(preferredHealthcheck.timeout_s))
          ? Number(preferredHealthcheck.timeout_s)
          : 120,
      intervalS:
        preferredHealthcheck && preferredHealthcheck.interval_s !== undefined && !Number.isNaN(Number(preferredHealthcheck.interval_s))
          ? Number(preferredHealthcheck.interval_s)
          : 5
    },
    envContract,
    integrations: integrations.length > 0 ? integrations : undefined,
    startCommand: typeof loaded.start === "string" ? loaded.start : "",
    baseDir: configDir === "." ? "." : configDir,
    lifecycle: {
      setup: typeof lifecycle.setup === "string" ? lifecycle.setup : "",
      start: typeof lifecycle.start === "string" ? lifecycle.start : "",
      stop: typeof lifecycle.stop === "string" ? lifecycle.stop : ""
    },
    dataSchemaRaw: loaded.data_schema
  };
}

export function appendWorkspaceApplication(
  workspaceDir: string,
  params: { appId: string; configPath: string; lifecycle?: Record<string, string> | null }
): void {
  updateWorkspaceApplications(workspaceDir, (applications) => {
    if (applications.some((entry) => entry.app_id === params.appId)) {
      return applications;
    }
    const nextEntry: Record<string, unknown> = {
      app_id: params.appId,
      config_path: params.configPath
    };
    if (params.lifecycle && Object.keys(params.lifecycle).length > 0) {
      nextEntry.lifecycle = params.lifecycle;
    }
    applications.push(nextEntry);
    return applications;
  });
}

export interface McpRegistryEntryParams {
  mcpEnabled: boolean;
  mcpTools: string[];
  mcpPath: string | null;
  mcpTimeoutMs: number;
  mcpPort: number | null;
  /** When true, force-bump the per-server `started_at` timestamp even if
   *  the rest of the entry is byte-identical. Lets MCP clients that watch
   *  workspace.yaml notice "the underlying app process restarted, drop
   *  any cached SSE stream and reconnect". */
  bumpStartedAt?: boolean;
}

export function writeWorkspaceMcpRegistryEntry(
  workspaceDir: string,
  appId: string,
  params: McpRegistryEntryParams,
): void {
  if (!params.mcpEnabled) {
    return;
  }
  const yamlPath = path.join(workspaceDir, "workspace.yaml");
  const raw = fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, "utf8") : "";
  const data = (raw ? (yaml.load(raw) as Record<string, unknown>) : {}) || {};

  const registry = (data.mcp_registry as Record<string, unknown> | undefined) ?? {};
  const servers = (registry.servers as Record<string, unknown> | undefined) ?? {};
  const allowlist = (registry.allowlist as Record<string, unknown> | undefined) ?? {};
  const existingToolIds: string[] = Array.isArray(allowlist.tool_ids)
    ? (allowlist.tool_ids as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

  // Replace this app's server entry
  const port = params.mcpPort ?? 13100;
  const mcpPath = params.mcpPath || "/mcp/sse";
  const previousServer = isRecord(servers[appId]) ? (servers[appId] as Record<string, unknown>) : null;
  const startedAt = params.bumpStartedAt
    ? new Date().toISOString()
    : (typeof previousServer?.started_at === "string" ? previousServer.started_at : new Date().toISOString());
  servers[appId] = {
    type: "remote",
    url: `http://localhost:${port}${mcpPath}`,
    enabled: true,
    timeout_ms: params.mcpTimeoutMs,
    started_at: startedAt,
  };

  // Replace this app's tool ids: drop existing entries prefixed with `${appId}.`,
  // append the new ones
  const otherToolIds = existingToolIds.filter((id) => !id.startsWith(`${appId}.`));
  const newToolIds = [
    ...otherToolIds,
    ...params.mcpTools.map((name) => `${appId}.${name}`),
  ];

  allowlist.tool_ids = newToolIds;
  registry.servers = servers;
  registry.allowlist = allowlist;
  data.mcp_registry = registry;

  fs.writeFileSync(yamlPath, yaml.dump(data), "utf8");
}

export function removeWorkspaceMcpRegistryEntry(
  workspaceDir: string,
  appId: string,
): void {
  const yamlPath = path.join(workspaceDir, "workspace.yaml");
  if (!fs.existsSync(yamlPath)) {
    return;
  }
  const raw = fs.readFileSync(yamlPath, "utf8");
  const data = (yaml.load(raw) as Record<string, unknown> | undefined) ?? {};
  const registry = data.mcp_registry as Record<string, unknown> | undefined;
  if (!registry) {
    return;
  }
  const servers = registry.servers as Record<string, unknown> | undefined;
  if (servers && appId in servers) {
    delete servers[appId];
  }
  const allowlist = registry.allowlist as Record<string, unknown> | undefined;
  if (allowlist && Array.isArray(allowlist.tool_ids)) {
    allowlist.tool_ids = (allowlist.tool_ids as unknown[]).filter(
      (id) => typeof id === "string" && !(id as string).startsWith(`${appId}.`),
    );
  }
  fs.writeFileSync(yamlPath, yaml.dump(data), "utf8");
}

export function resolveWorkspaceApp(
  workspaceDir: string,
  targetAppId: string,
  options?: { store?: RuntimeStateStore | null; workspaceId?: string | null; allocatePorts?: boolean }
): ResolvedWorkspaceApp {
  const workspaceYamlPath = path.join(workspaceDir, "workspace.yaml");
  if (!fs.existsSync(workspaceYamlPath)) {
    throw new WorkspaceAppsError(404, "workspace.yaml not found");
  }
  const applications = listWorkspaceApplications(workspaceDir);
  for (const [index, entry] of applications.entries()) {
    const appId = typeof entry.app_id === "string" ? entry.app_id : "";
    if (appId !== targetAppId) {
      continue;
    }
    const configPath = typeof entry.config_path === "string" ? entry.config_path : "";
    if (!configPath) {
      throw new WorkspaceAppsError(400, `app '${targetAppId}' is missing config_path`);
    }
    return {
      appId,
      configPath,
      appDir: path.join(workspaceDir, configPath ? path.dirname(configPath) : path.join("apps", appId)),
      index,
      ports: portsForWorkspaceApp({
        appId,
        fallbackIndex: index,
        store: options?.store,
        workspaceId: options?.workspaceId,
        allocate: options?.allocatePorts === true
      })
    };
  }
  throw new WorkspaceAppsError(404, `app '${targetAppId}' not found in workspace.yaml`);
}

export function resolveWorkspaceAppRuntime(
  workspaceDir: string,
  targetAppId: string,
  options?: { store?: RuntimeStateStore | null; workspaceId?: string | null; allocatePorts?: boolean }
): ResolvedWorkspaceAppRuntime {
  const resolved = resolveWorkspaceApp(workspaceDir, targetAppId, options);
  const fullPath = path.join(workspaceDir, resolved.configPath);
  if (!fs.existsSync(fullPath)) {
    throw new WorkspaceAppsError(404, `app config not found: '${resolved.configPath}'`);
  }
  return {
    ...resolved,
    resolvedApp: parseResolvedAppRuntime(fs.readFileSync(fullPath, "utf8"), resolved.appId, resolved.configPath)
  };
}

export function listWorkspaceApplicationPorts(
  workspaceDir: string,
  options?: { store?: RuntimeStateStore | null; workspaceId?: string | null; allocatePorts?: boolean }
): Record<string, { http: number; mcp: number }> {
  const result: Record<string, { http: number; mcp: number }> = {};
  for (const [index, entry] of listWorkspaceApplications(workspaceDir).entries()) {
    const appId = typeof entry.app_id === "string" ? entry.app_id : "";
    if (!appId) {
      continue;
    }
    result[appId] = portsForWorkspaceApp({
      appId,
      fallbackIndex: index,
      store: options?.store,
      workspaceId: options?.workspaceId,
      allocate: options?.allocatePorts === true
    });
  }
  return result;
}

export function listWorkspaceComposeShutdownTargets(workspaceDir: string): WorkspaceComposeShutdownTarget[] {
  const targets: WorkspaceComposeShutdownTarget[] = [];
  for (const entry of listWorkspaceApplications(workspaceDir)) {
    const appId = typeof entry.app_id === "string" ? entry.app_id : "";
    if (!appId) {
      continue;
    }
    const configPath = typeof entry.config_path === "string" ? entry.config_path : "";
    const appDir = path.join(workspaceDir, configPath ? path.dirname(configPath) : path.join("apps", appId));
    if (
      fs.existsSync(path.join(appDir, "docker-compose.yml")) ||
      fs.existsSync(path.join(appDir, "docker-compose.yaml"))
    ) {
      targets.push({ appId, appDir });
    }
  }
  return targets;
}
