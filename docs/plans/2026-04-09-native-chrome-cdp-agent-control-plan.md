# Native Chrome CDP Agent Control Plan

## Goal

Enable the agent to control a real locally installed Chrome browser through Chrome DevTools Protocol (CDP), while preserving the existing agent-facing `browser_*` tool surface as much as possible.

## Current State

The existing browser capability is already split into three layers:

- Harness tool definitions in `runtime/harnesses/src/desktop-browser-tools.ts`
- Runtime capability proxy routes in `runtime/api-server/src/app.ts`
- Desktop fulfillment in `desktop/electron/main.ts`

Today, the desktop layer does not control native Chrome. It controls an Electron `BrowserView` and exposes that through the local browser service.

This means:

- the agent already has a stable tool contract
- the runtime already has a stable capability API
- the main gap is the Electron-side executor/backend

## Current Architecture Notes

### Agent and runtime surface

The current tool contract already covers the main operations needed for browser control:

- `browser_navigate`
- `browser_open_tab`
- `browser_get_state`
- `browser_click`
- `browser_type`
- `browser_press`
- `browser_scroll`
- `browser_back`
- `browser_forward`
- `browser_reload`
- `browser_screenshot`
- `browser_list_tabs`

That surface is defined in `runtime/harnesses/src/desktop-browser-tools.ts`.

The runtime exposes the browser capability at:

- `GET /api/v1/capabilities/browser`
- `POST /api/v1/capabilities/browser/tools/:toolId`

That proxy surface lives in `runtime/api-server/src/app.ts`.

### Desktop implementation today

The desktop app currently:

- creates per-workspace browser state in Electron
- uses `session.fromPartition(...)` for workspace isolation
- creates `BrowserView` tabs
- drives navigation and interaction through Electron `webContents`
- exposes a local authenticated HTTP service at `/api/v1/browser/*`

The implementation is centered in `desktop/electron/main.ts`.

## Gap To Native Chrome Over CDP

The current browser service is tied directly to Electron primitives:

- page reads come from Electron `webContents`
- evaluation uses `executeJavaScript`
- screenshots use `capturePage`
- tabs are Electron `BrowserView` instances
- the Browser pane UI sizes and attaches a native embedded view

Because of that, the current implementation is not a thin browser abstraction. It is specifically an Electron embedded-browser implementation.

To support native Chrome via CDP, we need a new desktop backend that preserves the existing browser service contract while swapping out the execution layer.

## Recommended Scope

Start with an agent-only managed Chrome backend.

That means:

- keep the existing `browser_*` tool contract
- keep the runtime capability routes unchanged
- replace or extend the Electron browser service backend
- do not make native Chrome the first implementation of the visible in-app Browser pane

This is the smallest path that delivers real Chrome control without turning the Browser pane into a separate product redesign.

## Recommended Technical Approach

### 1. Introduce a browser backend abstraction in Electron

Create an internal backend interface for the desktop browser service, with operations for:

- workspace initialization
- tab creation
- active tab lookup
- navigation
- evaluation
- screenshot
- history navigation
- tab listing
- lifecycle and cleanup

One implementation can remain the current Electron embedded browser backend.

A second implementation should target native Chrome over CDP.

### 2. Use Playwright CDP connection for the native Chrome backend

Use Playwright's Chromium CDP connection support to attach to an existing or managed Chrome instance.

Recommended path:

- launch Chrome from Electron main with `--remote-debugging-port=<port>`
- assign a dedicated `--user-data-dir=<workspace-specific-dir>`
- connect through `chromium.connectOverCDP(...)`
- use Playwright page/context objects for the common flow
- use CDP sessions for lower-level cases when needed

This keeps the implementation practical while still giving direct CDP access where Playwright's higher-level APIs are not enough.

## Required Work

### Desktop main process

Add a native Chrome/CDP manager in `desktop/electron/main.ts` or a new Electron module that handles:

- Chrome executable discovery per platform
- port allocation for remote debugging
- process spawn and shutdown
- endpoint readiness checks
- reconnect logic
- browser/page/target bookkeeping

### Workspace isolation

Rebuild workspace isolation for Chrome.

Today, workspace isolation uses Electron session partitions. For native Chrome, the equivalent should be a managed Chrome profile per workspace, typically a dedicated `user-data-dir` per workspace.

This is required so that:

- cookies stay isolated per workspace
- local storage stays isolated per workspace
- service workers and site data stay isolated per workspace
- workspace restore behavior stays consistent

Reusing the user's default Chrome profile is the wrong default for this feature.

### Tab and page model

The current persisted browser state stores tab ids, URLs, titles, bookmarks, downloads, and history.

For native Chrome, we need to map that to CDP/Playwright concepts:

- workspace -> managed Chrome profile or managed browser instance
- tab -> page/target id
- active tab -> selected page id in workspace state
- open tab -> create a new page
- popup/new-window -> intercept and normalize into workspace tab state

Restore logic should reopen previously persisted tabs when a workspace is reactivated.

### Tool execution mapping

Map the existing browser tools onto the Chrome backend:

- `browser_navigate` -> `page.goto(...)`
- `browser_open_tab` -> create page and optionally select it
- `browser_get_state` -> evaluate DOM extraction script on the active page
- `browser_click` -> either keep the DOM-index approach or move to locator-backed actions behind the same tool interface
- `browser_type` -> fill/type into the matched element
- `browser_press` -> keyboard press on the active page
- `browser_scroll` -> evaluate scroll or wheel input
- `browser_back` / `browser_forward` / `browser_reload` -> page navigation helpers
- `browser_screenshot` -> page screenshot
- `browser_list_tabs` -> derive from managed page list

The existing DOM-first extraction logic in `runtime/api-server/src/desktop-browser-tools.ts` can remain the same at first.

### Browser pane separation

The current Browser pane is explicitly built around an embedded native view controlled through bounds sync.

That means native Chrome cannot be dropped in as a direct replacement without redesigning the pane behavior.

So the first implementation should separate:

- agent browser backend
- visible Browser pane backend

The visible pane can continue using Electron `BrowserView` until there is a separate UX decision to replace it.

## Config Changes

The current runtime config only tracks a single desktop browser capability URL/token pair.

We likely need extra configuration for the new backend, for example:

- backend type: `electron_embedded` or `native_chrome_cdp`
- Chrome executable path override
- remote debugging host/port settings
- workspace Chrome data root
- whether to launch a managed Chrome instance or attach to an existing one

## Packaging Changes

If Electron main uses Playwright for production CDP control, it must be available at runtime.

Today, `playwright` is only a desktop `devDependency`.

That means at minimum we need to:

- move the required client package into a runtime dependency or bundle it explicitly
- verify the Electron packaging path still works with `asar`
- ensure the packaged desktop app can still resolve any runtime files needed by the chosen CDP client

## Testing Requirements

### Unit and integration

Add tests for:

- Chrome executable resolution
- Chrome process launch and shutdown
- endpoint readiness failure paths
- workspace profile isolation
- tab persistence and restore
- service auth and routing behavior

### End-to-end

Extend the current desktop browser e2e coverage to validate native Chrome behavior:

- workspace A and workspace B isolation
- local storage isolation
- tab restore across relaunch
- agent tool calls routed into the native Chrome backend
- popup normalization into tabs

## Non-goals For Phase 1

- do not replace the visible Browser pane with external Chrome
- do not attach to the user's default everyday Chrome profile by default
- do not redesign the agent tool contract unless the backend proves it is necessary
- do not block on advanced CDP-only features before basic navigation and DOM interaction work

## Suggested Rollout

### Phase 1

- introduce backend abstraction
- add managed native Chrome backend behind a feature flag
- keep existing browser tools unchanged
- support navigation, tab open, state read, click, type, press, scroll, screenshot

### Phase 2

- harden restore behavior
- improve popup/download/history handling
- improve reconnect and crash recovery

### Phase 3

- decide whether the user-facing Browser pane should stay embedded or gain a separate native-Chrome mode

## Recommended Default Decision

The default implementation direction should be:

- managed Chrome launched by Holaboss
- one isolated Chrome profile per workspace
- agent-only usage first
- existing Browser pane unchanged in phase 1

This gives the agent real Chrome control with the smallest architectural blast radius.

## Relevant Files

- `runtime/harnesses/src/desktop-browser-tools.ts`
- `runtime/api-server/src/app.ts`
- `runtime/api-server/src/desktop-browser-tools.ts`
- `runtime/api-server/src/runtime-config.ts`
- `desktop/electron/main.ts`
- `desktop/src/components/panes/BrowserPane.tsx`
- `desktop/e2e/browser-workspace-isolation.test.mjs`
- `desktop/package.json`

## External References

- Playwright `connectOverCDP` docs:
  - https://github.com/microsoft/playwright/blob/v1.58.2/docs/src/api/class-browsertype.md
- Playwright browser CDP session docs:
  - https://github.com/microsoft/playwright/blob/v1.58.2/docs/src/api/class-browser.md
- Chrome remote debugging launch examples:
  - https://developer.chrome.com/docs/devtools/remote-debugging/local-server/
