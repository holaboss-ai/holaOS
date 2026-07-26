/** Persist a skill's store/catalog display name into its SKILL.md frontmatter as
 *  `title:`, so file-based readers (the composer's "/" list) show the same name
 *  the store used instead of re-deriving one from the document's H1 heading. */
export function withSkillDisplayTitle(
  markdown: string,
  displayName: string,
): string {
  const title = displayName.trim();
  if (!title) {
    return markdown;
  }
  const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const line = `title: "${escaped}"`;
  const normalized = markdown.replace(/\r\n/g, "\n");
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) {
    return `---\n${line}\n---\n\n${normalized.replace(/^\n+/, "")}`;
  }
  const yaml = frontmatter[1];
  const rest = normalized.slice(frontmatter[0].length);
  const nextYaml = /^title:[ \t]*.*$/m.test(yaml)
    ? yaml.replace(/^title:[ \t]*.*$/m, line)
    : `${line}\n${yaml}`;
  return `---\n${nextYaml}\n---${rest}`;
}
