import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Check,
  Clock3,
  Loader2,
  Pause,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
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

function summarizeInlineBackgroundTasks(tasks: BackgroundTaskRecordPayload[]) {
  const waitingCount = tasks.filter(
    (task) => task.status.trim().toLowerCase() === "waiting_on_user",
  ).length;
  if (waitingCount > 0) {
    return `${waitingCount} waiting`;
  }
  const activeCount = tasks.filter((task) => {
    const status = task.status.trim().toLowerCase();
    return status === "queued" || status === "running";
  }).length;
  if (activeCount > 0) {
    return `${activeCount} running`;
  }
  const failedCount = tasks.filter(
    (task) => task.status.trim().toLowerCase() === "failed",
  ).length;
  if (failedCount > 0) {
    return `${failedCount} failed`;
  }
  return `${tasks.length} recent`;
}

function inlineBackgroundIndicator(tasks: BackgroundTaskRecordPayload[]) {
  const sortedTasks = sortBackgroundTasks(tasks);
  const focusTask = sortedTasks[0] ?? null;
  return backgroundTaskStatusIndicator(focusTask?.status ?? "");
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

  function canRemoveTask(task: BackgroundTaskRecordPayload) {
    const status = task.status.trim().toLowerCase();
    return status !== "queued" && status !== "running";
  }

  function canContinueTask(task: BackgroundTaskRecordPayload) {
    const status = task.status.trim().toLowerCase();
    return status === "failed" || status === "cancelled";
  }

  if (variant === "inline") {
    if (!activeWorkspaceId) {
      return null;
    }

    if (tasks.length === 0 && !errorMessage) {
      return null;
    }

    const indicator = inlineBackgroundIndicator(sortedTasks);
    const summaryLabel = summarizeInlineBackgroundTasks(sortedTasks);

    return (
      <div
        className={`overflow-hidden rounded-2xl border border-border bg-card shadow-sm ${
          inlineExpanded ? "w-80" : "w-auto"
        }`}
      >
        <button
          type="button"
          onClick={() => setInlineExpanded((value) => !value)}
          aria-expanded={inlineExpanded}
          className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left transition-colors hover:bg-fg-2"
        >
          <span
            className={`inline-flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3 ${indicator.className}`}
          >
            {isLoading && tasks.length === 0 ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              indicator.icon
            )}
          </span>
          <span className="text-[11px] font-medium tabular-nums text-foreground">
            {summaryLabel}
          </span>
          <ChevronDown
            className={`size-3 shrink-0 text-muted-foreground transition ${inlineExpanded ? "rotate-0" : "-rotate-90"}`}
          />
        </button>

          {inlineExpanded ? (
            <div className="max-h-[320px] overflow-y-auto border-t border-border px-3 py-3 animate-in fade-in-0 slide-in-from-top-1 duration-150">
              {errorMessage ? (
                <div className="flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle size={14} />
                  <span>{errorMessage}</span>
                </div>
              ) : null}
              <div className={`${errorMessage ? "mt-3 " : ""}space-y-2`}>
                {sortedTasks.map((task) => {
                  const taskIndicator = backgroundTaskStatusIndicator(
                    task.status,
                  );
                  const canOpenTaskSession =
                    typeof onOpenTaskSession === "function" &&
                    Boolean(task.child_session_id.trim());
                  const showRemoveAction = canRemoveTask(task);
                  const showContinueAction = canContinueTask(task);
                  const taskBody = (
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`grid size-4 shrink-0 place-items-center ${taskIndicator.className}`}
                      >
                        {taskIndicator.icon}
                      </span>
                      <div className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                        {task.title.trim() || "Untitled background task"}
                      </div>
                    </div>
                  );
                  return (
                    <div
                      key={task.subagent_id}
                      className="flex items-center gap-2 rounded-xl border border-border bg-muted px-3 py-2.5"
                    >
                      {canOpenTaskSession ? (
                        <button
                          type="button"
                          onClick={() => onOpenTaskSession(task)}
                          className="min-w-0 flex-1 text-left transition hover:text-primary"
                        >
                          {taskBody}
                        </button>
                      ) : (
                        <div className="min-w-0 flex-1">{taskBody}</div>
                      )}
                      {showContinueAction ? (
                        <button
                          type="button"
                          aria-label={`Retry background task ${task.title.trim() || task.subagent_id}`}
                          disabled={continuingTaskId === task.subagent_id}
                          onClick={() => {
                            void handleContinueTask(task);
                          }}
                          className="shrink-0 rounded-full p-1 text-muted-foreground transition hover:bg-muted-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
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
                          className="shrink-0 rounded-full p-1 text-muted-foreground transition hover:bg-muted-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {removingTaskId === task.subagent_id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
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
      <div className="flex h-full items-center justify-center gap-2 px-6 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        <span>Loading background tasks…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 py-3 sm:px-5">
        <p className="text-xs text-muted-foreground">
          Read-only view for workspace background work. Use the main session to
          cancel, retry, or answer blockers.
        </p>
        {errorMessage ? (
          <div className="mt-2 flex items-center gap-2 rounded-md bg-destructive/8 px-3 py-1.5 text-xs text-destructive">
            <AlertTriangle size={14} />
            <span>{errorMessage}</span>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-5">
        {tasks.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No background tasks yet.
          </div>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {sortedTasks.map((task) => {
              const indicator = backgroundTaskStatusIndicator(task.status);
              const canOpenTaskSession =
                typeof onOpenTaskSession === "function" &&
                Boolean(task.child_session_id.trim());
              const showRemoveAction = canRemoveTask(task);
              const showContinueAction = canContinueTask(task);
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
                  className="group flex items-center gap-2 px-3 py-2.5 transition-colors hover:bg-fg-2"
                >
                  {canOpenTaskSession ? (
                    <button
                      type="button"
                      onClick={() => onOpenTaskSession(task)}
                      className="min-w-0 flex-1 text-left"
                    >
                      {taskBody}
                    </button>
                  ) : (
                    <div className="min-w-0 flex-1">{taskBody}</div>
                  )}
                  {showContinueAction ? (
                    <button
                      type="button"
                      aria-label={`Retry background task ${task.title.trim() || task.subagent_id}`}
                      disabled={continuingTaskId === task.subagent_id}
                      onClick={() => {
                        void handleContinueTask(task);
                      }}
                      className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-fg-8 hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
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
                      className="shrink-0 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-fg-8 hover:text-foreground focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {removingTaskId === task.subagent_id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Trash2 size={12} />
                      )}
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
