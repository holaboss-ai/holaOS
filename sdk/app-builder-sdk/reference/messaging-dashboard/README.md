# messaging-dashboard (canonical queue reference)

**Copy this whole `src/client/` into your new dashboard app. Don't compose from scratch.**

This is the **queue** reference — one of four canonical dashboard shapes:

| Reference | Shape | When to use |
|---|---|---|
| **messaging-dashboard** (this) | Single-column timeline with rail | Forward-looking work that goes out on a schedule — outgoing posts, scheduled emails, queued jobs. The user's question is "what goes out next and when?" |
| [engagement-inbox](../engagement-inbox/) | Attio-style table + detail drawer + composer | Reactive work that comes in from outside — comments, mentions, DMs, reviews, support replies. The user's question is "what do I respond to next?" |
| [content-calendar](../content-calendar/) | 7-column weekly grid | Spatial planning across time — multi-channel publishing schedules. The user's question is "where are the gaps in my week?" |
| [post-analytics](../post-analytics/) | KPI strip + chart + post grid + digest rail | Measuring + auto-reporting — engagement metrics, scheduled email/Slack digests of those metrics. The user's question is "how is what I shipped performing, and what got reported out?" |

**Pick the shape from the user's question, not from your data model.** A
"posts" table can power any of the four depending on whether the user
is sending / responding / planning / measuring.

The layout, tokens, type system, hierarchy, spacing, header chrome, and
connection pill are decided and tested here. Your job when copying is to
**swap the data, labels, and copy** — NOT to redesign the page.

This avoids the failure mode where every fresh dashboard ships with a
default-shaped "single column of full-width cards with a KPI strip on top"
because that was the easiest thing for the agent to invent. The reference
sets a quality floor.

## What to change vs. what to keep

| File | Change | Keep |
|---|---|---|
| `lib/sample-data.ts` | Replace entirely with TanStack Start server functions that read your `app.resource()` rows. Match the shape: `{ id, channel, text, status, bucket, timeLabel, authorHandle }` → your fields. | The `MessageStatus` union pattern — your states get the same `Record<…, { label, dot }>` mapping in `status-badge.tsx`. |
| `routes/index.tsx` | Page title (`"Outgoing"`), subtitle copy, day-divider labels (`Today` / `Tomorrow` / `Later`) → your domain wording. The "now" label in `nowLabel` → real current time. | The 3-region structure (header → attention strip → grouped sections), `max-w-3xl` column, the spatial sketch comment at the top. |
| `components/messages-table.tsx` | Column meta (`#{channel} · author · time`) → your row's identifying fields. Body copy field. | The 3-col grid (`64px_16px_1fr_auto`), the rail (`bg-fg-32`), marker treatment (next vs. default), attention strip styling. |
| `components/status-badge.tsx` | The `MAP` lookup → your states + chosen `StatusDot` variants. | The badge shape (StatusDot + label, `text-fg-64`). |
| `components/header-bar.tsx` | Pass your title / subtitle / Compose handler. | The whole component — no edits needed. |
| `components/connection-pill.tsx` | Wire `state` from `getIntegrationStatus()` — `ready === true` → `"ready"`, etc. | The whole component. |
| `routes/__root.tsx` | Update `<title>`. | Both styles imports + the `data-theme` attribute. |

## What you may NOT change without explicit reason

- The `max-w-3xl` single-column shape. No sidebar unless the user's data has a real second navigation axis.
- The "no KPI strip" decision. Don't add stat cards because dashboards "usually have them".
- The `font-weight ≤ 500` rule. Hierarchy via size + color, not weight. The design system clamps higher weights anyway.
- The `bg-fg-32` rail color. Stronger looks loud, weaker disappears in dark mode.
- The 3-col `[64px_16px_1fr_auto]` row grid. The 16px middle column hosts the rail markers.
- Token-only colors. No hex / `rgb()` / `oklch()` literals (the register-time lint rejects these).
- No `font-bold` / `font-semibold` / inline `style={{ fontWeight: ... }}` (clamped to 500 anyway).
- No second component library. Everything from `@holaboss/ui`.
- No `components/ui/` directory (shadcn-add copy).

## Required setup (lint-enforced)

The app **must** ship a Tailwind compile entry alongside the library's
stylesheet, or every utility class you write under `src/client/` will be
silently dropped from the bundle. The register-time lint
`workspace_app_missing_tailwind_compile` rejects apps without it.

`src/client/app.css`:

```css
@import "tailwindcss";
@source "../client";
```

`src/client/routes/__root.tsx`:

```tsx
import "@holaboss/ui/styles.css";
import "../app.css";
```

`vite.config.ts` (or your bundler's equivalent):

```ts
import tailwind from "@tailwindcss/vite"
export default defineConfig({ plugins: [react(), tailwind()] })
```

`package.json` devDeps:

```json
{
  "devDependencies": {
    "@tailwindcss/vite": "^4.2.1",
    "tailwindcss": "^4.2.1"
  }
}
```

## Layout sketch

```
                ┌──────────────────────────────────────────────┐
                │  Outgoing ●            ● Connected · @joshua │  ← header
                │  5 queued · agent will send on schedule      │
                │                                              │
                │  NEEDS ATTENTION                             │
                │  ┌──────────────────────────────────────┐   │  ← attention strip
                │  │ #ops · Failed · 3h ago               │   │    (warning tint
                │  │  Composio rate-limit retry exhausted │   │     + Retry CTA)
                │  │  rate_limit_exceeded · last 14:32    │   │
                │  │                       [Retry] [Edit] │   │
                │  └──────────────────────────────────────┘   │
                │                                              │
                │  TODAY ─────────────────────────────── 02   │  ← day divider
                │  NOW · 08:42 ────────────────────────────    │  ← "now" cursor
                │  09:00 ● #general · ● Scheduled · @joshua    │  ← next-up marker
                │        Heads-up: the new pricing page…      │
                │  17:00 · #growth · ● Draft · @joshua         │
                │        Weekly recap — KPI strip…             │
                │                                              │
                │  TOMORROW ────────────────────────────── 02 │
                │  17:00 · #founders · ● Scheduled · @joshua   │
                │        Investor update reminder…             │
                │  …                                           │
                └──────────────────────────────────────────────┘
                          (centered max-w-3xl on bg-background)
```

## File map

```
src/client/
├── app.css                    — REQUIRED: @import "tailwindcss" + @source
├── routes/
│   ├── __root.tsx             — mounts both styles, sets data-theme
│   └── index.tsx              — page composition (only stateful file)
├── components/
│   ├── header-bar.tsx         — sans title + status slot + Compose
│   ├── connection-pill.tsx    — readiness chip (4 states)
│   ├── status-badge.tsx       — per-row status with colored dot
│   └── messages-table.tsx     — list rows + rail + attention strip
└── lib/
    └── sample-data.ts         — REPLACE with SDK state reads
```

## If your app is a genuinely different shape

Some apps don't fit the queue/feed pattern. For those, still start from
this reference, but expect to swap larger pieces:

- **Calendar / event list** → keep header + connection pill + app.css setup; replace `MessageList` with the `Calendar` primitive page.
- **Kanban / status board** → keep header + connection pill + app.css setup; replace the grouped sections with horizontally-scrolling status columns of cards.
- **Single-resource form** → keep header + connection pill + app.css setup; drop the grouped sections, render a `Field`-based form.
- **Chat / log** → keep header + connection pill + app.css setup; replace the list with a bottom-anchored chronological log + composer.

The technique (tokens, density, hierarchy without weight, primitive
composition) transfers; the row-with-rail pattern is queue-specific.
