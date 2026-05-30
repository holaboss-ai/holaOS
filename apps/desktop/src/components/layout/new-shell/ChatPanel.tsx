import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ChevronDown,
  File as FileIcon,
  Globe,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { ChatPane } from "@/components/panes/ChatPane";
import type { AttachmentListItem } from "@/components/panes/ChatPane/types";
import { SubagentSessionsPane } from "@/components/panes/SubagentSessionsPane";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  activeInternalTabIdAtom,
  type InternalTab,
  internalTabsAtom,
} from "./state/internalTabs";
import {
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MAX_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  automationsOpenAtom,
  chatComposerPrefillAtom,
  chatPanelViewAtom,
  chatSessionOpenRequestAtom,
  chatPanelWidthAtom,
  type ChatSessionOpenRequest,
  focusModeAtom,
  newTabOpenAtom,
} from "./state/ui";
import type { ChatLayout } from "./useChatLayout";
import { useOpenIssueDetailTab } from "./useOpenIssueDetailTab";
import { useOpenWorkspaceOutput } from "./useOpenWorkspaceOutput";

// Linear-style ease — flat, no overshoot. Reused across canvas/width
// transitions so the shell feels of a piece with the inbox cards.
const CHAT_EASE = [0.32, 0.72, 0, 1] as const;

export function ChatPanel({ layout = "split" }: { layout?: ChatLayout }) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const setAutomationsOpen = useSetAtom(automationsOpenAtom);
  const { openOutput, openUrlInBrowserTab, openFileInInternalTab } =
    useOpenWorkspaceOutput();
  const openIssueDetailTab = useOpenIssueDetailTab();

  const [view, setView] = useAtom(chatPanelViewAtom);
  const [sessionOpenRequest, setSessionOpenRequest] = useAtom(
    chatSessionOpenRequestAtom,
  );
  const sessionRequestKeyRef = useRef(0);
  const composerPrefill = useAtomValue(chatComposerPrefillAtom);

  // Reset to chat whenever the workspace changes — the sessions list is
  // workspace-scoped and would otherwise show stale items briefly.
  useEffect(() => {
    setView("chat");
    setSessionOpenRequest(null);
  }, [selectedWorkspaceId, setSessionOpenRequest, setView]);

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

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      const normalized = sessionId.trim();
      if (!normalized) return;
      sessionRequestKeyRef.current += 1;
      setSessionOpenRequest({
        sessionId: normalized,
        requestKey: sessionRequestKeyRef.current,
        mode: "session",
      });
      setView("chat");
    },
    [setView],
  );

  const handleSessionOpenRequestConsumed = useCallback(
    (requestKey: number) => {
      setSessionOpenRequest((current) =>
        current?.requestKey === requestKey ? null : current,
      );
    },
    [setSessionOpenRequest],
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

      if (workspaceId && (sourceType === "cronjob" || cronjobId)) {
        setAutomationsOpen(true);
        return true;
      }

      return false;
    },
    [openIssueDetailTab, setAutomationsOpen, setFocusMode],
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
  const chatPanelWidth = useAtomValue(chatPanelWidthAtom);
  // Only the split layout offers a focus toggle inside ChatHeader; in
  // canvas modes the affordance is the dropdown / restore icon up top.
  const handleEnterFocusMode = useCallback(() => {
    setFocusMode(true);
  }, [setFocusMode]);

  const body =
    view === "sessions" ? (
      <SessionsView
        workspaceId={selectedWorkspaceId || null}
        onBack={handleReturnToChat}
        onOpenSession={handleOpenSession}
        onEnterFocusMode={isCanvas ? undefined : handleEnterFocusMode}
      />
    ) : (
      <ChatPane
        variant="embedded"
        onOpenOutput={openOutput}
        onOpenLinkInBrowser={openUrlInBrowserTab}
        onOpenLocalLink={handleOpenLocalLink}
        onPreviewImageAttachment={handlePreviewImageAttachment}
        onOpenBackgroundTask={handleOpenBackgroundTask}
        sessionOpenRequest={sessionOpenRequest}
        onSessionOpenRequestConsumed={handleSessionOpenRequestConsumed}
        composerPrefillRequest={composerPrefill}
        onEnterFocusMode={isCanvas ? undefined : handleEnterFocusMode}
      />
    );

  return (
    <aside
      className={cn(
        "relative flex shrink-0 flex-col bg-background transition-[width] duration-stride ease-out-expo",
        isCanvas ? "min-w-0 flex-1" : "border-l border-border",
      )}
      style={isCanvas ? undefined : { width: chatPanelWidth }}
    >
      {!isCanvas ? <ChatPanelResizeHandle /> : null}
      {isCanvas ? <CanvasHeader /> : null}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          isCanvas && "mx-auto w-full max-w-[760px] px-8 pt-1",
        )}
      >
        {body}
      </div>
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
  const draggingRef = useRef(false);
  const [hovering, setHovering] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const startX = e.clientX;
      const startWidth = width;
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        // Dragging left grows the panel (panel sits on the right of the
        // shell), so subtract dx instead of adding.
        const next = Math.max(
          CHAT_PANEL_MIN_WIDTH,
          Math.min(CHAT_PANEL_MAX_WIDTH, startWidth - (ev.clientX - startX)),
        );
        setWidth(next);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [setWidth, width],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat panel"
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onDoubleClick={() => setWidth(CHAT_PANEL_DEFAULT_WIDTH)}
      className="absolute top-0 left-0 z-20 h-full w-1.5 -translate-x-1/2 cursor-col-resize select-none"
    >
      <div
        className={cn(
          "absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-primary/60 transition-opacity duration-snappy ease-emphasized",
          hovering || draggingRef.current ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

/**
 * Full-width header bar for canvas modes. Holds the hidden-tabs dropdown
 * on the left (in focus mode) and the new-tab + restore controls on the
 * right. Replaces the floating overlay so the chat below isn't obstructed
 * by mid-content buttons and the area reads as a proper header.
 */
function CanvasHeader() {
  const { browserState } = useWorkspaceBrowser("user");
  const internalTabs = useAtomValue(internalTabsAtom);
  const [focusMode, setFocusMode] = useAtom(focusModeAtom);
  const openNewTab = useSetAtom(newTabOpenAtom);
  const totalTabsHidden = browserState.tabs.length + internalTabs.length;
  const showTabsDropdown = focusMode && totalTabsHidden > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: CHAT_EASE }}
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background/80 px-2 backdrop-blur-sm"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {showTabsDropdown ? (
          <motion.div
            key="tabs-dropdown"
            layout
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -4 }}
            transition={{ duration: 0.16, ease: CHAT_EASE }}
          >
            <HiddenTabsDropdown totalTabsHidden={totalTabsHidden} />
          </motion.div>
        ) : null}
      </AnimatePresence>
      <div className="ml-auto flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New tab"
          onClick={() => openNewTab(true)}
          className="window-no-drag text-foreground/55 hover:text-foreground"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </Button>
        {focusMode && totalTabsHidden > 0 ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Show tabs panel"
            title="Show tabs panel"
            onClick={() => setFocusMode(false)}
            className="window-no-drag text-foreground/45 hover:text-foreground/85"
          >
            <PanelLeftOpen className="size-3.5" strokeWidth={1.5} />
          </Button>
        ) : null}
      </div>
    </motion.div>
  );
}

/**
 * Dropdown listing every hidden tab (browser + internal). Picking a tab
 * activates it AND exits focus, so the user lands on that tab rather than
 * the last-active one. A trailing "Show all tabs" item exits focus without
 * picking — useful when the user just wants the tab strip back.
 */
function HiddenTabsDropdown({
  totalTabsHidden,
}: {
  totalTabsHidden: number;
}) {
  const { browserState } = useWorkspaceBrowser("user");
  const internalTabs = useAtomValue(internalTabsAtom);
  const setActiveInternalTabId = useSetAtom(activeInternalTabIdAtom);
  const setFocusMode = useSetAtom(focusModeAtom);
  const { selectedWorkspaceId } = useWorkspaceSelection();

  const items = useMemo(() => {
    const browserItems = browserState.tabs.map((tab) => ({
      kind: "browser" as const,
      id: tab.id,
      label: tab.title || tab.url || "Untitled tab",
      hint: tab.url ? hostFromUrl(tab.url) : "",
      faviconUrl: tab.faviconUrl ?? "",
    }));
    const internalItems = internalTabs.map((tab) => ({
      kind: "internal" as const,
      id: tab.id,
      label: tab.label,
      hint: tab.kind === "file" ? "Local file" : "Image",
      tab,
    }));
    return [...browserItems, ...internalItems];
  }, [browserState.tabs, internalTabs]);

  const activateBrowserTab = useCallback(
    async (tabId: string) => {
      setActiveInternalTabId(null);
      if (selectedWorkspaceId) {
        try {
          await window.electronAPI.browser.setActiveWorkspace(
            selectedWorkspaceId,
            "user",
          );
        } catch {
          // non-fatal
        }
      }
      try {
        await window.electronAPI.browser.setActiveTab(tabId);
      } catch {
        // non-fatal
      }
    },
    [selectedWorkspaceId, setActiveInternalTabId],
  );

  const handleSelect = useCallback(
    async (item: (typeof items)[number]) => {
      if (item.kind === "browser") {
        await activateBrowserTab(item.id);
      } else {
        setActiveInternalTabId(item.id);
      }
      setFocusMode(false);
    },
    [activateBrowserTab, setActiveInternalTabId, setFocusMode],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="window-no-drag inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-foreground/55 transition-colors hover:bg-foreground/[0.04] hover:text-foreground focus-visible:bg-foreground/[0.04] focus-visible:outline-none data-[popup-open]:bg-foreground/[0.04] data-[popup-open]:text-foreground"
        title="Hidden tabs"
      >
        <span className="tabular-nums">
          {totalTabsHidden} tab{totalTabsHidden === 1 ? "" : "s"}
        </span>
        <ChevronDown className="size-3 opacity-60" strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-72">
        {items.map((item) => (
          <DropdownMenuItem
            key={`${item.kind}-${item.id}`}
            onClick={() => void handleSelect(item)}
            className="gap-2"
          >
            <TabIconForItem item={item} />
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint ? (
              <span className="shrink-0 truncate text-[10px] text-foreground/40">
                {item.hint}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => setFocusMode(false)}
          className="gap-2 text-foreground/65"
        >
          <PanelLeftOpen className="size-3.5" strokeWidth={1.5} />
          <span>Show tabs panel</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type HiddenTabItem =
  | {
      kind: "browser";
      id: string;
      label: string;
      hint: string;
      faviconUrl: string;
    }
  | {
      kind: "internal";
      id: string;
      label: string;
      hint: string;
      tab: InternalTab;
    };

function TabIconForItem({ item }: { item: HiddenTabItem }) {
  if (item.kind === "browser") {
    return item.faviconUrl ? (
      <img
        src={item.faviconUrl}
        alt=""
        className="size-3.5 shrink-0 rounded-sm"
      />
    ) : (
      <Globe className="size-3.5 shrink-0 text-foreground/45" strokeWidth={1.75} />
    );
  }
  return (
    <FileIcon
      className="size-3.5 shrink-0 text-foreground/45"
      strokeWidth={1.75}
    />
  );
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function SessionsView({
  workspaceId,
  onBack,
  onOpenSession,
  onEnterFocusMode,
}: {
  workspaceId: string | null;
  onBack: () => void;
  onOpenSession: (sessionId: string) => void;
  onEnterFocusMode?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2">
        {onEnterFocusMode ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Focus on chat"
            title="Focus on chat"
            onClick={onEnterFocusMode}
            className="text-muted-foreground hover:text-foreground"
          >
            <PanelLeftClose className="size-4" strokeWidth={1.5} />
          </Button>
        ) : null}
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
