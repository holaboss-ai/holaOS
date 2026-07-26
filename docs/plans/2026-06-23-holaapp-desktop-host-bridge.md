# HolaApp Desktop Host Bridge — design

**Status:** in progress — backend + desktop built & verified; frontend Discuss pending package publish
**Date:** 2026-06-23
**Owner:** (tbd)

> ## ⚠️ Correction (2026-06-23) — where web HolaApp pages actually render
>
> The original draft below assumed a hosted HolaApp page loads in the existing
> **app-surface `BrowserView`** ("currently has no preload"). That assumption is
> **wrong**. There are two distinct app classes:
>
> - **App-builder apps** — served at `http://localhost:<port>` by the workspace
>   runtime; opened today as **browser-pane tabs**. The app-surface `BrowserView`
>   (`getOrCreateAppSurfaceView`) is currently unwired/parked.
> - **Web HolaApps** (need-review, …) — served **remotely** by the web frontend
>   at `<WEB_APP_BASE_URL>/apps/<holaAppId>` (`www.holaos.ai` / staging
>   `www.imerchstaging.com`), backend via `/gateway/wapp/...`. Not localhost.
>
> **Decision (confirmed with the user):** web HolaApps get their **own dedicated
> surface**, built by **reusing the app-surface `BrowserView` machinery**
> (`getOrCreate` / `setBounds` / `attach` / `destroy` / `hide`, `appSurface:*`
> IPC) with a remote-origin URL resolver swapped in (`navigateWebHolaAppSurface`
> → `<WEB_APP_BASE_URL>/apps/<holaAppId>`). A dedicated single-origin trusted
> surface is *why* the preload host bridge is safe (vs a general browser tab that
> loads arbitrary sites). The bridge from the sections below rides on exactly
> that surface — unchanged in shape, just driven for web apps.
>
> **As built (this branch `feat/app-host-bridge`):**
> - `@holaboss/app-host` package (web client + `/protocol`) — committed.
> - Desktop main: `WEB_APP_BASE_URL` config, `navigateWebHolaAppSurface` +
>   `appSurface:navigateWebApp`/`destroyWebApp` IPC, the committed host bridge
>   (`appSurfacePreload` + `appSurface:host:*` + `hostChatStart`).
> - Desktop renderer: `hola_app` internal-tab kind → `WebAppSurfacePane` (native
>   bounds mirror), a "HolaApps" sidebar section listing `GET /api/v1/apps`, and
>   `useHostOpenChat` (opens the session + prefills the composer, side-by-side).
> - Backend: `GET /api/v1/apps` launcher list (workflow-backend registry).
> - **Pending:** publish `@holaboss/app-host` to npm, then wire need-review's
>   Discuss → `host.chat.start` (frontend consumes it as a published dep, like
>   `@holaboss/app-sdk@0.1.1`). The richer `app-context` attachment pill is
>   deferred (prompt-only for v1).
>
> The sections below are the original design; read them through this correction.

## Summary

A **general, versioned bridge** that lets any HolaApp web page (hosted in the
desktop "holaOS" client) request native desktop operations. It is **not** a
need-review feature — need-review's **Discuss** button is consumer #1.

First operation: `chat.start` — open/create a desktop chat session, optionally
pre-filled with a prompt and one or more **generic app-context attachments**.
Discuss passes a record-shaped context; future apps pass their own.

This composes existing desktop primitives (session creation + composer prefill
atoms). The genuinely new surface area is (a) a preload + IPC on the
app-surface BrowserView, and (b) a generic `app-context` composer attachment.

## Non-goals / what this is NOT

- Not `@holaboss/app-builder-sdk` (that authors app *modules*, server side; its
  `bridge.ts` is a provider transport, unrelated).
- Not `@holaboss/runtime-client` (renderer↔runtime REST).
- Not a URL protocol (`holaboss://`) or an MCP/agent-inbox handoff — both were
  considered and rejected in favor of an in-app preload IPC bridge.
- Not coupled to the backend Projects layer (`Workflow → Project → Run`). The
  desktop session's existing `project_id` (`null = General`) is a separate
  concept; host `chat.start` passes `null` for now.

## Principles

1. **Generic & additive.** Ops are named strings dispatched through one
   `invoke(op, payload)` channel; adding ops never breaks callers. No app names
   (`needReview`, `discussRecord`) appear in the desktop main/renderer or SDK.
2. **Capability-negotiated.** The page can `capabilities()` to feature-detect;
   unknown ops return a typed `unsupported_op` error.
3. **Graceful degradation.** Outside the desktop the bridge is absent;
   `host.isAvailable()` is `false` and apps keep their web fallback (e.g.
   need-review's "coming soon" toast).
4. **Capability-safe.** The preload exposes only an allow-listed surface. Main
   verifies the *calling surface's* identity from its own BrowserView↔appId map
   (never trusts an app/workspace id sent by the page). No arbitrary IPC, no
   shell/exec, payload size-limited.

## Architecture

```
 HolaApp web page (BrowserView)            Desktop main            Shell renderer
 ─────────────────────────────            ────────────            ──────────────
 import { host } from                      ipcMain.handle           ipcRenderer.on
   "@holaboss/app-sdk/host"                ("appSurface:host:        ("host:openChat")
        │                                    invoke")                    │
   host.chat.start({prompt,context})  ─▶  resolve surface (appId,    setSelectedSessionId
        │  window.__holabossHost.invoke     workspaceId) from         + chatComposerPrefillAtom
        │  (preload, contextBridge)         appSurfaceViews           + app-context attachment atom
        ▼                                       │
   ipcRenderer.invoke                      createWorkspaceMainSession
   ("appSurface:host:invoke")             webContents.send("host:openChat", …)
```

Four layers:

1. **Web SDK** (`@holaboss/app-sdk/host`) — typed wrapper over `window.__holabossHost`.
2. **App-surface preload** (NEW) — `contextBridge` exposes the bridge into the
   hosted page; the app-surface `BrowserView` currently has no preload.
3. **Main process** — one generic IPC handler dispatching ops; resolves the
   caller's identity from `appSurfaceViews`; composes session + emits to shell.
4. **Shell renderer** — a listener hook that opens the session and prefills the
   composer (text + app-context pill) via existing atoms.

## The contract (`window.__holabossHost`)

Injected by the app-surface preload; present only inside the desktop.

```ts
interface HolabossHost {
  readonly version: number;                 // bridge protocol version (1)
  capabilities(): Promise<string[]>;        // e.g. ["chat.start"]
  invoke<T = unknown>(op: string, payload: unknown): Promise<HostResult<T>>;
}
type HostResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };
```

Note: the page does **not** pass its own `appId`/`workspaceId`; main derives
them from the BrowserView that sent the message.

## SDK — `@holaboss/app-host` (dedicated package)

A new, dependency-free `@holaboss/*` package — deliberately **separate from**
`@holaboss/app-sdk` (the Kubb-generated product REST client). "REST client" and
"desktop host RPC" are different concerns; a dedicated package is the single
source of truth for the host protocol. Two entry points:

- **`@holaboss/app-host`** — the web-facing client a HolaApp page imports
  (`host.isAvailable()` / `host.capabilities()` / `host.chat.start(...)`).
  Safe to import anywhere; degrades to a no-op outside the desktop.
- **`@holaboss/app-host/protocol`** — the shared contract: global name, bridge
  version, op/channel constants, and the `HolabossHost` / `HostResult` /
  `AppContext` / payload types. The desktop **preload + main import this same
  module** (`workspace:*` dep) so the two sides can never drift.

```ts
export const host = {
  isAvailable(): boolean,                       // window.__holabossHost?.version >= 1
  capabilities(): Promise<string[]>,            // [] when unavailable
  chat: {
    start(input: ChatStartInput): Promise<ChatStartResult>,  // throws HostUnavailableError when absent
  },
};

interface ChatStartInput {
  prompt?: string;
  context?: AppContext[];
  newSession?: boolean;   // default true
  autoSubmit?: boolean;   // default false (land as an editable draft)
  title?: string;
}
interface ChatStartResult { sessionId: string }

// Generic, cross-app context object — the unit attached to the composer.
interface AppContext {
  app: string;            // hola_app_id, e.g. "need-review"
  kind: string;           // "record" | "artifact" | "url" | …
  title: string;
  refs?: Record<string, string>;   // e.g. { recordId, workflowId, segmentName }
  snapshot?: { mime: "text/html" | "text/markdown" | "text/plain"; content: string };
  mcp?: { server: string; hint?: string };   // how the agent can expand it
}
```

## First op — `chat.start`

- **Web:** `host.chat.start({ prompt, context, newSession:true, autoSubmit:false })`.
- **Main** (`hostChatStart(surface, input)`):
  1. `createWorkspaceMainSession(surface.workspaceId, { title: input.title })` (existing).
  2. `mainWindow.webContents.send("host:openChat", { session, input })`.
  3. return `{ ok: true, data: { sessionId } }`.
- **Renderer** (`useHostOpenChat`):
  - `setSelectedSessionId(session.session_id)` (open it; focus chat).
  - `setComposerPrefill({ text: input.prompt ?? "", requestKey, sessionMode: "preserve", autoSubmit: input.autoSubmit })`.
  - For each `AppContext`, push an **`app-context` attachment** via a new
    `chatAppContextAttachmentRequestAtom` (mirrors `chatLocalAttachmentRequestAtom`).

### `app-context` composer attachment (NEW)

- Extend `AttachmentListItem.kind` with `"app-context"`, carrying the
  `AppContext` (id + title + refs + snapshot + mcp).
- Composer renders it as a pill (app icon + title; removable like other attachments).
- **On send**, serialize each app-context into the agent message as a context
  block that carries **both**: the inline `snapshot` (immediate grounding) **and**
  the `refs` + `mcp` hint (so the agent can pull the live/full version via that
  app's MCP, e.g. need-review `get_record` / `get_record_provenance`). Exact
  wire format = an open item (text block vs. a structured content part).

## Desktop wiring (files)

- **`apps/desktop/electron/appSurfacePreload.ts`** (NEW): `contextBridge.exposeInMainWorld("__holabossHost", { version, capabilities, invoke })` — global name, version, op/channel names imported from `@holaboss/app-host/protocol`.
- **`electron/main.ts` `getOrCreateAppSurfaceView(appId)`**: add `webPreferences.preload = <appSurfacePreload>` (keep `contextIsolation: true`); record `sender.id → { appId, workspaceId }` for resolution.
- **`electron/main.ts`** (NEW handlers): `appSurface:host:capabilities`, `appSurface:host:invoke` → dispatch table → `hostChatStart` (reuses `createWorkspaceMainSession`).
- **`apps/desktop/src/.../useHostOpenChat.ts`** (NEW): listens on `host:openChat`, drives `selectedSessionId` + `chatComposerPrefillAtom` + the app-context attachment atom. Mounted once in the shell (near `ChatPanel`).
- **Composer** (`components/panes/ChatPane/…`): render + serialize the `app-context` attachment kind.

## Security model

- Preload surface is **allow-listed + versioned**; no passthrough of arbitrary
  channels.
- Main **never trusts** an app/workspace id from the page — it maps
  `event.sender` → the owning app-surface (from `appSurfaceViews`) and scopes
  the op to that workspace.
- Per-op capability check; size-limit `snapshot.content`; ignore ops from
  surfaces whose app isn't installed/active.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox` as currently set.

## need-review as consumer #1

In `holaboss-frontend` `need-review-inbox.tsx`, the **Discuss** handler becomes:

```ts
import { host } from "@holaboss/app-host";

function discuss(record) {
  if (!host.isAvailable()) { /* keep today's toast */ return; }
  host.chat.start({
    prompt: `Let's discuss "${record.title}".`,
    context: [{
      app: "need-review",
      kind: "record",
      title: record.title,
      refs: { recordId: record.recordId, workflowId: record.workflowId, segmentName: record.segmentName ?? "" },
      snapshot: { mime: "text/html", content: record.artifactHtml },
      mcp: { server: "need-review", hint: "get_record / get_record_provenance by recordId" },
    }],
  });
}
```

(Request-changes later becomes a second consumer of the same op or a sibling op.)

## Build phases

1. **Package + contract + client** — scaffold `@holaboss/app-host`: `/protocol` (shared contract/constants) + the web client (`window.__holabossHost` wrapper, no-op fallback). Publish a prerelease; desktop adds it as a `workspace:*` dep for the protocol types.
2. **Desktop bridge** — app-surface preload + `appSurface:host:*` IPC + main dispatch + `hostChatStart`.
3. **Renderer + attachment** — `useHostOpenChat` + the `app-context` attachment kind (pill + send-serialization).
4. **Consumer** — wire need-review Discuss; bump the frontend's `@holaboss/app-sdk` dep.

Phases 2–3 are desktop-only and testable with a stub web page before the SDK
publishes; the frontend wiring (4) lands last.

## Open decisions

- **Package home — RESOLVED:** a dedicated package **`@holaboss/app-host`** (best
  fit over convenience — keeps the host RPC separate from the generated REST
  client, single source of truth for the protocol both sides import). Cost: a
  new published package + a new `holaboss-frontend` dependency.
- **app-context → agent wire format:** inline text block vs. structured content
  part; how prominently the snapshot vs. the MCP-expand hint is presented.
- **RPC vs. fire-and-forget:** `invoke` returns a promise (chosen) so the page
  gets the `sessionId`/errors back.
- **Multi-window:** which window/shell receives `host:openChat` if several are open.
- **Naming:** `__holabossHost` global + `host.*` SDK namespace.
