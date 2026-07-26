import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useDesktopAuthSession } from "./authClient";
import { ORG_ACTIVE_KEY } from "./useOrganizations";

// Native org member management, mirroring the web org panel. The member +
// invitation LIST comes from the active org (getFullOrganization returns both,
// via the same IPC + query cache as useOrganizations); the four mutations go
// through dedicated IPC handlers over the main-process Better-Auth org client.
// Authorization (admin+ to manage, never touch owner) is enforced server-side;
// we also gate the UI locally so managers only see the affordances.

export type AssignableRole = "admin" | "member";
export const ASSIGNABLE_ROLES: AssignableRole[] = ["admin", "member"];

export type MutationResult = { ok: boolean; error?: string };

function roleRank(role?: string | null): number {
  if (role === "owner") {
    return 3;
  }
  if (role === "admin") {
    return 2;
  }
  if (role === "member") {
    return 1;
  }
  return 0;
}

const UNAVAILABLE: MutationResult = {
  ok: false,
  error: "Authentication is not available.",
};

export interface UseOrgMembersResult {
  activeOrg: DesktopActiveOrganizationPayload | null;
  members: DesktopOrgMemberPayload[];
  /** Pending invitations only. */
  invitations: DesktopOrgInvitationPayload[];
  userId: string | undefined;
  myRole: string | undefined;
  /** True when the caller is admin+ (may manage members/invitations). */
  canManage: boolean;
  isPending: boolean;
  busy: boolean;
  invite: (email: string, role: AssignableRole) => Promise<MutationResult>;
  removeMember: (memberIdOrEmail: string) => Promise<MutationResult>;
  updateRole: (
    memberId: string,
    role: AssignableRole,
  ) => Promise<MutationResult>;
  cancelInvite: (invitationId: string) => Promise<MutationResult>;
}

export function useOrgMembers(): UseOrgMembersResult {
  const queryClient = useQueryClient();
  const { data: session } = useDesktopAuthSession();
  const userId = session?.user?.id;

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

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ORG_ACTIVE_KEY }),
    [queryClient],
  );

  const inviteMutation = useMutation({
    mutationFn: (payload: { email: string; role: AssignableRole }) =>
      window.electronAPI?.auth
        ? window.electronAPI.auth.inviteOrgMember(payload)
        : Promise.resolve(UNAVAILABLE),
    onSuccess: invalidate,
  });
  const removeMutation = useMutation({
    mutationFn: (memberIdOrEmail: string) =>
      window.electronAPI?.auth
        ? window.electronAPI.auth.removeOrgMember(memberIdOrEmail)
        : Promise.resolve(UNAVAILABLE),
    onSuccess: invalidate,
  });
  const roleMutation = useMutation({
    mutationFn: (payload: { memberId: string; role: AssignableRole }) =>
      window.electronAPI?.auth
        ? window.electronAPI.auth.updateOrgMemberRole(payload)
        : Promise.resolve(UNAVAILABLE),
    onSuccess: invalidate,
  });
  const cancelMutation = useMutation({
    mutationFn: (invitationId: string) =>
      window.electronAPI?.auth
        ? window.electronAPI.auth.cancelOrgInvitation(invitationId)
        : Promise.resolve(UNAVAILABLE),
    onSuccess: invalidate,
  });

  const activeOrg = activeQuery.data ?? null;
  const members = activeOrg?.members ?? [];
  const invitations = (activeOrg?.invitations ?? []).filter(
    (invite) => invite.status === "pending",
  );
  const myRole = members.find((member) => member.userId === userId)?.role;
  const canManage = roleRank(myRole) >= roleRank("admin");
  const busy =
    inviteMutation.isPending ||
    removeMutation.isPending ||
    roleMutation.isPending ||
    cancelMutation.isPending;

  const invite = useCallback(
    (email: string, role: AssignableRole) =>
      inviteMutation.mutateAsync({ email, role }),
    [inviteMutation],
  );
  const removeMember = useCallback(
    (memberIdOrEmail: string) => removeMutation.mutateAsync(memberIdOrEmail),
    [removeMutation],
  );
  const updateRole = useCallback(
    (memberId: string, role: AssignableRole) =>
      roleMutation.mutateAsync({ memberId, role }),
    [roleMutation],
  );
  const cancelInvite = useCallback(
    (invitationId: string) => cancelMutation.mutateAsync(invitationId),
    [cancelMutation],
  );

  return {
    activeOrg,
    members,
    invitations,
    userId,
    myRole,
    canManage,
    isPending: activeQuery.isPending,
    busy,
    invite,
    removeMember,
    updateRole,
    cancelInvite,
  };
}
