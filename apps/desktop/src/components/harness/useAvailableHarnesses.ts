import { useCallback, useEffect, useState } from "react";

/**
 * Fetches the runtime's harness inventory and tracks loading / error
 * state. The runtime probes PATH for each CLI's binary and caches for
 * 60s; we just refetch on workspace change.
 *
 * Callers typically use this to populate a per-session harness picker:
 * the user picks one at session creation and the chosen `id` is sent in
 * `createMainSession({ harness_id })`.
 */
export interface AvailableHarnessesState {
  harnesses: HarnessAvailabilityEntryPayload[];
  isLoading: boolean;
  error: string | null;
  /** Re-fetch the harness inventory and return the fresh list (so callers
   *  that test a single harness can read its updated availability). */
  refresh: () => Promise<HarnessAvailabilityEntryPayload[]>;
}

export function useAvailableHarnesses(
  workspaceId: string | null,
): AvailableHarnessesState {
  const [harnesses, setHarnesses] = useState<HarnessAvailabilityEntryPayload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setHarnesses([]);
      setError(null);
      return [];
    }
    setIsLoading(true);
    setError(null);
    try {
      const response =
        await window.electronAPI.workspace.listHarnessAvailability(workspaceId);
      const next = response.harnesses ?? [];
      setHarnesses(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load harnesses");
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { harnesses, isLoading, error, refresh };
}
