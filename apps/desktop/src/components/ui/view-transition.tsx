import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

/**
 * A small, refined crossfade between mutually-exclusive views. Re-render with a
 * new `transitionKey` (e.g. the active tab/section/detail id) and the old view
 * animates out while the new one animates in.
 *
 * - `fade`  — scale + opacity; for list ↔ detail within a surface.
 * - `slide` — a subtle rise from below + opacity; for switching top-level
 *             tabs/sections (new view eases up into place, old view eases up out).
 *
 * `initial={false}` means nothing animates on first mount — only subsequent
 * key changes transition, so nested ViewTransitions don't double-fire.
 */
// The new view eases in; the old one leaves quickly so the switch feels snappy
// rather than sequential.
const ENTER = { duration: 0.18, ease: "easeOut" } as const;
const EXIT = { duration: 0.09, ease: "easeIn" } as const;

const VARIANTS = {
  fade: {
    initial: { opacity: 0, scale: 0.99 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.99, transition: EXIT },
  },
  slide: {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -4, transition: EXIT },
  },
} as const;

export type ViewTransitionVariant = keyof typeof VARIANTS;

export function ViewTransition({
  transitionKey,
  variant = "fade",
  className,
  children,
}: {
  transitionKey: string;
  variant?: ViewTransitionVariant;
  className?: string;
  children: ReactNode;
}) {
  const preset = VARIANTS[variant];
  return (
    <AnimatePresence initial={false} mode="wait">
      <motion.div
        animate={preset.animate}
        className={className}
        exit={preset.exit}
        initial={preset.initial}
        key={transitionKey}
        transition={ENTER}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
