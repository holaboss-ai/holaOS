import { useSetAtom } from "jotai";
import { ChatPane } from "@/components/panes/ChatPane";
import { sessionsOpenAtom } from "./state/ui";

export function ChatPanel() {
  const setSessionsOpen = useSetAtom(sessionsOpenAtom);

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-border bg-background">
      <ChatPane
        variant="embedded"
        onOpenSessions={() => setSessionsOpen(true)}
      />
    </aside>
  );
}
