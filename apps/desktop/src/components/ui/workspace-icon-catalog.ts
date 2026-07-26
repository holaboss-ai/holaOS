import { addCollection } from "@iconify/react";
import phCollection from "@iconify-json/ph/icons.json";

// Idempotent registration of the Phosphor icon collection. addCollection
// is a no-op when the prefix is already loaded so duplicate evaluation
// across HMR / re-imports is safe.
addCollection(phCollection as Parameters<typeof addCollection>[0]);

/**
 * WORKSPACE_ICONS — curated Phosphor Fill subset usable as a workspace
 * identity glyph. Keys are human-readable PascalCase names (preserved
 * across the hugeicons → Phosphor migration so stored values like
 * `"Star"` continue to round-trip cleanly); values are Iconify icon
 * strings rendered by `<IconifyIcon icon={...} />`. Unknown stored
 * values fall back to a deterministic pick keyed by workspace id (see
 * deterministicIconKey).
 *
 * Phosphor's `-fill` variants give the gallery a solid, glyph-forward
 * look that pairs with the workspace color tint — every chip ends up
 * carrying both a shape *and* a color, so workspaces stay
 * distinguishable at a glance even in a long sidebar.
 */
export const WORKSPACE_ICONS = {
  Star: "ph:star-fill",
  Sparkles: "ph:sparkle-fill",
  Crown: "ph:crown-fill",
  Trophy: "ph:trophy-fill",
  Heart: "ph:heart-fill",
  Gift: "ph:gift-fill",
  Flag: "ph:flag-fill",
  Bookmark: "ph:bookmark-fill",
  Rocket: "ph:rocket-fill",
  Zap: "ph:lightning-fill",
  Flame: "ph:fire-fill",
  Lightbulb: "ph:lightbulb-fill",
  Compass: "ph:compass-fill",
  Anchor: "ph:anchor-fill",
  Globe: "ph:globe-fill",
  Map: "ph:map-pin-fill",
  Telescope: "ph:microscope-fill",
  Atom: "ph:atom-fill",
  Beaker: "ph:test-tube-fill",
  FlaskConical: "ph:flask-fill",
  Palette: "ph:palette-fill",
  Paintbrush: "ph:paint-brush-fill",
  Wand2: "ph:magic-wand-fill",
  Music2: "ph:music-notes-fill",
  Bird: "ph:bird-fill",
  Feather: "ph:feather-fill",
  Flower2: "ph:flower-fill",
  Leaf: "ph:leaf-fill",
  TreePine: "ph:tree-fill",
  Mountain: "ph:mountains-fill",
  Waves: "ph:wave-sine-fill",
  Sun: "ph:sun-fill",
  Moon: "ph:moon-fill",
  Cloud: "ph:cloud-fill",
  Snowflake: "ph:snowflake-fill",
  Umbrella: "ph:umbrella-fill",
  Hammer: "ph:hammer-fill",
  Boxes: "ph:cube-fill",
  Layers: "ph:stack-fill",
  Puzzle: "ph:puzzle-piece-fill",
  Shapes: "ph:shapes-fill",
  Diamond: "ph:diamond-fill",
  Gem: "ph:diamond-fill",
  Hexagon: "ph:hexagon-fill",
  Triangle: "ph:triangle-fill",
  Origami: "ph:paper-plane-fill",
  Workflow: "ph:tree-structure-fill",
} satisfies Record<string, string>;

export type WorkspaceIconKey = keyof typeof WORKSPACE_ICONS;

export const WORKSPACE_ICON_KEYS = Object.keys(WORKSPACE_ICONS) as WorkspaceIconKey[];

export interface WorkspaceIconColor {
  /** CSS background tint for the icon chip. */
  bg: string;
  /** CSS foreground (glyph) color. */
  fg: string;
}

/**
 * WORKSPACE_ICON_COLORS — palette of tints applied to the icon chip. Each
 * key maps to a pair of CSS variables defined in `styles/tokens.css`,
 * derived via color-mix so the same tokens adapt across light and dark
 * mode without a separate override.
 */
export const WORKSPACE_ICON_COLORS = {
  gray: { bg: "var(--workspace-color-gray-bg)", fg: "var(--workspace-color-gray-fg)" },
  red: { bg: "var(--workspace-color-red-bg)", fg: "var(--workspace-color-red-fg)" },
  orange: { bg: "var(--workspace-color-orange-bg)", fg: "var(--workspace-color-orange-fg)" },
  amber: { bg: "var(--workspace-color-amber-bg)", fg: "var(--workspace-color-amber-fg)" },
  emerald: { bg: "var(--workspace-color-emerald-bg)", fg: "var(--workspace-color-emerald-fg)" },
  teal: { bg: "var(--workspace-color-teal-bg)", fg: "var(--workspace-color-teal-fg)" },
  sky: { bg: "var(--workspace-color-sky-bg)", fg: "var(--workspace-color-sky-fg)" },
  indigo: { bg: "var(--workspace-color-indigo-bg)", fg: "var(--workspace-color-indigo-fg)" },
  violet: { bg: "var(--workspace-color-violet-bg)", fg: "var(--workspace-color-violet-fg)" },
  pink: { bg: "var(--workspace-color-pink-bg)", fg: "var(--workspace-color-pink-fg)" },
} satisfies Record<string, WorkspaceIconColor>;

export type WorkspaceIconColorKey = keyof typeof WORKSPACE_ICON_COLORS;

export const WORKSPACE_ICON_COLOR_KEYS = Object.keys(
  WORKSPACE_ICON_COLORS,
) as WorkspaceIconColorKey[];

/** Stable djb2-style hash so a workspace id always maps to the same bucket. */
function hashString(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return hash >>> 0;
}

export function deterministicIconKey(workspaceId: string): WorkspaceIconKey {
  const index = hashString(workspaceId) % WORKSPACE_ICON_KEYS.length;
  return WORKSPACE_ICON_KEYS[index]!;
}

// Slight offset so a workspace's deterministic color isn't perfectly
// correlated with its deterministic glyph — keeps the gallery feeling
// shuffled rather than streaky.
export function deterministicIconColorKey(workspaceId: string): WorkspaceIconColorKey {
  const index = (hashString(workspaceId) + 7) % WORKSPACE_ICON_COLOR_KEYS.length;
  return WORKSPACE_ICON_COLOR_KEYS[index]!;
}

export function resolveWorkspaceIconKey(
  workspaceId: string,
  stored: string | null | undefined,
): WorkspaceIconKey {
  if (stored && stored in WORKSPACE_ICONS) {
    return stored as WorkspaceIconKey;
  }
  return deterministicIconKey(workspaceId);
}

export function resolveWorkspaceIconColorKey(
  workspaceId: string,
  stored: string | null | undefined,
): WorkspaceIconColorKey {
  if (stored && stored in WORKSPACE_ICON_COLORS) {
    return stored as WorkspaceIconColorKey;
  }
  return deterministicIconColorKey(workspaceId);
}
