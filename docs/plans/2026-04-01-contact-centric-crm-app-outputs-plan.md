# Contact-Centric CRM App Outputs Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Define and implement a contact-centric CRM output protocol so Gmail- and Sheets-mediated results can both land in the shared `outputs` table and reopen into the correct app view from the desktop UI.

**Architecture:** Keep `outputs` as the single durable result ledger, but stop overloading `output_type` as a UI route hint. Introduce a standard app-output protocol carried in `metadata.presentation`, exposed through the module-local Holaboss Bridge SDK, then adopt it first in Gmail and Sheets. Gmail becomes the communication surface for draft/thread outputs; Sheets becomes the CRM record surface for contact-row outputs. The desktop reads the same protocol for any app output and opens the correct iframe route.

**Tech Stack:** runtime `outputs` API + state store, Electron desktop renderer, module-local Holaboss Bridge SDKs in `../../holaboss-modules/*/src/server/holaboss-bridge.ts`, TanStack Router module apps, node:test

### Task 1: Define the platform app-output protocol

**Files:**
- Create: `docs/plans/2026-04-01-contact-centric-crm-app-outputs-plan.md`
- Modify: `desktop/src/components/layout/AppShell.tsx`
- Modify: `desktop/src/components/layout/OperationsDrawer.tsx`
- Modify: `desktop/src/types/electron.d.ts`

**Step 1: Define the canonical output model**

Use the existing `outputs` table fields as follows:

- `module_id`: app id, e.g. `gmail`, `sheets`
- `module_resource_id`: app-local object id, e.g. draft id or contact-row id
- `output_type`: semantic result type, e.g. `draft`, `thread`, `contact_row`
- `metadata.source_kind`: `application`
- `metadata.presentation`: canonical UI protocol
- `metadata.resource`: app-domain object identity
- `metadata.crm`: cross-app contact references

Canonical `metadata.presentation` shape:

```json
{
  "kind": "app_resource",
  "view": "draft",
  "path": "/drafts/draft-42"
}
```

Canonical `metadata.resource` shape:

```json
{
  "entity_type": "draft",
  "entity_id": "draft-42",
  "label": "Reply draft"
}
```

Canonical CRM cross-reference shape:

```json
{
  "contact_key": "alice@example.com",
  "contact_row_ref": {
    "spreadsheet_id": "sheet-123",
    "sheet_name": "Sheet1",
    "row_number": 7
  }
}
```

**Step 2: Stop deriving app view from `output_type`**

Desktop must prefer `metadata.presentation.view` and `metadata.presentation.path`. `output_type` remains semantic only.

**Step 3: Add focused failing tests**

Add desktop-focused tests that assert:
- app outputs prefer `metadata.presentation` over `output_type`
- app outputs can carry CRM references without affecting internal outputs

### Task 2: Extend the module-local Bridge SDK for app outputs

**Files:**
- Modify: `../../holaboss-modules/gmail/src/server/holaboss-bridge.ts`
- Modify: `../../holaboss-modules/sheets/src/server/holaboss-bridge.ts`
- Later mirror to: `../../holaboss-modules/twitter/src/server/holaboss-bridge.ts`, `../../holaboss-modules/reddit/src/server/holaboss-bridge.ts`, `../../holaboss-modules/linkedin/src/server/holaboss-bridge.ts`, `../../holaboss-modules/_template/src/server/holaboss-bridge.ts`

**Step 1: Add a small app-output writer API**

Expose a focused SDK surface:

```ts
export interface AppOutputPresentation {
  kind: "app_resource"
  view: string
  path: string
}

export interface AppOutputResource {
  entity_type: string
  entity_id: string
  label?: string
}

export interface AppOutputCrmRef {
  contact_key?: string
  contact_row_ref?: {
    spreadsheet_id: string
    sheet_name?: string
    row_number: number
  }
}

export interface CreateAppOutputInput {
  workspaceId: string
  sessionId?: string | null
  moduleId: string
  moduleResourceId: string
  outputType: string
  title: string
  status?: string
  presentation: AppOutputPresentation
  resource: AppOutputResource
  crm?: AppOutputCrmRef | null
  metadata?: Record<string, unknown>
}
```

Provide:
- `createAppOutput(input)`
- `updateAppOutput(outputId, patch)`
- `buildAppResourcePresentation(view, path)`

**Step 2: Implement against the existing runtime outputs API**

Write through `POST /api/v1/outputs` and `PATCH /api/v1/outputs/:outputId`, not a new storage path.

**Step 3: Keep scope tight**

Do not absorb direct-output helpers yet. This SDK expansion is only for `application` outputs.

### Task 3: Adopt the protocol in Gmail

**Files:**
- Modify: `../../holaboss-modules/gmail/src/server/holaboss-bridge.ts`
- Modify: `../../holaboss-modules/gmail/src/server/mcp.ts`
- Modify: `../../holaboss-modules/gmail/src/routes/index.tsx`
- Create: `../../holaboss-modules/gmail/src/routes/drafts.$draftId.tsx`
- Optional create later: `../../holaboss-modules/gmail/src/routes/threads.$threadId.tsx`
- Modify: `../../holaboss-modules/gmail/src/lib/types.ts`

**Step 1: Define Gmail app resources**

First-class Gmail CRM resources:
- `draft`
- `thread`

First version implementation priority:
- `draft` is required
- `thread` may be read-only in phase 2

**Step 2: Add a stable route for single-draft reopen**

Create:
- `/drafts/$draftId`

This route loads one local draft from the module DB and renders:
- subject
- recipient
- body
- status
- linked Gmail thread id if present

**Step 3: Publish output on draft creation**

In `gmail_draft_reply`, after draft insert, create an app output:

```json
{
  "module_id": "gmail",
  "module_resource_id": "<draft-id>",
  "output_type": "draft",
  "title": "Draft reply to alice@example.com",
  "metadata": {
    "source_kind": "application",
    "presentation": {
      "kind": "app_resource",
      "view": "draft",
      "path": "/drafts/<draft-id>"
    },
    "resource": {
      "entity_type": "draft",
      "entity_id": "<draft-id>",
      "label": "Email draft"
    }
  }
}
```

If the agent already knows which CRM contact it is working on, add:
- `metadata.crm.contact_key`
- `metadata.crm.contact_row_ref`

**Step 4: Update output on send**

When `gmail_send_draft` succeeds:
- update the draft status in module DB
- update the matching output status to `sent` or `completed`
- optionally add `metadata.gmail.message_id`

### Task 4: Define the Sheets contact-record surface

**Files:**
- Modify: `../../holaboss-modules/sheets/src/server/holaboss-bridge.ts`
- Modify: `../../holaboss-modules/sheets/src/routes/index.tsx`
- Create: `../../holaboss-modules/sheets/src/routes/contacts.$contactRef.tsx`
- Modify: `../../holaboss-modules/sheets/src/server/actions.ts`
- Modify: `../../holaboss-modules/sheets/src/server/demo-actions.ts`
- Modify: `../../holaboss-modules/sheets/src/lib/types.ts`

**Step 1: Choose the canonical CRM resource**

For Sheets, first-class CRM resource is:
- `contact_row`

Canonical identity format:

```text
<spreadsheet_id>:<sheet_name>:<row_number>
```

This is what should become `module_resource_id`.

**Step 2: Promote the existing demo into a stable contact detail route**

The current `demo.tsx` is too broad. Add a focused route that can reopen a single CRM record:
- `/contacts/$contactRef`

The route resolves:
- spreadsheet id
- sheet name
- row number

Then loads:
- row data
- primary email
- any derived CRM fields (company, owner, stage, last_contacted_at, next_action)

**Step 3: Publish output when the agent changes CRM state**

Examples:
- creates the sample contact sheet
- updates a contact row after drafting follow-up
- appends a new contact

Output shape:

```json
{
  "module_id": "sheets",
  "module_resource_id": "sheet-123:Sheet1:7",
  "output_type": "contact_row",
  "title": "Updated CRM contact: Alice Chen",
  "metadata": {
    "source_kind": "application",
    "presentation": {
      "kind": "app_resource",
      "view": "contact",
      "path": "/contacts/sheet-123%3ASheet1%3A7"
    },
    "resource": {
      "entity_type": "contact_row",
      "entity_id": "sheet-123:Sheet1:7",
      "label": "Alice Chen"
    },
    "crm": {
      "contact_key": "alice@example.com",
      "contact_row_ref": {
        "spreadsheet_id": "sheet-123",
        "sheet_name": "Sheet1",
        "row_number": 7
      }
    }
  }
}
```

### Task 5: Define the contact-centric CRM workflow

**Files:**
- Modify: `../../holaboss-modules/gmail/src/server/mcp.ts`
- Modify: `../../holaboss-modules/sheets/src/server/demo-actions.ts`
- Modify: desktop output opening logic in `desktop/src/components/layout/AppShell.tsx`

**Step 1: Establish the CRM source of truth**

Use Sheets as the canonical contact table. A contact is keyed by email and anchored to a row.

**Step 2: Use Gmail as the communication execution surface**

Gmail creates:
- drafts
- thread views
- sent-message outcomes

**Step 3: Link outputs with cross-app CRM metadata**

Example lifecycle:
1. Agent selects contact row in Sheets
2. Agent reads Gmail thread history for that contact
3. Agent creates a Gmail draft
4. Gmail writes a `draft` output referencing the Sheets contact
5. Agent updates the Sheets row (`stage`, `last_contacted_at`, `next_action`)
6. Sheets writes a `contact_row` output for the same `contact_key`

This yields two durable outputs that both reopen into their app-native surfaces while still describing the same CRM contact.

### Task 6: Update desktop output opening logic

**Files:**
- Modify: `desktop/src/components/layout/AppShell.tsx`
- Modify: `desktop/src/components/layout/OperationsDrawer.tsx`
- Modify: `desktop/src/components/panes/AppSurfacePane.tsx`
- Modify: `desktop/src/components/panes/appSurfaceRoute.ts`
- Test: `desktop/src/components/panes/AppSurfacePane.test.mjs`

**Step 1: Read `metadata.presentation` first**

When an output has:

```json
{
  "source_kind": "application",
  "presentation": {
    "kind": "app_resource",
    "view": "...",
    "path": "..."
  }
}
```

Desktop should:
- open the module iframe
- use `presentation.view` as UI view context
- use `presentation.path` as the iframe route

**Step 2: Keep fallback compatibility**

If `metadata.presentation` is absent:
- fall back to the existing route helper behavior
- continue supporting legacy `/posts/:id` patterns

**Step 3: Surface CRM references later**

Do not block phase 1 on cross-app UI chrome. It is enough that the metadata exists and is queryable.

### Task 7: Testing and rollout

**Files:**
- Create: focused tests in desktop and module repos

**Step 1: Gmail tests**

Add tests for:
- draft detail route loads a draft
- `gmail_draft_reply` creates a draft output payload
- `gmail_send_draft` updates output status

**Step 2: Sheets tests**

Add tests for:
- contact route resolves a row reference
- contact-row output payload is produced when a row is created or updated

**Step 3: Desktop tests**

Add tests for:
- output renderer prefers `metadata.presentation.path`
- app outputs still open inside the iframe app surface
- internal outputs remain unchanged

**Step 4: Rollout order**

1. Bridge SDK app-output writer
2. Gmail `draft` resource + route + output creation
3. Desktop `metadata.presentation` consumption
4. Sheets `contact_row` resource + route + output creation
5. Optional Gmail `thread` resource and richer CRM chrome

### Task 8: Commit plan

**Files:**
- Create: `docs/plans/2026-04-01-contact-centric-crm-app-outputs-plan.md`

**Step 1: Commit**

```bash
git add docs/plans/2026-04-01-contact-centric-crm-app-outputs-plan.md
git commit -m "feat: define contact-centric crm app outputs plan"
```
