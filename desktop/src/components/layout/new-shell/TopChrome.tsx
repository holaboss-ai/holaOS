import { useSetAtom } from "jotai";
import {
  ChevronDown,
  FileText,
  Globe,
  LayoutDashboard,
  Package,
  Plus,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { newTabOpenAtom } from "./state/ui";

export function TopChrome() {
  const openNewTab = useSetAtom(newTabOpenAtom);
  return (
    <header className="window-drag flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
      <Tab title="Engagement" icon={<LayoutDashboard className="size-3.5" />} />
      <Tab title="launch brief" icon={<FileText className="size-3.5" />} active />
      <Tab title="linkedin.com" icon={<Globe className="size-3.5" />} />
      <Tab
        title="linkedin.com"
        icon={<Globe className="size-3.5" />}
        driver="agent"
      />
      <ScratchGroupChip />
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

function Tab({
  title,
  icon,
  active,
  driver,
}: {
  title: string;
  icon: React.ReactNode;
  active?: boolean;
  driver?: "agent" | "watch";
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      className={cn(
        "window-no-drag group/tab flex h-7 max-w-[180px] cursor-default items-center rounded-md px-2.5 text-sm transition-colors",
        active
          ? "bg-foreground/[0.07] text-foreground"
          : "text-foreground/60 hover:bg-foreground/[0.04]",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {icon}
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
          className="grid size-3.5 shrink-0 place-items-center rounded-full bg-foreground/10 text-foreground/60 opacity-0 transition-opacity duration-200 ease-out hover:bg-foreground/20 hover:text-foreground group-hover/tab:opacity-100"
        >
          <X className="size-2.5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}

const SCRATCH_TABS: Array<{ title: string; url: string; when: string }> = [
  { title: "Joshua Li · LinkedIn", url: "linkedin.com/in/joshli", when: "now" },
  { title: "Jeffrey Li · LinkedIn", url: "linkedin.com/in/jeffl", when: "1m" },
  { title: "ICP research notes", url: "notion.so/icp-q4", when: "3m" },
  { title: "Competitor X pricing", url: "competitorx.com/pricing", when: "5m" },
  { title: "Cold email examples", url: "google.com/search", when: "8m" },
];

function ScratchGroupChip() {
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
              {SCRATCH_TABS.length}
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
        {SCRATCH_TABS.map((tab) => (
          <ScratchRow key={tab.url} tab={tab} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function ScratchRow({
  tab,
}: {
  tab: { title: string; url: string; when: string };
}) {
  const initial = tab.title.trim().charAt(0).toUpperCase() || "•";
  const host = tab.url.split("/")[0] ?? tab.url;
  return (
    <div className="group/scratch-row flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-200 ease-out hover:bg-foreground/[0.04]">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span
          aria-hidden
          className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-foreground/[0.06] text-[10px] font-semibold text-foreground/55 ring-1 ring-inset ring-foreground/5 transition-colors duration-200 ease-out group-hover/scratch-row:bg-foreground/[0.08] group-hover/scratch-row:text-foreground/70"
        >
          {initial}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm text-foreground">{tab.title}</span>
          <span className="truncate text-xs text-foreground/35">{host}</span>
        </span>
      </button>
      <span className="shrink-0 text-xs tabular-nums text-foreground/35">
        {tab.when}
      </span>
      <div
        aria-hidden
        className="ml-0 w-0 shrink-0 overflow-hidden transition-[width,margin-left] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/scratch-row:ml-1 group-hover/scratch-row:w-4"
      >
        <button
          type="button"
          aria-label="Close tab"
          tabIndex={-1}
          className="grid size-4 place-items-center rounded-full bg-foreground/10 text-foreground/60 opacity-0 transition-opacity duration-200 ease-out hover:bg-foreground/20 hover:text-foreground group-hover/scratch-row:opacity-100"
        >
          <X className="size-2.5" strokeWidth={2.5} />
        </button>
      </div>
    </div>
  );
}
