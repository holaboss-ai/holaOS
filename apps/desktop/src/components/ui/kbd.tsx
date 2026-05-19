import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * Kbd — keyboard shortcut hint. Inline `<kbd>` styled as a tiny pill.
 * Use in tooltip footers, menu trailing slots, and help text to teach
 * keyboard grammar continuously.
 *
 * Single-key glyphs (⌘, ⇧, ↑, K) auto-center via the square sizing.
 * For multi-key sequences, render multiple <Kbd> with a separator:
 *   <Kbd>⌘</Kbd><Kbd>K</Kbd>
 */
const kbdVariants = cva(
  "inline-flex items-center justify-center rounded border border-border bg-fg-2 font-mono text-[10px] font-medium text-muted-foreground tabular-nums",
  {
    variants: {
      size: {
        sm: "h-4 min-w-4 px-1",
        md: "h-5 min-w-5 px-1.5 text-[11px]",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

export type KbdProps = ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>;

export function Kbd({ className, size, ...props }: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(kbdVariants({ size }), className)}
      {...props}
    />
  );
}
