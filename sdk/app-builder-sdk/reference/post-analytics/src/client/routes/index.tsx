/*
 * Spatial sketch — analytics dashboard, the "measure + report" shape
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ Twitter analytics ●        ● Connected · @joshua    [↓ Export CSV] │  ← header
 *   │ 8 posts tracked · last digest Today 18:00 · next in 4h              │
 *   ├─────────────────────────────────────────────────────────────────────┤
 *   │ [● Impressions] [● Engagement] [● Clicks] │ [24h][7d][30d]  ⌘K Search │  ← toolbar
 *   ├──────────────────────────────────────────────────────┬──────────────┤
 *   │ ┌──────────┐ ┌──────────┐ ┌──────────┐               │ DIGESTS   ⋯  │
 *   │ │ IMPR     │ │ ENGAGE   │ │ CLICKS   │  ← KPI tiles  │ Next in 4h   │
 *   │ │ 44K  +5%▲│ │ 2.0K +3%▲│ │ 285  -8%▼│               ├──────────────┤
 *   │ │ ▁▂▃▅▇    │ │ ▁▂▃▅▆    │ │ ▁▂▃▄▅    │               │ ✉ Today 18:00│
 *   │ └──────────┘ └──────────┘ └──────────┘               │ 8 · 44K · 2K │
 *   │                                                       │ [↗ Gmail]    │
 *   │ ╱╲                                          ___       ├──────────────┤
 *   │      ╲___       ___                       ╱           │ ✉ Yest 06:00 │
 *   │            ╲___╱   ╲___                ╱              │ 7 · 28K · 1K │
 *   │       :        :        :        :         :          │ [↗ Gmail]    │
 *   │     ckpt      ckpt    ckpt     ckpt       ckpt         ├──────────────┤
 *   │  02   06   10  14  18  22   02  06  10   14  18  22  │ ✉ 2d ago …   │
 *   ├──────────────────────────────────────────────────────┤              │
 *   │ POSTS (8)                                            │              │
 *   │ ┌─────────────────┐ ┌─────────────────┐              │              │
 *   │ │ Live · Mon 09   │ │ Live · Mon 12   │              │              │
 *   │ │ Just shipped t… │ │ 'Build small,…' │              │              │
 *   │ │ ◐12K ♥540 ↗92 ▁▇│ │ ◐4K ♥210 ↗14 ▁▇ │              │              │
 *   │ └─────────────────┘ └─────────────────┘              │              │
 *   │ …                                                    │              │
 *   └──────────────────────────────────────────────────────┴──────────────┘
 *                       flex (1fr)                              300px
 *
 *   Three-region analytics shape:
 *     1. KPI strip + line chart at top — aggregate trend across all posts.
 *        Vertical dotted lines on the chart mark CHECKPOINTS where a Gmail
 *        digest was sent. This is the cross-cut that ties the chart to
 *        the digest rail — without it, the email automation is invisible.
 *     2. Post cards below — drill-down per post with sparkline of the
 *        currently-selected metric. Eye carries continuity: same metric
 *        color from KPI tile → big chart → card sparkline.
 *     3. Right rail (300px) — chronological log of agent-sent digests.
 *        Each entry links back to the actual sent Gmail message.
 *
 *   Breaks the messaging-dashboard "no KPI strip" rule deliberately —
 *   that rule scopes to operational dashboards; analytics is a different
 *   archetype where the strip is load-bearing.
 */

import { useMemo, useState } from "react"
import { AnalyticsToolbar } from "../components/analytics-toolbar"
import { ConnectionPill } from "../components/connection-pill"
import { DigestRail } from "../components/digest-rail"
import { HeaderBar } from "../components/header-bar"
import { KpiStrip } from "../components/kpi-strip"
import { MetricChart } from "../components/metric-chart"
import { PostCard } from "../components/post-card"
import {
  CHECKPOINTS,
  METRIC_META,
  aggregateSeries,
  sampleDigests,
  samplePosts,
  type MetricKey,
} from "../lib/sample-data"

type RangeKey = "24h" | "7d" | "30d"

export function Dashboard() {
  const [metric, setMetric] = useState<MetricKey>("impressions")
  const [range, setRange] = useState<RangeKey>("7d")

  const chartValues = useMemo(() => aggregateSeries(metric), [metric])
  const stroke = METRIC_META[metric].stroke

  const latestDigest = sampleDigests[0]
  const subtitle = latestDigest
    ? `${samplePosts.length} posts tracked · last digest ${latestDigest.sentAt} · next in 4h`
    : `${samplePosts.length} posts tracked`

  return (
    <div className="flex min-h-screen w-full flex-col bg-background text-foreground">
      <HeaderBar
        title="Twitter analytics"
        subtitle={subtitle}
        rightSlot={<ConnectionPill state="ready" handle="@joshua" />}
        primaryLabel="Export CSV"
      />

      <AnalyticsToolbar
        metric={metric}
        onMetricChange={setMetric}
        range={range}
        onRangeChange={setRange}
      />

      <div className="grid flex-1 grid-cols-[1fr_300px] border-t border-border">
        <div className="flex min-h-0 flex-col gap-6 px-6 py-6">
          <KpiStrip active={metric} onSelect={setMetric} />

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[11px] tracking-[0.06em] text-fg-48 uppercase">
                {METRIC_META[metric].label} · per checkpoint
              </h2>
              <span className="font-mono text-[10px] text-fg-32 tabular-nums">
                {CHECKPOINTS.length} checkpoints
              </span>
            </div>
            <MetricChart
              values={chartValues}
              checkpoints={CHECKPOINTS}
              stroke={stroke}
            />
            <p className="mt-2 text-[10px] text-fg-48">
              Dotted vertical lines mark checkpoints where the agent sent a digest to Gmail.
            </p>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[11px] tracking-[0.06em] text-fg-48 uppercase">
                Posts <span className="font-mono text-fg-32">{samplePosts.length}</span>
              </h2>
              <span className="text-[10px] text-fg-48">
                sparkline shows {METRIC_META[metric].label.toLowerCase()}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {samplePosts.map((post) => (
                <PostCard key={post.id} post={post} activeMetric={metric} />
              ))}
            </div>
          </section>
        </div>

        <DigestRail digests={sampleDigests} nextInLabel="Next in 4h" />
      </div>
    </div>
  )
}

export default Dashboard
