/**
 * Path helpers for resolving links inside workspace previews.
 *
 * Renderer-side: we don't have access to Node's `path` module, and our
 * absolute paths can be either POSIX or Windows. These mini-helpers stay
 * narrow on purpose — anything fancier should go through the main
 * process via `window.electronAPI.fs.*`.
 */

export function isAbsolutePath(targetPath: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/)/.test(targetPath.trim());
}

export function dirnameFromAbsolutePath(absolutePath: string): string {
  const trimmed = absolutePath.trim();
  if (!trimmed) {
    return "";
  }
  const sep = trimmed.includes("\\") ? "\\" : "/";
  const idx = trimmed.lastIndexOf(sep);
  if (idx <= 0) {
    return sep;
  }
  return trimmed.slice(0, idx);
}

export function joinPath(base: string, relative: string): string {
  if (!base) {
    return relative;
  }
  if (!relative) {
    return base;
  }
  const sep = base.includes("\\") ? "\\" : "/";
  const trimmedBase = base.replace(/[\\/]+$/, "");
  const trimmedRel = relative.replace(/^[\\/]+/, "");
  return `${trimmedBase}${sep}${trimmedRel}`;
}

/**
 * Resolve an `<a href>` value emitted by a workspace preview (HTML iframe,
 * Tiptap markdown, etc.) to an absolute filesystem path. Returns null when
 * the href can't be meaningfully resolved (empty, no base directory).
 */
export function resolveLocalHrefToAbsolutePath(
  href: string,
  sourceAbsolutePath: string | null | undefined,
  fallbackBaseDir?: string | null,
): string | null {
  let raw = href.trim();
  if (!raw) {
    return null;
  }
  if (raw.toLowerCase().startsWith("file://")) {
    raw = raw.slice(7);
  }
  let cleaned = raw;
  try {
    cleaned = decodeURI(raw);
  } catch {
    cleaned = raw;
  }
  if (isAbsolutePath(cleaned)) {
    return cleaned;
  }
  const baseDir = sourceAbsolutePath?.trim()
    ? dirnameFromAbsolutePath(sourceAbsolutePath.trim())
    : (fallbackBaseDir?.trim() ?? "");
  if (!baseDir) {
    return null;
  }
  return joinPath(baseDir, cleaned);
}
