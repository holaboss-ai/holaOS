import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsRowProps {
  /** Primary label (string or rich content like "name + badge"). */
  label: ReactNode;
  /** Optional one-line helper text shown under the label. */
  description?: ReactNode;
  /** Optional leading visual (icon, brand mark, avatar). */
  leading?: ReactNode;
  /** Right-side control / actions / status. */
  children?: ReactNode;
  /** Subtler hover for clickable rows. */
  interactive?: boolean;
  /** Click handler — only fires when interactive=true. */
  onClick?: () => void;
  className?: string;
}

/**
 * SettingsRow
 *
 * Standard label-on-left / control-on-right row. Lives inside
 * SettingsCard. Use for simple display rows or as a base for
 * SettingsMenuSelectRow / SettingsToggle.
 *
 * Set `interactive` + `onClick` for rows that are themselves the
 * action target (e.g. a workspace override card collapse/expand
 * trigger).
 */
export function SettingsRow({
  label,
  description,
  leading,
  children,
  interactive,
  onClick,
  className,
}: SettingsRowProps) {
  const Component = interactive ? "button" : "div";
  return (
    <Component
      type={interactive ? "button" : undefined}
      onClick={interactive ? onClick : undefined}
      data-layout="settings-row"
      className={cn(
        "flex w-full items-center justify-between gap-4 px-4 py-3 text-left",
        interactive &&
          "transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {children ? (
        <div data-layout="settings-control" className="shrink-0">
          {children}
        </div>
      ) : null}
    </Component>
  );
}
