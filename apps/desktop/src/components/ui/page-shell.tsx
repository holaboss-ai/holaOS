import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// The shared page chrome used across the full-window panes (Automations,
// Projects, Profiles, Channels, Customize, …): a large title with an optional
// one-line description, right-aligned actions, and an optional toolbar row
// (tabs / filters) — all centered to a max-width column. Extracted so every
// surface reads as one system instead of copy-pasted headers.
//
// Use PageHeader when a pane owns a bespoke body (e.g. a sidebar layout); use
// PageShell for the common case of a single centered, scrolling body.

const MAX_WIDTH = {
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
} as const;

export type PageMaxWidth = keyof typeof MAX_WIDTH;

export interface PageHeaderProps {
  title: ReactNode;
  /** One-line orientation under the title. */
  description?: ReactNode;
  /** Right-aligned controls (buttons, menus). */
  actions?: ReactNode;
  /** A row below the title — tabs or a filter bar. */
  toolbar?: ReactNode;
  maxWidth?: PageMaxWidth;
}

export function PageHeader({
  title,
  description,
  actions,
  toolbar,
  maxWidth = "5xl",
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "mx-auto w-full shrink-0 px-6 pt-8",
        toolbar ? "pb-3" : "pb-4",
        MAX_WIDTH[maxWidth],
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-semibold text-2xl text-foreground tracking-tight">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-xl text-muted-foreground text-sm">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
        ) : null}
      </div>
      {toolbar ? <div className="mt-4">{toolbar}</div> : null}
    </div>
  );
}

export function PageShell({
  children,
  bodyClassName,
  maxWidth = "5xl",
  ...header
}: PageHeaderProps & {
  children: ReactNode;
  /** Extra classes on the scrolling body (e.g. a different bottom padding). */
  bodyClassName?: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <PageHeader maxWidth={maxWidth} {...header} />
      <div
        className={cn(
          "mx-auto min-h-0 w-full flex-1 overflow-y-auto px-6 pb-12",
          MAX_WIDTH[maxWidth],
          bodyClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
