import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Bot, ChevronDown, Clock3, Loader2, WandSparkles } from "lucide-react";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { Button } from "@/components/ui/button";

const SUBAGENT_SESSIONS_POLL_INTERVAL_MS = 2000;
type InspectableSessionFilter = "all" | "subagent" | "cronjob" | "task_proposal";

interface SubagentSessionsPaneProps {
  workspaceId?: string | null;
  variant?: "inline" | "full";
  onOpenSession?: (session: AgentSessionRecordPayload) => void;
}

function normalizeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function isInspectableRunSession(session: AgentSessionRecordPayload) {
  const kind = session.kind.trim().toLowerCase();
  return kind === "subagent" || kind === "task_proposal";
}

function sortInspectableRunSessions(items: AgentSessionRecordPayload[]) {
  return [...items].sort((left, right) => {
    const leftTs = Date.parse(left.updated_at || left.created_at || "") || 0;
    const rightTs = Date.parse(right.updated_at || right.created_at || "") || 0;
    return (
      rightTs - leftTs ||
      right.session_id.localeCompare(left.session_id)
    );
  });
}

function summarizeInspectableRunSessions(items: AgentSessionRecordPayload[]) {
  return items.length === 1
    ? "1 recent subagent session"
    : `${items.length} recent subagent sessions`;
}

function inspectableRunSessionLabel(session: AgentSessionRecordPayload) {
  const category = inspectableRunSessionCategory(session);
  if (category === "task_proposal") {
    return "Task proposal run";
  }
  if (category === "cronjob") {
    return "Cronjob run";
  }
  return "Subagent run";
}

function inspectableRunSessionCategory(
  session: AgentSessionRecordPayload,
): Exclude<InspectableSessionFilter, "all"> {
  const sourceType = (session.source_type ?? "").trim().toLowerCase();
  const kind = session.kind.trim().toLowerCase();
  if (sourceType === "cronjob" || Boolean((session.cronjob_id ?? "").trim())) {
    return "cronjob";
  }
  if (
    kind === "task_proposal" ||
    sourceType === "task_proposal" ||
    Boolean((session.proposal_id ?? "").trim()) ||
    Boolean((session.source_proposal_id ?? "").trim())
  ) {
    return "task_proposal";
  }
  return "subagent";
}

function formatSessionUpdatedLabel(session: AgentSessionRecordPayload) {
  const raw = Date.parse(session.updated_at || session.created_at || "");
  if (Number.isNaN(raw)) {
    return "";
  }
  return new Date(raw).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function SubagentSessionsPane({
  workspaceId,
  variant = "inline",
  onOpenSession,
}: SubagentSessionsPaneProps) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const activeWorkspaceId = workspaceId ?? selectedWorkspaceId;
  const [sessions, setSessions] = useState<AgentSessionRecordPayload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [inlineExpanded, setInlineExpanded] = useState(false);
  const [activeFilter, setActiveFilter] =
    useState<InspectableSessionFilter>("all");

  const refreshSessions = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (!activeWorkspaceId) {
        setSessions([]);
        setErrorMessage("");
        return;
      }
      if (options?.showLoading) {
        setIsLoading(true);
      }
      try {
        const response = await window.electronAPI.workspace.listAgentSessions({
          workspaceId: activeWorkspaceId,
          includeArchived: true,
          limit: 200,
          offset: 0,
        });
        setSessions(
          sortInspectableRunSessions(
            (response.items ?? []).filter(isInspectableRunSession),
          ),
        );
        setErrorMessage("");
      } catch (error) {
        setErrorMessage(normalizeErrorMessage(error));
      } finally {
        if (options?.showLoading) {
          setIsLoading(false);
        }
      }
    },
    [activeWorkspaceId],
  );

  useEffect(() => {
    if (!activeWorkspaceId) {
      setSessions([]);
      setErrorMessage("");
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    let requestInFlight = false;

    const loadSessions = async (options?: { showLoading?: boolean }) => {
      if (requestInFlight) {
        return;
      }
      requestInFlight = true;
      try {
        await refreshSessions(options);
      } finally {
        requestInFlight = false;
      }
    };

    const refreshVisibleSessions = () => {
      if (cancelled || document.visibilityState !== "visible") {
        return;
      }
      void loadSessions();
    };

    void loadSessions({ showLoading: true });
    const intervalId = window.setInterval(() => {
      refreshVisibleSessions();
    }, SUBAGENT_SESSIONS_POLL_INTERVAL_MS);
    window.addEventListener("focus", refreshVisibleSessions);
    document.addEventListener("visibilitychange", refreshVisibleSessions);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshVisibleSessions);
      document.removeEventListener("visibilitychange", refreshVisibleSessions);
    };
  }, [activeWorkspaceId, refreshSessions]);

  const latestSession = useMemo(() => sessions[0] ?? null, [sessions]);
  const filteredSessions = useMemo(() => {
    if (activeFilter === "all") {
      return sessions;
    }
    return sessions.filter(
      (session) => inspectableRunSessionCategory(session) === activeFilter,
    );
  }, [activeFilter, sessions]);

  if (variant === "inline") {
    if (!activeWorkspaceId) {
      return null;
    }
    if (!isLoading && sessions.length === 0 && !errorMessage) {
      return null;
    }

    const summaryLabel = summarizeInspectableRunSessions(filteredSessions);
    const detailLabel = latestSession
      ? latestSession.title?.trim() || inspectableRunSessionLabel(latestSession)
      : "";

    return (
      <div className="shrink-0 px-4 pt-3 sm:px-5">
        <div className="overflow-hidden rounded-lg border border-border bg-background/80 shadow-subtle-sm backdrop-blur-xl">
          <button
            type="button"
            onClick={() => setInlineExpanded((value) => !value)}
            aria-expanded={inlineExpanded}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-muted/60"
          >
            <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground">
              {isLoading && sessions.length === 0 ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Bot size={14} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-foreground">
                {summaryLabel}
              </div>
              {detailLabel ? (
                <div className="truncate text-[11px] text-muted-foreground">
                  {detailLabel}
                </div>
              ) : null}
            </div>
            <div className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
              {filteredSessions.length}
            </div>
            <ChevronDown
              className={`size-3.5 shrink-0 text-muted-foreground transition ${inlineExpanded ? "rotate-0" : "-rotate-90"}`}
            />
          </button>

          {inlineExpanded ? (
            <div className="max-h-[320px] overflow-y-auto border-t border-border px-3 py-3">
              {errorMessage ? (
                <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {errorMessage}
                </div>
              ) : null}
              <div className={`${errorMessage ? "mt-3 " : ""}space-y-2`}>
                {filteredSessions.map((session) => {
                  const title =
                    session.title?.trim() ||
                    inspectableRunSessionLabel(session);
                  const updatedLabel = formatSessionUpdatedLabel(session);
                  const archived = Boolean((session.archived_at || "").trim());
                  return (
                    <button
                      key={session.session_id}
                      type="button"
                      onClick={() => onOpenSession?.(session)}
                      className="flex w-full min-w-0 items-start gap-2 rounded-xl border border-border bg-muted px-3 py-2.5 text-left transition hover:border-primary/40 hover:text-primary"
                    >
                      <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground">
                        {session.kind.trim().toLowerCase() === "task_proposal" ? (
                          <WandSparkles size={13} />
                        ) : archived ? (
                          <Archive size={13} />
                        ) : (
                          <Bot size={13} />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-foreground">
                          {title}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                          <span>{inspectableRunSessionLabel(session)}</span>
                          {archived ? <span>Archived</span> : <span>Live</span>}
                          {updatedLabel ? <span>{updatedLabel}</span> : null}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (!activeWorkspaceId) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ["all", "All", Bot],
              ["subagent", "Subagents", Bot],
              ["cronjob", "Cronjobs", Clock3],
              ["task_proposal", "Task proposals", WandSparkles],
            ] as const
          ).map(([filterId, label, Icon]) => {
            const isActive = activeFilter === filterId;
            return (
              <Button
                key={filterId}
                type="button"
                variant={isActive ? "secondary" : "outline"}
                size="sm"
                onClick={() => setActiveFilter(filterId)}
                className="h-8 gap-1.5 rounded-full px-3 text-xs"
              >
                <Icon size={13} />
                <span>{label}</span>
              </Button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
        {filteredSessions.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-border bg-muted/20 px-6 text-center text-sm text-muted-foreground">
            No matching sessions yet.
          </div>
        ) : (
          <div className="space-y-3">
            {filteredSessions.map((session) => {
            const title =
              session.title?.trim() || inspectableRunSessionLabel(session);
            const archived = Boolean((session.archived_at || "").trim());
            const updatedLabel = formatSessionUpdatedLabel(session);
            return (
              <button
                key={session.session_id}
                type="button"
                onClick={() => onOpenSession?.(session)}
                className="flex w-full min-w-0 items-start gap-2 rounded-2xl border border-border bg-card/95 px-4 py-3 text-left shadow-subtle-xs transition hover:border-primary/40 hover:text-primary"
              >
                <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-muted-foreground">
                  {inspectableRunSessionCategory(session) === "task_proposal" ? (
                    <WandSparkles size={14} />
                  ) : inspectableRunSessionCategory(session) === "cronjob" ? (
                    <Clock3 size={14} />
                  ) : archived ? (
                    <Archive size={14} />
                  ) : (
                    <Bot size={14} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{inspectableRunSessionLabel(session)}</span>
                    {archived ? <span>Archived</span> : <span>Live</span>}
                    {updatedLabel ? <span>{updatedLabel}</span> : null}
                  </div>
                </div>
              </button>
            );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
