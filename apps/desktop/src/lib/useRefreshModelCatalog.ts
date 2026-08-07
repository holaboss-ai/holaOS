import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Resync the runtime model catalogue that backs every model selector.
 *
 * Calls the main-process refresh, which re-pulls the catalogue from the model
 * proxy / control plane and broadcasts a fresh `RuntimeConfigPayload`. The
 * `WorkspaceDesktop` provider's `onConfigChange` listener then updates
 * `runtimeConfig` for all consumers — so a single refresh propagates to the
 * chat composer, automation, and channel pickers without any per-selector
 * state plumbing.
 *
 * Returns a stable `refresh` callback plus a `refreshing` flag for the button's
 * spinner. Re-entrancy is guarded, so overlapping clicks coalesce into one call.
 */
export function useRefreshModelCatalog(): {
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      await window.electronAPI.runtime.refreshModelCatalog();
      toast.success("Models resynced");
    } catch (error) {
      toast.error("Couldn't resync models", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  return { refreshing, refresh };
}
