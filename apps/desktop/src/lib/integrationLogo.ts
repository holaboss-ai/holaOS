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

// Composio's logo CDN returns wide wordmark SVGs (and sometimes a pure
// white fill) for a handful of providers, so the square thumbnails render
// as a sliver-in-a-banner or invisibly white-on-white. Simple Icons
// publishes a square monochrome SVG per brand at a stable unpkg URL —
// short-circuit just those slugs.
const BRAND_LOGO_OVERRIDES: Record<string, string> = {
  github: "https://unpkg.com/simple-icons@16.20.0/icons/github.svg",
  linear: "https://unpkg.com/simple-icons@16.20.0/icons/linear.svg",
};

// Slugs where the CDN asset is known to be broken or low-quality and no
// override is provided. Render the Plug fallback instead of the broken
// image.
const KNOWN_BROKEN_LOGO_SLUGS = new Set<string>([]);

export interface IntegrationLogoSource {
  url: string | null;
  /** True when the URL is a known-good local asset. False when it's a
   *  best-effort CDN URL that might fail. */
  isLocal: boolean;
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function brandLogoOverride(slug: string): string | null {
  const key = normalizeSlug(slug);
  if (!key) return null;
  return BRAND_LOGO_OVERRIDES[key] ?? null;
}

export function getIntegrationLogo(slug: string): IntegrationLogoSource {
  const key = normalizeSlug(slug);
  if (!key) return { url: null, isLocal: false };
  const override = BRAND_LOGO_OVERRIDES[key];
  if (override) {
    return { url: override, isLocal: false };
  }
  if (KNOWN_BROKEN_LOGO_SLUGS.has(key)) {
    return { url: null, isLocal: false };
  }
  return { url: `${CDN_BASE}/${key}`, isLocal: false };
}
