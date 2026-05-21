import { Search } from "lucide-react";
import type { ReactNode } from "react";

import { Input } from "../primitives/input.js";
import { cn } from "../lib/utils.js";

/**
 * Search input + filter chip slot + right-aligned actions. Sits at the
 * top of a list / table to provide a consistent control row across
 * apps.
 */
export interface FilterBarProps {
  /** Search input value (controlled). */
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** Filter chips / selects / segmented controls. */
  filters?: ReactNode;
  /** Right-aligned actions (e.g. "New", "Refresh"). */
  actions?: ReactNode;
  className?: string;
}

export function FilterBar({
  search,
  onSearchChange,
  searchPlaceholder = "Search…",
  filters,
  actions,
  className,
}: FilterBarProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border px-4 py-2",
        className,
      )}
    >
      {onSearchChange ? (
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-7 pl-7 text-sm"
            value={search ?? ""}
            placeholder={searchPlaceholder}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
      ) : null}
      {filters ? (
        <div className="flex flex-wrap items-center gap-1.5">{filters}</div>
      ) : null}
      {actions ? (
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}
