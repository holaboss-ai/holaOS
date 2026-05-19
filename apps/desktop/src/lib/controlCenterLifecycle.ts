import { useEffect, useRef, useState } from "react";

export type LifecycleCardState = "starting" | "ready" | "error";
export type TaskActivitySignal = "none" | "waiting" | "running" | "failed";

export interface ControlCenterCardSignal {
  lifecycle: LifecycleCardState;
  taskActivity: TaskActivitySignal;
}

// Compact-payload polling cadence. The desktop main process collapses the
// per-workspace lifecycle + background-task probes into a single IPC with
// only the booleans/counts the cards need, so a tighter loop is affordable
// (vs the previous 30s window that surfaced "Running" tasks too late).
const POLL_INTERVAL_MS = 10_000;

export function taskActivityFromCounts(
  counts: WorkspaceCardSummaryTaskCountsPayload,
): TaskActivitySignal {
  if (counts.waiting_on_user > 0) return "waiting";
  if (counts.running > 0 || counts.queued > 0) return "running";
  if (counts.failed > 0) return "failed";
  return "none";
}

export function cardSignalFromSummary(
  summary: WorkspaceCardSummaryPayload,
): ControlCenterCardSignal {
  return {
    lifecycle: summary.lifecycle,
    taskActivity: taskActivityFromCounts(summary.task_counts),
  };
}

export function useControlCenterCardSignals(
  workspaceIds: readonly string[],
  enabled: boolean,
): Record<string, ControlCenterCardSignal> {
  const [signals, setSignals] = useState<
    Record<string, ControlCenterCardSignal>
  >({});
  const idsKey = workspaceIds.join("|");
  const idsRef = useRef<readonly string[]>(workspaceIds);
  idsRef.current = workspaceIds;

  useEffect(() => {
    if (!enabled || workspaceIds.length === 0) {
      return;
    }

    let cancelled = false;

    const probe = async () => {
      const targets = idsRef.current
        .map((id) => id.trim())
        .filter(Boolean);
      if (targets.length === 0) return;
      let response: WorkspaceCardSummariesResponsePayload;
      try {
        response =
          await window.electronAPI.workspace.listWorkspaceCardSummaries(
            targets,
          );
      } catch {
        return;
      }
      if (cancelled) return;
      setSignals((prev) => {
        const next = { ...prev };
        for (const summary of response.summaries) {
          const id = summary.workspace_id.trim();
          if (!id) continue;
          next[id] = cardSignalFromSummary(summary);
        }
        return next;
      });
    };

    void probe();

    const tick = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      void probe();
    };

    const intervalId = window.setInterval(tick, POLL_INTERVAL_MS);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void probe();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, idsKey, workspaceIds.length]);

  return signals;
}
