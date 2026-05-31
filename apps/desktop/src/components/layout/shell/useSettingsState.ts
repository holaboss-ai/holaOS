import { useCallback, useEffect, useState } from "react";
import {
  type ColorScheme,
  type ControlCenterCardsPerRow,
  isColorScheme,
  isControlCenterCardsPerRow,
  isThemeVariant,
  splitAppTheme,
  type ThemeVariant,
  THEME_VARIANTS,
} from "@/components/layout/themes";

const THEME_STORAGE_KEY = "holaboss-theme-v1";
const COLOR_SCHEME_STORAGE_KEY = "holaboss-color-scheme";
const THEME_VARIANT_STORAGE_KEY = "holaboss-theme-variant";
const CONTROL_CENTER_CARDS_PER_ROW_STORAGE_KEY =
  "holaboss-control-center-cards-per-row-v1";

function loadColorScheme(): ColorScheme {
  try {
    const stored = localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    if (stored && isColorScheme(stored)) return stored;
    // Fall back to the legacy combined "<variant>-<scheme>" key for users
    // upgrading from a pre-split build whose only theme record is there.
    const legacy = localStorage.getItem(THEME_STORAGE_KEY);
    if (legacy) {
      const split = splitAppTheme(legacy);
      if (split) return split.scheme;
    }
  } catch {
    // ignore
  }
  return "system";
}

function loadThemeVariant(): ThemeVariant {
  try {
    const stored = localStorage.getItem(THEME_VARIANT_STORAGE_KEY);
    if (stored && isThemeVariant(stored)) return stored;
    const legacy = localStorage.getItem(THEME_STORAGE_KEY);
    if (legacy) {
      const split = splitAppTheme(legacy);
      if (split) return split.variant;
    }
  } catch {
    // ignore
  }
  return "holaos";
}

function loadCardsPerRow(): ControlCenterCardsPerRow {
  try {
    const raw = localStorage.getItem(CONTROL_CENTER_CARDS_PER_ROW_STORAGE_KEY);
    const parsed = Number(raw);
    if (isControlCenterCardsPerRow(parsed)) return parsed;
  } catch {
    // ignore
  }
  return 3;
}

/**
 * Self-contained settings state for the new shell. Mirrors AppShell's
 * theme / color-scheme / cards-per-row / notifications flow and writes
 * to the same localStorage keys, so the two shells stay in sync when
 * a user toggles between them.
 */
export function useSettingsState() {
  const [colorScheme, setColorScheme] = useState<ColorScheme>(loadColorScheme);
  const [themeVariant, setThemeVariant] =
    useState<ThemeVariant>(loadThemeVariant);
  const [cardsPerRow, setCardsPerRow] =
    useState<ControlCenterCardsPerRow>(loadCardsPerRow);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const effectiveScheme: "light" | "dark" =
    colorScheme === "system"
      ? systemPrefersDark
        ? "dark"
        : "light"
      : colorScheme;
  const theme = `${themeVariant}-${effectiveScheme}`;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, colorScheme);
      localStorage.setItem(THEME_VARIANT_STORAGE_KEY, themeVariant);
    } catch {
      // ignore
    }
    void window.electronAPI?.ui.setTheme(theme);
  }, [theme, colorScheme, themeVariant]);

  useEffect(() => {
    try {
      localStorage.setItem(
        CONTROL_CENTER_CARDS_PER_ROW_STORAGE_KEY,
        String(cardsPerRow),
      );
    } catch {
      // ignore
    }
  }, [cardsPerRow]);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.ui
      .getNotificationsEnabled()
      .then((enabled) => {
        if (!cancelled) setNotificationsEnabled(enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleNotificationsChange = useCallback((enabled: boolean) => {
    setNotificationsEnabled(enabled);
    void window.electronAPI?.ui
      .setNotificationsEnabled(enabled)
      .then((persisted) => setNotificationsEnabled(persisted))
      .catch(() => undefined);
  }, []);

  const handleOpenExternalUrl = useCallback((url: string) => {
    void window.electronAPI?.ui.openExternalUrl(url);
  }, []);

  return {
    colorScheme,
    onColorSchemeChange: setColorScheme,
    themeVariant,
    themeVariants: THEME_VARIANTS,
    onThemeVariantChange: setThemeVariant,
    cardsPerRow,
    onCardsPerRowChange: setCardsPerRow,
    notificationsEnabled,
    onNotificationsChange: handleNotificationsChange,
    onOpenExternalUrl: handleOpenExternalUrl,
  };
}
