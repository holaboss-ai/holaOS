import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

export const COMPOSIO_REGISTRY_SERVER_ID = "holaboss_composio";

const LEGACY_COMPOSIO_SERVER_IDS = ["holaboss-composio"];

export interface ComposioMcpToolEntry {
  name: string;
  description: string;
  toolkit_slug: string;
  tool_slug: string;
  connected_account_id: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function removeComposioMcpRegistryEntry(workspaceDir: string): void {
  const yamlPath = path.join(workspaceDir, "workspace.yaml");
  if (!fs.existsSync(yamlPath)) {
    return;
  }
  const raw = fs.readFileSync(yamlPath, "utf8");
  const data = (yaml.load(raw) as Record<string, unknown> | undefined) ?? {};
  const registry = data.mcp_registry as Record<string, unknown> | undefined;
  if (!registry) {
    return;
  }
  const servers = registry.servers as Record<string, unknown> | undefined;
  if (servers) {
    delete servers[COMPOSIO_REGISTRY_SERVER_ID];
    for (const legacyId of LEGACY_COMPOSIO_SERVER_IDS) {
      delete servers[legacyId];
    }
    registry.servers = servers;
  }
  const allowlist = registry.allowlist as Record<string, unknown> | undefined;
  if (allowlist && Array.isArray(allowlist.tool_ids)) {
    const prefixes = [
      `${COMPOSIO_REGISTRY_SERVER_ID}.`,
      ...LEGACY_COMPOSIO_SERVER_IDS.map((id) => `${id}.`),
    ];
    allowlist.tool_ids = (allowlist.tool_ids as unknown[]).filter(
      (id): id is string =>
        typeof id === "string" && !prefixes.some((prefix) => id.startsWith(prefix)),
    );
    registry.allowlist = allowlist;
  }
  data.mcp_registry = registry;
  fs.writeFileSync(yamlPath, yaml.dump(data), "utf8");
}

export function hasHeroEntry(_toolkitSlug: string): boolean {
  return true;
}

export function toolkitNameFromSlug(slug: string): string {
  return slug;
}

export type ComposioUpstreamTool = {
  slug: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  read_only: boolean;
};

// Preloaded common set; read/write quotas so writes aren't starved. The long
// tail is reached via the composio_search_tools meta-tool.
const PRELOAD_TOTAL = 24;
const PRELOAD_READ_QUOTA = 14;

const READ_PREFIXES = [
  "FETCH_",
  "GET_",
  "LIST_",
  "READ_",
  "SEARCH_",
];

function isReadTool(slug: string): boolean {
  const upper = slug.toUpperCase();
  return READ_PREFIXES.some((prefix) => upper.includes(prefix));
}

function selectBalanced(
  upstream: ComposioUpstreamTool[],
  total: number,
  readQuota: number,
): ComposioUpstreamTool[] {
  const reads = upstream.filter((tool) => isReadTool(tool.slug));
  const writes = upstream.filter((tool) => !isReadTool(tool.slug));
  const writeQuota = total - readQuota;
  const picked = [...reads.slice(0, readQuota), ...writes.slice(0, writeQuota)];
  if (picked.length < total) {
    const pickedSlugs = new Set(picked.map((tool) => tool.slug));
    for (const tool of upstream) {
      if (picked.length >= total) break;
      if (!pickedSlugs.has(tool.slug)) picked.push(tool);
    }
  }
  return picked;
}

export function buildToolkitCatalogFromUpstream(
  toolkitSlug: string,
  connectedAccountId: string,
  upstream: ComposioUpstreamTool[],
  options: { total?: number; readQuota?: number } = {},
): ComposioMcpToolEntry[] {
  const total = options.total ?? PRELOAD_TOTAL;
  const readQuota = options.readQuota ?? PRELOAD_READ_QUOTA;
  const ranked = selectBalanced(upstream, total, readQuota);

  return ranked.map((tool) => ({
    name: `${toolkitSlug}_${tool.slug.replace(new RegExp(`^${toolkitSlug.toUpperCase()}_`), "").toLowerCase()}`,
    description: tool.description,
    toolkit_slug: toolkitSlug,
    tool_slug: tool.slug,
    connected_account_id: connectedAccountId,
    input_schema: tool.input_schema,
    annotations: tool.read_only ? { readOnlyHint: true } : undefined,
  }));
}
