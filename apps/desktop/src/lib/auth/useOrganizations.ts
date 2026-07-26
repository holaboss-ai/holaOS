import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

// Organization (tenant) context for the desktop. The active org lives on the
// Better-Auth session (`session.activeOrganizationId`); the frontend gateway
// reads it to inject `x-holaboss-org-id` on every proxied backend call — so
// switching the active org here silently re-scopes the whole app. All three
// operations go through the main-process auth IPC bridge (see
// electron/main.ts `auth:listOrganizations` / `auth:getActiveOrganization` /
// `auth:setActiveOrganization`), which owns the Better-Auth org client + cookie.

const ORG_LIST_KEY = ["desktop-organizations", "list"] as const;
/** Shared with useOrgMembers so the member/invitation list reuses this cache. */
export const ORG_ACTIVE_KEY = ["desktop-organizations", "active"] as const;

/** The personal org (a team-of-one) is created/backfilled by the backend with
 * the slug `personal-<userId>`. We treat *being in it* as NOT org-mode and
 * label it "Personal", regardless of its stored display name. */
export function isPersonalOrg(
  org: { slug?: string | null } | null | undefined,
): boolean {
  return typeof org?.slug === "string" && org.slug.startsWith("personal-");
}

/** Display label for an org in the profile selector — "Personal" for the
 * team-of-one, otherwise the org's name (falling back to a generic label). */
export function orgLabel(
  org: { name?: string | null; slug?: string | null } | null | undefined,
): string {
  if (!org || isPersonalOrg(org)) {
    return "Personal";
  }
  return org.name?.trim() || "Organization";
}

export interface UseOrganizationsResult {
  organizations: DesktopOrganizationPayload[];
  activeOrg: DesktopActiveOrganizationPayload | null;
  /** True when the active org is the user's personal (team-of-one) org, or
   * when no org is active yet — i.e. the desktop is NOT in org-mode. */
  isPersonal: boolean;
  isPending: boolean;
  switching: boolean;
  switchOrg: (
    organizationId: string | null,
  ) => Promise<DesktopActiveOrganizationPayload | null>;
}

export function useOrganizations(): UseOrganizationsResult {
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: ORG_LIST_KEY,
    queryFn: async (): Promise<DesktopOrganizationPayload[]> => {
      if (!window.electronAPI?.auth) {
        return [];
      }
      return window.electronAPI.auth.listOrganizations();
    },
    staleTime: 60_000,
  });

  const activeQuery = useQuery({
    queryKey: ORG_ACTIVE_KEY,
    queryFn: async (): Promise<DesktopActiveOrganizationPayload | null> => {
      if (!window.electronAPI?.auth) {
        return null;
      }
      return window.electronAPI.auth.getActiveOrganization();
    },
    staleTime: 60_000,
  });

  const switchMutation = useMutation({
    mutationFn: async (organizationId: string | null) => {
      if (!window.electronAPI?.auth) {
        return null;
      }
      return window.electronAPI.auth.setActiveOrganization(organizationId);
    },
    onSuccess: async () => {
      // Re-read both the active org (its id changed) and the list (membership
      // could differ). Callers that read org-scoped server data should refetch
      // their own queries too — switching the org re-scopes backend calls.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ORG_ACTIVE_KEY }),
        queryClient.invalidateQueries({ queryKey: ORG_LIST_KEY }),
      ]);
    },
  });

  const switchOrg = useCallback(
    (organizationId: string | null) =>
      switchMutation.mutateAsync(organizationId),
    [switchMutation],
  );

  const activeOrg = activeQuery.data ?? null;

  return {
    organizations: listQuery.data ?? [],
    activeOrg,
    // "Not in a real org" — personal team-of-one OR no active org resolved yet —
    // counts as personal mode (the org left column stays hidden, personal apps show).
    isPersonal: !activeOrg || isPersonalOrg(activeOrg),
    isPending: listQuery.isPending || activeQuery.isPending,
    switching: switchMutation.isPending,
    switchOrg,
  };
}
