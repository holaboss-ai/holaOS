import { useCallback, useEffect, useMemo, useState } from "react";

export interface SidebarIssueListItem {
  issue: IssueRecordPayload;
  assignee: TeammateRecordPayload | null;
}

export function useIssueWorkspaceData(workspaceId: string | null) {
  const [issues, setIssues] = useState<IssueRecordPayload[]>([]);
  const [teammatesById, setTeammatesById] = useState<
    Record<string, TeammateRecordPayload>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  const refresh = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!workspaceId) {
        if (!signal.cancelled) {
          setIssues([]);
          setTeammatesById({});
        }
        return;
      }

      try {
        const [issueResponse, teammateResponse] = await Promise.all([
          window.electronAPI.workspace.listIssues(workspaceId),
          window.electronAPI.workspace.listTeammates(workspaceId),
        ]);
        if (signal.cancelled) return;
        setIssues(issueResponse.issues);
        setTeammatesById(
          Object.fromEntries(
            teammateResponse.teammates.map((teammate) => [
              teammate.teammate_id,
              teammate,
            ]),
          ),
        );
        setStatusMessage("");
      } catch (error) {
        if (!signal.cancelled) {
          setStatusMessage(
            error instanceof Error ? error.message : "Failed to load issues",
          );
        }
      } finally {
        if (!signal.cancelled) {
          setIsLoading(false);
        }
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    const signal = { cancelled: false };

    if (!workspaceId) {
      setIssues([]);
      setTeammatesById({});
      setStatusMessage("");
      setIsLoading(false);
      return () => {
        signal.cancelled = true;
      };
    }

    setIsLoading(true);
    void refresh(signal);
    const timer = window.setInterval(() => {
      setIsLoading(true);
      void refresh(signal);
    }, 5000);

    return () => {
      signal.cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId, refresh]);

  return {
    issues,
    teammatesById,
    isLoading,
    statusMessage,
    refresh: () => refresh({ cancelled: false }),
  };
}

export function useIssues(workspaceId: string | null) {
  const { issues, teammatesById, isLoading, statusMessage, refresh } =
    useIssueWorkspaceData(workspaceId);

  const items = useMemo<SidebarIssueListItem[]>(
    () =>
      issues.map((issue) => ({
        issue,
        assignee: issue.assignee_teammate_id
          ? teammatesById[issue.assignee_teammate_id] ?? null
          : null,
      })),
    [issues, teammatesById],
  );

  return {
    issues: items,
    rawIssues: issues,
    teammatesById,
    isLoading,
    statusMessage,
    refresh,
  };
}
