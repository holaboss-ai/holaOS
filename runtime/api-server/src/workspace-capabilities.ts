import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeStateStore, WorkspaceCapabilityRecord } from "@holaboss/runtime-state-store";

import { listConnectionsMerged } from "./integration-connections-merged.js";
import yaml from "js-yaml";

import { classifyEnvValue } from "./mcp-env.js";
import { capabilityMcpServerId } from "./capability-mcp.js";
import {
  removeWorkspaceMcpRegistryEntriesByPrefix,
  upsertWorkspaceMcpServerEntry,
} from "./workspace-apps.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export type CapabilitySkillRef = { path: string } | { ref: string };

export type CapabilityIntegrationRequirement = {
  provider: string;
  required: boolean;
  reason?: string;
};

export type CapabilityMcpServer = {
  id: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  headers?: Record<string, string>;
  environment?: Record<string, string>;
  timeoutMs?: number;
  tools: string[];
};

export type CapabilityMcpConfig = {
  servers: CapabilityMcpServer[];
};

export type CapabilityDefinition = {
  id: string;
  name: string;
  description: string;
  version?: string;
  category?: string;
  icon?: string;
  skills: CapabilitySkillRef[];
  integrations: CapabilityIntegrationRequirement[];
  mcp?: CapabilityMcpConfig;
  sourceDir: string;
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type CapabilityIntegrationState = "connected" | "needs_connection";

export type CapabilityInstallResult = {
  record: WorkspaceCapabilityRecord;
  integrationStatus: Record<string, CapabilityIntegrationState>;
};

type StringMap = Record<string, unknown>;

function isRecord(value: unknown): value is StringMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function defaultCatalogDir(): string {
  return path.join(MODULE_DIR, "embedded-capabilities");
}

function parseSkillRefs(value: unknown, manifestPath: string): CapabilitySkillRef[] {
  if (!Array.isArray(value)) {
    throw new Error(`${manifestPath}: skills must be a list`);
  }
  const refs: CapabilitySkillRef[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`${manifestPath}: skills[${index}] must be a mapping`);
    }
    const skillPath = normalizedText(entry.path);
    const skillRef = normalizedText(entry.ref);
    if (skillPath) {
      refs.push({ path: skillPath });
    } else if (skillRef) {
      refs.push({ ref: skillRef });
    } else {
      throw new Error(`${manifestPath}: skills[${index}] must declare either 'path' or 'ref'`);
    }
  }
  return refs;
}

function parseIntegrationRequirements(value: unknown, manifestPath: string): CapabilityIntegrationRequirement[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${manifestPath}: integrations must be a list`);
  }
  const requirements: CapabilityIntegrationRequirement[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`${manifestPath}: integrations[${index}] must be a mapping`);
    }
    const provider = normalizedText(entry.provider);
    if (!provider) {
      throw new Error(`${manifestPath}: integrations[${index}].provider is required`);
    }
    const reason = normalizedText(entry.reason);
    requirements.push({
      provider,
      required: entry.required === undefined ? true : Boolean(entry.required),
      ...(reason ? { reason } : {}),
    });
  }
  return requirements;
}

function parseStringList(value: unknown, label: string, manifestPath: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${manifestPath}: ${label} must be a list`);
  }
  const items: string[] = [];
  for (const [index, entry] of value.entries()) {
    const item = normalizedText(entry);
    if (!item) {
      throw new Error(`${manifestPath}: ${label}[${index}] must be a non-empty string`);
    }
    items.push(item);
  }
  return items;
}

function parseStringMap(value: unknown, label: string, manifestPath: string): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`${manifestPath}: ${label} must be a mapping`);
  }
  const map: Record<string, string> = {};
  for (const [key, mapped] of Object.entries(value)) {
    if (!key.trim()) {
      continue;
    }
    if (typeof mapped !== "string") {
      throw new Error(`${manifestPath}: ${label}.${key} must be a string`);
    }
    map[key.trim()] = mapped;
  }
  return map;
}

function parseMcpServer(value: unknown, index: number, manifestPath: string): CapabilityMcpServer {
  if (!isRecord(value)) {
    throw new Error(`${manifestPath}: mcp.servers[${index}] must be a mapping`);
  }
  const id = normalizedText(value.id);
  if (!IDENTIFIER_PATTERN.test(id)) {
    throw new Error(`${manifestPath}: mcp.servers[${index}].id must match ${IDENTIFIER_PATTERN}`);
  }
  const typeRaw = normalizedText(value.type);
  if (typeRaw !== "local" && typeRaw !== "remote") {
    throw new Error(`${manifestPath}: mcp.servers[${index}].type must be 'local' or 'remote'`);
  }
  const tools = parseStringList(value.tools, `mcp.servers[${index}].tools`, manifestPath);
  if (tools.length === 0) {
    throw new Error(`${manifestPath}: mcp.servers[${index}].tools must list at least one tool`);
  }
  for (const tool of tools) {
    if (!IDENTIFIER_PATTERN.test(tool)) {
      throw new Error(`${manifestPath}: mcp.servers[${index}] tool '${tool}' must match ${IDENTIFIER_PATTERN}`);
    }
  }
  const headers = parseStringMap(value.headers, `mcp.servers[${index}].headers`, manifestPath);
  const environment = parseStringMap(value.environment, `mcp.servers[${index}].environment`, manifestPath);
  // Reject malformed `{env:...}` placeholders at install time. Runtime resolution
  // applies the same rule (classifyEnvValue); validating here means a bad var
  // name fails the install/customize, not every subsequent agent run.
  for (const [label, map] of [["headers", headers] as const, ["environment", environment] as const]) {
    for (const [key, mapped] of Object.entries(map)) {
      if (classifyEnvValue(mapped).kind === "malformed") {
        throw new Error(
          `${manifestPath}: mcp.servers[${index}].${label}.${key} has an invalid env placeholder '${mapped.trim()}'; use '{env:ENV_VAR_NAME}' or a literal value`,
        );
      }
    }
  }
  const timeoutRaw = value.timeout_ms ?? (value as StringMap).timeoutMs;
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    if (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw) || timeoutRaw <= 0) {
      throw new Error(`${manifestPath}: mcp.servers[${index}].timeout_ms must be a positive integer`);
    }
    timeoutMs = timeoutRaw;
  }

  if (typeRaw === "local") {
    const command = parseStringList(value.command, `mcp.servers[${index}].command`, manifestPath);
    if (command.length === 0) {
      throw new Error(`${manifestPath}: mcp.servers[${index}].command must not be empty`);
    }
    return {
      id,
      type: "local",
      command,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      tools,
    };
  }

  const url = normalizedText(value.url);
  if (!url) {
    throw new Error(`${manifestPath}: mcp.servers[${index}].url is required for remote servers`);
  }
  return {
    id,
    type: "remote",
    url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(environment).length > 0 ? { environment } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    tools,
  };
}

function parseMcpConfig(value: unknown, manifestPath: string): CapabilityMcpConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${manifestPath}: mcp must be a mapping`);
  }
  const rawServers = value.servers;
  if (rawServers === undefined || rawServers === null) {
    return undefined;
  }
  if (!Array.isArray(rawServers)) {
    throw new Error(`${manifestPath}: mcp.servers must be a list`);
  }
  const servers: CapabilityMcpServer[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of rawServers.entries()) {
    const server = parseMcpServer(entry, index, manifestPath);
    if (seen.has(server.id)) {
      throw new Error(`${manifestPath}: mcp.servers[${index}] duplicate server id '${server.id}'`);
    }
    seen.add(server.id);
    servers.push(server);
  }
  if (servers.length === 0) {
    return undefined;
  }
  return { servers };
}

function parseCapabilityManifest(rawYaml: string, manifestPath: string, sourceDir: string): CapabilityDefinition {
  let loaded: unknown;
  try {
    loaded = yaml.load(rawYaml);
  } catch (error) {
    throw new Error(`${manifestPath}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(loaded)) {
    throw new Error(`${manifestPath}: capability.yaml must be a mapping`);
  }

  const id = normalizedText(loaded.id);
  if (!id) {
    throw new Error(`${manifestPath}: id is required`);
  }
  const name = normalizedText(loaded.name);
  if (!name) {
    throw new Error(`${manifestPath}: name is required`);
  }
  const description = normalizedText(loaded.description);
  if (!description) {
    throw new Error(`${manifestPath}: description is required`);
  }
  const version = normalizedText(loaded.version);
  const category = normalizedText(loaded.category);
  const icon = normalizedText(loaded.icon);
  const skills = parseSkillRefs(loaded.skills, manifestPath);
  const integrations = parseIntegrationRequirements(loaded.integrations, manifestPath);
  const mcp = parseMcpConfig(loaded.mcp, manifestPath);

  return {
    id,
    name,
    description,
    ...(version ? { version } : {}),
    ...(category ? { category } : {}),
    ...(icon ? { icon } : {}),
    skills,
    integrations,
    ...(mcp ? { mcp } : {}),
    sourceDir,
  };
}

export function loadCapabilityCatalog(opts?: { dir?: string }): CapabilityDefinition[] {
  const dir = opts?.dir ?? defaultCatalogDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const capabilities: CapabilityDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sourceDir = path.join(dir, entry.name);
    const manifestPath = path.join(sourceDir, "capability.yaml");
    if (!fs.existsSync(manifestPath)) {
      continue;
    }
    capabilities.push(parseCapabilityManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath, sourceDir));
  }
  capabilities.sort((a, b) => a.id.localeCompare(b.id));
  return capabilities;
}

function frontmatterName(skillMarkdown: string): string | null {
  if (!skillMarkdown.startsWith("---")) {
    return null;
  }
  const end = skillMarkdown.indexOf("\n---", 3);
  if (end === -1) {
    return null;
  }
  const frontmatter = skillMarkdown.slice(3, end);
  let parsed: unknown;
  try {
    parsed = yaml.load(frontmatter);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const name = normalizedText(parsed.name);
  return name || null;
}

function skillIdForPathRef(capability: CapabilityDefinition, skillPath: string): { skillId: string; content: string } {
  const absolute = path.join(capability.sourceDir, skillPath);
  const content = fs.readFileSync(absolute, "utf8");
  const fromFrontmatter = frontmatterName(content);
  const skillId = fromFrontmatter ?? path.basename(path.dirname(skillPath));
  return { skillId, content };
}


async function computeIntegrationStatus(
  store: RuntimeStateStore,
  integrations: CapabilityIntegrationRequirement[],
): Promise<Record<string, CapabilityIntegrationState>> {
  const status: Record<string, CapabilityIntegrationState> = {};
  for (const integration of integrations) {
    const connections = await listConnectionsMerged(store, {
      providerId: integration.provider,
    });
    const connected = connections.some((connection) => connection.status === "active");
    status[integration.provider] = connected ? "connected" : "needs_connection";
  }
  return status;
}

export async function installCapability(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  workspaceDir: string;
  capability: CapabilityDefinition;
}): Promise<CapabilityInstallResult> {
  const { store, workspaceId, workspaceDir, capability } = params;
  const installedSkillIds: string[] = [];

  for (const skill of capability.skills) {
    if ("path" in skill) {
      const { skillId, content } = skillIdForPathRef(capability, skill.path);
      const skillDir = path.join(workspaceDir, "skills", skillId);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf8");
      installedSkillIds.push(skillId);
    } else {
      installedSkillIds.push(skill.ref);
    }
  }

  // MCP servers are unified through workspace.yaml's mcp_registry (like apps),
  // namespaced by capability id so uninstall can tear them down by prefix.
  if (capability.mcp) {
    for (const server of capability.mcp.servers) {
      upsertWorkspaceMcpServerEntry(workspaceDir, {
        serverId: capabilityMcpServerId(capability.id, server.id),
        transport: server.type,
        ...(server.url ? { url: server.url } : {}),
        ...(server.command ? { command: server.command } : {}),
        ...(server.headers ? { headers: server.headers } : {}),
        ...(server.environment ? { environment: server.environment } : {}),
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
        tools: server.tools,
      });
    }
  }

  const integrationStatus = await computeIntegrationStatus(store, capability.integrations);

  const record = store.createWorkspaceCapability({
    workspaceId,
    capabilityId: capability.id,
    version: capability.version ?? "",
    name: capability.name,
    description: capability.description,
    icon: capability.icon ?? null,
    installedSkillIds,
    integrationStatus,
    config: {},
  });

  return { record, integrationStatus };
}

export function uninstallCapability(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  workspaceDir: string;
  capabilityId: string;
}): boolean {
  const { store, workspaceId, workspaceDir, capabilityId } = params;
  const record = store.getWorkspaceCapability({ workspaceId, capabilityId });
  if (!record) {
    return false;
  }

  const otherSkillIds = new Set<string>();
  for (const other of store.listWorkspaceCapabilities({ workspaceId })) {
    if (other.capabilityId === capabilityId) {
      continue;
    }
    for (const skillId of other.installedSkillIds) {
      otherSkillIds.add(skillId);
    }
  }

  for (const skillId of record.installedSkillIds) {
    if (otherSkillIds.has(skillId)) {
      continue;
    }
    const skillDir = path.join(workspaceDir, "skills", skillId);
    fs.rmSync(skillDir, { recursive: true, force: true });
  }

  removeWorkspaceMcpRegistryEntriesByPrefix(workspaceDir, `${capabilityId}__`);

  return store.deleteWorkspaceCapability({ workspaceId, capabilityId });
}

export async function installWorkspaceAuthoredCapability(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  workspaceDir: string;
  capabilityId: string;
}): Promise<CapabilityInstallResult> {
  const sourceDir = path.join(params.workspaceDir, "capabilities", params.capabilityId);
  const manifestPath = path.join(sourceDir, "capability.yaml");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`capability manifest not found: ${manifestPath}`);
  }
  const capability = parseCapabilityManifest(fs.readFileSync(manifestPath, "utf8"), manifestPath, sourceDir);
  return await installCapability({
    store: params.store,
    workspaceId: params.workspaceId,
    workspaceDir: params.workspaceDir,
    capability,
  });
}

export function setCapabilityEnabled(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  capabilityId: string;
  enabled: boolean;
}): WorkspaceCapabilityRecord | null {
  return params.store.setWorkspaceCapabilityStatus({
    workspaceId: params.workspaceId,
    capabilityId: params.capabilityId,
    status: params.enabled ? "active" : "disabled",
  });
}
