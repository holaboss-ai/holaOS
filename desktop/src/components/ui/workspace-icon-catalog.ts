import type { LucideIcon } from "lucide-react";
import {
  Anchor,
  Atom,
  Beaker,
  Bird,
  Boxes,
  Cloud,
  Compass,
  Crown,
  Diamond,
  Feather,
  Flag,
  Flame,
  FlaskConical,
  Flower2,
  Gem,
  Globe,
  Hammer,
  Hexagon,
  Layers,
  Leaf,
  Lightbulb,
  Map,
  Moon,
  Mountain,
  Music2,
  Origami,
  Palette,
  Paintbrush,
  Puzzle,
  Rocket,
  Shapes,
  Snowflake,
  Sparkles,
  Star,
  Sun,
  Telescope,
  TreePine,
  Triangle,
  Umbrella,
  Wand2,
  Waves,
  Workflow,
  Zap,
} from "lucide-react";

/**
 * WORKSPACE_ICONS — curated lucide subset usable as a workspace identity
 * glyph. Keys are the lucide export names so storage stays human-readable
 * and round-trips cleanly. Any unknown key in the stored icon field falls
 * back to a deterministic pick (see deterministicIconKey).
 */
export const WORKSPACE_ICONS = {
  Anchor,
  Atom,
  Beaker,
  Bird,
  Boxes,
  Cloud,
  Compass,
  Crown,
  Diamond,
  Feather,
  Flag,
  Flame,
  FlaskConical,
  Flower2,
  Gem,
  Globe,
  Hammer,
  Hexagon,
  Layers,
  Leaf,
  Lightbulb,
  Map,
  Moon,
  Mountain,
  Music2,
  Origami,
  Palette,
  Paintbrush,
  Puzzle,
  Rocket,
  Shapes,
  Snowflake,
  Sparkles,
  Star,
  Sun,
  Telescope,
  TreePine,
  Triangle,
  Umbrella,
  Wand2,
  Waves,
  Workflow,
  Zap,
} satisfies Record<string, LucideIcon>;

export type WorkspaceIconKey = keyof typeof WORKSPACE_ICONS;

export const WORKSPACE_ICON_KEYS = Object.keys(WORKSPACE_ICONS) as WorkspaceIconKey[];

export interface WorkspaceIconColor {
  /** Background tint applied to the icon chip. */
  bg: string;
  /** Foreground glyph color. */
  fg: string;
}

/**
 * WORKSPACE_ICON_COLORS — six muted Notion-style tints. Each entry refers
 * to CSS variables defined in tokens.css that compose hue anchors with
 * --background / --foreground via color-mix, so the palette auto-adapts
 * to dark/light without separate theme overrides. Keys are persisted
 * verbatim.
 */
export const WORKSPACE_ICON_COLORS = {
  gray: {
    bg: "var(--workspace-color-gray-bg)",
    fg: "var(--workspace-color-gray-fg)",
  },
  amber: {
    bg: "var(--workspace-color-amber-bg)",
    fg: "var(--workspace-color-amber-fg)",
  },
  rose: {
    bg: "var(--workspace-color-rose-bg)",
    fg: "var(--workspace-color-rose-fg)",
  },
  emerald: {
    bg: "var(--workspace-color-emerald-bg)",
    fg: "var(--workspace-color-emerald-fg)",
  },
  blue: {
    bg: "var(--workspace-color-blue-bg)",
    fg: "var(--workspace-color-blue-fg)",
  },
  violet: {
    bg: "var(--workspace-color-violet-bg)",
    fg: "var(--workspace-color-violet-fg)",
  },
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

export function deterministicColorKey(workspaceId: string): WorkspaceIconColorKey {
  // Re-hash with a salt so icon and color buckets are independent — same
  // workspace doesn't always pair the Nth icon with the Nth color.
  const index = hashString(`color:${workspaceId}`) % WORKSPACE_ICON_COLOR_KEYS.length;
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
  return deterministicColorKey(workspaceId);
}
