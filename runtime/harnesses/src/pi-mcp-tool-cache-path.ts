import fs from "node:fs";
import path from "node:path";

/**
 * Canonical location of pi's cross-turn MCP tool cache (see
 * harness-host `pi-mcp-tool-cache.ts`, which reads/writes it). It lives in
 * `runtime/harnesses` because BOTH harness-host (the writer) and the api-server
 * (which invalidates it for the "Refresh MCP tools" capability) need the path,
 * and the api-server can't import harness-host — this is the single source of
 * truth so the two never drift.
 */
export const PI_MCP_TOOL_CACHE_FILE = "pi-mcp-tool-cache.json";

export function piMcpToolCachePath(workspaceDir: string): string {
  return path.join(workspaceDir, ".holaboss", "state", PI_MCP_TOOL_CACHE_FILE);
}

/**
 * Delete the workspace's pi MCP tool cache so the next run re-discovers every
 * connected MCP server's tools. Returns true if a cache file was present.
 * Best-effort: a missing file returns false; failures are swallowed (the next
 * run simply re-discovers anyway). Also removes the `.tmp` sibling that the
 * writer renames from, in case a write was interrupted.
 */
export function clearPiMcpToolCache(workspaceDir: string): boolean {
  const target = piMcpToolCachePath(workspaceDir);
  let existed = false;
  try {
    existed = fs.existsSync(target);
    fs.rmSync(target, { force: true });
    fs.rmSync(`${target}.tmp`, { force: true });
  } catch {
    // The OS/next-run reap handles leftovers; never let cleanup throw.
  }
  return existed;
}
