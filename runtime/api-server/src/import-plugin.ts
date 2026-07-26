import fs from "node:fs";
import path from "node:path";

import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

import {
  type CapabilityInstallResult,
  type CapabilitySkillRef,
  installCapability,
  loadCapabilityCatalog,
} from "./workspace-capabilities.js";

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "imported-capability"
  );
}

/**
 * Import a Claude / Codex plugin directory as a capability. The plugin's value
 * is its skills; we materialize them via the normal path-skill install (a
 * `path:` ref with `sourceDir = pluginPath` makes installCapability copy each
 * SKILL.md into the workspace). MCP/connector wiring is left to the user.
 */
export async function importPluginAsCapability(params: {
  store: RuntimeStateStore;
  workspaceId: string;
  workspaceDir: string;
  pluginPath: string;
}): Promise<CapabilityInstallResult> {
  const pluginPath = path.resolve(params.pluginPath.trim());
  if (!fs.existsSync(pluginPath)) {
    throw new Error(`plugin path not found: ${pluginPath}`);
  }

  const manifestPath = [
    path.join(pluginPath, ".claude-plugin", "plugin.json"),
    path.join(pluginPath, ".codex-plugin", "plugin.json"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!manifestPath) {
    throw new Error(
      `no plugin manifest under ${pluginPath} (expected .claude-plugin/ or .codex-plugin/plugin.json)`,
    );
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid plugin.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  const displayName = typeof manifest.displayName === "string" ? manifest.displayName.trim() : "";
  const name = displayName || (typeof manifest.name === "string" ? manifest.name.trim() : "");
  if (!name) {
    throw new Error("plugin.json declares no name");
  }
  const description = typeof manifest.description === "string" ? manifest.description.trim() : "";

  const skills: CapabilitySkillRef[] = [];
  const skillsDir = path.join(pluginPath, "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) {
        skills.push({ path: path.join("skills", entry.name, "SKILL.md") });
      }
    }
  }

  const taken = new Set([
    ...loadCapabilityCatalog().map((entry) => entry.id),
    ...params.store
      .listWorkspaceCapabilities({ workspaceId: params.workspaceId })
      .map((record) => record.capabilityId),
  ]);
  const baseId = slugify(name);
  let id = baseId;
  for (let n = 2; taken.has(id); n += 1) {
    id = `${baseId}-${n}`;
  }

  return await installCapability({
    store: params.store,
    workspaceId: params.workspaceId,
    workspaceDir: params.workspaceDir,
    capability: {
      id,
      name,
      description: description || name,
      skills,
      integrations: [],
      sourceDir: pluginPath,
    },
  });
}
