import type { Checkpoint } from "../lib/sample-data"

type Props = {
  /** Y-values, one per checkpoint. */
  values: number[]
  /** X-axis source — same length as values. Used for axis labels + the
   *  dotted "digest sent" vertical markers. */
  checkpoints: Checkpoint[]
  /** Token-driven stroke for the line, e.g. "var(--info)". */
  stroke: string
}

const W = 600
const H = 200
const PAD = { l: 40, r: 12, t: 12, b: 28 }
const INNER_W = W - PAD.l - PAD.r
const INNER_H = H - PAD.t - PAD.b
const GRID_FRACS = [0, 0.25, 0.5, 0.75, 1]

function formatNumber(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}K`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return Math.round(n).toString()
}

// SVG time-series chart for ONE metric across checkpoints. Single line, not
// multi-line, because impressions (10K+) and clicks (10s) cannot share a
// y-axis honestly. Metric switching lives in the parent toolbar.
//
// Notable layers, back-to-front:
//   1. Horizontal gridlines (0/25/50/75/100%) — anchor the y-scale
//   2. Y-axis labels (mono, 9px, fg-48) — left margin
//   3. Dotted vertical lines at checkpoints where digest was sent — these are
//      the cross-cutting "agent emailed here" markers. Without these the chart
//      has no relationship to the digest-log rail.
//   4. The actual line (1.5px) + dots at each data point
//   5. X-axis labels — show every 3rd checkpoint + the last, to avoid clutter
//
// `viewBox` + `width="100%"` makes this responsive within any parent width.
export function MetricChart({ values, checkpoints, stroke }: Props) {
  const maxVal = Math.max(...values, 1)
  const x = (i: number) =>
    PAD.l + (INNER_W * i) / Math.max(values.length - 1, 1)
  const y = (v: number) => PAD.t + INNER_H - INNER_H * (v / maxVal)

  const linePath = values
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`,
    )
    .join(" ")

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="block w-full"
      role="img"
    >
      {GRID_FRACS.map((f) => {
        const yPos = PAD.t + INNER_H * (1 - f)
        return (
          <line
            key={`g-${f}`}
            x1={PAD.l}
            x2={W - PAD.r}
            y1={yPos}
            y2={yPos}
            stroke="var(--border)"
            strokeWidth={0.5}
          />
        )
      })}

      {GRID_FRACS.map((f) => {
        const yPos = PAD.t + INNER_H * (1 - f)
        return (
          <text
            key={`yl-${f}`}
            x={PAD.l - 6}
            y={yPos + 3}
            textAnchor="end"
            fontSize="9"
            fontFamily="var(--font-mono)"
            fill="var(--fg-48)"
          >
            {formatNumber(maxVal * f)}
          </text>
        )
      })}

      {checkpoints.map((cp, i) => {
        if (!cp.digestSent) return null
        const xPos = x(i)
        return (
          <g key={`d-${i}`}>
            <line
              x1={xPos}
              x2={xPos}
              y1={PAD.t}
              y2={PAD.t + INNER_H}
              stroke="var(--fg-32)"
              strokeWidth={1}
              strokeDasharray="2 3"
            />
            <circle
              cx={xPos}
              cy={PAD.t - 2}
              r={2}
              fill="var(--fg-48)"
            />
          </g>
        )
      })}

      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />

      {values.map((v, i) => (
        <circle
          key={`pt-${i}`}
          cx={x(i)}
          cy={y(v)}
          r={2}
          fill={stroke}
        />
      ))}

      {checkpoints.map((cp, i) => {
        const isLast = i === checkpoints.length - 1
        if (i % 3 !== 0 && !isLast) return null
        return (
          <text
            key={`xl-${i}`}
            x={x(i)}
            y={H - 8}
            textAnchor="middle"
            fontSize="9"
            fontFamily="var(--font-mono)"
            fill="var(--fg-48)"
          >
            {cp.label}
          </text>
        )
      })}
    </svg>
  )
}
