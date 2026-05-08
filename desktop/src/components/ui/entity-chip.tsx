import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * EntityChip — inline pill rendering of an entity (workspace, app,
 * session, skill, integration). The unit of reference across the
 * product: anywhere a name + identity is referenced, prefer a chip
 * over plain text.
 *
 * Slots:
 *  - `icon`     — left visual: emoji string, Lucide icon, <img>, monogram
 *  - `label`    — entity name (truncates)
 *  - `trailing` — right side: status dot, account count, kbd hint, etc.
 *
 * The `interactive` variant adds hover state + cursor-pointer; pair with
 * `render={<button />}` (or a custom render prop) to wire a click target.
 */
const entityChipVariants = cva(
  "inline-flex max-w-full items-center select-none truncate font-medium",
  {
    variants: {
      size: {
        xs: "h-5 gap-1 rounded px-1.5 text-[11px]",
        sm: "h-6 gap-1.5 rounded-md px-2 text-xs",
        md: "h-7 gap-1.5 rounded-md px-2.5 text-sm",
      },
      variant: {
        // Subtle tinted surface — the canonical chip. Reads as "a thing"
        // without competing with surrounding content.
        default: "bg-fg-6 text-foreground",
        // Outlined — sits flat on a colored bg without adding tint.
        outline: "border border-border bg-transparent text-foreground",
        // Quiet — for chips that should fade into prose (mentions inside
        // long body text). Picks up tint on hover when interactive.
        ghost: "bg-transparent text-muted-foreground",
      },
      interactive: {
        true: "cursor-pointer transition-colors hover:bg-fg-8",
        false: "",
      },
    },
    compoundVariants: [
      // Ghost + interactive: gentle hint-of-fill on hover, not the same
      // as default's stepped-up surface.
      {
        variant: "ghost",
        interactive: true,
        className: "hover:bg-fg-4 hover:text-foreground",
      },
    ],
    defaultVariants: {
      size: "sm",
      variant: "default",
      interactive: false,
    },
  },
);

const iconSlotVariants = cva(
  "flex shrink-0 items-center justify-center [&_svg]:shrink-0",
  {
    variants: {
      size: {
        xs: "size-3 text-[10px] [&_svg]:size-3",
        sm: "size-3.5 text-[11px] [&_svg]:size-3.5",
        md: "size-4 text-[12px] [&_svg]:size-4",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

interface EntityChipOwnProps {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
}

export type EntityChipProps = useRender.ComponentProps<"span"> &
  VariantProps<typeof entityChipVariants> &
  EntityChipOwnProps;

export function EntityChip({
  icon,
  label,
  trailing,
  size,
  variant,
  interactive,
  className,
  render,
  ...props
}: EntityChipProps) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(
          entityChipVariants({ size, variant, interactive }),
          className,
        ),
        children: (
          <>
            {icon != null ? (
              <span aria-hidden="true" className={iconSlotVariants({ size })}>
                {icon}
              </span>
            ) : null}
            <span className="min-w-0 truncate">{label}</span>
            {trailing != null ? (
              <span className="shrink-0 [&_svg]:shrink-0">{trailing}</span>
            ) : null}
          </>
        ),
      },
      props,
    ),
    render,
    state: { slot: "entity-chip" },
  });
}
