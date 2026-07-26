// Pre-flight for an uploaded SKILL.md, so an obviously unusable file is caught
// before the bytes make a round trip. The runtime owns the real parse — it also
// slugifies the id and maps foreign frontmatter — so this only answers "would
// the agent ever be able to pick this up?".
//
// `name` and `description` are what the agent reads to decide when to run a
// skill; without them the skill installs and is never chosen.
export type SkillMarkdownCheck = { ok: true } | { ok: false; error: string };

export function parseSkillMarkdown(
  content: string,
  _fileName: string,
): SkillMarkdownCheck {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content.replace(/\r\n/g, "\n"));
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
  if (!(read("name") || read("title"))) {
    return { ok: false, error: "The frontmatter is missing a `name`." };
  }
  if (!(read("description") || read("summary"))) {
    return { ok: false, error: "The frontmatter is missing a `description`." };
  }
  return { ok: true };
}
