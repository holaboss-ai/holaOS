import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SettingsPageProps {
  /** Top-of-page heading (e.g. "General"). */
  title: string;
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
    <div className={cn("mx-auto w-full max-w-3xl px-10 py-12", className)}>
      <header className="mb-10">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </header>
      <div className="grid gap-10">{children}</div>
    </div>
  );
}
