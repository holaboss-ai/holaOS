import type { EvaluationRun } from "@holaboss/remote-api/contract";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Loader2, Play, RotateCw, Square } from "@/components/ui/icons";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { useInvalidateEvaluation } from "./data";
import {
  type EvaluationDetail,
  errorMessage,
  formatScalar,
  isActiveRun,
  isRecord,
  RUN_KIND_LABELS,
  readProgress,
  readTarget,
  runStatus,
} from "./format";
import { MetaChip, ProgressBar, StatusPill } from "./parts";

const KIND_ORDER = ["speed", "capability", "agent"];
const MAX_SUMMARY_ENTRIES = 4;

interface RunGroup {
  key: string;
  label: string;
  model: string;
  fromProposal: boolean;
  runs: EvaluationRun[];
}

function groupRuns(runs: EvaluationRun[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  for (const run of runs) {
    let group = groups.get(run.run_key);
    if (!group) {
      const target = readTarget(run.spec.target);
      group = {
        key: run.run_key,
        label: run.label,
        model: target?.model_id ?? "",
        fromProposal: false,
        runs: [],
      };
      groups.set(run.run_key, group);
    }
    group.runs.push(run);
    if (run.proposal_id) {
      group.fromProposal = true;
    }
  }
  for (const group of groups.values()) {
    group.runs.sort(
      (a, b) => kindRank(a.kind) - kindRank(b.kind) || a.created_at.localeCompare(b.created_at),
    );
  }
  return Array.from(groups.values());
}

function kindRank(kind: string): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

function summaryEntries(run: EvaluationRun): Array<[string, string]> {
  if (!isRecord(run.summary)) {
    return [];
  }
  return Object.entries(run.summary)
    .filter(
      ([, value]) =>
        typeof value === "number" ||
        typeof value === "string" ||
        typeof value === "boolean",
    )
    .slice(0, MAX_SUMMARY_ENTRIES)
    .map(([key, value]) => [key.replace(/_/g, " "), formatScalar(value)]);
}

export function RunsSection({
  detail,
  onGoToPlan,
}: {
  detail: EvaluationDetail;
  onGoToPlan: () => void;
}) {
  const evalId = detail.evaluation.eval_id;
  const invalidate = useInvalidateEvaluation(evalId);
  const groups = useMemo(() => groupRuns(detail.runs), [detail.runs]);
  const active = detail.runs.some(isActiveRun);
  const [confirmStop, setConfirmStop] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const cancelMutation = useMutation(
    remoteApiQuery.evals.cancel.mutationOptions({
      onSuccess: (next) => invalidate({ detail: next }),
      onError: (cause) =>
        toast.error(errorMessage(cause, "Couldn't stop the evaluation.")),
    }),
  );
  const retryMutation = useMutation(
    remoteApiQuery.evals.retryRun.mutationOptions({
      onSuccess: (next) => invalidate({ detail: next }),
      onError: (cause) => toast.error(errorMessage(cause, "Couldn't retry the run.")),
      onSettled: () => setRetryingId(null),
    }),
  );

  if (detail.runs.length === 0) {
    const canStart =
      detail.evaluation.status === "draft" ||
      detail.evaluation.status === "planned";
    return (
      <EmptyState
        action={
          canStart ? (
            <Button onClick={onGoToPlan} size="sm" type="button" variant="outline">
              <Play className="size-3.5" />
              Go to the plan
            </Button>
          ) : undefined
        }
        description="Runs appear here once the evaluation starts. They run one at a time in the background."
        size="sm"
        title="Nothing has run yet"
      />
    );
  }

  const doneCount = detail.runs.filter((run) => run.status === "done").length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs tabular-nums">
          {doneCount} of {detail.runs.length} done
        </span>
        <div className="flex-1" />
        {active ? (
          <Button
            disabled={cancelMutation.isPending}
            onClick={() => setConfirmStop(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            {cancelMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Square className="size-3.5" />
            )}
            Stop evaluation
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        confirmLabel="Stop"
        description="Runs in progress are cancelled. Finished runs keep their results, and you can retry cancelled runs later."
        destructive
        onConfirm={() => {
          cancelMutation.mutate({ evalId });
          setConfirmStop(false);
        }}
        onOpenChange={setConfirmStop}
        open={confirmStop}
        title="Stop this evaluation?"
      />

      {groups.map((group) => (
        <section
          className="overflow-hidden rounded-xl border border-border bg-card"
          key={group.key}
        >
          <header className="flex min-w-0 items-center gap-2 border-border border-b px-4 py-2">
            <span className="truncate font-medium text-foreground text-sm">
              {group.label}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              {group.key}
            </span>
            {group.fromProposal ? <MetaChip>Follow-up</MetaChip> : null}
            {group.model ? (
              <span className="ml-auto truncate text-muted-foreground text-xs">
                {group.model}
              </span>
            ) : null}
          </header>
          <ul className="divide-y divide-border">
            {group.runs.map((run) => (
              <RunRow
                key={run.run_id}
                onRetry={() => {
                  setRetryingId(run.run_id);
                  retryMutation.mutate({ evalId, runId: run.run_id });
                }}
                retrying={retryingId === run.run_id}
                run={run}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function RunRow({
  run,
  retrying,
  onRetry,
}: {
  run: EvaluationRun;
  retrying: boolean;
  onRetry: () => void;
}) {
  const status = runStatus(run.status);
  const progress = readProgress(run);
  const summary = run.status === "done" ? summaryEntries(run) : [];
  const canRetry = run.status === "failed" || run.status === "cancelled";
  const total = progress?.total ?? 0;
  const done = run.status === "done" && total > 0 ? total : (progress?.done ?? 0);

  return (
    <li className="flex flex-col gap-1.5 px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className="w-20 shrink-0 font-medium text-foreground text-xs">
          {RUN_KIND_LABELS[run.kind] ?? run.kind}
        </span>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {total > 0 ? (
            <>
              <ProgressBar
                done={done}
                tone={
                  run.status === "done"
                    ? "success"
                    : run.status === "failed"
                      ? "danger"
                      : run.status === "running"
                        ? "active"
                        : "neutral"
                }
                total={total}
              />
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {done}/{total}
              </span>
            </>
          ) : null}
        </div>
        {canRetry ? (
          <Button
            disabled={retrying}
            onClick={onRetry}
            size="xs"
            type="button"
            variant="ghost"
          >
            {retrying ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RotateCw className="size-3" />
            )}
            Retry
          </Button>
        ) : null}
      </div>
      {run.error ? (
        <p className="break-words pl-[92px] text-destructive text-xs leading-5">
          {run.error}
        </p>
      ) : progress?.lastLine && run.status !== "done" ? (
        <p
          className="truncate pl-[92px] font-mono text-[11px] text-muted-foreground"
          title={progress.lastLine}
        >
          {progress.lastLine}
        </p>
      ) : null}
      {summary.length > 0 ? (
        <p className="flex flex-wrap gap-x-3 pl-[92px] text-[11px] text-muted-foreground">
          {summary.map(([key, value]) => (
            <span key={key}>
              {key} <span className="text-foreground tabular-nums">{value}</span>
            </span>
          ))}
        </p>
      ) : null}
    </li>
  );
}
