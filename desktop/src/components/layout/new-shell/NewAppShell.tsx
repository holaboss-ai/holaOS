import { useSetAtom } from "jotai";
import { useEffect } from "react";
import { Center } from "./Center";
import { ChatPanel } from "./ChatPanel";
import { NewTabDialog } from "./NewTabDialog";
import { Sidebar } from "./Sidebar";
import { newTabOpenAtom } from "./state/ui";
import { TopChrome } from "./TopChrome";

export function NewAppShell() {
  const setNewTabOpen = useSetAtom(newTabOpenAtom);

  // Cmd/Ctrl + T → new tab palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "t") {
        e.preventDefault();
        setNewTabOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setNewTabOpen]);

  return (
    <div className="flex h-screen w-screen overflow-hidden text-foreground antialiased">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <TopChrome />
        <div className="flex min-h-0 flex-1">
          <Center />
          <ChatPanel />
        </div>
      </div>
      <NewTabDialog />
    </div>
  );
}
