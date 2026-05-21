import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import yaml from "js-yaml";

import {
  parseResolvedIntegrationRequirements,
  type ResolvedIntegrationRequirement
} from "./integration-types.js";
import { validateCanonicalIntegrationProviderId } from "./integration-catalog.js";

type JsonRecord = Record<string, unknown>;

export type WorkspaceRuntimePlanCompileRequest = {
  workspace_id: string;
  workspace_yaml: string;
  references?: Record<string, string> | null;
};

export type WorkspaceRuntimePlanReferenceRequest = {
  workspace_yaml: string;
};

type WorkspaceRuntimePlanResponse =
  | {
      ok: true;
      plan: CompiledWorkspaceRuntimePlan;
    }
  | {
      ok: false;
      error: WorkspaceRuntimePlanErrorPayload;
    };

type WorkspaceRuntimePlanErrorPayload = {
  code: string;
  message: string;
  path?: string | null;
  hint?: string | null;
};

export type WorkspaceGeneralMemberConfig = {
  id: string;
  model: string;
  prompt: string;
  config_path?: string | null;
  role?: string | null;
  schema_id?: string | null;
  schema_module_path?: string | null;
};

export type WorkspaceGeneralSingleConfig = {
  type: "single";
  agent: WorkspaceGeneralMemberConfig;
};

export type WorkspaceGeneralConfig = WorkspaceGeneralSingleConfig;

export type ResolvedMcpServerConfig = {
  server_id: string;
  type: "local" | "remote";
  command: string[];
  url?: string | null;
  headers: Array<[string, string]>;
  environment: Array<[string, string]>;
  timeout_ms: number;
};

export type ResolvedMcpToolRef = {
  tool_id: string;
  server_id: string;
  tool_name: string;
};

export type WorkspaceMcpCatalogEntry = {
  tool_id: string;
  tool_name: string;
  module_path: string;
  symbol_name: string;
};

export type ResolvedApplication = {
  app_id: string;
  mcp: {
    transport: string;
    port: number;
    path: string;
  };
  health_check: {
    target?: "api" | "mcp";
    path: string;
    timeout_s: number;
    interval_s: number;
  };
  env_contract: string[];
  integrations?: ResolvedIntegrationRequirement[];
  start_command: string;
  base_dir: string;
  lifecycle: {
    setup: string;
    start: string;
    stop: string;
  };
};

export type CompiledWorkspaceRuntimePlan = {
  workspace_id: string;
  mode: "single";
  general_config: WorkspaceGeneralConfig;
  schema_aliases: Record<string, string>;
  resolved_prompts: Record<string, string>;
  resolved_mcp_servers: ResolvedMcpServerConfig[];
  resolved_mcp_tool_refs: ResolvedMcpToolRef[];
  workspace_mcp_catalog: WorkspaceMcpCatalogEntry[];
  config_checksum: string;
  resolved_applications: ResolvedApplication[];
  mcp_tool_allowlist: string[];
};

type ServerConfig = {
  server_id: string;
  type: "local" | "remote";
  command: string[];
  url?: string | null;
  headers: Array<[string, string]>;
  environment: Array<[string, string]>;
  timeout_ms: number;
  enabled: boolean;
};

type CatalogEntry = {
  module_path: string;
  symbol_name: string;
};

type McpRegistryCompileResult = {
  resolved_servers: ResolvedMcpServerConfig[];
  resolved_tool_refs: ResolvedMcpToolRef[];
  workspace_catalog: WorkspaceMcpCatalogEntry[];
};

type AllowlistParseResult = {
  resolved_tool_refs: ResolvedMcpToolRef[];
  specified: boolean;
};

type WorkspaceRuntimePlanReferenceResponse =
  | {
      ok: true;
      references: string[];
    }
  | {
      ok: false;
      error: WorkspaceRuntimePlanErrorPayload;
    };

const DEFAULT_PROMPT_FILE = "AGENTS.md";
const DEFAULT_TIMEOUT_MS = 10_000;
const TOOL_ID_PATTERN = /^(?<server>[A-Za-z0-9][A-Za-z0-9_-]*)\.(?<tool>[A-Za-z0-9][A-Za-z0-9_-]*)$/;
const WORKSPACE_SERVER_ID = "workspace";

class WorkspaceRuntimePlanCompileError extends Error {
  readonly code: string;
  readonly path?: string | null;
  readonly hint?: string | null;

  constructor(payload: WorkspaceRuntimePlanErrorPayload) {
    super(payload.message);
    this.code = payload.code;
    this.path = payload.path;
    this.hint = payload.hint;
  }

  toJSON(): WorkspaceRuntimePlanErrorPayload {
    return {
      code: this.code,
      message: this.message,
      path: this.path ?? null,
      hint: this.hint ?? null
    };
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeCliRequest<T>(encoded: string): T {
  const trimmed = encoded.trim();
  if (!trimmed) {
    throw new Error("request_base64 is required");
  }
  const raw = Buffer.from(trimmed, "base64").toString("utf8");
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("request payload must be an object");
  }
  return parsed as T;
}

function err(payload: WorkspaceRuntimePlanErrorPayload): never {
  throw new WorkspaceRuntimePlanCompileError(payload);
}

function loadWorkspaceRuntimePlanDocument(workspaceYaml: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = yaml.load(workspaceYaml);
  } catch (error) {
    err({
      code: "workspace_config_invalid_yaml",
      path: "workspace.yaml",
      message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`
    });
  }
  if (!isRecord(parsed)) {
    err({
      code: "workspace_config_invalid_yaml",
      path: "workspace.yaml",
      message: "workspace.yaml must parse to a mapping object"
    });
  }
  return parsed;
}

function normalizeReferences(value: Record<string, string> | null | undefined): Record<string, string> {
  const references: Record<string, string> = {};
  if (!value || typeof value !== "object") {
    return references;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== "string" || !key.trim() || typeof entry !== "string") {
      continue;
    }
    references[key] = entry;
  }
  return references;
}

function schemaAliases(config: JsonRecord): Record<string, string> {
  const registry = config.schema_registry;
  if (!isRecord(registry)) {
    return {};
  }
  const aliases = registry.aliases;
  if (!isRecord(aliases)) {
    return {};
  }
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(aliases)) {
    if (typeof key !== "string" || !key.trim()) {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    parsed[key.trim()] = value.trim();
  }
  return parsed;
}

function requiredString(value: JsonRecord, key: string, path: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || !raw.trim()) {
    err({
      code: "workspace_general_missing",
      path,
      message: `expected non-empty string field '${key}'`
    });
  }
  return raw.trim();
}

function optionalString(value: JsonRecord, key: string, path: string): string | null {
  const raw = value[key];
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    err({
      code: "workspace_general_missing",
      path,
      message: `expected non-empty string field '${key}' when provided`
    });
  }
  return raw.trim();
}

function parseMember(
  value: JsonRecord,
  basePath: string,
  prompt: string
): WorkspaceGeneralMemberConfig {
  const memberId = requiredString(value, "id", `${basePath}.id`);
  const model = requiredString(value, "model", `${basePath}.model`);
  if (Object.hasOwn(value, "prompt")) {
    err({
      code: "workspace_prompt_inline_not_allowed",
      path: `${basePath}.prompt`,
      message: "inline prompt content is not allowed; use AGENTS.md"
    });
  }
  const role = optionalString(value, "role", `${basePath}.role`);
  const schemaId = optionalString(value, "schema_id", `${basePath}.schema_id`);
  const schemaModulePath = optionalString(value, "schema_module_path", `${basePath}.schema_module_path`);
  if (schemaId && schemaModulePath) {
    err({
      code: "workspace_schema_field_conflict",
      path: basePath,
      message: "use only one of 'schema_id' or 'schema_module_path'",
      hint: "remove one schema field from this member"
    });
  }
  return {
    id: memberId,
    model,
    prompt,
    config_path: basePath,
    role,
    schema_id: schemaId,
    schema_module_path: schemaModulePath
  };
}

function loadGeneralConfig(config: JsonRecord, references: Record<string, string>): WorkspaceGeneralConfig {
  const agentsValue = config.agents;
  const prompt = references[DEFAULT_PROMPT_FILE] ?? "";

  if (isRecord(agentsValue)) {
    if (Object.hasOwn(agentsValue, "id") && Object.hasOwn(agentsValue, "model")) {
      return {
        type: "single",
        agent: parseMember(agentsValue, "agents", prompt)
      };
    }
    err({
      code: "workspace_general_missing",
      path: "agents",
      message: "missing required fields 'agents.id' and 'agents.model'",
      hint: "set 'agents' to an object with non-empty 'id' and 'model'"
    });
  }

  err({
    code: "workspace_general_missing",
    path: "agents",
    message: "missing object field 'agents'",
    hint:
      "set 'agents' to an object with non-empty 'id' and 'model'; workspace instructions come from root 'AGENTS.md' when present"
  });
}

function parseToolId(token: string): [string, string] | null {
  const match = TOOL_ID_PATTERN.exec(token);
  if (!match?.groups) {
    return null;
  }
  return [match.groups.server, match.groups.tool];
}

function parseTimeoutMs(value: unknown, path: string): number {
  if (value === undefined || value === null) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    err({
      code: "workspace_mcp_server_unknown",
      path,
      message: "timeout_ms must be an integer when provided"
    });
  }
  if (value <= 0) {
    err({
      code: "workspace_mcp_server_unknown",
      path,
      message: "timeout_ms must be greater than 0"
    });
  }
  return value;
}

function parseCommand(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    err({
      code: "workspace_mcp_server_unknown",
      path,
      message: "expected non-empty list command"
    });
  }
  const command: string[] = [];
  for (const [index, token] of value.entries()) {
    if (typeof token !== "string" || !token.trim()) {
      err({
        code: "workspace_mcp_server_unknown",
        path: `${path}[${index}]`,
        message: "command tokens must be non-empty strings"
      });
    }
    command.push(token.trim());
  }
  if (command.length === 0) {
    err({
      code: "workspace_mcp_server_unknown",
      path,
      message: "command list must not be empty"
    });
  }
  return command;
}

function parseStringPairs(value: unknown, path: string): Array<[string, string]> {
  if (value === undefined || value === null) {
    return [];
  }
  if (!isRecord(value)) {
    err({
      code: "workspace_mcp_server_unknown",
      path,
      message: "expected mapping object"
    });
  }
  const pairs: Array<[string, string]> = [];
  for (const [key, mappedValue] of Object.entries(value)) {
    if (!key.trim()) {
      continue;
    }
    if (typeof mappedValue !== "string") {
      err({
        code: "workspace_mcp_server_unknown",
        path: `${path}.${key}`,
        message: "mapping values must be strings"
      });
    }
    pairs.push([key.trim(), mappedValue]);
  }
  return pairs;
}

function readAllowlist(registry: JsonRecord): AllowlistParseResult {
  const allowlist = registry.allowlist;
  if (allowlist === undefined || allowlist === null) {
    return { resolved_tool_refs: [], specified: false };
  }
  if (!isRecord(allowlist)) {
    err({
      code: "workspace_mcp_registry_missing",
      path: "mcp_registry.allowlist",
      message: "missing object field 'mcp_registry.allowlist'"
    });
  }
  const toolIds = allowlist.tool_ids;
  if (toolIds === undefined || toolIds === null) {
    return { resolved_tool_refs: [], specified: false };
  }
  if (!Array.isArray(toolIds)) {
    err({
      code: "workspace_mcp_tool_id_invalid",
      path: "mcp_registry.allowlist.tool_ids",
      message: "expected list field 'tool_ids'"
    });
  }
  if (toolIds.length === 0) {
    return { resolved_tool_refs: [], specified: false };
  }
  const refs: ResolvedMcpToolRef[] = [];
  const seen = new Set<string>();
  for (const [index, value] of toolIds.entries()) {
    if (typeof value !== "string" || !value.trim()) {
      err({
        code: "workspace_mcp_tool_id_invalid",
        path: `mcp_registry.allowlist.tool_ids[${index}]`,
        message: "tool id must be a non-empty string"
      });
    }
    const token = value.trim();
    const parsed = parseToolId(token);
    if (!parsed) {
      err({
        code: "workspace_mcp_tool_id_invalid",
        path: `mcp_registry.allowlist.tool_ids[${index}]`,
        message: `tool id '${token}' must match strict 'server.tool' format`
      });
    }
    if (seen.has(token)) {
      err({
        code: "workspace_mcp_tool_id_invalid",
        path: `mcp_registry.allowlist.tool_ids[${index}]`,
        message: `duplicate MCP tool id '${token}'`
      });
    }
    seen.add(token);
    refs.push({
      tool_id: token,
      server_id: parsed[0],
      tool_name: parsed[1]
    });
  }
  return { resolved_tool_refs: refs, specified: true };
}

function readServers(registry: JsonRecord): Record<string, ServerConfig> {
  const rawServers = registry.servers;
  if (!isRecord(rawServers)) {
    err({
      code: "workspace_mcp_registry_missing",
      path: "mcp_registry.servers",
      message: "missing object field 'mcp_registry.servers'"
    });
  }

  const parsed: Record<string, ServerConfig> = {};
  for (const [serverId, value] of Object.entries(rawServers)) {
    if (!serverId.trim()) {
      continue;
    }
    const serverKey = serverId.trim();
    if (!isRecord(value)) {
      err({
        code: "workspace_mcp_server_unknown",
        path: `mcp_registry.servers.${serverKey}`,
        message: "server definition must be an object"
      });
    }
    const serverTypeRaw = value.type;
    if (typeof serverTypeRaw !== "string") {
      err({
        code: "workspace_mcp_server_unknown",
        path: `mcp_registry.servers.${serverKey}.type`,
        message: "server type must be 'local' or 'remote'"
      });
    }
    const serverType = serverTypeRaw.trim();
    if (serverType !== "local" && serverType !== "remote") {
      err({
        code: "workspace_mcp_server_unknown",
        path: `mcp_registry.servers.${serverKey}.type`,
        message: "server type must be 'local' or 'remote'"
      });
    }
    const enabled = value.enabled === undefined ? true : Boolean(value.enabled);
    const timeoutMs = parseTimeoutMs(value.timeout_ms, `mcp_registry.servers.${serverKey}.timeout_ms`);
    const headers = parseStringPairs(value.headers, `mcp_registry.servers.${serverKey}.headers`);
    const environment = parseStringPairs(value.environment, `mcp_registry.servers.${serverKey}.environment`);

    if (serverType === "local") {
      const command =
        serverKey === WORKSPACE_SERVER_ID && (value.command === undefined || value.command === null)
          ? []
          : parseCommand(value.command, `mcp_registry.servers.${serverKey}.command`);
      parsed[serverKey] = {
        server_id: serverKey,
        type: "local",
        command,
        url: null,
        headers,
        environment,
        timeout_ms: timeoutMs,
        enabled
      };
      continue;
    }

    const url = value.url;
    if (typeof url !== "string" || !url.trim()) {
      err({
        code: "workspace_mcp_server_unknown",
        path: `mcp_registry.servers.${serverKey}.url`,
        message: "remote server requires non-empty string field 'url'"
      });
    }
    parsed[serverKey] = {
      server_id: serverKey,
      type: "remote",
      command: [],
      url: url.trim(),
      headers,
      environment,
      timeout_ms: timeoutMs,
      enabled
    };
  }
  return parsed;
}

function readCatalog(registry: JsonRecord): Record<string, CatalogEntry> {
  const rawCatalog = registry.catalog;
  if (rawCatalog === undefined || rawCatalog === null) {
    return {};
  }
  if (!isRecord(rawCatalog)) {
    err({
      code: "workspace_mcp_catalog_entry_invalid",
      path: "mcp_registry.catalog",
      message: "catalog must be an object when provided"
    });
  }

  const parsed: Record<string, CatalogEntry> = {};
  for (const [toolId, entry] of Object.entries(rawCatalog)) {
    if (!toolId.trim()) {
      continue;
    }
    const basePath = `mcp_registry.catalog.${toolId}`;
    if (!isRecord(entry)) {
      err({
        code: "workspace_mcp_catalog_entry_invalid",
        path: basePath,
        message: "catalog entry must be an object"
      });
    }
    const modulePath = entry.module_path;
    const symbolName = entry.symbol;
    if (typeof modulePath !== "string" || !modulePath.trim()) {
      err({
        code: "workspace_mcp_catalog_entry_invalid",
        path: `${basePath}.module_path`,
        message: "catalog entry requires non-empty 'module_path'"
      });
    }
    if (typeof symbolName !== "string" || !symbolName.trim()) {
      err({
        code: "workspace_mcp_catalog_entry_invalid",
        path: `${basePath}.symbol`,
        message: "catalog entry requires non-empty 'symbol'"
      });
    }
    parsed[toolId.trim()] = {
      module_path: modulePath.trim(),
      symbol_name: symbolName.trim()
    };
  }
  return parsed;
}

function ensureWorkspaceServerConfig(servers: Record<string, ServerConfig>): Record<string, ServerConfig> {
  const workspaceServer = servers[WORKSPACE_SERVER_ID];
  if (!workspaceServer) {
    return {
      ...servers,
      [WORKSPACE_SERVER_ID]: {
        server_id: WORKSPACE_SERVER_ID,
        type: "local",
        command: [],
        url: null,
        headers: [],
        environment: [],
        timeout_ms: DEFAULT_TIMEOUT_MS,
        enabled: true
      }
    };
  }
  if (workspaceServer.type !== "local") {
    err({
      code: "workspace_mcp_server_unknown",
      path: `mcp_registry.servers.${WORKSPACE_SERVER_ID}.type`,
      message: "workspace MCP server must be local"
    });
  }
  if (workspaceServer.command.length === 0) {
    return servers;
  }
  return {
    ...servers,
    [WORKSPACE_SERVER_ID]: {
      ...workspaceServer,
      command: []
    }
  };
}

function resolveMcpRegistry(config: JsonRecord): McpRegistryCompileResult {
  if (isRecord(config.tool_registry)) {
    err({
      code: "workspace_tool_registry_unsupported",
      path: "tool_registry",
      message: "tool_registry is no longer supported; use mcp_registry"
    });
  }

  const registry = config.mcp_registry;
  if (!isRecord(registry)) {
    err({
      code: "workspace_mcp_registry_missing",
      path: "mcp_registry",
      message: "missing object field 'mcp_registry'"
    });
  }

  const allowlist = readAllowlist(registry);
  const toolRefs = allowlist.resolved_tool_refs;
  const servers = ensureWorkspaceServerConfig(readServers(registry));
  const catalog = readCatalog(registry);

  const referencedServerIds: string[] = [];
  const seenServerIds = new Set<string>();
  if (allowlist.specified) {
    for (const [index, toolRef] of toolRefs.entries()) {
      const server = servers[toolRef.server_id];
      if (!server) {
        err({
          code: "workspace_mcp_server_unknown",
          path: `mcp_registry.allowlist.tool_ids[${index}]`,
          message: `unknown MCP server '${toolRef.server_id}' for tool '${toolRef.tool_id}'`,
          hint: "add server config under mcp_registry.servers"
        });
      }
      if (!server.enabled) {
        err({
          code: "workspace_mcp_server_unknown",
          path: `mcp_registry.allowlist.tool_ids[${index}]`,
          message: `MCP server '${toolRef.server_id}' is disabled for tool '${toolRef.tool_id}'`
        });
      }
      if (!seenServerIds.has(toolRef.server_id)) {
        seenServerIds.add(toolRef.server_id);
        referencedServerIds.push(toolRef.server_id);
      }
    }
    for (const server of Object.values(servers)) {
      if (
        !server.enabled ||
        server.server_id === WORKSPACE_SERVER_ID ||
        seenServerIds.has(server.server_id)
      ) {
        continue;
      }
      seenServerIds.add(server.server_id);
      referencedServerIds.push(server.server_id);
    }
  } else {
    for (const server of Object.values(servers)) {
      if (!server.enabled || server.server_id === WORKSPACE_SERVER_ID) {
        continue;
      }
      seenServerIds.add(server.server_id);
      referencedServerIds.push(server.server_id);
    }
  }

  const workspaceCatalog: WorkspaceMcpCatalogEntry[] = [];
  if (allowlist.specified) {
    for (const [index, toolRef] of toolRefs.entries()) {
      if (toolRef.server_id !== WORKSPACE_SERVER_ID) {
        continue;
      }
      const catalogEntry = catalog[toolRef.tool_id];
      if (!catalogEntry) {
        err({
          code: "workspace_mcp_catalog_missing",
          path: `mcp_registry.allowlist.tool_ids[${index}]`,
          message: `workspace tool '${toolRef.tool_id}' is missing catalog entry in mcp_registry.catalog`
        });
      }
      workspaceCatalog.push({
        tool_id: toolRef.tool_id,
        tool_name: toolRef.tool_name,
        module_path: catalogEntry.module_path,
        symbol_name: catalogEntry.symbol_name
      });
    }
  } else {
    for (const [toolId, catalogEntry] of Object.entries(catalog)) {
      const parsedToolId = parseToolId(toolId);
      if (!parsedToolId || parsedToolId[0] !== WORKSPACE_SERVER_ID) {
        continue;
      }
      workspaceCatalog.push({
        tool_id: toolId,
        tool_name: parsedToolId[1],
        module_path: catalogEntry.module_path,
        symbol_name: catalogEntry.symbol_name
      });
    }
  }
  if (workspaceCatalog.length > 0 && !seenServerIds.has(WORKSPACE_SERVER_ID)) {
    referencedServerIds.push(WORKSPACE_SERVER_ID);
  }

  return {
    resolved_servers: referencedServerIds.map((serverId) => {
      const server = servers[serverId];
      return {
        server_id: server.server_id,
        type: server.type,
        command: [...server.command],
        url: server.url ?? null,
        headers: [...server.headers],
        environment: [...server.environment],
        timeout_ms: server.timeout_ms
      };
    }),
    resolved_tool_refs: toolRefs,
    workspace_catalog: workspaceCatalog
  };
}

function parseAppRuntimeYaml(rawYaml: string, declaredAppId: string, configPath: string): ResolvedApplication {
  let loaded: unknown;
  try {
    loaded = yaml.load(rawYaml);
  } catch (error) {
    err({
      code: "app_config_invalid_yaml",
      path: configPath,
      message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`
    });
  }
  if (!isRecord(loaded)) {
    err({
      code: "app_config_invalid_yaml",
      path: configPath,
      message: "app.runtime.yaml must be a mapping"
    });
  }

  const yamlAppId = String(loaded.app_id ?? "");
  if (yamlAppId !== declaredAppId) {
    err({
      code: "app_id_mismatch",
      path: configPath,
      message: `app_id in yaml ('${yamlAppId}') does not match declared app_id ('${declaredAppId}')`
    });
  }

  const mcp = isRecord(loaded.mcp) ? loaded.mcp : null;
  if (!mcp || mcp.port === undefined || mcp.port === null || Number.isNaN(Number(mcp.port))) {
    err({
      code: "app_mcp_port_missing",
      path: `${configPath}:mcp.port`,
      message: "mcp.port is required"
    });
  }

  const healthchecks = isRecord(loaded.healthchecks) ? loaded.healthchecks : null;
  const fallbackHealthcheck = healthchecks
    ? Object.values(healthchecks).find((entry) => isRecord(entry))
    : null;
  const preferredHealthcheck =
    (healthchecks && isRecord(healthchecks.mcp) ? healthchecks.mcp : null) ||
    (healthchecks && isRecord(healthchecks.api) ? healthchecks.api : null) ||
    (isRecord(fallbackHealthcheck) ? fallbackHealthcheck : null);
  const lifecycle = isRecord(loaded.lifecycle) ? loaded.lifecycle : {};
  const envContract = Array.isArray(loaded.env_contract)
    ? loaded.env_contract.filter((value): value is string => typeof value === "string")
    : [];
  let integrations: ReturnType<typeof parseResolvedIntegrationRequirements> = [];
  try {
    integrations = parseResolvedIntegrationRequirements(loaded);
  } catch (error) {
    err({
      code: "app_config_invalid_yaml",
      path: configPath,
      message: error instanceof Error ? error.message : String(error)
    });
  }
  for (const [index, integration] of integrations.entries()) {
    try {
      validateCanonicalIntegrationProviderId(integration.provider);
    } catch (error) {
      err({
        code: "app_integration_provider_unknown",
        path: `${configPath}:integrations[${index}].provider`,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const configDir = configPath.includes("/") ? configPath.slice(0, configPath.lastIndexOf("/")) : ".";
  const preferredHealthcheckTarget =
    healthchecks && isRecord(healthchecks.mcp)
      ? "mcp"
      : healthchecks && isRecord(healthchecks.api)
        ? "api"
        : "mcp";

  return {
    app_id: declaredAppId,
    mcp: {
      transport: typeof mcp.transport === "string" ? mcp.transport : "http-sse",
      port: Number(mcp.port),
      path: typeof mcp.path === "string" ? mcp.path : "/mcp"
    },
    health_check: {
      target: preferredHealthcheckTarget,
      path: preferredHealthcheck && typeof preferredHealthcheck.path === "string" ? preferredHealthcheck.path : "/health",
      timeout_s:
        preferredHealthcheck &&
        preferredHealthcheck.timeout_s !== undefined &&
        !Number.isNaN(Number(preferredHealthcheck.timeout_s))
          ? Number(preferredHealthcheck.timeout_s)
          : 60,
      interval_s:
        preferredHealthcheck &&
        preferredHealthcheck.interval_s !== undefined &&
        !Number.isNaN(Number(preferredHealthcheck.interval_s))
          ? Number(preferredHealthcheck.interval_s)
          : 5
    },
    env_contract: envContract,
    integrations: integrations.length > 0 ? integrations : undefined,
    start_command: typeof loaded.start === "string" ? loaded.start : "",
    base_dir: configDir === "." ? "." : configDir,
    lifecycle: {
      setup: typeof lifecycle.setup === "string" ? lifecycle.setup : "",
      start: typeof lifecycle.start === "string" ? lifecycle.start : "",
      stop: typeof lifecycle.stop === "string" ? lifecycle.stop : ""
    }
  };
}

function loadApplications(config: JsonRecord, references: Record<string, string>): ResolvedApplication[] {
  const applications = config.applications;
  if (!applications) {
    return [];
  }
  if (!Array.isArray(applications)) {
    err({
      code: "workspace_config_invalid_yaml",
      path: "applications",
      message: "applications must be a list"
    });
  }

  const seenIds = new Set<string>();
  const resolved: ResolvedApplication[] = [];
  for (const [index, entry] of applications.entries()) {
    if (!isRecord(entry)) {
      err({
        code: "workspace_config_invalid_yaml",
        path: `applications[${index}]`,
        message: "each application entry must be a mapping"
      });
    }
    const appId = String(entry.app_id ?? "");
    const configPath = String(entry.config_path ?? "");
    if (seenIds.has(appId)) {
      err({
        code: "app_duplicate_id",
        path: `applications[${index}].app_id`,
        message: `duplicate app_id '${appId}'`
      });
    }
    const rawYaml = references[configPath];
    if (rawYaml === undefined) {
      err({
        code: "app_config_not_found",
        path: `applications[${index}].config_path`,
        message: `app config not found: '${configPath}'`
      });
    }
    resolved.push(parseAppRuntimeYaml(rawYaml, appId, configPath));
    seenIds.add(appId);
  }
  return resolved;
}

function promptsByMemberId(generalConfig: WorkspaceGeneralConfig): Record<string, string> {
  return {
    [generalConfig.agent.id]: generalConfig.agent.prompt
  };
}

export function collectWorkspaceRuntimePlanReferences(request: WorkspaceRuntimePlanReferenceRequest): string[] {
  const config = loadWorkspaceRuntimePlanDocument(request.workspace_yaml);
  const references = new Set<string>([DEFAULT_PROMPT_FILE]);
  const applications = config.applications;
  if (!Array.isArray(applications)) {
    return [...references];
  }
  for (const entry of applications) {
    if (!isRecord(entry)) {
      continue;
    }
    const configPath = entry.config_path;
    if (typeof configPath !== "string" || !configPath.trim()) {
      continue;
    }
    references.add(configPath.trim());
  }
  return [...references];
}

export function compileWorkspaceRuntimePlan(request: WorkspaceRuntimePlanCompileRequest): CompiledWorkspaceRuntimePlan {
  const config = loadWorkspaceRuntimePlanDocument(request.workspace_yaml);
  const references = normalizeReferences(request.references);
  const generalConfig = loadGeneralConfig(config, references);
  const mcpResult = resolveMcpRegistry(config);
  return {
    workspace_id: request.workspace_id,
    mode: generalConfig.type,
    general_config: generalConfig,
    schema_aliases: schemaAliases(config),
    resolved_prompts: promptsByMemberId(generalConfig),
    resolved_mcp_servers: mcpResult.resolved_servers,
    resolved_mcp_tool_refs: mcpResult.resolved_tool_refs,
    workspace_mcp_catalog: mcpResult.workspace_catalog,
    config_checksum: createHash("sha256").update(request.workspace_yaml, "utf8").digest("hex"),
    resolved_applications: loadApplications(config, references),
    mcp_tool_allowlist: mcpResult.resolved_tool_refs.map((toolRef) => toolRef.tool_id)
  };
}

export async function runWorkspaceRuntimePlanCli(
  argv: string[],
  options: {
    io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  } = {}
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const operation = (argv[0] ?? "").trim().toLowerCase();
  const requestBase64 = argv[1] === "--request-base64" ? argv[2] ?? "" : argv[1] ?? "";

  if (!operation) {
    io.stderr.write("operation is required\n");
    return 2;
  }
  if (operation !== "compile" && operation !== "collect-references") {
    io.stderr.write(`unsupported operation: ${operation}\n`);
    return 2;
  }

  try {
    if (operation === "collect-references") {
      const request = decodeCliRequest<WorkspaceRuntimePlanReferenceRequest>(requestBase64);
      io.stdout.write(
        JSON.stringify({
          ok: true,
          references: collectWorkspaceRuntimePlanReferences(request)
        } satisfies WorkspaceRuntimePlanReferenceResponse)
      );
      return 0;
    }

    const request = decodeCliRequest<WorkspaceRuntimePlanCompileRequest>(requestBase64);
    io.stdout.write(
      JSON.stringify({ ok: true, plan: compileWorkspaceRuntimePlan(request) } satisfies WorkspaceRuntimePlanResponse)
    );
    return 0;
  } catch (error) {
    if (error instanceof WorkspaceRuntimePlanCompileError) {
      const payload: { ok: false; error: WorkspaceRuntimePlanErrorPayload } = { ok: false, error: error.toJSON() };
      io.stdout.write(
        JSON.stringify(
          operation === "collect-references"
            ? (payload satisfies WorkspaceRuntimePlanReferenceResponse)
            : (payload satisfies WorkspaceRuntimePlanResponse)
        )
      );
      return 0;
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function main(): Promise<void> {
  process.exitCode = await runWorkspaceRuntimePlanCli(process.argv.slice(2));
}

// The usual `import.meta.url === pathToFileURL(argv[1])` guard fires for
// EVERY bundled module when tsup collapses these source files into
// dist/index.mjs, because all modules share the same bundle URL. That made
// booting index.mjs spuriously run this CLI with empty argv and print
// "operation is required" on stderr. We also match on the invoked script's
// basename so only a direct `node workspace-runtime-plan.mjs …` call runs.
const WORKSPACE_RUNTIME_PLAN_CLI_BASENAME = "workspace-runtime-plan";
if (
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href &&
  path.basename(process.argv[1] ?? "", path.extname(process.argv[1] ?? "")) ===
    WORKSPACE_RUNTIME_PLAN_CLI_BASENAME
) {
  await main();
}
