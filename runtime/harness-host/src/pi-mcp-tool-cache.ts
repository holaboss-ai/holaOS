import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { HarnessDiscoveredMcpTool } from "../../harnesses/src/index.js";
import { piMcpToolCachePath } from "../../harnesses/src/index.js";

/**
 * Cross-turn cache of the MCP tool schemas pi discovers, so a turn can build
 * its tool list WITHOUT a live `listTools` handshake against every workspace
 * MCP server. Without it, pi opened + listed every server (including remote
 * ones) before `run_started` on every turn — the dominant startup lag for
 * workspaces with remote MCP servers. Transports still connect lazily on the
 * first `callTool` (mcporter memoizes per server), so the cache only removes
 * the eager discovery, not the actual tool execution.
 *
 * The cache lives on disk because the harness-host is a fresh subprocess per
 * turn (an in-memory cache wouldn't survive). It's keyed by a hash of the
 * server configs + allowlist tool refs — the inputs that determine which
 * tools are exposed — so it self-invalidates when those change.
 */

const CACHE_VERSION = 1;
// Cache path lives in runtime/harnesses (piMcpToolCachePath) so the api-server
// can invalidate the same file for the "Refresh MCP tools" capability.

/** Deterministic JSON: object keys sorted recursively so logically-equal
 *  configs hash equal regardless of key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * Cache key derived from the inputs that determine the exposed tool *set*:
 * the server configs (url/headers/command/env) + the allowlist tool refs.
 * When any of these change the key changes and pi re-discovers. Tool input
 * schemas that drift on the server without a config change are a tolerated
 * staleness window — the config/allowlist is the source of truth for which
 * tools exist.
 */
export function piMcpToolCacheKey(servers: unknown, toolRefs: unknown): string {
  return createHash("sha256")
    .update(stableStringify({ servers, toolRefs }))
    .digest("hex");
}

/**
 * True when any server payload carries `_holaboss_force_refresh` — set when a
 * resolved-application sidecar just (re)started and its tool set may have
 * changed. Forces a live re-discovery, bypassing the cache.
 */
export function piMcpServersForceRefresh(servers: readonly unknown[]): boolean {
  return servers.some(
    (server) =>
      !!server &&
      typeof server === "object" &&
      (server as Record<string, unknown>)._holaboss_force_refresh === true,
  );
}

export function readPiMcpToolCache(
  workspaceDir: string,
  expectedKey: string,
): HarnessDiscoveredMcpTool[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(piMcpToolCachePath(workspaceDir), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      key?: string;
      tools?: HarnessDiscoveredMcpTool[];
    };
    if (parsed.version !== CACHE_VERSION || parsed.key !== expectedKey) {
      return null;
    }
    return Array.isArray(parsed.tools) ? parsed.tools : null;
  } catch {
    return null;
  }
}

export function writePiMcpToolCache(
  workspaceDir: string,
  key: string,
  tools: HarnessDiscoveredMcpTool[],
): void {
  const target = piMcpToolCachePath(workspaceDir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tempPath = `${target}.tmp`;
    fs.writeFileSync(
      tempPath,
      JSON.stringify({ version: CACHE_VERSION, key, tools }),
      "utf8",
    );
    fs.renameSync(tempPath, target);
  } catch {
    // Best effort — a write failure just means the next turn re-discovers.
  }
}
