// The user's org-scoped skill library — the backend marketplace's per-org install store
// (Supabase `workspace_skills`), SHARED with the web employee platform. We LIST it here
// (so a skill added on web shows up on desktop) and materialize entries locally on install
// so the desktop agent can run them; IMPORT (URL) writes to the same backend store.
//
// Reaches the marketplace BFF through the app-sdk client (main injects the Better-Auth
// cookie). Org scoping is applied by the BFF's active-org header; the `principal` (the
// user id) is the path param, matching how the web platform scopes the same store.

import {
  installImportedMarketplaceSkill,
  listWorkspaceMarketplaceSkills,
} from "@holaboss/app-sdk";
import { getMarketplaceAppSdkClient } from "@/lib/app-sdk-client";

export interface OrgSkill {
  /** The skill_id — also the local materialized folder name. */
  id: string;
  name: string;
  description: string;
  /** Full SKILL.md body — used to materialize the skill locally on install. */
  content: string;
  sourceUrl: string | null;
}

// Best-effort name/description from a SKILL.md's YAML frontmatter.
function metaFromContent(
  content: string,
  fallbackId: string,
): { name: string; description: string } {
  const fm = /^---\s*([\s\S]*?)\s*---/.exec(content);
  const block = fm?.[1] ?? "";
  const grab = (key: string): string => {
    const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(block);
    return m?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  };
  return {
    name: grab("name") || grab("title") || fallbackId,
    description: grab("description") || grab("summary"),
  };
}

/** The org library (only rows that carry a body, so they can be materialized locally). */
export async function listOrgSkills(principal: string): Promise<OrgSkill[]> {
  const client = getMarketplaceAppSdkClient();
  const data = await listWorkspaceMarketplaceSkills(principal, { client });
  const rows = data?.skills ?? [];
  const out: OrgSkill[] = [];
  for (const r of rows) {
    if (typeof r.content !== "string" || r.content.length === 0) {
      continue;
    }
    out.push({
      id: r.skill_id,
      ...metaFromContent(r.content, r.skill_id),
      content: r.content,
      sourceUrl: r.source_url ?? null,
    });
  }
  return out;
}

/** Import a SKILL.md URL into the org store; returns the created skill (with its body). */
export async function importOrgSkillFromUrl(
  principal: string,
  url: string,
): Promise<OrgSkill> {
  const client = getMarketplaceAppSdkClient();
  const rec = await installImportedMarketplaceSkill(
    { workspace_id: principal, url },
    { client },
  );
  const content = typeof rec.content === "string" ? rec.content : "";
  const meta = metaFromContent(content, rec.skill_id);
  return {
    id: rec.skill_id,
    name: rec.imported_name || meta.name,
    description: rec.imported_description || meta.description,
    content,
    sourceUrl: rec.source_url ?? null,
  };
}
