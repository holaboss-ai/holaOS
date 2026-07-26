import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SettingsPageProps {
  /** Top-of-page heading (e.g. "General"). Omit to let the page body own its heading. */
  title?: string;
  /** Optional one-line subtitle below the heading. */
  description?: ReactNode;
  /** Sections / cards / arbitrary children. */
  children: ReactNode;
  className?: string;
}

/**
 * SettingsPage
 *
 * Inner content wrapper used by every settings page body. Centers the
 * column at a comfortable reading width, owns the page-level H1 +
 * subtitle, and provides consistent vertical rhythm between sections.
 *
 * Pair with `SettingsScreen` (the outer shell) and use `SettingsSection`
 * inside `children` for grouped settings cards.
 */
export function SettingsPage({
  title,
  description,
  children,
  className,
}: SettingsPageProps) {
  return (
    <div className={cn("mx-auto w-full max-w-3xl px-8 py-8", className)}>
      {title || description ? (
        <header className="mb-7">
          {title ? (
            <h1 className="text-xl font-semibold leading-tight tracking-tight text-foreground">
              {title}
            </h1>
          ) : null}
          {description ? (
            <p className="mt-1.5 text-sm leading-snug text-foreground/55">
              {description}
            </p>
          ) : null}
        </header>
      ) : null}
      <div className="grid gap-7">{children}</div>
    </div>
  );
}
