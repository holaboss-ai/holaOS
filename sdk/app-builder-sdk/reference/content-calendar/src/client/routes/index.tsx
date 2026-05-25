/*
 * Spatial sketch
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │  Calendar ○                              ● Connected · @joshua     │  ← header
 *   │  11 planned this week · agent will hold drafts until you publish   │
 *   ├────────────────────────────────────────────────────────────────────┤
 *   │  [<] [>] [Today]   May 26 – Jun 1   · 11 posts · 4 drafts          │  ← week nav
 *   ├──────┬──────┬──────┬──────┬──────┬──────┬─────────────────────────┤
 *   │ MON  │ TUE  │ WED  │ THU  │ FRI  │ SAT  │ SUN                     │  ← day headers
 *   │ 5/26 │ 5/27 │ 5/28 │ 5/29 │ 5/30 │ 5/31 │ 6/01                    │
 *   │  02  │  04  │  02  │  00  │  01  │  01  │  01                     │  ← density
 *   ├──────┼──────┼──────┼──────┼──────┼──────┼─────────────────────────┤
 *   │ 09:00│ 08:00│ 10:00│      │ 12:00│ 09:30│ 18:00                   │
 *   │ in● S│ X  S │ r  D │ [+]  │ tt D │ X  F │ ig S                    │  ← post cards
 *   │ Laun.│ Morn │ AMA  │      │ Tren │ Reca │ Week                    │     (channel tint
 *   │      │      │      │      │      │      │                          │      stripe on left)
 *   │ 12:30│ 11:00│ 15:00│      │      │      │                          │
 *   │ X  D │ ig S │ yt P │      │      │      │                          │
 *   │ Quot │ BTS  │ Demo │      │      │      │                          │
 *   │      │ 14:00│      │      │      │      │                          │
 *   │      │ in D │      │      │      │      │                          │
 *   │      │ Cust │      │      │      │      │                          │
 *   │      │      │      │      │      │      │                          │
 *   │      │ 16:00│      │ ·und.│      │·und. │ ·underbooked            │  ← whisper
 *   │      │ b  S │      │      │      │      │                          │
 *   ├──────┴──────┴──────┴──────┴──────┴──────┴─────────────────────────┤
 *   │ CHANNELS  ◼ X  ◼ in  ◼ ig  ◼ r  ◼ yt  ◼ tt  ◼ b                   │  ← legend (footer)
 *   └────────────────────────────────────────────────────────────────────┘
 *
 *   The grid IS the page. Three signal layers carry the planning insight:
 *     1. Per-cell DENSITY COUNT in the column header — spot stacked days.
 *     2. EMPTY CELL placeholder (dashed border + hover +) — spot blank days.
 *     3. UNDERBOOKED WHISPER at the bottom of low-count cells — soft nudge,
 *        not a warning, because "1 post is fine" depends on cadence.
 *
 *   No max-w-3xl. The whole point is to see all 7 days at once.
 */

import { ConnectionPill } from "../components/connection-pill"
import { HeaderBar } from "../components/header-bar"
import { ChannelLegend } from "../components/channel-legend"
import { WeekGrid } from "../components/week-grid"
import { WeekNav } from "../components/week-nav"
import { type Channel, samplePosts } from "../lib/sample-data"

const TODAY_INDEX = 1
const RANGE_LABEL = "May 26 – Jun 1, 2026"

const UNIQUE_CHANNELS: Channel[] = Array.from(
  new Set(samplePosts.map((p) => p.channel)),
) as Channel[]

export function Dashboard() {
  const totalCount = samplePosts.length
  const draftCount = samplePosts.filter((p) => p.status === "draft").length

  return (
    <div className="flex min-h-screen w-full flex-col bg-background text-foreground">
      <HeaderBar
        title="Calendar"
        subtitle={`${totalCount} planned this week · agent will hold drafts until you publish`}
        rightSlot={<ConnectionPill state="ready" handle="@joshua" />}
        primaryLabel="Plan post"
      />
      <WeekNav
        rangeLabel={RANGE_LABEL}
        meta={`${totalCount} posts · ${draftCount} drafts`}
      />
      <div className="flex-1">
        <WeekGrid posts={samplePosts} todayIndex={TODAY_INDEX} underbookedBelow={2} />
      </div>
      <ChannelLegend channels={UNIQUE_CHANNELS} />
    </div>
  )
}

export default Dashboard
