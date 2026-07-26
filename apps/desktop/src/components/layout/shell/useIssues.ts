import { useCallback, useEffect, useMemo, useState } from "react";

export interface SidebarIssueListItem {
  issue: IssueRecordPayload;
}

export function useIssueWorkspaceData(workspaceId: string | null) {
  const [issues, setIssues] = useState<IssueRecordPayload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  const refresh = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!workspaceId) {
        if (!signal.cancelled) {
          setIssues([]);
        }
        return;
      }

      try {
        const issueResponse = await window.electronAPI.workspace.listIssues(workspaceId);
        if (signal.cancelled) return;
        setIssues(issueResponse.issues);
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
    isLoading,
    statusMessage,
    refresh: () => refresh({ cancelled: false }),
  };
}

export function useIssues(workspaceId: string | null) {
  const { issues, isLoading, statusMessage, refresh } =
    useIssueWorkspaceData(workspaceId);

  const items = useMemo<SidebarIssueListItem[]>(
    () =>
      issues.map((issue) => ({
        issue,
      })),
    [issues],
  );

  return {
    issues: items,
    rawIssues: issues,
    isLoading,
    statusMessage,
    refresh,
  };
}
