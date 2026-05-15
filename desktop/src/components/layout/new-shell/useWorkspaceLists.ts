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
