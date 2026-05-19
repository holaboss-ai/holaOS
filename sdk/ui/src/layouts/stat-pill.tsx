import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils.js";

/**
 * Small metric display — label on top, value below, optional icon and
 * trend chip. Use in a grid at the top of a dashboard. Stays tight; no
 * shadows or gradients.
 */
export interface StatPillProps {
  label: ReactNode;
  value: ReactNode;
  icon?: LucideIcon;
  /** Optional trend / hint chip rendered next to the value. */
  trend?: ReactNode;
  /** Visual tone for the value. Default `neutral` (foreground). */
  tone?: "neutral" | "positive" | "negative";
  className?: string;
}

const toneClass: Record<NonNullable<StatPillProps["tone"]>, string> = {
  neutral: "text-foreground",
  positive: "text-emerald-600 dark:text-emerald-400",
  negative: "text-destructive",
};

export function StatPill({
  label,
  value,
  icon: Icon,
  trend,
  tone = "neutral",
  className,
}: StatPillProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon ? <Icon className="size-3" strokeWidth={1.6} /> : null}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={cn("text-lg font-semibold", toneClass[tone])}>
          {value}
        </span>
        {trend ? (
          <span className="text-xs text-muted-foreground">{trend}</span>
        ) : null}
      </div>
    </div>
  );
}
