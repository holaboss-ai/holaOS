import type { ReactNode } from "react";

import { cn } from "../lib/utils.js";

/**
 * Title + optional subtitle + optional right-aligned actions. The
 * canonical first child of `<DashboardShell header={...}>`. Density and
 * weight stay consistent regardless of which app drops it in.
 */
export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned action slot (typically buttons). */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-4 px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}
