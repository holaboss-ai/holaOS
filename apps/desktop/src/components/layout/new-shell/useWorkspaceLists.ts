import { useEffect, useState } from "react";

const POLL_INTERVAL_MS = 5_000;

/** Workspace skills (workspace.yaml driven). */
export function useWorkspaceSkills(workspaceId: string | null) {
  const [skills, setSkills] = useState<WorkspaceSkillRecordPayload[]>([]);

  useEffect(() => {
    if (!workspaceId) {
      setSkills([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response =
          await window.electronAPI.workspace.listSkills(workspaceId);
        if (!cancelled) setSkills(response.skills);
      } catch {
        // tolerate transient errors — sidebar count just stays at last known
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId]);

  return skills;
}

/**
 * Workspace output folders. Used by the sidebar to label artifact groups
 * (output records carry only a `folder_id`; this hook supplies the names).
 */
export function useWorkspaceOutputFolders(workspaceId: string | null) {
  const [folders, setFolders] = useState<WorkspaceOutputFolderRecordPayload[]>(
    [],
  );

  useEffect(() => {
    if (!workspaceId) {
      setFolders([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response =
          await window.electronAPI.workspace.listOutputFolders(workspaceId);
        if (!cancelled) setFolders(response.items ?? []);
      } catch {
        // tolerate transient errors
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId]);

  return folders;
}

/**
 * Workspace artifacts (agent-run outputs). Mirrors the workspace-scoped
 * fetch behind ArtifactsPane so the sidebar can show recent items inline
 * without forcing the user to open the full overlay.
 */
export function useWorkspaceArtifacts(workspaceId: string | null) {
  const [outputs, setOutputs] = useState<WorkspaceOutputRecordPayload[]>([]);

  useEffect(() => {
    if (!workspaceId) {
      setOutputs([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await window.electronAPI.workspace.listOutputs({
          workspaceId,
          limit: 50,
        });
        if (!cancelled) setOutputs(response.items ?? []);
      } catch {
        // tolerate transient errors — sidebar stays at last known list
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId]);

  return outputs;
}

/** Workspace cronjobs (active automations). */
export function useWorkspaceCronjobs(workspaceId: string | null) {
  const [jobs, setJobs] = useState<CronjobRecordPayload[]>([]);

  useEffect(() => {
    if (!workspaceId) {
      setJobs([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response =
          await window.electronAPI.workspace.listCronjobs(workspaceId);
        if (!cancelled) setJobs(response.jobs);
      } catch {
        // tolerate
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId]);

  return jobs;
}

/**
 * Browser history capped to N most-recent entries, subscribed to live
 * updates. Used by the sidebar Recents section.
 */
export function useRecentBrowserHistory(limit = 7) {
  const [entries, setEntries] = useState<BrowserHistoryEntryPayload[]>([]);

  useEffect(() => {
    let cancelled = false;
    const apply = (next: BrowserHistoryEntryPayload[]) => {
      if (cancelled) return;
      setEntries(next.slice(0, limit));
    };
    void window.electronAPI.browser.getHistory().then(apply);
    const unsubscribe = window.electronAPI.browser.onHistoryChange(apply);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [limit]);

  return entries;
}
