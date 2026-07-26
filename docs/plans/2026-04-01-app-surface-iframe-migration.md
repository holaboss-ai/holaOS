# App Surface Iframe Migration Implementation Plan

> **Execution Note:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move first-party workspace app surfaces from Electron `BrowserView` overlays to renderer-managed `iframe` embeds so desktop UI overlays are no longer blocked by native web contents.

**Architecture:** Keep the general-purpose browser pane on native Electron web contents, but change app surfaces to resolve a local app URL in the main process and render it inside React with an `iframe`. Preserve existing actions like reload and app removal in the pane UI while removing the native bounds-sync dependency for app surfaces.

**Tech Stack:** Electron main/preload IPC, React 19, TypeScript, node:test

### Task 1: Lock the target architecture with failing tests

**Files:**
- Create: `desktop/src/components/panes/AppSurfacePane.test.mjs`
- Test: `desktop/src/components/layout/SettingsDialog.test.mjs`

**Step 1: Write the failing test**

Add a focused test that asserts:
- `AppSurfacePane.tsx` renders an `iframe`
- it no longer calls `window.electronAPI.appSurface.setBounds`
- it resolves a URL rather than navigating a native view

**Step 2: Run test to verify it fails**

Run: `node --test desktop/src/components/panes/AppSurfacePane.test.mjs`

Expected: FAIL because the component still uses `navigate` and `setBounds`.

### Task 2: Add URL resolution IPC for app surfaces

**Files:**
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/src/types/electron.d.ts`

**Step 1: Write the failing contract in the renderer test**

The failing test from Task 1 should look for a URL-resolution call, not native bounds sync.

**Step 2: Implement minimal IPC**

Expose:
- `appSurface.resolveUrl(workspaceId, appId, path?) -> Promise<string>`

Back it with the existing main-process URL resolution logic for installed apps.

**Step 3: Verify wiring**

Run: `node --test desktop/src/components/panes/AppSurfacePane.test.mjs`

Expected: still FAIL until renderer is migrated, but no IPC/type mismatch remains in the implementation.

### Task 3: Migrate the app surface pane to an iframe

**Files:**
- Modify: `desktop/src/components/panes/AppSurfacePane.tsx`

**Step 1: Replace native-view lifecycle with renderer iframe state**

Change the component to:
- resolve the app URL via IPC when the app is ready
- store the resolved URL in component state
- render the website in an `iframe` inside the existing right-hand pane
- reload the iframe without depending on native Electron view APIs

**Step 2: Keep existing shell behavior**

Preserve:
- loading state
- error state
- remove-app flow
- app metadata card

**Step 3: Run focused test**

Run: `node --test desktop/src/components/panes/AppSurfacePane.test.mjs`

Expected: PASS

### Task 4: Remove obsolete app-surface native behavior and verify

**Files:**
- Modify: `desktop/src/components/layout/AppShell.tsx`
- Modify: `desktop/electron/main.ts`

**Step 1: Stop hiding/showing app surfaces as native overlays**

Remove or neutralize renderer effects that exist only to hide a `BrowserView`.

**Step 2: Make native app-surface handlers inert or delete them**

Remove `setBounds`/native attachment usage for app surfaces where no longer needed, while leaving browser pane logic intact.

**Step 3: Run verification**

Run:
- `node --test desktop/src/components/panes/AppSurfacePane.test.mjs`
- `node --test desktop/src/components/layout/SettingsDialog.test.mjs`

Expected: PASS

### Task 5: Final verification and commit

**Files:**
- Modify: `desktop/src/components/panes/AppSurfacePane.tsx`
- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/src/types/electron.d.ts`
- Create: `desktop/src/components/panes/AppSurfacePane.test.mjs`

**Step 1: Run broader validation**

Run:
- `npm --prefix desktop run typecheck`

Expected: no new errors from the migration; if unrelated pre-existing failures remain, document them.

**Step 2: Commit**

```bash
git add desktop/src/components/panes/AppSurfacePane.tsx desktop/src/components/panes/AppSurfacePane.test.mjs desktop/electron/main.ts desktop/electron/preload.ts desktop/src/types/electron.d.ts docs/plans/2026-04-01-app-surface-iframe-migration.md
git commit -m "feat: migrate app surfaces to renderer iframes"
```
