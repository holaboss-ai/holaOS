import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Self-contained proposals subscription for the new shell — polls every
 * 5 s and exposes accept / dismiss handlers. The old AppShell threads
 * the same flow through dozens of locally-managed state slots; this
 * hook reproduces the pieces OperationsInboxPane needs without
 * lifting them to a shared layer (yet).
 */
export function useTaskProposals(workspaceId: string | null) {
  const [proposals, setProposals] = useState<TaskProposalRecordPayload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [action, setAction] = useState<{
    proposalId: string;
    action: "accept" | "dismiss";
  } | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      if (!workspaceId) {
        if (!signal.cancelled) setProposals([]);
        return;
      }
      try {
        const response =
          await window.electronAPI.workspace.listTaskProposals(workspaceId);
        if (!signal.cancelled) setProposals(response.proposals);
      } catch (error) {
        if (!signal.cancelled) {
          setStatusMessage(
            error instanceof Error ? error.message : "Failed to load proposals",
          );
        }
      } finally {
        if (!signal.cancelled) setIsLoading(false);
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    cancelledRef.current = false;
    const signal = { cancelled: false };

    if (!workspaceId) {
      setProposals([]);
      setStatusMessage("");
      setIsLoading(false);
      return () => {
        signal.cancelled = true;
      };
    }

    setIsLoading(true);
    void load(signal);
    const timer = window.setInterval(() => {
      setIsLoading(true);
      void load(signal);
    }, 5000);

    return () => {
      signal.cancelled = true;
      cancelledRef.current = true;
      window.clearInterval(timer);
    };
  }, [workspaceId, load]);

  const accept = useCallback(
    async (proposal: TaskProposalRecordPayload) => {
      setAction({ proposalId: proposal.proposal_id, action: "accept" });
      setStatusMessage("");
      try {
        const accepted = await window.electronAPI.workspace.acceptTaskProposal({
          proposal_id: proposal.proposal_id,
          workspace_id: proposal.workspace_id,
          task_name: proposal.task_name,
          task_prompt: proposal.task_prompt,
          parent_session_id: null,
          priority: 0,
          model: "",
        });
        setStatusMessage(
          accepted.input.status === "QUEUED"
            ? `Started background task "${proposal.task_name}".`
            : `Accepted "${proposal.task_name}" as background work.`,
        );
        const signal = { cancelled: cancelledRef.current };
        await load(signal);
      } catch (error) {
        setStatusMessage(
          error instanceof Error ? error.message : "Accept failed",
        );
      } finally {
        setAction(null);
      }
    },
    [load],
  );

  const dismiss = useCallback(
    async (proposal: TaskProposalRecordPayload) => {
      setAction({ proposalId: proposal.proposal_id, action: "dismiss" });
      setStatusMessage("");
      try {
        await window.electronAPI.workspace.updateTaskProposalState(
          proposal.workspace_id,
          proposal.proposal_id,
          "dismissed",
        );
        setStatusMessage(`Dismissed "${proposal.task_name}".`);
        const signal = { cancelled: cancelledRef.current };
        await load(signal);
      } catch (error) {
        setStatusMessage(
          error instanceof Error ? error.message : "Dismiss failed",
        );
      } finally {
        setAction(null);
      }
    },
    [load],
  );

  return {
    proposals,
    isLoading,
    statusMessage,
    action,
    accept,
    dismiss,
  };
}
