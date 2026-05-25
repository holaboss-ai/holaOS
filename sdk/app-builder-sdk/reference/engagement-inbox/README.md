# engagement-inbox (canonical inbox reference)

**Copy this whole `src/client/` into your new inbox-shaped app. Don't compose from scratch.**

This is one of four canonical dashboard shapes (alongside
`messaging-dashboard`, `content-calendar`, and `post-analytics`). Pick this reference when
your app's primary motion is **read → react** — comments, mentions, DMs,
reviews, support replies, anything where the user is *responding to
things other people sent in*. The shape is master-detail (list + open
thread + composer), NOT a single-column queue, because reactive work
needs the original context and the reply box on screen at the same time.

If your app's primary motion is "send things out on a schedule", use
`messaging-dashboard` instead. If it's "plan content density across the
week", use `content-calendar`.

## Why a different shape from messaging-dashboard

| Concern | messaging-dashboard | engagement-inbox |
|---|---|---|
| Hero axis | Time (when does this go out) | Person (who is engaging) |
| Sort order | Chronological forward | Priority bucket → recency |
| Reading mode | Glance + edit | Read + reply |
| Container | `max-w-3xl` single column | full-width 2-pane `380px / 1fr` |
| Lead column | Time + rail marker | Avatar + kind pip |
| Recovery flow | "Retry" failed sends (attention strip) | "Reply now" missed SLA (overdue strip) |
| Composer | Side modal (out of frame) | Anchored at bottom of detail pane |

The composer placement is the load-bearing difference. In an outgoing
queue the composer is rarely open (you set things up once); in an inbox
you open it dozens of times per session, so it lives on screen.

## What to change vs. what to keep

| File | Change | Keep |
|---|---|---|
| `lib/sample-data.ts` | Replace with TanStack Start server functions that read your `app.resource()` rows. Match the shape: `{ id, channel, kind, authorName, authorHandle, body, contextLabel, status, bucket, timeLabel }` → your fields. | The `ThreadStatus` union pattern (unread/replying/replied/resolved/escalated) → same `Record<…, { label, dot }>` mapping in `status-badge.tsx`. The `ThreadKind` union (`mention | comment | dm | review`) → the `KindIcon` pip on the avatar. |
| `routes/index.tsx` | Page title (`"Inbox"`), subtitle copy, filter tab labels → your domain wording. | The 2-pane grid (`grid-cols-[380px_1fr]`), the filter-tabs-above-list layout, the spatial sketch comment at the top. |
| `components/thread-list-item.tsx` | The fields you display in the list row → yours. | The compact 8px avatar + name lead + 2-line snippet + corner kind-pip pattern. The unread-dot in the gutter. |
| `components/thread-detail.tsx` | The quoted-context block + body + composer fields → yours. | The 3-region structure (header → context+body → composer). The `border-l-2` quoted-context treatment. The composer button order (Suggest → Reply on the right). |
| `components/inbox-filters.tsx` | The tab keys + labels → yours. | The chip-style tab + inline count pattern. |
| `components/status-badge.tsx` | The `MAP` lookup → your states + chosen `StatusDot` variants. | The badge shape (StatusDot + label, `text-fg-64`). |
| `components/header-bar.tsx` | Pass your title / subtitle / primary handler. | The whole component — no edits needed. |
| `components/connection-pill.tsx` | Wire `state` from `getIntegrationStatus()`. | The whole component. |
| `routes/__root.tsx` | Update `<title>`. | Both styles imports + the `data-theme` attribute. |

## What you may NOT change without explicit reason

- The 2-pane `[380px_1fr]` grid. Don't collapse it to single-column "for
  mobile" without a real responsive strategy — the inbox shape *is* the
  reference. (Mobile = stack panes with a route param.)
- Person-first list rows. Don't lead with `#channel · @author` like the
  messaging dashboard — for an inbox the human is the hero, the channel
  is metadata.
- The composer pinned to the bottom of the detail pane. Don't move it
  into a modal or a side drawer — its whole job is to be on screen.
- The `font-weight ≤ 500` rule. Hierarchy via size + color, not weight.
- Token-only colors. No hex / `rgb()` / `oklch()` literals.
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
 ┌────────────────────────────────────────────────────────────────┐
 │  Inbox ●          ● Connected · @joshua    [Mark all read]    │  ← header (full width)
 │  4 unread · agent triages new mentions every 5 min            │
 ├──────────────────────────┬─────────────────────────────────────┤
 │ [All Mentions Comments…] │ twitter · Mention · ● Unread   26h  │  ← detail header
 │                          │ Lena Park  @lenacodes                │
 │  ● Lena Park       26h   │                                      │
 │    Post · Pricing page   │ │ Replying to                        │  ← quoted context
 │    Tried the new pricing │ │ Post · Pricing page launch         │
 │  ───────────────────     │                                      │
 │  ● Marco D.        42m   │ Tried the new pricing page — the    │  ← actual body
 │    Reel · Bundle teaser  │ 'team' tier copy is a little…       │
 │    Where's the link for  │                                      │
 │  ───────────────────     │                                      │
 │  Priya Shah         2h   │ ┌──────────────────────────────────┐ │
 │    Post · Launch announ. │ │ Write a reply…                   │ │  ← composer
 │    Curious how this com  │ │ [✨ Suggest] … [Resolve] [Reply] │ │     (anchored)
 │  ───────────────────     │ └──────────────────────────────────┘ │
 │  …                       │                                      │
 └──────────────────────────┴─────────────────────────────────────┘
                      380px              flex (1fr)
```

## File map

```
src/client/
├── app.css                       — REQUIRED: @import "tailwindcss" + @source
├── routes/
│   ├── __root.tsx                — mounts both styles, sets data-theme
│   └── index.tsx                 — 2-pane composition (only stateful file)
├── components/
│   ├── header-bar.tsx            — serif title + status slot + Mark all read
│   ├── connection-pill.tsx       — readiness chip (4 states)
│   ├── status-badge.tsx          — per-thread status with colored dot
│   ├── inbox-filters.tsx         — kind-filter tabs above the list
│   ├── thread-list-item.tsx      — compact triage row (left pane)
│   └── thread-detail.tsx         — open conversation + composer (right pane)
└── lib/
    └── sample-data.ts            — REPLACE with SDK state reads
```

## If your app is genuinely different in shape

If you have a real second-axis besides the open thread (e.g. multi-account
inbox where the user also switches accounts), add a *narrow* 64px rail on
the far left for account switching — but do NOT turn the layout into 3
equal panes. The detail pane is the hero; everything else negotiates
around it.
