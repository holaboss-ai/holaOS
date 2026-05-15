import { useSetAtom } from "jotai";
import {
  ChevronDown,
  Globe,
  Loader2,
  Package,
  Plus,
  X,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useWorkspaceBrowser } from "@/components/panes/useWorkspaceBrowser";
import { cn } from "@/lib/utils";
import { newTabOpenAtom } from "./state/ui";

export function TopChrome() {
  const openNewTab = useSetAtom(newTabOpenAtom);
  const { browserState } = useWorkspaceBrowser("user");

  const handleSelectTab = (id: string) => {
    void window.electronAPI.browser.setActiveTab(id);
  };
  const handleCloseTab = (id: string) => {
    void window.electronAPI.browser.closeTab(id);
  };

  const agentTabCount = browserState.tabCounts.agent;

  return (
    <header className="window-drag flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
      {browserState.tabs.map((tab) => (
        <Tab
          key={tab.id}
          id={tab.id}
          title={tab.title || hostFromUrl(tab.url) || "New Tab"}
          faviconUrl={tab.faviconUrl}
          loading={tab.loading}
          active={tab.id === browserState.activeTabId}
          onSelect={handleSelectTab}
          onClose={handleCloseTab}
        />
      ))}
      {agentTabCount > 0 ? <ScratchGroupChip /> : null}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="New tab"
        onClick={() => openNewTab(true)}
        className="window-no-drag ml-1 text-foreground/60"
      >
        <Plus className="size-3.5" />
      </Button>
    </header>
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
}: {
  id: string;
  title: string;
  faviconUrl?: string;
  loading?: boolean;
  active?: boolean;
  driver?: "agent" | "watch";
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const [faviconError, setFaviconError] = useState(false);
  const showFavicon = Boolean(faviconUrl) && !faviconError && !loading;

  return (
    <div
      role="tab"
      aria-selected={active}
      title={title}
      onClick={() => onSelect(id)}
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
            className="size-1.5 shrink-0 rounded-full bg-primary transition-opacity duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover/tab:opacity-0"
            title="Agent driving"
            aria-label="Agent driving"
          />
        ) : null}
      </div>
      <div
        aria-hidden
        className="ml-0 w-0 shrink-0 overflow-hidden transition-[width,margin-left] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/tab:ml-1.5 group-hover/tab:w-3.5"
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
            <ChevronDown className="size-3 transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-aria-expanded/button:rotate-180" />
          </Button>
        }
      />
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[280px] gap-0 p-1"
        style={{
          animationDuration: "220ms",
          animationTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        {tabs.map((tab) => (
          <ScratchRow key={tab.id} tab={tab} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ScratchRow({ tab }: { tab: BrowserStatePayload }) {
  const title = tab.title || hostFromUrl(tab.url) || "New Tab";
  const host = hostFromUrl(tab.url) || tab.url;
  const [faviconError, setFaviconError] = useState(false);
  const showFavicon =
    Boolean(tab.faviconUrl) && !faviconError && !tab.loading;

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    void window.electronAPI.browser.closeTab(tab.id);
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
        onClick={() => void window.electronAPI.browser.setActiveTab(tab.id)}
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
        className="ml-0 w-0 shrink-0 overflow-hidden transition-[width,margin-left] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/scratch-row:ml-1 group-hover/scratch-row:w-4"
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
