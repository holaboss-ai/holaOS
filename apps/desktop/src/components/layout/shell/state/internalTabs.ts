import { atom } from "jotai";

export type WorkspaceSurfaceTabKind = "automations" | "skills";

export type WorkspaceSurfaceInternalTab = {
  id: string;
  kind: WorkspaceSurfaceTabKind;
  workspaceId: string;
  label: string;
};

export type InternalTab =
  | {
      id: string;
      kind: "file";
      filePath: string;
      label: string;
    }
  | {
      id: string;
      kind: "image";
      dataUrl: string;
      label: string;
      revokeOnClose?: boolean;
    }
  | WorkspaceSurfaceInternalTab
  | {
      id: string;
      kind: "issue_detail";
      workspaceId: string;
      issueId: string;
      label: string;
    }
  | {
      // An empty in-app tab (the "New tab" landing). Not a browser tab — the
      // in-app browser was retired; browsing happens in profile windows.
      id: string;
      kind: "blank";
      label: string;
    };

// Open tabs are scoped to the active session (each chat keeps its own set).
// The session-aware read/write facade lives in ./ui alongside
// `selectedSessionIdAtom`; re-exported here so consumers keep importing from
// the tabs module. Defining them in ./ui avoids an import cycle (ui only
// needs InternalTab as a type).
export { internalTabsAtom, activeInternalTabIdAtom } from "./ui";

// One-shot signal: when an issue detail tab is opened via "Reply" on a
// blocked board card, its tab id lands here. The IssueDetailPane reads it
// on mount, removes itself from the set, and auto-focuses the composer.
// Re-clicking the same tab later does NOT re-trigger focus.
export const pendingIssueComposerFocusAtom = atom<Set<string>>(
  new Set<string>(),
);

let counter = 0;
export function makeInternalTabId(): string {
  counter += 1;
  return `int-${Date.now()}-${counter}`;
}

/** A fresh empty in-app tab (the New-tab landing). */
export function blankTab(): Extract<InternalTab, { kind: "blank" }> {
  return { id: makeInternalTabId(), kind: "blank", label: "New Tab" };
}

export function fileNameFromPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

export function makeWorkspaceSurfaceTabId(
  kind: WorkspaceSurfaceTabKind,
  workspaceId: string,
): string {
  return `surface:${kind}:${workspaceId.trim()}`;
}

export function workspaceSurfaceTab(
  kind: WorkspaceSurfaceTabKind,
  workspaceId: string,
): WorkspaceSurfaceInternalTab {
  return {
    id: makeWorkspaceSurfaceTabId(kind, workspaceId),
    kind,
    workspaceId: workspaceId.trim(),
    label: workspaceSurfaceLabel(kind),
  };
}

function workspaceSurfaceLabel(kind: WorkspaceSurfaceTabKind): string {
  switch (kind) {
    case "skills":
      return "Skills";
    case "automations":
    default:
      return "Automations";
  }
}

export function makeIssueDetailTabId(
  workspaceId: string,
  issueId: string,
): string {
  return `issue:${workspaceId.trim()}:${issueId.trim()}`;
}

export function issueDetailTab(params: {
  workspaceId: string;
  issueId: string;
  label?: string | null;
}): Extract<InternalTab, { kind: "issue_detail" }> {
  const normalizedIssueId = params.issueId.trim();
  return {
    id: makeIssueDetailTabId(params.workspaceId, normalizedIssueId),
    kind: "issue_detail",
    workspaceId: params.workspaceId.trim(),
    issueId: normalizedIssueId,
    label: params.label?.trim() || normalizedIssueId,
  };
}

export function upsertInternalTab(
  tabs: InternalTab[],
  tab: InternalTab,
): InternalTab[] {
  return tabs.some((entry) => entry.id === tab.id) ? tabs : [...tabs, tab];
}
