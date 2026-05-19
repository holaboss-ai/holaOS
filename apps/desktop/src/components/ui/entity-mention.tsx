import type { ReactNode } from "react";

import { EntityChip, type EntityChipProps } from "@/components/ui/entity-chip";
import { cn } from "@/lib/utils";

/**
 * EntityMention — inline reference to an entity inside prose. Visually
 * a chip with a leading `@` glyph, sized to flow with body text. Use
 * for `@workspace`, `@app`, `@session`, `@memory` etc. references in
 * chat composers, agent prompts, skill descriptions.
 *
 * Distinct from EntityChip in two ways: (1) the `@` prefix marks it
 * as a mention rather than a generic reference, (2) sizing aligns to
 * `xs` by default so it fits inline without breaking line height.
 *
 * Pair with MentionPicker for entry; pair with EntityChip when the
 * reference is structural (sidebar, breadcrumb) rather than mid-prose.
 */
export interface EntityMentionProps extends Omit<EntityChipProps, "label"> {
  label: ReactNode;
}

export function EntityMention({
  label,
  size = "xs",
  variant = "ghost",
  interactive = true,
  className,
  ...props
}: EntityMentionProps) {
  return (
    <EntityChip
      label={
        <>
          <span aria-hidden="true" className="text-muted-foreground">
            @
          </span>
          {label}
        </>
      }
      size={size}
      variant={variant}
      interactive={interactive}
      className={cn(
        // Mentions sit inside text — keep them visually quiet so a
        // paragraph with multiple mentions doesn't read as a wall of
        // pills.
        "text-foreground",
        className,
      )}
      {...props}
    />
  );
}
