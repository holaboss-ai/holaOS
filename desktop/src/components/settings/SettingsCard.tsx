import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsCardProps {
  /** Rows / content. Direct children get a separator between them via `[&>*+*]:border-t`. */
  children: ReactNode;
  className?: string;
}

/**
 * SettingsCard
 *
 * A boxed surface for SettingsRow / SettingsToggle / SettingsMenuSelectRow.
 * Direct children automatically get a top border so successive rows share
 * a hairline divider.
 *
 * Style notes:
 *  - Single hairline border around the card; no shadow. Matches the
 *    full-screen settings reference's quieter chrome.
 *  - rounded-xl + overflow-hidden so the inner row borders don't peek
 *    past the corners.
 */
export function SettingsCard({ children, className }: SettingsCardProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card [&>*+*]:border-t [&>*+*]:border-border",
        className,
      )}
    >
      {children}
    </div>
  );
}
