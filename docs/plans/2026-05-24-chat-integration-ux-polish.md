# Chat & Integration UX Polish — 2026-05-24

Owner: Joshua
Status: In progress
Worktree: `/Users/joshua/holaboss-ai/holaboss/holaOS-ux-polish` on branch `feat/chat-integration-ux-polish`, forked from `feat/integration-store-unified@275e8d45` (clean HEAD, before in-progress merge)

## Context

This plan replaces an earlier proposal to migrate Composio integrations from MCP tools to direct function calls. PM-side review concluded:

- Past "connected toolkit not immediately usable" pain has already been fixed by `composioMcpManager.restart()` plumbing — no more user-facing pull.
- Billing flow through Hono is structurally correct; no architectural change needed.
- The single sliver of value from the MCP→native migration that users would feel is **structured error transit from Composio → chat UI**. Carved out as a one-shot prep task here.
- All other engineering wins (LOC reduction, token savings, latency) are not user-visible. Opportunity cost > value.

Decision: keep the MCP-based Composio plumbing. Invest 4.5 weeks into chat output polish (Surface A) and integration connect-flow polish (Surface B) — the two areas users actually touch every day.

## Goals

1. **Connect flow stops feeling abandoned.** Every OAuth wait, error, and recovery path has a clear visual + action affordance.
2. **Tool failures are actionable in chat.** Composio's structured errors reach the user as readable text + a one-click fix.
3. **Agent output has presence.** Drafts, artifacts, and tool completions land as something the user wants to keep, not log entries.
4. **Integration list looks loaded.** No flicker, no broken logos, no abandoned states.

## Non-goals

- MCP → native Composio migration (deferred indefinitely; revisit only if token cost becomes a P0).
- In-turn dynamic tool expansion (not a user request; pre-registration at workspace boot continues to work).
- Adding new Composio toolkits / integrations (separate roadmap).
- Backend / runtime architecture changes beyond the error transit prep.

---

## Phase 0 — Prep (½ day, ships before Week 2)

### Composio error transit (prep, dependency for Week 2)

**Files touched:**
- `runtime/api-server/src/composio-mcp-host.ts` — change error-mapping logic when `ComposioService.executeTool` returns `{ ok: false, error }`.
- `runtime/api-server/src/composio-service.ts` — confirm we already surface `{ code, message, log_id, slug? }` from Hono.

**Change:** Today, when `ComposioService.executeTool` rejects, the MCP host wraps the error into a generic `internal_error` code on the MCP response. Instead:

- If the Composio error code is `tool_failed`, `connection_expired`, `connection_not_authorized`, `rate_limited`, `not_configured`, or `not_found`: surface as MCP `isError: true` tool result with a JSON `content` block containing `{ code, message, log_id, slug, retriable }`. This makes the structured error flow into pi's tool_result and from there into the chat's TraceStepGroup as legible data.
- Add a unit test in `composio-mcp-host.test.ts` covering the three highest-frequency codes (`tool_failed`, `connection_expired`, `rate_limited`).

**Acceptance:** When Composio returns a 401, the chat UI receives `code: "connection_expired"` and renders the right banner; the raw error string is preserved in `data.message` for "Show technical details" disclosure.

**Risk note:** Error semantics that downstream consumers already pattern-match against (the IntegrationErrorBanner regexes) MUST keep working. Verify by snapshotting the current `details` string for the top 5 patterns before the change.

---

## Week 1 — Connect flow has sound (5 working days)

### W1.1 — Unified Cancel affordance (1 day)

**Files:**
- `apps/desktop/src/components/panes/ChatPane/AssistantTurn/IntegrationProposalCard.tsx`
- `apps/desktop/src/lib/workspaceDesktop.tsx` (the `connectIntegrationProvider` polling loop)

**Change:**
- Add `cancel()` to the polling loop's return value: an `AbortController` whose `.abort()` rejects the poll promise with `code: "user_cancelled"`.
- Surface a Cancel link/button in IntegrationProposalCard's `connecting` phase, with the same visual style as IntegrationConnectCard's Cancel.
- On cancel: clear `phase`, hide the spinner, show no error (silent return to idle, with a faint "Connect" CTA again).

**Acceptance:** From IntegrationProposalCard, the user can press Cancel during the OAuth wait and immediately return to idle. No "Connection failed" toast on cancel.

### W1.2 — OAuth wait countdown + helper text (1.5 days)

**Files:**
- `apps/desktop/src/components/panes/ChatPane/AssistantTurn/IntegrationProposalCard.tsx`
- `apps/desktop/src/components/panes/ChatPane/AssistantTurn/IntegrationConnectCard.tsx`
- A new shared subcomponent `OAuthWaitIndicator.tsx` under `AssistantTurn/` (or `components/integration/`).

**Change:**
- OAuthWaitIndicator shows: spinner, "Waiting for {provider} authorization…", a thin progress bar fed by elapsed/total seconds (5 min hard cap = 300s), and a muted countdown ("4:32 left").
- After 30 elapsed seconds, fade in a helper line: "If the window didn't open, try reopening it" with a "Reopen" CTA that recalls the same OAuth URL.
- After 90s with no progress, dim the spinner and surface "Still waiting — try Cancel and reconnect" as a softer escalation.

**Acceptance:** Visual reads as alive at all times; user never feels stranded.

### W1.3 — Detect closed OAuth window (0.5 day)

**Files:**
- `apps/desktop/src/lib/workspaceDesktop.tsx` — extend the poll loop with `window.addEventListener('focus', …)` heuristic: if focus returns to the app AND no connection has appeared after 4 more seconds, prompt "Did the authorization complete? If you closed the window without authorizing, click Reopen".

**Acceptance:** Closing OAuth window (without granting) results in inline prompt within ~5s, not a 5-min silent timeout.

### W1.4 — Friendly error copy + Retry (1 day)

**Files:**
- New file `apps/desktop/src/lib/integrationErrorMessages.ts` — pure mapper `(code, slug?) => { headline, detail, action: "retry" | "reconnect" | "contact" }`.
- `IntegrationProposalCard.tsx` + `IntegrationConnectCard.tsx` — consume the mapper; render Retry/Reconnect button bound to the action enum.

**Codes to cover (initial set):**
- `user_cancelled` — silent (no error UI)
- `connection_expired` — "Your {provider} session expired" + Reconnect
- `connection_not_authorized` — "{provider} hasn't been authorized yet" + Reconnect
- `rate_limited` — "{provider} is busy — try again in a minute" + Retry
- `network_error` — "Couldn't reach {provider}" + Retry
- `popup_blocked` — "Allow popups for the desktop app, then click Reopen" + Reopen
- `unknown` — "Something went wrong" + Retry + raw `data.message` in "Show details" disclosure

**Acceptance:** No raw exception strings reach the user. All paths have a Retry/Reconnect/Reopen action.

### W1.5 — Polish + QA (1 day)
- Dark + light mode parity sweep on the three cards.
- Reduced-motion: countdown still works, just no animation on the spinner/progress bar.
- Snapshot tests for the new mapper (`integrationErrorMessages.test.ts`).

**Week 1 ship target:** Behind no flag — these are pure UI improvements that ship together.

---

## Week 2 — Errors become one-click fixes (5 days)

Depends on Phase 0 (Composio error transit).

### W2.1 — Expand IntegrationErrorBanner pattern matching (1.5 days)

**Files:**
- `apps/desktop/src/components/panes/ChatPane/skeletons.tsx` (IntegrationErrorBanner function).
- New `apps/desktop/src/lib/integrationErrorBannerMap.ts` — owns the (code | slug | message-regex) → banner-config map.

**Change:**
- Move pattern matching from inline regexes to the centralized map.
- Add coverage for every toolkit currently in the integration store catalog (cross-ref `integration-store-catalog.ts`).
- Each entry has: icon, headline, detail, action ("reconnect" | "retry" | "open_settings"), and a target connection_id (for inline reconnect).

**Acceptance:** 100% of in-catalog toolkit failures hit a typed banner; only truly unknown errors fall through to "Show technical details".

### W2.2 — Inline Reconnect mini-card (2 days)

**Files:**
- New `apps/desktop/src/components/panes/ChatPane/AssistantTurn/InlineReconnectCard.tsx`.
- Banner action "reconnect" renders the mini-card directly below the failing TraceStepGroup.
- Reuses the Week 1 OAuth wait machinery (countdown, cancel, error mapping) via shared OAuthWaitIndicator.

**Acceptance:** Tool fails with `connection_expired` → banner appears → "Reconnect" → OAuth flow inline → on success, prompt "Retry the original tool call" → agent retries automatically (with rate-limit guard).

### W2.3 — Generic tool failure shell (1 day)

**Files:**
- `apps/desktop/src/components/panes/ChatPane/AssistantTurn/TraceStepGroup.tsx`.
- New `apps/desktop/src/components/panes/ChatPane/AssistantTurn/ToolFailureShell.tsx`.

**Change:**
- When `step.status === 'error'` and no IntegrationErrorBanner pattern matches, render ToolFailureShell instead of dumping raw JSON.
- Shell shows: short summary line ("Tool {name} failed"), the error message (truncated to one line, full text under `<details>`), and a "Show technical details" toggle that reveals the original JSON payload.

**Acceptance:** No more raw JSON wall in collapsed step details — even unknown errors look intentional.

### W2.4 — Polish + QA (0.5 day)
- E2E walkthrough: simulate expired-token tool failure in the e2e script; confirm full banner→reconnect→retry path works.

---

## Week 3 — Output has presence (5 days)

### W3.1 — Artifact type taxonomy + plumbing (1.5 days)

**Files:**
- `runtime/state-store/src/store.ts` — verify `artifacts` table already has `type` (or add migration if not).
- `runtime/api-server/src/runtime-agent-tools.ts` — agents emitting artifacts pass `type` (draft_post | draft_email | draft_image | dashboard | report | other).
- `apps/desktop/src/types/electron.d.ts` — surface type in the artifact event.

**Acceptance:** Every new artifact created by an agent carries a typed enum; legacy artifacts default to `other`.

### W3.2 — Artifact card redesign (2 days)

**Files:**
- `apps/desktop/src/components/panes/ChatPane/AssistantTurn/Outputs.tsx`.
- New `apps/desktop/src/components/panes/ChatPane/AssistantTurn/ArtifactCard.tsx` (per-card; replaces the current `<li>`).

**Change:**
- Per-type icon (Lucide: FileText for drafts, Mail for email drafts, Image for image drafts, LayoutDashboard for dashboards, FileBarChart for reports).
- Default title rules: `{type} #{n}` if title missing — "Twitter draft #2", "Email draft #1".
- 1-line preview (first 60 chars of body, or alt text for images).
- Hover state: subtle bg shift + 1px border highlight (no shadow lift per design rules).
- Click → existing ArtifactBrowserModal.

### W3.3 — "Show more" affordance promotion (0.5 day)

**Files:**
- `Outputs.tsx`.

**Change:**
- From xs muted "Show 2 more" → a full-width "+2 more artifacts" button with icon (ChevronDown) and Cmd+Shift+A keyboard hint.
- Threshold remains at 3 for the same reason (avoid wall-of-cards).

### W3.4 — Tool completion micro-animation (0.5 day)

**Files:**
- `apps/desktop/src/components/panes/ChatPane/AssistantTurn/TraceStepGroup.tsx`.
- CSS via Tailwind utility — define `@keyframes draw-check` in the global stylesheet (or use motion library if already installed; lazy-load if not).

**Change:**
- When a step transitions from `running` → `success`, animate the check icon: SVG path stroke-dasharray draw-in over 200ms. Respect `prefers-reduced-motion: reduce`.

### W3.5 — QA (0.5 day)
- Light + dark mode for all artifact types.
- Stress test: 10 artifacts in one turn — collapsed "+7 more" still readable.

**Week 3 designer involvement:** Joshua confirmed designer participation. Specific touchpoints:
- ArtifactCard visual treatment (typography, spacing, hover)
- "Show more" affordance proportion
- Provider logo treatment in Week 4

I (Claude) will land scaffolding code and stub visual choices that conform to the existing design system (OKLch tokens, Inter/Newsreader, shadow scales 0-3). Designer review can refine before merge.

---

## Week 4 — Lists feel loaded (4 days + ½ buffer)

### W4.1 — Skeleton screens (1.5 days)

**Files:**
- New `apps/desktop/src/components/panes/IntegrationsPane.skeleton.tsx`.
- New `apps/desktop/src/components/panes/AddIntegrationDialog.skeleton.tsx`.
- `MarketplacePane.tsx` — skeleton for the "connect_integrations" tab.

**Change:**
- Pulse-bg skeleton rows matching the real row height; render until both `listIntegrationConnections` and the toolkit catalog have resolved.

### W4.2 — Bundle hero logos (1.5 days)

**Files:**
- New dir `apps/desktop/src/assets/integration-logos/` with SVG files for the top 20 toolkits (gmail, twitter, linkedin, reddit, github, slack, notion, hubspot, salesforce, gcal, gdrive, dropbox, figma, asana, jira, intercom, zendesk, stripe, airtable, calendly).
- New `apps/desktop/src/lib/integrationLogo.ts` — `getIntegrationLogo(slug): { src: string; isLocal: boolean }`. Returns the bundled asset if known, falls back to Composio CDN URL otherwise.
- Replace direct `<img src={composioLogoUrl}>` usage in IntegrationsPane, AddIntegrationDialog, IntegrationProposalCard, IntegrationConnectCard, MarketplacePane.

**Acceptance:** Top 20 toolkit logos always render correctly (no white-on-white SVG, no broken aspect ratio); long-tail toolkits still load from CDN.

### W4.3 — Cross-surface state vocabulary audit (1 day)

**Files (audit + fix):**
- IntegrationProposalCard, IntegrationConnectCard, IntegrationsPane row, AddIntegrationDialog entry, MarketplacePane provider row.

**Change:**
- Define the canonical visual vocabulary in `apps/desktop/src/lib/integrationStateStyles.ts`:
  - `idle`: muted secondary, plug icon
  - `loading`: skeleton
  - `connecting`: spinner + countdown + cancel
  - `success`: check icon + green-50 bg (or oklch equivalent) for 2s, then idle
  - `error`: AlertTriangle icon + red-50 bg + Retry CTA
- Apply consistently across all 5 surfaces.

### W4.4 — Buffer + QA + demo (0.5 day)
- End-to-end walkthrough video.
- Update `backend/docs/work_log.md` and `docs/work-log.md` (holaOS-local) with the week's changes.

---

## Acceptance — done when…

- [ ] User can cancel OAuth from any entry point with consistent UI.
- [ ] OAuth wait never feels >30s without visible reassurance.
- [ ] No raw error messages reach the user; all errors have a Retry/Reconnect/Reopen action.
- [ ] Token-expired tool failure → user can reconnect inline → original tool retries automatically.
- [ ] All in-catalog toolkit failures render through IntegrationErrorBanner (no fallback raw JSON for known toolkits).
- [ ] Artifacts have type icons and informative default titles; no "Untitled artifact" in normal flow.
- [ ] Tool-completion has a moment (200ms anim) before transitioning to summary.
- [ ] No skeleton-less list flickers anywhere.
- [ ] Top-20 toolkit logos always render correctly.
- [ ] Light/dark mode parity across all changes; reduced-motion honored.

## Out of scope (explicitly)

- Onboarding redesign (separate roadmap).
- Workspace control center polish.
- Module app UI lint enforcement (already shipped in 8453030d).
- Chat composer / input area redesign.
- Memory pane / artifact browser modal redesign.

## Open questions / dependencies

- **Q1**: Designer can review ArtifactCard mocks before W3.2 implementation? Plan assumes yes.
- **Q2**: Will the in-progress merge on `feat/integration-store-unified` change IntegrationProposalCard's prop shape? If so, this branch needs a rebase before W1 lands. Mitigation: keep changes small and well-named so rebase is mechanical.
- **Q3**: Composio webhook handler (`composio.ts:1799`) already invalidates session caches on `connection_expired`. Confirm that path triggers the runtime's `composioMcpManager.restart` (or the chat just sees the next tool call fail). Affects whether W2.2 needs to subscribe to webhook events for proactive reconnect prompts. (Default: out of scope for this plan; reactive flow is enough.)

## Rebase strategy

`feat/integration-store-unified` is mid-merge. This branch is forked from clean HEAD 275e8d45. When the merge completes and lands on main:
1. `git fetch origin main`
2. `git rebase origin/main` on this branch
3. Conflicts will concentrate in IntegrationProposalCard and related ChatPane files — resolve preserving the UX work here (cancel button, countdown, error mapping) and the merge work there (whatever the integration-store-unified team added).
4. Re-run lint + tests in worktree before pushing.
