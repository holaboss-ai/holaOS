import { atom, useAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { useOrganizations } from "@/lib/auth/useOrganizations";
import { listDisplayOutputs } from "@/lib/outputs";
import { remoteApi } from "@/lib/remoteApiClient";

// Default poll interval. Most live workspace data is fine at 5s; hooks
// that wrap slow-changing surfaces (skills, cronjobs) bump their own
// interval to cut idle IPC chatter — see per-hook constants.
const POLL_INTERVAL_MS = 5_000;
const POLL_INTERVAL_SLOW_MS = 30_000;
const POLL_INTERVAL_MEDIUM_MS = 15_000;

// OS-clutter files that should never surface in user-facing lists. Filter
// defensively at the consumer boundary because they can sneak in through
// runtime sync paths that pre-date the renderer-side dotfile guards in
// listDirectory / workspaceFiles.
const OS_CLUTTER_NAMES: ReadonlySet<string> = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);

function isOsClutterPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const lastSegment = path.split(/[\\/]/).pop() ?? "";
  return OS_CLUTTER_NAMES.has(lastSegment);
}

// Stale output rows from before createOutput enforced workspace-relative
// paths sometimes carry the absolute host path. Splitting those by `/` in
// the tree builder produces phantom ancestor folders (`users/alice/...`).
// They can't be deleted via fs.deletePath either — the file is gone or the
// real one lives at the relative path on a parallel row. Drop them at the
// hook so no UI surface has to know about them.
function isAbsoluteOutputPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const trimmed = path.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return true;
  if (trimmed.startsWith("\\\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  return false;
}

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
    // Skills change rarely (user edits SKILL.md). 30s is generous enough
    // to absorb workspace.yaml writes without burning IPC every 5s for
    // the sidebar count badge.
    const timer = window.setInterval(load, POLL_INTERVAL_SLOW_MS);
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
    // Output folders are user-created and change slowly.
    const timer = window.setInterval(load, POLL_INTERVAL_MEDIUM_MS);
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
 *
 * Caller can override `limit` to express intent — Library wants the full
 * 200 (server-enforced max), sidebar peeks can stay slim.
 *
 * NOTE: workspaces with >200 outputs are still truncated. Real pagination
 * (cursor-based load-more inside ArtifactsPane) is a follow-up.
 */
export function useWorkspaceArtifacts(
  workspaceId: string | null,
  options: { limit?: number } = {},
) {
  const limit = options.limit ?? 200;
  const [outputs, setOutputs] = useState<WorkspaceOutputRecordPayload[]>([]);

  useEffect(() => {
    if (!workspaceId) {
      setOutputs([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await listDisplayOutputs({
          limit,
        });
        if (cancelled) return;
        // OS clutter (.DS_Store / Thumbs.db / etc.) can sneak into the
        // outputs table when the runtime mirrors a workspace folder; strip
        // here so it never reaches the UI. Same for stale absolute-path
        // rows that pre-date workspace-relative createOutput enforcement.
        const cleaned = (response.items ?? []).filter(
          (item) =>
            !isOsClutterPath(item.file_path) &&
            !isAbsoluteOutputPath(item.file_path),
        );
        setOutputs(cleaned);
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
  }, [workspaceId, limit]);

  return outputs;
}

function cronjobsEqual(
  a: CronjobRecordPayload,
  b: CronjobRecordPayload,
): boolean {
  return (
    a.id === b.id &&
    a.updated_at === b.updated_at &&
    a.next_run_at === b.next_run_at &&
    a.last_run_at === b.last_run_at &&
    a.enabled === b.enabled &&
    a.last_status === b.last_status
  );
}

function reconcileCronjobs(
  prev: CronjobRecordPayload[],
  next: CronjobRecordPayload[],
): CronjobRecordPayload[] {
  if (prev.length === 0) return next.length === 0 ? prev : next;
  const prevById = new Map(prev.map((j) => [j.id, j]));
  let changed = next.length !== prev.length;
  const merged = next.map((job, index) => {
    const existing = prevById.get(job.id);
    if (existing && cronjobsEqual(existing, job)) {
      if (existing !== prev[index]) changed = true;
      return existing;
    }
    changed = true;
    return job;
  });
  return changed ? merged : prev;
}

// Shared cache for scheduled automations. Cronjobs are global (the list API
// isn't workspace-scoped), so a single atom is enough. Sharing it lets the
// AutomationsPane render with data on its first frame — kept warm by the
// always-mounted shell — instead of flashing a loading skeleton on open.
// `null` means "never loaded" (show the skeleton once); an empty array means
// "loaded, nothing scheduled" (show the empty state, not the skeleton).
export const sharedCronjobsAtom = atom<CronjobRecordPayload[] | null>(null);

/** Workspace scheduled automations exposed through the cronjob compatibility view. */
export function useWorkspaceCronjobs(workspaceId: string | null) {
  const [jobs, setJobs] = useAtom(sharedCronjobsAtom);

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await remoteApi.cronjobs.list({});
        if (!cancelled) {
          const next = response.jobs ?? [];
          setJobs((prev) => (prev === null ? next : reconcileCronjobs(prev, next)));
        }
      } catch {
        // tolerate
      }
    };
    void load();
    // Cronjobs are added / edited at human pace; 15s keeps the
    // automations list responsive without flooding IPC.
    const timer = window.setInterval(load, POLL_INTERVAL_MEDIUM_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId, setJobs]);

  return jobs ?? [];
}


function mainSessionsEqual(
  a: MainSessionRecordPayload,
  b: MainSessionRecordPayload,
): boolean {
  return (
    a.session_id === b.session_id &&
    a.title === b.title &&
    a.updated_at === b.updated_at &&
    a.project_id === b.project_id &&
    a.archived_at === b.archived_at &&
    a.workspace_id === b.workspace_id
  );
}

// Reuse prior row objects (and the array itself) when a poll returns
// identical content, so memoised sidebar rows don't all re-render every
// interval.
function reconcileMainSessions(
  prev: MainSessionRecordPayload[],
  next: MainSessionRecordPayload[],
): MainSessionRecordPayload[] {
  if (prev.length === 0) return next;
  const prevById = new Map(prev.map((s) => [s.session_id, s]));
  let changed = next.length !== prev.length;
  const merged = next.map((session, index) => {
    const existing = prevById.get(session.session_id);
    if (existing && mainSessionsEqual(existing, session)) {
      if (existing !== prev[index]) changed = true;
      return existing;
    }
    changed = true;
    return session;
  });
  return changed ? merged : prev;
}

// `appId` scopes the list to one HolaApp's own sessions (the app session
// dropdown). Omitted, the hook returns the workspace sidebar list, which the
// runtime already strips of app-owned sessions.
export function useWorkspaceMainSessions(
  workspaceId: string | null,
  appId?: string | null,
) {
  const [sessions, setSessions] = useState<MainSessionRecordPayload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // The sidebar list is org-scoped server-side (the runtime filters by the
  // active org). Re-fetch immediately when the active org changes rather than
  // waiting for the next 5s poll, so a switch swaps the list right away.
  const activeOrgId = useOrganizations().activeOrg?.id ?? null;

  useEffect(() => {
    if (!workspaceId) {
      setSessions([]);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const response = await window.electronAPI.workspace.listMainSessions(
          workspaceId,
          appId ?? null,
        );
        if (!cancelled) {
          setSessions((prev) =>
            reconcileMainSessions(prev, response.sessions ?? []),
          );
        }
      } catch {
        // tolerate transient fetch failures
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId, appId, activeOrgId]);

  return { sessions, isLoading, setSessions };
}

function projectsEqual(
  a: WorkspaceProjectRecordPayload,
  b: WorkspaceProjectRecordPayload,
): boolean {
  return (
    a.project_id === b.project_id &&
    a.name === b.name &&
    a.updated_at === b.updated_at &&
    a.project_path === b.project_path &&
    a.icon === b.icon &&
    a.icon_color === b.icon_color
  );
}

// Reuse prior row objects (and the array itself) when a poll returns
// identical content, so shared subscribers don't all re-render on every
// poll tick.
function reconcileProjects(
  prev: WorkspaceProjectRecordPayload[],
  next: WorkspaceProjectRecordPayload[],
): WorkspaceProjectRecordPayload[] {
  if (prev.length === 0) return next.length === 0 ? prev : next;
  const prevById = new Map(prev.map((p) => [p.project_id, p]));
  let changed = next.length !== prev.length;
  const merged = next.map((project, index) => {
    const existing = prevById.get(project.project_id);
    if (existing && projectsEqual(existing, project)) {
      if (existing !== prev[index]) changed = true;
      return existing;
    }
    changed = true;
    return project;
  });
  return changed ? merged : prev;
}

// Shared, workspace-keyed cache so the Projects index, a project's landing
// page, the sidebar, and the ChatPane all read the same already-loaded list.
// Without this, each consumer kept its own useState([]) and refetched on
// mount — so opening a project flashed the empty/greeting state for a frame
// before the async fetch resolved. Backing the hook with a shared atom means
// a consumer that mounts after another has fetched renders with data on the
// first frame.
const EMPTY_PROJECTS: WorkspaceProjectRecordPayload[] = [];
const workspaceProjectsAtom = atom<
  Record<string, WorkspaceProjectRecordPayload[]>
>({});

export function useWorkspaceProjects(workspaceId: string | null) {
  const [byWorkspace, setByWorkspace] = useAtom(workspaceProjectsAtom);
  const [isLoading, setIsLoading] = useState(false);

  const projects = workspaceId
    ? (byWorkspace[workspaceId] ?? EMPTY_PROJECTS)
    : EMPTY_PROJECTS;
  // Distinguish "not fetched yet" (show skeleton once) from "loaded, empty"
  // (show the empty state, never the skeleton again) so revisits don't flash.
  const hasLoaded = workspaceId ? byWorkspace[workspaceId] !== undefined : false;

  useEffect(() => {
    if (!workspaceId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setIsLoading(true);
      try {
        const response =
          await window.electronAPI.workspace.listProjects(workspaceId);
        if (!cancelled) {
          const items = response.items ?? [];
          setByWorkspace((prev) => {
            const reconciled = reconcileProjects(prev[workspaceId] ?? [], items);
            if (reconciled === prev[workspaceId]) return prev;
            return { ...prev, [workspaceId]: reconciled };
          });
        }
      } catch {
        // tolerate transient fetch failures
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId, setByWorkspace]);

  const setProjects = useCallback(
    (
      updater:
        | WorkspaceProjectRecordPayload[]
        | ((
            current: WorkspaceProjectRecordPayload[],
          ) => WorkspaceProjectRecordPayload[]),
    ) => {
      if (!workspaceId) return;
      setByWorkspace((prev) => {
        const current = prev[workspaceId] ?? [];
        const next =
          typeof updater === "function" ? updater(current) : updater;
        return { ...prev, [workspaceId]: next };
      });
    },
    [workspaceId, setByWorkspace],
  );

  return { projects, isLoading, hasLoaded, setProjects };
}

