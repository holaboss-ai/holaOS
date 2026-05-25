type Props = {
  values: number[]
  /** Token color string (e.g. "var(--info)") or any valid stroke. Defaults to
   *  currentColor so the sparkline can inherit text color from its container. */
  stroke?: string
  width?: number
  height?: number
  /** If true, fills the area under the curve with the stroke color at 8% opacity
   *  — gives the sparkline more presence inside busy table cells. */
  filled?: boolean
}

// Inline SVG sparkline. Deliberately tiny + axis-less — reads as "shape of
// the trend," not a precise chart. Pairs with KPI tiles + post cards.
//
// We use `vectorEffect="non-scaling-stroke"` so the 1.5px line thickness stays
// constant when the SVG is upscaled or downscaled by its container. Without
// this the stroke would visually thicken/thin with the container width.
export function Sparkline({
  values,
  stroke = "currentColor",
  width = 80,
  height = 20,
  filled = false,
}: Props) {
  if (values.length === 0) return null
  const maxVal = Math.max(...values, 1)
  const x = (i: number) =>
    (width * i) / Math.max(values.length - 1, 1)
  const y = (v: number) => height - (height - 2) * (v / maxVal) - 1

  const linePath = values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`)
    .join(" ")

  const areaPath = filled
    ? `${linePath} L ${x(values.length - 1).toFixed(2)} ${height} L 0 ${height} Z`
    : null

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width, height }}
      aria-hidden
    >
      {areaPath ? (
        <path d={areaPath} fill={stroke} opacity={0.08} />
      ) : null}
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
