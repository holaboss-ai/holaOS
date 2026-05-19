import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../primitives/button.js";
import { cn } from "../lib/utils.js";

/**
 * Centered error display with an optional retry action. Use for the
 * body of a pane when data fetch / mutation fails. Title is short, the
 * `detail` is the developer-relevant message (truncate-friendly).
 */
export interface ErrorStateProps {
  title?: string;
  /** Concrete error description — the API error text, etc. */
  detail?: ReactNode;
  /** Click handler for the retry button. Omit to skip the button. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  detail,
  onRetry,
  retryLabel = "Try again",
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-4 py-14 text-center",
        className,
      )}
    >
      <div className="grid size-10 place-items-center rounded-xl bg-destructive/10 text-destructive">
        <AlertTriangle className="size-4" strokeWidth={1.6} />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail ? (
        <p className="max-w-md text-xs leading-5 text-muted-foreground">
          {detail}
        </p>
      ) : null}
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
