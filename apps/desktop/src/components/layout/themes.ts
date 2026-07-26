/**
 * Theme constants and types shared by the shell and the settings
 * surface. Lives at module scope so anything that needs to describe a
 * theme — variant + scheme + the legacy combined string — can pull it
 * here without depending on the shell component itself.
 */

export const THEMES = [
  "holaos-dark",
  "holaos-light",
  "catppuccin-dark",
  "catppuccin-light",
  "rose-pine-dark",
  "rose-pine-light",
  "solarized-dark",
  "solarized-light",
  "nord-dark",
  "nord-light",
  "one-dark-pro-dark",
  "one-dark-pro-light",
  "gruvbox-dark",
  "gruvbox-light",
  "vitesse-dark",
  "vitesse-light",
] as const;

export type AppTheme = (typeof THEMES)[number];

export function isAppTheme(value: string): value is AppTheme {
  return THEMES.includes(value as AppTheme);
}

// Appearance model — two orthogonal axes combined into the legacy
// AppTheme string for Electron IPC and `data-theme` application.
export const THEME_VARIANTS = [
  "holaos",
  "catppuccin",
  "rose-pine",
  "solarized",
  "nord",
  "one-dark-pro",
  "gruvbox",
  "vitesse",
] as const;

export type ThemeVariant = (typeof THEME_VARIANTS)[number];

export function isThemeVariant(value: string): value is ThemeVariant {
  return THEME_VARIANTS.includes(value as ThemeVariant);
}

export type ColorScheme = "system" | "light" | "dark";

export function isColorScheme(value: string): value is ColorScheme {
  return value === "system" || value === "light" || value === "dark";
}

export const FONT_FAMILIES = ["inter", "system", "jakarta", "plex"] as const;

export type FontFamily = (typeof FONT_FAMILIES)[number];

export function isFontFamily(value: string): value is FontFamily {
  return (FONT_FAMILIES as readonly string[]).includes(value);
}

/** Font-family stacks applied to --ui-font-sans by the font preference. */
export const FONT_STACKS: Record<FontFamily, string> = {
  inter: "'Inter Variable', Inter, system-ui, sans-serif",
  system:
    "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  jakarta: "'Plus Jakarta Sans Variable', system-ui, sans-serif",
  plex: "'IBM Plex Sans', system-ui, sans-serif",
};

/**
 * Decompose a legacy combined theme string ("holaos-dark") into the
 * (variant, scheme) tuple the new storage format uses. Returns null if
 * the string doesn't match any known theme.
 */
export function splitAppTheme(
  value: string,
): { variant: ThemeVariant; scheme: "light" | "dark" } | null {
  if (!isAppTheme(value)) {
    return null;
  }
  if (value.endsWith("-dark")) {
    const variant = value.slice(0, -"-dark".length);
    if (isThemeVariant(variant)) {
      return { variant, scheme: "dark" };
    }
  }
  if (value.endsWith("-light")) {
    const variant = value.slice(0, -"-light".length);
    if (isThemeVariant(variant)) {
      return { variant, scheme: "light" };
    }
  }
  return null;
}
