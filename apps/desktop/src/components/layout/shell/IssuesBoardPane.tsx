import {
  AlertCircle,
  CheckCircle2,
  Circle,
  CircleDot,
  Eye,
  Loader2,
  MessageSquareText,
  Play,
  Square,
  type IconType,
} from "@/components/ui/icons";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";
import { useIssueWorkspaceData } from "./useIssues";

type VisibleBoardStatus = Exclude<IssueStatusPayload, "backlog">;

function isVisibleBoardStatus(
  status: IssueStatusPayload,
): status is VisibleBoardStatus {
  return status !== "backlog";
}

const BOARD_STATUS_ORDER: VisibleBoardStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
];

const BOARD_STATUS_ICON: Record<VisibleBoardStatus, IconType> = {
  todo: Circle,
  in_progress: CircleDot,
  in_review: Eye,
  blocked: AlertCircle,
  done: CheckCircle2,
};

const BOARD_STATUS_ICON_CLASS: Record<VisibleBoardStatus, string> = {
  todo: "text-muted-foreground",
  in_progress: "text-primary",
  in_review: "text-info",
  blocked: "text-warning",
  done: "text-success",
};

function issueRelativeTime(value: string): string {
  const ms = Date.now() - Date.parse(value);
  if (Number.isNaN(ms)) return value;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function issueStatusLabel(status: IssueStatusPayload): string {
  switch (status) {
    case "in_progress":
      return "In Progress";
    case "in_review":
      return "In Review";
    case "blocked":
      return "Waiting";
    default:
      return status
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function issuePriorityLabel(priority: IssuePriorityPayload | null): string {
  if (!priority) return "None";
  return priority.slice(0, 1).toUpperCase() + priority.slice(1);
}

function issuePriorityRank(priority: IssuePriorityPayload | null): number {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

/**
 * Whether a blocked issue can be resumed with a one-click PATCH status=todo.
 *
 * The runtime auto-dispatches the issue when status transitions back to
 * `todo`, but `dispatchIssue` (runtime-agent-tools.ts) rejects 409
 * `issue_run_already_queued` if the latest subagent run is in
 * `queued | running | waiting_on_user`. We can't see the run status from
 * the issue payload directly, so we sniff the blocker_reason which is set
 * by the runtime itself at:
 *   - "Run cancelled by user."  (cancelSubagent / app-close cancel)
 *   - "Run failed[: <reason>]." (failed paths)
 * Anything else (the agent's own `waiting_on_user` message) means the
 * latest run is waiting on the user and dispatch would 409; the card
 * should surface a Reply affordance instead so the user can answer.
 */
function isBlockedIssueResumable(issue: IssueRecordPayload): boolean {
  if (issue.status !== "blocked") return false;
  const reason = (issue.blocker_reason ?? "").trim();
  return reason.startsWith("Run cancelled") || reason.startsWith("Run failed");
}

/**
 * Soft pastel pill for priority. Saturation scales with urgency
 * (critical → destructive, high → warning, medium → info, low → muted)
 * and uses project tokens so dark mode adapts automatically.
 */
function issuePriorityBadgeClass(
  priority: IssuePriorityPayload | null,
): string {
  switch (priority) {
    case "critical":
      return "bg-destructive/12 text-destructive";
    case "high":
      return "bg-warning/18 text-foreground";
    case "medium":
      return "bg-info/12 text-info";
    case "low":
      return "bg-fg-8 text-muted-foreground";
    default:
      return "bg-fg-6 text-muted-foreground";
  }
}

export function IssuesBoardPane({ workspaceId }: { workspaceId: string }) {
  const { issues, isLoading, statusMessage, refresh } =
    useIssueWorkspaceData(workspaceId);
  const openIssueDetailTab = useOpenIssueDetailTab();
  const [pendingIssueId, setPendingIssueId] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const visibleIssues = useMemo(
    () => issues.filter((issue) => issue.status !== "backlog"),
    [issues],
  );

  const issuesByStatus = useMemo(() => {
    const groups = Object.fromEntries(
      BOARD_STATUS_ORDER.map((status) => [status, [] as IssueRecordPayload[]]),
    ) as Record<VisibleBoardStatus, IssueRecordPayload[]>;
    for (const issue of visibleIssues) {
      if (isVisibleBoardStatus(issue.status)) {
        groups[issue.status].push(issue);
      }
    }
    for (const status of BOARD_STATUS_ORDER) {
      groups[status].sort((left, right) => {
        const priorityDelta =
          issuePriorityRank(left.priority) - issuePriorityRank(right.priority);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return right.updated_at.localeCompare(left.updated_at);
      });
    }
    return groups;
  }, [visibleIssues]);

  const openIssueDetail = useCallback(
    (issue: IssueRecordPayload) => {
      void openIssueDetailTab({
        workspaceId: issue.workspace_id,
        issueId: issue.issue_id,
        title: issue.title,
      });
    },
    [openIssueDetailTab],
  );

  const mutateIssue = useCallback(
    async (
      issueId: string,
      action: () => Promise<unknown>,
      fallbackMessage: string,
    ) => {
      setPendingIssueId(issueId);
      setErrorMessage("");
      try {
        await action();
        await refresh();
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : fallbackMessage,
        );
      } finally {
        setPendingIssueId("");
      }
    },
    [refresh],
  );

  // Bulk status mutator. Used by the right-click context menu's "Move
   // to …" items and the "Archive" item (which is just status=backlog).
   const handleSetIssueStatus = useCallback(
    async (issue: IssueRecordPayload, status: IssueStatusPayload) => {
      if (issue.status === status) return;
      await mutateIssue(
        issue.issue_id,
        () =>
          window.electronAPI.workspace.updateIssue(
            workspaceId,
            issue.issue_id,
            {
              workspace_id: workspaceId,
              status,
            },
          ),
        "Failed to move issue",
      );
    },
    [mutateIssue, workspaceId],
  );

  // Single context-menu anchored at the right-clicked card. We store
  // the active issue id + the DOM element so base-ui's Menu can anchor
  // its Positioner against the actual card (not a virtual mouse
  // coordinate). Slightly less precise than "popup at cursor" but
  // visually cleaner.
  const cardRefsByIssueId = useRef<Map<string, HTMLElement>>(new Map());
  const [contextMenuIssueId, setContextMenuIssueId] = useState<string | null>(
    null,
  );
  const contextMenuIssue = useMemo(
    () =>
      contextMenuIssueId
        ? (visibleIssues.find((i) => i.issue_id === contextMenuIssueId) ?? null)
        : null,
    [contextMenuIssueId, visibleIssues],
  );
  const contextMenuAnchor = contextMenuIssueId
    ? (cardRefsByIssueId.current.get(contextMenuIssueId) ?? null)
    : null;

  const handleStopIssue = useCallback(
    async (issue: IssueRecordPayload) => {
      if (!issue.active_subagent_id) return;
      if (!window.confirm(`Stop ${issue.issue_id}?`)) {
        return;
      }
      await mutateIssue(
        issue.issue_id,
        () =>
          window.electronAPI.workspace.stopIssueRun(
            workspaceId,
            issue.issue_id,
          ),
        "Failed to stop issue run",
      );
    },
    [mutateIssue, workspaceId],
  );

  // Resume a blocked-but-resumable issue (cancelled / failed) by flipping
  // status back to `todo`; the runtime auto-dispatches a fresh subagent on
  // the existing session so the agent continues with full history.
  const handleResumeIssue = useCallback(
    async (issue: IssueRecordPayload) => {
      await mutateIssue(
        issue.issue_id,
        () =>
          window.electronAPI.workspace.updateIssue(
            workspaceId,
            issue.issue_id,
            {
              workspace_id: workspaceId,
              status: "todo",
            },
          ),
        "Failed to resume issue",
      );
    },
    [mutateIssue, workspaceId],
  );

  // Open the detail tab focused on the reply composer. Used when a blocked
  // issue is NOT auto-resumable (agent is waiting on user input) — typing
  // a specific answer is the only path forward.
  const handleReplyToIssue = useCallback(
    (issue: IssueRecordPayload) => {
      void openIssueDetailTab({
        workspaceId: issue.workspace_id,
        issueId: issue.issue_id,
        title: issue.title,
        focusComposer: true,
      });
    },
    [openIssueDetailTab],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Top bar — matches the dashboard's compact header so the new
          shell reads as one piece of software. */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-6">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Issues
        </div>
        <div className="text-xs tabular-nums text-muted-foreground">
          {visibleIssues.length} total
        </div>
      </header>

      {errorMessage || statusMessage ? (
        <div className="border-b border-border bg-card/40 px-6 py-2 text-sm text-muted-foreground">
          {errorMessage || statusMessage}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-fg-6 px-4 py-3">
        {isLoading && visibleIssues.length === 0 ? (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex h-full min-h-full min-w-full items-start gap-3 pb-2">
            {BOARD_STATUS_ORDER.map((status) => {
              const columnIssues = issuesByStatus[status];
              const StatusIcon = BOARD_STATUS_ICON[status];
              const iconClass = BOARD_STATUS_ICON_CLASS[status];
              return (
                <section
                  key={status}
                  className="flex h-full min-h-0 w-64 shrink-0 flex-col rounded-xl bg-fg-2 px-2 pb-2 pt-2"
                >
                  {/* Column header — sits inside the column pillow. */}
                  <div className="flex items-center gap-1.5 px-1 pb-2 pt-0.5">
                    <StatusIcon
                      className={cn("size-3.5 shrink-0", iconClass)}
                      strokeWidth={2.25}
                    />
                    <h2 className="text-sm font-semibold text-foreground">
                      {issueStatusLabel(status)}
                    </h2>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {columnIssues.length}
                    </span>
                  </div>

                  {/* Column body — cards (bg-card) lift above the
                      column pillow (bg-fg-2) which lifts above the
                      page wash (bg-fg-6). Three-tier elevation reads
                      cleanly without competing colors. */}
                  <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-0.5">
                    {columnIssues.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border/70 px-3 py-5 text-center text-xs text-muted-foreground">
                        No {issueStatusLabel(status).toLowerCase()}
                      </div>
                    ) : (
                      columnIssues.map((issue) => {
                        const pending = pendingIssueId === issue.issue_id;
                        const running = Boolean(issue.active_subagent_id);
                        const blockerHint = (issue.blocker_reason ?? "").trim();
                        const isResumable = isBlockedIssueResumable(issue);
                        return (
                          <div
                            key={issue.issue_id}
                            ref={(el) => {
                              if (el) {
                                cardRefsByIssueId.current.set(
                                  issue.issue_id,
                                  el,
                                );
                              } else {
                                cardRefsByIssueId.current.delete(
                                  issue.issue_id,
                                );
                              }
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              setContextMenuIssueId(issue.issue_id);
                            }}
                            className={cn(
                              "group overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-foreground/15",
                              running &&
                                "border-primary/30 ring-1 ring-primary/25",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => openIssueDetail(issue)}
                              className="block w-full text-left transition-colors hover:bg-foreground/2"
                            >
                              {/* Header row: pulse dot (if running) + id + priority pill + action */}
                              <div className="flex items-center justify-between gap-1.5 px-3 pt-2.5">
                                <div className="flex min-w-0 items-center gap-1.5 text-xs">
                                  {running ? (
                                    <StatusDot
                                      variant="primary"
                                      pulse
                                      size="md"
                                      className="shrink-0"
                                    />
                                  ) : null}
                                  <span className="shrink-0 font-mono text-muted-foreground">
                                    {issue.issue_id}
                                  </span>
                                  {issue.priority ? (
                                    <span
                                      className={cn(
                                        "shrink-0 rounded px-1 py-px text-xs font-medium",
                                        issuePriorityBadgeClass(issue.priority),
                                      )}
                                    >
                                      {issuePriorityLabel(issue.priority)}
                                    </span>
                                  ) : null}
                                </div>
                                {running ? (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-5 shrink-0 gap-1 px-1.5 text-xs"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleStopIssue(issue);
                                    }}
                                    disabled={pending}
                                  >
                                    <Square className="size-3" />
                                    Stop
                                  </Button>
                                ) : issue.status === "blocked" ? (
                                  isResumable ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      className="h-6 shrink-0 gap-1 bg-warning px-2 text-xs font-medium text-warning-foreground hover:bg-warning/90"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void handleResumeIssue(issue);
                                      }}
                                      disabled={pending}
                                      title={
                                        blockerHint ||
                                        "Resume the cancelled run"
                                      }
                                    >
                                      <Play className="size-3" />
                                      Resume
                                    </Button>
                                  ) : (
                                    <Button
                                      type="button"
                                      size="sm"
                                      className="h-6 shrink-0 gap-1 bg-warning px-2 text-xs font-medium text-warning-foreground hover:bg-warning/90"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handleReplyToIssue(issue);
                                      }}
                                      disabled={pending}
                                      title={
                                        blockerHint ||
                                        "Reply to unblock this issue"
                                      }
                                    >
                                      <MessageSquareText className="size-3" />
                                      Reply
                                    </Button>
                                  )
                                ) : null}
                              </div>

                              {/* Title — single line, Linear-style font-medium
                                  + tight leading. Truncates rather than wrapping
                                  to keep card height predictable. */}
                              <div className="line-clamp-1 px-3 pt-1.5 text-sm font-medium leading-tight text-foreground">
                                {issue.title || "Untitled issue"}
                              </div>

                              {/* Description — hidden when a blocker hint
                                  takes the slot below. */}
                              {issue.description && !blockerHint ? (
                                <div className="line-clamp-2 px-3 pt-1 text-xs leading-snug text-muted-foreground">
                                  {issue.description}
                                </div>
                              ) : null}

                              {/* Blocker hint — inline secondary text with
                                  a warning glyph. Reads as a flagged
                                  description rather than a framed strip. */}
                              {blockerHint ? (
                                <div className="flex items-start gap-1.5 px-3 pt-1 text-xs leading-snug">
                                  <AlertCircle className="mt-0.5 size-3 shrink-0 text-warning" />
                                  <span className="line-clamp-2 text-muted-foreground">
                                    {blockerHint}
                                  </span>
                                </div>
                              ) : null}

                              {/* Footer — hairline + minimal metadata. */}
                              <div className="mt-2 flex items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-xs tabular-nums text-muted-foreground">
                                <span>
                                  {issueRelativeTime(issue.updated_at)}
                                </span>
                                <span className="truncate text-[11px] uppercase tracking-wide text-foreground/45">
                                  {issue.issue_id}
                                </span>
                              </div>
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* Right-click context menu. Single instance, anchored at the
          card element of the last-right-clicked issue. Drops down to
          base-ui's Menu primitive so we can pass `anchor` directly
          (the DropdownMenuContent wrapper doesn't expose it). */}
      <MenuPrimitive.Root
        open={contextMenuIssueId !== null && contextMenuIssue !== null}
        onOpenChange={(open) => {
          if (!open) setContextMenuIssueId(null);
        }}
      >
        <MenuPrimitive.Portal>
          {contextMenuIssue && contextMenuAnchor ? (
            <MenuPrimitive.Positioner
              className="isolate z-50 outline-none"
              anchor={contextMenuAnchor}
              align="start"
              side="bottom"
              sideOffset={4}
              alignOffset={8}
            >
              <MenuPrimitive.Popup className="z-50 min-w-48 overflow-hidden rounded-lg border border-border/70 bg-popover/95 p-1 text-sm text-popover-foreground shadow-2xl ring-1 ring-foreground/[0.04] backdrop-blur-xl outline-none">
                {(() => {
                  const issue = contextMenuIssue;
                  const close = () => setContextMenuIssueId(null);
                  return (
                    <>
                      <MenuPrimitive.Item
                        className="flex cursor-default items-center rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors hover:bg-foreground/[0.04] focus:bg-foreground/[0.06] data-disabled:cursor-not-allowed data-disabled:opacity-50"
                        onClick={() => {
                          close();
                          openIssueDetail(issue);
                        }}
                      >
                        Open detail
                      </MenuPrimitive.Item>
                      <MenuPrimitive.Separator className="my-1 h-px bg-border/50" />
                      {BOARD_STATUS_ORDER.filter(
                        (status) => status !== "blocked",
                      ).map((status) => (
                        <MenuPrimitive.Item
                          key={status}
                          disabled={issue.status === status}
                          className="flex cursor-default items-center rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors hover:bg-foreground/[0.04] focus:bg-foreground/[0.06] data-disabled:cursor-not-allowed data-disabled:opacity-50"
                          onClick={() => {
                            close();
                            void handleSetIssueStatus(issue, status);
                          }}
                        >
                          Move to {issueStatusLabel(status)}
                        </MenuPrimitive.Item>
                      ))}
                      <MenuPrimitive.Separator className="my-1 h-px bg-border/50" />
                      <MenuPrimitive.Item
                        disabled={issue.status === "backlog"}
                        className="flex cursor-default items-center rounded-md px-2.5 py-1.5 text-sm outline-none transition-colors hover:bg-foreground/[0.04] focus:bg-foreground/[0.06] data-disabled:cursor-not-allowed data-disabled:opacity-50"
                        onClick={() => {
                          close();
                          void handleSetIssueStatus(issue, "backlog");
                        }}
                      >
                        Archive (move to backlog)
                      </MenuPrimitive.Item>
                    </>
                  );
                })()}
              </MenuPrimitive.Popup>
            </MenuPrimitive.Positioner>
          ) : null}
        </MenuPrimitive.Portal>
      </MenuPrimitive.Root>
    </div>
  );
}
