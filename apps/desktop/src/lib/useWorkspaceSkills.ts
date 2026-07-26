import { useQuery } from "@tanstack/react-query";

export function workspaceSkillsKey(workspaceId: string | null) {
  return ["workspace-skills", workspaceId] as const;
}

/**
 * Shared source of truth for a workspace's installed skills. The list is read
 * from the workspace's `skills/` folder over IPC, so both the Installed rail
 * (`SkillsPane`) and the Marketplace badge (`SkillsStorePane`) observe the same
 * cache entry — invalidating `workspaceSkillsKey(id)` after an install / remove
 * / agent-driven create refreshes every view at once.
 */
export function useWorkspaceSkills(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceSkillsKey(workspaceId),
    enabled: Boolean(workspaceId),
    queryFn: async () => {
      if (!workspaceId) return null;
      const result =
        await window.electronAPI?.workspace?.listSkills?.(workspaceId);
      return result ?? null;
    },
  });
}
