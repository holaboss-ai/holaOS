import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  Check,
  Clock3,
  Inbox,
  Loader2,
  MessageCircleQuestion,
  MoreHorizontal,
  Pause,
  RotateCw,
  Trash2,
  X,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

const BACKGROUND_TASKS_POLL_INTERVAL_MS = 1000;

interface BackgroundTasksPaneProps {
  workspaceId?: string | null;
  ownerMainSessionId?: string | null;
  emptyWorkspaceMessage?: string;
  variant?: "full" | "inline";
  onOpenTaskSession?: (task: BackgroundTaskRecordPayload) => void;
}

function normalizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function backgroundTaskOpenSessionTarget(task: BackgroundTaskRecordPayload) {
  return (
    task.parent_session_id?.trim() ||
    task.owner_main_session_id.trim() ||
    task.child_session_id.trim()
  );
}

function backgroundTaskStatusIndicator(status: string): {
  className: string;
  icon: ReactNode;
} {
  switch (status.trim().toLowerCase()) {
    case "queued":
      return {
        className: "text-info",
        icon: <Clock3 size={14} />,
      };
    case "running":
      return {
        className: "text-primary",
        icon: <Loader2 size={14} className="animate-spin" />,
      };
    case "waiting_on_user":
      return {
        className: "text-warning",
        icon: <Pause size={14} />,
      };
    case "completed":
      return {
        className: "text-success",
        icon: <Check size={14} />,
      };
    case "failed":
      return {
        className: "text-destructive",
        icon: <X size={14} />,
      };
    case "cancelled":
      return {
        className: "text-muted-foreground",
        icon: <Pause size={14} />,
      };
    default:
      return {
        className: "text-muted-foreground",
        icon: <Clock3 size={14} />,
      };
  }
}

function backgroundTaskDetail(task: BackgroundTaskRecordPayload): string {
  const status = task.status.trim().toLowerCase();
  const blockingQuestion =
    typeof task.blocking_payload?.blocking_question === "string" &&
    task.blocking_payload.blocking_question.trim()
      ? task.blocking_payload.blocking_question.trim()
      : "";
  if (blockingQuestion) {
    return blockingQuestion;
  }
  const goal = task.goal.trim();
  const summary = task.summary?.trim() ?? "";
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
      return summary || goal || "No summary yet.";
    case "waiting_on_user":
      return goal || "Waiting on user input.";
    case "running":
      return goal || "Working in the background.";
    case "queued":
      return goal || "Queued to run.";
    default:
      return summary || goal || "No summary yet.";
  }
}

function backgroundTaskPriority(status: string): number {
  switch (status.trim().toLowerCase()) {
    case "waiting_on_user":
      return 0;
    case "running":
      return 1;
    case "queued":
      return 2;
    case "failed":
      return 3;
    case "completed":
      return 4;
    case "cancelled":
      return 5;
    default:
      return 6;
  }
}

function formatRelativeBackgroundTime(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "";
  const diffMs = Date.now() - parsed;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return "now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

function backgroundTaskGroup(
  status: string,
): "needs_attention" | "active" | "recent" | "other" {
  switch (status.trim().toLowerCase()) {
    case "waiting_on_user":
      return "needs_attention";
    case "queued":
    case "running":
      return "active";
    case "completed":
    case "failed":
    case "cancelled":
      return "recent";
    default:
      return "other";
  }
}

function sortBackgroundTasks(tasks: BackgroundTaskRecordPayload[]) {
  return [...tasks].sort((left, right) => {
    const priorityDiff =
      backgroundTaskPriority(left.status) - backgroundTaskPriority(right.status);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return (
      Date.parse(right.updated_at || "") - Date.parse(left.updated_at || "") ||
      left.subagent_id.localeCompare(right.subagent_id)
    );
  });
}

function isWaitingOnUser(task: BackgroundTaskRecordPayload) {
  return task.status.trim().toLowerCase() === "waiting_on_user";
}

function isInlineVisibleBackgroundTask(task: BackgroundTaskRecordPayload) {
  const status = task.status.trim().toLowerCase();
  // waiting_on_user is the highest-signal inline state — the agent is blocked
  // on the user — so it must surface in the composer strip, not only the page.
  return status === "queued" || status === "running" || status === "waiting_on_user";
}

export function BackgroundTasksPane({
  workspaceId,
  ownerMainSessionId = null,
  emptyWorkspaceMessage = "Choose a workspace from the top bar to view background tasks.",
  variant = "full",
  onOpenTaskSession,
}: BackgroundTasksPaneProps) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const activeWorkspaceId = workspaceId ?? selectedWorkspaceId;
  const activeOwnerMainSessionId = ownerMainSessionId?.trim() || null;
  const [tasks, setTasks] = useState<BackgroundTaskRecordPayload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [inlineExpanded, setInlineExpanded] = useState(false);
  const [removingTaskId, setRemovingTaskId] = useState<string | null>(null);
  const [continuingTaskId, setContinuingTaskId] = useState<string | null>(null);

  const refreshTasks = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (!activeWorkspaceId) {
        setTasks([]);
        setErrorMessage("");
        return;
      }
      if (options?.showLoading) {
        setIsLoading(true);
      }
      try {
        const response = await window.electronAPI.workspace.listBackgroundTasks({
          workspaceId: activeWorkspaceId,
          ownerMainSessionId: activeOwnerMainSessionId,
          limit: 200,
        });
        setTasks(response.tasks ?? []);
        setErrorMessage("");
      } catch (error) {
        setErrorMessage(normalizeErrorMessage(error));
      } finally {
        if (options?.showLoading) {
          setIsLoading(false);
        }
      }
    },
    [activeOwnerMainSessionId, activeWorkspaceId],
  );

  useEffect(() => {
    if (!activeWorkspaceId) {
      setTasks([]);
      setErrorMessage("");
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    let requestInFlight = false;

    const loadTasks = async (options?: { showLoading?: boolean }) => {
      if (requestInFlight) {
        return;
      }
      requestInFlight = true;
      try {
        await refreshTasks(options);
      } finally {
        requestInFlight = false;
      }
    };

    const refreshVisibleTasks = () => {
      if (document.visibilityState !== "visible" || cancelled) {
        return;
      }
      void loadTasks();
    };

    void loadTasks({ showLoading: true });
    const intervalId = window.setInterval(() => {
      refreshVisibleTasks();
    }, BACKGROUND_TASKS_POLL_INTERVAL_MS);
    window.addEventListener("focus", refreshVisibleTasks);
    document.addEventListener("visibilitychange", refreshVisibleTasks);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshVisibleTasks);
      document.removeEventListener("visibilitychange", refreshVisibleTasks);
    };
  }, [activeWorkspaceId, refreshTasks]);

  const handleRemoveTask = useCallback(
    async (task: BackgroundTaskRecordPayload) => {
      if (!activeWorkspaceId || removingTaskId === task.subagent_id) {
        return;
      }
      setRemovingTaskId(task.subagent_id);
      try {
        await window.electronAPI.workspace.archiveBackgroundTask({
          workspaceId: activeWorkspaceId,
          subagentId: task.subagent_id,
          ownerMainSessionId: task.owner_main_session_id,
        });
        setTasks((current) =>
          current.filter((item) => item.subagent_id !== task.subagent_id),
        );
        setErrorMessage("");
      } catch (error) {
        setErrorMessage(normalizeErrorMessage(error));
      } finally {
        setRemovingTaskId((current) =>
          current === task.subagent_id ? null : current,
        );
      }
    },
    [activeWorkspaceId, removingTaskId],
  );

  const handleContinueTask = useCallback(
    async (task: BackgroundTaskRecordPayload) => {
      if (!activeWorkspaceId || continuingTaskId === task.subagent_id) {
        return;
      }
      const ownerSessionId = (
        task.owner_main_session_id ??
        activeOwnerMainSessionId ??
        ""
      ).trim();
      if (!ownerSessionId) {
        setErrorMessage(
          "Cannot continue this task — main session is unknown.",
        );
        return;
      }
      const instruction =
        task.goal.trim() || "Please continue this task from where it stopped.";
      setContinuingTaskId(task.subagent_id);
      try {
        await window.electronAPI.workspace.continueBackgroundTask({
          workspaceId: activeWorkspaceId,
          subagentId: task.subagent_id,
          ownerMainSessionId: ownerSessionId,
          instruction,
        });
        setTasks((current) =>
          current.map((item) =>
            item.subagent_id === task.subagent_id
              ? { ...item, status: "queued" }
              : item,
          ),
        );
        setErrorMessage("");
        void refreshTasks({ showLoading: false });
      } catch (error) {
        setErrorMessage(normalizeErrorMessage(error));
      } finally {
        setContinuingTaskId((current) =>
          current === task.subagent_id ? null : current,
        );
      }
    },
    [
      activeOwnerMainSessionId,
      activeWorkspaceId,
      continuingTaskId,
      refreshTasks,
    ],
  );

  const sortedTasks = sortBackgroundTasks(tasks);
  const inlineVisibleTasks = sortedTasks.filter(isInlineVisibleBackgroundTask);
  const pageVisibleTasks = sortedTasks;

  function canRemoveTask(task: BackgroundTaskRecordPayload) {
    const status = task.status.trim().toLowerCase();
    return status !== "queued" && status !== "running";
  }

  function canContinueTask(task: BackgroundTaskRecordPayload) {
    const status = task.status.trim().toLowerCase();
    return status === "failed" || status === "cancelled";
  }

  if (variant === "inline") {
    if (!activeWorkspaceId || inlineVisibleTasks.length === 0) {
      return null;
    }

    const waitingTasks = inlineVisibleTasks.filter(isWaitingOnUser);
    const runningCount = inlineVisibleTasks.length - waitingTasks.length;

    // Urgent: a background task is blocked on the user. The highest-signal
    // state, so it takes over the strip in amber with the actual question and a
    // one-click way into the task to answer.
    if (waitingTasks.length > 0) {
      const focus = waitingTasks[0];
      const focusTitle = focus.title.trim();
      const question = backgroundTaskDetail(focus);
      const label =
        waitingTasks.length > 1
          ? `${waitingTasks.length} tasks need you`
          : focusTitle || "A background task needs you";
      const canOpen =
        typeof onOpenTaskSession === "function" &&
        Boolean(backgroundTaskOpenSessionTarget(focus));
      return (
        <div className="flex w-full items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2">
          <span className="grid size-5 shrink-0 place-items-center text-amber-600 dark:text-amber-400">
            <MessageCircleQuestion className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5 text-xs">
              <span className="truncate font-medium text-foreground">
                {label}
              </span>
              {runningCount > 0 ? (
                <span className="shrink-0 text-muted-foreground">
                  · {runningCount} running
                </span>
              ) : null}
            </div>
            {question && question !== focusTitle ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {question}
              </p>
            ) : null}
          </div>
          {canOpen ? (
            <button
              type="button"
              onClick={() => onOpenTaskSession?.(focus)}
              className="shrink-0 rounded-md bg-amber-500 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-amber-600 dark:bg-amber-400 dark:text-amber-950 dark:hover:bg-amber-300"
            >
              Open
            </button>
          ) : null}
        </div>
      );
    }

    // Ambient: work is running in the background. Quiet single line; expand to
    // see which tasks and jump into any of them.
    return (
      <div className="w-full overflow-hidden rounded-xl border border-border bg-muted">
        <button
          type="button"
          onClick={() => setInlineExpanded((value) => !value)}
          aria-expanded={inlineExpanded}
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-fg-2"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {inlineVisibleTasks.length} running in the background
          </span>
          <ChevronDown
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
              inlineExpanded ? "rotate-0" : "-rotate-90"
            }`}
          />
        </button>
        {inlineExpanded ? (
          <div className="max-h-56 space-y-0.5 overflow-y-auto border-t border-border p-1.5 animate-in fade-in-0 slide-in-from-top-1 duration-quick ease-out-expo">
            {inlineVisibleTasks.map((task) => {
              const taskIndicator = backgroundTaskStatusIndicator(task.status);
              const canOpen =
                typeof onOpenTaskSession === "function" &&
                Boolean(backgroundTaskOpenSessionTarget(task));
              const row = (
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`grid size-4 shrink-0 place-items-center ${taskIndicator.className}`}
                  >
                    {taskIndicator.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                    {task.title.trim() || "Untitled background task"}
                  </span>
                </div>
              );
              return canOpen ? (
                <button
                  key={task.subagent_id}
                  type="button"
                  onClick={() => onOpenTaskSession?.(task)}
                  className="block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fg-2"
                >
                  {row}
                </button>
              ) : (
                <div key={task.subagent_id} className="px-2 py-1.5">
                  {row}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  if (!activeWorkspaceId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {emptyWorkspaceMessage}
      </div>
    );
  }

  if (isLoading && tasks.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-muted">
            <Activity className="size-3.5 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            Background tasks
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center gap-2 px-6 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          <span>Loading background tasks…</span>
        </div>
      </div>
    );
  }

  // Pure workflow runs surface in the workflow editor; the Tasks page hides
  // them via `pageVisibleTasks`. Cronjob and delegate_task runs stay visible.
  const needsAttentionTasks = pageVisibleTasks.filter(
    (t) => backgroundTaskGroup(t.status) === "needs_attention",
  );
  const activeTasks = pageVisibleTasks.filter(
    (t) => backgroundTaskGroup(t.status) === "active",
  );
  const recentTasks = pageVisibleTasks.filter(
    (t) => backgroundTaskGroup(t.status) === "recent",
  );
  const hasAnyTasks = pageVisibleTasks.length > 0;

  const renderRow = (task: BackgroundTaskRecordPayload) => {
    const indicator = backgroundTaskStatusIndicator(task.status);
    const canOpenTaskSession =
      typeof onOpenTaskSession === "function" &&
      Boolean(backgroundTaskOpenSessionTarget(task));
    const showRemoveAction = canRemoveTask(task);
    const showContinueAction = canContinueTask(task);
    const detail = backgroundTaskDetail(task);
    const detailIsTitle = detail === task.title.trim();
    const relative = formatRelativeBackgroundTime(task.updated_at);
    const taskBody = (
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`grid size-4 shrink-0 place-items-center ${indicator.className}`}
        >
          {indicator.icon}
        </span>
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {task.title.trim() || "Untitled background task"}
        </div>
      </div>
    );
    return (
      <div
        key={task.subagent_id}
        className="flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-fg-2 sm:px-5"
      >
        <div className="min-w-0 flex-1">
          {canOpenTaskSession ? (
            <button
              type="button"
              onClick={() => onOpenTaskSession(task)}
              className="block w-full text-left"
            >
              {taskBody}
            </button>
          ) : (
            <div>{taskBody}</div>
          )}
          {detail && !detailIsTitle ? (
            <p className="ml-6 mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {detail}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
          {relative ? (
            <span className="mr-1 text-[10.5px] tabular-nums text-muted-foreground">
              {relative}
            </span>
          ) : null}
          {showContinueAction ? (
            <button
              type="button"
              aria-label={`Retry background task ${task.title.trim() || task.subagent_id}`}
              disabled={continuingTaskId === task.subagent_id}
              onClick={() => {
                void handleContinueTask(task);
              }}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-fg-8 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {continuingTaskId === task.subagent_id ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RotateCw size={12} />
              )}
            </button>
          ) : null}
          {showRemoveAction ? (
            <button
              type="button"
              aria-label={`Remove background task ${task.title.trim() || task.subagent_id}`}
              disabled={removingTaskId === task.subagent_id}
              onClick={() => {
                void handleRemoveTask(task);
              }}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-fg-8 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {removingTaskId === task.subagent_id ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Trash2 size={12} />
              )}
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderGroup = (
    label: string,
    groupTasks: BackgroundTaskRecordPayload[],
  ) => {
    if (groupTasks.length === 0) return null;
    return (
      <div key={label}>
        <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-1.5 backdrop-blur-sm sm:px-5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {label}
          </span>
          <span className="text-[10px] tabular-nums text-muted-foreground/70">
            {groupTasks.length}
          </span>
        </div>
        <div className="divide-y divide-border">{groupTasks.map(renderRow)}</div>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-muted">
          <Activity className="size-3.5 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          Background tasks
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="More actions"
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-44">
            <DropdownMenuItem
              onClick={() => void refreshTasks({ showLoading: true })}
              disabled={isLoading}
            >
              <RotateCw
                className={cn("size-3.5", isLoading && "animate-spin")}
              />
              Refresh
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <span className="sr-only">
        Read-only view for workspace background work. Use the main session to
        cancel, retry, or answer blockers.
      </span>

      {errorMessage ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-destructive/20 bg-destructive/5 px-4 py-1.5 text-xs text-destructive sm:px-5">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 truncate">{errorMessage}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {hasAnyTasks ? (
          <>
            {renderGroup("Needs attention", needsAttentionTasks)}
            {renderGroup("Active", activeTasks)}
            {renderGroup("Recent", recentTasks)}
          </>
        ) : (
          <div className="grid h-full place-items-center p-6">
            <EmptyState
              icon={Inbox}
              title="No background tasks yet."
              description="When the agent spawns parallel work — subagents, scheduled runs, fan-outs — they'll show up here."
              size="md"
              decorated
            />
          </div>
        )}
      </div>
    </div>
  );
}
