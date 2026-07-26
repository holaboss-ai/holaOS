import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  selectedSessionByWorkspaceAtom,
  selectedSessionIdAtom,
  selectedWorkspaceIdAtom,
} from "@/components/layout/shell/state/ui";

interface WorkspaceSelectionContextValue {
  selectedWorkspaceId: string;
  setSelectedWorkspaceId: Dispatch<SetStateAction<string>>;
  selectedSessionId: string;
  setSelectedSessionForWorkspace: (workspaceId: string, sessionId: string) => void;
  clearSelectedSessionForWorkspace: (workspaceId: string) => void;
}

const WorkspaceSelectionContext =
  createContext<WorkspaceSelectionContextValue | null>(null);

// Selection state lives in Jotai (selectedWorkspaceIdAtom /
// selectedSessionByWorkspaceAtom / the derived selectedSessionIdAtom) so the
// sidebar, chat, and browser panes read ONE source and never diverge. This
// provider is a thin compatibility layer over those atoms — it keeps the
// existing `useWorkspaceSelection()` API and the same localStorage keys
// (persistence is handled by atomWithStorage now).
export function WorkspaceSelectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useAtom(
    selectedWorkspaceIdAtom,
  );
  const setSelectedSessionByWorkspace = useSetAtom(
    selectedSessionByWorkspaceAtom,
  );
  const selectedSessionId = useAtomValue(selectedSessionIdAtom) ?? "";

  const setSelectedSessionForWorkspace = useCallback(
    (workspaceId: string, sessionId: string) => {
      const trimmedWorkspace = workspaceId.trim();
      const trimmedSession = sessionId.trim();
      if (!trimmedWorkspace) return;
      setSelectedSessionByWorkspace((prev) => {
        if (!trimmedSession) {
          if (!(trimmedWorkspace in prev)) return prev;
          const next = { ...prev };
          delete next[trimmedWorkspace];
          return next;
        }
        if (prev[trimmedWorkspace] === trimmedSession) return prev;
        return { ...prev, [trimmedWorkspace]: trimmedSession };
      });
    },
    [setSelectedSessionByWorkspace],
  );

  const clearSelectedSessionForWorkspace = useCallback(
    (workspaceId: string) => {
      const trimmed = workspaceId.trim();
      if (!trimmed) return;
      setSelectedSessionByWorkspace((prev) => {
        if (!(trimmed in prev)) return prev;
        const next = { ...prev };
        delete next[trimmed];
        return next;
      });
    },
    [setSelectedSessionByWorkspace],
  );

  const value = useMemo(
    () => ({
      selectedWorkspaceId,
      setSelectedWorkspaceId,
      selectedSessionId,
      setSelectedSessionForWorkspace,
      clearSelectedSessionForWorkspace,
    }),
    [
      selectedWorkspaceId,
      setSelectedWorkspaceId,
      selectedSessionId,
      setSelectedSessionForWorkspace,
      clearSelectedSessionForWorkspace,
    ],
  );

  return (
    <WorkspaceSelectionContext.Provider value={value}>
      {children}
    </WorkspaceSelectionContext.Provider>
  );
}

export function useWorkspaceSelection() {
  const context = useContext(WorkspaceSelectionContext);
  if (!context) {
    throw new Error(
      "useWorkspaceSelection must be used within WorkspaceSelectionProvider.",
    );
  }
  return context;
}
