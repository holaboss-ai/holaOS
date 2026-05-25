---
name: build-dashboard
description: Build the visual layer of a holaOS dashboard app — TanStack Start + @holaboss/ui + workspace tokens. Use when an app has SDK primitives wired (via app-builder-sdk) AND needs a `src/client/` UI surface. NOT for marketing pages, NOT for snapshot HTML reports.
---

# build-dashboard

The agent before you reliably produces ugly dashboards because it starts from a blank page and reaches for default shapes (single-column full-width cards, KPI strips that don't fit, sidebars that don't earn their space). This skill exists to **bypass that default**. The visual decisions are already made — your job is to fill in the data and copy.

## When to use

- The user asked for a dashboard, workspace pane, list view, kanban, calendar, or "let me see my X"
- The app's `app.ts` already declares `resource(...)` rows via the SDK (set up via the `app-builder-sdk` skill first)
- The app dir needs a `src/client/` directory

**Skip this skill when:**
- Integration-only module (Slack/Discord/Stripe-style MCP-only) — those use only `app-builder-sdk`
- Marketing landing page → use `frontend-design`
- One-off static HTML report → not this product class

## The two non-negotiables

1. **Copy the bundled reference. Don't invent.** `reference/messaging-dashboard/src/client/` is the canonical starting point. Three files below are verbatim across every dashboard; the rest gets customized per shape.
2. **Two style imports, not one.** `@holaboss/ui/styles.css` only bakes in utilities used inside the library. Every Tailwind class your `src/client/` writes needs your own app-side compile pass. The register-time lint `workspace_app_missing_tailwind_compile` rejects apps missing this.

## The shape catalog — pick one

Look at the user's data, NOT at "what dashboards usually have". Most apps are shape 1.

| # | Shape | Pick when the data is… | Template |
|---|---|---|---|
| 1 | **Queue / feed** | scheduled items, drafts, an action queue, an activity log, anything time-ordered | `reference/messaging-dashboard/` (full, ready to copy) |
| 2 | **Dense table** | flat records (CRM contacts, log rows, ticket list) that the user scans like a spreadsheet | Replace shape-1's `messages-table.tsx` with the `<Table>` primitive (see snippet below) |
| 3 | **Kanban** | rows that move between named statuses; user drags between columns | Replace shape-1's main column with horizontal status columns (see snippet below) |
| 4 | **Detail / form** | a single resource the user edits or watches in depth | Replace shape-1's main column with `<Field>` form (see snippet below) |
| 5 | **Calendar week** | rows with `start_time` + duration that pin to a day-grid | Replace shape-1's main column with `@holaboss/ui`'s `Calendar` primitive |

Shapes 2–5 still keep shape 1's header, app.css, connection pill, status badge, and tokens. **Only the main content area changes.**

ASCII for shape 1 (the most common, read this even if you're using another shape):

```
                ┌────────────────────────────────────────────┐
                │  Outgoing ●            ● Connected · @jot  │  ← header
                │  5 queued · agent will send on schedule    │
                │                                            │
                │  NEEDS ATTENTION                           │
                │  ┌──────────────────────────────────┐     │  ← attention strip
                │  │ #ops · Failed · 3h ago           │     │    (warning-bordered,
                │  │  Composio retry exhausted…       │     │     always-visible Retry)
                │  │                  [Retry] [Edit]  │     │
                │  └──────────────────────────────────┘     │
                │                                            │
                │  TODAY ───────────────────────────── 02   │  ← day divider
                │  NOW · 08:42 ─────────────────────────    │  ← "now" cursor on rail
                │  09:00 ● #general · ● Scheduled            │  ← next-up marker
                │        Heads-up: pricing page goes live…  │
                │  17:00 · #growth · ● Draft                 │
                │        Weekly recap — KPI strip…           │
                │                                            │
                │  TOMORROW ────────────────────────── 02   │
                │  …                                         │
                └────────────────────────────────────────────┘
                       (max-w-3xl centered on bg-background)
```

## Foundation — paste verbatim into every dashboard

These five files do NOT vary per shape. Copy them exactly.

### `src/client/app.css` (13 lines)

```css
/* App-local Tailwind compile entry.
 *
 * `@holaboss/ui/styles.css` only bakes in utilities used INSIDE the library.
 * Every Tailwind class your `src/client/` writes (max-w-3xl, grid-cols-*,
 * text-fg-48, bg-card, flex-1, etc.) needs an app-side compile pass to land
 * in the bundle. Without it the page renders mostly unstyled.
 *
 * Required by the register-time lint `workspace_app_missing_tailwind_compile`.
 */

@import "tailwindcss";

@source "../client";
```

### `src/client/routes/__root.tsx`

```tsx
import "@holaboss/ui/styles.css"
import "../app.css"

import type { ReactNode } from "react"

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="holaos-light">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Your App — holaOS</title>
      </head>
      <body className="antialiased">{children}</body>
    </html>
  )
}
```

### `src/client/components/connection-pill.tsx`

```tsx
import { StatusDot } from "@holaboss/ui"

type Props = {
  state: "ready" | "needs_connect" | "needs_reauth" | "checking"
  handle?: string
}

const COPY: Record<Props["state"], { label: string; tone: "success" | "warning" | "muted" }> = {
  ready: { label: "Connected", tone: "success" },
  needs_connect: { label: "Not connected", tone: "warning" },
  needs_reauth: { label: "Reauth required", tone: "warning" },
  checking: { label: "Checking…", tone: "muted" },
}

export function ConnectionPill({ state, handle }: Props) {
  const { label, tone } = COPY[state]
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-64">
      <StatusDot variant={tone} size="sm" />
      <span className="text-fg-80">{label}</span>
      {handle ? <span className="text-fg-48">· {handle}</span> : null}
    </span>
  )
}
```

Wire `state` from `getIntegrationStatus()` — `ready === true` → `"ready"`, `code === "integration_not_connected"` → `"needs_connect"`, `code === "integration_needs_reauth"` → `"needs_reauth"`. See app-builder-sdk skill for the helper.

### `src/client/components/header-bar.tsx`

```tsx
import { Button, StatusDot } from "@holaboss/ui"
import { Plus } from "lucide-react"
import type { ReactNode } from "react"

type Props = {
  title: string
  subtitle?: string
  rightSlot?: ReactNode
  onCompose?: () => void
}

export function HeaderBar({ title, subtitle, rightSlot, onCompose }: Props) {
  return (
    <header className="px-10 pt-12 pb-8">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <h1
            className="font-serif text-[22px] leading-none text-foreground"
            style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 500 }}
          >
            {title}
          </h1>
          <StatusDot variant="success" size="sm" pulse />
        </div>
        {rightSlot}
        <Button
          variant="ghost"
          size="sm"
          onClick={onCompose}
          className="h-7 gap-1.5 px-2 text-xs text-fg-64 hover:text-foreground"
        >
          <Plus className="size-3" />
          Add draft
        </Button>
      </div>
      {subtitle ? (
        <p className="mt-2 truncate text-xs text-fg-48">{subtitle}</p>
      ) : null}
    </header>
  )
}
```

### `src/client/components/status-badge.tsx`

```tsx
import { StatusDot } from "@holaboss/ui"

// REPLACE this union with your resource's state machine.
type MyStatus = "draft" | "scheduled" | "sent" | "edited" | "failed"

// REPLACE this map: one entry per state with its label and dot variant.
// Use `success` for completed/healthy, `info` for in-flight/scheduled,
// `muted` for inert/draft, `warning` for soft problems, `destructive`
// for hard failures.
const MAP: Record<MyStatus, { label: string; dot: "success" | "warning" | "destructive" | "muted" | "info" }> = {
  draft: { label: "Draft", dot: "muted" },
  scheduled: { label: "Scheduled", dot: "info" },
  sent: { label: "Sent", dot: "success" },
  edited: { label: "Edited", dot: "info" },
  failed: { label: "Failed", dot: "destructive" },
}

export function StatusBadge({ status }: { status: MyStatus }) {
  const { label, dot } = MAP[status]
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-fg-64">
      <StatusDot variant={dot} size="sm" />
      {label}
    </span>
  )
}
```

## Shape 1: queue / feed (canonical, fully bundled)

The full implementation is bundled at `reference/messaging-dashboard/src/client/` next to this skill. Two files vary per app — read them directly from the bundled reference:

- `routes/index.tsx` — page composition (~100 lines). Sets up the 3-region layout: header → attention strip → grouped sections. Read this whole file before copying.
- `components/messages-table.tsx` — the row + rail + attention list (~150 lines). The hardest file; spent the most iteration. Read this whole file before copying.
- `lib/sample-data.ts` — mock data with the `MessageRow` shape (`channel / text / status / bucket / timeLabel / authorHandle / errorReason`). **Replace this file entirely** with TanStack Start server functions that read from your `app.resource()` rows.

What to swap when copying shape 1:

| File | Change | Keep |
|---|---|---|
| `lib/sample-data.ts` | Replace entirely with server functions; rename to `data.ts`. | The row shape — your data should map to the same field set, or the table needs JSX changes too. |
| `routes/index.tsx` | Page title (`"Outgoing"`), subtitle, `nowLabel` (real current time), day-divider labels. | The 3-region structure (header → attention → grouped sections), `max-w-3xl`, spatial sketch comment, useMemo grouping. |
| `messages-table.tsx` | Column meta layout (`#{channel} · author · time`), body field, error-reason placement. | 3-col grid (`64px_16px_1fr_auto`), rail (`bg-fg-32`), marker treatment, attention strip styling. |
| `status-badge.tsx` | `MAP` lookup → your states. | Component shape. |
| `header-bar.tsx`, `connection-pill.tsx`, `__root.tsx`, `app.css` | nothing. | everything. |

## Shape 2: dense table (CRM / log / ticket list)

When the data is naturally rows-and-columns and the user scans like a spreadsheet, replace shape-1's `messages-table.tsx` with the `<Table>` primitive. Header + connection pill + `app.css` setup stay.

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Badge } from "@holaboss/ui"
import { StatusBadge } from "./status-badge"

export function RecordsTable({ rows }: { rows: MyRow[] }) {
  return (
    <Table className="text-[13px]">
      <TableHeader>
        <TableRow className="text-fg-48">
          <TableHead className="w-[180px] pl-6">Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead className="w-[140px]">Owner</TableHead>
          <TableHead className="w-[120px]">Status</TableHead>
          <TableHead className="w-[140px] text-right pr-6">Last touch</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id} className="hover:bg-muted/40">
            <TableCell className="pl-6 text-foreground">{row.name}</TableCell>
            <TableCell className="text-fg-64">{row.email}</TableCell>
            <TableCell className="text-fg-64">{row.owner}</TableCell>
            <TableCell><StatusBadge status={row.status} /></TableCell>
            <TableCell className="text-right text-fg-64 tabular-nums pr-6">{row.lastTouchLabel}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
```

Layout shape: drop the time-rail; keep `max-w-3xl` (or bump to `max-w-5xl` if 5+ columns). Day-divider sections from shape 1 become optional — usually one flat table is fine.

## Shape 3: kanban (status board)

When rows move between named statuses and the user drags between them. Replace shape-1's main column with horizontally-arranged status columns. Header + connection pill + `app.css` stay.

```tsx
import { Card } from "@holaboss/ui"
import { StatusBadge } from "./status-badge"

const COLUMNS = ["draft", "scheduled", "sent", "failed"] as const

export function KanbanBoard({ rows }: { rows: MyRow[] }) {
  const byStatus = COLUMNS.map((status) => ({
    status,
    rows: rows.filter((r) => r.status === status),
  }))

  return (
    <div className="grid grid-cols-4 gap-3 px-10 pb-12">
      {byStatus.map(({ status, rows }) => (
        <div key={status} className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between px-1">
            <span className="text-[10px] tracking-wider text-fg-48 uppercase">{status}</span>
            <span className="font-mono text-[10px] text-fg-32 tabular-nums">
              {rows.length.toString().padStart(2, "0")}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <Card key={row.id} size="sm" className="cursor-pointer hover:bg-muted/40">
                <div className="px-3 py-2">
                  <div className="text-[11px] text-fg-48">#{row.channel}</div>
                  <p className="mt-1 line-clamp-3 text-sm leading-snug text-fg-80">{row.text}</p>
                  <div className="mt-2">
                    <StatusBadge status={row.status} />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
```

Layout shape: change `max-w-3xl` on the outer container to `max-w-6xl` for breathing room. Drop the attention strip (failed rows surface naturally in the "failed" column).

## Shape 4: single-resource detail / form

For workflows where the user edits one resource at a time (settings, single-record CRM contact, single bookmark editor). Replace shape-1's main column with a `<Field>`-based form. Header + connection pill + `app.css` stay.

```tsx
import { Button, Field, FieldDescription, FieldGroup, FieldLabel, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@holaboss/ui"

export function RecordForm({ record, onSave }: { record: MyRow; onSave: (r: MyRow) => void }) {
  return (
    <form className="mx-auto flex max-w-2xl flex-col gap-6 px-10 pb-12">
      <FieldGroup>
        <Field>
          <FieldLabel>Title</FieldLabel>
          <Input defaultValue={record.title} />
        </Field>
        <Field>
          <FieldLabel>Owner</FieldLabel>
          <Select defaultValue={record.owner}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="alice">Alice</SelectItem>
              <SelectItem value="bob">Bob</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>Notes</FieldLabel>
          <Textarea rows={6} defaultValue={record.notes} />
          <FieldDescription>Markdown is supported.</FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" type="button">Cancel</Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  )
}
```

Layout shape: tighter column (`max-w-2xl`). No attention strip; surface validation errors inline via `FieldError`.

## Shape 5: calendar week

When rows have a real `start_time` + duration that pin to a day-grid. Use `@holaboss/ui`'s `Calendar` primitive. This shape is intentionally less battle-tested — extend the base only when calendar truly fits.

```tsx
import { Calendar } from "@holaboss/ui"

export function WeekCalendar({ rows }: { rows: MyRow[] }) {
  // Calendar is the base-ui primitive; for full week-view with custom
  // event rendering you'll need to compose it yourself. The skeleton:
  return (
    <div className="px-10 pb-12">
      <Calendar mode="single" />
      {/* Layer events on top via absolute-positioned cards keyed by date. */}
    </div>
  )
}
```

## Wiring the rest of the app

Everything below is the same as the `app-builder-sdk` skill describes for any app — repeat here only for the dashboard-specific gotchas.

### Required deps in `package.json`

```json
{
  "dependencies": {
    "@holaboss/app-builder-sdk": "latest",
    "@holaboss/ui": "latest",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "lucide-react": "^0.542.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.2.1",
    "@vitejs/plugin-react": "^5.0.0",
    "tailwindcss": "^4.2.1",
    "vite": "^6.3.0"
  }
}
```

Use `"latest"` literally for the two `@holaboss/*` packages — pre-1.0 caret semver drifts.

### Required `vite.config.ts`

```ts
import tailwind from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwind()],
})
```

Without `@tailwindcss/vite`, the `@import "tailwindcss"` in `app.css` is a no-op and your custom utilities don't compile.

### `server.ts` boots BOTH MCP and the dashboard

```ts
import { startMcpServer, SqliteStateBackend, createRuntimeBrokerTransport } from "@holaboss/app-builder-sdk"
import { buildMyApp } from "./app.ts"

const state = new SqliteStateBackend({ path: process.env.WORKSPACE_DB_PATH! })
const bridge = createRuntimeBrokerTransport({ provider: "<provider>" })
const app = buildMyApp({ state, bridge })

// MCP for the agent
await startMcpServer({
  port: Number(process.env.MCP_PORT),
  app, bridge,
})

// Dashboard for the user (iframe loads this URL)
// Use TanStack Start's production build output OR Vite's dev server.
// IMPORTANT: read from the SAME SqliteStateBackend the SDK uses; never
// spin up a second DB.
import { build } from "./client/build"
Bun.serve({ port: Number(process.env.PORT), fetch: build.fetch })
```

The desktop's `AppSurfacePane` iframe resolves to `process.env.PORT` — whatever you serve there is what the user sees.

## Required setup checklist (lint-enforced)

The register-time lint rejects dashboard apps that fail any of these. Run through the list before declaring done.

| Check | Lint code (if fails) |
|---|---|
| `src/client/` has ≥3 distinct named imports from `@holaboss/ui` | `workspace_app_holaboss_ui_named_imports_too_few` |
| At least one `.css` file under `src/client/` contains `@import "tailwindcss"` | `workspace_app_missing_tailwind_compile` |
| No hex / `rgb()` / `hsl()` / `oklch()` literals in `src/client/**/*.css` | `workspace_app_parallel_design_system` |
| No custom `--<token>:` definitions in CSS (passthroughs like `--mine: var(--background)` allowed) | `workspace_app_parallel_design_system` |

If any lint fires, the runtime returns the file + line + suggested fix. Don't try to bypass — read the message and fix the root cause.

## What you may NOT do (read once, internalize)

These are hard rules. The lint catches some; the rest are caught by review (or by the user noticing the dashboard looks alien).

- **No `font-bold` / `font-semibold` / `font-extrabold` / inline `style={{ fontWeight: ... }}`.** Design system clamps all of those to 500. Hierarchy comes from **size** (`text-2xl` for hero numbers, `text-base` for headings, `text-xs` for labels) and **color** (`text-foreground` → `text-fg-80` → `text-fg-64` → `text-fg-48`).
- **No hex / `rgb()` / `oklch()` literals anywhere.** Lint rejects in CSS; review catches in JSX. Use tokens: `bg-background`, `bg-card`, `bg-muted`, `text-foreground`, `text-fg-{12,16,32,48,64,80,92}`, `border`, `border-warning`, `bg-warning/[0.06]`, `text-primary`.
- **No second component library.** No MUI, Ant, Chakra, raw Radix, Headless UI, react-aria. The `@holaboss/ui` package wraps base-ui's shadcn-flavored primitives; that is the only allowed source.
- **No `components/ui/` directory** (shadcn-add copy). Import primitives from `@holaboss/ui` only.
- **No `bg-gradient-*` on cards, no `hover:shadow-*`, no `hover:-translate-y-*` lift effects.** Subtle hover via `hover:bg-muted/40` only.
- **No per-app theme toggle.** Theme is workspace-level; the app inherits via CSS variables.
- **No custom CSS files beyond `app.css`** (and `app.css` must contain only `@import "tailwindcss"` + `@source`, possibly empty `@layer` blocks).
- **No KPI strip "because dashboards usually have them".** Add stat cards only when the user genuinely tracks ≥3 comparable numbers that need to sit side-by-side. The single count of "5 queued" goes in the subtitle, not in a card.
- **No sidebar "because dashboards usually have them".** Add one only when the user has a genuine second navigation axis that must stay on screen (multi-channel chat, multi-project switcher).
- **No `Promise.all` rendering gate.** Each card / table / chart renders the moment its own data lands, with `Skeleton` during fetch and `EmptyState` if empty. A 0.5s skeleton beats a 4s blank page.

## What you SHOULD do

- **Read `reference/messaging-dashboard/` end-to-end** (it lives next to this skill — 4 component files, 1 lib file, 1 routes file). Even if your shape isn't queue/feed, the patterns transfer.
- **Spend 30 seconds on a one-line spatial sketch BEFORE writing JSX.** Single sentence: "Header strip + grouped sections of rows" or "Header + 4-column kanban". If you can't say it in one sentence, pick from the shape catalog above.
- **Replace `lib/sample-data.ts` with TanStack Start server functions** that read from the SDK's `SqliteStateBackend` (the table `app.resource()` declared). Never spin up a second DB. Never call MCP tools from the dashboard.
- **Wire `ConnectionPill` to `getIntegrationStatus()`** (helper from `@holaboss/app-builder-sdk`). The four `state` values map directly to readiness codes.
- **Test in both light AND dark.** Workspace theme can be either; the dashboard inherits via `[data-theme]`. Set `data-theme="holaos-dark"` on `<html>` to verify dark renders correctly.

## Examples

```
User: "Build a GitHub work tracker dashboard"
→ Shape 1 (queue / feed). Rows = issues + PRs, grouped by today / this week / older.
  Status mapping: open → info, in_progress → success, closed → muted, failed → destructive.
  Replace `sample-data.ts` with a server function reading from your `app.resource("issue")` rows.

User: "Make me a Notion page tracker"
→ Shape 2 (dense table). One row per page, columns: title / database / author / last-edited / status.
  No attention strip; just one flat sortable table.

User: "I want to see my Linear issues organized by status"
→ Shape 3 (kanban). Columns: backlog / todo / in-progress / done / canceled. Cards have title + assignee + priority.

User: "I want to manage my Mailchimp campaigns"
→ Shape 1 (queue / feed) grouped by send time — campaigns are time-ordered drafts → scheduled → sent, exactly the messaging metaphor.

User: "I want a calendar of my upcoming gcal events"
→ Shape 5 (calendar week). Compose from `Calendar` primitive; this is the least-tested shape, expect to iterate.
```

## When you're done

Run through this list — if any item is uncertain, fix before declaring done:

1. `bun install` in the app dir → exit 0
2. `bun run server.ts` → "MCP server listening on :<port>" AND dashboard responds on `:$PORT`
3. `curl http://localhost:<PORT>/` returns a TanStack Start HTML response, NOT the SDK's "headless module" placeholder (search for `headless module` in the response body)
4. Open the dashboard in the desktop iframe. Visually:
   - Fonts are Inter + Source Serif 4 (NOT Times / system-ui)
   - Connection pill shows correct state (Connected / Reauth / Not connected)
   - Empty state renders when filtered to a status with no rows
   - Hover affordances on rows (subtle bg shift, no shadow lift)
   - Light mode AND dark mode both look intentional (set `data-theme="holaos-dark"` on `<html>` to test)
5. The dashboard looks like the rest of the workspace (same fonts, borders, radii, card surface color). If it looks alien, you've broken a token import, imported from outside `@holaboss/ui`, or redefined a primitive.

If all 5 pass, you're done. **Do not invoke `interface-design`.** The build pass should already produce shipping-quality output via this skill + the bundled reference + the register-time lints.

If you later receive an `[Auto-queued post-build polish pass]` input for this app (the runtime queues one when a binding completes and unblocks `pendingIntegrations`), re-enter **this** skill — not `interface-design` — and re-evaluate `src/client/` against the bundled reference now that real data is wired in. That second pass is the safety net for cases the build-time agent finished before the integrations were connected, not a license to add chrome that this skill didn't already endorse.
