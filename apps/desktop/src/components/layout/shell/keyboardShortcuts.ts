import { isWindowsDesktop } from "@/lib/windowControls";

/**
 * Source of truth for the keyboard-shortcut cheatsheet. Consumed by:
 *   - the `?` cheatsheet overlay (Overlays.tsx → KeyboardShortcutsOverlay)
 *   - the inline list in Settings → General → Keyboard shortcuts
 *
 * Grouped by intent so users can scan instead of read a flat list. Keys are
 * stored as the canonical macOS glyphs (⌘, ⇧, …) and mapped to the platform's
 * labels at render time via `shortcutKeyLabel` — on Windows the same bindings
 * fire on Ctrl/Shift/Alt (the handlers already test `metaKey || ctrlKey`), so
 * the display must say "Ctrl" there instead of "⌘".
 */

/** macOS glyph → Windows word. Keys not listed render unchanged. */
const WINDOWS_KEY_LABELS: Record<string, string> = {
  "⌘": "Ctrl",
  "⌃": "Ctrl",
  "⇧": "Shift",
  "⌥": "Alt",
  "⏎": "Enter",
  "↵": "Enter",
  "⌫": "Backspace",
  "⎋": "Esc",
};

/** Render a single canonical shortcut glyph for the current platform. */
export function shortcutKeyLabel(key: string): string {
  return isWindowsDesktop() ? (WINDOWS_KEY_LABELS[key] ?? key) : key;
}

/** The primary modifier for the current platform: "⌘" on macOS, "Ctrl" on Windows. */
export function modifierKeyLabel(): string {
  return shortcutKeyLabel("⌘");
}
export interface KeyboardShortcutItem {
  readonly label: string;
  readonly keys: ReadonlyArray<string>;
}

export interface KeyboardShortcutGroup {
  readonly heading: string;
  readonly items: ReadonlyArray<KeyboardShortcutItem>;
}

export const KEYBOARD_SHORTCUT_GROUPS: ReadonlyArray<KeyboardShortcutGroup> = [
  {
    heading: "Navigation",
    items: [
      { label: "Search", keys: ["⌘", "K"] },
      { label: "New tab", keys: ["⌘", "T"] },
      { label: "Toggle sidebar", keys: ["⌘", "\\"] },
      { label: "Close current tab", keys: ["⌘", "W"] },
      { label: "Close window", keys: ["⌘", "⇧", "W"] },
    ],
  },
  {
    heading: "Chat",
    items: [
      { label: "New chat", keys: ["⌘", "N"] },
      { label: "Toggle chat mode", keys: ["⌘", "."] },
      { label: "Toggle chat panel", keys: ["⌘", "⇧", "."] },
    ],
  },
  {
    heading: "Help",
    items: [{ label: "Keyboard shortcuts", keys: ["⌘", "/"] }],
  },
];

export const SHORTCUT_ACCELERATORS = {
  search: ["⌘", "K"],
  newTab: ["⌘", "T"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export const acceleratorGlyph = (keys: ReadonlyArray<string>): string =>
  keys
    .map(shortcutKeyLabel)
    // "⌘K" reads fine glyph-adjacent; "CtrlK" doesn't, so join with "+" once
    // any key rendered as a word (Windows).
    .join(isWindowsDesktop() ? "+" : "");
