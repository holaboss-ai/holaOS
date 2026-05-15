import { ChatPane } from "@/components/panes/ChatPane";

export function ChatPanel() {
  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-border bg-background">
      <ChatPane variant="embedded" />
    </aside>
  );
}
