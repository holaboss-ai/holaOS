import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/**
 * Bridges the host op `window.__holabossHost.employees.changed` into the shell.
 * The HolaEmployee `/employees` web surface calls it after creating, renaming,
 * or archiving an employee; main relays `host:employeesChanged`, and here we
 * invalidate the roster query so the sidebar reflects the change immediately.
 *
 * Needed because that surface writes straight to the gateway over HTTP — those
 * mutations never pass through this desktop bridge, so without this nudge the
 * cached sidebar roster would stay stale until it happened to refetch. Mount
 * once at the shell root.
 */
export function useHostEmployeesChanged(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const off = window.electronAPI?.host?.onEmployeesChanged?.(() => {
      void queryClient.invalidateQueries({
        queryKey: ["holaemployee", "employees"],
      });
    });
    return off;
  }, [queryClient]);
}
