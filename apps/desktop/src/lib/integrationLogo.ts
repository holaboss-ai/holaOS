/**
 * Provider logo resolution + stable rendering rules.
 *
 * The Composio CDN at https://logos.composio.dev/api/{slug} is the default
 * source. Some toolkits ship broken assets (white-on-white fills, wrong
 * aspect ratio) — recent override fixes (bd82591c, GitHub + Linear) had to
 * patch this case-by-case. This module centralises the rule so future
 * "the logo looks wrong" reports have one place to fix.
 *
 * Strategy:
 *   1. CDN URL is the default.
 *   2. KNOWN_BROKEN slugs return null — caller falls back to the Plug
 *      icon (or any provided fallback node), avoiding the broken render.
 *   3. Future: add a `bundled/` subdirectory of static SVGs and wire them
 *      in here. Asset files are out of scope for this commit — the
 *      interface is what we want to stabilise.
 */

const CDN_BASE = "https://logos.composio.dev/api";

// Slugs where the CDN asset is known to be broken or low-quality. Render
// the Plug fallback instead of the broken image.
const KNOWN_BROKEN_LOGO_SLUGS = new Set<string>([
  // intentionally empty — fill in as production reports come in. Existing
  // overrides (e.g. GitHub white-on-white at bd82591c) are handled
  // separately in the receiving components today; we'll migrate them here.
]);

export interface IntegrationLogoSource {
  url: string | null;
  /** True when the URL is a known-good local asset. False when it's a
   *  best-effort CDN URL that might fail. */
  isLocal: boolean;
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function getIntegrationLogo(slug: string): IntegrationLogoSource {
  const key = normalizeSlug(slug);
  if (!key) return { url: null, isLocal: false };
  if (KNOWN_BROKEN_LOGO_SLUGS.has(key)) {
    return { url: null, isLocal: false };
  }
  return { url: `${CDN_BASE}/${key}`, isLocal: false };
}

/**
 * Compatibility shim for older callers that only expect a concrete
 * brand-specific override URL and otherwise fall back to toolkit/CDN logos.
 */
export function brandLogoOverride(slug: string): string | null {
  const { url, isLocal } = getIntegrationLogo(slug);
  return isLocal ? url : null;
}
