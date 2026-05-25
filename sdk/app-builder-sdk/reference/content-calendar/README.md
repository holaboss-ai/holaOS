# content-calendar (canonical calendar reference)

**Copy this whole `src/client/` into your new calendar-shaped app. Don't compose from scratch.**

This is one of four canonical dashboard shapes (alongside
`messaging-dashboard`, `engagement-inbox`, and `post-analytics`). Pick this reference when
your app's primary motion is **spatial planning across time** — weekly
content calendars, multi-channel publishing schedules, anything where
the user needs to see *density and gaps* at a glance.

This reference is the dimensional break from the other two: instead of
a single-column list (queue) or a 2-pane master-detail (inbox), it's a
7-column horizontal grid where each cell is a day. The whole point is
that you can see all 7 days at once and immediately spot "Thursday is
empty" or "Tuesday is stacked".

## Why a different shape from messaging-dashboard

| Concern | messaging-dashboard | content-calendar |
|---|---|---|
| Hero axis | Time (forward queue) | Time × channel (2D plane) |
| Reading mode | Vertical scroll a list | Horizontal scan a grid |
| Density signal | Implicit (longer list = more) | Explicit (per-cell count) |
| Empty state | Section hidden | Dashed-border `+` placeholder |
| Container | `max-w-3xl` single column | Full width, `grid-cols-7` |
| Card size | Full-width row, multi-line | ~64px compact card |
| Color use | Status dot only | Channel tint stripe on every card |
| Recovery flow | "Retry" failed sends | "Underbooked" soft whisper |

The grid breaks `max-w-3xl` because the whole point is *spatial
overview*. The README on `messaging-dashboard` allows this explicitly:
"No sidebar **unless the user's data has a real second navigation axis**".
For a calendar, **the week itself is the second axis** — you literally
cannot do weekly planning in a single column.

## What to change vs. what to keep

| File | Change | Keep |
|---|---|---|
| `lib/sample-data.ts` | Replace with TanStack Start server functions that read your `app.resource()` rows. Match the shape: `{ id, channel, dayIndex, timeLabel, title, status }` → your fields. Update `SAMPLE_WEEK_DATES` to come from a real date helper. | The `PostStatus` union (draft/scheduled/publishing/published/failed) — same `Record<…, { label, dot }>` mapping in `status-badge.tsx`. The `CHANNEL_META` shape (`{ label, letter, tint }`) for per-channel color. |
| `routes/index.tsx` | Page title (`"Calendar"`), subtitle copy, week range label → your domain wording. The hardcoded `TODAY_INDEX` → real `getDay()` math. | The 3-region structure (header → week nav → grid → legend). The spatial sketch comment at the top. |
| `components/week-grid.tsx` | The `WEEK_DAYS` import if your week starts on Sunday. The `underbookedBelow` threshold for your cadence. | The `grid-cols-7 gap-2` layout. The `min-h-[420px]` cell. The `DayHeader` density-count pattern. The empty-cell dashed-border `+` button. The "underbooked whisper" at the bottom of low-count cells. |
| `components/post-card.tsx` | The fields you show inside the card. | The 2px left-edge channel-tint stripe. The 3-cell top row (time / monogram / status). The `line-clamp-2` body. The compact ~64px height. No shadow lift on hover (`hover:bg-muted/60 hover:ring-fg-32`, no translate). |
| `components/week-nav.tsx` | Wire `onPrev/onNext/onToday` to real date math. | The chip group layout (icon buttons + Today). The range label + meta line. |
| `components/channel-legend.tsx` | Pass the channels actually used this week. | The footer placement (NOT in the header). The compact `size-2` color square + label. |
| `components/status-badge.tsx` | The `MAP` lookup → your states + chosen `StatusDot` variants. | The badge shape (StatusDot + label). |
| `components/header-bar.tsx` | Pass your title / subtitle / primary handler. | The whole component — no edits needed. |
| `components/connection-pill.tsx` | Wire `state` from `getIntegrationStatus()`. | The whole component. |
| `routes/__root.tsx` | Update `<title>`. | Both styles imports + the `data-theme` attribute. |

## What you may NOT change without explicit reason

- The 7-column grid. Don't switch to "list of days stacked vertically"
  on smaller screens without a real responsive strategy — the grid IS
  the reference. (Mobile = horizontal swipe day-at-a-time.)
- The per-cell **density count** in the column header. It's the single
  most important spatial signal in the page.
- The **empty-cell `+` placeholder**. Don't collapse empty days to
  whitespace — the dashed border carries the "click to add" affordance.
- The **2px channel-tint stripe** on post cards. Channel identification
  is the fastest job a cell needs to do; don't replace it with a row of
  icons. Tokens only (`bg-info`, `bg-primary`, `bg-warning`, etc.) — no
  hex / `oklch()` literals.
- The compact `~64px` post card height. Cards exist to be glanceable in
  a grid, not full-fidelity edit surfaces. Click → drawer/modal for edit.
- The legend in the FOOTER, not the header. The header band is reserved
  for "what week am I on"; legend is reference info.
- The `font-weight ≤ 500` rule. Hierarchy via size + color, not weight.
- No `font-bold` / `font-semibold` / inline `style={{ fontWeight: ... }}`.
- No second component library. Everything from `@holaboss/ui`.
- No `components/ui/` directory (shadcn-add copy).

## Required setup (lint-enforced)

Same Tailwind-compile setup as the other canonical references. The
`workspace_app_missing_tailwind_compile` lint rejects apps without it.

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

`vite.config.ts`:

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
 ┌────────────────────────────────────────────────────────────────────┐
 │  Calendar ○                              ● Connected · @joshua     │
 │  11 planned this week · agent will hold drafts until you publish   │
 ├────────────────────────────────────────────────────────────────────┤
 │  [<] [>] [Today]   May 26 – Jun 1, 2026   · 11 posts · 4 drafts   │
 ├──────┬──────┬──────┬──────┬──────┬──────┬─────────────────────────┤
 │ MON  │ TUE  │ WED  │ THU  │ FRI  │ SAT  │ SUN                     │
 │ 5/26 │ 5/27 │ 5/28 │ 5/29 │ 5/30 │ 5/31 │ 6/01                    │
 │  02  │  04  │  02  │  00  │  01  │  01  │  01  ← density          │
 ├──────┼──────┼──────┼──────┼──────┼──────┼─────────────────────────┤
 │ 09:00│ 08:00│ 10:00│      │ 12:00│ 09:30│ 18:00                   │
 │ in S │ X  S │ r  D │ [+]  │ tt D │ X  F │ ig S ← stripe on left   │
 │ Laun │ Morn │ AMA  │      │ Tren │ Reca │ Week                    │
 │      │ 11:00│ 15:00│      │      │      │                          │
 │ 12:30│ ig S │ yt P │      │      │      │                          │
 │ X  D │ BTS  │ Demo │      │      │      │                          │
 │ Quot │ 14:00│      │      │      │      │                          │
 │      │ in D │      │      │      │      │                          │
 │      │ Cust │      │      │      │      │                          │
 │      │ 16:00│      │·und. │      │·und. │·underbooked             │
 │      │ b  S │      │      │      │      │                          │
 ├──────┴──────┴──────┴──────┴──────┴──────┴─────────────────────────┤
 │ CHANNELS  ◼ X  ◼ in  ◼ ig  ◼ r  ◼ yt  ◼ tt  ◼ b                   │
 └────────────────────────────────────────────────────────────────────┘
```

## File map

```
src/client/
├── app.css                       — REQUIRED: @import "tailwindcss" + @source
├── routes/
│   ├── __root.tsx                — mounts both styles, sets data-theme
│   └── index.tsx                 — page composition (only stateful file)
├── components/
│   ├── header-bar.tsx            — serif title + status slot + Plan post
│   ├── connection-pill.tsx       — readiness chip (4 states)
│   ├── status-badge.tsx          — per-post status with colored dot
│   ├── week-nav.tsx              — prev/next/today + range label
│   ├── post-card.tsx             — compact card with channel-tint stripe
│   ├── week-grid.tsx             — 7-col grid + density + empty-cell + whisper
│   └── channel-legend.tsx        — footer color legend
└── lib/
    └── sample-data.ts            — REPLACE with SDK state reads + date helper
```

## If your app is genuinely different in shape

- **Month grid** (5 weeks × 7 days) — keep `WeekGrid` cell + `PostCard`;
  stack them into a 5×7 outer grid; post cards collapse to 1-line.
- **Channel-row × day-column** (rare; only when channel parity is the
  primary insight) — keep the column headers, add a left rail of channel
  labels, render cells as a flat `<grid>` of single cards.
- **Day view** (zoom into a single day) — keep `PostCard`; replace the
  7-col layout with a vertical hourly timeline (like Google Calendar
  day-view).

The compact card + the density-count signal + the per-channel tint
stripe are the load-bearing patterns; reuse them in any of the variants.
