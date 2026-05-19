import { Check, Lightbulb, Loader2, PencilLine, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function memoryProposalStateLabel(state: MemoryUpdateProposalState) {
  switch (state) {
    case "accepted":
      return "Saved";
    case "dismissed":
      return "Dismissed";
    default:
      return "Review";
  }
}

export function AssistantTurnMemoryProposals({
  proposals,
  proposalAction,
  editingProposalId,
  drafts,
  onEditProposal,
  onDraftChange,
  onAcceptProposal,
  onDismissProposal,
}: {
  proposals: MemoryUpdateProposalRecordPayload[];
  proposalAction: { proposalId: string; action: "accept" | "dismiss" } | null;
  editingProposalId: string | null;
  drafts: Record<string, string>;
  onEditProposal: (proposalId: string) => void;
  onDraftChange: (proposalId: string, value: string) => void;
  onAcceptProposal: (proposal: MemoryUpdateProposalRecordPayload) => void;
  onDismissProposal: (proposal: MemoryUpdateProposalRecordPayload) => void;
}) {
  return (
    <div className="mt-4 grid gap-3">
      {proposals.map((proposal) => {
        const isPending = proposal.state === "pending";
        const isEditing = editingProposalId === proposal.proposal_id;
        const isActing = proposalAction?.proposalId === proposal.proposal_id;
        const draftValue = drafts[proposal.proposal_id] ?? proposal.summary;

        return (
          <article
            key={proposal.proposal_id}
            className="bg-card rounded-2xl border border-border px-4 py-4 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Lightbulb className="size-4 shrink-0 text-primary" />
                  <span>{proposal.title}</span>
                </div>
                {isEditing ? (
                  <textarea
                    value={draftValue}
                    onChange={(event) =>
                      onDraftChange(proposal.proposal_id, event.target.value)
                    }
                    className="bg-muted mt-3 min-h-[86px] w-full rounded-xl border border-border px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary"
                  />
                ) : (
                  <div className="mt-3 text-sm leading-6 text-muted-foreground">
                    {proposal.summary}
                  </div>
                )}
                {proposal.evidence ? (
                  <div className="mt-3 text-xs leading-5 text-muted-foreground">
                    {proposal.evidence}
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 items-start gap-2">
                <Badge variant="outline" className="uppercase">
                  {memoryProposalStateLabel(proposal.state)}
                </Badge>
                {isPending ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => onEditProposal(proposal.proposal_id)}
                    className="rounded-xl"
                    aria-label="Edit memory proposal"
                  >
                    <PencilLine className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>

            {isPending ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => onDismissProposal(proposal)}
                  disabled={isActing}
                  className="rounded-2xl"
                >
                  {isActing && proposalAction?.action === "dismiss" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <X className="size-3" />
                  )}
                  <span>Dismiss</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={() => onAcceptProposal(proposal)}
                  disabled={isActing}
                  className="rounded-2xl border-primary bg-primary/10 text-primary hover:bg-primary/14"
                >
                  {isActing && proposalAction?.action === "accept" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Check className="size-3" />
                  )}
                  <span>Accept</span>
                </Button>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
