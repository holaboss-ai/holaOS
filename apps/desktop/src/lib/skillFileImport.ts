// Parsing for an uploaded SKILL.md. Kept out of the dialog so it can be
// tested without pulling the icon bundle into a node test.

/** What a SKILL.md has to declare before it can be installed. */
export interface ParsedSkillFile {
  skillId: string;
  name: string;
  description: string;
  content: string;
}

const SKILL_ID_FALLBACK = "skill";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// A name of only punctuation ("…") slugifies to nothing, so fall through to the
// filename rather than jumping straight to the generic fallback.
function slugifySkillId(name: string, fileName: string): string {
  return (
    slugify(name) ||
    slugify(fileName.replace(/\.[^.]+$/, "")) ||
    SKILL_ID_FALLBACK
  );
}

/**
 * Read a SKILL.md's YAML frontmatter. `name` and `description` are the contract
 * the agent reads to decide when to run a skill, so a file without them is
 * rejected here rather than installed as something the agent can never pick.
 */
export function parseSkillMarkdown(
  content: string,
  fileName: string,
): { ok: true; skill: ParsedSkillFile } | { ok: false; error: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(normalized);
  if (!frontmatter) {
    return {
      ok: false,
      error: "That file has no YAML frontmatter block at the top.",
    };
  }
  const block = frontmatter[1] ?? "";
  const read = (key: string): string => {
    const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(block);
    return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  };
  const name = read("name") || read("title");
  const description = read("description") || read("summary");
  if (!name) {
    return { ok: false, error: "The frontmatter is missing a `name`." };
  }
  if (!description) {
    return { ok: false, error: "The frontmatter is missing a `description`." };
  }
  return {
    ok: true,
    skill: {
      skillId: slugifySkillId(name, fileName),
      name,
      description,
      content: normalized,
    },
  };
}
