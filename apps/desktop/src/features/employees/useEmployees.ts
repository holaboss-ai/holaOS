// The active-org HolaEmployee roster + a selected employee's desktop threads, fetched
// over the main-process gateway bridge (window.electronAPI.holaemployee.*). Server data
// → TanStack Query (the desktop convention), keyed under "holaemployee".

import { useQuery } from "@tanstack/react-query";
import { useOrganizations } from "@/lib/auth/useOrganizations";

export function useHolaEmployees() {
  // Employees are org-scoped (the gateway injects the active org from the
  // session). Key by the active org so switching orgs refetches instead of
  // serving the previous org's roster from cache.
  //
  // Creates/renames/archives happen in the web `/employees` surface, which
  // writes straight to the gateway and never touches this bridge — so the
  // roster is refetched on demand via the host-bridge `employees.changed`
  // event (see useHostEmployeesChanged), not by polling.
  const { activeOrg } = useOrganizations();
  return useQuery({
    queryKey: ["holaemployee", "employees", activeOrg?.id ?? "personal"],
    queryFn: () => window.electronAPI.holaemployee.listEmployees(),
    staleTime: 30_000,
  });
}

/** The employee's equipped skills / capabilities / integrations, for the chat
 *  composer's "+" menu. Read-only reflection of the employee's standing config. */
export function useEmployeeEquipment(employeeId: string | null) {
  return useQuery({
    queryKey: ["holaemployee", "equipment", employeeId ?? ""],
    queryFn: () =>
      employeeId
        ? window.electronAPI.holaemployee.getEquipment(employeeId)
        : Promise.resolve({ skills: [], capabilities: [], integrations: [] }),
    enabled: Boolean(employeeId),
    staleTime: 60_000,
  });
}

export function useEmployeeThreads(employeeId: string | null) {
  return useQuery({
    queryKey: ["holaemployee", "threads", employeeId ?? ""],
    queryFn: () =>
      employeeId
        ? window.electronAPI.holaemployee.listThreads(employeeId)
        : Promise.resolve([]),
    enabled: Boolean(employeeId),
    staleTime: 10_000,
  });
}
