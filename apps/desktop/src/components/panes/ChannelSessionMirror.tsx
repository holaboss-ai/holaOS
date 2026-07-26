import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationTurns } from "@/components/panes/ChatPane/ConversationTurns";
import { chatMessagesFromSessionState } from "@/components/panes/ChatPane/index";
import type { ChatMessage } from "@/components/panes/ChatPane/types";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Search,
  X,
} from "@/components/ui/icons";
import { listDisplayOutputs } from "@/lib/outputs";

function messageSearchText(message: ChatMessage): string {
  const parts = [message.text];
  for (const segment of message.segments ?? []) {
    if (segment.kind === "output") parts.push(segment.text);
  }
  return parts.join("\n").toLowerCase();
}

const SEARCH_HIGHLIGHT_ALL = "hb-conv-search";
const SEARCH_HIGHLIGHT_ACTIVE = "hb-conv-search-active";

type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightRegistry(): Map<string, unknown> | null {
  const css = globalThis.CSS as unknown as
    | { highlights?: Map<string, unknown> }
    | undefined;
  return css?.highlights ?? null;
}

function clearSearchHighlights(): void {
  const registry = highlightRegistry();
  registry?.delete(SEARCH_HIGHLIGHT_ALL);
  registry?.delete(SEARCH_HIGHLIGHT_ACTIVE);
}

/** Paint every `query` occurrence under `container` via the CSS Custom
 *  Highlight API — no DOM mutation, so React-rendered markdown stays
 *  untouched. Matches inside the active turn use the stronger style. */
function applySearchHighlights(params: {
  container: HTMLElement;
  query: string;
  activeMessageId: string | null;
}): void {
  const registry = highlightRegistry();
  const HighlightCtor = (
    globalThis as { Highlight?: HighlightConstructor }
  ).Highlight;
  if (!registry || !HighlightCtor) return;
  const allRanges: Range[] = [];
  const activeRanges: Range[] = [];
  const activeSelector = params.activeMessageId
    ? `[data-message-id="${CSS.escape(params.activeMessageId)}"]`
    : null;
  const walker = document.createTreeWalker(
    params.container,
    NodeFilter.SHOW_TEXT,
  );
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    const lower = text.toLowerCase();
    let index = lower.indexOf(params.query);
    while (index !== -1) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + params.query.length);
      allRanges.push(range);
      const parent = node.parentElement;
      if (activeSelector && parent && parent.closest(activeSelector)) {
        activeRanges.push(range);
      }
      index = lower.indexOf(params.query, index + params.query.length);
    }
    node = walker.nextNode();
  }
  registry.set(SEARCH_HIGHLIGHT_ALL, new HighlightCtor(...allRanges));
  if (activeRanges.length > 0) {
    registry.set(SEARCH_HIGHLIGHT_ACTIVE, new HighlightCtor(...activeRanges));
  } else {
    registry.delete(SEARCH_HIGHLIGHT_ACTIVE);
  }
}

/**
 * Read-only mirror of a single channel conversation's agent session.
 *
 * It replicates — never drives — the session, and renders the SAME full-fidelity
 * transcript the real chat does: it feeds the session's structured output-event
 * history through the exported `chatMessagesFromSessionState` builder into the
 * shared `ConversationTurns` renderer (with `showExecutionInternals`), so
 * reasoning segments and the tool-use timeline show up exactly as in a normal
 * session — no bespoke rendering. Live-ish: the live output stream is used only
 * as a "something changed" trigger to re-run the pure builder (throttled), which
 * keeps the trace complete without copying ChatPane's stateful live reducer.
 * There is no composer — the channel's users send; this surface only reads.
 */
export function ChannelSessionMirror({
  sessionId,
  workspaceId,
  assistantLabel = "Agent",
  harnessId = null,
  replySurfaceLabel = null,
  searchOpen = false,
  onCloseSearch,
}: {
  sessionId: string;
  workspaceId: string;
  assistantLabel?: string;
  harnessId?: string | null;
  /** Platform name shown in the footer ("reply over WeChat"). */
  replySurfaceLabel?: string | null;
  /** In-conversation search bar (query + prev/next jump), toggled by the host. */
  searchOpen?: boolean;
  onCloseSearch?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedTraceByStepId, setCollapsedTraceByStepId] = useState<Record<string, boolean>>({});

  const streamIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rebuildPendingRef = useRef(false);

  const rebuild = useCallback(async () => {
    if (!sessionId || !workspaceId) return;
    try {
      // Same three sources the chat uses: flat message text (user turns),
      // structured output events (reasoning/tool/output — include_history), and
      // the artifact list. The builder reconstructs the full turn timeline.
      const [history, outputEvents, outputs] = await Promise.all([
        window.electronAPI.workspace.getSessionHistory({
          workspaceId,
          sessionId,
          limit: 500,
          offset: 0,
          order: "asc",
        }),
        window.electronAPI.workspace.getSessionOutputEvents({ workspaceId, sessionId }),
        listDisplayOutputs({ sessionId, limit: 200, offset: 0 }),
      ]);
      setMessages(
        chatMessagesFromSessionState({
          historyMessages: history.messages,
          outputEvents: outputEvents.items,
          outputs: outputs.items,
          showExecutionInternals: true,
          showBootstrapPhaseTrace: false,
        }),
      );
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load the conversation.");
    } finally {
      setLoading(false);
    }
  }, [sessionId, workspaceId]);

  // Coalesce rebuilds — the stream fires many events/sec during an active turn,
  // and each rebuild refetches the full event history. Leading-edge + trailing.
  const scheduleRebuild = useCallback(() => {
    if (rebuildTimerRef.current) {
      rebuildPendingRef.current = true;
      return;
    }
    void rebuild();
    rebuildTimerRef.current = setTimeout(() => {
      rebuildTimerRef.current = null;
      if (rebuildPendingRef.current) {
        rebuildPendingRef.current = false;
        scheduleRebuild();
      }
    }, 900);
  }, [rebuild]);

  // Initial paint + attach the live stream (as a change signal) per session.
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setError(null);
    setLoading(true);
    setCollapsedTraceByStepId({});
    void rebuild();

    void window.electronAPI.workspace
      .openSessionOutputStream({
        sessionId,
        workspaceId,
        includeHistory: false,
        stopOnTerminal: false,
      })
      .then((handle) => {
        if (cancelled) {
          void window.electronAPI.workspace
            .closeSessionOutputStream(handle.streamId, "channel_mirror_cancelled")
            .catch(() => undefined);
          return;
        }
        streamIdRef.current = handle.streamId;
      })
      .catch(() => undefined); // the stream is only a refresh trigger; the poll covers us

    return () => {
      cancelled = true;
      const activeStreamId = streamIdRef.current;
      streamIdRef.current = null;
      if (activeStreamId) {
        void window.electronAPI.workspace
          .closeSessionOutputStream(activeStreamId, "channel_mirror_unmounted")
          .catch(() => undefined);
      }
      if (rebuildTimerRef.current) {
        clearTimeout(rebuildTimerRef.current);
        rebuildTimerRef.current = null;
      }
    };
  }, [sessionId, workspaceId, rebuild]);

  // Any activity on this session → rebuild (throttled). The pure builder turns
  // the refetched events into the full reasoning/tool timeline.
  useEffect(() => {
    return window.electronAPI.workspace.onSessionStreamEvent((payload) => {
      if (!streamIdRef.current || payload.streamId !== streamIdRef.current) return;
      scheduleRebuild();
    });
  }, [scheduleRebuild]);

  // Safety poll — inbound user messages arrive from the platform (not our
  // stream), so an idle-but-open mirror still needs to notice them.
  useEffect(() => {
    const interval = setInterval(() => {
      void rebuild();
    }, 8000);
    return () => clearInterval(interval);
  }, [rebuild]);

  // ── In-conversation search ─────────────────────────────────────────
  // Matches over the already-loaded transcript (no extra fetches); jumping
  // scrolls the matched turn's data-message-id anchor into view with a
  // brief highlight flash.
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;
  useEffect(() => {
    if (!searchOpen) {
      setSearchQuery("");
      setMatchIndex(0);
    }
  }, [searchOpen]);
  const matchedIds = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!searchOpen || !query) return [];
    return messages
      .filter((message) => messageSearchText(message).includes(query))
      .map((message) => message.id);
  }, [messages, searchOpen, searchQuery]);
  const boundedMatchIndex =
    matchedIds.length === 0 ? 0 : Math.min(matchIndex, matchedIds.length - 1);
  const activeMatchId = matchedIds[boundedMatchIndex] ?? null;
  useEffect(() => {
    if (!activeMatchId) return;
    const container = scrollRef.current;
    const target = container?.querySelector(
      `[data-message-id="${CSS.escape(activeMatchId)}"]`,
    );
    if (!(target instanceof HTMLElement)) return;
    target.scrollIntoView({ block: "center" });
    target.animate(
      [
        { backgroundColor: "var(--color-accent, rgba(0, 0, 0, 0.08))" },
        { backgroundColor: "transparent" },
      ],
      { duration: 1400, easing: "ease-out" },
    );
  }, [activeMatchId]);
  const stepMatch = useCallback(
    (direction: 1 | -1) => {
      if (matchedIds.length === 0) return;
      setMatchIndex(
        (current) =>
          (Math.min(current, matchedIds.length - 1) +
            direction +
            matchedIds.length) %
          matchedIds.length,
      );
    },
    [matchedIds.length],
  );

  // Keyword highlighting over the rendered transcript. Re-applied whenever
  // the query, the focused match, or the DOM itself (messages rebuild)
  // changes; ranges die with the DOM they point into, so recompute is the
  // only correct strategy. No-op on engines without the Highlight API.
  useEffect(() => {
    const query = searchQuery.trim().toLowerCase();
    const container = scrollRef.current;
    if (!searchOpen || !query || !container) {
      clearSearchHighlights();
      return;
    }
    applySearchHighlights({
      container,
      query,
      activeMessageId: activeMatchId,
    });
    return clearSearchHighlights;
  }, [searchOpen, searchQuery, activeMatchId, messages]);

  // Keep pinned to the newest content — except while searching, where an
  // incoming event would yank the viewport away from the jumped-to match.
  useEffect(() => {
    if (searchOpenRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  const handleToggleTraceStep = useCallback((stepId: string) => {
    setCollapsedTraceByStepId((previous) => ({ ...previous, [stepId]: !previous[stepId] }));
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {searchOpen ? (
        <div className="mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setMatchIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                stepMatch(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onCloseSearch?.();
              }
            }}
            placeholder="Search this conversation…"
            className="embedded-input h-6 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {searchQuery.trim() ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {matchedIds.length === 0
                ? "0 results"
                : `${boundedMatchIndex + 1}/${matchedIds.length}`}
            </span>
          ) : null}
          <button
            type="button"
            aria-label="Previous match"
            disabled={matchedIds.length === 0}
            onClick={() => stepMatch(-1)}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <ChevronUp className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Next match"
            disabled={matchedIds.length === 0}
            onClick={() => stepMatch(1)}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <ChevronDown className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Close search"
            onClick={() => onCloseSearch?.()}
            className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      <div className="flex-1 overflow-y-auto px-1 py-1" ref={scrollRef}>
        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {loading && messages.length === 0 ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading conversation…
          </div>
        ) : null}

        {!loading && messages.length === 0 && !error ? (
          <div className="grid place-items-center px-4 py-10 text-center text-sm text-muted-foreground">
            No activity yet. When someone messages this channel, the agent's session — reasoning,
            tool use, and replies — appears here live.
          </div>
        ) : null}

        {messages.length > 0 ? (
          <ConversationTurns
            assistantLabel={assistantLabel}
            assistantMode="channel"
            collapsedTraceByStepId={collapsedTraceByStepId}
            harnessId={harnessId}
            messages={messages}
            onToggleTraceStep={handleToggleTraceStep}
            showExecutionInternals
            workspaceId={workspaceId}
          />
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border px-1 pt-2 text-[11px] text-muted-foreground">
        {`Watching live · to reply, message the bot ${
          replySurfaceLabel ? `on ${replySurfaceLabel}` : "in its chat app"
        }`}
      </div>
    </div>
  );
}
