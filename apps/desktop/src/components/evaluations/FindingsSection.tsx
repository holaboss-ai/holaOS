import type { EvaluationProposal } from "@holaboss/remote-api/contract";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Check, Loader2, X } from "@/components/ui/icons";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { useInvalidateEvaluation } from "./data";
import {
  AGENT_CONDITION_LABELS,
  type EvaluationDetail,
  errorMessage,
  formatMinutes,
  formatScalar,
  isRecord,
  pluralize,
  proposalStatus,
  RUN_KIND_LABELS,
  readTarget,
  relativeTime,
} from "./format";
import { StatusPill } from "./parts";

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  approved: 1,
  done: 2,
  rejected: 3,
};

export function FindingsSection({ detail }: { detail: EvaluationDetail }) {
  const evalId = detail.evaluation.eval_id;
  const invalidate = useInvalidateEvaluation(evalId);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const proposals = useMemo(
    () =>
      [...detail.proposals].sort(
        (a, b) =>
          (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
          b.created_at.localeCompare(a.created_at),
      ),
    [detail.proposals],
  );

  const decideMutation = useMutation(
    remoteApiQuery.evals.decideProposal.mutationOptions({
      onSuccess: (next) => invalidate({ detail: next }),
      onError: (cause) =>
        toast.error(errorMessage(cause, "Couldn't record your decision.")),
      onSettled: () => setDecidingId(null),
    }),
  );

  if (proposals.length === 0) {
    return (
      <EmptyState
        description="When a result looks off, the agent proposes a follow-up run that changes one thing and shows the evidence. It lands here for you to approve."
        size="sm"
        title="No follow-ups yet"
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {proposals.map((proposal) => (
        <ProposalCard
          deciding={decidingId === proposal.proposal_id}
          key={proposal.proposal_id}
          onDecide={(decision) => {
            setDecidingId(proposal.proposal_id);
            decideMutation.mutate({
              evalId,
              proposalId: proposal.proposal_id,
              decision,
            });
          }}
          proposal={proposal}
        />
      ))}
    </ul>
  );
}

function ProposalCard({
  proposal,
  deciding,
  onDecide,
}: {
  proposal: EvaluationProposal;
  deciding: boolean;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  const status = proposalStatus(proposal.status);
  const pending = proposal.status === "pending";
  const estimate = formatMinutes(proposal.estimate_minutes);

  return (
    <li className="rounded-xl border border-border bg-card">
      <header className="flex items-start gap-2 px-4 pt-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-foreground text-sm">
            {proposal.title}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {proposal.created_by === "agent"
              ? "Proposed by the agent"
              : proposal.created_by === "user"
                ? "Added by you"
                : "Proposed"}{" "}
            {relativeTime(proposal.created_at)}
            {estimate ? ` · ${estimate}` : ""}
          </p>
        </div>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
      </header>
      <div className="flex flex-col gap-3 px-4 py-3">
        {proposal.rationale.trim() ? (
          <p className="whitespace-pre-wrap text-foreground/85 text-sm leading-6">
            {proposal.rationale.trim()}
          </p>
        ) : null}
        {proposal.evidence.length > 0 ? (
          <Block title="Evidence">
            <div className="flex flex-col gap-1.5">
              {proposal.evidence.map((entry, index) => (
                <EvidenceEntry entry={entry} key={index} />
              ))}
            </div>
          </Block>
        ) : null}
        {proposal.runs.length > 0 ? (
          <Block title="Runs it adds">
            <ul className="flex flex-col gap-1">
              {proposal.runs.map((run, index) => (
                <li className="text-foreground/85 text-xs leading-5" key={index}>
                  {describeProposalRun(run)}
                </li>
              ))}
            </ul>
          </Block>
        ) : null}
      </div>
      {pending ? (
        <footer className="flex items-center justify-end gap-2 border-border border-t px-4 py-2">
          <Button
            disabled={deciding}
            onClick={() => onDecide("reject")}
            size="sm"
            type="button"
            variant="ghost"
          >
            <X className="size-3.5" />
            Reject
          </Button>
          <Button
            disabled={deciding}
            onClick={() => onDecide("approve")}
            size="sm"
            type="button"
          >
            {deciding ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            Approve and run
          </Button>
        </footer>
      ) : null}
    </li>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
        {title}
      </div>
      {children}
    </div>
  );
}

function EvidenceEntry({ entry }: { entry: unknown }) {
  if (!isRecord(entry)) {
    return (
      <p className="font-mono text-[11px] text-foreground/85 leading-5">
        {formatScalar(entry)}
      </p>
    );
  }
  return (
    <dl className="rounded-md bg-fg-2 px-2.5 py-1.5 font-mono text-[11px] leading-5">
      {Object.entries(entry).map(([key, value]) => (
        <div className="flex gap-2" key={key}>
          <dt className="shrink-0 text-muted-foreground">{key}:</dt>
          <dd className="min-w-0 break-words text-foreground/85">
            {formatScalar(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function describeProposalRun(run: unknown): string {
  if (!isRecord(run)) {
    return formatScalar(run);
  }
  const parts: string[] = [];
  const label = typeof run.label === "string" ? run.label : "";
  const key = typeof run.key === "string" ? run.key : "";
  if (label || key) {
    parts.push(key && label ? `${label} (${key})` : label || key);
  }
  const target = readTarget(run.target);
  if (target) {
    parts.push(target.model_id);
  }
  if (Array.isArray(run.kinds) && run.kinds.length > 0) {
    parts.push(
      run.kinds
        .map((kind) => (typeof kind === "string" ? (RUN_KIND_LABELS[kind] ?? kind) : ""))
        .filter(Boolean)
        .join(", "),
    );
  }
  if (Array.isArray(run.agent_conditions) && run.agent_conditions.length > 0) {
    parts.push(
      run.agent_conditions
        .map((condition) =>
          typeof condition === "string"
            ? (AGENT_CONDITION_LABELS[condition] ?? condition)
            : "",
        )
        .filter(Boolean)
        .join(" + "),
    );
  }
  if (isRecord(run.sampling)) {
    for (const [name, value] of Object.entries(run.sampling)) {
      if (value != null) {
        parts.push(`${name.replace("_", "-")} ${formatScalar(value)}`);
      }
    }
  }
  if (typeof run.samples === "number") {
    parts.push(pluralize(run.samples, "sample"));
  }
  return parts.length > 0 ? parts.join(" · ") : formatScalar(run);
}
