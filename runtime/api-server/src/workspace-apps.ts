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
  integrations?: ResolvedIntegrationRequirement[];
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
  smokeTests?: ResolvedApplicationSmokeTest[];
};

export type ResolvedApplicationSmokeTestPayload = {
  actionName: string;
  rowId?: string | null;
  resourceName?: string | null;
  rowData?: Record<string, unknown> | null;
  rowStatus?: string | null;
  input?: Record<string, unknown> | null;
};

export type ResolvedLocalActionSmokeTest = {
  name: string;
  kind: "local_action";
  path: string;
  timeoutS: number;
  payload: ResolvedApplicationSmokeTestPayload;
  expect: {
    actionOk: boolean;
    createdRow: boolean | null;
    rowStatus: string | null;
  };
};

export type ResolvedDelegatedTaskActionSmokeTest = {
  name: string;
  kind: "delegated_task_action";
  path: string;
  timeoutS: number;
  payload: ResolvedApplicationSmokeTestPayload;
  expect: {
    actionOk: boolean;
    createdRow: boolean | null;
    rowStatus: string | null;
    taskStatuses: string[];
    runStatuses: string[];
    requireRequestedModelNull: boolean;
    requireEffectiveModel: boolean;
  };
};

export type ResolvedApplicationSmokeTest =
  | ResolvedLocalActionSmokeTest
  | ResolvedDelegatedTaskActionSmokeTest;

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

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optionalStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items;
}

function normalizeSmokeTestPath(value: unknown): string {
  const trimmed = normalizedText(value);
  if (!trimmed) return "/__holaboss/actions/run";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseSmokeTestPayload(
  value: unknown,
  configPath: string,
  index: number,
): ResolvedApplicationSmokeTestPayload {
  if (!isRecord(value)) {
    throw new Error(`${configPath}: smoke_tests[${index}].payload must be a mapping`);
  }
  const actionName = normalizedText(value.action_name ?? value.actionName);
  if (!actionName) {
    throw new Error(`${configPath}: smoke_tests[${index}].payload.action_name is required`);
  }
  const rowId = normalizedText(value.row_id ?? value.rowId) || null;
  const resourceName = normalizedText(value.resource_name ?? value.resourceName) || null;
  const rowData = isRecord(value.row_data)
    ? value.row_data
    : isRecord(value.rowData)
      ? value.rowData
      : null;
  const rowStatus = normalizedText(value.row_status ?? value.rowStatus) || null;
  const input = isRecord(value.input) ? value.input : null;

  if (!rowId && !resourceName) {
    throw new Error(
      `${configPath}: smoke_tests[${index}].payload must include row_id or resource_name`,
    );
  }
  if (!rowId && !rowData) {
    throw new Error(
      `${configPath}: smoke_tests[${index}].payload.row_data is required when row_id is omitted`,
    );
  }

  return {
    actionName,
    rowId,
    resourceName,
    rowData,
    rowStatus,
    input,
  };
}

function parseResolvedAppSmokeTests(
  loaded: StringMap,
  configPath: string,
): ResolvedApplicationSmokeTest[] | undefined {
  const rawSmokeTests = loaded.smoke_tests;
  if (rawSmokeTests === undefined) {
    return undefined;
  }
  if (!Array.isArray(rawSmokeTests)) {
    throw new Error(`${configPath}: smoke_tests must be a list`);
  }
  const parsed: ResolvedApplicationSmokeTest[] = [];
  for (const [index, entry] of rawSmokeTests.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`${configPath}: smoke_tests[${index}] must be a mapping`);
    }
    const name = normalizedText(entry.name);
    if (!name) {
      throw new Error(`${configPath}: smoke_tests[${index}].name is required`);
    }
    const kind = normalizedText(entry.kind);
    if (kind !== "local_action" && kind !== "delegated_task_action") {
      throw new Error(
        `${configPath}: smoke_tests[${index}].kind must be local_action or delegated_task_action`,
      );
    }
    const timeoutValue = entry.timeout_s;
    const timeoutS =
      timeoutValue === undefined || timeoutValue === null || Number.isNaN(Number(timeoutValue))
        ? 20
        : Math.min(120, Math.max(1, Number(timeoutValue)));
    const payload = parseSmokeTestPayload(entry.payload, configPath, index);
    const rawExpect = isRecord(entry.expect) ? entry.expect : {};
    const actionOkValue =
      rawExpect.action_ok === undefined
        ? true
        : optionalBoolean(rawExpect.action_ok);
    if (actionOkValue === null) {
      throw new Error(`${configPath}: smoke_tests[${index}].expect.action_ok must be boolean`);
    }
    const createdRowValue =
      rawExpect.created_row === undefined
        ? null
        : optionalBoolean(rawExpect.created_row);
    if (rawExpect.created_row !== undefined && createdRowValue === null) {
      throw new Error(`${configPath}: smoke_tests[${index}].expect.created_row must be boolean`);
    }
    const rowStatus = normalizedText(rawExpect.row_status) || null;

    if (kind === "local_action") {
      parsed.push({
        name,
        kind,
        path: normalizeSmokeTestPath(entry.path),
        timeoutS,
        payload,
        expect: {
          actionOk: actionOkValue,
          createdRow: createdRowValue,
          rowStatus,
        },
      });
      continue;
    }

    const taskStatuses =
      optionalStringList(rawExpect.task_statuses) ?? ["todo"];
    const runStatuses =
      optionalStringList(rawExpect.run_statuses) ?? ["queued", "running", "waiting_on_user", "completed"];
    const requireRequestedModelNull =
      rawExpect.require_requested_model_null === undefined
        ? true
        : optionalBoolean(rawExpect.require_requested_model_null);
    if (requireRequestedModelNull === null) {
      throw new Error(
        `${configPath}: smoke_tests[${index}].expect.require_requested_model_null must be boolean`,
      );
    }
    const requireEffectiveModel =
      rawExpect.require_effective_model === undefined
        ? true
        : optionalBoolean(rawExpect.require_effective_model);
    if (requireEffectiveModel === null) {
      throw new Error(
        `${configPath}: smoke_tests[${index}].expect.require_effective_model must be boolean`,
      );
    }
    parsed.push({
      name,
      kind,
      path: normalizeSmokeTestPath(entry.path),
      timeoutS,
      payload,
      expect: {
        actionOk: actionOkValue,
        createdRow: createdRowValue,
        rowStatus,
        taskStatuses,
        runStatuses,
        requireRequestedModelNull,
        requireEffectiveModel,
      },
    });
  }
  return parsed.length > 0 ? parsed : undefined;
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
  const raw = fs.readFileSync(workspaceYamlPath, "utf8");
  try {
    const loaded = yaml.load(raw);
    return isRecord(loaded) ? loaded : {};
  } catch (err) {
    // A corrupt workspace.yaml must never wedge the workspace: this is read on
    // every turn (queueSessionInput), so a parse error here previously failed
    // every message with "Internal Server Error". Mirrors the data.db self-heal:
    // quarantine the bad copy and recover the longest valid YAML prefix (the
    // observed corruption appends non-YAML garbage — e.g. a stray process PATH —
    // after an otherwise-complete document).
    return recoverCorruptWorkspaceYaml(workspaceYamlPath, raw, err);
  }
}

/**
 * Salvage a workspace.yaml that failed to parse. Quarantines the original, finds
 * the longest leading line-prefix that still parses to a mapping, rewrites the
 * file with it (so every other reader sees valid YAML), and returns it. Falls
 * back to an empty document only when nothing parses.
 */
function recoverCorruptWorkspaceYaml(
  yamlPath: string,
  raw: string,
  err: unknown,
): Record<string, unknown> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(yamlPath, `${yamlPath}.corrupt-${stamp}`);
  } catch {
    // best-effort quarantine
  }
  const lines = raw.split("\n");
  for (let end = lines.length; end > 0; end -= 1) {
    const candidate = lines.slice(0, end).join("\n");
    let parsed: unknown;
    try {
      parsed = yaml.load(candidate);
    } catch {
      continue;
    }
    if (isRecord(parsed)) {
      try {
        fs.writeFileSync(yamlPath, `${candidate.replace(/\s+$/, "")}\n`, "utf8");
      } catch {
        // best-effort rewrite; we still return the recovered document
      }
      console.warn(
        `[workspace] repaired corrupt workspace.yaml (${message}): recovered ${end}/${lines.length} lines, quarantined the original`,
      );
      return parsed;
    }
  }
  console.error(
    `[workspace] workspace.yaml is unrecoverable (${message}); using an empty config`,
  );
  return {};
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

export interface WorkspaceMcpServerSummary {
  id: string;
  transport: "remote" | "local";
  enabled: boolean;
  url?: string;
  command?: string[];
  /** True for a server owned by an installed app container (lives in
   *  `app_servers`, or — pre-migration — a `servers` entry with `started_at`),
   *  vs a standalone one the user/agent connected. */
  appManaged: boolean;
  /** The app that owns this server, when app-managed. Standalone (user-added)
   *  servers have no owner. Used to GROUP the MCP list under its app container. */
  ownerAppId?: string;
}

/**
 * List the MCP servers registered in `workspace.yaml` for display — BOTH the
 * standalone pool (`mcp_registry.servers`, user/agent-connected) and the
 * app-container-owned set (`mcp_registry.app_servers`). Each is flagged with
 * `appManaged` + `ownerAppId` so the UI can group app-owned servers under their
 * app and keep the standalone pool separate. Excludes the reserved built-in
 * `workspace` tools server (not a user-facing integration).
 */
export function listWorkspaceMcpRegistryServers(
  workspaceDir: string,
): WorkspaceMcpServerSummary[] {
  const document = readWorkspaceYamlDocument(workspaceDir);
  const registry = isRecord(document.mcp_registry) ? document.mcp_registry : {};
  const out: WorkspaceMcpServerSummary[] = [];

  const pushFrom = (rawServers: unknown, section: "servers" | "app_servers") => {
    if (!isRecord(rawServers)) return;
    for (const [id, raw] of Object.entries(rawServers)) {
      if (id === "workspace") continue; // internal workspace-tools server
      if (!isRecord(raw)) continue;
      const transport = raw.type === "local" ? "local" : "remote";
      // Owner precedence: explicit owner_app_id → else app_servers is owned by
      // its key → else a legacy `servers` entry with started_at (app reconcile,
      // not yet migrated) is owned by its key → else standalone (no owner).
      const explicitOwner =
        typeof raw.owner_app_id === "string" && raw.owner_app_id.trim()
          ? raw.owner_app_id.trim()
          : undefined;
      const ownerAppId =
        explicitOwner ??
        (section === "app_servers" || typeof raw.started_at === "string" ? id : undefined);
      const summary: WorkspaceMcpServerSummary = {
        id,
        transport,
        enabled: raw.enabled !== false,
        appManaged: ownerAppId !== undefined,
      };
      if (ownerAppId !== undefined) summary.ownerAppId = ownerAppId;
      if (typeof raw.url === "string") summary.url = raw.url;
      if (Array.isArray(raw.command)) {
        summary.command = raw.command.filter((v): v is string => typeof v === "string");
      }
      out.push(summary);
    }
  };

  pushFrom(registry.servers, "servers");
  pushFrom(registry.app_servers, "app_servers");
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface WorkspaceMcpServerEntryParams {
  /** Stable registry key / MCP server name (also the `server.tool` prefix). */
  serverId: string;
  transport: "remote" | "local";
  /** remote: the MCP endpoint URL (http/streamable or sse). */
  url?: string;
  /** local: [executable, ...args] to spawn for a stdio MCP server. */
  command?: string[];
  /** remote: auth/other request headers. */
  headers?: Record<string, string>;
  /** local: extra env for the spawned process. */
  environment?: Record<string, string>;
  timeoutMs?: number;
  /** Tool names (unprefixed) to allowlist as `${serverId}.${tool}`. When set,
   *  replaces this server's existing allowlist entries. */
  tools?: string[];
  /** When set, this server is OWNED by the given app container: it's written to
   *  `mcp_registry.app_servers` (with `owner_app_id`) instead of the standalone
   *  `mcp_registry.servers` pool. Standalone user/agent connects omit it. */
  ownerAppId?: string;
}

/**
 * Add (or replace) a user/agent-declared MCP server in `workspace.yaml`
 * `mcp_registry.servers`. Unlike {@link writeWorkspaceMcpRegistryEntry} (which
 * is app-lifecycle-specific and pins a localhost URL + tool allowlist), this is
 * the generic path behind the `mcp_connect` runtime tool: it writes an
 * arbitrary remote (URL) or local (command) server and deliberately does NOT
 * touch `mcp_registry.allowlist` — the tool names aren't known until the server
 * is connected, and CLI harnesses expose every tool a connected server offers
 * regardless of the allowlist. Takes effect on the next run.
 */
export function upsertWorkspaceMcpServerEntry(
  workspaceDir: string,
  params: WorkspaceMcpServerEntryParams,
): void {
  const document = readWorkspaceYamlDocument(workspaceDir);
  const registry = isRecord(document.mcp_registry) ? { ...document.mcp_registry } : {};
  const ownerId = typeof params.ownerAppId === "string" ? params.ownerAppId.trim() : "";
  const sectionKey = ownerId ? "app_servers" : "servers";
  const section = isRecord(registry[sectionKey])
    ? { ...(registry[sectionKey] as Record<string, unknown>) }
    : {};

  const entry: Record<string, unknown> = {
    type: params.transport,
    enabled: true,
  };
  if (params.transport === "remote") {
    entry.url = params.url;
    if (params.headers && Object.keys(params.headers).length > 0) {
      entry.headers = { ...params.headers };
    }
  } else {
    entry.command = [...(params.command ?? [])];
    if (params.environment && Object.keys(params.environment).length > 0) {
      entry.environment = { ...params.environment };
    }
  }
  if (typeof params.timeoutMs === "number" && params.timeoutMs > 0) {
    entry.timeout_ms = params.timeoutMs;
  }

  if (ownerId) {
    entry.owner_app_id = ownerId;
  }
  section[params.serverId] = entry;
  registry[sectionKey] = section;

  // Keep the id in exactly one section: drop any stale copy in the other so an
  // MCP never appears in both the standalone pool and an app container.
  const otherKey = ownerId ? "servers" : "app_servers";
  if (isRecord(registry[otherKey]) && params.serverId in (registry[otherKey] as Record<string, unknown>)) {
    const other = { ...(registry[otherKey] as Record<string, unknown>) };
    delete other[params.serverId];
    registry[otherKey] = other;
  }

  if (params.tools && params.tools.length > 0) {
    const allowlist = isRecord(registry.allowlist) ? { ...registry.allowlist } : {};
    const existing = Array.isArray(allowlist.tool_ids)
      ? (allowlist.tool_ids as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const others = existing.filter((id) => !id.startsWith(`${params.serverId}.`));
    allowlist.tool_ids = [...others, ...params.tools.map((name) => `${params.serverId}.${name}`)];
    registry.allowlist = allowlist;
  }

  document.mcp_registry = registry;
  writeWorkspaceYamlDocument(workspaceDir, document);
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
    mcpTools,
    integrations: integrations.length > 0 ? integrations : undefined,
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
  const smokeTests = parseResolvedAppSmokeTests(loaded, configPath);
  const configDir = path.posix.dirname(configPath);
  return {
    appId: declaredAppId,
    mcp: {
      transport: typeof mcp.transport === "string" ? mcp.transport : "http-sse",
      port: Number(mcp.port),
      // App MCP servers (app-builder SDK) serve SSE at /mcp/sse — there is no
      // /mcp route — and every downstream consumer already defaults to it.
      path: typeof mcp.path === "string" ? mcp.path : "/mcp/sse"
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
    dataSchemaRaw: loaded.data_schema,
    ...(smokeTests && smokeTests.length > 0 ? { smokeTests } : {}),
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
  const appServers = (registry.app_servers as Record<string, unknown> | undefined) ?? {};
  const allowlist = (registry.allowlist as Record<string, unknown> | undefined) ?? {};
  const existingToolIds: string[] = Array.isArray(allowlist.tool_ids)
    ? (allowlist.tool_ids as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

  // Replace this app's server entry
  const port = params.mcpPort ?? 13100;
  const mcpPath = params.mcpPath || "/mcp/sse";
  // App-owned MCP: written to `app_servers` (with owner_app_id) so it's grouped
  // under its app container, not mixed into the standalone `servers` pool.
  const previousServer = isRecord(appServers[appId])
    ? (appServers[appId] as Record<string, unknown>)
    : isRecord(servers[appId])
      ? (servers[appId] as Record<string, unknown>)
      : null;
  const startedAt = params.bumpStartedAt
    ? new Date().toISOString()
    : (typeof previousServer?.started_at === "string" ? previousServer.started_at : new Date().toISOString());
  appServers[appId] = {
    type: "remote",
    url: `http://localhost:${port}${mcpPath}`,
    enabled: true,
    timeout_ms: params.mcpTimeoutMs,
    started_at: startedAt,
    owner_app_id: appId,
  };
  // Drop any legacy standalone-pool copy of this app's server (pre-app_servers).
  if (appId in servers) {
    delete servers[appId];
  }

  // Replace this app's tool ids: drop existing entries prefixed with `${appId}.`,
  // append the new ones
  const otherToolIds = existingToolIds.filter((id) => !id.startsWith(`${appId}.`));
  const newToolIds = [
    ...otherToolIds,
    ...params.mcpTools.map((name) => `${appId}.${name}`),
  ];

  allowlist.tool_ids = newToolIds;
  registry.servers = servers;
  registry.app_servers = appServers;
  registry.allowlist = allowlist;
  data.mcp_registry = registry;

  fs.writeFileSync(yamlPath, yaml.dump(data), "utf8");
}

/**
 * One-time, idempotent migration: relocate legacy app-owned MCP servers that
 * still sit in the standalone `mcp_registry.servers` pool into the app-owned
 * `mcp_registry.app_servers` section (tagging `owner_app_id`) and drop the stale
 * copy. A `servers` entry with a `started_at` timestamp was written by an app
 * reconcile — the standalone attach paths (marketplace / user `mcp_connect`)
 * never set it — so it's a reliable "this belongs to an app" signal. Reserved
 * `workspace` server and already-tagged entries are left alone. Returns the ids
 * moved; a no-op (no write) once there's nothing left, so it's safe to call on
 * every compile. See writeWorkspaceMcpRegistryEntry for the forward path.
 */
export function migrateLegacyAppMcpServers(workspaceDir: string): string[] {
  const yamlPath = path.join(workspaceDir, "workspace.yaml");
  if (!fs.existsSync(yamlPath)) {
    return [];
  }
  const raw = fs.readFileSync(yamlPath, "utf8");
  const data = (yaml.load(raw) as Record<string, unknown> | undefined) ?? {};
  const registry = isRecord(data.mcp_registry) ? data.mcp_registry : null;
  if (!registry) {
    return [];
  }
  const servers = isRecord(registry.servers) ? registry.servers : null;
  if (!servers) {
    return [];
  }
  const appServers = isRecord(registry.app_servers)
    ? (registry.app_servers as Record<string, unknown>)
    : {};

  const moved: string[] = [];
  for (const [id, entry] of Object.entries(servers)) {
    if (id === "workspace") {
      continue; // reserved internal workspace-tools server, never app-owned
    }
    if (!isRecord(entry) || typeof entry.started_at !== "string") {
      continue; // not an app-reconciled server (standalone attaches omit started_at)
    }
    if (typeof entry.owner_app_id === "string") {
      continue; // already tagged (defensive; shouldn't be in `servers`)
    }
    appServers[id] = { ...entry, owner_app_id: id };
    delete servers[id];
    moved.push(id);
  }

  if (moved.length === 0) {
    return [];
  }
  registry.app_servers = appServers;
  registry.servers = servers;
  data.mcp_registry = registry;
  fs.writeFileSync(yamlPath, yaml.dump(data), "utf8");
  return moved;
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
  // Remove from BOTH the standalone pool and the app-owned section — an app's
  // server lives in `app_servers` now, but legacy installs may still have it in
  // `servers`, so clear both to fully detach.
  const servers = registry.servers as Record<string, unknown> | undefined;
  if (servers && appId in servers) {
    delete servers[appId];
  }
  const appServers = registry.app_servers as Record<string, unknown> | undefined;
  if (appServers && appId in appServers) {
    delete appServers[appId];
  }
  const allowlist = registry.allowlist as Record<string, unknown> | undefined;
  if (allowlist && Array.isArray(allowlist.tool_ids)) {
    allowlist.tool_ids = (allowlist.tool_ids as unknown[]).filter(
      (id) => typeof id === "string" && !(id as string).startsWith(`${appId}.`),
    );
  }
  fs.writeFileSync(yamlPath, yaml.dump(data), "utf8");
}

/** Remove all mcp_registry servers (and their allowlisted tools) whose key
 *  begins with `prefix`. Used to tear down a capability's namespaced MCP
 *  servers (`${capabilityId}__*`) on uninstall. */
export function removeWorkspaceMcpRegistryEntriesByPrefix(
  workspaceDir: string,
  prefix: string,
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
  if (servers) {
    for (const key of Object.keys(servers)) {
      if (key.startsWith(prefix)) {
        delete servers[key];
      }
    }
  }
  const allowlist = registry.allowlist as Record<string, unknown> | undefined;
  if (allowlist && Array.isArray(allowlist.tool_ids)) {
    allowlist.tool_ids = (allowlist.tool_ids as unknown[]).filter(
      (id) => typeof id === "string" && !(id as string).startsWith(prefix),
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
