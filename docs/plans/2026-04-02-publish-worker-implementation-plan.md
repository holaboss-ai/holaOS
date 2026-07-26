# Publish Worker — Unified Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single `/publish` endpoint into a three-step API (create submission → package/upload → finalize), fix silent data loss for `apps` and `onboarding_md`, and implement a matching publish dialog in the desktop app.

**Architecture:** Backend adds three new marketplace endpoints with presigned S3 PUT URLs. Web frontend updates its existing dialog to call the three-step API. Desktop app adds a new IPC-backed publish dialog that packages workspace files locally and uploads directly to S3. Both platforms share the same submission API and manifest format.

**Tech Stack:** Python/FastAPI (backend), React/Base UI/Electron (desktop), React/Radix (web frontend), boto3 (S3), archiver (Node.js zip)

**Spec:** `docs/plans/2026-04-02-publish-worker-unified-design.md`

---

## Subsystem A: Backend API

### Task 1: Supabase migration — add `apps` and `onboarding_md` columns

**Files:**
- Create: `backend/supabase/migrations/20260402000000_add_submission_apps_onboarding.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Add apps and onboarding_md columns to template_submissions
ALTER TABLE template_submissions
ADD COLUMN IF NOT EXISTS apps JSONB NOT NULL DEFAULT '[]',
ADD COLUMN IF NOT EXISTS onboarding_md TEXT;

-- Add status index for new states
CREATE INDEX IF NOT EXISTS idx_submissions_status_created
ON template_submissions(status, created_at DESC);
```

- [ ] **Step 2: Apply migration locally**

Run: `cd backend && supabase db push --local`
Expected: Migration applied successfully.

- [ ] **Step 3: Commit**

```bash
cd backend
git add supabase/migrations/20260402000000_add_submission_apps_onboarding.sql
git commit -m "migrate: add apps and onboarding_md columns to template_submissions"
```

---

### Task 2: Update the submission repository to handle new fields + presigned PUT URL

**Files (backend, marketplace services):**
- Modify: the backend's submission repository
- Modify: the backend's archive-storage service
- Modify: the backend's template packager

- [ ] **Step 1: Add `apps` and `onboarding_md` to `SubmissionRecord`**

In the backend's submission repository, update `SubmissionRecord`:

```python
@property
def apps(self) -> list[str]:
    raw = self._row.get("apps")
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str):
        import json
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else []
        except (json.JSONDecodeError, TypeError):
            return []
    return []

@property
def onboarding_md(self) -> str | None:
    return self._row.get("onboarding_md")
```

- [ ] **Step 2: Update `SupabaseSubmissionRepository.create` to accept new fields**

Update the `create` method signature and body to include `apps`, `onboarding_md`, and `archive_storage_key`:

```python
async def create(
    self,
    *,
    author_id: str,
    author_name: str,
    template_name: str,
    template_id: str,
    version: str,
    status: str,
    manifest: dict,
    archive_data: bytes | None = None,
    archive_size_bytes: int = 0,
    apps: list[str] | None = None,
    onboarding_md: str | None = None,
    archive_storage_key: str | None = None,
) -> SubmissionRecord:
    row = {
        "author_id": author_id,
        "author_name": author_name,
        "template_name": template_name,
        "template_id": template_id,
        "version": version,
        "status": status,
        "manifest": json.dumps(manifest),
        "archive_data": archive_data.hex() if archive_data else None,
        "archive_size_bytes": archive_size_bytes,
        "apps": json.dumps(apps or []),
        "onboarding_md": onboarding_md,
        "archive_storage_key": archive_storage_key,
    }
    result = self._supabase.table(self._table).insert(row).execute()
    return SubmissionRecord(result.data[0])
```

Also update `InMemorySubmissionRepository.create` with the same new parameters.

- [ ] **Step 3: Add presigned PUT URL generation to the archive-storage service**

In the backend's archive-storage service, add:

```python
def generate_upload_url(self, *, author_id: str, template_id: str, version: str, expiration: int = 3600) -> tuple[str, str]:
    """Returns (presigned_put_url, object_key)."""
    object_key = self.build_object_key(author_id=author_id, template_id=template_id, version=version)
    url = self._s3.s3_client.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": self._s3.bucket_name,
            "Key": object_key,
            "ContentType": "application/zip",
        },
        ExpiresIn=expiration,
    )
    return url, object_key
```

- [ ] **Step 4: Add `apps` filtering to `create_manifest`**

In the backend's template packager, update `create_manifest`:

```python
def create_manifest(
    template_id: str,
    name: str,
    version: str,
    description: str,
    author_id: str,
    author_name: str = "",
    tags: list[str] | None = None,
    dependencies: list[str] | None = None,
    apps: list[str] | None = None,
    onboarding_md: str | None = None,
    category: str = "general",
) -> dict:
    return {
        "template_id": template_id,
        "name": name,
        "version": version,
        "description": description,
        "category": category,
        "author": {"id": author_id, "name": author_name},
        "tags": tags or [],
        "dependencies": dependencies or [],
        "apps": apps or [],
        "onboarding_md": onboarding_md,
        "created_at": datetime.now(UTC).isoformat(),
    }
```

- [ ] **Step 5: Add `included_apps` filter to `package_directory_as_zip`**

In the backend's template packager, add an `included_apps` parameter:

```python
def package_directory_as_zip(
    directory: Path,
    manifest: dict,
    hbignore_content: str | None = None,
    included_apps: list[str] | None = None,
) -> bytes:
```

Inside the `rglob` loop, before the existing `should_include` check, add:

```python
# Filter by selected apps if specified
if included_apps is not None and len(included_apps) > 0:
    rel_parts = relative.parts
    if len(rel_parts) >= 2 and rel_parts[0] == "apps":
        app_dir_name = rel_parts[1]
        if app_dir_name not in included_apps:
            continue
```

This skips `apps/<name>/` directories that aren't in the selected list. Root files (`workspace.yaml`, `AGENTS.md`, `skills/`, etc.) pass through unaffected.

- [ ] **Step 6: Run existing tests**

Run: `cd backend && uv run pytest test/services/marketplace/ -v`
Expected: PASS (existing tests should not break since new params have defaults).

- [ ] **Step 7: Commit**

```bash
cd backend
git add <the marketplace service files touched above>
git commit -m "feat(marketplace): add apps/onboarding_md to submission + presigned PUT URL + apps filtering"
```

---

### Task 3: Create submission endpoint

**Files (backend, marketplace API routes):**
- Create: a new `publish` routes module
- Modify: the marketplace v1 router

- [ ] **Step 1: Create the publish routes module**

Create the new marketplace publish routes module:

```python
from __future__ import annotations

import re
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

# import the archive-storage service and the template packager from the backend's marketplace services

router = APIRouter(prefix="/marketplace")


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", name.strip().lower())
    slug = slug.strip("_")
    return slug[:50] or "untitled"


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


class CreateSubmissionResponse(BaseModel):
    submission_id: str
    template_id: str
    upload_url: str
    upload_expires_at: str


class FinalizePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    holaboss_user_id: str | None = None


class FinalizeResponse(BaseModel):
    submission_id: str
    status: str
    template_name: str


class PackageFromSandboxPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    holaboss_user_id: str | None = None


class PackageFromSandboxResponse(BaseModel):
    submission_id: str
    archive_size_bytes: int
    status: str


@router.post(
    "/submissions/create",
    response_model=CreateSubmissionResponse,
    status_code=201,
    operation_id="createSubmission",
)
async def create_submission(payload: CreateSubmissionPayload, request: Request):
    submission_repo = request.app.state.submission_repository
    archive_storage: MarketplaceArchiveStorage | None = MarketplaceArchiveStorage.from_env()
    if archive_storage is None:
        raise HTTPException(status_code=500, detail="Archive storage not configured")

    author_id = (payload.holaboss_user_id or "").strip()
    if not author_id:
        raise HTTPException(status_code=422, detail="holaboss_user_id is required")

    template_id = _slugify(payload.name)
    version = "1.0.0"

    manifest = create_manifest(
        template_id=template_id,
        name=payload.name,
        version=version,
        description=payload.description,
        author_id=author_id,
        tags=payload.tags,
        apps=payload.apps,
        onboarding_md=payload.onboarding_md,
        category=payload.category,
    )

    upload_url, object_key = archive_storage.generate_upload_url(
        author_id=author_id,
        template_id=template_id,
        version=version,
        expiration=3600,
    )

    expiry = datetime.now(UTC).replace(microsecond=0)
    from datetime import timedelta
    expiry = expiry + timedelta(hours=1)

    record = await submission_repo.create(
        author_id=author_id,
        author_name="",
        template_name=f"{author_id}/{template_id}",
        template_id=template_id,
        version=version,
        status="pending_upload",
        manifest=manifest,
        apps=payload.apps,
        onboarding_md=payload.onboarding_md,
        archive_storage_key=object_key,
    )

    return CreateSubmissionResponse(
        submission_id=record.id,
        template_id=template_id,
        upload_url=upload_url,
        upload_expires_at=expiry.isoformat() + "Z",
    )


@router.post(
    "/submissions/{submission_id}/package-from-sandbox",
    response_model=PackageFromSandboxResponse,
    operation_id="packageFromSandbox",
)
async def package_from_sandbox(
    submission_id: str,
    payload: PackageFromSandboxPayload,
    request: Request,
):
    import tarfile
    import tempfile
    from pathlib import Path

    # import the archive-storage service, the template packager (package_directory_as_zip),
    # and the workspace-dependency error type from the backend's marketplace/workspaces services

    submission_repo = request.app.state.submission_repository
    record = await submission_repo.get_by_id(submission_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Submission not found")
    if record.status != "pending_upload":
        raise HTTPException(status_code=409, detail=f"Submission status is '{record.status}', expected 'pending_upload'")

    workspace_id = record.manifest.get("workspace_id") or ""
    holaboss_user_id = (payload.holaboss_user_id or record.author_id).strip()

    # Export workspace files from sandbox
    workspace_service = request.app.state.workspace_service
    if workspace_service is None:
        raise HTTPException(status_code=500, detail="Workspace service not available in marketplace service")

    try:
        tar_bytes = await workspace_service.export_workspace_files(
            workspace_id=workspace_id,
            holaboss_user_id=holaboss_user_id,
        )
    except WorkspaceDependencyError as exc:
        raise HTTPException(status_code=502, detail=f"Failed to export workspace: {exc}") from exc

    # Extract, package, upload
    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        import io
        with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as tf:
            # use the projects service's safe tar-extraction helper
            _safe_extract(tf, tmp_path)

        hbignore_path = tmp_path / ".hbignore"
        hbignore_content = hbignore_path.read_text() if hbignore_path.is_file() else None

        archive_bytes = package_directory_as_zip(
            tmp_path,
            record.manifest,
            hbignore_content=hbignore_content,
            included_apps=record.apps if record.apps else None,
        )

    # Upload to S3 using the pre-allocated key
    archive_storage = MarketplaceArchiveStorage.from_env()
    if archive_storage is None:
        raise HTTPException(status_code=500, detail="Archive storage not configured")

    object_key = record.manifest.get("archive_storage_key") or ""
    if not object_key:
        object_key = archive_storage.build_object_key(
            author_id=record.author_id,
            template_id=record.template_id,
            version=record.version,
        )
    archive_storage._s3.upload_bytes(
        file_data=archive_bytes,
        object_key=object_key,
        content_type="application/zip",
        metadata={"author_id": record.author_id, "template_id": record.template_id},
    )

    await submission_repo.update_status(
        submission_id=submission_id,
        status="pending_finalize",
    )
    # Store archive size
    await submission_repo.update_archive_size(submission_id, len(archive_bytes))

    return PackageFromSandboxResponse(
        submission_id=submission_id,
        archive_size_bytes=len(archive_bytes),
        status="pending_finalize",
    )


@router.post(
    "/submissions/{submission_id}/finalize",
    response_model=FinalizeResponse,
    operation_id="finalizeSubmission",
)
async def finalize_submission(
    submission_id: str,
    payload: FinalizePayload,
    request: Request,
):
    submission_repo = request.app.state.submission_repository
    record = await submission_repo.get_by_id(submission_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Submission not found")
    if record.status not in ("pending_upload", "pending_finalize"):
        raise HTTPException(
            status_code=409,
            detail=f"Submission status is '{record.status}', expected 'pending_upload' or 'pending_finalize'",
        )

    # Verify archive exists in S3
    archive_storage = MarketplaceArchiveStorage.from_env()
    if archive_storage:
        object_key = archive_storage.build_object_key(
            author_id=record.author_id,
            template_id=record.template_id,
            version=record.version,
        )
        if not archive_storage._s3.object_exists(object_key):
            raise HTTPException(status_code=409, detail="Archive not found in storage. Upload may not have completed.")

    await submission_repo.update_status(
        submission_id=submission_id,
        status="pending_review",
    )

    return FinalizeResponse(
        submission_id=submission_id,
        status="pending_review",
        template_name=record.template_name,
    )
```

- [ ] **Step 2: Add `update_archive_size` and `object_exists` helpers**

In the submission repository, add to both implementations:

```python
async def update_archive_size(self, submission_id: str, size: int) -> None:
    self._supabase.table(self._table).update({"archive_size_bytes": size}).eq("id", submission_id).execute()
```

In the backend's S3 storage service, add:

```python
def object_exists(self, object_key: str) -> bool:
    try:
        self.s3_client.head_object(Bucket=self.bucket_name, Key=object_key)
        return True
    except self.s3_client.exceptions.ClientError:
        return False
```

- [ ] **Step 3: Register in v1 router**

In the marketplace v1 router, include the new publish router:

```python
# from the new publish routes module
v1_router.include_router(publish_router)
```

- [ ] **Step 4: Store `workspace_id` in manifest during creation**

In the `create_submission` handler, add `workspace_id` to manifest before saving:

```python
manifest["workspace_id"] = payload.workspace_id
```

- [ ] **Step 5: Run quality checks**

Run: `cd backend && make check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd backend
git add <the marketplace publish routes, v1 router, submission repository, and S3 storage service touched above>
git commit -m "feat(marketplace): add three-step publish API with presigned upload"
```

---

### Task 4: Add `package-from-sandbox` workspace service dependency

The `package-from-sandbox` endpoint needs access to `workspace_service` for `export_workspace_files`. This service lives in the projects service, not marketplace. Two options: (a) mount the endpoint in the projects service, or (b) inject workspace_service into marketplace lifespan.

**Recommended:** Mount the `package-from-sandbox` route in the **projects service** since it already has `workspace_service`. The other two endpoints (`create`, `finalize`) stay in marketplace.

**Files (backend, projects API routes):**
- Modify: the projects v1 router
- Move: the `package_from_sandbox` handler into the projects service's workspaces routes

- [ ] **Step 1: Move `package_from_sandbox` to projects routes**

Add the handler to the projects service's workspaces routes as a new route. It can directly access `workspace_service` from `request.app.state`.

Update the endpoint path to include the workspace context:

```python
@workspace_router.post(
    "/{workspace_id}/package-for-submission",
    response_model=PackageFromSandboxResponse,
    operation_id="packageWorkspaceForSubmission",
)
async def package_workspace_for_submission(
    workspace_id: str,
    payload: PackageFromSandboxPayload,
    request: Request,
):
    # ... (same logic as Task 3, but reads workspace_service from request.app.state)
```

- [ ] **Step 2: Remove `package_from_sandbox` from the marketplace publish routes**

Keep only `create_submission` and `finalize_submission` in the publish routes module.

- [ ] **Step 3: Run tests**

Run: `cd backend && uv run pytest test/api/v1/ -v -k "publish or submission"`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd backend
git add <the projects workspaces routes and the marketplace publish routes touched above>
git commit -m "feat: move package-from-sandbox to projects service for workspace_service access"
```

---

### Task 5: Deprecate old `/publish` endpoint

**Files (backend, projects API routes):**
- Modify: the projects service's workspaces routes

- [ ] **Step 1: Add deprecation warning header**

Wrap the existing `publish_workspace_as_template` handler to add a `Deprecation` response header:

```python
@workspace_router.post(
    "/{workspace_id}/publish",
    response_model=PublishTemplateResponse,
    status_code=201,
    operation_id="publishWorkspaceAsTemplate",
    deprecated=True,
)
async def publish_workspace_as_template(
    workspace_id: str, payload: PublishTemplatePayload, request: Request, response: Response
):
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = "2026-06-01"
    # ... existing implementation unchanged
```

- [ ] **Step 2: Commit**

```bash
cd backend
git add <the projects workspaces routes touched above>
git commit -m "chore: mark /publish endpoint as deprecated"
```

---

## Subsystem B: Desktop App

### Task 6: Add `archiver` dependency + packaging utility

**Files:**
- Modify: `holaOS/desktop/package.json`
- Create: `holaOS/desktop/electron/workspace-packager.ts`

- [ ] **Step 1: Install archiver**

Run: `cd holaOS/desktop && npm install archiver && npm install -D @types/archiver`

- [ ] **Step 2: Create the workspace packager module**

Create `holaOS/desktop/electron/workspace-packager.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";

export interface PackageWorkspaceParams {
  workspaceDir: string;
  apps: string[];
  manifest: Record<string, unknown>;
}

export interface PackageResult {
  archiveBuffer: Buffer;
  archiveSizeBytes: number;
}

const GLOBAL_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "out",
  ".parcel-cache",
  ".vercel",
  ".yarn",
  ".pnpm-store",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "target",
  "tmp",
  "temp",
  ".DS_Store",
  ".cache",
  ".turbo",
  "coverage",
  ".holaboss",
]);

const SENSITIVE_PATTERNS = [".pem", ".key"];

function shouldIgnoreEntry(entryName: string): boolean {
  const parts = entryName.split("/");
  for (const part of parts) {
    if (GLOBAL_IGNORE.has(part)) return true;
  }
  const lower = entryName.toLowerCase();
  for (const pat of SENSITIVE_PATTERNS) {
    if (lower.endsWith(pat)) return true;
  }
  if (lower.includes("secret") || lower.includes("token") || lower.includes("credential")) return true;
  // Skip sqlite data files
  if (/^data\/.*\.db$/.test(entryName)) return true;
  return false;
}

function shouldIncludeForApps(relativePath: string, selectedApps: string[]): boolean {
  if (selectedApps.length === 0) return true;
  const parts = relativePath.split("/");
  if (parts.length >= 2 && parts[0] === "apps") {
    return selectedApps.includes(parts[1]);
  }
  return true; // non-apps/ files always included
}

export async function packageWorkspace(params: PackageWorkspaceParams): Promise<PackageResult> {
  const { workspaceDir, apps, manifest } = params;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 6 } });

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => {
      const buffer = Buffer.concat(chunks);
      resolve({ archiveBuffer: buffer, archiveSizeBytes: buffer.length });
    });
    archive.on("error", reject);

    // manifest.json first
    archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });

    // Read .hbignore if present
    const hbignorePath = path.join(workspaceDir, ".hbignore");
    const customIgnore: string[] = [];
    if (fs.existsSync(hbignorePath)) {
      const content = fs.readFileSync(hbignorePath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          customIgnore.push(trimmed);
        }
      }
    }

    // Walk and add files
    function walkDir(dir: string, prefix: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (relativePath === "manifest.json") continue;
        if (shouldIgnoreEntry(relativePath)) continue;
        if (!shouldIncludeForApps(relativePath, apps)) continue;

        if (entry.isDirectory()) {
          walkDir(fullPath, relativePath);
        } else if (entry.isFile()) {
          archive.file(fullPath, { name: relativePath });
        }
      }
    }

    walkDir(workspaceDir, "");
    archive.finalize();
  });
}

export async function uploadToPresignedUrl(url: string, data: Buffer): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/zip" },
    body: data,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Upload failed (${response.status}): ${text.slice(0, 500)}`);
  }
}
```

- [ ] **Step 3: Commit**

```bash
cd holaOS
git add desktop/package.json desktop/package-lock.json desktop/electron/workspace-packager.ts
git commit -m "feat(desktop): add workspace packager for publish flow"
```

---

### Task 7: Desktop IPC handlers + preload + types

**Files:**
- Modify: `holaOS/desktop/src/types/electron.d.ts`
- Modify: `holaOS/desktop/electron/preload.ts`
- Modify: `holaOS/desktop/electron/main.ts`

- [ ] **Step 1: Add types to `electron.d.ts`**

Add before the `workspace` interface closing brace (~line 890):

```typescript
  interface CreateSubmissionPayload {
    workspaceId: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    apps: string[];
    onboardingMd: string | null;
  }

  interface CreateSubmissionResponse {
    submission_id: string;
    template_id: string;
    upload_url: string;
    upload_expires_at: string;
  }

  interface FinalizeSubmissionResponse {
    submission_id: string;
    status: string;
    template_name: string;
  }

  interface PackageAndUploadResult {
    archiveSizeBytes: number;
  }
```

Add to the `workspace` section of `ElectronAPI`:

```typescript
    createSubmission(payload: CreateSubmissionPayload): Promise<CreateSubmissionResponse>;
    packageAndUploadWorkspace(params: {
      workspaceId: string;
      apps: string[];
      manifest: Record<string, unknown>;
      uploadUrl: string;
    }): Promise<PackageAndUploadResult>;
    finalizeSubmission(submissionId: string): Promise<FinalizeSubmissionResponse>;
```

- [ ] **Step 2: Add preload bindings**

In `holaOS/desktop/electron/preload.ts`, add to the `workspace` object:

```typescript
    createSubmission: (payload: CreateSubmissionPayload) =>
      ipcRenderer.invoke("workspace:createSubmission", payload) as Promise<CreateSubmissionResponse>,
    packageAndUploadWorkspace: (params: {
      workspaceId: string;
      apps: string[];
      manifest: Record<string, unknown>;
      uploadUrl: string;
    }) =>
      ipcRenderer.invoke("workspace:packageAndUploadWorkspace", params) as Promise<PackageAndUploadResult>,
    finalizeSubmission: (submissionId: string) =>
      ipcRenderer.invoke("workspace:finalizeSubmission", submissionId) as Promise<FinalizeSubmissionResponse>,
```

- [ ] **Step 3: Add IPC handlers in `main.ts`**

Add near the other workspace IPC registrations (~line 11890):

```typescript
  // Publish flow
  handleTrustedIpc("workspace:createSubmission", ["main"], async (_event, payload: CreateSubmissionPayload) => {
    const userId = await controlPlaneWorkspaceUserId();
    if (!userId) throw new Error("Not authenticated");

    const apiKey = controlPlaneApiKey();
    const baseUrl = DESKTOP_CONTROL_PLANE_BASE_URL;
    if (!baseUrl || !apiKey) throw new Error("Control plane not configured");

    const response = await fetch(`${baseUrl}/api/v1/marketplace/submissions/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        workspace_id: payload.workspaceId,
        holaboss_user_id: userId,
        name: payload.name,
        description: payload.description,
        category: payload.category,
        tags: payload.tags,
        apps: payload.apps,
        onboarding_md: payload.onboardingMd,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Create submission failed (${response.status}): ${text.slice(0, 500)}`);
    }

    return await response.json();
  });

  handleTrustedIpc("workspace:packageAndUploadWorkspace", ["main"], async (_event, params: {
    workspaceId: string;
    apps: string[];
    manifest: Record<string, unknown>;
    uploadUrl: string;
  }) => {
    const { packageWorkspace, uploadToPresignedUrl } = await import("./workspace-packager.js");
    const workspaceDir = workspaceDirectoryPath(params.workspaceId);

    const result = await packageWorkspace({
      workspaceDir,
      apps: params.apps,
      manifest: params.manifest,
    });

    await uploadToPresignedUrl(params.uploadUrl, result.archiveBuffer);

    return { archiveSizeBytes: result.archiveSizeBytes };
  });

  handleTrustedIpc("workspace:finalizeSubmission", ["main"], async (_event, submissionId: string) => {
    const userId = await controlPlaneWorkspaceUserId();
    const apiKey = controlPlaneApiKey();
    const baseUrl = DESKTOP_CONTROL_PLANE_BASE_URL;
    if (!baseUrl || !apiKey) throw new Error("Control plane not configured");

    const response = await fetch(`${baseUrl}/api/v1/marketplace/submissions/${encodeURIComponent(submissionId)}/finalize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ holaboss_user_id: userId }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Finalize failed (${response.status}): ${text.slice(0, 500)}`);
    }

    return await response.json();
  });
```

- [ ] **Step 4: Run typecheck**

Run: `cd holaOS && npm --prefix desktop run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd holaOS
git add desktop/src/types/electron.d.ts desktop/electron/preload.ts desktop/electron/main.ts
git commit -m "feat(desktop): add publish IPC handlers for three-step submission flow"
```

---

### Task 8: Desktop PublishDialog UI component

**Files:**
- Create: `holaOS/desktop/src/components/publish/PublishDialog.tsx`

This is a 4-step wizard dialog matching the web's publish flow, using the desktop's established dialog pattern (custom overlay, Base UI components, lucide-react icons, Tailwind + cva).

- [ ] **Step 1: Create the PublishDialog component**

Create `holaOS/desktop/src/components/publish/PublishDialog.tsx`. The component follows the `SettingsDialog` overlay pattern:

- 4 steps: Template Info → Apps → Onboarding → Review & Publish
- Left sidebar with step navigation (matching web's stepper)
- Right content area with fade transitions
- Props: `open`, `onOpenChange`, `workspaceId`
- Gets installed apps from `useWorkspaceDesktop().installedApps`
- Gets user info from desktop auth session
- Submit handler calls three IPC methods sequentially with progress state:
  1. `window.electronAPI.workspace.createSubmission(...)` → "Creating submission..."
  2. `window.electronAPI.workspace.packageAndUploadWorkspace(...)` → "Packaging & uploading..."
  3. `window.electronAPI.workspace.finalizeSubmission(...)` → "Finalizing..."
- Success state shows confirmation with "Done" button

The component is ~400 lines following the exact patterns from the web's `publish-template-dialog.tsx`, adapted to:
- Base UI `Select` instead of Radix `Select`
- Desktop `Input`, `Label`, `Textarea` from `desktop/src/components/ui/`
- `lucide-react` icons instead of `@hugeicons`
- No `createPortal` (desktop uses absolute positioning like `SettingsDialog`)

Full implementation should follow the web dialog structure step-for-step, replacing imports.

- [ ] **Step 2: Run typecheck**

Run: `cd holaOS && npm --prefix desktop run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd holaOS
git add desktop/src/components/publish/PublishDialog.tsx
git commit -m "feat(desktop): add PublishDialog UI component"
```

---

### Task 9: Wire up publish trigger in desktop

**Files:**
- Modify: `holaOS/desktop/src/components/layout/AppShell.tsx`
- Modify: `holaOS/desktop/src/components/layout/TopTabsBar.tsx`

- [ ] **Step 1: Add publish state to AppShell**

In `AppShell.tsx`, add state and render the dialog:

```typescript
const [publishOpen, setPublishOpen] = useState(false);

// In the render, alongside SettingsDialog:
{selectedWorkspaceId && (
  <PublishDialog
    open={publishOpen}
    onOpenChange={setPublishOpen}
    workspaceId={selectedWorkspaceId}
  />
)}
```

Pass `onPublish={() => setPublishOpen(true)}` to `TopTabsBar`.

- [ ] **Step 2: Add "Publish to Store" action in TopTabsBar**

In `TopTabsBar.tsx`, add a publish button in the workspace dropdown menu (near the delete workspace option):

```typescript
<button
  type="button"
  onClick={() => {
    onPublish?.();
    closePopup();
  }}
  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
>
  <Upload size={14} className="text-muted-foreground" />
  Publish to Store
</button>
```

- [ ] **Step 3: Run typecheck**

Run: `cd holaOS && npm --prefix desktop run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd holaOS
git add desktop/src/components/layout/AppShell.tsx desktop/src/components/layout/TopTabsBar.tsx desktop/src/components/publish/PublishDialog.tsx
git commit -m "feat(desktop): wire publish dialog trigger in workspace menu"
```

---

## Subsystem C: Web Frontend

### Task 10: Update web publish dialog to three-step API

**Files:**
- Modify: `frontend/apps/web/src/features/workspace/components/publish-template-dialog.tsx`

- [ ] **Step 1: Update `handleSubmit` to use three-step flow**

Replace the single `fetch` in `handleSubmit` with three sequential calls:

```typescript
const handleSubmit = async () => {
  setError(null);
  setIsSubmitting(true);
  try {
    const tagArray = tags.split(",").map((t) => t.trim()).filter((t) => t.length > 0);

    // Step 1: Create submission
    const createRes = await fetch(
      `${apiUrl}/gateway/marketplace/api/v1/marketplace/submissions/create`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          workspace_id: workspaceId,
          holaboss_user_id: userId,
          name,
          description,
          category,
          tags: tagArray,
          apps: [...selectedApps],
          onboarding_md: onboardingMd || null,
        }),
      }
    );
    if (!createRes.ok) {
      const data = await createRes.json().catch(() => ({}));
      throw new Error(data.detail || `Failed to create submission (${createRes.status})`);
    }
    const submission = await createRes.json();

    // Step 2: Package from sandbox
    const packageRes = await fetch(
      `${apiUrl}/gateway/projects/api/v1/projects/workspaces/${workspaceId}/package-for-submission`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          submission_id: submission.submission_id,
          holaboss_user_id: userId,
        }),
      }
    );
    if (!packageRes.ok) {
      const data = await packageRes.json().catch(() => ({}));
      throw new Error(data.detail || `Failed to package workspace (${packageRes.status})`);
    }

    // Step 3: Finalize
    const finalizeRes = await fetch(
      `${apiUrl}/gateway/marketplace/api/v1/marketplace/submissions/${submission.submission_id}/finalize`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ holaboss_user_id: userId }),
      }
    );
    if (!finalizeRes.ok) {
      const data = await finalizeRes.json().catch(() => ({}));
      throw new Error(data.detail || `Failed to finalize submission (${finalizeRes.status})`);
    }

    setSuccess(true);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Failed to publish template");
  } finally {
    setIsSubmitting(false);
  }
};
```

- [ ] **Step 2: Run frontend lint**

Run: `cd frontend && bun run check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd frontend
git add apps/web/src/features/workspace/components/publish-template-dialog.tsx
git commit -m "feat(web): update publish dialog to use three-step submission API"
```

---

### Task 11: Add `extra="forbid"` convention to backend AGENTS.md

**Files:**
- Modify: `backend/AGENTS.md`

- [ ] **Step 1: Add Pydantic convention**

Append to the coding style section:

```markdown
### Pydantic Request Models

All request body models must use `extra="forbid"` to prevent silent data loss:

```python
class MyPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # fields...
```

This ensures unknown fields from clients are rejected with 422 rather than silently dropped.
```

- [ ] **Step 2: Commit**

```bash
cd backend
git add AGENTS.md
git commit -m "docs: add extra=forbid Pydantic convention to AGENTS.md"
```

---

## Subsystem Dependencies

```
Task 1 (migration) → Task 2 (repository) → Task 3 (endpoints) → Task 4 (package in projects)
                                                                      ↓
Task 6 (packager) → Task 7 (IPC) → Task 8 (UI) → Task 9 (wire up)  Task 10 (web update)
                                                                      ↓
Task 5 (deprecate old endpoint)                                  Task 11 (docs)
```

**Parallelizable:** Tasks 1-5 (backend) and Tasks 6-9 (desktop) can run in parallel. Task 10 (web) depends on backend Tasks 1-4 being deployed.
