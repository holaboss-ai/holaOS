import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Bot,
  ChevronDown,
  Clock3,
  Loader2,
  MessageCircle,
  Search,
} from "lucide-react";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";

const SUBAGENT_SESSIONS_POLL_INTERVAL_MS = 2000;

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
  return kind === "subagent";
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
    ? "1 recent run session"
    : `${items.length} recent run sessions`;
}

function inspectableRunSessionLabel(session: AgentSessionRecordPayload) {
  const category = inspectableRunSessionCategory(session);
  if (category === "cronjob") {
    return "Cronjob run";
  }
  return "Subagent run";
}

function inspectableRunSessionCategory(
  session: AgentSessionRecordPayload,
): "subagent" | "cronjob" {
  const sourceType = (session.source_type ?? "").trim().toLowerCase();
  if (sourceType === "cronjob" || Boolean((session.cronjob_id ?? "").trim())) {
    return "cronjob";
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

function sessionTimestampMs(session: AgentSessionRecordPayload): number {
  const raw = Date.parse(session.updated_at || session.created_at || "");
  return Number.isNaN(raw) ? 0 : raw;
}

/** Bucket label used for grouping in the full-variant timeline. */
function sessionDateBucket(ms: number): string {
  if (ms <= 0) return "Earlier";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(ms);
  const targetMidnight = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
  );
  const dayDelta = Math.floor(
    (today.getTime() - targetMidnight.getTime()) / 86_400_000,
  );
  if (dayDelta <= 0) return "Today";
  if (dayDelta === 1) return "Yesterday";
  if (dayDelta < 7) return "Last 7 days";
  if (
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth()
  ) {
    return "Earlier this month";
  }
  return "Earlier";
}

const BUCKET_ORDER: ReadonlyArray<string> = [
  "Today",
  "Yesterday",
  "Last 7 days",
  "Earlier this month",
  "Earlier",
];

function formatSessionTimeOnly(ms: number): string {
  if (ms <= 0) return "";
  const target = new Date(ms);
  const now = new Date();
  if (
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate()
  ) {
    return target.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return target.toLocaleDateString([], {
    month: "short",
    day: "numeric",
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
  const cronjobSessions = useMemo(
    () =>
      sessions.filter(
        (session) => inspectableRunSessionCategory(session) === "cronjob",
      ),
    [sessions],
  );

  if (variant === "inline") {
    if (!activeWorkspaceId) {
      return null;
    }
    if (!isLoading && sessions.length === 0 && !errorMessage) {
      return null;
    }

    const summaryLabel = summarizeInspectableRunSessions(sessions);
    const detailLabel = latestSession
      ? latestSession.title?.trim() || inspectableRunSessionLabel(latestSession)
      : "";

    return (
      <div className="shrink-0 px-4 pt-3 sm:px-5">
        <div className="overflow-hidden rounded-lg border border-border bg-background/80 shadow-xs backdrop-blur-xl">
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
                <MessageCircle size={14} />
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
              {sessions.length}
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
                {sessions.map((session) => {
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
                        {archived ? (
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
    <FullSessionsView
      sessions={cronjobSessions}
      isLoading={isLoading}
      errorMessage={errorMessage}
      onOpenSession={onOpenSession}
    />
  );
}

function FullSessionsView({
  sessions,
  isLoading,
  errorMessage,
  onOpenSession,
}: {
  sessions: AgentSessionRecordPayload[];
  isLoading: boolean;
  errorMessage: string;
  onOpenSession?: (session: AgentSessionRecordPayload) => void;
}) {
  const [query, setQuery] = useState("");

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const title = (s.title ?? "").toLowerCase();
      const fallback = inspectableRunSessionLabel(s).toLowerCase();
      return title.includes(q) || fallback.includes(q);
    });
  }, [query, sessions]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, AgentSessionRecordPayload[]>();
    for (const s of searched) {
      const ms = sessionTimestampMs(s);
      const bucket = sessionDateBucket(ms);
      const list = buckets.get(bucket) ?? [];
      list.push(s);
      buckets.set(bucket, list);
    }
    return BUCKET_ORDER.filter((b) => buckets.has(b)).map(
      (b) => [b, buckets.get(b) ?? []] as const,
    );
  }, [searched]);

  const emptyForReason =
    sessions.length === 0
      ? "No cronjob runs yet."
      : searched.length === 0 && query.trim()
        ? `No cronjob runs match "${query.trim()}".`
        : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-3 pb-2">
        <div className="relative">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cronjobs…"
            aria-label="Search cronjobs"
            className="h-8 w-full rounded-md border border-border bg-transparent pr-2 pl-7 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-foreground/20 focus-visible:outline-none"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {errorMessage ? (
          <div className="mx-2 my-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {errorMessage}
          </div>
        ) : null}
        {emptyForReason ? (
          <div className="flex h-full min-h-[160px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {isLoading && sessions.length === 0 ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Loading sessions…
              </span>
            ) : (
              emptyForReason
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            {grouped.map(([bucket, items]) => (
              <div key={bucket} className="flex flex-col">
                <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-foreground/40">
                  {bucket}
                </div>
                {items.map((session) => (
                  <SessionRow
                    key={session.session_id}
                    session={session}
                    onOpen={() => onOpenSession?.(session)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  onOpen,
}: {
  session: AgentSessionRecordPayload;
  onOpen: () => void;
}) {
  const title = session.title?.trim() || inspectableRunSessionLabel(session);
  const archived = Boolean((session.archived_at || "").trim());
  const category = inspectableRunSessionCategory(session);
  const ms = sessionTimestampMs(session);
  const time = formatSessionTimeOnly(ms);
  const subtitle = archived
    ? "Archived"
    : inspectableRunSessionLabel(session);
  const Icon =
    category === "cronjob"
        ? Clock3
        : archived
          ? Archive
          : Bot;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md px-2 text-left transition-colors hover:bg-foreground/[0.04]"
    >
      <Icon
        size={14}
        className={
          archived
            ? "shrink-0 text-foreground/40"
            : "shrink-0 text-foreground/65"
        }
      />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {title}
      </span>
      <span className="shrink-0 truncate text-xs text-muted-foreground">
        {subtitle}
      </span>
      <span className="shrink-0 truncate text-xs text-muted-foreground/70 tabular-nums">
        {time}
      </span>
    </button>
  );
}
