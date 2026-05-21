import type { ReactNode } from "react";

import { cn } from "../lib/utils.js";

/**
 * Canonical chrome for a workspace-pane dashboard. Two slots: a top bar
 * (header, actions) and a scrollable content region underneath. Apps
 * should wrap their dashboard root with this so density, padding, and
 * scroll behavior stay consistent across the workspace.
 *
 * The shell does not manage its own width; it fills its parent (the
 * pane). Vertical scroll lives on `content` so the header stays pinned.
 */
export interface DashboardShellProps {
  /** Sticky top region. Typically a `<PageHeader>`. */
  header?: ReactNode;
  /** Main scrollable content. */
  children: ReactNode;
  /** Extra class on the outer flex container. */
  className?: string;
  /** Extra class on the scrollable content region. */
  contentClassName?: string;
}

export function DashboardShell({
  header,
  children,
  className,
  contentClassName,
}: DashboardShellProps) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      {header ? (
        <div className="shrink-0 border-b border-border bg-background">
          {header}
        </div>
      ) : null}
      <div className={cn("min-h-0 flex-1 overflow-y-auto", contentClassName)}>
        {children}
      </div>
    </div>
  );
}
