import { Eye, Heart, MousePointerClick } from "lucide-react"
import {
  METRIC_META,
  type MetricKey,
  type Post,
} from "../lib/sample-data"
import { Sparkline } from "./sparkline"
import { StatusBadge } from "./status-badge"

function formatBig(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n.toString()
}

const METRIC_ICONS: Record<MetricKey, typeof Eye> = {
  impressions: Eye,
  engagement: Heart,
  clicks: MousePointerClick,
}

type Props = {
  post: Post
  /** Which metric to drive the card's hero sparkline. Matches the parent
   *  chart's selected metric so the eye carries continuity from the global
   *  trend down to the per-post drill-down. */
  activeMetric: MetricKey
}

// One post — body + 3 inline metric pills + a hero sparkline of the active
// metric. Designed to fit a 2-column grid at desktop, 1-column at narrow.
//
// Visual hierarchy inside the card:
//   - meta row (status badge + posted-at) — small + muted
//   - body — 2-line clamp, reads like a tweet
//   - bottom row: 3 metric pills (icon + number) on the left, sparkline on
//     the right. Active-metric pill picks up the metric tint as text color.
export function PostCard({ post, activeMetric }: Props) {
  const activeMeta = METRIC_META[activeMetric]
  return (
    <article className="group flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-fg-24">
      <div className="flex items-center gap-2 text-[11px] text-fg-48">
        <StatusBadge status={post.status} />
        <span aria-hidden>·</span>
        <span className="font-mono tabular-nums">{post.postedAt}</span>
      </div>

      <p className="line-clamp-2 text-[13px] leading-relaxed text-foreground">
        {post.body}
      </p>

      <div className="mt-auto flex items-end justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {(Object.keys(METRIC_META) as MetricKey[]).map((key) => {
            const Icon = METRIC_ICONS[key]
            const isActive = key === activeMetric
            return (
              <span
                key={key}
                className={[
                  "inline-flex items-center gap-1 text-[11px] tabular-nums",
                  isActive ? "text-foreground" : "text-fg-64",
                ].join(" ")}
              >
                <Icon className="size-3 text-fg-48" />
                {formatBig(post.totals[key])}
              </span>
            )
          })}
        </div>

        <Sparkline
          values={post.series[activeMetric]}
          stroke={activeMeta.stroke}
          width={72}
          height={20}
          filled
        />
      </div>
    </article>
  )
}
