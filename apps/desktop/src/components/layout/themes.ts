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

export type ControlCenterCardsPerRow = 2 | 3 | 4;

export function isControlCenterCardsPerRow(
  value: number,
): value is ControlCenterCardsPerRow {
  return value === 2 || value === 3 || value === 4;
}

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
