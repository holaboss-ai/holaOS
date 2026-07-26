import fs from "node:fs";
import path from "node:path";

import {
  listRuntimeHarnessAdapters,
  type RuntimeHarnessAdapter,
} from "./harness-registry.js";
import { discoverHarnessModelsViaHost } from "./harness-model-discovery.js";
import type { HarnessSupportedModel } from "../../harnesses/src/types.js";

/**
 * Local CLI binary that, when found on PATH, signals that a harness can be
 * used on this machine. The pi harness has no binary requirement (Hola runs
 * in-process) — its absence from this map means it's always available.
 */
const HARNESS_REQUIRED_BINARY: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
};

export interface HarnessAvailability {
  id: string;
  displayName: string;
  capabilities: RuntimeHarnessAdapter["capabilities"];
  available: boolean;
  /**
   * When `available` is true, the absolute path to the detected binary
   * (or "in-process" for harnesses without a binary). When false, a short
   * hint the UI can surface ("install `claude` and ensure it is on PATH").
   */
  detection: string;
  /**
   * Models the harness's host runner accepts. Empty array means the
   * harness uses the runtime's dynamic provider catalogue (pi/Hola)
   * and the desktop should keep its existing ModelCombobox; non-empty
   * means the harness has its own namespace and the desktop should
   * render a picker scoped to these entries.
   */
  supportedModels: HarnessSupportedModel[];
}

interface CacheEntry {
  expiresAt: number;
  result: HarnessAvailability[];
}

const CACHE_TTL_MS = 60_000;
let cache: CacheEntry | null = null;
let modelsCache: CacheEntry | null = null;
let modelsRefreshInFlight: Promise<HarnessAvailability[]> | null = null;

// Per-harness timeout for a live model-discovery spawn. Generous because
// discovery runs in the BACKGROUND (stale-while-revalidate) and the
// harness-host's inner CLI timeouts must finish inside it.
const MODEL_DISCOVERY_TIMEOUT_MS = 25_000;

export function invalidateHarnessAvailabilityCache(): void {
  cache = null;
  modelsCache = null;
  modelsRefreshInFlight = null;
}

export function listHarnessAvailability(): HarnessAvailability[] {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return cache.result;
  }
  const result = listRuntimeHarnessAdapters().map(probeAdapter);
  cache = { expiresAt: now + CACHE_TTL_MS, result };
  return result;
}

/**
 * Like {@link listHarnessAvailability}, but each available harness that
 * declares `dynamicModelDiscovery` gets its static `supportedModels` replaced
 * with the live catalogue read from the CLI (via the harness-host
 * `discover-models` subcommand).
 *
 * Stale-while-revalidate: this never blocks the status path on a CLI spawn.
 * On a cache hit it returns the cached (model-enriched) result; on a miss it
 * kicks off a background refresh and immediately returns the last result (or
 * the static probe if there's none yet). Within one ~60s poll cycle the
 * dynamic catalogue lands in the cache. Discovery only runs for PATH-present
 * harnesses, so uninstalled CLIs cost nothing.
 *
 * The sync {@link listHarnessAvailability} stays for callers that only need
 * availability (e.g. `pickDefaultHarness`) and must not pay for discovery.
 */
export async function resolveHarnessAvailabilityWithModels(
  options: { cwd?: string } = {},
): Promise<HarnessAvailability[]> {
  const now = Date.now();
  if (modelsCache && modelsCache.expiresAt > now) {
    return modelsCache.result;
  }
  // Cache cold or stale — start a background refresh (deduped) and serve the
  // freshest thing we already have: the last (stale) enriched result, else the
  // static probe. No `await` on the refresh, so the status path stays fast.
  if (!modelsRefreshInFlight) {
    const cwd = options.cwd?.trim() || process.cwd();
    modelsRefreshInFlight = refreshHarnessModels(cwd).finally(() => {
      modelsRefreshInFlight = null;
    });
  }
  return modelsCache?.result ?? listRuntimeHarnessAdapters().map(probeAdapter);
}

async function refreshHarnessModels(cwd: string): Promise<HarnessAvailability[]> {
  const base = listRuntimeHarnessAdapters().map((adapter) => ({
    adapter,
    availability: probeAdapter(adapter),
  }));
  const resolved = await Promise.all(
    base.map(async ({ adapter, availability }) => {
      if (!availability.available || !adapter.dynamicModelDiscovery) {
        return availability;
      }
      const discovered = await discoverHarnessModelsViaHost({
        harnessId: adapter.id,
        cwd,
        timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
      }).catch(() => [] as HarnessSupportedModel[]);
      // Discovery failed/empty — keep the static fallback catalogue.
      return discovered.length === 0
        ? availability
        : { ...availability, supportedModels: discovered };
    }),
  );
  modelsCache = { expiresAt: Date.now() + CACHE_TTL_MS, result: resolved };
  return resolved;
}

/**
 * Pick a default harness for a new workspace when the client doesn't
 * supply one. Preference order:
 *   1. The current pi harness (Hola) — always available, lowest risk.
 *   2. Any other available CLI harness in registration order.
 *   3. Pi anyway, as a last resort, so callers always get a non-null id.
 *
 * Used by onboarding / workspace-create when the client hasn't yet shown
 * the user a picker.
 */
export function pickDefaultHarness(): string {
  const available = listHarnessAvailability().filter((entry) => entry.available);
  const pi = available.find((entry) => entry.id === "pi");
  if (pi) {
    return pi.id;
  }
  if (available.length > 0) {
    return available[0]!.id;
  }
  return "pi";
}

function probeAdapter(adapter: RuntimeHarnessAdapter): HarnessAvailability {
  // The adapter is the source of truth for its own model namespace.
  // Defensive `?? []` guards legacy adapters that predate the field;
  // current adapters always declare it.
  const supportedModels = adapter.supportedModels ?? [];
  const binary = HARNESS_REQUIRED_BINARY[adapter.id];
  if (!binary) {
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      capabilities: adapter.capabilities,
      available: true,
      detection: "in-process",
      supportedModels,
    };
  }
  const resolved = findOnPath(binary);
  if (resolved) {
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      capabilities: adapter.capabilities,
      available: true,
      detection: resolved,
      supportedModels,
    };
  }
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    capabilities: adapter.capabilities,
    available: false,
    detection: `install \`${binary}\` and ensure it is on PATH`,
    supportedModels,
  };
}

function findOnPath(binary: string): string | null {
  const rawPath = process.env.PATH;
  if (!rawPath) {
    return null;
  }
  const sep = process.platform === "win32" ? ";" : ":";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const dir of rawPath.split(sep)) {
    if (!dir) {
      continue;
    }
    for (const ext of extensions) {
      const candidate = path.join(dir, `${binary}${ext}`);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) {
          continue;
        }
        if (process.platform !== "win32") {
          // Best-effort executability check; ignore EACCES on directories
          // we can stat but not access.
          try {
            fs.accessSync(candidate, fs.constants.X_OK);
          } catch {
            continue;
          }
        }
        return candidate;
      } catch {
        // File doesn't exist or stat failed — keep searching.
      }
    }
  }
  return null;
}
