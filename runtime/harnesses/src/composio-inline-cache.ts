import fs from "node:fs";
import path from "node:path";

/**
 * Cross-turn cache for the workspace's Composio inline tool listing.
 *
 * `GET /api/v1/capabilities/composio-inline-tools` is fetched TWICE on every
 * single turn, from two different processes:
 *   - the api-server's ts-runner during bootstrap (to build the capability
 *     manifest / tool-ref map), and
 *   - the harness-host during pi's session setup (to build the tool defs).
 * Measured on a desktop turn that difference is real money: 773ms of fetch plus
 * 754ms awaiting it in bootstrap, then another 659ms in session setup — roughly
 * 1.5-2.2s of the ~3.8s pre-model init, every message, for a listing that
 * changes only when the user connects or disconnects an integration. MCP tool
 * discovery already has exactly this cache (`pi-mcp-tool-cache.json`), which is
 * why `mcp_connect` costs ~1ms while composio costs ~700ms.
 *
 * The cache lives in `runtime/harnesses` because BOTH readers need it and
 * harness-host cannot import the api-server (mirroring `pi-mcp-tool-cache-path`).
 * It is keyed by workspace id and carries the raw response body, so the two
 * callers can each parse it their own way.
 *
 * Freshness: a short TTL keeps a newly-connected integration from being
 * invisible for long, and `clearComposioInlineCache` gives the connect/install
 * flows an explicit invalidation hook. A cache miss simply re-fetches, so every
 * failure mode degrades to today's behavior.
 */

const CACHE_VERSION = 1;
export const COMPOSIO_INLINE_CACHE_FILE = "composio-inline-tool-cache.json";

/**
 * The TTL no longer carries the freshness job.
 *
 * It was 120 s because it was the *only* invalidation this cache had —
 * `clearComposioInlineCache` shipped documented as the connect/install hook and
 * was never called. One number had to be both short enough that a newly
 * connected integration appears promptly and long enough that the bootstrap
 * fetch hits between turns, and it was tuned for the first. So the ~773 ms
 * bootstrap fetch missed on every turn a user took more than two minutes to
 * send — which is most real conversation.
 *
 * Connection mutations made through this runtime now invalidate explicitly
 * (`composio-cache-invalidation.ts`), which is strictly fresher than a 120 s
 * window: a disconnect takes effect immediately instead of up to two minutes
 * later.
 *
 * What the TTL still has to cover is changes made OUTSIDE this runtime — an
 * integration connected in the web app, or revoked at the provider — which have
 * no invalidation path here. That is what keeps this minutes rather than hours:
 * 15 minutes captures nearly every inter-turn gap while bounding how long an
 * externally-made change can stay invisible.
 */
const DEFAULT_TTL_MS = 15 * 60_000;

export function composioInlineCachePath(workspaceDir: string): string {
  return path.join(workspaceDir, ".holaboss", "state", COMPOSIO_INLINE_CACHE_FILE);
}

function ttlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt((env.HB_COMPOSIO_CACHE_TTL_MS ?? "").trim(), 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_TTL_MS;
}

export function composioInlineCacheEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = (env.HB_COMPOSIO_CACHE ?? "").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

/**
 * Return the cached listing body for this workspace, or null when absent, stale,
 * from another workspace, or unreadable. `nowMs` is injectable for tests.
 */
export function readComposioInlineCache(params: {
  workspaceDir: string;
  workspaceId: string;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}): unknown | null {
  const env = params.env ?? process.env;
  if (!composioInlineCacheEnabled(env)) return null;
  try {
    const raw = fs.readFileSync(composioInlineCachePath(params.workspaceDir), "utf8");
    const parsed = JSON.parse(raw) as {
      version?: number;
      workspace_id?: string;
      fetched_at_ms?: number;
      payload?: unknown;
    };
    if (parsed.version !== CACHE_VERSION) return null;
    if (parsed.workspace_id !== params.workspaceId) return null;
    if (typeof parsed.fetched_at_ms !== "number") return null;
    const age = (params.nowMs ?? Date.now()) - parsed.fetched_at_ms;
    const ttl = ttlMs(env);
    if (age < 0 || age > ttl) return null;
    return parsed.payload ?? null;
  } catch {
    return null;
  }
}

/** Persist a freshly fetched listing. Best-effort: write failures are ignored. */
export function writeComposioInlineCache(params: {
  workspaceDir: string;
  workspaceId: string;
  payload: unknown;
  nowMs?: number;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  if (!composioInlineCacheEnabled(env)) return;
  const target = composioInlineCachePath(params.workspaceDir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        version: CACHE_VERSION,
        workspace_id: params.workspaceId,
        fetched_at_ms: params.nowMs ?? Date.now(),
        payload: params.payload,
      }),
    );
    fs.renameSync(tmp, target);
  } catch {
    /* best-effort: the next turn simply re-fetches */
  }
}

/**
 * Drop the workspace's cached listing so the next turn re-fetches. Returns true
 * when a cache file was present. For the connect / install / refresh flows.
 */
export function clearComposioInlineCache(workspaceDir: string): boolean {
  const target = composioInlineCachePath(workspaceDir);
  let existed = false;
  for (const file of [target, `${target}.tmp`]) {
    try {
      fs.rmSync(file);
      if (file === target) existed = true;
    } catch {
      /* missing file is fine */
    }
  }
  return existed;
}
