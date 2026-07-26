# Publish Worker — Unified Web + Desktop Design

## Problem

The current publish flow has two structural issues:

1. **Silent data loss** — The web frontend collects `apps`, `onboarding_md`, and `template_id` in a 4-step wizard, but the backend `PublishTemplatePayload` model doesn't declare these fields. Pydantic silently drops them. Steps 2 (Apps) and 3 (Onboarding) are entirely non-functional — data is collected from users and thrown away.

2. **No desktop support** — Publishing only works from the web frontend, which reaches the Python backend through the Hono gateway. The desktop app communicates exclusively via Electron IPC and cannot use this path. Furthermore, the desktop already has workspace files on local disk, making the backend's "export from sandbox → package → upload" round-trip unnecessary.

## Design

Split the single `/publish` endpoint into a three-step API. Steps 1 and 3 are identical across platforms. Step 2 (packaging) adapts to each platform's file access model.

```
    Web + Desktop (identical)           Web only              Desktop only
    ─────────────────────────    ─────────────────────    ─────────────────────
    Step 1: Create Submission    Step 2a: Package         Step 2b: Package
    POST /submissions            from Sandbox             Locally
    { name, desc, apps, ... }    POST /submissions/       Electron main reads
    → { submission_id,             {id}/package             workspace dir,
        upload_url }             Backend exports from      filters by apps[],
                                 sandbox, filters by       builds manifest.json,
    Step 3: Finalize             apps[], packages zip,     zips, PUTs to
    POST /submissions/           uploads to upload_url     upload_url
      {id}/finalize
    → { status:
        "pending_review" }
```

## API Contracts

All endpoints live in the **marketplace service** (port 3037). The `package-from-sandbox` step calls the projects service internally to export workspace files.

### Step 1: Create Submission

```
POST /api/v1/marketplace/submissions

Request:
{
  "workspace_id": "ws-abc",
  "holaboss_user_id": "user-123",
  "name": "Social Operator",                    // required, 1-100 chars
  "description": "AI social media automation",   // required, 1-500 chars
  "category": "marketing",                       // default: "general"
  "tags": ["social", "content"],                 // default: []
  "apps": ["twitter", "linkedin"],               // default: [] (empty = all apps)
  "onboarding_md": "# Welcome\n\nGet started..." // optional
}

Response (201):
{
  "submission_id": "sub-uuid",
  "template_id": "social_operator",              // slug from name
  "upload_url": "https://s3.../presigned-put",   // presigned S3 PUT URL, 1 hour expiry
  "upload_expires_at": "2026-04-02T06:00:00Z"
}
```

Backend model:
```python
class CreateSubmissionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workspace_id: str
    holaboss_user_id: str | None = None
    name: str = Field(..., min_length=1, max_length=100)
    description: str = Field(..., min_length=1, max_length=500)
    category: str = "general"
    tags: list[str] = Field(default_factory=list)
    apps: list[str] = Field(default_factory=list)
    onboarding_md: str | None = None
```

Creates a `template_submissions` record with `status = "pending_upload"`. Generates `template_id` from `_slugify(name)`. Generates a presigned S3 PUT URL for the archive.

### Step 2a: Package from Sandbox (Web only)

```
POST /api/v1/marketplace/submissions/{submission_id}/package-from-sandbox

Request:
{
  "holaboss_user_id": "user-123"
}

Response (200):
{
  "submission_id": "sub-uuid",
  "archive_size_bytes": 4521000,
  "status": "pending_finalize"
}
```

Backend:
1. Reads submission record to get `workspace_id`, `apps`, `onboarding_md`
2. Calls projects service to export workspace files (existing `export_workspace_files`)
3. Extracts tar.gz to temp dir
4. Filters by `apps[]` — if non-empty, only include `apps/{selected}/` directories plus root workspace files (`workspace.yaml`, `AGENTS.md`, etc.)
5. Builds `manifest.json` with all metadata including `apps` and `onboarding_md`
6. Reads `.hbignore`, packages zip
7. Uploads to the presigned S3 URL from Step 1
8. Updates submission status to `pending_finalize`

### Step 2b: Package Locally (Desktop only)

No API call. The Electron main process:
1. Reads submission metadata (returned from Step 1)
2. Reads workspace directory from local disk
3. Filters by `apps[]` — same logic as 2a
4. Builds `manifest.json` — same structure as 2a
5. Reads `.hbignore`, packages zip in memory
6. PUTs the zip to `upload_url` (presigned S3 URL)

This is exposed as an IPC handler:
```ts
electronAPI.workspace.packageAndUploadWorkspace(params: {
  workspaceId: string;
  apps: string[];
  onboardingMd: string | null;
  submissionId: string;
  templateId: string;
  name: string;
  description: string;
  authorId: string;
  authorName: string;
  tags: string[];
  category: string;
  uploadUrl: string;
}): Promise<{ archiveSizeBytes: number }>
```

### Step 3: Finalize Submission

```
POST /api/v1/marketplace/submissions/{submission_id}/finalize

Request:
{
  "holaboss_user_id": "user-123"
}

Response (200):
{
  "submission_id": "sub-uuid",
  "status": "pending_review",
  "template_name": "user-123/social_operator"
}
```

Backend:
1. Verifies archive exists in S3 at the expected key
2. Updates submission status from `pending_finalize` → `pending_review`
3. Returns final status

## manifest.json Format

```json
{
  "template_id": "social_operator",
  "name": "Social Operator",
  "version": "1.0.0",
  "description": "AI social media automation",
  "category": "marketing",
  "tags": ["social", "content"],
  "apps": ["twitter", "linkedin"],
  "onboarding_md": "# Welcome\n\nGet started...",
  "author": {
    "id": "user-123",
    "name": "Alice"
  }
}
```

When a template is installed, `apps` tells the system which modules to set up, and `onboarding_md` is written to `ONBOARD.md` in the workspace.

## Apps Filtering Logic

When `apps` is non-empty, the archive includes:
- Root workspace files: `workspace.yaml`, `AGENTS.md`, `ONBOARD.md`, `skills/`
- Only selected app directories: `apps/{app_id}/` for each app in `apps[]`
- `manifest.json` (generated, placed at archive root)

When `apps` is empty, include everything (current behavior).

Excluded always (in addition to `.hbignore`):
- `.holaboss/` (runtime state)
- `node_modules/`
- `data/*.db` (SQLite runtime data)

## Desktop UI Implementation

### Dialog Component

New file: `desktop/src/components/publish/PublishDialog.tsx`

Same 4-step wizard as web, adapted to desktop patterns:
- Base UI components (`@base-ui/react`) instead of Radix
- Custom overlay pattern (matching `SettingsDialog`)
- `lucide-react` icons
- Tailwind + cva styling

### Workspace State Integration

- Installed apps: already available via `workspaceDesktop.tsx` → `installedApps`
- User info: available via `authClient.ts` → `useDesktopAuthSession`
- Workspace ID: available via `workspaceSelection.tsx` → `selectedWorkspaceId`

### IPC Additions (`electron.d.ts`)

```ts
interface ElectronAPI {
  workspace: {
    // ... existing methods ...
    createSubmission(payload: CreateSubmissionPayload): Promise<CreateSubmissionResponse>;
    packageAndUploadWorkspace(params: PackageUploadParams): Promise<{ archiveSizeBytes: number }>;
    finalizeSubmission(submissionId: string): Promise<FinalizeSubmissionResponse>;
  }
}
```

### Trigger Point

Add "Publish to Store" action in the workspace dropdown (matching web's trigger location). This goes in `TopTabsBar.tsx` workspace menu or a dedicated action in the left navigation rail.

## Web Frontend Changes

Minimal changes to existing `publish-template-dialog.tsx`:

1. Replace single `fetch()` in `handleSubmit` with three sequential calls:
   - `POST /marketplace/submissions` → get `submission_id` + `upload_url`
   - `POST /marketplace/submissions/{id}/package-from-sandbox`
   - `POST /marketplace/submissions/{id}/finalize`

2. Add progress feedback during submission (e.g. "Creating submission..." → "Packaging workspace..." → "Finalizing...")

3. No wizard step changes needed — the 4-step UI is correct, data now actually gets persisted.

## Backend Changes

### New Endpoints (marketplace service)

- `POST /api/v1/marketplace/submissions` — create submission + presigned URL
- `POST /api/v1/marketplace/submissions/{id}/package-from-sandbox` — package from sandbox
- `POST /api/v1/marketplace/submissions/{id}/finalize` — finalize after upload

### Model Changes

- New `CreateSubmissionPayload` with `extra="forbid"`, includes `apps` and `onboarding_md`
- Submission record in Supabase gains `apps` (jsonb) and `onboarding_md` (text) columns
- Status gains new states: `pending_upload` → `pending_finalize` → `pending_review` → `published` / `rejected`

### Deprecation

- `POST /projects/workspaces/{id}/publish` — keep for backwards compatibility with a deprecation warning header, internally delegates to the new three-step flow. Remove after web frontend is migrated.

### Convention

- All request body models use `extra="forbid"` as standard practice. Add to `backend/AGENTS.md`.

## Submission Status State Machine

```
pending_upload → pending_finalize → pending_review → published
                                                   → rejected
pending_upload → expired (upload_url expired, no archive received)
```

## Error Handling

| Step | Error | HTTP | Behavior |
|------|-------|------|----------|
| 1 | Invalid payload | 422 | Pydantic `extra="forbid"` rejects unknown fields |
| 1 | Workspace not found | 404 | |
| 1 | Unauthorized | 403 | |
| 2a | Sandbox unreachable | 502 | Submission stays `pending_upload`, can retry |
| 2a | Archive too large | 413 | Max 100 MB compressed |
| 2b | Upload failed | - | Desktop shows error, can retry upload |
| 3 | Archive not found in S3 | 409 | "Upload not completed" |
| 3 | Wrong status | 409 | "Submission not ready for finalization" |
