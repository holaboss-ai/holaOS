// Typed client for the MCP-server marketplace.
//
// The backend serves a catalog of installable MCP servers at
// `GET /api/v1/apps/mcp-catalog`, reached through the gateway at
// `/gateway/wapp/mcp-catalog` (same convention as the HolaApp catalog at
// `/gateway/wapp/catalog`, see webHolaApps.ts). Each entry describes an MCP server the
// user can attach to their agent — the first is 坚果云 (Nutstore).
//
// Installing an MCP server is a LOCAL operation: the user pastes the server's required
// keys (credentials), which are stored ONLY on this machine (localMcpKeys.ts) and handed
// to the Electron main process over IPC to be written into the local workspace.yaml. No
// `/gateway/*` call ever carries the keys. This mirrors the existing HolaApp API-key
// install path (attachCustomMcpServer in electron/main.ts) but is kept separate because
// the MCP catalog's shape (holabossHosted, requiredKeys[], tools[]) differs from a HolaApp.

import { bffFetch } from "./bff-fetch-bridge";
import {
  clearMcpKeys,
  markMcpInstalled,
  markMcpUninstalled,
  readInstalledMcpIds,
  readMcpKeys,
  writeMcpKeys,
} from "./localMcpKeys";

// ── catalog types (mirror the backend McpCatalogEntry contract) ──────────────

/** Where a required key is applied when attaching the MCP server. */
export type McpKeyTarget = "header" | "query" | "env";

/** One credential the user must supply to install an MCP server. Every declared key is
 * required — install is blocked until all are non-empty. */
export interface McpRequiredKey {
  target: McpKeyTarget;
  /** The header name / query param / env var the value is applied as. */
  name: string;
  /** Human label shown above the input. */
  label: string;
  /** Optional helper text under the input. */
  help?: string;
  /** Masked (password) input + never rendered back once stored. */
  secret?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
}

/** A marketplace card for an installable MCP server, plus the local `installed` flag. */
export interface McpCatalogEntry {
  id: string;
  name: string;
  description?: string;
  /** Favicon/logo image URL. */
  iconUrl?: string;
  category?: string;
  badge?: string;
  tags?: string[];
  /** Holaboss-hosted → a PATH like "/mcp/<id>/mcp" (prepend the API base in main);
   * external → an absolute URL. */
  mcpUrl: string;
  /** true → main ALSO attaches the Holaboss session bearer (Authorization header). */
  holabossHosted: boolean;
  requiredKeys: McpRequiredKey[];
  /** Optional web surface to open (e.g. the provider's site) for the user to get a key. */
  surfaceUrl?: string;
  /** Tool names/descriptions from the server — enumerated into the agent's allowlist. */
  tools?: McpTool[];
  /** Shown in the marketplace but greyed / not-installable (backend availability=coming_soon). */
  comingSoon: boolean;
  /** false = a community (user-uploaded) server, not Holaboss-vetted — install is
   * gated behind an "unverified — its tools run in your agent" consent prompt. */
  verified: boolean;
  /** Local install state (from localMcpKeys), merged in by listMcpCatalog. */
  installed: boolean;
}

/** The resolved config handed to the Electron main process to attach the server. Carries
 * the user's credentials split by their `target`, so main can apply them to the local
 * workspace.yaml server entry (header → headers, query → url query, env → server env). */
export interface McpAttachInput {
  id: string;
  mcpUrl: string;
  holabossHosted: boolean;
  headerKeys: Record<string, string>;
  queryKeys: Record<string, string>;
  envKeys: Record<string, string>;
  tools: string[];
  /** When set, this MCP is OWNED by the app container with this id — main writes
   * it to workspace.yaml's `app_servers` (grouped under the app), not the
   * standalone `servers` pool. Set for a HolaApp's `hostedMcpInstall`. */
  ownerAppId?: string;
}

// ── normalization ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRequiredKey(value: unknown): McpRequiredKey | null {
  if (!isRecord(value)) {
    return null;
  }
  const target =
    value.target === "header" || value.target === "query" || value.target === "env"
      ? value.target
      : null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const label = typeof value.label === "string" ? value.label.trim() : "";
  if (!(target && name && label)) {
    return null;
  }
  return {
    target,
    name,
    label,
    ...(typeof value.help === "string" && value.help.trim()
      ? { help: value.help }
      : {}),
    ...(value.secret === true ? { secret: true } : {}),
  };
}

function normalizeTools(value: unknown): McpTool[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tools = value.flatMap((entry): McpTool[] => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !entry.name.trim()) {
      return [];
    }
    return [
      {
        name: entry.name.trim(),
        description:
          typeof entry.description === "string" ? entry.description : "",
      },
    ];
  });
  return tools.length > 0 ? tools : undefined;
}

function normalizeMcpEntry(value: unknown): McpCatalogEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const mcpUrl = typeof value.mcpUrl === "string" ? value.mcpUrl.trim() : "";
  if (!(id && name && mcpUrl)) {
    return null;
  }
  const requiredKeys = Array.isArray(value.requiredKeys)
    ? value.requiredKeys
        .map(normalizeRequiredKey)
        .filter((key): key is McpRequiredKey => key !== null)
    : [];
  const tags = Array.isArray(value.tags)
    ? value.tags.filter(
        (tag): tag is string => typeof tag === "string" && tag.trim().length > 0,
      )
    : undefined;
  const tools = normalizeTools(value.tools);
  return {
    id,
    name,
    mcpUrl,
    holabossHosted: value.holabossHosted === true,
    requiredKeys,
    comingSoon: value.comingSoon === true,
    // Default true unless the backend explicitly marks it unverified (community).
    verified: value.verified !== false,
    installed: false,
    ...(typeof value.description === "string" && value.description.trim()
      ? { description: value.description }
      : {}),
    ...(typeof value.iconUrl === "string" && value.iconUrl.trim()
      ? { iconUrl: value.iconUrl }
      : {}),
    ...(typeof value.category === "string" && value.category.trim()
      ? { category: value.category }
      : {}),
    ...(typeof value.badge === "string" && value.badge.trim()
      ? { badge: value.badge }
      : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(typeof value.surfaceUrl === "string" && value.surfaceUrl.trim()
      ? { surfaceUrl: value.surfaceUrl }
      : {}),
    ...(tools ? { tools } : {}),
  };
}

// ── catalog fetch ─────────────────────────────────────────────────────────────

async function backendBaseUrl(): Promise<string | null> {
  const base = (await window.electronAPI.auth.getBackendBaseUrl())?.replace(
    /\/+$/,
    "",
  );
  return base || null;
}

/** Fetch the MCP catalog and merge in this machine's local install state. Returns an
 * empty catalog (and logs why) when it can't be fetched — same posture as the HolaApp
 * catalog. */
export async function listMcpCatalog(): Promise<McpCatalogEntry[]> {
  const installed = new Set(readInstalledMcpIds());
  try {
    const base = await backendBaseUrl();
    if (!base) {
      console.warn("[mcp-marketplace] no backend base URL — empty catalog");
      return [];
    }
    const resp = await bffFetch(`${base}/gateway/wapp/mcp-catalog`);
    if (!resp.ok) {
      console.warn(
        `[mcp-marketplace] GET /gateway/wapp/mcp-catalog → ${resp.status}; empty catalog`,
      );
      return [];
    }
    const data = (await resp.json()) as { mcps?: unknown };
    const mcps = Array.isArray(data.mcps)
      ? data.mcps
          .map(normalizeMcpEntry)
          .filter((entry): entry is McpCatalogEntry => entry !== null)
      : [];
    return mcps.map((entry) => ({ ...entry, installed: installed.has(entry.id) }));
  } catch (err) {
    console.warn("[mcp-marketplace] catalog fetch failed; empty catalog", err);
    return [];
  }
}

// ── install / uninstall / sync (LOCAL — never hits the gateway) ───────────────

/** Split a server's stored key values by their declared `target` so main can apply each
 * to the right place on the workspace.yaml server entry. */
export function buildAttachInput(
  entry: McpCatalogEntry,
  values: Record<string, string>,
  ownerAppId?: string,
): McpAttachInput {
  const headerKeys: Record<string, string> = {};
  const queryKeys: Record<string, string> = {};
  const envKeys: Record<string, string> = {};
  for (const key of entry.requiredKeys) {
    const value = values[key.name];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    if (key.target === "header") {
      headerKeys[key.name] = value;
    } else if (key.target === "query") {
      queryKeys[key.name] = value;
    } else {
      envKeys[key.name] = value;
    }
  }
  return {
    id: entry.id,
    mcpUrl: entry.mcpUrl,
    holabossHosted: entry.holabossHosted,
    headerKeys,
    queryKeys,
    envKeys,
    tools: (entry.tools ?? []).map((tool) => tool.name),
    ...(ownerAppId ? { ownerAppId } : {}),
  };
}

/** Build a synthetic `McpCatalogEntry` from a HolaApp's `hostedMcpInstall` block
 * so the shared MCP install gate (McpInstallDialog) + attach machinery can
 * install an APP's Holaboss-hosted, BYO-credential MCP. The app id is the server
 * id; `installMcp(entry, values, app.holaAppId)` then tags it app-owned so it
 * lands in `app_servers` (grouped under its app), not the standalone pool. */
export function hostedMcpInstallToEntry(app: {
  holaAppId: string;
  title: string;
  iconUrl?: string;
  hostedMcpInstall: {
    mcpUrl: string;
    holabossHosted?: boolean;
    requiredKeys: McpRequiredKey[];
    tools?: McpTool[];
  };
}): McpCatalogEntry {
  return {
    id: app.holaAppId,
    name: app.title,
    mcpUrl: app.hostedMcpInstall.mcpUrl,
    holabossHosted: app.hostedMcpInstall.holabossHosted !== false,
    requiredKeys: app.hostedMcpInstall.requiredKeys,
    comingSoon: false,
    // A HolaApp's own hosted MCP is Holaboss-official — no consent prompt.
    verified: true,
    installed: false,
    ...(app.iconUrl ? { iconUrl: app.iconUrl } : {}),
    ...(app.hostedMcpInstall.tools ? { tools: app.hostedMcpInstall.tools } : {}),
  };
}

/** Install an MCP server: persist its credentials LOCALLY, then hand the resolved config
 * to main to attach it to the agent's workspace.yaml. Keys never leave the machine. */
export async function installMcp(
  entry: McpCatalogEntry,
  values: Record<string, string>,
  ownerAppId?: string,
): Promise<void> {
  writeMcpKeys(entry.id, values);
  markMcpInstalled(entry.id);
  await window.electronAPI.mcpMarketplace?.install(
    buildAttachInput(entry, values, ownerAppId),
  );
}

/** Attach a HolaApp's hosted MCP (`hostedMcpInstall`) as APP-OWNED: persist its
 * creds locally (for a future re-attach) and attach it to workspace.yaml's
 * `app_servers` (owner_app_id) via a DEDICATED IPC. This bypasses the marketplace
 * install/sync set on purpose — that set is reconciled against the MCP catalog,
 * which an app MCP is never in, so `installMcp` would attach then instantly
 * detach it. Torn down with the app on uninstall (detach clears app_servers). */
export async function attachAppOwnedMcp(
  entry: McpCatalogEntry,
  values: Record<string, string>,
  ownerAppId: string,
): Promise<void> {
  writeMcpKeys(entry.id, values);
  await window.electronAPI.mcpMarketplace?.attachAppOwned({
    ...buildAttachInput(entry, values, ownerAppId),
    ownerAppId,
  });
}

/** Uninstall an MCP server: detach it from workspace.yaml and forget its local keys. */
export async function uninstallMcp(id: string): Promise<void> {
  markMcpUninstalled(id);
  clearMcpKeys(id);
  await window.electronAPI.mcpMarketplace?.uninstall(id);
}

/** Re-apply every installed MCP server to main from local state (on catalog load / app
 * restart), so main can hold the resolved configs and refresh the Holaboss session bearer
 * per turn — mirroring holaApps:sync. */
export async function syncInstalledMcps(catalog: McpCatalogEntry[]): Promise<void> {
  const configs = catalog
    .filter((entry) => entry.installed)
    .map((entry) => buildAttachInput(entry, readMcpKeys(entry.id)));
  await window.electronAPI.mcpMarketplace?.sync(configs);
}

/** Re-apply every installed APP-OWNED hosted MCP (a HolaApp's `hostedMcpInstall`,
 * e.g. jianguoyun) to main from local state, so main holds the resolved configs and
 * refreshes the Holaboss session bearer per turn — the app-owned twin of
 * `syncInstalledMcps`, kept on its OWN track (never catalog-reconciled, so it can't
 * be detached by the standalone marketplace sync). Torn down with the app on uninstall. */
export async function syncInstalledAppHostedMcps(
  apps: {
    holaAppId: string;
    title: string;
    iconUrl?: string;
    installed: boolean;
    hostedMcpInstall?: {
      mcpUrl: string;
      holabossHosted?: boolean;
      requiredKeys: McpRequiredKey[];
      tools?: McpTool[];
    };
  }[],
): Promise<void> {
  const configs = apps.flatMap((app) => {
    if (!(app.installed && app.hostedMcpInstall)) {
      return [];
    }
    const values = readMcpKeys(app.holaAppId);
    // Skip a gate that never completed: attaching a required-key server without
    // its creds would just fail (and churn the attach). Bearer-only servers
    // (no required keys) always qualify.
    const missingKey = app.hostedMcpInstall.requiredKeys.some(
      (key) => !values[key.name],
    );
    if (missingKey) {
      return [];
    }
    const entry = hostedMcpInstallToEntry({
      holaAppId: app.holaAppId,
      title: app.title,
      ...(app.iconUrl ? { iconUrl: app.iconUrl } : {}),
      hostedMcpInstall: app.hostedMcpInstall,
    });
    return [{ ...buildAttachInput(entry, values, app.holaAppId), ownerAppId: app.holaAppId }];
  });
  await window.electronAPI.mcpMarketplace?.syncAppOwned(configs);
}
