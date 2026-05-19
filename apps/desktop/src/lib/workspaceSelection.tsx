import { createContext, useContext, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

const WORKSPACE_STORAGE_KEY = "holaboss-selected-workspace-v1";

interface WorkspaceSelectionContextValue {
  selectedWorkspaceId: string;
  setSelectedWorkspaceId: Dispatch<SetStateAction<string>>;
}

const WorkspaceSelectionContext = createContext<WorkspaceSelectionContextValue | null>(null);

function loadStoredWorkspaceId() {
  try {
    return localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function WorkspaceSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(loadStoredWorkspaceId);

  useEffect(() => {
    try {
      if (selectedWorkspaceId) {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, selectedWorkspaceId);
      } else {
        localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      }
    } catch {
      // ignore
    }
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }
    void window.electronAPI.browser.setActiveWorkspace(selectedWorkspaceId || null);
  }, [selectedWorkspaceId]);

  const value = useMemo(
    () => ({
      selectedWorkspaceId,
      setSelectedWorkspaceId
    }),
    [selectedWorkspaceId]
  );

  return <WorkspaceSelectionContext.Provider value={value}>{children}</WorkspaceSelectionContext.Provider>;
}

export function useWorkspaceSelection() {
  const context = useContext(WorkspaceSelectionContext);
  if (!context) {
    throw new Error("useWorkspaceSelection must be used within WorkspaceSelectionProvider.");
  }
  return context;
}
