import { useEffect, useMemo, useState } from "react";
import { Loader2, Paperclip, PencilLine, Square, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const ISSUE_STATUS_OPTIONS: Array<{
  value: IssueStatusPayload;
  label: string;
  disabled?: boolean;
}> = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress", disabled: true },
  { value: "in_review", label: "In review" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

const ISSUE_PRIORITY_OPTIONS: Array<{
  value: IssuePriorityPayload;
  label: string;
}> = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function issueStatusLabel(status: IssueStatusPayload): string {
  switch (status) {
    case "in_progress":
      return "In progress";
    case "in_review":
      return "In review";
    default:
      return status
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function issueStatusVariant(
  status: IssueStatusPayload,
): "success" | "warning" | "info" | "primary" | "muted" {
  switch (status) {
    case "done":
      return "success";
    case "blocked":
      return "warning";
    case "in_progress":
      return "primary";
    case "in_review":
      return "info";
    case "backlog":
      return "muted";
    case "todo":
    default:
      return "info";
  }
}

interface IssueThreadControlsProps {
  issue: IssueRecordPayload;
  teammates: TeammateRecordPayload[];
  isPending: boolean;
  errorMessage: string;
  onChangeStatus: (status: IssueStatusPayload) => Promise<void>;
  onChangeAssignee: (teammateId: string | null) => Promise<void>;
  onChangePriority: (priority: IssuePriorityPayload | null) => Promise<void>;
  onSaveDetails: (fields: {
    title: string;
    description: string | null;
    blockerReason: string | null;
  }) => Promise<boolean>;
  onStopIssueRun: () => Promise<void>;
}

export function IssueThreadControls({
  issue,
  teammates,
  isPending,
  errorMessage,
  onChangeStatus,
  onChangeAssignee,
  onChangePriority,
  onSaveDetails,
  onStopIssueRun,
}: IssueThreadControlsProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(issue.title);
  const [draftDescription, setDraftDescription] = useState(
    issue.description ?? "",
  );
  const [draftBlockerReason, setDraftBlockerReason] = useState(
    issue.blocker_reason ?? "",
  );
  const [localErrorMessage, setLocalErrorMessage] = useState("");

  useEffect(() => {
    setDraftTitle(issue.title);
    setDraftDescription(issue.description ?? "");
    setDraftBlockerReason(issue.blocker_reason ?? "");
    setLocalErrorMessage("");
    setDetailsOpen(false);
  }, [issue.blocker_reason, issue.description, issue.issue_id, issue.title]);

  const isRunning = Boolean(issue.active_subagent_id);
  const activeTeammates = useMemo(
    () =>
      [...teammates]
        .filter((teammate) => teammate.status === "active")
        .sort((left, right) => left.name.localeCompare(right.name)),
    [teammates],
  );
  const assigneeName = issue.assignee_teammate_id
    ? activeTeammates.find(
        (teammate) => teammate.teammate_id === issue.assignee_teammate_id,
      )?.name ?? "Assigned"
    : "Unassigned";
  const attachmentsLabel =
    issue.attachments.length === 1
      ? "1 attachment"
      : `${issue.attachments.length} attachments`;
  const statusOptions =
    issue.status === "backlog"
      ? [
          { value: "backlog", label: "Backlog (hidden)", disabled: true },
          ...ISSUE_STATUS_OPTIONS,
        ]
      : ISSUE_STATUS_OPTIONS;

  const handleSaveDetails = async () => {
    const normalizedTitle = draftTitle.trim();
    if (!normalizedTitle) {
      setLocalErrorMessage("Issue title is required.");
      return;
    }
    const normalizedBlockerReason = draftBlockerReason.trim();
    if (issue.status === "blocked" && !normalizedBlockerReason) {
      setLocalErrorMessage("Blocked issues need a blocker reason.");
      return;
    }
    setLocalErrorMessage("");
    const saved = await onSaveDetails({
      title: normalizedTitle,
      description: draftDescription.trim() || null,
      blockerReason:
        issue.status === "blocked" ? normalizedBlockerReason : null,
    });
    if (saved) {
      setDetailsOpen(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border bg-card/85 px-4 py-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="rounded-full">
              {issue.issue_id}
            </Badge>
            <span className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-1 text-[11px] text-foreground/60">
              <StatusDot
                variant={issueStatusVariant(issue.status)}
                pulse={issue.status === "in_progress"}
              />
              {issueStatusLabel(issue.status)}
            </span>
            {issue.priority ? (
              <span className="rounded-full bg-foreground/[0.05] px-2 py-1 text-[11px] text-foreground/60">
                {issue.priority.slice(0, 1).toUpperCase() + issue.priority.slice(1)}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-1 text-[11px] text-foreground/60">
              <UserRound className="size-3" />
              {assigneeName}
            </span>
            {issue.attachments.length > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-foreground/[0.05] px-2 py-1 text-[11px] text-foreground/60">
                <Paperclip className="size-3" />
                {attachmentsLabel}
              </span>
            ) : null}
          </div>

          <div className="mt-3 min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {issue.title || "Untitled issue"}
            </div>
            {issue.description ? (
              <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-foreground/58">
                {issue.description}
              </div>
            ) : null}
          </div>

          {issue.blocker_reason ? (
            <div className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-100/85">
              {issue.blocker_reason}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {isRunning ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onStopIssueRun()}
              disabled={isPending}
            >
              {isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Square className="size-4" />
              )}
              Stop
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLocalErrorMessage("");
              setDetailsOpen((current) => !current);
            }}
            disabled={isPending || isRunning}
          >
            <PencilLine className="size-4" />
            Edit details
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <Select
          value={issue.status}
          onValueChange={(value) => {
            if (!value) return;
            void onChangeStatus(value as IssueStatusPayload);
          }}
          disabled={isPending || isRunning}
        >
          <SelectTrigger className="h-8 w-full bg-card text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {statusOptions.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={issue.assignee_teammate_id ?? "__unassigned__"}
          onValueChange={(value) => {
            if (!value) return;
            void onChangeAssignee(
              value === "__unassigned__" ? null : value,
            );
          }}
          disabled={isPending || isRunning}
        >
          <SelectTrigger className="h-8 w-full bg-card text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="__unassigned__">Unassigned</SelectItem>
            {activeTeammates.map((teammate) => (
              <SelectItem
                key={teammate.teammate_id}
                value={teammate.teammate_id}
              >
                {teammate.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={issue.priority ?? "__none__"}
          onValueChange={(value) => {
            if (!value) return;
            void onChangePriority(
              value === "__none__" ? null : (value as IssuePriorityPayload),
            );
          }}
          disabled={isPending || isRunning}
        >
          <SelectTrigger className="h-8 w-full bg-card text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="__none__">No priority</SelectItem>
            {ISSUE_PRIORITY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isRunning ? (
        <div className="mt-3 text-xs text-foreground/48">
          Issue fields are locked while this run is active.
        </div>
      ) : null}

      {detailsOpen ? (
        <div className="mt-4 grid gap-3 border-t border-border/70 pt-4">
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
              Title
            </div>
            <Input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder="Issue title"
              className="h-9 bg-background"
            />
          </div>
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
              Description
            </div>
            <Textarea
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              placeholder="Add description..."
              className="min-h-[120px] resize-y bg-background"
            />
          </div>
          {issue.status === "blocked" ? (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                Blocker reason
              </div>
              <Textarea
                value={draftBlockerReason}
                onChange={(event) => setDraftBlockerReason(event.target.value)}
                placeholder="Why is this issue blocked?"
                className="min-h-[84px] resize-y bg-background"
              />
            </div>
          ) : null}
          {issue.attachments.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">
                Attachments
              </div>
              <div className="flex flex-wrap gap-2">
                {issue.attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className="inline-flex max-w-full items-center gap-1 rounded-full bg-foreground/[0.05] px-2.5 py-1 text-[11px] text-foreground/62"
                  >
                    <Paperclip className="size-3" />
                    <span className="truncate">{attachment.name}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <div
              className={cn(
                "min-h-[20px] text-xs",
                localErrorMessage || errorMessage
                  ? "text-destructive"
                  : "text-foreground/45",
              )}
            >
              {localErrorMessage || errorMessage || " "}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDraftTitle(issue.title);
                  setDraftDescription(issue.description ?? "");
                  setDraftBlockerReason(issue.blocker_reason ?? "");
                  setLocalErrorMessage("");
                  setDetailsOpen(false);
                }}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSaveDetails()}
                disabled={isPending}
              >
                {isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>
        </div>
      ) : errorMessage ? (
        <div className="mt-3 text-xs text-destructive">{errorMessage}</div>
      ) : null}
    </div>
  );
}
