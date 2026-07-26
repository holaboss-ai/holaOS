import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../lib/utils"

/**
 * StatusDot — small colored dot signalling a state (running, error,
 * working, idle, etc.). Replaces ~18 hand-rolled
 * `<span className="size-X rounded-full bg-X" />` instances across the
 * shell so a single change here propagates everywhere.
 *
 * Default size = `sm` (6px) which matches the dominant existing usage
 * (status pip alongside text). Use `md` (8px) for slightly more
 * presence (sidebar entry status), `lg` (10px) for stand-alone
 * notification-style indicators.
 *
 * `withRing` adds a card-colored ring — used for badge dots that sit on
 * top of an icon and need to read against the underlying surface.
 */
const statusDotVariants = cva("inline-block shrink-0 rounded-full", {
  variants: {
    variant: {
      success: "bg-success",
      destructive: "bg-destructive",
      warning: "bg-warning",
      info: "bg-info",
      primary: "bg-primary",
      muted: "bg-muted-foreground",
      neutral: "bg-fg-24",
    },
    size: {
      sm: "size-1.5",
      md: "size-2",
      lg: "size-2.5",
    },
    withRing: {
      true: "border-2 border-card",
      false: "",
    },
    pulse: {
      true: "animate-pulse",
      false: "",
    },
  },
  defaultVariants: {
    variant: "info",
    size: "sm",
    withRing: false,
    pulse: false,
  },
})

export type StatusDotProps = useRender.ComponentProps<"span"> &
  VariantProps<typeof statusDotVariants>

export function StatusDot({
  className,
  variant,
  size,
  withRing,
  pulse,
  render,
  ...props
}: StatusDotProps) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(
          statusDotVariants({ variant, size, withRing, pulse }),
          className,
        ),
        "aria-hidden": true,
      },
      props,
    ),
    render,
    state: {
      slot: "status-dot",
      variant,
      size,
    },
  })
}
