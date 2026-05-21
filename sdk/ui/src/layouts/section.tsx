import type { ReactNode } from "react";

import { cn } from "../lib/utils.js";

/**
 * Title + optional description over a content block. Use to group
 * related controls or stats inside a pane.
 */
export interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned action slot next to the title. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export function Section({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: SectionProps) {
  return (
    <section className={cn("px-4 py-3", className)}>
      {title || description || actions ? (
        <header className="mb-2 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {title ? (
              <h2 className="text-sm font-medium text-foreground">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
          ) : null}
        </header>
      ) : null}
      <div className={contentClassName}>{children}</div>
    </section>
  );
}
