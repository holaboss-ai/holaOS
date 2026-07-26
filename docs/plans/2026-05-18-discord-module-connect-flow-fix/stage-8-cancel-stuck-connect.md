# Stage 8 — Cancel a stuck Connect spinner

> Reported: user clicked Connect Discord Bot, rejected the authorization
> in the browser OAuth window, but the button stayed in "Connecting..."
> indefinitely.

## Root cause

`connectIntegrationProvider` (`workspaceDesktop.tsx:1108`) polls
Composio's `composioAccountStatus` every 3s for up to 100 ticks (= 5
minutes) waiting for `status === "ACTIVE"`. The early-exit branch
covers `FAILED / EXPIRED / INACTIVE` but **not the case where the user
rejects/closes the OAuth tab without Composio ever transitioning the
account to a terminal status**. In that case the account stays
`INITIATED` and the poll loop spins for the full 5-minute timeout.

The Stage 7 hook (`useIntegrationBinding`) already handled errors and
the internal `IntegrationConnectCancelled` sentinel, but had no public
`cancel()` action — so the UI had no way to abort early either.

## Fix

### Hook (`desktop/src/lib/useIntegrationBinding.ts`)

- New `cancel()` action on the return type.
- `AbortController` per `connect()` call, tracked in a ref. Each new
  `connect()` aborts the previous controller (so re-clicking Connect
  doesn't leak two parallel poll loops).
- `connect()` passes `signal: controller.signal` into
  `connectIntegrationProvider` — the existing `throwIfAborted` checks
  along the poll loop fire on the next tick (≤3s).
- `connect()`'s catch silences both `controller.signal.aborted` and
  `Error.name === "IntegrationConnectCancelled"` (the workspaceDesktop
  internal sentinel) so cancellation doesn't render an error banner.
- Unmount effect aborts any in-flight controller so a poll loop never
  outlives the surface that started it.

### UI

Both consumers swap the Connect button to a clickable Cancel while
`busy === "connecting"`:

- `IntegrationConnectCard` (chat) — no_connection branch. The
  "Waiting for authorization…" text stays as inline status; the
  primary button becomes "Cancel" with an `X` icon.
- `AppSurfacePane` (App Surface header) — the no-candidates Connect
  button becomes a Cancel button with the spinner as its leading icon,
  keyed off `bindingBusyState === "connecting"`.

The dropdown bind/needs_binding paths already disable the inner items
via `busy`, so the only stuck-spinner surface that needed Cancel
explicitly is the OAuth-bootstrap one — the only one where the
underlying `connectIntegrationProvider` poll is the long-running call.

## Files changed

- `holaOS/desktop/src/lib/useIntegrationBinding.ts` — `cancel` action,
  AbortController plumbing, unmount-safe.
- `holaOS/desktop/src/components/panes/ChatPane/AssistantTurn/IntegrationConnectCard.tsx` —
  no_connection button swap.
- `holaOS/desktop/src/components/panes/AppSurfacePane.tsx` — header
  Connect button swap.

## Verification

1. Build / restart desktop.
2. Click Connect <toolkit> on the App Surface (or in the chat card).
3. In the OAuth browser tab: reject (Discord's "Cancel") or just close
   the tab without granting.
4. The desktop button immediately shows "Cancel" with a spinner.
5. Click it. The button returns to "Connect <toolkit>" within ≤3s
   (next poll tick of the underlying poll loop, which then throws
   `IntegrationConnectCancelled` and unwinds). No error banner.
6. Click Connect again — the next attempt aborts any zombie controller
   from the previous call before opening a fresh OAuth window.

## Why not auto-cancel via window-focus heuristic

A "user returned to desktop window while OAuth still pending" signal
would let us cancel without an explicit click, but it mis-fires when
the user alt-tabs to look up a password manager or read notes during
the OAuth flow. The Cancel button is deterministic and discoverable;
the focus heuristic stays out of scope as long as the manual control
exists.
