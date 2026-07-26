import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bossmanExperimentalEnabledAtom } from "@/components/layout/shell/state/ui";

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
  const [rawHarnesses, setRawHarnesses] = useState<HarnessAvailabilityEntryPayload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Experimental: hide Bossman unless the toggle is on. A ref keeps `refresh`
  // (memoized on workspaceId) filtering with the current value without a
  // re-fetch when the toggle flips; the derived `harnesses` re-filters live.
  const bossmanEnabled = useAtomValue(bossmanExperimentalEnabledAtom);
  const bossmanEnabledRef = useRef(bossmanEnabled);
  bossmanEnabledRef.current = bossmanEnabled;
  const filterList = useCallback(
    (list: HarnessAvailabilityEntryPayload[]): HarnessAvailabilityEntryPayload[] =>
      bossmanEnabledRef.current ? list : list.filter((h) => h.id !== "bossman"),
    [],
  );

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setRawHarnesses([]);
      setError(null);
      return [];
    }
    setIsLoading(true);
    setError(null);
    try {
      const response =
        await window.electronAPI.workspace.listHarnessAvailability(workspaceId);
      const next = response.harnesses ?? [];
      setRawHarnesses(next);
      return filterList(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load harnesses");
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, filterList]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const harnesses = useMemo(
    () => filterList(rawHarnesses),
    // re-filter when the raw list OR the toggle changes
    [rawHarnesses, filterList, bossmanEnabled],
  );

  return { harnesses, isLoading, error, refresh };
}
