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
 * WORKSPACE_ICON_COLORS — neutral tint used across every workspace identity.
 * Color selection was deliberately removed: the glyph carries identity, and
 * keeping a single tone keeps the workspace gallery visually calm. The map
 * is preserved (rather than inlined) so WorkspaceIcon can keep its existing
 * tint-lookup shape.
 */
export const WORKSPACE_ICON_COLORS = {
  gray: {
    bg: "var(--workspace-color-gray-bg)",
    fg: "var(--workspace-color-gray-fg)",
  },
} satisfies Record<string, WorkspaceIconColor>;

export type WorkspaceIconColorKey = keyof typeof WORKSPACE_ICON_COLORS;

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
  _workspaceId: string,
  _stored: string | null | undefined,
): WorkspaceIconColorKey {
  return "gray";
}
