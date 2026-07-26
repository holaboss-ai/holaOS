import {
  chatSessionOpenRequestAtom,
  selectedSessionIdAtom,
} from "@/components/layout/shell/state/ui";
import { useWorkspaceMainSessions } from "@/components/layout/shell/useWorkspaceLists";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Plus } from "@/components/ui/icons";
import { useAtomValue, useSetAtom } from "jotai";

/**
 * Session switcher for a HolaApp. A HolaApp owns its own sessions (tagged with
 * `owning_app_id`), so instead of the workspace sidebar this compact dropdown —
 * mounted in the ChatPane header while an app surface is active — is the only
 * way to move between the app's sessions or start a new one. Selecting a session
 * routes ChatPane to it; "New chat" opens a fresh draft that ChatPane persists
 * tagged with this app's id on the first message.
 */
export function AppSessionDropdown({
  workspaceId,
  appId,
  appTitle,
}: {
  workspaceId: string | null;
  appId: string;
  appTitle: string;
}) {
  const { sessions } = useWorkspaceMainSessions(workspaceId, appId);
  const selectedSessionId = useAtomValue(selectedSessionIdAtom);
  const setSelectedSessionId = useSetAtom(selectedSessionIdAtom);
  const setSessionOpenRequest = useSetAtom(chatSessionOpenRequestAtom);

  const current = sessions.find(
    (session) => session.session_id === selectedSessionId,
  );
  const currentLabel = current?.title?.trim() || "New chat";

  const openSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setSessionOpenRequest({
      sessionId,
      requestKey: Date.now(),
      mode: "session",
      parentSessionId: null,
      clearComposer: true,
    });
  };

  const openNewDraft = () => {
    setSelectedSessionId(null);
    setSessionOpenRequest({
      sessionId: "",
      requestKey: Date.now(),
      mode: "draft",
      parentSessionId: null,
      clearComposer: true,
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-muted-foreground text-xs transition-colors hover:bg-foreground/6 hover:text-foreground"
            title={`${appTitle} sessions`}
            type="button"
          />
        }
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onClick={openNewDraft}>
          <Plus className="size-3.5" />
          <span className="truncate">New {appTitle} chat</span>
        </DropdownMenuItem>
        {sessions.length > 0 ? <DropdownMenuSeparator /> : null}
        {sessions.map((session) => (
          <DropdownMenuItem
            className={
              session.session_id === selectedSessionId
                ? "bg-foreground/6 text-foreground"
                : undefined
            }
            key={session.session_id}
            onClick={() => openSession(session.session_id)}
          >
            <span className="truncate">
              {session.title?.trim() || "Untitled chat"}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
