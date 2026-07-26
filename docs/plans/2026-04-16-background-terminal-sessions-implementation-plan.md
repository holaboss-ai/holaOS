# Background Terminal Sessions — Implementation Plan

## Goal

Add first-class long-lived terminal sessions that the runtime, agent, and desktop app can start, monitor, reconnect to, and control without blocking the foreground runner path.

## Core Principle

Keep the existing foreground runner for one-shot agent turns and add a separate terminal-session subsystem for interactive or long-running work.

That means:

- `runtime/api-server/src/runner-worker.ts` remains the execution path for normal foreground runs.
- Background or interactive shell work becomes an explicit runtime resource with its own state, API, and UI.
- The desktop app can monitor a live terminal session without treating terminal output as the source of truth for session completion.

---

## Decision Summary

### Chosen first implementation

- Use `node-pty` as the local PTY backend in the runtime API server.
- Use `@fastify/websocket` for bidirectional terminal session transport.
- Keep session metadata and append-only terminal output events in the runtime state store.
- Add a desktop terminal pane backed by `xterm.js`.
- Expose terminal sessions to the agent through new runtime tools instead of overloading the existing foreground `bash` flow.

### Explicit non-goals for phase 1

- Do not replace the current foreground runner with PTYs.
- Do not make the native OS terminal app the execution substrate.
- Do not require `tmux` in phase 1.
- Do not attempt true live-session recovery across runtime restarts with raw PTYs.

### Deferred extension

- Design the subsystem so a later `tmux` backend can sit behind the same session API when durable detach/reattach becomes more important than Windows parity.

---

## Desired Behavior

### Agent behavior

- The agent can start a long-running command and get back a `terminal_id`.
- The agent can continue working while the command runs.
- The agent can later read recent output, wait for more output, send input, or stop the session.
- Long-running jobs such as dev servers, migrations, and data-enrichment scripts no longer depend on the foreground runner idle watchdog.

### Desktop behavior

- The desktop app can open a terminal pane for a session and stream live output.
- Terminal panes can reconnect after UI reload or transient network loss by replaying persisted events.
- The user can type into a terminal session, resize it, and stop it from the UI.
- Terminal sessions appear as operator surfaces so the active terminal can be referenced in prompt context.

### Runtime behavior

- Terminal sessions have durable metadata and append-only event history in SQLite.
- Live PTY state is held in memory by the runtime API server.
- If the runtime process restarts, the persisted session record remains, but live raw PTY sessions are marked as interrupted because they cannot be reattached.
- The existing session output SSE stream remains responsible for chat run events and terminal run completion, not raw terminal output.

---

## Current State

The current architecture has three useful building blocks but no first-class background terminal object.

### Foreground runner

- `runtime/api-server/src/runner-worker.ts` executes a single shell command and waits for terminal events from the harness runner.
- Idle detection is tied to forwarded terminal events, not to a persistent interactive session.

### Runtime streaming

- `runtime/api-server/src/app.ts` already exposes long-lived SSE endpoints for session output streams.
- `desktop/electron/main.ts` already proxies runtime SSE streams to renderer IPC via `workspace:sessionStream`.

### Operator surfaces and prompt context

- The desktop and runtime types already include `terminal` in `OperatorSurfaceType`.
- `runtime/api-server/src/agent-runtime-prompt.ts` already knows how to describe active operator surfaces in prompt context.

### Gap

- There is no `terminal_sessions` table.
- There is no PTY/session manager.
- There is no bidirectional terminal transport.
- There is no desktop terminal pane.
- The agent can only run commands as synchronous tool calls, not as durable terminal sessions.

---

## Why `node-pty` First

`node-pty` is still the practical Node/Electron default for local PTY creation:

- cross-platform support across macOS, Linux, and Windows
- mature `spawn` / `write` / `resize` / `kill` API
- already used by mature terminal products
- fits the existing Node/TypeScript runtime without introducing a second service

`tmux` is still valuable, but it solves a slightly different problem:

- stronger detach/reattach semantics
- stronger recovery for remote or Linux/macOS-first environments
- weaker Windows story
- extra operational dependency

Phase 1 should optimize for integration speed and cross-platform fit. Phase 2 can add a `tmux` backend behind the same runtime API.

---

## Target Architecture

## 1. Terminal Session Domain Model

Introduce a new persisted runtime resource: `terminal_session`.

Recommended session record shape:

```json
{
  "terminal_id": "uuid",
  "workspace_id": "workspace uuid",
  "session_id": "agent session uuid or null",
  "input_id": "agent input uuid or null",
  "title": "Install server",
  "backend": "node_pty",
  "owner": "agent",
  "status": "running",
  "cwd": "workspace-relative path",
  "shell": "bash",
  "command": "npm run dev",
  "exit_code": null,
  "last_event_seq": 42,
  "created_at": "iso",
  "started_at": "iso",
  "last_activity_at": "iso",
  "ended_at": null,
  "metadata": {}
}
```

Recommended event record shape:

```json
{
  "terminal_id": "uuid",
  "sequence": 42,
  "event_type": "output",
  "payload": {
    "stream": "stdout",
    "chunk": "Compiled successfully\n"
  },
  "created_at": "iso"
}
```

Suggested event types:

- `started`
- `output`
- `input`
- `resize`
- `signal`
- `status`
- `exit`
- `error`

## 2. Runtime PTY Manager

Add a `TerminalSessionManager` in the API server process.

**New file:**

- `runtime/api-server/src/terminal-session-manager.ts`

Responsibilities:

- create `node-pty` processes with workspace-scoped `cwd`
- sanitize and build environment, reusing the same PATH/runtime bootstrapping pattern as `runner-worker.ts`
- maintain a live in-memory map of active sessions
- assign monotonically increasing sequence numbers
- persist event records to the state store
- broadcast events to connected WebSocket clients
- mark sessions exited or interrupted on process end

Important constraints:

- never allow `cwd` to escape the workspace root
- cap output chunk size and total retained in-memory buffer
- enforce per-workspace and global session-count limits
- prevent orphaned PTYs during Fastify shutdown

## 3. Runtime Persistence Layer

Extend the state store with terminal session tables.

**Files:**

- Modify: `runtime/state-store/src/store.ts`
- Modify: `runtime/state-store/src/index.ts`
- Modify: `runtime/state-store/src/store.test.ts`

### New tables

- `terminal_sessions`
- `terminal_session_events`

### Recommended columns for `terminal_sessions`

- `terminal_id TEXT PRIMARY KEY`
- `workspace_id TEXT NOT NULL`
- `session_id TEXT`
- `input_id TEXT`
- `title TEXT NOT NULL DEFAULT ''`
- `backend TEXT NOT NULL`
- `owner TEXT NOT NULL`
- `status TEXT NOT NULL`
- `cwd TEXT NOT NULL`
- `shell TEXT`
- `command TEXT NOT NULL`
- `exit_code INTEGER`
- `last_event_seq INTEGER NOT NULL DEFAULT 0`
- `created_by TEXT`
- `created_at TEXT NOT NULL`
- `started_at TEXT NOT NULL`
- `last_activity_at TEXT NOT NULL`
- `ended_at TEXT`
- `metadata TEXT NOT NULL DEFAULT '{}'`

### Recommended columns for `terminal_session_events`

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `terminal_id TEXT NOT NULL`
- `workspace_id TEXT NOT NULL`
- `session_id TEXT`
- `sequence INTEGER NOT NULL`
- `event_type TEXT NOT NULL`
- `payload TEXT NOT NULL`
- `created_at TEXT NOT NULL`

### Indexes

- `idx_terminal_sessions_workspace_status`
- `idx_terminal_sessions_session_created`
- `idx_terminal_session_events_terminal_sequence`
- `idx_terminal_session_events_workspace_created`

### Store methods

- `createTerminalSession(...)`
- `getTerminalSession(...)`
- `listTerminalSessions(...)`
- `appendTerminalSessionEvent(...)`
- `listTerminalSessionEvents(...)`
- `markTerminalSessionRunning(...)`
- `markTerminalSessionExited(...)`
- `markTerminalSessionInterrupted(...)`
- `touchTerminalSessionActivity(...)`

### Startup reconciliation

On runtime startup:

- find persisted sessions in `running` or `starting`
- mark them `interrupted`
- append a synthetic `exit` or `error` event explaining that the runtime restarted before the PTY could be reattached

This is the correct raw-PTY behavior and keeps the persisted model honest.

## 4. Runtime API Surface

Add a dedicated terminal session API in `runtime/api-server/src/app.ts`.

**New dependency:**

- `@fastify/websocket`

### Routes

- `POST /api/v1/terminal-sessions`
- `GET /api/v1/terminal-sessions/:terminalId`
- `GET /api/v1/terminal-sessions`
- `GET /api/v1/terminal-sessions/:terminalId/events`
- `POST /api/v1/terminal-sessions/:terminalId/input`
- `POST /api/v1/terminal-sessions/:terminalId/resize`
- `POST /api/v1/terminal-sessions/:terminalId/signal`
- `POST /api/v1/terminal-sessions/:terminalId/close`
- `GET /api/v1/terminal-sessions/:terminalId/stream` with `wsHandler`

### Request model

`POST /api/v1/terminal-sessions`

```json
{
  "workspace_id": "required",
  "session_id": "optional",
  "input_id": "optional",
  "title": "optional",
  "cwd": ".",
  "command": "npm run dev",
  "shell": "optional",
  "cols": 120,
  "rows": 36,
  "owner": "agent",
  "metadata": {}
}
```

### Stream behavior

Use WebSocket rather than SSE for the live terminal stream.

Reasons:

- terminal sessions need bidirectional I/O
- resize and input must flow back to the runtime immediately
- SSE is already good enough for chat/session events and should stay there

Recommended WebSocket payload types:

- `connected`
- `replay`
- `output`
- `status`
- `exit`
- `error`

### Auth and scoping

- reuse the existing local runtime auth model
- require workspace ownership checks on every session operation
- reject requests when `terminal_id` does not belong to the provided workspace

## 5. Desktop Main-Process Bridge

Mirror the existing session-output bridging pattern in `desktop/electron/main.ts`.

**Files:**

- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/src/types/electron.d.ts`

### Main-process responsibilities

- open WebSocket connections to runtime terminal session routes
- proxy runtime events into renderer IPC
- accept renderer IPC for input, resize, signal, and close
- preserve one stream per renderer-facing handle
- reconnect by replaying persisted events when the window reloads

Recommended IPC additions:

- `workspace:createTerminalSession`
- `workspace:getTerminalSession`
- `workspace:listTerminalSessions`
- `workspace:openTerminalSessionStream`
- `workspace:closeTerminalSessionStream`
- `workspace:sendTerminalSessionInput`
- `workspace:resizeTerminalSession`
- `workspace:signalTerminalSession`
- `workspace:closeTerminalSession`

Recommended event channel:

- `workspace:terminalSessionStream`

The design should parallel the existing `workspace:sessionStream` bridge instead of inventing a separate renderer networking model.

## 6. Desktop Renderer Terminal Pane

Add a dedicated terminal pane backed by `xterm.js`.

**Files:**

- Add: `desktop/src/components/panes/TerminalPane.tsx`
- Add: `desktop/src/components/panes/TerminalPane.test.mjs`
- Modify: `desktop/src/components/layout/AppShell.tsx`
- Modify: any pane registry/view-state files that currently register internal panes

### Renderer responsibilities

- render terminal output with `xterm.js`
- send keystrokes through the preload API
- send resize events through `ResizeObserver` plus the `fit` addon
- restore historical output from replay events before showing live data
- show session metadata such as title, status, cwd, command, and exit code

### Suggested dependencies

- `xterm`
- `@xterm/addon-fit`

### Minimal UI scope

- one pane per terminal session
- title bar with status and stop/reconnect controls
- input enabled only while running
- read-only historical view after exit

## 7. Operator Surface Integration

Terminal sessions should participate in operator-surface context.

**Files:**

- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/src/types/electron.d.ts`
- Modify: `runtime/api-server/src/agent-runtime-prompt.ts`
- Modify: `runtime/api-server/src/agent-runtime-prompt.test.ts`

### Surface model

- user-opened terminal pane: `owner = "user"`, `mutability = "takeover_allowed"`
- agent-started background terminal: `owner = "agent"`, `mutability = "agent_owned"`

### Prompt behavior

When a terminal session is active, surface context should include a short summary such as:

- `Agent-owned terminal: npm run dev in workspace root, status running`
- `User terminal: python manage.py shell in scripts/, status waiting`

That lets the model interpret references such as `this terminal`, `the server`, or `the process you started`.

## 8. Agent Tool Surface

Expose terminal control as runtime tools, not browser tools and not raw shell-only hacks.

**Files:**

- Modify: `runtime/harnesses/src/runtime-agent-tools.ts`
- Modify: `runtime/api-server/src/runtime-agent-tools.ts`
- Modify: `runtime/api-server/src/agent-capability-registry.ts`
- Modify: `runtime/api-server/src/agent-capability-registry.test.ts`

### Recommended tools

- `terminal_start`
- `terminal_list`
- `terminal_read`
- `terminal_wait`
- `terminal_send_input`
- `terminal_signal`
- `terminal_close`

### Recommended semantics

- `terminal_start` returns `terminal_id`, initial status, and a short output excerpt
- `terminal_read` returns output after a sequence number
- `terminal_wait` blocks briefly for new output or exit, then returns delta events
- `terminal_send_input` writes bytes or text into the PTY
- `terminal_signal` sends `SIGINT`, `SIGTERM`, or kill-equivalent
- `terminal_close` closes the session and updates persisted status

### Why not reuse foreground `bash`

- foreground `bash` should stay optimized for one-turn command execution
- terminal sessions are not tied to one runner invocation
- terminal sessions need stateful follow-up operations and live monitoring

## 9. Session Output and Chat Trace Strategy

Do not dump raw PTY output into `session_output_events` by default.

Instead:

- keep `session_output_events` for agent-run lifecycle and summarized tool calls
- keep raw terminal output in `terminal_session_events`
- let the agent read terminal output via `terminal_read` / `terminal_wait`
- let the desktop terminal pane consume the live terminal stream directly

This avoids exploding chat traces with terminal noise while preserving full terminal history in its own store.

Optional future enhancement:

- add summarized terminal status events into `session_output_events` for visibility, for example `terminal_started` and `terminal_exited`

## 10. Foreground Runner Integration

The terminal subsystem should complement `runner-worker.ts`, not replace it.

### Keep as-is

- synchronous agent runs
- foreground tool execution
- current run completion and failure semantics

### New guidance

- use `terminal_start` for commands expected to run for a long time, require interactivity, or need to be monitored later
- keep `bash` for short deterministic commands whose full result is needed in the current turn

### Optional later integration

Add a helper path where the runtime can recommend upgrading a command from foreground `bash` to `terminal_start` when it matches known long-running patterns such as:

- `npm run dev`
- `vite`
- `next dev`
- `docker compose up`
- `tail -f`
- explicit user requests to keep something running

---

## Implementation Tasks

## Task 1: Add Terminal Session Persistence

**Files:**

- Modify: `runtime/state-store/src/store.ts`
- Modify: `runtime/state-store/src/index.ts`
- Modify: `runtime/state-store/src/store.test.ts`

### Work

- [ ] Add `terminal_sessions` table
- [ ] Add `terminal_session_events` table
- [ ] Add migration logic for existing databases
- [ ] Add typed record interfaces and store methods
- [ ] Add startup reconciliation for stale `running` sessions

## Task 2: Add Runtime PTY Manager

**Files:**

- Add: `runtime/api-server/src/terminal-session-manager.ts`
- Add: `runtime/api-server/src/terminal-session-manager.test.ts`
- Modify: `runtime/api-server/package.json`

### Work

- [ ] Add `node-pty` dependency
- [ ] Build a manager that owns live PTY instances
- [ ] Validate workspace-scoped `cwd`
- [ ] Reuse runtime PATH/env setup patterns from `runner-worker.ts`
- [ ] Persist output and exit events to the store
- [ ] Add safe shutdown handling

## Task 3: Add Runtime API Routes

**Files:**

- Modify: `runtime/api-server/src/app.ts`
- Modify: `runtime/api-server/src/app.test.ts`
- Modify: `runtime/api-server/package.json`

### Work

- [ ] Register `@fastify/websocket`
- [ ] Add terminal-session CRUD and control routes
- [ ] Add WebSocket stream route with replay support
- [ ] Add route-level workspace validation
- [ ] Add tests for create, replay, input, resize, signal, exit, and reconnect

## Task 4: Add Desktop Main-Process Terminal Bridge

**Files:**

- Modify: `desktop/electron/main.ts`
- Modify: `desktop/electron/preload.ts`
- Modify: `desktop/src/types/electron.d.ts`

### Work

- [ ] Add runtime-terminal WebSocket client management
- [ ] Add renderer IPC methods for terminal control
- [ ] Proxy terminal events to renderer windows
- [ ] Reconnect by replaying after renderer reload
- [ ] Add tests for stream open/close and event forwarding where coverage exists

## Task 5: Add Terminal Pane UI

**Files:**

- Add: `desktop/src/components/panes/TerminalPane.tsx`
- Add: `desktop/src/components/panes/TerminalPane.test.mjs`
- Modify: `desktop/src/components/layout/AppShell.tsx`

### Work

- [ ] Add `xterm.js` renderer integration
- [ ] Add fit-on-resize handling
- [ ] Add input, copy, paste, and stop controls
- [ ] Add historical replay before live stream attach
- [ ] Add empty, loading, exited, and interrupted states

## Task 6: Add Agent Tools

**Files:**

- Modify: `runtime/harnesses/src/runtime-agent-tools.ts`
- Modify: `runtime/api-server/src/runtime-agent-tools.ts`
- Modify: `runtime/api-server/src/agent-capability-registry.ts`
- Modify: `runtime/api-server/src/agent-capability-registry.test.ts`

### Work

- [ ] Define terminal runtime tools in the harness-facing manifest
- [ ] Implement runtime handlers for each terminal tool
- [ ] Add capability-manifest exposure and filtering
- [ ] Add tests for tool registration and execution

## Task 7: Add Prompt and Surface Context

**Files:**

- Modify: `runtime/api-server/src/agent-runtime-prompt.ts`
- Modify: `runtime/api-server/src/agent-runtime-prompt.test.ts`
- Modify: desktop surface-summary plumbing as needed

### Work

- [ ] Include live terminal surfaces in operator-surface summaries
- [ ] Add prompt guidance for when to use background terminal tools
- [ ] Ensure active terminal surfaces can anchor deictic references

## Task 8: Add Terminal Status Summaries In Chat

**Files:**

- Modify: `desktop/src/components/panes/ChatPane.tsx`
- Modify: `desktop/src/components/panes/ChatPane.test.mjs`

### Work

- [ ] Show compact mentions for `terminal_start` results
- [ ] Optionally show terminal exit summaries when a session linked to the current agent session exits
- [ ] Avoid inlining raw terminal output into the chat transcript

## Task 9: Add Recovery and Observability

**Files:**

- Modify: `runtime/api-server/src/app.ts`
- Modify: `runtime/api-server/src/terminal-session-manager.ts`
- Modify: `runtime/api-server/src/runner-worker.ts` only if shared helpers are extracted

### Work

- [ ] Add logs for session create, exit, signal, and reconnect
- [ ] Add metrics or counters if available
- [ ] Mark uncleanly lost PTYs as `interrupted` on startup
- [ ] Document expected behavior during runtime restart

---

## Testing Strategy

### Runtime unit tests

- terminal session creation and persistence
- output event ordering and sequence numbering
- workspace `cwd` escape rejection
- resize and signal behavior
- exit and interrupted-state persistence
- replay from `after_seq`

### Runtime API tests

- create/list/get routes
- input/resize/signal/close routes
- WebSocket replay plus live output
- reconnect after partial consumption
- workspace access rejection

### Desktop tests

- IPC bridge open/close behavior
- renderer stream subscription and cleanup
- terminal pane state transitions
- resize handling and replay bootstrap

### Manual verification

- start a dev server and keep chatting
- interrupt a long-running process from the UI
- close and reopen the terminal pane during an active session
- restart the runtime and confirm the session becomes `interrupted`

---

## Rollout Plan

## Phase 1: Runtime substrate

- state-store tables
- `node-pty` manager
- runtime REST and WebSocket API
- no renderer UI required yet

Deliverable:

- terminal sessions can be created and controlled through API tests and local scripts

## Phase 2: Agent tools

- runtime tools wired into capability manifest
- prompt guidance updated
- chat shows terminal-start summaries

Deliverable:

- the agent can launch and monitor long-running sessions in product flows

## Phase 3: Desktop pane

- Electron bridge
- `xterm.js` pane
- operator-surface integration

Deliverable:

- users can inspect and interact with running sessions visually

## Phase 4: Hardening

- output retention limits
- better reconnect ergonomics
- interrupted-session recovery semantics
- optional session pinning or naming

## Phase 5: Optional backend abstraction

- add a `tmux` backend behind the same `TerminalSessionManager` interface
- prefer it only where durable detach/reattach matters more than Windows support

---

## Open Questions

1. Should agent-started terminal sessions be visible to the user by default, or only after explicit open?
2. Do we want one shared terminal namespace per workspace, or separate user and agent terminal namespaces?
3. Should terminal output retention be unlimited in SQLite, or should old event rows be compacted after exit?
4. Should `terminal_wait` return raw chunks, line-buffered output, or both?
5. Should `terminal_send_input` accept plain UTF-8 text only, or arbitrary byte payloads?

---

## Recommended First Slice

Build the smallest path that proves the architecture:

- state-store tables
- `node-pty` manager
- `POST /api/v1/terminal-sessions`
- `GET /api/v1/terminal-sessions/:terminalId/events`
- `POST /api/v1/terminal-sessions/:terminalId/signal`
- `GET /api/v1/terminal-sessions/:terminalId/stream` over WebSocket
- `terminal_start`, `terminal_wait`, and `terminal_signal`

That slice is enough to solve the current product problem: long-running commands can continue in the background, and the agent can come back to monitor them later.
