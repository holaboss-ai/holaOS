import { useSetAtom } from "jotai";
import { ChatPane } from "@/components/panes/ChatPane";
import {
  artifactsOpenAtom,
  automationsOpenAtom,
  sessionsOpenAtom,
} from "./state/ui";

export function ChatPanel() {
  const setArtifactsOpen = useSetAtom(artifactsOpenAtom);
  const setAutomationsOpen = useSetAtom(automationsOpenAtom);
  const setSessionsOpen = useSetAtom(sessionsOpenAtom);

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-border bg-background">
      <ChatPane
        variant="embedded"
        onOpenArtifacts={() => setArtifactsOpen(true)}
        onOpenAutomations={() => setAutomationsOpen(true)}
        onOpenSessions={() => setSessionsOpen(true)}
      />
    </aside>
  );
}
