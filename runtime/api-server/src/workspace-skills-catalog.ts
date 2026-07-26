import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

export type SkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
};

function parseFrontmatter(markdown: string): { name: string; description: string } {
  if (!markdown.startsWith("---")) {
    return { name: "", description: "" };
  }
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) {
    return { name: "", description: "" };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(markdown.slice(3, end));
  } catch {
    return { name: "", description: "" };
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return { name, description };
}

/**
 * Materialize a skill's SKILL.md body into the workspace's skills/ dir so the
 * harness picks it up. Idempotent (overwrites). The body is resolved upstream
 * from the marketplace registry (the single source of truth) and passed in by
 * the caller — there is no embedded catalog anymore.
 */
export function materializeSkill(params: {
  workspaceDir: string;
  skillId: string;
  content: string;
}): SkillCatalogEntry {
  const skillDir = path.join(params.workspaceDir, "skills", params.skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), params.content, "utf8");
  const { name, description } = parseFrontmatter(params.content);
  return { id: params.skillId, name: name || params.skillId, description };
}
