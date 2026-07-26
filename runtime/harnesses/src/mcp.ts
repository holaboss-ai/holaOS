import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HarnessMcpToolRef {
  tool_id: string;
  server_id: string;
  tool_name: string;
}

export interface HarnessPreparedMcpServerConfig {
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
}

export type HarnessMcpServerBinding = {
  serverId: string;
  timeoutMs: number;
  description: string;
  transport:
    | {
        kind: "stdio";
        command: string;
        args: string[];
        cwd: string;
        env: Record<string, string>;
      }
    | {
        kind: "http";
        url: string;
        headers: Record<string, string>;
      };
};

export interface HarnessMcpRuntimeToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface HarnessMcpRuntimeLike {
  listTools: (
    serverId: string,
    options?: { includeSchema?: boolean },
  ) => Promise<HarnessMcpRuntimeToolInfo[]>;
}

export interface HarnessDiscoveredMcpTool {
  harnessToolName: string;
  serverId: string;
  toolId: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  timeoutMs: number;
}

export interface HarnessMcpDiscoveryFailure {
  serverId: string;
  reason: string;
  missingToolIds: string[];
  /** True when the server rejected us for auth reasons (401/403) — i.e. it
   *  needs an OAuth Authorize before its tools can be discovered. Lets the UI
   *  offer an "Authorize" action instead of a generic "unreachable" error. */
  authRequired?: boolean;
}

export interface HarnessMcpDiscoveryResult {
  tools: HarnessDiscoveredMcpTool[];
  failures: HarnessMcpDiscoveryFailure[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "";
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function sanitizeHarnessToolNameSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

export function buildHarnessMcpToolName(serverId: string, toolName: string): string {
  return `mcp__${sanitizeHarnessToolNameSegment(serverId)}__${sanitizeHarnessToolNameSegment(toolName)}`;
}

/**
 * Alternate `mcp__<server>__<tool>` names a model might emit for an MCP tool
 * whose registered pi name is the BARE tool name. Some models (e.g. GLM) borrow
 * the Claude Agent SDK's `mcp__<server>__<tool>` namespacing even though pi
 * doesn't use it — so a bare-named tool comes back "not found". They sanitize
 * the server segment but tend to keep the ORIGINAL tool segment (e.g.
 * `get-group-list`, not `get_group_list`), so cover both spellings. Register a
 * tool under these (same execute) so either resolves.
 */
export function harnessMcpToolNameAliases(
  serverId: string,
  toolName: string,
): string[] {
  const sanitizedServer = sanitizeHarnessToolNameSegment(serverId);
  const originalTool = toolName.trim();
  return [
    buildHarnessMcpToolName(serverId, toolName), // fully sanitized
    ...(originalTool ? [`mcp__${sanitizedServer}__${originalTool}`] : []), // original tool segment
  ].filter((name, index, all) => all.indexOf(name) === index);
}

export function buildUniqueHarnessMcpToolName(
  serverId: string,
  toolName: string,
  usedNames: ReadonlySet<string>,
): string {
  const baseName = buildHarnessMcpToolName(serverId, toolName);
  if (!usedNames.has(baseName)) {
    return baseName;
  }
  let suffix = 2;
  while (usedNames.has(`${baseName}_${suffix}`)) {
    suffix += 1;
  }
  return `${baseName}_${suffix}`;
}

function fallbackMcpToolParametersSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  };
}

export function normalizeHarnessMcpToolParametersSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return fallbackMcpToolParametersSchema();
  }
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Path-safe rendering of a registry server id for use as a directory name. */
function mcpTokenDirSegment(serverId: string): string {
  const cleaned = serverId.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "server";
}

/**
 * Per-workspace, per-server directory where the OAuth token vault for a
 * user-connected remote MCP server lives. mcporter's DirectoryPersistence
 * writes `tokens.json`/`client.json` here when we set it as `tokenCacheDir`.
 * The interactive `authorize-mcp` flow (in the api-server-spawned harness-host)
 * writes it; the per-turn harness reads `tokens.json` back to inject the
 * bearer header — so BOTH must derive the same path from (workspaceDir,
 * serverId). Kept beside the pi MCP tool cache (both per-workspace runtime
 * state under workspaceDir).
 */
export function mcpOAuthTokenCacheDir(workspaceDir: string, serverId: string): string {
  return path.join(workspaceDir, "mcp-oauth", mcpTokenDirSegment(serverId));
}

/**
 * Read the persisted OAuth access token for a user-connected remote MCP server,
 * or null when the server has never been authorized. The token is injected as
 * an `Authorization: Bearer` header so the per-turn harness never has to run
 * (and never accidentally launches) the interactive OAuth flow — that lives
 * only in the out-of-turn `authorize-mcp` action. No expiry check: an expired
 * token 401s, which surfaces as authRequired and prompts a re-Authorize.
 */
export function readMcpOAuthAccessToken(workspaceDir: string, serverId: string): string | null {
  try {
    const file = path.join(mcpOAuthTokenCacheDir(workspaceDir, serverId), "tokens.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { access_token?: unknown };
    const token = typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
    return token || null;
  } catch {
    return null;
  }
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

function mcpAuthRequiredMarkerPath(workspaceDir: string, serverId: string): string {
  return path.join(mcpOAuthTokenCacheDir(workspaceDir, serverId), "auth-required");
}

/**
 * Record whether a remote server demands OAuth (learned from the connect-time
 * probe) so the per-turn harness can SKIP discovering an unauthenticated one —
 * otherwise a registered-but-unauthorized server (e.g. HeyGen with no token)
 * makes EVERY turn's bootstrap grind the 401 + StreamableHTTP→SSE fallback for
 * ~12s. Written beside the token; cleared once the server turns out NOT to need
 * auth. Lives in the token dir, so `clearMcpOAuthToken` (uninstall/reauth) wipes
 * it for free.
 */
export function writeMcpAuthRequiredMarker(
  workspaceDir: string,
  serverId: string,
  required: boolean,
): void {
  const markerPath = mcpAuthRequiredMarkerPath(workspaceDir, serverId);
  try {
    if (required) {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, "1");
    } else {
      fs.rmSync(markerPath, { force: true });
    }
  } catch {
    // best-effort — a missing marker just means we attempt discovery normally
  }
}

/**
 * True when a server is flagged auth-required AND has no usable token: its
 * discovery would 401, so the harness should skip it (surfacing authRequired
 * immediately) rather than paying the transport-fallback cost every turn. A
 * token present → false, so we discover its tools with the replayed bearer
 * header as usual.
 */
export function mcpServerNeedsAuthWithoutToken(
  workspaceDir: string,
  serverId: string,
): boolean {
  if (readMcpOAuthAccessToken(workspaceDir, serverId)) {
    return false;
  }
  try {
    return fs.existsSync(mcpAuthRequiredMarkerPath(workspaceDir, serverId));
  } catch {
    return false;
  }
}

/**
 * Wipe every persisted OAuth artifact for a server so the NEXT authorize runs a
 * fresh browser consent (re-auth / switch account). mcporter mirrors the token
 * across THREE stores, so clearing only our token dir isn't enough — the shared
 * vault would mask it:
 *   1. our per-workspace token dir (`mcpOAuthTokenCacheDir`, what the harness reads),
 *   2. mcporter's legacy `~/.mcporter/<serverId>` dir,
 *   3. the shared vault `~/.mcporter/credentials.json` — entries are keyed
 *      `${serverId}|<hash>`, so drop any entry whose key is (or starts with)
 *      the server id (prefix match → robust to mcporter's hash format).
 * Best-effort: any missing file / parse error is ignored.
 */
export function clearMcpOAuthToken(workspaceDir: string, serverId: string): void {
  const rmDir = (dir: string): void => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };
  rmDir(mcpOAuthTokenCacheDir(workspaceDir, serverId));
  rmDir(path.join(os.homedir(), ".mcporter", serverId));
  try {
    const vaultPath = path.join(os.homedir(), ".mcporter", "credentials.json");
    const vault = JSON.parse(fs.readFileSync(vaultPath, "utf8")) as {
      entries?: Record<string, unknown>;
    };
    if (vault && vault.entries && typeof vault.entries === "object") {
      const keys = mcpVaultKeysForServer(vault.entries, serverId);
      if (keys.length > 0) {
        for (const key of keys) {
          delete vault.entries[key];
        }
        fs.writeFileSync(vaultPath, JSON.stringify(vault));
      }
    }
  } catch {
    // no vault / unreadable → nothing to clear
  }
}

/**
 * Vault entry keys belonging to a server. mcporter keys entries as
 * `${serverName}|<hash>` (or bare `${serverName}`), so match the server id
 * exactly or as the `${id}|` prefix — robust to whatever hash mcporter uses,
 * and it won't touch a DIFFERENT server whose id merely shares a prefix
 * (`heygen` must not match `heygen_two|…`).
 */
export function mcpVaultKeysForServer(
  entries: Record<string, unknown>,
  serverId: string,
): string[] {
  return Object.keys(entries).filter(
    (key) => key === serverId || key.startsWith(`${serverId}|`),
  );
}

/** Heuristic: did discovery fail because the server needs authorization? */
export function isMcpAuthError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("invalid_token") ||
    message.includes("bearer")
  );
}

function toHarnessMcpServerBinding(
  payload: HarnessPreparedMcpServerConfig,
  workspaceDir: string,
): HarnessMcpServerBinding | null {
  const name = firstNonEmptyString(payload.name);
  const config = isRecord(payload.config) ? payload.config : null;
  if (!name || !config) {
    return null;
  }

  const enabled = typeof config.enabled === "boolean" ? config.enabled : true;
  if (!enabled) {
    return null;
  }

  const timeoutMs = typeof config.timeout === "number" && Number.isFinite(config.timeout) ? config.timeout : 30000;
  const description = `Holaboss MCP server ${name}`;
  if (config.type === "local") {
    const command = Array.isArray(config.command)
      ? config.command.filter((item): item is string => typeof item === "string")
      : [];
    const [executable, ...args] = command;
    if (!executable) {
      throw new Error(`Pi MCP server ${name} is missing a local command`);
    }
    return {
      serverId: name,
      timeoutMs,
      description,
      transport: {
        kind: "stdio",
        command: executable,
        args,
        cwd: workspaceDir,
        env: stringRecord(config.environment),
      },
    };
  }

  const url = firstNonEmptyString(config.url);
  if (!url) {
    throw new Error(`Pi MCP server ${name} is missing a remote url`);
  }
  const headers = stringRecord(config.headers);
  // If the server was authorized via the out-of-turn OAuth flow, replay the
  // persisted bearer token as a header so this turn's discovery + tool calls
  // authenticate WITHOUT any interactive OAuth machinery (which must never run
  // mid-turn). Skip when the caller already supplied an explicit auth header.
  if (!hasAuthorizationHeader(headers)) {
    const token = readMcpOAuthAccessToken(workspaceDir, name);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return {
    serverId: name,
    timeoutMs,
    description,
    transport: {
      kind: "http",
      url,
      headers,
    },
  };
}

export function buildHarnessMcpServerBindings(params: {
  servers: HarnessPreparedMcpServerConfig[];
  workspaceDir: string;
}): HarnessMcpServerBinding[] {
  return params.servers
    .map((server) => toHarnessMcpServerBinding(server, params.workspaceDir))
    .filter((binding): binding is HarnessMcpServerBinding => Boolean(binding));
}

function mcpToolAllowlist(
  toolRefs: HarnessMcpToolRef[],
): Map<string, Map<string, HarnessMcpToolRef>> {
  const allowlist = new Map<string, Map<string, HarnessMcpToolRef>>();
  for (const toolRef of toolRefs) {
    const serverTools = allowlist.get(toolRef.server_id) ?? new Map<string, HarnessMcpToolRef>();
    serverTools.set(toolRef.tool_name, toolRef);
    allowlist.set(toolRef.server_id, serverTools);
  }
  return allowlist;
}

function describeDiscoveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

export async function discoverHarnessMcpTools(params: {
  bindings: HarnessMcpServerBinding[];
  runtime: HarnessMcpRuntimeLike;
  toolRefs: HarnessMcpToolRef[];
  retryIntervalMs?: number;
  maxWaitMs?: number;
}): Promise<HarnessMcpDiscoveryResult> {
  const retryIntervalMs = Math.max(1, params.retryIntervalMs ?? 250);
  const maxWaitMs = Math.max(retryIntervalMs, params.maxWaitMs ?? 10000);
  const allowlist = mcpToolAllowlist(params.toolRefs);
  const discovered: HarnessDiscoveredMcpTool[] = [];
  const failures: HarnessMcpDiscoveryFailure[] = [];
  const usedNames = new Set<string>();

  for (const binding of params.bindings) {
    const allowedTools = allowlist.get(binding.serverId);
    const discoveryDeadline = Date.now() + Math.min(binding.timeoutMs, maxWaitMs);
    let discoveredTools: HarnessMcpRuntimeToolInfo[] = [];
    let lastDiscoveryError: unknown = null;
    let serverReachable = false;

    while (true) {
      try {
        discoveredTools = await params.runtime.listTools(binding.serverId, { includeSchema: true });
        lastDiscoveryError = null;
        serverReachable = true;
      } catch (error) {
        lastDiscoveryError = error;
        discoveredTools = [];
        serverReachable = false;
      }

      const missingAllowedTools = allowedTools
        ? [...allowedTools.keys()].filter((toolName) => !discoveredTools.some((tool) => tool.name === toolName))
        : [];
      if (missingAllowedTools.length === 0) {
        break;
      }
      if (Date.now() >= discoveryDeadline) {
        const missingToolIds = allowedTools
          ? missingAllowedTools.map(
              (toolName) =>
                allowedTools.get(toolName)?.tool_id ?? `${binding.serverId}.${toolName}`,
            )
          : [];
        const authRequired = !serverReachable && isMcpAuthError(lastDiscoveryError);
        const reason = serverReachable
          ? `Tools not discovered: ${missingAllowedTools.join(", ")}`
          : authRequired
            ? `Authorization required: ${describeDiscoveryError(lastDiscoveryError)}`
            : `Server unreachable: ${describeDiscoveryError(lastDiscoveryError)}`;
        failures.push({
          serverId: binding.serverId,
          reason,
          missingToolIds,
          authRequired,
        });
        break;
      }
      await sleep(retryIntervalMs);
    }

    // A reachable server still exposes the tools it DID return, even when some
    // allowlisted tools never showed up — those are reported as unavailable
    // (the failure record above) without discarding the tools that work. Skip
    // entirely only when the server never became reachable, so one partial or
    // slow-to-list server can't knock out its own working tools.
    if (!serverReachable) {
      // Record the failure even with NO allowlist. Previously an unreachable
      // server with no allowlisted tools broke the loop and was dropped with no
      // failure recorded — so a remote server that needs OAuth surfaced zero
      // tools AND zero errors, and the agent cheerfully reported "connected".
      // Classify auth (401/403) so the UI can offer an Authorize action.
      if (!failures.some((failure) => failure.serverId === binding.serverId)) {
        const authRequired = isMcpAuthError(lastDiscoveryError);
        failures.push({
          serverId: binding.serverId,
          reason: authRequired
            ? `Authorization required: ${describeDiscoveryError(lastDiscoveryError)}`
            : `Server unreachable: ${describeDiscoveryError(lastDiscoveryError)}`,
          missingToolIds: [],
          authRequired,
        });
      }
      continue;
    }

    const filteredTools = allowedTools
      ? discoveredTools.filter((tool) => allowedTools.has(tool.name))
      : discoveredTools;

    for (const tool of filteredTools) {
      const toolRef = allowedTools?.get(tool.name);
      const harnessToolName = buildUniqueHarnessMcpToolName(binding.serverId, tool.name, usedNames);
      usedNames.add(harnessToolName);
      discovered.push({
        harnessToolName,
        serverId: binding.serverId,
        toolId: toolRef?.tool_id ?? `${binding.serverId}.${tool.name}`,
        toolName: tool.name,
        description: [tool.description?.trim(), `MCP server: ${binding.serverId}`, `MCP tool: ${tool.name}`]
          .filter(Boolean)
          .join("\n"),
        inputSchema: normalizeHarnessMcpToolParametersSchema(tool.inputSchema),
        timeoutMs: binding.timeoutMs,
      });
    }
  }

  return { tools: discovered, failures };
}
