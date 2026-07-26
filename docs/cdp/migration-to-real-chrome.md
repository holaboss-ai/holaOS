# Migrating browser automation from embedded Electron to real Chrome

This is the playbook for swapping the browser automation backend from the
embedded `BrowserView` (in-process Chromium via Electron) to a real Chrome
instance launched separately, without rewriting the agent-facing input
layer.

The CDP input layer was built with this migration as the explicit endgame.
Everything below describes **what changes** and **what doesn't** when you
make the swap.

## TL;DR

- The transport boundary is `CdpClient` in
  `apps/desktop/electron/browser-pane/cdp-input.ts`.
- Today there's one implementation:
  `getElectronCdpClient(webContents)` → talks to Chromium via
  `webContents.debugger`.
- To drive real Chrome, add a second implementation —
  `createRemoteCdpClient(wsUrl)` — that tunnels `send()` over the
  WebSocket Chrome exposes when launched with `--remote-debugging-port=N`.
- Every dispatch helper (`cdpDispatchMouseClick`, `cdpDispatchKeyPress`,
  `cdpInsertText`, `cdpClearFocusedTextInput`, …) takes a `CdpClient` and
  doesn't care which backend it talks to. They stay unchanged.
- The HTTP service routes (`http-service.ts`) and main-process helpers
  (`sendBrowserKeyPress` / `clearFocusedBrowserTextInput`) currently
  resolve the client by calling `getElectronCdpClient(webContents)`. The
  swap is: hand them a `CdpClient` instead of a `WebContents` (or have
  them call a different factory). One ~5-line change per call site.

## What stays the same

| Component | Owner | Survives the swap? |
| --- | --- | --- |
| `CdpClient` interface | `cdp-input.ts` | Yes — defines the contract |
| All dispatch helpers (`cdpDispatch*`, `cdpInsertText`, `cdpClearFocusedTextInput`) | `cdp-input.ts` | Yes — transport-agnostic |
| Key descriptor table + modifier bitmask | `cdp-input.ts` | Yes — protocol-level shape |
| `sendBrowserKeyPress` / `clearFocusedBrowserTextInput` in `main.ts` | `main.ts` | Signature stays; resolution changes |
| HTTP routes (`/api/v1/browser/{context-click,mouse,keyboard}`) | `http-service.ts` | Yes — only `getElectronCdpClient(...)` swaps for a factory call |
| The agent-facing tool surface (`browser_act`, `browser_press`, …) | runtime/harnesses | Yes — unchanged |
| User-lock + programmatic-input gating | `user-lock.ts` | Yes |
| `withProgrammaticBrowserInput` wrapper | `user-lock.ts` | Yes |

## What changes

| Component | Reason |
| --- | --- |
| `getElectronCdpClient(webContents)` call sites | They need a `CdpClient` for a remote target instead of an Electron `webContents` |
| Tab model (`BrowserTabRecord`) | A "tab" in real Chrome is a CDP Target, not an Electron `BrowserView`. Address by target id, not webContents id |
| Lifecycle: open / close / activate tab | Today: `BrowserView` + `webContents.loadURL` etc. Future: CDP `Target.createTarget`, `Target.closeTarget`, `Target.activateTarget` |
| Screenshots | Today: `webContents.capturePage()`. Future: CDP `Page.captureScreenshot` |
| Navigation, JS eval, observability | Already mostly CDP-friendly. `executeJavaScript` → `Runtime.evaluate`; console / errors / requests → `Runtime.consoleAPICalled`, `Network.*`, `Log.entryAdded` (subscribe via CDP events) |
| `withTemporarilyRenderedBrowserTab` | No analog in real Chrome — every CDP target is "always rendered" enough for input/eval. Replace with a thin no-op shim, or drop callers' awareness of it |
| The shared agent input host window (`ensureSharedAgentInputHostWindow` in `tab-state.ts`) | Dead code already; delete during migration |
| `mainWindow.focus()` / `BrowserView.show()` / `host.focus()` | Already gone for input; will be irrelevant entirely in remote Chrome |

## Step-by-step

### 1. Add a remote CDP client backend

Create `apps/desktop/electron/browser-pane/cdp-input-remote.ts` (or
similar) exporting:

```ts
export function createRemoteCdpClient(opts: {
  /** Per-page WebSocket URL — `ws://host:port/devtools/page/<targetId>`. */
  webSocketDebuggerUrl: string;
}): CdpClient;
```

It opens a single WebSocket, multiplexes request/response by an
auto-incrementing `id` field, and implements the same `send` /
`attach` / `detach` / `isAttached` shape. Keep it dependency-free if you
can (use `ws` or `undici`'s WebSocket).

Key implementation notes:

- CDP frames are JSON: `{ id, method, params }` → `{ id, result }` /
  `{ id, error }`.
- Event frames (`{ method, params }` with no `id`) deliver asynchronous
  events (console output, request lifecycle, etc.). The current input
  layer doesn't subscribe — leave that for whoever ports observability.
- `attach()` is a no-op for per-page WebSocket URLs (the socket is the
  attachment). Browser-level URLs (`ws://host:port/devtools/browser`)
  need an explicit `Target.attachToTarget` to acquire a `sessionId` and
  every subsequent call must include it. Pick one model up front; the
  per-page model is simpler.

### 2. Add a factory that resolves a `CdpClient` from your tab record

Today, `http-service.ts` does:

```ts
const cdp = getElectronCdpClient(activeTab.view.webContents);
```

Replace with something like:

```ts
const cdp = await deps.getCdpClientForTab(activeTab);
```

Where `deps.getCdpClientForTab` is injected at the http-service
construction site (in `main.ts`) and resolves to either the Electron or
remote backend depending on configuration.

There are three call sites in `http-service.ts` (context-click, mouse,
keyboard). All three look the same.

### 3. Update the helpers in `main.ts`

`sendBrowserKeyPress` and `clearFocusedBrowserTextInput` currently take a
`WebContents`. Change them to take a `CdpClient` (the http-service
already has one resolved at the call site), or accept whichever opaque
tab handle you settle on. The body stays the same — they already call
the CDP dispatch helpers.

### 4. Drop the dead code

Once the embedded `BrowserView` path is gone, the following can be
removed wholesale:

- `withTemporarilyRenderedBrowserTab` and its `requireFocusedWindow`
  parameter (already only used by removed paths)
- `withQueuedAgentInputHost`, `ensureSharedAgentInputHostWindow`, and
  the entire shared-agent-input-host machinery in `tab-state.ts`
- The `sendInputEvent` fallback inside `sendBrowserKeyPress` /
  `clearFocusedBrowserTextInput` / the three http-service routes —
  there's no Electron `webContents` to fall back to. (Keep `CdpUnavailableError`
  as a real error path if the remote Chrome's CDP socket dies.)

### 5. Things you'll need to figure out at the system level

These aren't input-layer concerns but you can't ship the migration
without them:

- **Chrome process lifecycle** — launch, supervise, restart, profile
  directory, headless vs headed, persistent vs per-session.
- **Per-workspace isolation** — today each workspace has its own
  Chromium partition. Replicate via `--user-data-dir=<path-per-workspace>`
  or via `Browser.createBrowserContext` if you launch one Chrome and
  multiplex.
- **Authentication / cookies / extensions** — moving from
  `session.fromPartition()` to a Chrome user-data-dir.
- **Rendering** — if you still want to *show* the browser to the user
  in the desktop app, Chrome is a separate OS window. Either embed via a
  native Chromium child window, or screen-share via
  `Page.startScreencast` and paint frames into a renderer canvas.
- **Observability** — wire CDP event streams (`Network.*`, `Log.*`,
  `Runtime.consoleAPICalled`, `Page.*`) into the same
  `observability.ts` schemas the renderer already consumes.

## Why this design

The motivating bug was macOS Spaces focus theft on fullscreen Holaboss:
`webContents.sendInputEvent(...)` requires the host window to be focused,
and our code path was calling `mainWindow.focus()` / `host.focus()` /
`webContents.focus()` before every input event. On fullscreen the OS
treats `focus()` as a hard Space switch — the user gets yanked back to
Holaboss every time the agent clicks something in the page.

The fix was to route input through CDP (`Input.dispatchMouseEvent` /
`Input.dispatchKeyEvent` / `Input.insertText`), which goes straight to
the renderer's input synthesizer and doesn't need OS-level window focus.
That's the same approach Playwright and Puppeteer use.

Designing it as a transport boundary (rather than coupling the dispatch
to `webContents.debugger` directly) meant the work doubles as the
foundation for the future "drive a real Chrome" path. The dispatch
helpers don't know or care whether they're talking to an Electron
in-process debugger or a remote WebSocket — same protocol either way.

## Pointers

- Backend interface: `apps/desktop/electron/browser-pane/cdp-input.ts`
- Current Electron backend: same file, `createElectronCdpClient`
- HTTP routes that consume the dispatch helpers:
  `apps/desktop/electron/browser-pane/http-service.ts`
  (search for `cdpDispatch` / `cdpInsertText` / `getElectronCdpClient`)
- Main-process helpers: `apps/desktop/electron/main.ts`
  (`sendBrowserKeyPress`, `clearFocusedBrowserTextInput`)
- Reference assertions: `apps/desktop/electron/browser-context-menu.test.mjs`
- The agent-tool schemas that ride on top:
  `runtime/harnesses/src/desktop-browser-tools.ts`
