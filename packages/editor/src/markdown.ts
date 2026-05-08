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
 * paragraph separators. We also skip the entire heuristic inside
 * fenced code blocks (``` or ~~~), where pipe-shaped lines are literal
 * code, not table rows.
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

  // Match a CommonMark fenced code block boundary. Returns the fence
  // char and length, plus whether an info string follows (only legal on
  // an *opener*, never on a closer). `null` when the line is not a
  // fence boundary at all. Up to 3 leading spaces are tolerated per
  // spec.
  const fenceMatch = (
    line: string,
  ): { char: "`" | "~"; len: number; hasInfo: boolean } | null => {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!m) return null;
    return {
      char: m[1][0] as "`" | "~",
      len: m[1].length,
      hasInfo: m[2].trim().length > 0,
    };
  };

  let inFence = false;
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = fenceMatch(line);

    if (!inFence && fm) {
      // Opening fence — info string is allowed.
      inFence = true;
      fenceChar = fm.char;
      fenceLen = fm.len;
      out.push(line);
      continue;
    }

    if (
      inFence &&
      fm &&
      fm.char === fenceChar &&
      fm.len >= fenceLen &&
      !fm.hasInfo
    ) {
      // Closing fence — same character, ≥ opener length, no info string.
      inFence = false;
      fenceChar = null;
      fenceLen = 0;
      out.push(line);
      continue;
    }

    if (inFence) {
      // Verbatim — pipe-shaped literals inside a code block must not be
      // touched.
      out.push(line);
      continue;
    }

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
