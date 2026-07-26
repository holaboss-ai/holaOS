/**
 * Motion presets — pair with index.css token rhythm.
 *
 * Spring values are softer than industry defaults to match the
 * "friendly, confident" brand voice. Use these instead of inline
 * literals so timing stays coherent across the app.
 *
 * Shape matches motion/react's Transition; no import to avoid a
 * dependency on a library that may not be installed yet. Cast at
 * call site when consumed.
 *
 * For CSS-side easing/duration tokens see:
 *   --ease-standard, --ease-out-quint
 *   --duration-fast, --duration-base, --duration-slow
 */

/** Panel push/pop, sash drag, content shifts. */
export const SPRING_PANEL = {
  type: "spring" as const,
  stiffness: 520,
  damping: 44,
}

/** Sidebar collapse/expand, navigator slide-in. */
export const SPRING_SIDEBAR = {
  type: "spring" as const,
  stiffness: 280,
  damping: 28,
}

/** Standard cubic-bezier for hand-rolled tween animations. */
export const EASE_STANDARD = [0.32, 0.08, 0.24, 1] as const

/** Decelerating curve — for content reveal, list-item entrance. */
export const EASE_OUT_QUINT = [0.22, 1, 0.36, 1] as const

export const DURATION_FAST = 0.12
export const DURATION_BASE = 0.22
export const DURATION_SLOW = 0.36

/** Stagger delay between sibling list items. */
export const STAGGER_CHILD = 0.02
