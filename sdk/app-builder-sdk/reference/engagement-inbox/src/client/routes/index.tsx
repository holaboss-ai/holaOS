/*
 * Spatial sketch — Attio-style CRM inbox
 *
 *   ┌────────────────────────────────────────────────────────────────────────┐
 *   │  Inbox ●                           ● Connected · @joshua [Mark all r] │  ← page header
 *   │  4 unread · agent triages new mentions every 5 min                     │
 *   ├────────────────────────────────────────────────────────────────────────┤
 *   │  [All 7] [Mentions 2] [Comments 2] [DMs 2] [Reviews 1] │ ⌃Filter ↕Sort   ⌘K Search │  ← toolbar
 *   ├──────────────────────────────────────────────┬─────────────────────────┤
 *   │  PERSON       SOURCE   RE · LAST MSG  STAT TIME │ AV Lena Park  @lenacodes [↗][⋯] │  ← person card
 *   │ ●LP Lena Park [✕ twit] Pricing… Tried…  ●Unr 26h │    Engineering Lead · Loop      │
 *   │ ●MD Marco D.  [◫ inst] Bundle… Where…   ●Unr 42m │    [✕ twitter] · ●Unread · 4 prior │
 *   │   PS Priya Sh [in lnk] Launch… Curious… ◐Repl 2h │ ─────────────────────────────── │
 *   │ ●U/ u/forge_w [r/ red] r/SaaS… Honest…  ●Unr  5h │  ┌──────────────────────────┐  │  ← context callout
 *   │   AR Alex Rom [M  gml] Partner Followi  ◐Repl Tue │  │ REPLYING TO              │  │
 *   │   K  kev_l    [★ apps] 1.4.0   Love th  ✓Repd Wed │  │ Pricing page launch      │  │
 *   │ ●SK Sora Kim  [✕ twit] Guest…  Hey! Op  ●Unr  A14 │  └──────────────────────────┘  │
 *   │                                                  │  Tried the new pricing page…   │  ← body
 *   │                                                  │                                │
 *   │                                                  │  ┌──────────────────────────┐  │  ← composer
 *   │                                                  │  │ Write a reply…           │  │
 *   │                                                  │  │ [✨] [⋯]  [✓ R] [Reply]  │  │
 *   │                                                  │  └──────────────────────────┘  │
 *   └──────────────────────────────────────────────────┴─────────────────────────────┘
 *                          flex (1fr)                              640px
 *
 *   The list becomes a TABLE (not a card list). Why: this is reactive CRM
 *   work — you scan many rows for "who's waiting, what's overdue, what
 *   matters". Density + sortable columns + chip-shaped chrome beat
 *   message-card stacks for that job.
 *
 *   The detail still slides in from the right, but now leads with a
 *   compact PERSON CARD that reads like an Attio record header — name,
 *   role, source chip, status, prior-touch count. The conversation +
 *   composer follow below.
 */

import { useMemo, useState } from "react"
import { ConnectionPill } from "../components/connection-pill"
import { HeaderBar } from "../components/header-bar"
import { InboxTable } from "../components/inbox-table"
import { InboxToolbar } from "../components/inbox-toolbar"
import { ThreadDetail, ThreadDetailEmpty } from "../components/thread-detail"
import { sampleThreads, type ThreadKind } from "../lib/sample-data"

type FilterKey = "all" | ThreadKind

export function Dashboard() {
  const [activeId, setActiveId] = useState<string | null>(sampleThreads[0]?.id ?? null)
  const [filter, setFilter] = useState<FilterKey>("all")

  const { rows, counts } = useMemo(() => {
    const allCounts: Record<FilterKey, number> = {
      all: sampleThreads.length,
      mention: 0,
      comment: 0,
      dm: 0,
      review: 0,
    }
    for (const t of sampleThreads) allCounts[t.kind] += 1
    const filtered =
      filter === "all" ? sampleThreads : sampleThreads.filter((t) => t.kind === filter)
    return { rows: filtered, counts: allCounts }
  }, [filter])

  const active = sampleThreads.find((t) => t.id === activeId) ?? null
  const unreadCount = sampleThreads.filter((t) => t.status === "unread").length

  return (
    <div className="flex min-h-screen w-full flex-col bg-background text-foreground">
      <HeaderBar
        title="Inbox"
        subtitle={`${unreadCount} unread · agent triages new mentions every 5 min`}
        rightSlot={<ConnectionPill state="ready" handle="@joshua" />}
        primaryLabel="Mark all read"
      />

      <InboxToolbar active={filter} onChange={setFilter} counts={counts} />

      <div className="grid flex-1 grid-cols-[1fr_560px] border-t border-border">
        <div className="min-h-0">
          <InboxTable rows={rows} activeId={activeId} onSelect={setActiveId} />
        </div>
        <section className="min-h-0 border-l border-border">
          {active ? <ThreadDetail row={active} /> : <ThreadDetailEmpty />}
        </section>
      </div>
    </div>
  )
}

export default Dashboard
