import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ChevronDown,
  Globe,
  Image as ImageIcon,
  Loader2,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  X,
} from "lucide-react";
import { FileTypeIcon } from "@/lib/fileIcon";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PopoverContent,
  PopoverTrigger,
  SuspendingPopover as Popover,
} from "./overlay-presence";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { useWorkspaceSelection } from "@/lib/workspaceSelection";
import { cn } from "@/lib/utils";
import {
  TabContextMenu,
  type TabContextMenuTarget,
} from "./TabContextMenu";
import {
  activeInternalTabIdAtom,
  internalTabsAtom,
} from "./state/internalTabs";
import { removeRecentFileByPathAtom } from "./state/recentFiles";
import { newTabOpenAtom, sidebarCollapsedAtom } from "./state/ui";

export function TopChrome() {
  const openNewTab = useSetAtom(newTabOpenAtom);
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const { browserState } = useWorkspaceBrowser("user");
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const [internalTabs, setInternalTabs] = useAtom(internalTabsAtom);
  const [activeInternalTabId, setActiveInternalTabId] = useAtom(
    activeInternalTabIdAtom,
  );
  const removeRecentFileByPath = useSetAtom(removeRecentFileByPathAtom);
  const [menuTarget, setMenuTarget] = useState<TabContextMenuTarget | null>(
    null,
  );

  const handleSelectBrowserTab = (id: string) => {
    setActiveInternalTabId(null);
    if (selectedWorkspaceId) {
      void window.electronAPI.browser.setActiveWorkspace(
        selectedWorkspaceId,
        "user",
      );
    }
    void window.electronAPI.browser.setActiveTab(id);
  };

  const handleCloseBrowserTab = (id: string) => {
    void window.electronAPI.browser.closeTab(id);
  };

  const handleSelectInternalTab = (id: string) => {
    setActiveInternalTabId(id);
  };

  const handleCloseInternalTab = (id: string) => {
    setInternalTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeInternalTabId === id) {
        // Activate the previous sibling if any, else clear (revert to browser).
        const idx = prev.findIndex((t) => t.id === id);
        const fallback = next[idx - 1] ?? next[0] ?? null;
        setActiveInternalTabId(fallback?.id ?? null);
      }
      return next;
    });
  };

  const openContextMenu =
    (list: "browser" | "internal", tabId: string) =>
    (e: React.MouseEvent) => {
      e.preventDefault();
      setMenuTarget({ list, tabId, x: e.clientX, y: e.clientY });
    };

  const buildContextActions = () => {
    if (!menuTarget) return null;
    const browserTabs = browserState.tabs;
    const browserIds = browserTabs.map((t) => t.id);
    const internalIds = internalTabs.map((t) => t.id);
    const allIds = [...browserIds, ...internalIds];
    const targetGlobalIdx = allIds.indexOf(menuTarget.tabId);
    if (targetGlobalIdx === -1) return null;
    const idsLeft = allIds.slice(0, targetGlobalIdx);
    const idsRight = allIds.slice(targetGlobalIdx + 1);
    const idsOthers = [...idsLeft, ...idsRight];

    const closeMany = (ids: string[]) => {
      const internalSet = new Set(internalIds);
      const browserToClose = ids.filter((id) => !internalSet.has(id));
      const internalToClose = ids.filter((id) => internalSet.has(id));
      for (const id of browserToClose) {
        void window.electronAPI.browser.closeTab(id);
      }
      if (internalToClose.length > 0) {
        setInternalTabs((prev) =>
          prev.filter((t) => !internalToClose.includes(t.id)),
        );
        if (
          activeInternalTabId &&
          internalToClose.includes(activeInternalTabId)
        ) {
          setActiveInternalTabId(null);
        }
      }
    };

    const targetInternal =
      menuTarget.list === "internal"
        ? internalTabs.find((t) => t.id === menuTarget.tabId) ?? null
        : null;

    return {
      onClose: () => {
        if (menuTarget.list === "browser") handleCloseBrowserTab(menuTarget.tabId);
        else handleCloseInternalTab(menuTarget.tabId);
      },
      onCloseOthers: () => closeMany(idsOthers),
      onCloseToLeft: () => closeMany(idsLeft),
      onCloseToRight: () => closeMany(idsRight),
      onDeleteFile: (() => {
        if (!targetInternal || targetInternal.kind !== "file") {
          return undefined;
        }
        const tab = targetInternal;
        return () => {
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
              // surfaced via OS notification when applicable; nothing
              // useful to render inline.
            });
        };
      })(),
      canCloseLeft: idsLeft.length > 0,
      canCloseRight: idsRight.length > 0,
      canCloseOthers: idsOthers.length > 0,
    };
  };
  const ctxActions = buildContextActions();

  const agentTabCount = browserState.tabCounts.agent;

  return (
    <header
      className="window-drag flex h-10 shrink-0 items-center gap-1 border-b border-border pr-3 transition-[padding-left] duration-stride ease-out-expo"
      style={{
        paddingLeft: sidebarCollapsed ? "5rem" : "0.5rem",
      }}
    >
      <button
        type="button"
        aria-label={sidebarCollapsed ? "Pin sidebar open" : "Collapse sidebar"}
        title={
          sidebarCollapsed
            ? "Pin sidebar open (⌘\\)"
            : "Collapse sidebar (⌘\\)"
        }
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        className="window-no-drag mr-1 grid size-7 shrink-0 place-items-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen className="size-3.5" />
        ) : (
          <PanelLeftClose className="size-3.5" />
        )}
      </button>
      {browserState.tabs.map((tab) => (
        <Tab
          key={tab.id}
          id={tab.id}
          title={tab.title || hostFromUrl(tab.url) || "New Tab"}
          faviconUrl={tab.faviconUrl}
          loading={tab.loading}
          active={
            tab.id === browserState.activeTabId && !activeInternalTabId
          }
          onSelect={handleSelectBrowserTab}
          onClose={handleCloseBrowserTab}
          onContextMenu={openContextMenu("browser", tab.id)}
        />
      ))}
      {internalTabs.map((tab) => (
        <InternalTabChip
          key={tab.id}
          id={tab.id}
          label={tab.label}
          filePath={tab.kind === "file" ? tab.filePath : null}
          active={tab.id === activeInternalTabId}
          onSelect={handleSelectInternalTab}
          onClose={handleCloseInternalTab}
          onContextMenu={openContextMenu("internal", tab.id)}
        />
      ))}
      {agentTabCount > 0 ? <ScratchGroupChip /> : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="New tab"
        onClick={() => openNewTab(true)}
        className="window-no-drag ml-1 text-foreground/55 hover:text-foreground"
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
      </Button>
      {menuTarget && ctxActions ? (
        <TabContextMenu
          target={menuTarget}
          actions={ctxActions}
          canCloseLeft={ctxActions.canCloseLeft}
          canCloseRight={ctxActions.canCloseRight}
          canCloseOthers={ctxActions.canCloseOthers}
          onDismiss={() => setMenuTarget(null)}
        />
      ) : null}
    </header>
  );
}

function InternalTabChip({
  id,
  label,
  filePath,
  active,
  onSelect,
  onClose,
  onContextMenu,
}: {
  id: string;
  label: string;
  filePath: string | null;
  active?: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      title={label}
      onClick={() => onSelect(id)}
      onContextMenu={onContextMenu}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(id);
        }
      }}
      className={cn(
        "window-no-drag group/tab flex h-7 max-w-[180px] cursor-default items-center rounded-md px-2.5 text-sm transition-colors",
        active
          ? "bg-foreground/[0.07] text-foreground"
          : "text-foreground/60 hover:bg-foreground/[0.04]",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {filePath ? (
          <FileTypeIcon filePath={filePath} size={14} className="shrink-0" />
        ) : (
          <ImageIcon className="size-3.5 shrink-0 text-foreground/60" />
        )}
        <span className="flex-1 truncate">{label}</span>
      </div>
      <div
        aria-hidden
        className="ml-0 w-0 shrink-0 overflow-hidden transition-[width,margin-left] duration-300 ease-out-expo group-hover/tab:ml-1.5 group-hover/tab:w-3.5"
      >
        <button
          type="button"
          aria-label="Close tab"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onClose(id);
          }}
          className="grid size-3.5 shrink-0 place-items-center rounded-full bg-foreground/10 text-foreground/60 opacity-0 transition-opacity duration-200 ease-out hover:bg-foreground/20 hover:text-foreground group-hover/tab:opacity-100"
        >
          <X className="size-2.5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function Tab({
  id,
  title,
  faviconUrl,
  loading,
  active,
  driver,
  onSelect,
  onClose,
  onContextMenu,
}: {
  id: string;
  title: string;
  faviconUrl?: string;
  loading?: boolean;
  active?: boolean;
  driver?: "agent" | "watch";
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [faviconError, setFaviconError] = useState(false);
  const showFavicon = Boolean(faviconUrl) && !faviconError && !loading;

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
        "window-no-drag group/tab flex h-7 max-w-[180px] cursor-default items-center rounded-md px-2.5 text-sm transition-colors",
        active
          ? "bg-foreground/[0.07] text-foreground"
          : "text-foreground/60 hover:bg-foreground/[0.04]",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          aria-hidden
          className="grid size-3.5 shrink-0 place-items-center text-foreground/60"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : showFavicon ? (
            <img
              src={faviconUrl}
              alt=""
              className="size-3.5 rounded-[2px] object-contain"
              onError={() => setFaviconError(true)}
            />
          ) : (
            <Globe className="size-3.5" />
          )}
        </span>
        <span className="flex-1 truncate">{title}</span>
        {driver === "agent" ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-primary transition-opacity duration-300 ease-emphasized group-hover/tab:opacity-0"
            title="Agent driving"
            aria-label="Agent driving"
          />
        ) : null}
      </div>
      <div
        aria-hidden
        className="ml-0 w-0 shrink-0 overflow-hidden transition-[width,margin-left] duration-300 ease-out-expo group-hover/tab:ml-1.5 group-hover/tab:w-3.5"
      >
        <button
          type="button"
          aria-label="Close tab"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onClose(id);
          }}
          className="grid size-3.5 shrink-0 place-items-center rounded-full bg-foreground/10 text-foreground/60 opacity-0 transition-opacity duration-200 ease-out hover:bg-foreground/20 hover:text-foreground group-hover/tab:opacity-100"
        >
          <X className="size-2.5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

function ScratchGroupChip() {
  // Only mounted when the user-space hook reports tabCounts.agent > 0.
  // Subscribing here is then safe — ensureBrowserTabSpaceInitialized
  // sees existing tabs and skips its seed-a-default-tab branch.
  const { browserState: agentState } = useWorkspaceBrowser("agent");
  const tabs = agentState.tabs;

  if (tabs.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="window-no-drag ml-1 h-7 gap-1.5 border-dashed border-foreground/15 bg-transparent px-2.5 text-sm font-normal text-foreground/60 aria-expanded:border-foreground/25 aria-expanded:text-foreground"
          >
            <Package className="size-3.5" />
            <span>Agent scratch</span>
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {tabs.length}
            </Badge>
            <ChevronDown className="size-3 transition-transform duration-200 ease-out-expo group-aria-expanded/button:rotate-180" />
          </Button>
        }
      />
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[280px] gap-0 p-1"
        style={{
          animationDuration: "var(--duration-base)",
          animationTimingFunction: "var(--ease-out-expo)",
        }}
      >
        {tabs.map((tab) => (
          <ScratchRow key={tab.id} tab={tab} />
        ))}
        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            onClick={() => {
              for (const tab of tabs) {
                void window.electronAPI.browser.closeTab(tab.id);
              }
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/60 transition-colors hover:bg-foreground/[0.04] hover:text-destructive"
          >
            <X className="size-3.5" />
            Close all agent tabs
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ScratchRow({ tab }: { tab: BrowserStatePayload }) {
  const { selectedWorkspaceId } = useWorkspaceSelection();
  const title = tab.title || hostFromUrl(tab.url) || "New Tab";
  const host = hostFromUrl(tab.url) || tab.url;
  const [faviconError, setFaviconError] = useState(false);
  const showFavicon =
    Boolean(tab.faviconUrl) && !faviconError && !tab.loading;

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    void window.electronAPI.browser.closeTab(tab.id);
  };

  const handleSelect = async () => {
    if (selectedWorkspaceId) {
      await window.electronAPI.browser.setActiveWorkspace(
        selectedWorkspaceId,
        "agent",
      );
    }
    await window.electronAPI.browser.setActiveTab(tab.id);
  };

  return (
    <div
      className="group/scratch-row flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-200 ease-out hover:bg-foreground/[0.04]"
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void window.electronAPI.browser.closeTab(tab.id);
        }
      }}
    >
      <button
        type="button"
        title={title}
        onClick={() => void handleSelect()}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span
          aria-hidden
          className="grid size-5 shrink-0 place-items-center overflow-hidden rounded-[5px] bg-foreground/[0.06] text-[10px] font-semibold text-foreground/55 ring-1 ring-inset ring-foreground/5 transition-colors duration-200 ease-out group-hover/scratch-row:bg-foreground/[0.08] group-hover/scratch-row:text-foreground/70"
        >
          {tab.loading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : showFavicon ? (
            <img
              src={tab.faviconUrl}
              alt=""
              className="size-3.5 rounded-[2px] object-contain"
              onError={() => setFaviconError(true)}
            />
          ) : (
            <Globe className="size-3" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm text-foreground">{title}</span>
          <span className="truncate text-xs text-foreground/35">{host}</span>
        </span>
      </button>
      <div
        aria-hidden
        className="ml-0 w-0 shrink-0 overflow-hidden transition-[width,margin-left] duration-300 ease-out-expo group-hover/scratch-row:ml-1 group-hover/scratch-row:w-4"
      >
        <button
          type="button"
          aria-label="Close tab"
          tabIndex={-1}
          onClick={handleClose}
          className="grid size-4 place-items-center rounded-full bg-foreground/10 text-foreground/60 opacity-0 transition-opacity duration-200 ease-out hover:bg-foreground/20 hover:text-foreground group-hover/scratch-row:opacity-100"
        >
          <X className="size-2.5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
