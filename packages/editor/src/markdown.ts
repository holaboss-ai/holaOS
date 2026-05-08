// Markdown helpers used by MarkdownEditor before content is fed to Tiptap.

/**
 * Collapse blank lines that sit BETWEEN consecutive pipe-table rows.
 *
 * GFM requires table rows to be on consecutive lines — a blank line
 * terminates the table and turns every following row into a literal
 * paragraph beginning with `|`. Some authors (especially LLMs) produce
 * tables with a blank line between every row; without intervention,
 * marked tokenises every row as its own `paragraph` and the editor
 * shows raw `|` characters instead of a grid.
 *
 * Heuristic: if a blank line is sandwiched between two lines that both
 * start with `|` and end with `|` (after trim), drop the blank. We do
 * NOT touch blanks adjacent to non-table content — those are real
 * paragraph separators.
 *
 * Idempotent. Round-trip safe (running it on already-tight markdown is
 * a no-op).
 */
export function tightenMarkdownTables(md: string): string {
  if (!md.includes("|")) return md;
  const lines = md.split("\n");
  const out: string[] = [];

  const isPipeRow = (line: string): boolean => {
    const t = line.trim();
    return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" && out.length > 0) {
      const prev = out[out.length - 1];
      // peek past any further blanks to find the next non-blank line
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const nextNonBlank = j < lines.length ? lines[j] : "";
      if (isPipeRow(prev) && isPipeRow(nextNonBlank)) {
        // skip this blank — keeps the table contiguous
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}
