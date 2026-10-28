import type { ReactNode } from "react";
import { Check } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { TONE_CLASSES, type Tone } from "./format";

export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-medium text-[11px] leading-4",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function MetaChip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-full border border-border bg-fg-2 px-2 py-0.5 text-[11px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ProgressBar({
  done,
  total,
  tone = "active",
}: {
  done: number;
  total: number;
  tone?: "active" | "success" | "danger" | "neutral";
}) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
  return (
    <div
      aria-valuemax={total}
      aria-valuemin={0}
      aria-valuenow={done}
      className="h-1 w-full overflow-hidden rounded-full bg-fg-8"
      role="progressbar"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300 ease-out",
          tone === "success"
            ? "bg-success"
            : tone === "danger"
              ? "bg-destructive"
              : tone === "neutral"
                ? "bg-fg-24"
                : "bg-info",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("rounded-xl border border-border bg-card", className)}
    >
      {title || actions ? (
        <header className="flex items-start justify-between gap-3 border-border border-b px-4 py-2.5">
          <div className="min-w-0">
            {title ? (
              <h3 className="font-medium text-foreground text-sm">{title}</h3>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-muted-foreground text-xs">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
          ) : null}
        </header>
      ) : null}
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

const CALLOUT_CLASSES: Record<Tone, { box: string; icon: string }> = {
  neutral: {
    box: "border-border bg-fg-2 text-muted-foreground",
    icon: "text-muted-foreground",
  },
  active: {
    box: "border-info/20 bg-info/6 text-foreground/85",
    icon: "text-info",
  },
  success: {
    box: "border-success/20 bg-success/8 text-foreground/85",
    icon: "text-success",
  },
  warning: {
    box: "border-warning/40 bg-warning/10 text-foreground/85",
    icon: "text-foreground/70",
  },
  danger: {
    box: "border-destructive/20 bg-destructive/6 text-foreground/85",
    icon: "text-destructive",
  },
};

export function Callout({
  tone = "neutral",
  icon,
  children,
  action,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  const classes = CALLOUT_CLASSES[tone];
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-[13px] leading-5",
        classes.box,
      )}
    >
      {icon ? (
        <span className={cn("mt-0.5 shrink-0 [&>svg]:size-3.5", classes.icon)}>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1 self-center">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = "md",
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-lg bg-fg-4 p-0.5"
      role="tablist"
    >
      {options.map((option) => (
        <button
          aria-selected={option.value === value}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md font-medium transition-colors",
            size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm",
            option.value === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="tab"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ToggleChip({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-pressed={pressed}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border px-2 font-medium text-xs transition-colors disabled:pointer-events-none disabled:opacity-50",
        pressed
          ? "border-fg-24 bg-fg-8 text-foreground"
          : "border-border bg-background text-muted-foreground hover:bg-fg-4 hover:text-foreground",
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {pressed ? <Check className="size-3" /> : null}
      {children}
    </button>
  );
}

export function CountBadge({
  count,
  tone = "neutral",
}: {
  count: number;
  tone?: "neutral" | "warning" | "danger";
}) {
  if (count <= 0) {
    return null;
  }
  return (
    <span
      className={cn(
        "rounded-full px-1.5 font-medium text-[10px] tabular-nums leading-4",
        tone === "warning"
          ? "bg-warning/32 text-foreground"
          : tone === "danger"
            ? "bg-destructive/12 text-destructive"
            : "bg-fg-8 text-foreground/70",
      )}
    >
      {count}
    </span>
  );
}
