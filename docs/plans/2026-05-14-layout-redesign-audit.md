# Layout Redesign — Audit & Migration Map

**Branch**: `feat/layout-redesign-shell` (off upstream/main `67a2fa51`)
**Date**: 2026-05-14
**Purpose**: Ground the layout redesign in current code — what exists, what migrates, what dies.
**Companion**: `holaboss/docs/plans/2026-05-14-holaos-layout-wireframes.md` (target design)

---

## 1. Entry Point

`src/App.tsx` (77 lines, clean) — single mount: `<AppShell />` inside `ErrorBoundary > QueryClientProvider > TooltipProvider`.
**Feature flag for new shell will go here** — one conditional, swap `AppShell` for `NewAppShell`.

---

## 2. Current AppShell.tsx (5815 lines)

### JSX render structure (lines 5329–5809)

| Region | Lines | Component |
|---|---|---|
| Top bar | 5364–5409 | `<TopTabsBar>` (conditional on `hasWorkspaces`) |
| Bootstrap / error / first-workspace / onboarding | 5412–5425 | `WorkspaceStartupErrorPane`, `WorkspaceBootstrapPane`, `FirstWorkspacePane`, `WorkspaceOnboardingTakeover` |
| Control Center mode | 5426–5445 | `<WorkspaceControlCenter>` |
| **Space mode (3-column)** | 5447–5737 | inline JSX |
| └ Left rail + explorer panel | 5451–5668 | rail (52px) + `FileExplorerPane` / `SpaceBrowserExplorerPane` / `SpaceApplicationsExplorerPane` |
| └ Center display | 5671–5680 | `spaceDisplayContent` memo → `SpaceBrowserDisplayPane` / `AppSurfacePane` / `InternalSurfacePane` |
| └ Right agent pane | 5704–5731 | `agentContent` memo → `ChatPane` / `ArtifactsPane` / `AutomationsPane` / `SubagentSessionsPane` / etc. |
| Modal / overlay layer | 5740–5807 | create workspace, `WorkspaceAppsDialog`, `SettingsScreenRoot`, `PublishScreen` |

### Four state machines that drive layout

| State | Type | Line | Drives |
|---|---|---|---|
| `activeShellView` | `"control_center" \| "space"` | ~1497 | CC vs three-column |
| `spaceExplorerMode` | `"files" \| "browser" \| "applications"` | 1536 | Left icon rail selection |
| `spaceDisplayView` | `{ type: "browser" \| "app" \| "internal", ... }` | 1560 | Center pane |
| `agentView` | `{ type: "chat" \| "sessions" \| "artifacts" \| "automations" \| "inbox" \| "app" \| "internal" }` | 1511 | Right pane |

### Layout-related width / resize state

- `filesPaneWidth` (260 default, 1583), `browserPaneWidth` (1586), `spaceAgentPaneWidth` (420 default, 1563)
- `spaceLayoutHostWidth` (ResizeObserver-fed, 1570), `isUtilityPaneResizing` (1592), `isSpacePaneAnimating` (1575)
- `spaceWorkspacePanelCollapsed` (1541), `spaceBrowserFullscreen` (1543), `spaceVisibility` (1581)

### LocalStorage keys (defined lines 73–91)

`THEME_STORAGE_KEY`, `SPACE_VISIBILITY_STORAGE_KEY`, `SPACE_WORKSPACE_PANEL_COLLAPSED_STORAGE_KEY`, `CONTROL_CENTER_CARDS_PER_ROW_STORAGE_KEY`, `LAST_SHELL_VIEW_STORAGE_KEY`, `BROWSER_PANE_WIDTH_STORAGE_KEY`, `OPERATIONS_DRAWER_OPEN_STORAGE_KEY`, `CHAT_MODEL_STORAGE_KEY`, etc.

### Providers (wrapping `AppShellContent`, 5813–5821)

`WorkspaceSelectionProvider > WorkspaceDesktopProvider > DesktopBillingProvider > AppShellContent`. Inside: `StoplightProvider` wraps the JSX (5330).

### Global event handlers

- `cmd/ctrl + 1/2/3` → layout modes split/focus_chat/focus_work (4390–4422)
- Window focus/blur (1547–1556)
- ResizeObserver on utility pane host (4974–4982)
- Three pointer-drag handlers for explorer resize / reveal / display resize (5103–5327)

### Direct IPC calls (AppShell talks to electronAPI)

`runtime.getStatus()` + `onStateChange` (2089–2104), `appUpdate.onStateChange` (2257–2264), `ui.onThemeChange` (2288–2296), `workspace.listNotifications()` (3s poll, 2339–2476). Workspace data / installed apps / runtime config come via context (not direct).

---

## 3. Current Tab System

### Tab model (currently browser-only)

`src/types/electron.d.ts:160-170`:

```ts
interface BrowserStatePayload {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  initialized: boolean;
  error: string;
}
```

No abstraction — tabs are pure browser webviews. **For new universal tabs, need a discriminated union** `Tab = BrowserTab | DocTab | DashboardTab | AppTab | ArtifactTab`.

### State ownership

Main-process owned (`electron/browser-pane/tab-state.ts`) — renderer reads via `window.electronAPI.browser.onStateChange()`. Each tab maps 1:1 to an Electron `BrowserView` instance. Persisted via `deps.persistWorkspace()` in workspace YAML.

### "User vs Agent" scope (`BrowserSpaceId = "user" | "agent"`)

**Not a filter — two entirely separate tab lists** with own `activeTabId`, own counts, own webview pool. Toggle is in `SpaceBrowserExplorerPane.tsx:504-551`. New design **drops this concept** (one unified tab list; agent-opened tabs identified by driver indicator, not separate space).

### `TopTabsBar.tsx` (918 lines) — what it actually is

**Not the browser tab bar.** It's the top chrome only:

| Lines | Component |
|---|---|
| 430–509 | Layout picker (split / focus-chat / focus-work) |
| 548–584 | Workspace switcher dropdown |
| 588 | Runtime status indicator |
| 589–609 | Notification inbox popover |
| 610–734 | Account menu dropdown |
| 735–776 | Windows title bar controls |

**The actual browser tab strip is in `BrowserPane.tsx:750-800`** (horizontally scrolling tabs). The sidebar tab list is in `SpaceBrowserExplorerPane.tsx:437-499`.

### New-tab behavior today

`+` button → `electronAPI.browser.newTab()` → opens directly to `https://www.google.com` with `shouldFocusAddressRef`. No landing page; URL bar in `BrowserPane.tsx:923-993` becomes focus target.

**New design**: `+` opens a unified landing page (URL bar + recently closed + Doc/Dashboard buttons).

---

## 4. Panes — Survival Verdict

### Keep as-is

- `MissingWorkspacePane` — blocking error screen, layout-independent
- `IntegrationsPane`, `MarketplacePane` — live in Settings / Marketplace flow, not the shell
- `BackgroundTasksPane` — toast overlay, layout-independent
- `HtmlPreviewFrame`, `PresentationPreview`, `SpreadsheetEditor` — file-preview utilities

### Refactor-light (reuse logic, restyle / re-mount)

- `FileExplorerPane` — survives, becomes a Files tab (browser doesn't have it; tabs do)
- `BrowserPane` — survives, but tab-strip extracted to top bar; URL bar / nav controls / content stay
- `SpaceBrowserDisplayPane` — rendering logic reused under new "browser" tab type
- `AppSurfacePane` — iframe logic reused; mount as "app surface" tab when invoked
- `InternalSurfacePane` — same
- `AutomationsPane` — becomes content of "Automations" emergent sidebar entry (opens center view)
- `SubagentSessionsPane` — similar

### Refactor-heavy

- `ChatPane/index.tsx` + `ChatHeader.tsx` + `QueuedSessionInputRail.tsx` — main shell of chat needs:
  - thread switcher in header (replacing current single-session model)
  - removal of the 4 agentView toggle icons (sessions/inbox/automations/artifacts) — those move to sidebar
  - composer / conversation rendering sub-components survive intact (see below)
- `ArtifactBrowserModal.tsx` — keep or merge with new sidebar Artifacts entry (TBD)

### Drop

- `SpaceBrowserExplorerPane` — old left-rail browser tab list (replaced by new top tab bar)
- `SpaceApplicationsExplorerPane` — old left-rail apps list (apps no longer center destination)

### ChatPane internals (in `src/components/panes/ChatPane/`)

**Reusable as-is** (pure rendering, width-flexible):
- `ConversationTurns.tsx`
- `UserTurn.tsx`
- `AssistantTurn/index.tsx` + all sub-components (`Outputs`, `status`, `TraceStepGroup`, `MemoryProposals`, `ActionsMenu`, `IntegrationConnectCard`)
- `Composer/*` (`index`, `ModelCombobox`, `ThinkingValueSelect`)
- `AttachmentList.tsx`, `ImageAttachmentPreviewModal.tsx`
- `skeletons.tsx`, `types.ts`, `helpers.ts`, `constants.ts`

**Needs redesign**: `index.tsx` (main), `ChatHeader.tsx`, `QueuedSessionInputRail.tsx`.

---

## 5. agentView Type → New Layout Mapping

The current right-pane `agentView` is a switch among 7 types. New design distributes them:

| Current `agentView.type` | New layout home |
|---|---|
| `chat` | Right chat panel (with thread switcher; this is the default state) |
| `sessions` | Sidebar emergent section / Settings (de-prioritized) |
| `inbox` | Sidebar always-on entry `📥 Inbox` |
| `artifacts` | Sidebar always-on entry `📦 Artifacts` → opens center "all artifacts" tab |
| `automations` | Sidebar emergent section `⏰ Automations` |
| `app` | Top tab bar (app surface tab) |
| `internal` | Top tab bar (internal surface tab) or in-chat artifact |

→ **`agentView` state machine collapses** in new shell. Right panel is single-purpose (chat only); other views surface via sidebar / tab bar.

---

## 6. spaceExplorerMode → New Layout Mapping

Current left rail has 3 modes:

| Old mode | New layout home |
|---|---|
| `files` | Files become tabs (open from a file picker / sidebar entry → tab opens) |
| `browser` | Browser is a tab type at top bar |
| `applications` | Apps live in sidebar `🔌 Apps` section + tab open on use |

→ **`spaceExplorerMode` state machine dies**. Left rail (52px) is removed entirely.

---

## 7. spaceDisplayView → New Layout Mapping

Current center pane has 3 types:

| Old type | New layout home |
|---|---|
| `browser` | Browser tab content area |
| `app` | App surface tab content |
| `internal` | Internal surface tab content |

→ **`spaceDisplayView` state machine collapses into the universal tab model**. Each tab carries its own type + content state; no top-level switch.

---

## 8. What Survives the State Machine Collapse

After redesign, top-level layout state shrinks to:

| New state | Replaces |
|---|---|
| `sidebarOpen: boolean` | `spaceWorkspacePanelCollapsed` + spaceVisibility.files/browser |
| `sidebarWidth: number` | `filesPaneWidth` |
| `chatPanelOpen: boolean` | spaceVisibility.agent |
| `chatPanelWidth: number` | `spaceAgentPaneWidth` |
| `tabs: Tab[]` (universal) | browser-tab-only model |
| `activeTabId: string` | `browserState.activeTabId` per BrowserSpaceId |
| `chatThreads: Thread[]` (NEW concept) | n/a (currently single session) |
| `activeThreadId: string` (NEW) | n/a |

`activeShellView` (CC vs space) — **survives**, but renamed.

---

## 9. Cutover Strategy — Side-by-Side

**Decision**: build `NewAppShell` alongside existing `AppShell`. Feature flag in `App.tsx` toggles which renders.

### Rationale

- AppShell is 5815 lines with 42 useState + ~30 useEffect — in-place refactor would have unsafe intermediate states that ship to users
- Side-by-side lets each migration step (universal tabs / new sidebar / chat panel / cohabited browser) ship to dogfooders behind flag without breaking production
- Cleanup of old AppShell happens once new shell is feature-complete (single deletion commit)
- Providers / context / IPC handling stays — both shells consume the same `WorkspaceDesktopProvider` etc.

### Flag mechanism (proposed)

Env var `VITE_NEW_LAYOUT_SHELL=1` for dev; settings toggle later. Single conditional in `App.tsx`:

```tsx
const useNewShell = import.meta.env.VITE_NEW_LAYOUT_SHELL === "1";
return useNewShell ? <NewAppShell /> : <AppShell />;
```

### What stays shared between shells

- `WorkspaceDesktopProvider`, `WorkspaceSelectionProvider`, `DesktopBillingProvider`, `StoplightProvider`
- All `electronAPI` calls (runtime, browser, workspace, apps)
- All reusable panes (FileExplorerPane, the entire ChatPane sub-tree minus index/Header)

### What new shell adds (net-new code)

- `NewAppShell.tsx` — top-level shell composition
- `NewTabBar.tsx` — universal tabs + landing page
- `NewSidebar.tsx` — 3-zone sidebar
- `NewChatPanel.tsx` — chat region with thread switcher (wraps reusable ChatPane sub-components)
- `tab` type discriminated union + tab manager (renderer state, talks to existing IPC for browser-typed tabs, owns state for other types)
- `thread` type + thread manager

### What new shell deletes (after cutover)

- `SpaceBrowserExplorerPane.tsx`
- `SpaceApplicationsExplorerPane.tsx`
- Three state machines: `spaceExplorerMode`, `spaceDisplayView`, `agentView`
- `BrowserSpaceId` "agent" concept (consolidates to one tab list)

---

## 10. Risks & Open Questions

1. **Tab model — main-process vs renderer-owned**: Browser tabs are main-owned (BrowserView lifecycle). New non-browser tabs (doc / dashboard / artifact) are pure renderer state. The Tab discriminated union needs to bridge — one type stays main-owned, others stay renderer-owned. Need careful design of the renderer-side "Tab" abstraction that wraps both.
2. **Browser space "agent" — do we lose data**: Dropping the agent BrowserSpace means existing user data (saved agent-space tabs per workspace) needs migration or graceful drop. Check `persistWorkspace()` schema before deciding.
3. **`agentView` consumers**: Anything else in the codebase that reads/writes `agentView` outside AppShell? If yes, refactor scope widens.
4. **Settings dialog still mounted at shell level** — `SettingsScreenRoot` should remain shell-mounted in new design (no change). Confirm.
5. **`StoplightProvider` integration with new title bar**: Double-row chrome (Notion-style) means traffic-light placement differs from current. Verify provider can express this without code churn.

---

## 11. Recommended Next Step (after this audit lands)

**Step B (decision) — confirm side-by-side approach + flag mechanism with the team.** If approved, **Step C** is the scaffold commit:

- Add `VITE_NEW_LAYOUT_SHELL` env handling
- Create `NewAppShell.tsx` (empty 3-region static skeleton; no logic)
- Wire flag in `App.tsx`
- Verify both shells render (old default, new behind flag)
- No behavioral / UI fidelity yet — pure scaffolding

After scaffold: build out one region at a time, each in its own PR — universal tab bar → new sidebar → new chat panel → cohabited browser features.
