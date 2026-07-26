// Local-only persistence for MCP-marketplace install state + credentials.
//
// The MCP marketplace (see mcpMarketplace.ts) lets a user install an MCP server by
// pasting its required keys (an account credential, an API token, …). Those values are
// SECRETS and MUST NEVER leave the machine: they live here in localStorage and are only
// ever handed to the Electron MAIN process over IPC (which writes them into the local
// workspace.yaml, exactly like the existing API-key install path). No `/gateway/*` / BFF
// call ever carries them.
//
// Two records are kept:
//   • installed ids  — which MCP servers the user has installed (drives the `installed`
//     flag merged into the catalog).
//   • per-server keys — `{ <requiredKey.name>: <value> }` for each installed server, so an
//     install can be re-applied (per-turn bearer refresh / app restart) without re-prompting.
//
// Everything is best-effort and tolerant of a corrupt/blocked store (returns empty).

const INSTALLED_KEY = "holaboss.mcp.installed.v1";
const KEYS_PREFIX = "holaboss.mcp.keys.v1.";
// Per-server install SPEC (the catalog fields needed to rebuild the attach input:
// mcpUrl, holabossHosted, each key's target, tool names). Persisted so an install can be
// re-synced/re-attached from local state ALONE — even when its catalog entry isn't loaded.
// This is what lets a 坚果云 install triggered from the HolaApp catalog (absent from the MCP
// catalog) survive a relaunch: the MCP-page sync rebuilds its config from this spec instead
// of dropping (and detaching) it because it isn't in the MCP catalog. Never holds secrets —
// the credential VALUES live under KEYS_PREFIX; the spec only carries key metadata.
const SPEC_PREFIX = "holaboss.mcp.spec.v1.";

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

/** The ids of MCP servers the user currently has installed. */
export function readInstalledMcpIds(): string[] {
  if (!hasLocalStorage()) {
    return [];
  }
  try {
    const raw = localStorage.getItem(INSTALLED_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function writeInstalledMcpIds(ids: string[]): void {
  if (!hasLocalStorage()) {
    return;
  }
  try {
    localStorage.setItem(INSTALLED_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    // best-effort — install state is non-critical local UI state
  }
}

export function markMcpInstalled(id: string): void {
  writeInstalledMcpIds([...readInstalledMcpIds(), id]);
}

export function markMcpUninstalled(id: string): void {
  writeInstalledMcpIds(readInstalledMcpIds().filter((existing) => existing !== id));
}

/** The stored credential values for one MCP server, keyed by `requiredKey.name`. */
export function readMcpKeys(id: string): Record<string, string> {
  if (!hasLocalStorage()) {
    return {};
  }
  try {
    const raw = localStorage.getItem(`${KEYS_PREFIX}${id}`);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        out[name] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeMcpKeys(id: string, values: Record<string, string>): void {
  if (!hasLocalStorage()) {
    return;
  }
  try {
    localStorage.setItem(`${KEYS_PREFIX}${id}`, JSON.stringify(values));
  } catch {
    // best-effort
  }
}

export function clearMcpKeys(id: string): void {
  if (!hasLocalStorage()) {
    return;
  }
  try {
    localStorage.removeItem(`${KEYS_PREFIX}${id}`);
  } catch {
    // best-effort
  }
}

/** The stored install spec for one MCP server (the catalog fields needed to rebuild its
 * attach input). Returns null when absent/corrupt. Kept as an opaque JSON record so this
 * leaf module stays free of the catalog types — the caller re-validates it. */
export function readMcpSpec(id: string): Record<string, unknown> | null {
  if (!hasLocalStorage()) {
    return null;
  }
  try {
    const raw = localStorage.getItem(`${SPEC_PREFIX}${id}`);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function writeMcpSpec(id: string, spec: Record<string, unknown>): void {
  if (!hasLocalStorage()) {
    return;
  }
  try {
    localStorage.setItem(`${SPEC_PREFIX}${id}`, JSON.stringify(spec));
  } catch {
    // best-effort
  }
}

export function clearMcpSpec(id: string): void {
  if (!hasLocalStorage()) {
    return;
  }
  try {
    localStorage.removeItem(`${SPEC_PREFIX}${id}`);
  } catch {
    // best-effort
  }
}
