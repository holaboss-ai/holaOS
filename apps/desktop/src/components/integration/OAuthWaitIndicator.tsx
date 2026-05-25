import { LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { COMPOSIO_POLL_TIMEOUT_MS } from "@/lib/workspaceDesktop";

/**
 * Shared "we're waiting for OAuth to finish" indicator. Renders a spinner,
 * countdown ("M:SS left"), and progressively more helpful copy as the
 * 5-minute polling window elapses. Surfaces a Cancel button driven by the
 * caller's AbortController, and a window.focus heuristic that brings the
 * "did you close the OAuth tab?" hint up sooner when the user refocuses the
 * desktop window without completing auth.
 *
 * Used by IntegrationProposalCard and IntegrationConnectCard so the two
 * surfaces share the same vocabulary (cf. Week 1.2 + Week 4.3 in the UX
 * polish plan).
 */
export function OAuthWaitIndicator({
  displayName,
  onCancel,
  compact = false,
}: {
  displayName: string;
  onCancel: () => void;
  /** Inline-only variant — single row, no progress bar. */
  compact?: boolean;
}) {
  const elapsedMs = useElapsedMs();
  const focusedAfterStart = useReturnedToAppAfterStart();
  const remainingMs = Math.max(0, COMPOSIO_POLL_TIMEOUT_MS - elapsedMs);
  const fraction = Math.min(1, elapsedMs / COMPOSIO_POLL_TIMEOUT_MS);
  const showFirstHelper = elapsedMs > 30_000;
  const showStrongerHelper = elapsedMs > 90_000;
  const refocusHint = focusedAfterStart && elapsedMs > 5_000;

  if (compact) {
    return (
      <div
        aria-live="polite"
        className="flex w-full items-center gap-2 text-xs text-muted-foreground"
      >
        <LoaderCircle className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
        <span className="flex-1 truncate">
          Waiting for {displayName} authorization…
        </span>
        <span className="tabular-nums opacity-70">{formatRemaining(remainingMs)}</span>
        <Button
          aria-label="Cancel connection"
          className="ml-1 h-6 px-2 text-xs"
          onClick={onCancel}
          size="sm"
          title="Cancel"
          type="button"
          variant="ghost"
        >
          <X className="size-3" />
        </Button>
      </div>
    );
  }

  return (
    <div aria-live="polite" className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
        <span className="flex-1 truncate text-sm font-medium text-foreground">
          Waiting for {displayName} authorization…
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatRemaining(remainingMs)} left
        </span>
        <Button
          className="h-7 px-3 text-xs"
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      <ProgressBar fraction={fraction} />
      {(showFirstHelper || refocusHint) && !showStrongerHelper ? (
        <div className="text-xs text-muted-foreground">
          {refocusHint
            ? `Did the ${displayName} window close before you finished? Cancel and try again.`
            : "If the authorization window didn't open, reopen it from your browser tabs."}
        </div>
      ) : null}
      {showStrongerHelper ? (
        <div className="text-xs text-amber-600 dark:text-amber-400">
          Still waiting. Cancel and reconnect if the {displayName} window isn't
          responding.
        </div>
      ) : null}
    </div>
  );
}

function ProgressBar({ fraction }: { fraction: number }) {
  return (
    <div
      aria-hidden="true"
      className="h-0.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full bg-foreground/30 transition-[width] duration-300 ease-out"
        style={{ width: `${Math.round(fraction * 100)}%` }}
      />
    </div>
  );
}

function formatRemaining(remainingMs: number): string {
  const totalSec = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

function useElapsedMs(): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  return elapsed;
}

function useReturnedToAppAfterStart(): boolean {
  const [returned, setReturned] = useState(false);
  useEffect(() => {
    const onFocus = () => setReturned(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return returned;
}
