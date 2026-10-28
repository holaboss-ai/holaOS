import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAtom, useSetAtom } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { workspaceOverlayAtom } from "@/components/layout/shell/state/ui";
import { useStartNewChat } from "@/components/layout/shell/useStartNewChat";
import { notifyMainSessionsChanged } from "@/components/layout/shell/useWorkspaceLists";
import { displayModelLabel } from "@/components/panes/ChatPane/helpers";

function analystModelLabel(token: string): string {
  const slash = token.indexOf("/");
  if (slash > 0 && token.startsWith("local_")) {
    return `${token.slice(slash + 1)} (local)`;
  }
  return displayModelLabel(token);
}
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
  ChevronLeft,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  RotateCw,
  Trash2,
} from "@/components/ui/icons";
import { RenameDialog } from "@/components/ui/rename-dialog";
import { remoteApiQuery } from "@/lib/remoteApiQuery";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { DistributeSection } from "./DistributeSection";
import {
  useEvaluationDetail,
  useInvalidateEvaluation,
  useRefreshOnSessionActivity,
} from "./data";
import { FindingsSection } from "./FindingsSection";
import {
  type EvaluationDetail,
  type EvaluationRecord,
  errorMessage,
  evalStatus,
  hasActiveRuns,
  isRecord,
  questionTypeLabel,
  readTarget,
} from "./format";
import { Callout, CountBadge, MetaChip, SegmentedControl, StatusPill } from "./parts";
import { PlanSection } from "./PlanSection";
import { ReportSection } from "./ReportSection";
import { RunsSection } from "./RunsSection";
import { type EvaluationSection, evaluationSectionByIdAtom } from "./state";
import { useOpenEvaluation } from "./useOpenEvaluation";

function defaultSection(status: string | undefined): EvaluationSection {
  switch (status) {
    case "running":
      return "runs";
    case "analyzing":
    case "published":
      return "report";
    default:
      return "plan";
  }
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "NOT_FOUND";
}

function evaluationTargets(detail: EvaluationDetail): string[] {
  const names = new Set<string>();
  for (const run of detail.evaluation.plan?.runs ?? []) {
    if (run.target?.model_id) {
      names.add(run.target.model_id);
    }
  }
  const extra = detail.evaluation.targets;
  if (names.size === 0 && Array.isArray(extra)) {
    for (const entry of extra) {
      const name =
        typeof entry === "string" ? entry : (readTarget(entry)?.model_id ?? "");
      if (name) {
        names.add(name);
      }
    }
  }
  return Array.from(names);
}

export function EvaluationDetailPane({
  evalId,
  onClose,
}: {
  evalId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const detailQuery = useEvaluationDetail(evalId);
  const invalidate = useInvalidateEvaluation(evalId);
  const detail = detailQuery.data;
  const evaluation = detail?.evaluation;

  useRefreshOnSessionActivity(evaluation?.session_id ?? null, () => {
    void invalidate();
  });

  const runsSignature =
    detail?.runs.map((run) => `${run.run_id}:${run.status}`).join("|") ?? "";
  const previousSignatureRef = useRef(runsSignature);
  useEffect(() => {
    if (previousSignatureRef.current === runsSignature) {
      return;
    }
    previousSignatureRef.current = runsSignature;
    void queryClient.invalidateQueries({
      queryKey: remoteApiQuery.evals.report.key({ input: { evalId } }),
    });
    void queryClient.invalidateQueries({
      queryKey: remoteApiQuery.evals.list.key(),
    });
  }, [evalId, queryClient, runsSignature]);

  const [sectionById, setSectionById] = useAtom(evaluationSectionByIdAtom);
  const section = sectionById[evalId] ?? defaultSection(evaluation?.status);
  const setSection = (next: EvaluationSection) =>
    setSectionById((prev) => ({ ...prev, [evalId]: next }));

  if (detailQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="size-3.5 animate-spin" />
        Loading evaluation…
      </div>
    );
  }

  if (!detail || !evaluation) {
    const missing = isNotFound(detailQuery.error);
    return (
      <EmptyState
        action={
          missing ? (
            <Button onClick={onClose} size="sm" type="button" variant="outline">
              Close tab
            </Button>
          ) : (
            <Button
              onClick={() => void detailQuery.refetch()}
              size="sm"
              type="button"
              variant="outline"
            >
              <RotateCw className="size-3.5" />
              Try again
            </Button>
          )
        }
        description={
          missing
            ? "It may have been deleted."
            : errorMessage(detailQuery.error)
        }
        icon={AlertTriangle}
        size="md"
        title={
          missing
            ? "This evaluation no longer exists"
            : "Couldn't load the evaluation"
        }
      />
    );
  }

  const activeRuns = detail.runs.filter(
    (run) => run.status === "queued" || run.status === "running",
  ).length;
  const failedRuns = detail.runs.filter((run) => run.status === "failed").length;
  const pendingProposals = detail.proposals.filter(
    (proposal) => proposal.status === "pending",
  ).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader
        detail={detail}
        evaluation={evaluation}
        onDeleted={onClose}
      />
      <div className="shrink-0 border-border border-b px-5 py-2">
        <SegmentedControl
          onChange={setSection}
          options={[
            { value: "plan", label: "Plan" },
            {
              value: "runs",
              label: (
                <>
                  Runs
                  {activeRuns > 0 ? (
                    <CountBadge count={activeRuns} />
                  ) : (
                    <CountBadge count={failedRuns} tone="danger" />
                  )}
                </>
              ),
            },
            {
              value: "findings",
              label: (
                <>
                  Findings
                  <CountBadge count={pendingProposals} tone="warning" />
                </>
              ),
            },
            { value: "report", label: "Report" },
            { value: "distribute", label: "Distribute" },
          ]}
          size="sm"
          value={section}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-5 py-4">
          {section === "plan" ? (
            <PlanSection detail={detail} onStarted={() => setSection("runs")} />
          ) : section === "runs" ? (
            <RunsSection detail={detail} onGoToPlan={() => setSection("plan")} />
          ) : section === "findings" ? (
            <FindingsSection detail={detail} />
          ) : section === "report" ? (
            <ReportSection detail={detail} />
          ) : (
            <DistributeSection evaluation={evaluation} />
          )}
        </div>
      </div>
    </div>
  );
}

function DetailHeader({
  detail,
  evaluation,
  onDeleted,
}: {
  detail: EvaluationDetail;
  evaluation: EvaluationRecord;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { startNewChat } = useStartNewChat(selectedWorkspaceId || null);
  const evalId = evaluation.eval_id;
  const invalidate = useInvalidateEvaluation(evalId);
  const openEvaluation = useOpenEvaluation();
  const setWorkspaceOverlay = useSetAtom(workspaceOverlayAtom);
  const [renameOpen, setRenameOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const status = evalStatus(evaluation.status);
  const targets = useMemo(() => evaluationTargets(detail), [detail]);
  const running = hasActiveRuns(detail.runs);

  const renameMutation = useMutation(
    remoteApiQuery.evals.update.mutationOptions({
      onSuccess: (updated) => invalidate({ evaluation: updated }),
      onError: (cause) => toast.error(errorMessage(cause, "Couldn't rename.")),
    }),
  );
  const deleteMutation = useMutation(
    remoteApiQuery.evals.delete.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: remoteApiQuery.evals.list.key(),
        });
        queryClient.removeQueries({
          queryKey: remoteApiQuery.evals.get.key({ input: { evalId } }),
        });
        notifyMainSessionsChanged();
        onDeleted();
        void startNewChat();
      },
      onError: (cause) =>
        toast.error(errorMessage(cause, "Couldn't delete the evaluation.")),
    }),
  );

  const openById = async (targetId: string) => {
    setOpeningId(targetId);
    try {
      const target = await queryClient.fetchQuery(
        remoteApiQuery.evals.get.queryOptions({ input: { evalId: targetId } }),
      );
      openEvaluation(target.evaluation);
    } catch (cause) {
      toast.error(errorMessage(cause, "Couldn't open that evaluation."));
    } finally {
      setOpeningId(null);
    }
  };

  const sourceUrl =
    isRecord(evaluation.source) && typeof evaluation.source.url === "string"
      ? evaluation.source.url
      : null;
  const isReproduction = evaluation.relation === "reproduction";
  const relationLabel = isReproduction
    ? "Reproduces a published report"
    : evaluation.parent_eval_id
      ? "New version of an earlier evaluation"
      : null;

  return (
    <div className="shrink-0 px-5 pt-3 pb-2.5">
      <button
        className="-ml-1 mb-1 inline-flex items-center gap-0.5 rounded px-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
        onClick={() => setWorkspaceOverlay("evaluations")}
        type="button"
      >
        <ChevronLeft className="size-3" />
        Evaluations
      </button>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate font-semibold text-foreground text-lg tracking-tight">
              {evaluation.title}
            </h1>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
          </div>
          {evaluation.question.trim() &&
          evaluation.question.trim() !== evaluation.title.trim() ? (
            <p className="mt-0.5 line-clamp-2 text-muted-foreground text-sm">
              {evaluation.question}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <MetaChip>{questionTypeLabel(evaluation.question_type)}</MetaChip>
            {targets.length > 0 ? (
              <MetaChip>
                <span className="truncate">{targets.join(" vs ")}</span>
              </MetaChip>
            ) : null}
            {evaluation.brain_model ? (
              <MetaChip>
                <span className="truncate">
                  Analyst: {analystModelLabel(evaluation.brain_model)}
                </span>
              </MetaChip>
            ) : null}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label="Evaluation actions"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44" sideOffset={6}>
            <DropdownMenuItem onClick={() => setRenameOpen(true)}>
              <Pencil className="size-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={running}
              onClick={() => setConfirmDelete(true)}
              variant="destructive"
            >
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {detail.newer_version_id ? (
        <div className="mt-2.5">
          <Callout
            action={
              <Button
                disabled={openingId !== null}
                onClick={() => {
                  if (detail.newer_version_id) {
                    void openById(detail.newer_version_id);
                  }
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                {openingId === detail.newer_version_id ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                Open newer version
              </Button>
            }
            icon={<History />}
            tone="warning"
          >
            This is an older version. A newer one exists.
          </Callout>
        </div>
      ) : null}

      {relationLabel ? (
        <p className="mt-2 text-muted-foreground text-xs">
          {relationLabel}
          {sourceUrl ? (
            <>
              {" · "}
              <button
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() =>
                  void window.electronAPI?.ui?.openExternalUrl(sourceUrl)
                }
                type="button"
              >
                original post
              </button>
            </>
          ) : null}
          {evaluation.parent_eval_id ? (
            <>
              {" · "}
              <button
                className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                disabled={openingId !== null}
                onClick={() => {
                  if (evaluation.parent_eval_id) {
                    void openById(evaluation.parent_eval_id);
                  }
                }}
                type="button"
              >
                open the earlier one
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      <RenameDialog
        confirmLabel="Rename"
        initial={evaluation.title}
        onConfirm={(next) => {
          setRenameOpen(false);
          renameMutation.mutate({ evalId, title: next.slice(0, 160) });
        }}
        onOpenChange={setRenameOpen}
        open={renameOpen}
        title="Rename evaluation"
      />
      <ConfirmDialog
        confirmLabel="Delete"
        description="Its plan, runs, report and chat are removed."
        destructive
        onConfirm={() => {
          setConfirmDelete(false);
          deleteMutation.mutate({ evalId });
        }}
        onOpenChange={setConfirmDelete}
        open={confirmDelete}
        title="Delete this evaluation?"
      />
    </div>
  );
}
