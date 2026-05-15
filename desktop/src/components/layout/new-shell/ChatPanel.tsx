import {
  ArrowUp,
  ChevronDown,
  ChevronsLeftRight,
  Paperclip,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ChatPanel() {
  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-border">
      <ChatHeader />
      <div className="flex flex-1 flex-col justify-end overflow-hidden">
        <div className="flex flex-1 items-center justify-center text-xs text-foreground/40">
          No messages yet
        </div>
      </div>
      <Composer />
    </aside>
  );
}

function ChatHeader() {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 flex-1 justify-start gap-1.5 px-2 text-sm font-medium"
      >
        <ChevronsLeftRight className="size-3.5 text-foreground/60" />
        <span className="truncate">Cold email Q4</span>
        <ChevronDown className="size-3 text-foreground/40" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="New thread"
        className="text-foreground/60"
      >
        <Plus className="size-3.5" />
      </Button>
    </div>
  );
}

function Composer() {
  return (
    <div className="p-2">
      <div className="rounded-lg border border-border bg-muted/40 px-3 pt-2 pb-1.5">
        <Input
          placeholder="Ask anything..."
          className="h-7 w-full border-0 bg-transparent px-0 text-sm focus-visible:ring-0"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              className="px-1.5 text-xs font-normal text-foreground/60"
            >
              GPT-5.5
              <ChevronDown className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Attach"
              className="text-foreground/60"
            >
              <Paperclip className="size-3.5" />
            </Button>
          </div>
          <Button size="icon-xs" aria-label="Send">
            <ArrowUp className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
