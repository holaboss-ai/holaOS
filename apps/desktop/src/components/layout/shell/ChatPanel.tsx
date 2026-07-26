import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ArrowLeft, Layers, MessageCircle } from "@/components/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArtifactsPane } from "@/components/panes/ArtifactsPane";
import { ChatPane } from "@/components/panes/ChatPane";
import { AppSessionDropdown } from "@/components/panes/ChatPane/AppSessionDropdown";
import { ChatContextCard } from "@/components/panes/ChatPane/ChatContextPopover";
import { ChatHeaderToolbar } from "@/components/panes/ChatPane/ChatHeader";
import { listDisplayOutputs } from "@/lib/outputs";
import type { AttachmentListItem } from "@/components/panes/ChatPane/types";
import { SubagentSessionsPane } from "@/components/panes/SubagentSessionsPane";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { windowsCaptionGutterPx } from "@/lib/windowControls";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  composerDraftForWorkspaceAtom,
  setComposerDraftAtom,
} from "./state/composerDrafts";
import {
  activeInternalTabIdAtom,
  blankTab,
  type InternalTab,
  internalTabsAtom,
  upsertInternalTab,
  workspaceSurfaceTab,
} from "./state/internalTabs";
import {
  activeWebAppSurfaceAtom,
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  chatAppContextAttachmentRequestAtom,
  chatComposerPrefillAtom,
  chatExplorerAttachmentRequestAtom,
  chatLocalAttachmentRequestAtom,
  chatPanelHiddenAtom,
  chatPanelViewAtom,
  chatSessionOpenRequestAtom,
  chatPanelWidthAtom,
  type ChatSessionOpenRequest,
  contextCardCollapsedBySessionAtom,
  focusModeAtom,
  lastSeenOutputsCountAtom,
  selectedSessionIdAtom,
  sidebarCollapsedAtom,
} from "./state/ui";
import { useStoplightCompensation } from "@/lib/StoplightContext";
import type { ChatLayout } from "./useChatLayout";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";

export function ChatPanel({ layout = "split" }: { layout?: ChatLayout }) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const { openOutput, openUrlInBrowserTab, openFileInInternalTab } =
    useOpenWorkspaceOutput();
  const openIssueDetailTab = useOpenIssueDetailTab();

  const [view, setView] = useAtom(chatPanelViewAtom);
  // Tracks the chat's bound session. ChatPane reports it via
  // onActiveSessionIdChange below — keeping this current is what lets the
  // Outputs panel query the right session after a load / HMR remount.
  const [selectedSessionId, setSelectedSessionId] = useAtom(
    selectedSessionIdAtom,
  );
  const [sessionOpenRequest, setSessionOpenRequest] = useAtom(
    chatSessionOpenRequestAtom,
  );
  const [activeWebAppSurface, setActiveWebAppSurface] = useAtom(
    activeWebAppSurfaceAtom,
  );
  const [localAttachmentRequest, setLocalAttachmentRequest] = useAtom(
    chatLocalAttachmentRequestAtom,
  );
  const [explorerAttachmentRequest, setExplorerAttachmentRequest] = useAtom(
    chatExplorerAttachmentRequestAtom,
  );
  const [appContextAttachmentRequest, setAppContextAttachmentRequest] = useAtom(
    chatAppContextAttachmentRequestAtom,
  );
  const sessionRequestKeyRef = useRef(0);
  const composerPrefill = useAtomValue(chatComposerPrefillAtom);
  const setComposerPrefill = useSetAtom(chatComposerPrefillAtom);

  // Reset to chat whenever the workspace changes — the sessions list is
  // workspace-scoped and would otherwise show stale items briefly.
  useEffect(() => {
    setView("chat");
    setSessionOpenRequest(null);
    setLocalAttachmentRequest(null);
    setExplorerAttachmentRequest(null);
  }, [
    selectedWorkspaceId,
    setExplorerAttachmentRequest,
    setLocalAttachmentRequest,
    setSessionOpenRequest,
    setView,
  ]);

  // Some prefills (for example schedule creation/editing) want a clean draft
  // composer, while others (for example "New issue") should preserve the
  // current session and only seed the input text.
  const lastPrefillRequestKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (!composerPrefill) return;
    if (composerPrefill.requestKey === lastPrefillRequestKeyRef.current) {
      return;
    }
    lastPrefillRequestKeyRef.current = composerPrefill.requestKey;
    if ((composerPrefill.sessionMode ?? "preserve") === "draft") {
      sessionRequestKeyRef.current += 1;
      setSessionOpenRequest({
        sessionId: "",
        requestKey: sessionRequestKeyRef.current,
        mode: "draft",
      });
    }
    setView("chat");
  }, [composerPrefill, setSessionOpenRequest, setView]);

  const handleReturnToChat = useCallback(() => {
    setView("chat");
  }, [setView]);

  const outputsQuery = useQuery({
    queryKey: ["chat-panel-outputs", selectedWorkspaceId],
    queryFn: () =>
      listDisplayOutputs({
        limit: 500,
      }),
    enabled: Boolean(selectedWorkspaceId),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
  const outputsCount = outputsQuery.data?.items.length ?? null;
  const [lastSeenOutputs, setLastSeenOutputs] = useAtom(
    lastSeenOutputsCountAtom,
  );

  // Baseline the seen-count the first time we observe a workspace's outputs so
  // pre-existing artifacts don't all read as "new". After that the dot only
  // appears when the live count climbs past what was there when you arrived.
  useEffect(() => {
    if (!selectedWorkspaceId || outputsCount === null) return;
    if (lastSeenOutputs[selectedWorkspaceId] === undefined) {
      setLastSeenOutputs((prev) => ({
        ...prev,
        [selectedWorkspaceId]: outputsCount,
      }));
    }
  }, [selectedWorkspaceId, outputsCount, lastSeenOutputs, setLastSeenOutputs]);

  const hasNewOutputs =
    outputsCount !== null &&
    Boolean(selectedWorkspaceId) &&
    outputsCount > (lastSeenOutputs[selectedWorkspaceId as string] ?? outputsCount);

  const markOutputsSeen = useCallback(() => {
    if (selectedWorkspaceId && outputsCount !== null) {
      setLastSeenOutputs((prev) => ({
        ...prev,
        [selectedWorkspaceId]: outputsCount,
      }));
    }
  }, [selectedWorkspaceId, outputsCount, setLastSeenOutputs]);

  const handleOpenArtifacts = useCallback(() => {
    markOutputsSeen();
    setView("artifacts");
  }, [markOutputsSeen, setView]);

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      const normalized = sessionId.trim();
      if (!normalized) return;
      sessionRequestKeyRef.current += 1;
      // Leaving any HolaApp surface context — clear it so its API-key gate doesn't
      // leak onto this session (same fix as the sidebar's session open).
      setActiveWebAppSurface(null);
      setSessionOpenRequest({
        sessionId: normalized,
        requestKey: sessionRequestKeyRef.current,
        mode: "session",
      });
      setView("chat");
    },
    [setActiveWebAppSurface, setSessionOpenRequest, setView],
  );

  const handleSessionOpenRequestConsumed = useCallback(
    (requestKey: number) => {
      setSessionOpenRequest((current) =>
        current?.requestKey === requestKey ? null : current,
      );
    },
    [setSessionOpenRequest],
  );

  // Clear the prefill once ChatPane handles it. A lingering request would be
  // re-processed by any fresh ChatPane instance (its dedup ref resets on
  // remount), which for an autoSubmit prefill re-fires the send and mints a
  // duplicate session.
  const handleComposerPrefillConsumed = useCallback(
    (requestKey: number) => {
      setComposerPrefill((current) =>
        current?.requestKey === requestKey ? null : current,
      );
    },
    [setComposerPrefill],
  );

  const handleLocalAttachmentRequestConsumed = useCallback(
    (requestKey: number) => {
      setLocalAttachmentRequest((current) =>
        current?.requestKey === requestKey ? null : current,
      );
    },
    [setLocalAttachmentRequest],
  );
  const handleExplorerAttachmentRequestConsumed = useCallback(
    (requestKey: number) => {
      setExplorerAttachmentRequest((current) =>
        current?.requestKey === requestKey ? null : current,
      );
    },
    [setExplorerAttachmentRequest],
  );
  const handleAppContextAttachmentRequestConsumed = useCallback(
    (requestKey: number) => {
      setAppContextAttachmentRequest((current) =>
        current?.requestKey === requestKey ? null : current,
      );
    },
    [setAppContextAttachmentRequest],
  );

  const handleOpenLocalLink = useCallback(
    (href: string) => {
      if (!href.trim()) return;
      openFileInInternalTab(href);
    },
    [openFileInInternalTab],
  );

  const setFocusMode = useSetAtom(focusModeAtom);
  const handleOpenBackgroundTask = useCallback(
    (task: BackgroundTaskRecordPayload) => {
      const workspaceId = task.workspace_id.trim();
      const sourceType = (task.source_type ?? "").trim().toLowerCase();
      const sourceId = (task.source_id ?? "").trim();
      const cronjobId = (task.cronjob_id ?? "").trim();
      const issueId = (task.issue_id ?? "").trim();

      if (
        workspaceId &&
        sourceId &&
        (sourceType === "issue" || sourceType === "delegate_task")
      ) {
        setFocusMode(false);
        openIssueDetailTab({
          workspaceId,
          issueId: sourceId,
          title: task.title,
        });
        return true;
      }

      // Cronjob runs route to the spawned subagent's issue detail —
      // same UX as a delegated task. `source_id` for cronjob-sourced
      // tasks is the workflow_run_id (set in workflow-runtime when the
      // agent node dispatches), so use `task.issue_id` directly.
      if (workspaceId && sourceType === "cronjob" && issueId) {
        setFocusMode(false);
        openIssueDetailTab({
          workspaceId,
          issueId,
          title: task.title,
        });
        return true;
      }

      // Legacy fallback: when we only know it's a cronjob (e.g. just
      // cronjob_id is set, no issue resolved), drop the user on the
      // Automations surface rather than the Workflows tab so they can
      // see the schedule that produced this run.
      if (workspaceId && (sourceType === "cronjob" || cronjobId)) {
        setFocusMode(false);
        const tab = workspaceSurfaceTab("automations", workspaceId);
        setInternalTabs((prev) => upsertInternalTab(prev, tab));
        setActiveInternalTabId(tab.id);
        return true;
      }

      return false;
    },
    [
      openIssueDetailTab,
      setActiveInternalTabId,
      setFocusMode,
      setInternalTabs,
    ],
  );

  // Blob URLs we minted for ephemeral-image tabs, keyed by tab id. Revoke
  // them once the tab is closed (and on unmount) so we don't leak.
  const ephemeralImageBlobUrlsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const map = ephemeralImageBlobUrlsRef.current;
    if (map.size === 0) return;
    const liveIds = new Set(internalTabs.map((t) => t.id));
    for (const [tabId, url] of map.entries()) {
      if (!liveIds.has(tabId)) {
        URL.revokeObjectURL(url);
        map.delete(tabId);
      }
    }
  }, [internalTabs]);

  useEffect(() => {
    return () => {
      const map = ephemeralImageBlobUrlsRef.current;
      for (const url of map.values()) {
        URL.revokeObjectURL(url);
      }
      map.clear();
    };
  }, []);

  const handlePreviewImageAttachment = useCallback(
    (attachment: AttachmentListItem) => {
      const workspacePath = attachment.workspace_path?.trim() || "";
      if (workspacePath) {
        openFileInInternalTab(workspacePath);
        return;
      }
      const file = attachment.file;
      if (!file) return;

      const existing = internalTabs.find(
        (t) => t.kind === "image" && t.id === `att-${attachment.id}`,
      );
      if (existing) {
        setActiveInternalTabId(existing.id);
        return;
      }

      const url = URL.createObjectURL(file);
      const id = `att-${attachment.id}`;
      ephemeralImageBlobUrlsRef.current.set(id, url);
      const tab = {
        id,
        kind: "image" as const,
        dataUrl: url,
        label: attachment.name || file.name || "Image",
        revokeOnClose: true,
      };
      setInternalTabs((prev) => [...prev, tab]);
      setActiveInternalTabId(id);
    },
    [internalTabs, openFileInInternalTab, setActiveInternalTabId, setInternalTabs],
  );

  const isCanvas = layout !== "split";
  // The context panel rides alongside the chat whenever the chat owns the full
  // canvas (chat-only / focus). In split mode the middle workbench takes over,
  // isCanvas is false, and the context collapses to the header popover.
  const showContextPanel = isCanvas && view === "chat";

  const [collapsedBySession, setCollapsedBySession] = useAtom(
    contextCardCollapsedBySessionAtom,
  );
  const cardSessionKey = selectedSessionId || "_draft";
  const contextCardCollapsed = collapsedBySession[cardSessionKey] ?? true;
  const toggleContextCard = useCallback(() => {
    setCollapsedBySession((prev) => ({
      ...prev,
      [cardSessionKey]: !(prev[cardSessionKey] ?? true),
    }));
  }, [cardSessionKey, setCollapsedBySession]);
  const showContextCard = showContextPanel && !contextCardCollapsed;

  // Viewing the docked Outputs card (canvas) counts as seeing outputs — clear
  // the "new outputs" dot on the header control. Depends on outputsCount so new
  // outputs that land while the card is open are marked seen too.
  useEffect(() => {
    if (showContextCard) {
      markOutputsSeen();
    }
  }, [showContextCard, markOutputsSeen]);

  // In canvas, a collapsed sidebar leaves the chat flush against the window's
  // left edge — reserve the macOS traffic-light (and floating expand button)
  // gutter for the header so the agent name doesn't sit under the stoplights.
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const reserveStoplightGutter = useStoplightCompensation();
  const headerStoplightGutter =
    isCanvas && sidebarCollapsed
      ? reserveStoplightGutter
        ? "7.25rem"
        : "2.75rem"
      : undefined;

  // The panel toggle reveals the middle tab area. With nothing to reveal (no
  // tabs open), "show" would be a dead click — instead surface the session's
  // latest output, or open an empty in-app tab, so the button always does something.
  const hasOpenTabs = internalTabs.length > 0;
  const latestOutputQuery = useQuery({
    queryKey: ["chat-latest-output", selectedWorkspaceId, selectedSessionId],
    queryFn: () =>
      listDisplayOutputs({ limit: 1, sessionId: selectedSessionId }),
    enabled: Boolean(selectedWorkspaceId) && Boolean(selectedSessionId),
    staleTime: 15_000,
  });
  const latestOutput = latestOutputQuery.data?.items[0] ?? null;
  const handleTogglePanel = useCallback(() => {
    if (!isCanvas) {
      setFocusMode(true);
      return;
    }
    if (hasOpenTabs) {
      setFocusMode(false);
      return;
    }
    if (latestOutput) {
      openOutput(latestOutput);
    } else {
      // Nothing to reveal yet (no tabs, no prior output) — open an empty
      // placeholder tab so the panel always shows something, never a dead click.
      const tab = blankTab();
      setInternalTabs((prev) => [...prev, tab]);
      setActiveInternalTabId(tab.id);
    }
    setFocusMode(false);
  }, [
    isCanvas,
    hasOpenTabs,
    latestOutput,
    openOutput,
    setFocusMode,
    setInternalTabs,
    setActiveInternalTabId,
  ]);

  const chatPanelHidden = useAtomValue(chatPanelHiddenAtom);
  const effectiveHidden = chatPanelHidden && !isCanvas;
  const chatPanelWidth = useAtomValue(chatPanelWidthAtom);

  const composerDraftSelector = useAtomValue(composerDraftForWorkspaceAtom);
  const setComposerDraft = useSetAtom(setComposerDraftAtom);
  const composerDraftText = composerDraftSelector(selectedWorkspaceId || null);
  const handleComposerDraftTextChange = useCallback(
    (text: string) => {
      setComposerDraft({ workspaceId: selectedWorkspaceId || null, text });
    },
    [selectedWorkspaceId, setComposerDraft],
  );

  const body =
    view === "artifacts" ? (
      <ArtifactsView
        workspaceId={selectedWorkspaceId || null}
        onBack={handleReturnToChat}
        onOpenOutput={openOutput}
        defaultSessionId={selectedSessionId || null}
      />
    ) : view === "sessions" ? (
      <SessionsView
        workspaceId={selectedWorkspaceId || null}
        onBack={handleReturnToChat}
        onOpenSession={handleOpenSession}
      />
    ) : (
      <ChatPane
        variant="embedded"
        onOpenOutput={openOutput}
        onOpenArtifacts={handleOpenArtifacts}
        outputsHasNew={hasNewOutputs}
        onOpenLinkInBrowser={openUrlInBrowserTab}
        onOpenLocalLink={handleOpenLocalLink}
        onPreviewImageAttachment={handlePreviewImageAttachment}
        onOpenBackgroundTask={handleOpenBackgroundTask}
        onActiveSessionIdChange={setSelectedSessionId}
        sessionOpenRequest={sessionOpenRequest}
        onSessionOpenRequestConsumed={handleSessionOpenRequestConsumed}
        composerPrefillRequest={composerPrefill}
        onComposerPrefillConsumed={handleComposerPrefillConsumed}
        localAttachmentRequest={localAttachmentRequest}
        onLocalAttachmentRequestConsumed={handleLocalAttachmentRequestConsumed}
        explorerAttachmentRequest={explorerAttachmentRequest}
        onExplorerAttachmentRequestConsumed={
          handleExplorerAttachmentRequestConsumed
        }
        appContextAttachmentRequest={appContextAttachmentRequest}
        onAppContextAttachmentRequestConsumed={
          handleAppContextAttachmentRequestConsumed
        }
        composerDraftText={composerDraftText}
        onComposerDraftTextChange={handleComposerDraftTextChange}
        contextSlot={
          showContextCard ? (
            <ChatContextCard onOpenAll={handleOpenArtifacts} />
          ) : null
        }
        headerStoplightGutter={headerStoplightGutter}
      />
    );

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col overflow-hidden bg-background transition-[width] duration-stride ease-out-expo",
        isCanvas ? "min-w-0 flex-1" : effectiveHidden ? "" : "border-l border-border",
      )}
      style={
        isCanvas ? undefined : { width: effectiveHidden ? 0 : chatPanelWidth }
      }
    >
      {!isCanvas && !effectiveHidden ? <ChatPanelResizeHandle /> : null}
      {/* When a HolaApp owns this rail, its header must be CONTINUOUS with the
          app surface's own chrome bar (WebAppSurfacePane: h-9 + border-b) so the
          two form one unbroken titlebar across the window — the chat then reads
          as sitting *under* that shared bar rather than as a detached peer. Match
          the height and bottom border exactly so the seam line is unbroken at the
          column divider. The app's own sessions are also listed under the app in
          the sidebar; this top-right switcher moves between them in-context. The
          Outputs/tabs toolbar stays hidden to keep the chat scoped to the app. */}
      {activeWebAppSurface && view === "chat" && !effectiveHidden ? (
        <div
          className="flex h-9 shrink-0 items-center justify-end border-b border-border"
          // Right-aligned into the window's top-right; reserve the Windows
          // caption gutter (min/restore/close) there, like ChatHeaderToolbar.
          style={{
            paddingLeft: 12,
            paddingRight: windowsCaptionGutterPx() || 12,
          }}
        >
          <AppSessionDropdown
            appId={activeWebAppSurface.holaAppId}
            appTitle={activeWebAppSurface.title}
            workspaceId={selectedWorkspaceId || null}
          />
        </div>
      ) : null}
      {/* A HolaApp-opened chat is scoped to its app — hide the Outputs + tabs-panel
          toolbar so the session reads as belonging only to that HolaApp. */}
      {view === "chat" && !effectiveHidden && !activeWebAppSurface ? (
        <ChatHeaderToolbar
          // top-1.5 (6px) centers the size-7 controls on the shared h-10 top-bar
          // band (y=20) so they line up with the agent name + the floating
          // sidebar-expand button, rather than sitting 2px low.
          className="absolute top-1.5 z-20"
          // The chat rail is flush with the window's right edge, so on Windows
          // this toolbar would sit under the caption controls (min/restore/
          // close). Reserve the caption gutter there; falls back to the base
          // right-3 (12px) inset on macOS/Linux where the top-right is free.
          style={{ right: windowsCaptionGutterPx() || 12 }}
          pinned={showContextPanel}
          cardCollapsed={contextCardCollapsed}
          onToggleCard={toggleContextCard}
          panelHidden={isCanvas}
          onTogglePanel={handleTogglePanel}
          outputsHasNew={hasNewOutputs}
          onOpenArtifacts={handleOpenArtifacts}
          onContextOpen={markOutputsSeen}
        />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </aside>
  );
}

/**
 * Left-edge drag handle for resizing the chat rail in split mode. Mirrors
 * SidebarResizeHandle's pattern (1px hairline that lights up on hover/drag,
 * full-height col-resize hitbox). Persists width on drop via the atom.
 */
function ChatPanelResizeHandle() {
  const [width, setWidth] = useAtom(chatPanelWidthAtom);
  // Pointer capture (not window mouse listeners) so a drag that crosses an
  // iframe — HTML preview, browser tab, app surface — keeps delivering moves
  // and the release; raw window listeners die over iframes and leave the
  // handle stuck following the cursor.
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);

  const stopDragging = useCallback(() => {
    dragStateRef.current = null;
    setDragging(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragStateRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startWidth: width,
      };
      setDragging(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      // Dragging left grows the panel (it sits on the right of the shell),
      // so subtract dx instead of adding.
      const next = Math.max(
        CHAT_PANEL_MIN_WIDTH,
        Math.min(
          CHAT_PANEL_MAX_WIDTH,
          drag.startWidth - (e.clientX - drag.startX),
        ),
      );
      setWidth(next);
    },
    [setWidth],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      stopDragging();
    },
    [stopDragging],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
      title="Drag to resize · Double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={stopDragging}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
      onDoubleClick={() => setWidth(CHAT_PANEL_DEFAULT_WIDTH)}
      className="absolute top-0 left-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize select-none"
    >
      <div
        className={cn(
          "absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-primary/60 transition-opacity duration-snappy ease-emphasized",
          hovering || dragging ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function SessionsView({
  workspaceId,
  onBack,
  onOpenSession,
}: {
  workspaceId: string | null;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2">
        <div className="inline-flex min-w-0 flex-1 items-center gap-2 px-1 text-sm font-medium text-foreground">
          <MessageCircle
            className="size-3.5 shrink-0 text-foreground/55"
            strokeWidth={1.75}
          />
          <span className="truncate">Sessions</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Return to chat"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <SubagentSessionsPane
          workspaceId={workspaceId}
          variant="full"
          onOpenSession={(session) =>
            onOpenSession(session.parent_session_id?.trim() || session.session_id)
          }
        />
      </div>
    </div>
  );
}

function ArtifactsView({
  workspaceId,
  onBack,
  onOpenOutput,
  defaultSessionId,
}: {
  workspaceId: string | null;
  onBack: () => void;
  onOpenOutput: (output: WorkspaceOutputRecordPayload) => void;
  defaultSessionId?: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2">
        <div className="inline-flex min-w-0 flex-1 items-center gap-2 px-1 text-sm font-medium text-foreground">
          <Layers
            className="size-3.5 shrink-0 text-foreground/55"
            strokeWidth={1.75}
          />
          <span className="truncate">Outputs</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Return to chat"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" strokeWidth={1.75} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ArtifactsPane
          workspaceId={workspaceId}
          onOpenOutput={onOpenOutput}
          defaultSessionId={defaultSessionId}
        />
      </div>
    </div>
  );
}
