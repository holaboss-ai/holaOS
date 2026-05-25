import { ArrowDown, ArrowUp, Minus } from "lucide-react"
import {
  METRIC_META,
  aggregateSeries,
  trendDelta,
  type MetricKey,
} from "../lib/sample-data"
import { Sparkline } from "./sparkline"

function formatBig(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return Math.round(n).toString()
}

function TrendChip({ delta }: { delta: number }) {
  const rounded = Math.round(delta)
  if (rounded === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-fg-48">
        <Minus className="size-2.5" />
        flat
      </span>
    )
  }
  const isUp = rounded > 0
  const Icon = isUp ? ArrowUp : ArrowDown
  return (
    <span
      className={[
        "inline-flex items-center gap-0.5 text-[10px]",
        isUp ? "text-success-text" : "text-destructive-text",
      ].join(" ")}
    >
      <Icon className="size-2.5" />
      {Math.abs(rounded)}%
    </span>
  )
}

type Props = {
  /** Which metric tile is "active" — gets a stronger border + the chart
   *  below is showing this metric's series. */
  active: MetricKey
  onSelect: (m: MetricKey) => void
}

// Three KPI tiles side-by-side. Each shows:
//   - metric label (mono uppercase, fg-48)
//   - current total (big number)
//   - trend chip (% delta vs previous checkpoint, with arrow)
//   - 80px sparkline in metric color
//
// Clicking a tile re-selects which metric the big chart below shows.
// The active tile gets a foreground border + slightly bolder text;
// inactive tiles read as muted but still clickable.
export function KpiStrip({ active, onSelect }: Props) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {(Object.keys(METRIC_META) as MetricKey[]).map((key) => {
        const meta = METRIC_META[key]
        const series = aggregateSeries(key)
        const total = series[series.length - 1] ?? 0
        const delta = trendDelta(key)
        const isActive = key === active
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            className={[
              "group flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors",
              isActive
                ? "border-fg-32 bg-card"
                : "border-border bg-card hover:border-fg-24",
            ].join(" ")}
          >
            <div className="flex w-full items-center justify-between">
              <span className="flex items-center gap-1.5 text-[10px] tracking-[0.06em] text-fg-48 uppercase">
                <span
                  aria-hidden
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: meta.stroke }}
                />
                {meta.label}
              </span>
              <TrendChip delta={delta} />
            </div>
            <div className="flex w-full items-end justify-between">
              <span
                className={[
                  "font-mono tabular-nums",
                  isActive ? "text-foreground" : "text-fg-80",
                  "text-[24px] leading-none",
                ].join(" ")}
              >
                {formatBig(total)}
              </span>
              <span className="text-fg-48">
                <Sparkline values={series} stroke={meta.stroke} width={88} height={22} filled />
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
