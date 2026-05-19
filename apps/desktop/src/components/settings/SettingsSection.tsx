import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsSectionProps {
  /** Section heading. */
  title: string;
  /** Optional one-line context shown under the title. */
  description?: string;
  /** Optional element rendered to the right of the title (e.g. an action button). */
  action?: ReactNode;
  /** Section content — typically one or more SettingsCard blocks. */
  children: ReactNode;
  className?: string;
}

/**
 * SettingsSection
 *
 * Top-level grouping for settings panels. Renders a title row + optional
 * description and lets the children (cards, lists, ad-hoc divs) flow
 * underneath. Pair with SettingsCard for surfaces that need a hairline-
 * boxed feel; pair with bare children when the content is full-bleed
 * (workspace override list, connection list, etc.).
 */
export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <section className={cn("grid gap-3", className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-medium text-foreground">{title}</div>
          {description ? (
            <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}
