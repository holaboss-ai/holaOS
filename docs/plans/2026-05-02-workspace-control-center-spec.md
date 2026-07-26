# Workspace Control Center Spec

## Goal

Change desktop app launch behavior so the user enters a workspace control center instead of dropping directly into the currently selected workspace. The control center should feel like a calm gallery of agent computers, while still allowing direct conversation with each workspace from the launch surface.

## Product Intent

- Make the app feel like a control center for multiple agent computers.
- Keep workspace chat as the primary interaction model.
- Preserve the existing workspace shell and main-session runtime model.
- Avoid adding a second conversation model or alternate session type.

## Launch And Navigation

- On every desktop app launch, open the control center first.
- The control center is a top-level shell mode beside the existing workspace shell.
- Users can enter any workspace from a card and land in the main chat pane.
- Users can return to the control center from the workspace shell at any time.
- New workspace creation bypasses the control center and lands directly in onboarding chat for that workspace.
- Runtime notifications, task proposal deep links, and similar direct-open flows bypass the control center and open the targeted workspace shell immediately.

## Card Model

Each card represents exactly one workspace and exactly one session:

- Workspace: a single workspace record.
- Session: that workspace's main session only.

Cards do not surface subagent, cronjob, or task-proposal sessions as the primary conversation thread.

## Card Content

Each workspace card should show:

- Workspace name
- Main session status
- Scrollable mini chat pane
- Inline composer for direct prompts
- Enter workspace action

Nice-to-have metadata in the prototype:

- Missing workspace folder warning
- Live run indicator
- Last activity timestamp

## Card Behavior

- The mini chat pane renders recent messages from the workspace main session.
- The pane is independently scrollable inside the card.
- Sending a message from the inline composer keeps the user in the control center.
- Replies stream into the same card while the user remains on the control center.
- Enter workspace is explicit and separate from the inline composer flow.

## Sorting

- Cards are ordered by recency.
- Recency is based on the main session's latest meaningful activity timestamp.
- When main-session data is not yet loaded, fall back to workspace `updated_at` and then `created_at`.

## Runtime Behavior

- Workspaces continue running while the user is on the control center.
- Active main-session runs should remain visible from the card surface.
- The control center should attach to existing in-flight main-session runs when possible.
- The prototype may use lightweight per-card runtime polling as a safety fallback even when stream events are attached.

## Visual Direction

- Calm, gallery-like surface rather than a dense operations dashboard.
- Spacious layout with soft separation between cards.
- Emphasis on quiet awareness instead of hard-alert chrome.
- The card should feel like a small window into a live workspace machine.

## Prototype Scope

The first prototype should include:

- New top-level `control_center` shell mode
- Title bar affordance to return to the control center
- Workspace grid surface
- Per-card recent main-session preview
- Per-card inline composer
- Per-card enter workspace action
- Per-card live busy/queued state
- Stream-driven assistant preview updates for active runs where feasible

The first prototype does not need:

- Rich markdown parity with the full chat pane
- Attachments from the card composer
- Multi-input queue editing on cards
- Subagent session surfacing in cards
- Virtualized card grids
- A fully shared chat state store between the control center and full chat pane

## Implementation Notes

- Reuse `ensureMainSession`, `getSessionHistory`, `listRuntimeStates`, `queueSessionInput`, and `openSessionOutputStream`.
- Keep the existing workspace shell intact and treat the control center as a new wrapper mode, not a replacement architecture.
- Prefer a thin preview renderer for cards instead of embedding `ChatPane`.
- Preserve current onboarding, notifications, and workspace creation flows unless they explicitly need to bypass the control center.
