import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  type RuntimeStateStore,
  utcNowIso,
  type WorkspaceRecord,
} from "@holaboss/runtime-state-store";

// Workspace-removal (single-tenant synthetic root): the store no longer exposes
// createWorkspace/updateWorkspace/deleteWorkspace/relocateWorkspace, and
// ensureRuntimeDbSchema/ensureControlPlaneDbSchema stopped emitting the
// `workspaces` CREATE TABLE. Kept-method tests still need a registered workspace
// as setup, so this helper replicates the persistent effects the removed
// `createWorkspace` had: it (1) creates the registry table (control-plane db +
// mirrored host-state db), (2) inserts the registry row, and (3) lays down the
// on-disk workspace folder + its hidden identity file (so workspaceDir's rename
// recovery can rediscover the folder). The column set is the exact pre-refactor
// production DDL so the INSERT never throws "no column named onboarding_state".
const WORKSPACES_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      harness TEXT,
      error_message TEXT,
      onboarding_status TEXT NOT NULL,
      onboarding_state TEXT,
      onboarding_session_id TEXT,
      onboarding_alignment_question TEXT,
      onboarding_alignment_report TEXT,
      onboarding_verification_report TEXT,
      onboarding_completed_at TEXT,
      onboarding_completion_summary TEXT,
      onboarding_requested_at TEXT,
      onboarding_requested_by TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at_utc TEXT,
      icon TEXT,
      icon_color TEXT,
      workspace_role TEXT NOT NULL DEFAULT 'source',
      source_workspace_id TEXT,
      lab_purpose TEXT,
      lab_status TEXT
  );`;

export interface SeedWorkspaceParams {
  workspaceId?: string;
  name?: string;
  harness?: string;
  status?: string;
  onboardingStatus?: string;
  onboardingState?: string | null;
  onboardingSessionId?: string | null;
  errorMessage?: string | null;
  workspacePath?: string;
  workspaceRole?: string;
  sourceWorkspaceId?: string | null;
}

export function seedWorkspaceRecord(
  store: RuntimeStateStore,
  params: SeedWorkspaceParams = {},
): WorkspaceRecord {
  const workspaceId = params.workspaceId ?? `ws-${Math.random().toString(36).slice(2)}`;
  const now = utcNowIso();
  const workspacePath = params.workspacePath ?? path.join(store.workspaceRoot, workspaceId);
  const stateDir = path.join(workspacePath, ".holaboss", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "workspace_id"), `${workspaceId}\n`, "utf-8");
  for (const file of new Set([store.controlPlaneDbPath, store.dbPath])) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    try {
      db.exec(WORKSPACES_TABLE_DDL);
      db.prepare(
        `INSERT OR IGNORE INTO workspaces (
            id, workspace_path, name, status, harness, error_message, onboarding_status,
            onboarding_state, onboarding_session_id, created_at, updated_at, workspace_role, source_workspace_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        workspaceId,
        workspacePath,
        params.name ?? "Workspace",
        params.status ?? "active",
        params.harness ?? "pi",
        params.errorMessage ?? null,
        params.onboardingStatus ?? "not_required",
        params.onboardingState ?? null,
        params.onboardingSessionId ?? null,
        now,
        now,
        params.workspaceRole ?? "source",
        params.sourceWorkspaceId ?? null,
      );
    } finally {
      db.close();
    }
  }
  return {
    id: workspaceId,
    name: params.name ?? "Workspace",
    status: params.status ?? "active",
    harness: params.harness ?? "pi",
    errorMessage: params.errorMessage ?? null,
    onboardingStatus: params.onboardingStatus ?? "not_required",
    onboardingState: params.onboardingState ?? null,
    onboardingSessionId: params.onboardingSessionId ?? null,
    onboardingAlignmentQuestion: null,
    onboardingAlignmentReport: null,
    onboardingVerificationReport: null,
    onboardingCompletedAt: null,
    onboardingCompletionSummary: null,
    onboardingRequestedAt: null,
    onboardingRequestedBy: null,
    createdAt: now,
    updatedAt: now,
    deletedAtUtc: null,
    icon: null,
    iconColor: null,
    workspaceRole: params.workspaceRole ?? "source",
    sourceWorkspaceId: params.sourceWorkspaceId ?? null,
    labPurpose: null,
    labStatus: null,
  };
}

export function softDeleteWorkspaceRecord(store: RuntimeStateStore, workspaceId: string): void {
  const now = utcNowIso();
  for (const file of new Set([store.controlPlaneDbPath, store.dbPath])) {
    const db = new Database(file);
    try {
      db.prepare(`UPDATE workspaces SET status='deleted', deleted_at_utc=? WHERE id=?`).run(
        now,
        workspaceId,
      );
    } finally {
      db.close();
    }
  }
}
