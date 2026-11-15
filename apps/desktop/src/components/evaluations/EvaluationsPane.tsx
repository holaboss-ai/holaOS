import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSetAtom } from "jotai";
import { useState } from "react";
import { toast } from "sonner";
import { notifyMainSessionsChanged } from "@/components/layout/shell/useWorkspaceLists";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import {
  AlertTriangle,
  BarChart3,
  MoreHorizontal,
  Plus,
  RotateCw,
  Trash2,
  Upload,
} from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-shell";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { cn } from "@/lib/utils";
import {
  type EvaluationSummary,
  errorMessage,
  evalStatus,
  pluralize,
  questionTypeLabel,
  relativeTime,
} from "./format";
import { StatusPill } from "./parts";
import { BenchmarkRunList } from "./BenchmarkRunList";
import { ReproduceDialog } from "./ReproduceDialog";
import { RunBenchmarkButton } from "./RunBenchmarkButton";
import { newEvaluationDialogOpenAtom } from "./state";
import { useOpenEvaluation } from "./useOpenEvaluation";

const LIST_POLL_MS = 4000;
const BENCH_POLL_MS = 15_000;

function isBusy(evaluation: EvaluationSummary): boolean {
  return (
    evaluation.run_counts.running + evaluation.run_counts.queued > 0 ||
    evaluation.status === "running"
  );
}

export function EvaluationsPane() {
  const queryClient = useQueryClient();
  const openEvaluation = useOpenEvaluation();
  const setNewDialogOpen = useSetAtom(newEvaluationDialogOpenAtom);
  const [reproduceOpen, setReproduceOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<EvaluationSummary | null>(
    null,
  );

  const listQuery = useQuery(
    remoteApiQuery.evals.list.queryOptions({
      input: {},
      staleTime: 0,
      refetchInterval: (query) =>
        query.state.data?.evaluations.some(isBusy) ? LIST_POLL_MS : false,
    }),
  );
  const evaluations = listQuery.data?.evaluations ?? [];
  const benchQuery = useQuery(
    remoteApiQuery.bench.list.queryOptions({
      input: {},
      staleTime: 0,
      refetchInterval: BENCH_POLL_MS,
    }),
  );
  const benchRuns = benchQuery.data?.runs ?? [];

  const deleteMutation = useMutation(
    remoteApiQuery.evals.delete.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: remoteApiQuery.evals.list.key(),
        });
        notifyMainSessionsChanged();
      },
      onError: (cause) =>
        toast.error(errorMessage(cause, "Couldn't delete the evaluation.")),
    }),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        actions={
          <>
            <Button
              className="h-7 gap-1.5"
              onClick={() => setReproduceOpen(true)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Upload className="size-3.5" />
              Reproduce from report
            </Button>
            <RunBenchmarkButton />
            <Button
              className="h-7 gap-1.5"
              onClick={() => setNewDialogOpen(true)}
              size="sm"
              type="button"
            >
              <Plus className="size-3.5" />
              New evaluation
            </Button>
          </>
        }
        description="Test a model running on this machine and publish what you find."
        title="Evaluations"
      />

      <ReproduceDialog onOpenChange={setReproduceOpen} open={reproduceOpen} />

      <ConfirmDialog
        confirmLabel="Delete"
        description={
          pendingDelete
            ? `"${pendingDelete.title}", its results and its chat will be removed.`
            : undefined
        }
        destructive
        onConfirm={() => {
          if (pendingDelete) {
            deleteMutation.mutate({ evalId: pendingDelete.eval_id });
          }
          setPendingDelete(null);
        }}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        open={pendingDelete !== null}
        title="Delete this evaluation?"
      />

      <div className="min-h-0 w-full flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-6 pb-12">
          {benchRuns.length > 0 ? (
            <section className="mb-8 flex flex-col gap-2">
              <h2 className="font-medium text-muted-foreground text-xs">Benchmarks</h2>
              <BenchmarkRunList runs={benchRuns} />
            </section>
          ) : null}
          {benchRuns.length > 0 && evaluations.length > 0 ? (
            <h2 className="mb-2 font-medium text-muted-foreground text-xs">Evaluations</h2>
          ) : null}
          {listQuery.isPending ? (
            <ListSkeleton />
          ) : listQuery.isError ? (
            <EmptyState
              action={
                <Button
                  onClick={() => void listQuery.refetch()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RotateCw className="size-3.5" />
                  Try again
                </Button>
              }
              description={errorMessage(listQuery.error)}
              icon={AlertTriangle}
              size="md"
              title="Couldn't load evaluations"
            />
          ) : evaluations.length === 0 && benchRuns.length > 0 ? (
            <EmptyState
              action={
                <Button onClick={() => setNewDialogOpen(true)} size="sm" type="button" variant="outline">
                  <Plus className="size-3.5" />
                  New evaluation
                </Button>
              }
              description="For a deeper look than the benchmark, ask one question about a local model and the agent plans the tests."
              size="sm"
              title="No evaluations yet"
            />
          ) : evaluations.length === 0 ? (
            <EmptyState
              action={
                <div className="flex gap-2">
                  <RunBenchmarkButton />
                  <Button
                    onClick={() => setNewDialogOpen(true)}
                    size="sm"
                    type="button"
                  >
                    <Plus className="size-3.5" />
                    New evaluation
                  </Button>
                </div>
              }
              decorated
              description="Run the standard benchmark on a model in one click, or ask one question about a local model and let the agent plan the tests."
              icon={BarChart3}
              size="md"
              title="Nothing tested yet"
            />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {evaluations.map((evaluation) => (
                <EvaluationRow
                  evaluation={evaluation}
                  key={evaluation.eval_id}
                  onDelete={() => setPendingDelete(evaluation)}
                  onOpen={() => openEvaluation(evaluation)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function EvaluationRow({
  evaluation,
  onOpen,
  onDelete,
}: {
  evaluation: EvaluationSummary;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const status = evalStatus(evaluation.status);
  const counts = evaluation.run_counts;
  const busy = isBusy(evaluation);
  const meta: string[] = [questionTypeLabel(evaluation.question_type)];
  if (evaluation.relation === "version") {
    meta.push("New version");
  } else if (evaluation.relation === "reproduction") {
    meta.push("Reproduction");
  }
  if (evaluation.targets.length > 0) {
    meta.push(evaluation.targets.join(" vs "));
  }
  if (counts.total > 0) {
    meta.push(`${counts.done} of ${pluralize(counts.total, "run")} done`);
  }

  return (
    <li className="group relative transition-colors hover:bg-fg-2">
      <button
        aria-label={`Open ${evaluation.title}`}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onOpen}
        type="button"
      />
      <div className="pointer-events-none flex items-start gap-3 px-4 py-3 pr-12">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-foreground text-sm">
              {evaluation.title}
            </span>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
          </div>
          {evaluation.question.trim() !== evaluation.title.trim() ? (
            <p className="mt-0.5 truncate text-muted-foreground text-xs">
              {evaluation.question}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
            <span className="truncate">{meta.join(" · ")}</span>
            {counts.failed > 0 ? (
              <span className="font-medium text-destructive">
                · {counts.failed} failed
              </span>
            ) : null}
            {evaluation.pending_proposals > 0 ? (
              <span className="font-medium text-foreground">
                · {pluralize(evaluation.pending_proposals, "follow-up")} to
                review
              </span>
            ) : null}
            <span className={cn(busy && "text-info")}>
              · {busy ? "running now" : `updated ${relativeTime(evaluation.updated_at)}`}
            </span>
          </div>
        </div>
      </div>
      <div className="absolute top-2.5 right-2.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`Actions for ${evaluation.title}`}
                className="rounded-lg text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100"
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44" sideOffset={6}>
            <DropdownMenuItem disabled={busy} onClick={onDelete} variant="destructive">
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function ListSkeleton() {
  const widths = ["w-48", "w-64", "w-40"];
  return (
    <ul
      aria-busy="true"
      aria-label="Loading evaluations"
      className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
    >
      {widths.map((width) => (
        <li className="flex flex-col gap-2 px-4 py-3.5" key={width}>
          <div className={cn("h-3.5 animate-pulse rounded bg-fg-8", width)} />
          <div className="h-2.5 w-2/3 animate-pulse rounded bg-fg-6" />
        </li>
      ))}
    </ul>
  );
}
