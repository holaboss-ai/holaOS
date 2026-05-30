import { atom } from "jotai";

export type WorkspaceSurfaceTabKind =
  | "issues_board"
  | "workspace_dashboard"
  | "teammates";

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
  | {
      id: string;
      kind: WorkspaceSurfaceTabKind;
      workspaceId: string;
      label: string;
    }
  | {
      id: string;
      kind: "issue_detail";
      workspaceId: string;
      issueId: string;
      label: string;
    };

export const internalTabsAtom = atom<InternalTab[]>([]);
export const activeInternalTabIdAtom = atom<string | null>(null);

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
): Extract<InternalTab, { kind: WorkspaceSurfaceTabKind }> {
  return {
    id: makeWorkspaceSurfaceTabId(kind, workspaceId),
    kind,
    workspaceId: workspaceId.trim(),
    label:
      kind === "issues_board"
        ? "Board"
        : kind === "workspace_dashboard"
          ? "Dashboard"
          : "Teammates",
  };
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
