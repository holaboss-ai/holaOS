import { useAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import {
  type ColorScheme,
  type FontFamily,
  FONT_FAMILIES,
  FONT_STACKS,
  isColorScheme,
  isFontFamily,
  splitAppTheme,
  type ThemeVariant,
} from "@/components/layout/themes";
import { defaultMainViewModeAtom } from "./state/ui";

const THEME_STORAGE_KEY = "holaboss-theme-v1";
const COLOR_SCHEME_STORAGE_KEY = "holaboss-color-scheme";
const THEME_VARIANT_STORAGE_KEY = "holaboss-theme-variant";
const FONT_FAMILY_STORAGE_KEY = "holaboss-font-family";

function loadFontFamily(): FontFamily {
  try {
    const stored = localStorage.getItem(FONT_FAMILY_STORAGE_KEY);
    if (stored && isFontFamily(stored)) return stored;
  } catch {
    // ignore
  }
  return "inter";
}

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

/**
 * Self-contained settings state for the new shell. Mirrors AppShell's
 * theme / color-scheme / notifications flow and writes to the same
 * localStorage keys, so the two shells stay in sync when a user
 * toggles between them.
 */
export function useSettingsState() {
  const [colorScheme, setColorScheme] = useState<ColorScheme>(loadColorScheme);
  // Palette picker removed; the app ships only the Holaboss theme.
  const themeVariant: ThemeVariant = "holaos";
  const [fontFamily, setFontFamily] = useState<FontFamily>(loadFontFamily);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(true);
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
      // Legacy THEME_STORAGE_KEY is intentionally not written anymore —
      // its only consumer was the retired AppShell. App.tsx clears any
      // historical value on boot.
      localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, colorScheme);
      localStorage.setItem(THEME_VARIANT_STORAGE_KEY, themeVariant);
    } catch {
      // ignore
    }
    void window.electronAPI?.ui.setTheme(theme);
  }, [theme, colorScheme, themeVariant]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--ui-font-sans",
      FONT_STACKS[fontFamily],
    );
    try {
      localStorage.setItem(FONT_FAMILY_STORAGE_KEY, fontFamily);
    } catch {
      // ignore
    }
  }, [fontFamily]);

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

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.ui
      .getKeepAwakeEnabled()
      .then((enabled) => {
        if (!cancelled) setKeepAwakeEnabled(enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleKeepAwakeChange = useCallback((enabled: boolean) => {
    setKeepAwakeEnabled(enabled);
    void window.electronAPI?.ui
      .setKeepAwakeEnabled(enabled)
      .then((persisted) => setKeepAwakeEnabled(persisted))
      .catch(() => undefined);
  }, []);

  const handleOpenExternalUrl = useCallback((url: string) => {
    // Settings help/links → the Default profile's browser window, not the OS browser.
    void window.electronAPI?.profiles.launch("bprofile_default", url);
  }, []);

  const [defaultMainViewMode, setDefaultMainViewMode] = useAtom(
    defaultMainViewModeAtom,
  );

  return {
    colorScheme,
    onColorSchemeChange: setColorScheme,
    fontFamily,
    fontFamilies: FONT_FAMILIES,
    onFontFamilyChange: setFontFamily,
    defaultMainViewMode,
    onDefaultMainViewModeChange: setDefaultMainViewMode,
    notificationsEnabled,
    onNotificationsChange: handleNotificationsChange,
    keepAwakeEnabled,
    onKeepAwakeChange: handleKeepAwakeChange,
    onOpenExternalUrl: handleOpenExternalUrl,
  };
}
