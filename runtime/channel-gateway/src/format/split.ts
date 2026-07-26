export type LengthUnit = "codepoints" | "utf16";

/** Measure text length in the platform's unit (Telegram counts UTF-16 code units). */
export function measure(text: string, unit: LengthUnit): number {
  return unit === "utf16" ? text.length : [...text].length;
}

/**
 * Largest UTF-16 prefix index of `text` whose measured length is <= `limit`,
 * without splitting a surrogate pair.
 */
function maxPrefixIndex(text: string, limit: number, unit: LengthUnit): number {
  if (unit === "utf16") {
    let idx = Math.min(text.length, limit);
    if (idx > 0 && idx < text.length) {
      const code = text.charCodeAt(idx - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        idx -= 1; // would split a surrogate pair — back off one unit
      }
    }
    return idx;
  }
  let count = 0;
  let idx = 0;
  for (const ch of text) {
    if (count + 1 > limit) break;
    count += 1;
    idx += ch.length;
  }
  return idx;
}

/**
 * Prefer to break at a paragraph (\n\n) > line (\n) > space boundary within
 * [floor(upper/2), upper]; otherwise hard-cut at `upper`. Ports the prior-art
 * `_find_split_boundary` from the removed Telegram connector.
 */
function findBoundary(text: string, upper: number): number {
  if (upper >= text.length) return text.length;
  const lower = Math.max(1, Math.floor(upper / 2));
  for (const separator of ["\n\n", "\n", " "]) {
    const position = text.lastIndexOf(separator, upper - 1);
    if (position >= lower) return position + separator.length;
  }
  return upper;
}

/**
 * Split `text` into chunks each within `limit` (measured in `unit`), breaking at
 * natural boundaries where possible and never mid-surrogate. A single over-limit
 * line with no break point is hard-cut. Returns `[text]` unchanged when it fits.
 */
export function splitMessage(
  text: string,
  limit: number,
  unit: LengthUnit = "codepoints",
): string[] {
  if (limit <= 0 || measure(text, unit) <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (measure(rest, unit) > limit) {
    const upper = maxPrefixIndex(rest, limit, unit);
    const boundary = Math.max(1, findBoundary(rest, upper)); // guarantee progress
    parts.push(rest.slice(0, boundary));
    rest = rest.slice(boundary);
  }
  if (rest.length > 0) parts.push(rest);
  return parts.filter((part) => part.length > 0);
}
