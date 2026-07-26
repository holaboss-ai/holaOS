import { cn } from "@/lib/utils";

export type SettingsStatusTone =
  | "default"
  | "success"
  | "muted"
  | "destructive"
  | "warning";

interface SettingsStatusBadgeProps {
  tone: SettingsStatusTone;
  children: string;
  className?: string;
}

/**
 * SettingsStatusBadge
 *
 * Small rounded chip used to convey at-a-glance state next to a row
 * label (e.g. "Default", "Connected", "Auth failed", "Validating...").
 *
 * Five tones, all keyed to design tokens:
 *  - default     — brand (orange-tinted ring), e.g. "Default"
 *  - success     — green, e.g. "Connected", "Valid"
 *  - muted       — neutral, e.g. "Not connected"
 *  - destructive — red, e.g. "Auth failed", "Invalid"
 *  - warning     — amber, e.g. "Validating...", "Pending"
 */
export function SettingsStatusBadge({
  tone,
  children,
  className,
}: SettingsStatusBadgeProps) {
  const toneClass = {
    default: "border-primary/30 bg-primary/10 text-primary",
    success: "border-success/30 bg-success/10 text-success",
    muted: "border-border bg-muted/40 text-muted-foreground",
    destructive: "border-destructive/30 bg-destructive/10 text-destructive",
    warning: "border-warning/30 bg-warning/10 text-warning",
  }[tone];

  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium tabular-nums",
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  );
}
