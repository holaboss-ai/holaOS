# Desktop Billing Credits Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add read-only hosted billing visibility to `holaOS/desktop`, including a top-bar credits badge, an account-level plan and credits summary, low-balance warnings in chat, and web-only billing actions.

**Architecture:** Keep all hosted billing and quota reads inside Electron main so Better Auth cookies and environment-specific URLs stay in the trusted process. Expose a small desktop-focused billing IPC surface to the renderer, then build a single renderer hook and two UI components (`CreditsPill`, `BillingSummaryCard`) that consume that normalized shape. Billing mutations and management remain web-only: desktop may open billing URLs in the browser, but never performs Stripe or subscription management locally.

**Tech Stack:** Electron IPC, React 19, TypeScript, Better Auth session cookies, existing hosted control-plane APIs, Node test runner, `tsc`.

### Task 1: Add Desktop Billing IPC In Electron Main

**Files:**
- Modify: `holaOS/desktop/electron/main.ts`
- Modify: `holaOS/desktop/electron/preload.ts`
- Modify: `holaOS/desktop/src/types/electron.d.ts`
- Test: `holaOS/desktop/electron/settings-pane-routing.test.mjs`
- Create: `holaOS/desktop/electron/billing-ipc.test.mjs`

**Step 1: Write the failing test**

Add a new test file `holaOS/desktop/electron/billing-ipc.test.mjs` that checks the source of `main.ts` for:
- registered handlers for `billing:getOverview`, `billing:getUsage`, and `billing:getLinks`
- a helper that performs authenticated hosted fetches using Better Auth cookie headers
- a web-only link policy for add-credits, billing portal, and usage routes

Example assertions:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("desktop billing IPC handlers are registered", async () => {
  const source = await readFile(MAIN_PATH, "utf8");
  assert.match(source, /handleTrustedIpc\("billing:getOverview"/);
  assert.match(source, /handleTrustedIpc\("billing:getUsage"/);
  assert.match(source, /handleTrustedIpc\("billing:getLinks"/);
});
```

**Step 2: Run test to verify it fails**

Run: `node --test desktop/electron/billing-ipc.test.mjs`

Expected: FAIL because the new handlers and helpers do not exist yet.

**Step 3: Write minimal implementation**

In `holaOS/desktop/electron/main.ts`:
- add a `billingFetch<T>()` helper similar to `composioFetch<T>()`
- authenticate hosted requests with `authCookieHeader()`
- normalize a desktop-specific overview payload
- derive web links from hosted base URLs instead of hardcoding them in renderer
- register trusted IPC handlers:
  - `billing:getOverview`
  - `billing:getUsage`
  - `billing:getLinks`

In `holaOS/desktop/electron/preload.ts`:
- expose `window.electronAPI.billing.getOverview()`
- expose `window.electronAPI.billing.getUsage()`
- expose `window.electronAPI.billing.getLinks()`

In `holaOS/desktop/src/types/electron.d.ts`:
- add payload types for overview, usage, and links
- extend the `ElectronAPI` type with the new `billing` namespace

Normalize the main-process output to a renderer-safe shape:

```ts
interface DesktopBillingOverviewPayload {
  isManagedBillingUser: boolean;
  planName: string | null;
  planStatus: "active" | "trialing" | "past_due" | "canceled" | "inactive";
  renewsAt: string | null;
  expiresAt: string | null;
  creditsBalance: number;
  monthlyCreditsIncluded: number;
  monthlyCreditsUsed: number;
  dailyRefreshCredits: number | null;
  dailyRefreshTarget: number | null;
  lowBalanceThreshold: number;
  isLowBalance: boolean;
}
```

**Step 4: Run test to verify it passes**

Run: `node --test desktop/electron/billing-ipc.test.mjs`

Expected: PASS

**Step 5: Commit**

```bash
git -C holaOS add desktop/electron/main.ts desktop/electron/preload.ts desktop/src/types/electron.d.ts desktop/electron/billing-ipc.test.mjs
git -C holaOS commit -m "feat: add desktop billing ipc bridge"
```

### Task 2: Add A Shared Renderer Billing Hook

**Files:**
- Create: `holaOS/desktop/src/lib/billing/useDesktopBilling.ts`
- Test: `holaOS/desktop/src/lib/billing/useDesktopBilling.test.mjs`

**Step 1: Write the failing test**

Create `holaOS/desktop/src/lib/billing/useDesktopBilling.test.mjs` to assert the hook source:
- calls `window.electronAPI.billing.getOverview`
- calls `window.electronAPI.billing.getUsage`
- derives `isOutOfCredits` from `creditsBalance <= 0`
- exposes a `refresh` method

**Step 2: Run test to verify it fails**

Run: `node --test desktop/src/lib/billing/useDesktopBilling.test.mjs`

Expected: FAIL because the hook file does not exist yet.

**Step 3: Write minimal implementation**

Create `holaOS/desktop/src/lib/billing/useDesktopBilling.ts`:
- fetch overview and usage on mount
- expose `isLoading`, `error`, `overview`, `usage`, `links`, and `refresh`
- derive:
  - `isManagedBillingUser`
  - `isLowBalance`
  - `isOutOfCredits`
- keep the hook read-only; no Stripe or mutation logic here

Suggested return shape:

```ts
return {
  isLoading,
  error,
  overview,
  usage,
  links,
  isManagedBillingUser,
  isLowBalance,
  isOutOfCredits,
  refresh,
};
```

**Step 4: Run test to verify it passes**

Run: `node --test desktop/src/lib/billing/useDesktopBilling.test.mjs`

Expected: PASS

**Step 5: Commit**

```bash
git -C holaOS add desktop/src/lib/billing/useDesktopBilling.ts desktop/src/lib/billing/useDesktopBilling.test.mjs
git -C holaOS commit -m "feat: add desktop billing renderer hook"
```

### Task 3: Add The Top-Bar Credits Pill

**Files:**
- Create: `holaOS/desktop/src/components/billing/CreditsPill.tsx`
- Modify: `holaOS/desktop/src/components/layout/TopTabsBar.tsx`
- Modify: `holaOS/desktop/src/components/layout/AppShell.tsx`
- Test: `holaOS/desktop/src/components/layout/TopTabsBar.test.mjs`

**Step 1: Write the failing test**

Create `holaOS/desktop/src/components/layout/TopTabsBar.test.mjs` to assert:
- `TopTabsBar.tsx` renders a credits pill before the account trigger
- the credits pill is hidden when the user is not in managed billing mode
- clicking the pill routes to account settings

**Step 2: Run test to verify it fails**

Run: `node --test desktop/src/components/layout/TopTabsBar.test.mjs`

Expected: FAIL because the badge and account routing do not exist yet.

**Step 3: Write minimal implementation**

Create `holaOS/desktop/src/components/billing/CreditsPill.tsx`:
- render a rounded capsule with a sparkles-style icon and balance number
- support states: `loading`, `normal`, `low`, `empty`
- accept `onClick`

Modify `TopTabsBar.tsx`:
- consume `useDesktopBilling()`
- render `CreditsPill` immediately to the left of the user dropdown trigger
- show only when `isManagedBillingUser` is true

Modify `AppShell.tsx`:
- allow `TopTabsBar` to open account settings pre-focused on billing summary
- preserve the existing account/settings behavior

**Step 4: Run test to verify it passes**

Run: `node --test desktop/src/components/layout/TopTabsBar.test.mjs`

Expected: PASS

**Step 5: Commit**

```bash
git -C holaOS add desktop/src/components/billing/CreditsPill.tsx desktop/src/components/layout/TopTabsBar.tsx desktop/src/components/layout/AppShell.tsx desktop/src/components/layout/TopTabsBar.test.mjs
git -C holaOS commit -m "feat: add desktop credits pill to top bar"
```

### Task 4: Add A Read-Only Account Billing Summary Card

**Files:**
- Create: `holaOS/desktop/src/components/billing/BillingSummaryCard.tsx`
- Modify: `holaOS/desktop/src/components/auth/AuthPanel.tsx`
- Modify: `holaOS/desktop/src/components/layout/SettingsDialog.tsx`
- Test: `holaOS/desktop/src/components/layout/SettingsDialog.test.mjs`

**Step 1: Write the failing test**

Extend `holaOS/desktop/src/components/layout/SettingsDialog.test.mjs` so it asserts:
- account section still renders `AuthPanel`
- `AuthPanel` includes a billing summary card
- billing summary includes web-only actions such as `Add credits`, `Manage on web`, and `View usage`

**Step 2: Run test to verify it fails**

Run: `node --test desktop/src/components/layout/SettingsDialog.test.mjs`

Expected: FAIL because the billing summary card and CTAs do not exist.

**Step 3: Write minimal implementation**

Create `holaOS/desktop/src/components/billing/BillingSummaryCard.tsx`:
- show plan name and renewal or expiry line
- show main credits number
- show monthly credits included and used
- optionally show daily refresh credits when present
- show latest usage rows if usage exists
- add buttons:
  - `Add credits`
  - `Manage on web`
  - `View usage`
- every button must call `window.electronAPI.ui.openExternalUrl(...)`

Modify `AuthPanel.tsx`:
- consume `useDesktopBilling()`
- render `BillingSummaryCard` under the account status area
- keep this card read-only
- render a local-provider note when billing does not apply

Modify `SettingsDialog.tsx` only if needed for spacing or section focus behavior.

**Step 4: Run test to verify it passes**

Run: `node --test desktop/src/components/layout/SettingsDialog.test.mjs`

Expected: PASS

**Step 5: Commit**

```bash
git -C holaOS add desktop/src/components/billing/BillingSummaryCard.tsx desktop/src/components/auth/AuthPanel.tsx desktop/src/components/layout/SettingsDialog.tsx desktop/src/components/layout/SettingsDialog.test.mjs
git -C holaOS commit -m "feat: add read-only desktop billing summary"
```

### Task 5: Add Low-Balance Warning And Out-Of-Credits Guard In Chat

**Files:**
- Modify: `holaOS/desktop/src/components/panes/ChatPane.tsx`
- Test: `holaOS/desktop/src/components/panes/ChatPane.test.mjs`

**Step 1: Write the failing test**

Extend `holaOS/desktop/src/components/panes/ChatPane.test.mjs` so it asserts source contains:
- low-balance warning copy for managed usage
- out-of-credits guard copy
- web-only CTA labels such as `Add credits` and `Manage on web`

**Step 2: Run test to verify it fails**

Run: `node --test desktop/src/components/panes/ChatPane.test.mjs`

Expected: FAIL because chat does not yet reference billing guardrails.

**Step 3: Write minimal implementation**

Modify `ChatPane.tsx`:
- consume `useDesktopBilling()`
- before queueing a managed session input, call `refresh()`
- if `isOutOfCredits`, block send and show inline CTA state
- if `isLowBalance`, show warning banner but allow send
- do not apply this logic to local-provider sessions

Required behavior:
- local providers remain unaffected
- managed mode warns when low
- managed mode blocks only when balance is exhausted
- all recovery actions open web URLs

**Step 4: Run test to verify it passes**

Run: `node --test desktop/src/components/panes/ChatPane.test.mjs`

Expected: PASS

**Step 5: Commit**

```bash
git -C holaOS add desktop/src/components/panes/ChatPane.tsx desktop/src/components/panes/ChatPane.test.mjs
git -C holaOS commit -m "feat: add desktop low-credit chat guardrails"
```

### Task 6: End-To-End Verification

**Files:**
- Modify: `holaOS/docs/plans/2026-04-02-desktop-billing-credits-implementation-plan.md`

**Step 1: Run desktop source tests**

Run: `node --test desktop/electron/billing-ipc.test.mjs desktop/electron/settings-pane-routing.test.mjs desktop/src/lib/billing/useDesktopBilling.test.mjs desktop/src/components/layout/TopTabsBar.test.mjs desktop/src/components/layout/SettingsDialog.test.mjs desktop/src/components/panes/ChatPane.test.mjs`

Expected: PASS

**Step 2: Run typecheck**

Run: `npm run typecheck`

Workdir: `holaOS/desktop`

Expected: PASS

**Step 3: Smoke the desktop build**

Run: `npm run build`

Workdir: `holaOS/desktop`

Expected: PASS

**Step 4: Manual verification**

Verify:
- top bar shows credits pill only for managed hosted mode
- clicking credits pill opens account settings
- account card shows plan and credits as read-only
- add/manage/view buttons open browser, not in-app payment UI
- low balance warns in chat
- zero balance blocks managed send and offers web CTAs
- local-provider mode does not show hosted billing gatekeeping

**Step 5: Commit**

```bash
git -C holaOS add desktop/src/components/billing desktop/src/components/layout desktop/src/components/auth desktop/src/components/panes desktop/src/lib/billing desktop/electron desktop/src/types/electron.d.ts docs/plans/2026-04-02-desktop-billing-credits-implementation-plan.md
git -C holaOS commit -m "feat: add read-only desktop billing visibility"
```
