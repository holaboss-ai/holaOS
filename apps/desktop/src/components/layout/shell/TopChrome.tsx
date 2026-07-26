import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  CircleDot,
  Feather,
  Image as ImageIcon,
  Maximize,
  Minimize,
  Plus,
  X,
} from "@/components/ui/icons";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FileTypeIcon } from "@/lib/fileIcon";
import { useStoplightCompensation } from "@/lib/StoplightContext";
import { cn } from "@/lib/utils";
import { windowsCaptionGutterPx } from "@/lib/windowControls";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import {
  activeInternalTabIdAtom,
  type InternalTab,
  internalTabsAtom,
} from "./state/internalTabs";
import { removeRecentFileByPathAtom } from "./state/recentFiles";
import { centerFullscreenAtom, sidebarCollapsedAtom } from "./state/ui";

export function TopChrome() {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const reserveStoplightGutter = useStoplightCompensation();
  const [centerFullscreen, setCenterFullscreen] = useAtom(centerFullscreenAtom);
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const [activeInternalTabId, setActiveInternalTabId] = useAtom(
    activeInternalTabIdAtom,
  );
  const removeRecentFileByPath = useSetAtom(removeRecentFileByPathAtom);
  const tabStripRef = useRef<HTMLDivElement>(null);
  const captionGutter = windowsCaptionGutterPx();

  // Mouse-wheel-to-horizontal-scroll redirect. Trackpads already emit
  // deltaX for horizontal scroll, so only redirect when deltaY dominates
  // (classic vertical wheel). Native passive default would block
  // preventDefault, so this is a manual addEventListener with passive: false.
  useEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // Active tab auto-scrolls into view smoothly. Triggers on either:
  // - active id changes (user picked a tab that was offscreen, or an IPC
  //   focus came in)
  // - tab count grows (new tab appended at the right edge while user is
  //   scrolled left — pull it into view)
  //
  // The tab chips animate `width: 0 → 180` via framer-motion on mount
  // (140ms), so a synchronous scrollIntoView at effect time measures the
  // brand-new tab as a 0-width element pinned to the strip's right edge
  // and `inline: "nearest"` decides it's already "visible" — even though
  // the tab will overflow the viewport once its animation completes.
  // Wait one frame for the active tab to mount, then once for the
  // animation to settle, before measuring + scrolling. `inline: "center"`
  // is forgiving of layout shifts mid-scroll and lines the active tab up
  // in the middle of the strip's visible window when it would otherwise
  // be partly clipped.
  const internalTabsCount = internalTabs.length;
  useEffect(() => {
    const el = tabStripRef.current;
    if (!el) return;
    let timerId: number | null = null;
    const raf = window.requestAnimationFrame(() => {
      // After paint: framer-motion's enter animation runs ~140ms. Defer
      // the actual scroll a hair past that so we measure the settled
      // width, not the 0-width starting frame.
      timerId = window.setTimeout(() => {
        const active = el.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        );
        if (!active) return;
        active.scrollIntoView({
          behavior: "smooth",
          inline: "center",
          block: "nearest",
        });
      }, 160);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [activeInternalTabId, internalTabsCount]);

  // Most-recently-active tab history, newest first, so closing the active tab
  // returns focus to whichever tab the user looked at last — Chrome / Safari
  // behavior, much friendlier than "jump to left sibling". Capped to a small
  // window since beyond ~16 the MRU signal is no longer interesting.
  const tabActivationHistoryRef = useRef<string[]>([]);
  useEffect(() => {
    if (!activeInternalTabId) return;
    const prev = tabActivationHistoryRef.current;
    if (prev[0] === activeInternalTabId) return;
    tabActivationHistoryRef.current = [
      activeInternalTabId,
      ...prev.filter((id) => id !== activeInternalTabId),
    ].slice(0, 16);
  }, [activeInternalTabId]);

  // Pick the next active tab when closing the currently-active one. Walks the
  // MRU stack skipping the tab being closed and any stale ids, else falls back
  // to any remaining tab. Returns null when no other tab exists.
  const pickNextActiveAfterClose = useCallback(
    (closedId: string): string | null => {
      const liveIds = new Set(
        internalTabs.map((t) => t.id).filter((id) => id !== closedId),
      );
      for (const id of tabActivationHistoryRef.current) {
        if (id === closedId) continue;
        if (liveIds.has(id)) return id;
      }
      const firstInternal = internalTabs.find((t) => t.id !== closedId);
      return firstInternal ? firstInternal.id : null;
    },
    [internalTabs],
  );

  const handleSelectInternalTab = (id: string) => {
    setActiveInternalTabId(id);
  };

  const handleCloseInternalTab = useCallback(
    (id: string) => {
      const wasActive = activeInternalTabId === id;
      setInternalTabs((prev) => prev.filter((t) => t.id !== id));
      if (wasActive) {
        setActiveInternalTabId(pickNextActiveAfterClose(id));
      }
    },
    [
      activeInternalTabId,
      pickNextActiveAfterClose,
      setInternalTabs,
      setActiveInternalTabId,
    ],
  );

  // Keep latest refs for the close-active-tab IPC handler so the
  // subscription is registered once and never sees stale closures.
  const activeInternalTabIdRef = useRef(activeInternalTabId);
  const handleCloseInternalTabRef = useRef(handleCloseInternalTab);
  activeInternalTabIdRef.current = activeInternalTabId;
  handleCloseInternalTabRef.current = handleCloseInternalTab;

  useEffect(() => {
    return window.electronAPI.app.onCloseActiveTab(() => {
      const internalId = activeInternalTabIdRef.current;
      if (internalId) {
        handleCloseInternalTabRef.current(internalId);
      }
    });
  }, []);

  const openContextMenu =
    (tabId: string) =>
    (e: React.MouseEvent) => {
      e.preventDefault();
      const internalIds = internalTabs.map((t) => t.id);
      const targetGlobalIdx = internalIds.indexOf(tabId);
      if (targetGlobalIdx === -1) return;
      const idsLeft = internalIds.slice(0, targetGlobalIdx);
      const idsRight = internalIds.slice(targetGlobalIdx + 1);
      const idsOthers = [...idsLeft, ...idsRight];
      const targetInternal = internalTabs.find((t) => t.id === tabId) ?? null;
      const deletableFile =
        targetInternal && targetInternal.kind === "file" ? targetInternal : null;

      const closeMany = (ids: string[]) => {
        const idSet = new Set(ids);
        setInternalTabs((prev) => prev.filter((t) => !idSet.has(t.id)));
        if (activeInternalTabId && idSet.has(activeInternalTabId)) {
          setActiveInternalTabId(null);
        }
      };

      void window.electronAPI.tabs
        .showContextMenu({
          canCloseLeft: idsLeft.length > 0,
          canCloseRight: idsRight.length > 0,
          canCloseOthers: idsOthers.length > 0,
          canCloseAll: internalIds.length > 0,
          hasDeleteFile: deletableFile !== null,
        })
        .then((action) => {
          if (!action) return;
          if (action === "close") {
            handleCloseInternalTab(tabId);
            return;
          }
          if (action === "closeOthers") return closeMany(idsOthers);
          if (action === "closeToLeft") return closeMany(idsLeft);
          if (action === "closeToRight") return closeMany(idsRight);
          if (action === "closeAll") return closeMany(internalIds);
          if (action === "deleteFile" && deletableFile) {
            const tab = deletableFile;
            if (
              !window.confirm(
                `Delete '${tab.label}'? This moves the file to the trash and can't be undone from here.`,
              )
            ) {
              return;
            }
            void window.electronAPI.fs
              .deletePath(tab.filePath, selectedWorkspaceId ?? null)
              .then(() => {
                handleCloseInternalTab(tab.id);
                removeRecentFileByPath({
                  filePath: tab.filePath,
                  workspaceId: selectedWorkspaceId ?? null,
                });
              })
              .catch(() => {
                // surfaced via OS notification when applicable
              });
          }
        });
    };

  return (
    <header
      className="window-drag flex h-10 shrink-0 items-center gap-1 border-b border-border pr-3 transition-[padding-left] duration-stride ease-out-expo"
      style={{
        // Clear the macOS stoplight + the floating sidebar-expand button that
        // sits at the window's top-left while the sidebar is collapsed.
        // Reserve the macOS traffic-light gutter whenever nothing sits to the
        // left of the tab strip. Fullscreen hides the sidebar AND the floating
        // expand button, so it only needs the stoplight width; a merely
        // collapsed sidebar also needs room for that floating expand button.
        paddingLeft: centerFullscreen
          ? reserveStoplightGutter
            ? "5rem"
            : "0.5rem"
          : sidebarCollapsed
            ? reserveStoplightGutter
              ? "7.25rem"
              : "2.75rem"
            : "0.5rem",
        // In fullscreen the center pane spans the full window, so the New-tab /
        // fullscreen controls at this header's right edge reach the Windows
        // caption buttons. Reserve the caption gutter there; otherwise the
        // right ChatPanel covers the window edge and the base pr-3 is enough.
        paddingRight:
          centerFullscreen && captionGutter ? captionGutter : undefined,
      }}
    >
      <div
        ref={tabStripRef}
        className="flex min-w-0 flex-1 scroll-smooth items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {/* AnimatePresence + per-chip motion.div gives a visible close
            animation: chip shrinks to 0 width and fades, neighbors slide
            together via the shared `layout` flag. Critical when two tabs
            share a title (e.g. two "Library" surfaces or two "index.md"
            files) — without the transition you can't tell *which* one
            you closed. exit is intentionally short (140ms) so it reads
            as feedback, not waiting. */}
        <AnimatePresence initial={false}>
          {internalTabs.map((tab) => (
            <motion.div
              key={tab.id}
              layout
              initial={{ opacity: 0, width: 0, scale: 0.96 }}
              animate={{ opacity: 1, width: 180, scale: 1 }}
              exit={{ opacity: 0, width: 0, scale: 0.96 }}
              transition={{
                duration: 0.14,
                ease: [0.16, 1, 0.3, 1],
              }}
              className="shrink-0 overflow-hidden"
            >
              <InternalTab
                id={tab.id}
                kind={tab.kind}
                label={tab.label}
                filePath={tab.kind === "file" ? tab.filePath : null}
                active={tab.id === activeInternalTabId}
                onSelect={handleSelectInternalTab}
                onClose={handleCloseInternalTab}
                onContextMenu={openContextMenu(tab.id)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={centerFullscreen ? "Exit fullscreen" : "Fullscreen"}
              onClick={() => setCenterFullscreen((value) => !value)}
              className="window-no-drag grid size-7 shrink-0 place-items-center rounded-md text-foreground/55 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
            />
          }
        >
          {centerFullscreen ? (
            <Minimize className="size-3.5" strokeWidth={1.75} />
          ) : (
            <Maximize className="size-3.5" strokeWidth={1.75} />
          )}
        </TooltipTrigger>
        <TooltipContent>
          {centerFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        </TooltipContent>
      </Tooltip>
    </header>
  );
}

// Shared chip for the in-app tabs (issue detail, file preview, dashboards,
// blank new tab, etc.). Owns: active/inactive surface, middle-click close,
// right-click context menu, hover-reveal close affordance. Per-kind concerns
// (file icon vs kind glyph) come in via `leadingIcon`.
function TabChip({
  id,
  title,
  active,
  leadingIcon,
  onSelect,
  onClose,
  onContextMenu,
}: {
  id: string;
  title: string;
  active?: boolean;
  leadingIcon: ReactNode;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      title={title}
      onClick={() => onSelect(id)}
      onContextMenu={onContextMenu}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(id);
        }
      }}
      className={cn(
        // Fixed width keeps tabs uniform so the strip reads as a stable
        // grid instead of a content-width row that re-flows whenever a
        // title hydrates. The close button column below also reserves its
        // space unconditionally, so hover never causes layout shift.
        "window-no-drag group/tab flex h-7 w-[180px] shrink-0 cursor-default items-center rounded-md px-2.5 text-sm transition-colors",
        active
          ? "bg-foreground/[0.09] text-foreground"
          : "text-foreground/60 hover:bg-foreground/[0.05] hover:text-foreground/85",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          aria-hidden
          className="grid size-3.5 shrink-0 place-items-center text-foreground/60"
        >
          {leadingIcon}
        </span>
        <span className="flex-1 truncate">{title}</span>
      </div>
      <div aria-hidden className="ml-1.5 w-3.5 shrink-0">
        <button
          type="button"
          aria-label={`Close ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose(id);
          }}
          // Always-visible to keyboard focus (focus-visible ring), but
          // pointer users still get the hover-fade affordance via opacity.
          className="grid size-3.5 shrink-0 place-items-center rounded-full bg-foreground/10 text-foreground/60 opacity-0 transition-opacity duration-fast ease-out hover:bg-foreground/20 hover:text-foreground group-hover/tab:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X className="size-2.5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

function InternalTab({
  id,
  kind,
  label,
  filePath,
  active,
  onSelect,
  onClose,
  onContextMenu,
}: {
  id: string;
  kind: InternalTab["kind"];
  label: string;
  filePath: string | null;
  active?: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const icon = filePath ? (
    <FileTypeIcon filePath={filePath} size={14} className="shrink-0" />
  ) : kind === "issue_detail" ? (
    <CircleDot className="size-3.5" />
  ) : kind === "skills" ? (
    <Feather className="size-3.5" />
  ) : kind === "blank" ? (
    <Plus className="size-3.5" />
  ) : (
    <ImageIcon className="size-3.5" />
  );

  return (
    <TabChip
      id={id}
      title={label}
      active={active}
      leadingIcon={icon}
      onSelect={onSelect}
      onClose={onClose}
      onContextMenu={onContextMenu}
    />
  );
}

