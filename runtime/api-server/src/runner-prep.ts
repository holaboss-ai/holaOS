import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { classifyEnvValue } from "./mcp-env.js";
import { foldKeyed } from "./mcp-compose.js";
import {
  collectWorkspaceRuntimePlanReferences,
  compileWorkspaceRuntimePlan,
  type CompiledWorkspaceRuntimePlan,
} from "./workspace-runtime-plan.js";
import { migrateLegacyAppMcpServers } from "./workspace-apps.js";

const WORKSPACE_MCP_SERVER_ID = "workspace";

export type PreparedMcpServerPayload = {
  name: string;
  config: {
    type: "local" | "remote";
    enabled: boolean;
    command?: string[];
    environment?: Record<string, string>;
    headers?: Record<string, string>;
    url?: string | null;
    timeout: number;
  };
  _holaboss_force_refresh?: boolean;
};

export type RunningWorkspaceMcpSidecar = {
  physical_server_id: string;
  url: string;
  timeout_ms: number;
  pid?: number | null;
  reused: boolean;
};

export type McpServerMappingMetadata = {
  logical_id: string;
  physical_id: string;
};

function assertSafeRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (!normalized || path.isAbsolute(normalized) || normalized.split(path.sep).includes("..")) {
    throw new Error(`workspace reference path '${relativePath}' is invalid`);
  }
  return normalized;
}

function readWorkspaceReference(workspaceDir: string, relativePath: string): string {
  const resolvedWorkspaceDir = path.resolve(workspaceDir);
  const normalized = assertSafeRelativePath(relativePath);
  const target = path.resolve(resolvedWorkspaceDir, normalized);
  const relativeTarget = path.relative(resolvedWorkspaceDir, target);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error(`workspace reference path '${relativePath}' escapes workspace root`);
  }
  return fs.readFileSync(target, "utf8");
}

// Fresh default workspace contract, matching the legacy auto-provision seed
// (app.ts). Used when a workspace dir has no workspace.yaml yet.
const DEFAULT_WORKSPACE_YAML =
  "agents:\n  id: holaboss\n  model: gpt-5.4\n\nmcp_registry:\n  servers: {}\n";
const DEFAULT_WORKSPACE_AGENTS_MD = "# Holaboss\n\nDefault workspace.\n";

/**
 * Read workspace.yaml, seeding a minimal default contract first if the workspace
 * dir has none. The synthetic root workspace (workspace-removal Piece 5.x) is
 * never created through the legacy `createWorkspace` path that used to seed
 * workspace.yaml + AGENTS.md, so its dir (`workspace/root`) is bare; without this
 * the first run ENOENTs here — the plan compiler reads workspace.yaml during the
 * `compile_runtime_plan` bootstrap stage, before any harness dispatch, and the pi
 * harness host then reads the same file. Seeding is defensive (covers any bare
 * workspace dir) and idempotent (writes only when the file is absent).
 */
function readWorkspaceYamlEnsuringContract(workspaceDir: string): string {
  const resolvedDir = path.resolve(workspaceDir);
  const yamlPath = path.join(resolvedDir, "workspace.yaml");
  if (!fs.existsSync(yamlPath)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
    fs.writeFileSync(yamlPath, DEFAULT_WORKSPACE_YAML, "utf8");
    const agentsMdPath = path.join(resolvedDir, "AGENTS.md");
    if (!fs.existsSync(agentsMdPath)) {
      fs.writeFileSync(agentsMdPath, DEFAULT_WORKSPACE_AGENTS_MD, "utf8");
    }
  }
  return fs.readFileSync(yamlPath, "utf8");
}

export function readWorkspaceRuntimePlanReferences(workspaceDir: string): Record<string, string> {
  const workspaceYaml = readWorkspaceYamlEnsuringContract(workspaceDir);
  const references = collectWorkspaceRuntimePlanReferences({ workspace_yaml: workspaceYaml });
  const resolved: Record<string, string> = {};
  for (const relativePath of references) {
    resolved[relativePath] = readWorkspaceReference(workspaceDir, relativePath);
  }
  return resolved;
}

export function compileWorkspaceRuntimePlanFromWorkspace(params: {
  workspaceId: string;
  workspaceDir: string;
}): CompiledWorkspaceRuntimePlan {
  const workspaceDir = path.resolve(params.workspaceDir);
  // Self-healing one-time migration: move any legacy app MCPs still parked in
  // the standalone pool into `app_servers` before we read + compile. Idempotent
  // — a no-op once every workspace has been swept.
  migrateLegacyAppMcpServers(workspaceDir);
  const workspaceYaml = readWorkspaceYamlEnsuringContract(workspaceDir);
  return compileWorkspaceRuntimePlan({
    workspace_id: params.workspaceId,
    workspace_yaml: workspaceYaml,
    references: readWorkspaceRuntimePlanReferences(workspaceDir),
  });
}

export function workspaceMcpPhysicalServerId(params: {
  workspaceId: string;
  sandboxId: string;
}): string {
  const workspaceSegment = params.workspaceId.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "workspace";
  const digest = createHash("sha256").update(`${params.sandboxId}:${workspaceSegment}`, "utf8").digest("hex").slice(0, 16);
  return `${WORKSPACE_MCP_SERVER_ID}__${digest}`;
}

export function mcpServerIdMap(params: {
  workspaceId: string;
  sandboxId: string;
  compiledPlan: CompiledWorkspaceRuntimePlan;
}): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const server of params.compiledPlan.resolved_mcp_servers) {
    mapping[server.server_id] = server.server_id;
  }
  if (mapping[WORKSPACE_MCP_SERVER_ID] || params.compiledPlan.workspace_mcp_catalog.length > 0) {
    mapping[WORKSPACE_MCP_SERVER_ID] = workspaceMcpPhysicalServerId({
      workspaceId: params.workspaceId,
      sandboxId: params.sandboxId,
    });
  }
  return mapping;
}

function pairsToMapping(items: Array<[string, string]>): Record<string, string> {
  return Object.fromEntries(items);
}

function resolveEnvPlaceholders(mapping: Record<string, string>): {
  resolved: Record<string, string>;
  missing: string[];
} {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, value] of Object.entries(mapping)) {
    const classified = classifyEnvValue(value);
    if (classified.kind === "literal") {
      resolved[key] = value;
      continue;
    }
    if (classified.kind === "malformed") {
      // A malformed {env:...} placeholder (e.g. an invalid var name) used to
      // THROW here and fail the entire run. Install-time validation now rejects
      // these up front (parseMcpServer), but configs predating that — or
      // workspace.yaml servers that skip it — must degrade gracefully: disable
      // just this server, like a missing secret, so the caller surfaces it as
      // mcp_server_unavailable instead of aborting every run.
      missing.push(`malformed placeholder '${value.trim()}'`);
      continue;
    }
    const envValue = process.env[classified.name];
    // An unset env var disables just this server (the caller collects + skips it)
    // rather than aborting the whole run — see mcpServerPayloads.
    if (envValue === undefined) {
      missing.push(classified.name);
      continue;
    }
    resolved[key] = envValue;
  }
  return { resolved, missing };
}

export function workspaceMcpCatalogFingerprint(compiledPlan: CompiledWorkspaceRuntimePlan): string {
  const payload = {
    catalog: compiledPlan.workspace_mcp_catalog.map((entry) => ({
      tool_id: entry.tool_id,
      module_path: entry.module_path,
      symbol_name: entry.symbol_name,
    })),
    timeouts: Object.fromEntries(
      compiledPlan.resolved_mcp_servers
        .filter((server) => server.server_id === WORKSPACE_MCP_SERVER_ID)
        .map((server) => [server.server_id, server.timeout_ms]),
    ),
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export function encodeWorkspaceMcpCatalog(compiledPlan: CompiledWorkspaceRuntimePlan): string {
  return Buffer.from(
    JSON.stringify(
      compiledPlan.workspace_mcp_catalog.map((entry) => ({
        tool_id: entry.tool_id,
        tool_name: entry.tool_name,
        module_path: entry.module_path,
        symbol_name: entry.symbol_name
      }))
    ),
    "utf8"
  ).toString("base64");
}

export function mcpServerMappingMetadata(
  serverIdMap: Readonly<Record<string, string>>
): McpServerMappingMetadata[] {
  return Object.entries(serverIdMap)
    .filter(([logicalId, physicalId]) => logicalId !== physicalId)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([logical_id, physical_id]) => ({ logical_id, physical_id }));
}

export type McpServerUnavailable = {
  serverId: string;
  reason: string;
  missingToolIds: string[];
};

/**
 * Single pass over the plan's resolved MCP servers, splitting them into the
 * ones that can be prepared and the ones that can't (today: an unset
 * `{env:VAR}` secret). Both `mcpServerPayloads` and
 * `mcpServersUnavailableForMissingEnv` are thin views over this, so the
 * "what got skipped and why" set can never drift from the actual payloads.
 */
export function prepareMcpServers(
  compiledPlan: CompiledWorkspaceRuntimePlan,
  serverIdMap?: Readonly<Record<string, string>>,
): { payloads: PreparedMcpServerPayload[]; unavailable: McpServerUnavailable[] } {
  const payloads: PreparedMcpServerPayload[] = [];
  const unavailable: McpServerUnavailable[] = [];
  for (const server of compiledPlan.resolved_mcp_servers) {
    const name = serverIdMap?.[server.server_id] ?? server.server_id;
    const headers = resolveEnvPlaceholders(pairsToMapping(server.headers));
    const environment = resolveEnvPlaceholders(pairsToMapping(server.environment));
    const missing = [...new Set([...headers.missing, ...environment.missing])];
    if (missing.length > 0) {
      // A single MCP server with an unset {env:VAR} must not abort the whole agent
      // run — skip just this server (its tools go unavailable) and keep going. This
      // keeps an unrelated, half-configured workspace server from breaking every
      // run (IM, cron, or UI). The placeholder-syntax error above still throws.
      // The skip is also reported as `unavailable` here so the runner can emit an
      // mcp_server_unavailable event — otherwise a missing secret makes a server's
      // tools vanish with no signal to the user (only this server-side log).
      console.warn(
        `[mcp-prep] skipping MCP server '${name}' — unset env var(s): ${missing.join(", ")}`,
      );
      unavailable.push({
        serverId: name,
        reason: `Missing required secret/environment variable(s): ${missing.join(", ")}`,
        missingToolIds: (compiledPlan.resolved_mcp_tool_refs ?? [])
          .filter((toolRef) => toolRef.server_id === server.server_id)
          .map((toolRef) => toolRef.tool_id),
      });
      continue;
    }
    if (server.type === "local") {
      payloads.push({
        name,
        config: {
          type: "local",
          enabled: true,
          command: [...server.command],
          environment: environment.resolved,
          timeout: server.timeout_ms,
        },
      });
    } else {
      payloads.push({
        name,
        config: {
          type: "remote",
          enabled: true,
          url: server.url,
          headers: headers.resolved,
          timeout: server.timeout_ms,
        },
      });
    }
  }
  return { payloads, unavailable };
}

export function mcpServerPayloads(
  compiledPlan: CompiledWorkspaceRuntimePlan,
  serverIdMap?: Readonly<Record<string, string>>,
): PreparedMcpServerPayload[] {
  return prepareMcpServers(compiledPlan, serverIdMap).payloads;
}

/**
 * MCP servers dropped during payload prep because a required `{env:VAR}` secret
 * was unset. The runner emits these as `mcp_server_unavailable` events so the
 * desktop surfaces the same "server unavailable" warning the discovery path
 * already does — instead of the tools silently disappearing.
 */
export function mcpServersUnavailableForMissingEnv(
  compiledPlan: CompiledWorkspaceRuntimePlan,
  serverIdMap?: Readonly<Record<string, string>>,
): McpServerUnavailable[] {
  return prepareMcpServers(compiledPlan, serverIdMap).unavailable;
}

export function effectiveMcpServerPayloads(params: {
  compiledPlan: CompiledWorkspaceRuntimePlan;
  sidecar: RunningWorkspaceMcpSidecar | null;
  serverIdMap?: Readonly<Record<string, string>>;
}): PreparedMcpServerPayload[] {
  const payloads = mcpServerPayloads(params.compiledPlan, params.serverIdMap);
  if (!params.sidecar) {
    return payloads;
  }
  const sidecarPayload: PreparedMcpServerPayload = {
    name: params.sidecar.physical_server_id,
    config: {
      type: "remote",
      enabled: true,
      url: params.sidecar.url,
      headers: {},
      timeout: params.sidecar.timeout_ms,
    },
    _holaboss_force_refresh: !params.sidecar.reused,
  };
  const existingIndex = payloads.findIndex((payload) => payload.name === params.sidecar!.physical_server_id);
  if (existingIndex >= 0) {
    payloads[existingIndex] = sidecarPayload;
    return payloads;
  }
  payloads.push(sidecarPayload);
  return payloads;
}

export function mergePreparedMcpServerPayloads(
  basePayloads: PreparedMcpServerPayload[],
  overridePayloads: PreparedMcpServerPayload[]
): PreparedMcpServerPayload[] {
  // Runtime payload tier: overrides (bootstrapped apps) win over the base by
  // name, kept at the base's first-seen position, and carry a force-refresh
  // flag set whenever the config changed. Pre-normalizing the override list so
  // every override entry already carries an explicit boolean flag lets the
  // shared foldKeyed core reproduce the original semantics exactly — including
  // override-only entries (no base match), which still get `false`.
  const normalizedOverrides = overridePayloads.map((payload) => ({
    ...payload,
    _holaboss_force_refresh: Boolean(payload._holaboss_force_refresh),
  }));
  const { values } = foldKeyed<PreparedMcpServerPayload>(
    [
      ...basePayloads.map((payload) => ({ key: payload.name, value: payload, source: "base" })),
      ...normalizedOverrides.map((payload) => ({ key: payload.name, value: payload, source: "override" })),
    ],
    {
      mode: "last-wins",
      merge: (incumbent, challenger) => ({
        ...challenger,
        _holaboss_force_refresh: Boolean(
          challenger._holaboss_force_refresh ||
            incumbent._holaboss_force_refresh ||
            JSON.stringify(incumbent.config) !== JSON.stringify(challenger.config)
        ),
      }),
    }
  );
  return values;
}
