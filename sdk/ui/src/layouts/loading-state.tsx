import { cn } from "../lib/utils.js";

/**
 * Skeleton-style loading placeholder. Use for the body of a pane while
 * data is fetching. The default presentation is a vertical stack of
 * pulsing bars; `variant="list"` mimics a row list and `variant="card"`
 * mimics card-grid loading.
 *
 * Solid backgrounds + subtle pulse only. No shimmer gradients.
 */
export interface LoadingStateProps {
  variant?: "rows" | "list" | "card";
  /** How many placeholder elements to render. Default 4. */
  count?: number;
  className?: string;
}

export function LoadingState({
  variant = "rows",
  count = 4,
  className,
}: LoadingStateProps) {
  const items = Array.from({ length: count }, (_, i) => i);
  if (variant === "card") {
    return (
      <div
        className={cn(
          "grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3",
          className,
        )}
      >
        {items.map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-border bg-muted"
          />
        ))}
      </div>
    );
  }
  if (variant === "list") {
    return (
      <div className={cn("flex flex-col divide-y divide-border", className)}>
        {items.map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="size-8 shrink-0 animate-pulse rounded-full bg-muted" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-2.5 w-2/3 animate-pulse rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col gap-2 p-4", className)}>
      {items.map((i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded bg-muted"
          style={{ width: `${100 - i * 8}%` }}
        />
      ))}
    </div>
  );
}
