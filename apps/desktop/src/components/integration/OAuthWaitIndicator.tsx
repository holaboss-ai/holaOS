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
  onReopen,
  compact = false,
}: {
  displayName: string;
  onCancel: () => void;
  /** Optional handler to reopen the OAuth URL (e.g. user closed the tab or
   *  popup was blocked). When provided, surfaces a "Reopen" affordance from
   *  t=0 so users can recover without restarting the whole flow. */
  onReopen?: () => void;
  /** Inline-only variant — single row, no progress bar. */
  compact?: boolean;
}) {
  const elapsedMs = useElapsedMs();
  const focusedAfterStart = useReturnedToAppAfterStart();
  const remainingMs = Math.max(0, COMPOSIO_POLL_TIMEOUT_MS - elapsedMs);
  const fraction = Math.min(1, elapsedMs / COMPOSIO_POLL_TIMEOUT_MS);
  // Surface the "tab didn't open / lost track of it" hint much earlier
  // (12s instead of 30s). Most successful OAuths complete in 15-25s, so the
  // earlier hint catches the genuine "where did the window go?" case before
  // users give up and assume the app is broken.
  const showFirstHelper = elapsedMs > 12_000;
  const showStrongerHelper = elapsedMs > 90_000;
  // The user refocused the desktop window without finishing OAuth — likely
  // closed the tab. Surface immediately rather than waiting 5s.
  const refocusHint = focusedAfterStart;

  if (compact) {
    return (
      <div
        aria-live="polite"
        className="flex w-full items-center gap-2 text-xs text-muted-foreground"
      >
        <LoaderCircle className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
        <span className="flex-1 truncate">
          Finish authorizing {displayName} in your browser…
        </span>
        <span className="tabular-nums opacity-70">{formatRemaining(remainingMs)}</span>
        {onReopen ? (
          <Button
            aria-label={`Reopen ${displayName} authorization`}
            className="h-6 px-2 text-xs"
            onClick={onReopen}
            size="sm"
            title="Reopen authorization window"
            type="button"
            variant="ghost"
          >
            Reopen
          </Button>
        ) : null}
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
          Finish authorizing {displayName} in your browser…
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatRemaining(remainingMs)} left
        </span>
        {onReopen ? (
          <Button
            className="h-7 px-3 text-xs"
            onClick={onReopen}
            size="sm"
            type="button"
            variant="outline"
          >
            Reopen
          </Button>
        ) : null}
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
      <div className="text-xs text-muted-foreground">
        {showStrongerHelper
          ? `Still waiting. If the ${displayName} window isn't responding, cancel and reconnect.`
          : refocusHint
            ? `Did the ${displayName} tab close before you finished? Use Reopen to try again.`
            : showFirstHelper
              ? `If the ${displayName} tab didn't open, reopen it from your browser tabs${onReopen ? " or click Reopen above" : ""}.`
              : `A browser tab opened for ${displayName}. Sign in and approve access — we'll detect it automatically.`}
      </div>
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
