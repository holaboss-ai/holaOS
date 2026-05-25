# post-analytics (canonical analytics reference)

**Copy this whole `src/client/` into your new analytics-shaped app. Don't compose from scratch.**

This is the **measure + report** reference — one of four canonical
dashboard shapes:

| Reference | Shape | When to use |
|---|---|---|
| [messaging-dashboard](../messaging-dashboard/) | Single-column timeline + rail | Sending: outgoing queue |
| [engagement-inbox](../engagement-inbox/) | Attio-style table + detail | Responding: comments / mentions / DMs |
| [content-calendar](../content-calendar/) | 7-column weekly grid | Planning: cross-channel cadence |
| **post-analytics** (this) | **KPI strip + chart + post grid + digest rail** | **Measuring + auto-reporting** |

**Pick the shape from the user's question, not from your data model.** A
"posts" table can power any of the four depending on whether the user
is sending / responding / planning / measuring.

The composition (3-region layout, SVG chart, sparkline reuse, digest rail
as the side surface that makes scheduled email automation tangible) is
decided and tested here. Your job when copying is to **swap the data,
labels, and copy** — NOT to redesign the page.

## Why a different shape from the other three

| Concern | Other 3 references | post-analytics |
|---|---|---|
| Hero artifact | List / table / grid | **Line chart + KPI tiles** |
| Color use | Status dots / channel chips | **Per-metric line color carried from KPI tile → chart line → card sparkline** |
| Side surfaces | Composer / detail pane | **Digest rail showing sent emails** |
| Special rule | "No KPI strip" enforced | **KPI strip is the centerpiece** |

**The KPI strip is intentional here.** The messaging-dashboard README
forbids KPI strips because they default-pollute operational dashboards.
For an analytics dashboard, the KPI strip *is* the operational signal —
banning it would be dogma.

## What to change vs. what to keep

| File | Change | Keep |
|---|---|---|
| `lib/sample-data.ts` | Replace with TanStack Start server functions that read your `app.resource()` rows. Match the shape: `{ id, body, postedAt, status, totals, series }` → your fields. Update `CHECKPOINTS` from real timestamps. | The `MetricKey` union (impressions/engagement/clicks) — same `Record<…, { label, stroke, tint }>` mapping in `METRIC_META`. The `aggregateSeries(metric)` / `trendDelta(metric)` helpers — these are pure utilities. The `digestSent` boolean on checkpoints (drives the chart's dotted vertical markers). |
| `routes/index.tsx` | Page title (`"Twitter analytics"`), subtitle copy, default selected metric/range. | The 3-region grid (`grid-cols-[1fr_300px]`), the order (KPI strip → chart → posts grid), the spatial sketch comment at the top. |
| `components/metric-chart.tsx` | The single-metric line rendering is correct as-is — only change is the formatNumber helper if your metric scale differs (e.g. ratios, durations). | The viewBox + padding constants. The dotted vertical lines at `cp.digestSent === true`. The y-axis gridlines at 0/25/50/75/100%. The `vectorEffect="non-scaling-stroke"` on the line path. |
| `components/sparkline.tsx` | The width/height props for context. | The whole component — reused by KPI tiles AND post cards. |
| `components/kpi-strip.tsx` | The metric tile rendering is correct as-is — only change is `formatBig` if your scale differs. | The "click-to-select" tile interaction (clicking a KPI tile re-selects the chart's metric). The trend chip pattern (arrow + percent, success/destructive tinted). |
| `components/post-card.tsx` | The metric pills + card body fields → yours. | The card structure (meta row → body clamp → metrics + sparkline footer). The active-metric carry-through: same metric color from KPI strip → chart → this card's sparkline. |
| `components/digest-rail.tsx` | The DigestEntry shape + Gmail deep-link → your real artifact (could be Slack, could be a notion page, could be a saved report URL). | The rail layout (300px, sticky border-left, header with "Next in Xh" hint, time-mono timestamps). The entry structure (mail icon + time + post count + metric summary dots + deep link). |
| `components/analytics-toolbar.tsx` | The metric / range pills → yours. | The segmented-control chip group pattern. The ⌘K search hint. |
| `components/status-badge.tsx` | The `MAP` lookup → your post-status states. | The badge shape (StatusDot + label, `text-fg-64`). |
| `components/header-bar.tsx` | Pass your title / subtitle / Export handler. | The whole component — no edits needed. |
| `components/connection-pill.tsx` | Wire `state` from `getIntegrationStatus()`. | The whole component. |
| `routes/__root.tsx` | Update `<title>`. | Both styles imports + the `data-theme` attribute. |

## What you may NOT change without explicit reason

- The 3-region structure. Don't fold the digest rail into a tab, don't
  move the chart to the bottom. The reading order — *headline number →
  trend chart → drill-down per post → what got reported* — is the user
  journey of an analytics dashboard.
- The **per-metric color carry-through**. The same `var(--info)` stroke
  must appear on the Impressions KPI sparkline, the big chart line when
  Impressions is selected, AND each post card's sparkline when
  Impressions is selected. Without this the page feels like 3 unrelated
  widgets stacked.
- The **dotted vertical chart markers** at `digestSent` checkpoints.
  These are the cross-cut that ties chart to digest rail. Removing them
  makes the email automation invisible.
- The "click a KPI tile to switch the chart metric" interaction. Cheaper
  than a dropdown, and it makes the KPI strip feel alive instead of
  decorative.
- The 1.5px chart line + `vectorEffect="non-scaling-stroke"`. Without
  the vector effect, the line thins out on wide screens and thickens on
  narrow ones — looks broken.
- The single-metric line chart. Do NOT multi-line different metrics on
  one chart with different scales (impressions in 10Ks, clicks in 10s
  cannot share a y-axis honestly).
- Token-only colors. No hex / `rgb()` / `oklch()` literals. SVG strokes
  use `var(--info)` etc.
- The `font-weight ≤ 530` rule (the design system clamps higher weights
  to 530). Hierarchy via size + color, not weight.
- No second component library. Everything from `@holaboss/ui` + raw SVG.
  No `recharts`, no `chart.js`, no `visx` — the chart is intentionally
  hand-rolled SVG so the reference has no extra deps.
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
 ┌─────────────────────────────────────────────────────────────────────┐
 │ Twitter analytics ●        ● Connected · @joshua    [↓ Export CSV] │
 │ 8 posts tracked · last digest Today 18:00 · next in 4h              │
 ├─────────────────────────────────────────────────────────────────────┤
 │ [● Impressions] [● Engagement] [● Clicks] │ [24h][7d][30d]  ⌘K Search │
 ├──────────────────────────────────────────────────────┬──────────────┤
 │ ┌──────────┐ ┌──────────┐ ┌──────────┐               │ DIGESTS   ⋯  │
 │ │ IMPR     │ │ ENGAGE   │ │ CLICKS   │  ← KPI tiles  │ Next in 4h   │
 │ │ 44K  +5%▲│ │ 2.0K +3%▲│ │ 285  -8%▼│   (click to   ├──────────────┤
 │ │ ▁▂▃▅▇    │ │ ▁▂▃▅▆    │ │ ▁▂▃▄▅    │    switch    │ ✉ Today 18:00│
 │ └──────────┘ └──────────┘ └──────────┘    chart)     │ 8 · 44K · 2K │
 │                                                       │ [↗ Gmail]    │
 │  44K ── ── ── ── ── ── ── ── ── ── ── ── ──          ├──────────────┤
 │       ▲       ▲       ▲       ▲        ← digest      │ ✉ Yest 06:00 │
 │  33K  :       :       :       :          markers      │ 7 · 28K · 1K │
 │       :       :       :       :   _________          │ [↗ Gmail]    │
 │  22K  :       :       :    ___/                       ├──────────────┤
 │       :       :       _/  :                           │ ✉ 2d ago 18  │
 │  11K  :    ___:   ___/    :       :                   │ 4 · 13K …    │
 │      _:___/   :__/        :       :                   │              │
 │   0  :        :           :       :                   │              │
 │      02   06  10  14  18  22  02  06  10  14  18  22 │              │
 │ Dotted vertical lines mark digest checkpoints.       │              │
 ├──────────────────────────────────────────────────────┤              │
 │ POSTS 8                                              │              │
 │ ┌─────────────────┐ ┌─────────────────┐              │              │
 │ │ Live · Mon 09   │ │ Live · Mon 12   │              │              │
 │ │ Just shipped t… │ │ 'Build small…'  │              │              │
 │ │ ◐12K ♥540 ↗92 ▁▇│ │ ◐4K ♥210 ↗14 ▁▇│              │              │
 │ └─────────────────┘ └─────────────────┘              │              │
 │ …                                                    │              │
 └──────────────────────────────────────────────────────┴──────────────┘
                       flex (1fr)                            300px
```

## File map

```
src/client/
├── app.css                       — REQUIRED: @import "tailwindcss" + @source
├── routes/
│   ├── __root.tsx                — mounts both styles, sets data-theme
│   └── index.tsx                 — 3-region composition (only stateful file)
├── components/
│   ├── header-bar.tsx            — sans title + status slot + Export CSV
│   ├── connection-pill.tsx       — readiness chip (4 states)
│   ├── status-badge.tsx          — per-post status with colored dot
│   ├── analytics-toolbar.tsx     — metric + range segmented controls
│   ├── kpi-strip.tsx             — 3 click-to-select metric tiles
│   ├── metric-chart.tsx          — single-metric SVG line chart + digest markers
│   ├── sparkline.tsx             — tiny SVG sparkline reused everywhere
│   ├── post-card.tsx             — per-post drill-down card
│   └── digest-rail.tsx           — right-rail sent-email log
└── lib/
    └── sample-data.ts            — REPLACE with SDK state reads
```

## If your app is genuinely different in shape

- **Single-metric obsession** (e.g. "track only impressions, no other
  metrics") — drop the `analytics-toolbar` metric pills and the KPI
  strip; keep the chart + post cards + digest rail. Metric becomes a
  type-level constant rather than runtime state.
- **No automation** (no Gmail digests) — drop the `digest-rail` and the
  chart's dotted vertical markers. Pane becomes `grid-cols-[1fr]`.
- **Real-time stream** (live tail of new posts) — keep this structure
  but add a `<NewPostBanner />` between toolbar and KPI strip showing
  "3 new posts since last refresh", and a manual "Refresh" affordance.
- **Comparison view** (this period vs. last period) — render TWO chart
  lines on the same chart, in the same metric color but one solid
  (current) and one dashed (previous). KPI tiles already show a delta —
  reuse the same comparison source.

The technique (token-driven palette, density, per-metric color
carry-through, raw SVG chart, sparkline reuse, digest rail as the
side surface for automation history) transfers. Don't pull in a charting
library — the hand-rolled SVG is the reference.
