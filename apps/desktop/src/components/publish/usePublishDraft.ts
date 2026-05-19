import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_PREFIX = "publish:draft:";
// Bumping this throws away in-flight drafts, so prefer to keep it stable
// and tolerate missing fields below — readers should default new fields
// to safe empty values.
const SCHEMA_VERSION = 1;

export interface PublishDraft {
  schemaVersion: number;
  savedAt: number;
  name: string;
  description: string;
  category: string;
  tags: string;
  selectedApps: string[];
  onboardingMd: string;
  readmeMd: string;
  coverImageDataUrl: string | null;
  screenshotsDataUrls: string[];
  /** Workspace-relative paths the user opted out of bundling (added in v2). */
  forceExcludePaths: string[];
}

export const EMPTY_DRAFT: Omit<PublishDraft, "schemaVersion" | "savedAt"> = {
  name: "",
  description: "",
  category: "marketing",
  tags: "",
  selectedApps: [],
  onboardingMd: "",
  readmeMd: "",
  coverImageDataUrl: null,
  screenshotsDataUrls: [],
  forceExcludePaths: [],
};

function storageKey(workspaceId: string): string {
  return STORAGE_PREFIX + workspaceId;
}

export function loadDraft(workspaceId: string): PublishDraft | null {
  try {
    const raw = localStorage.getItem(storageKey(workspaceId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PublishDraft;
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      return null;
    }
    // Tolerate older drafts written before forceExcludePaths existed.
    if (!Array.isArray(parsed.forceExcludePaths)) {
      parsed.forceExcludePaths = [];
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraft(workspaceId: string): void {
  try {
    localStorage.removeItem(storageKey(workspaceId));
  } catch {
    // ignore
  }
}

/**
 * Debounced autosave of publish-form state to localStorage. Returns the
 * timestamp of the last successful save so the UI can show "Saved 3s ago".
 */
export function usePublishDraftAutosave(
  workspaceId: string | null,
  draft: Omit<PublishDraft, "schemaVersion" | "savedAt">,
  enabled: boolean,
  debounceMs = 600,
): number | null {
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!(workspaceId && enabled)) {
      return;
    }
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => {
      try {
        const payload: PublishDraft = {
          schemaVersion: SCHEMA_VERSION,
          savedAt: Date.now(),
          ...draft,
        };
        localStorage.setItem(storageKey(workspaceId), JSON.stringify(payload));
        setSavedAt(payload.savedAt);
      } catch {
        // localStorage may be full or disabled — silently skip
      }
    }, debounceMs);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, [workspaceId, enabled, debounceMs, draft]);

  return savedAt;
}

export function useDraftRestore(workspaceId: string | null): {
  hasDraft: boolean;
  draftAge: number | null;
  restore: () => PublishDraft | null;
  discard: () => void;
} {
  const [hasDraft, setHasDraft] = useState(false);
  const [draftAge, setDraftAge] = useState<number | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setHasDraft(false);
      setDraftAge(null);
      return;
    }
    const existing = loadDraft(workspaceId);
    if (existing) {
      setHasDraft(true);
      setDraftAge(Date.now() - existing.savedAt);
    } else {
      setHasDraft(false);
      setDraftAge(null);
    }
  }, [workspaceId]);

  const restore = useCallback(() => {
    if (!workspaceId) {
      return null;
    }
    return loadDraft(workspaceId);
  }, [workspaceId]);

  const discard = useCallback(() => {
    if (!workspaceId) {
      return;
    }
    clearDraft(workspaceId);
    setHasDraft(false);
    setDraftAge(null);
  }, [workspaceId]);

  return { hasDraft, draftAge, restore, discard };
}
