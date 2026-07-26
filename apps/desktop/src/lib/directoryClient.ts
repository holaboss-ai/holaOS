/**
 * Central directory catalog client — fetches the curated capability/skill
 * catalog from the Hono backend (`/api/directory/*`) through the bff:fetch
 * bridge (main injects the Better-Auth cookie).
 *
 * Skills are sourced live from the marketplace registry (the single source of
 * truth) via the gateway — there is no local runtime fallback for skills.
 * `fetchDirectorySkillBody` resolves a skill's full SKILL.md body so the
 * runtime can materialize it into the workspace on "Add".
 */
import { bffFetch } from "./bff-fetch-bridge";

/** A required credential a bundled MCP declares (what to ask for, never the
 * secret). Mirrors the backend McpRequiredKey. */
export type DirectoryMcpRequiredKeyDto = {
  name: string;
  label: string;
  help?: string;
  secret?: boolean;
  target: "header" | "query" | "env";
};

/** A capability's bundled MCP server, resolved from the catalog at serve time
 * (keyless ones attach on install; keyed ones need a connect-gate where the
 * user supplies `requiredKeys`). */
export type DirectoryCapabilityMcpDto = {
  id: string;
  name: string;
  url: string;
  tools: string[];
  requiresKeys: boolean;
  requiredKeys: DirectoryMcpRequiredKeyDto[];
  required: boolean;
  reason: string | null;
};

export type DirectoryCapabilityDto = {
  id: string;
  name: string;
  description: string;
  icon?: string;
  category?: string;
  skills: string[];
  integrations: string[];
  mcps?: DirectoryCapabilityMcpDto[];
};

export type DirectorySkillDto = {
  id: string;
  name: string;
  description: string;
  category?: string;
  /** Phosphor glyph name (ph:*-fill) from the backend skill_catalog. */
  icon?: string;
  /** Curated in the backend skill_catalog — drives the Recommended shelf. */
  featured?: boolean;
};

let cachedApiBaseUrl: string | null = null;

async function apiBaseUrl(): Promise<string> {
  if (cachedApiBaseUrl == null) {
    cachedApiBaseUrl = (await window.electronAPI.auth.getApiBaseUrl()) ?? "";
  }
  return cachedApiBaseUrl;
}

async function getDirectoryJson<T>(path: string): Promise<T> {
  const base = await apiBaseUrl();
  if (!base) {
    throw new Error("Directory API base URL is not configured.");
  }
  const response = await bffFetch(`${base.replace(/\/+$/u, "")}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Directory request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchDirectoryCapabilities(): Promise<{
  capabilities: DirectoryCapabilityDto[];
}> {
  return getDirectoryJson("/api/directory/capabilities");
}

export function fetchDirectorySkills(): Promise<{ skills: DirectorySkillDto[] }> {
  return getDirectoryJson("/api/directory/skills");
}

export type DirectorySkillBodyDto = {
  id: string;
  name: string;
  body: string;
};

export function fetchDirectorySkillBody(
  skillId: string,
): Promise<DirectorySkillBodyDto> {
  return getDirectoryJson(
    `/api/directory/skills/${encodeURIComponent(skillId)}`,
  );
}
