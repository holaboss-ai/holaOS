import {
  AreaChart as AreaChartIcon,
  BarChart3,
  LineChart as LineChartIcon,
  type LucideIcon,
  PieChart as PieChartIcon,
} from "lucide-react";
import { useMemo } from "react";

import { useIsDarkTheme } from "@/lib/themeAttr";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type {
  ChartPanel as ChartPanelSpec,
  ChartSpec,
} from "@/lib/dashboardSchema";

import type { DataViewState } from "./DataViewPanel";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "./ErrorMessage";
import { formatValue } from "./format";

const CHART_ICON: Record<ChartSpec["kind"], LucideIcon> = {
  line: LineChartIcon,
  bar: BarChart3,
  area: AreaChartIcon,
  pie: PieChartIcon,
  donut: PieChartIcon,
};

interface ChartPanelProps {
  panel: ChartPanelSpec;
  state: DataViewState;
}

// Series palette — Tailwind v4 default colors (OKLch). Sky + orange
// lead because they're a high-contrast complementary pair that read
// distinctly even at one-glance scan; the rest fill in for charts
// with 3+ series. Light mode uses Tailwind's -500 stops; dark mode
// uses -400 for a slight pop against the darker chart surface.
//
// Recharts draws into SVG and can't pick up CSS vars at render time,
// so we inline OKLch literals here and pick the active palette at
// render based on the desktop's theme class.
const SERIES_LIGHT = [
  "oklch(68.5% 0.169 237.323)", // sky-500
  "oklch(70.5% 0.213 47.604)",  // orange-500
  "oklch(69.6% 0.17 162.48)",   // emerald-500
  "oklch(60.6% 0.25 292.717)",  // violet-500
  "oklch(64.5% 0.246 16.439)",  // rose-500
  "oklch(76.9% 0.188 70.08)",   // amber-500
  "oklch(55.4% 0.046 257.417)", // slate-500
];
const SERIES_DARK = [
  "oklch(74.6% 0.16 232.661)",  // sky-400
  "oklch(75% 0.183 55.934)",    // orange-400
  "oklch(76.5% 0.177 163.223)", // emerald-400
  "oklch(70.2% 0.183 293.541)", // violet-400
  "oklch(71.2% 0.194 13.428)",  // rose-400
  "oklch(82.8% 0.189 84.429)",  // amber-400
  "oklch(70.4% 0.04 256.788)",  // slate-400
];

function useSeriesPalette(): string[] {
  return useIsDarkTheme() ? SERIES_DARK : SERIES_LIGHT;
}

export function ChartPanel({ panel, state }: ChartPanelProps) {
  return (
    <section className="overflow-hidden rounded-xl bg-card shadow-md smooth-corners">
      <header className="border-b border-border bg-fg-2 px-4 py-3">
        <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">
          {panel.title}
        </h3>
        {panel.description ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {panel.description}
          </p>
        ) : null}
      </header>
      <div className="px-4 py-3">
        {state.kind === "loading" ? (
          <ChartSkeleton />
        ) : state.kind === "error" ? (
          <ErrorMessage message={state.message} />
        ) : state.rows.length === 0 ? (
          <EmptyState
            icon={CHART_ICON[panel.chart.kind] ?? BarChart3}
            title={panel.empty_state ?? "Nothing here yet."}
            minHeight={260}
          />
        ) : (
          <ChartBody chart={panel.chart} state={state} />
        )}
      </div>
    </section>
  );
}

function ChartBody({
  chart,
  state,
}: {
  chart: ChartSpec;
  state: Extract<DataViewState, { kind: "data" }>;
}) {
  if (chart.kind === "pie" || chart.kind === "donut") {
    return <PieChartBody chart={chart} state={state} />;
  }
  // chart.kind is "line" | "bar" | "area" — narrowed by the if above,
  // but TypeScript needs the cast because ChartSpec is a discriminated
  // union and TS doesn't narrow generics.
  return (
    <CartesianChartBody
      chart={chart as Extract<ChartSpec, { kind: "line" | "bar" | "area" }>}
      state={state}
    />
  );
}

// ----- Cartesian (line / bar / area) -------------------------------

function CartesianChartBody({
  chart,
  state,
}: {
  chart: Extract<ChartSpec, { kind: "line" | "bar" | "area" }>;
  state: Extract<DataViewState, { kind: "data" }>;
}) {
  const palette = useSeriesPalette();
  const xIdx = state.columns.indexOf(chart.x);
  const seriesIdx = chart.y
    .map((s) => ({ name: s, idx: state.columns.indexOf(s) }))
    .filter((s) => s.idx >= 0);

  // Project the row set into Recharts shape: array of objects keyed by
  // column name. Coerce numeric columns from string (sqlite REAL/
  // INTEGER come through as JS numbers but defensive about strings).
  const data = useMemo(() => {
    return state.rows.map((row) => {
      const o: Record<string, unknown> = {};
      o[chart.x] = row[xIdx];
      for (const s of seriesIdx) {
        const v = row[s.idx];
        const n =
          typeof v === "number"
            ? v
            : typeof v === "string"
              ? Number(v)
              : null;
        o[s.name] = Number.isFinite(n as number) ? n : null;
      }
      return o;
    });
  }, [state.rows, xIdx, seriesIdx, chart.x]);

  if (xIdx < 0) {
    return (
      <ChartConfigError
        msg={`x column "${chart.x}" not in projection.`}
      />
    );
  }
  if (seriesIdx.length === 0) {
    return (
      <ChartConfigError
        msg={`y column(s) ${chart.y.map((s) => `"${s}"`).join(", ")} not in projection.`}
      />
    );
  }

  const xTickFormatter = (raw: unknown): string => {
    if (chart.x_format === "date") return formatValue(raw, "date");
    if (chart.x_format === "datetime") return formatValue(raw, "datetime");
    return String(raw ?? "");
  };
  const yTickFormatter = (raw: unknown): string => {
    if (!chart.y_format) {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) return String(raw);
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n);
    }
    return formatValue(raw, chart.y_format);
  };
  const tooltipFormatter = (
    value: unknown,
    name: unknown,
  ): [string, string] => {
    return [
      chart.y_format
        ? formatValue(value, chart.y_format)
        : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
            typeof value === "number" ? value : Number(value),
          ),
      String(name),
    ];
  };

  const showLegend =
    chart.legend !== false && seriesIdx.length > 1;

  const commonAxisProps = {
    stroke: "currentColor",
    style: { fontSize: 11, fill: "currentColor", opacity: 0.55 },
    tickLine: false,
    axisLine: { stroke: "currentColor", opacity: 0.15 },
  } as const;

  return (
    <div className="h-[280px] w-full text-muted-foreground">
      <ResponsiveContainer width="100%" height="100%">
        {chart.kind === "line" ? (
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="currentColor" strokeOpacity={0.08} vertical={false} />
            <XAxis dataKey={chart.x} tickFormatter={xTickFormatter} {...commonAxisProps} />
            <YAxis tickFormatter={yTickFormatter} width={48} {...commonAxisProps} />
            <Tooltip
              cursor={{ stroke: "currentColor", strokeOpacity: 0.15 }}
              wrapperStyle={{ outline: "none" }}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                boxShadow: "0 4px 12px oklch(0 0 0 / 0.08)",
              }}
              labelStyle={{ color: "var(--foreground)", fontWeight: 500 }}
              labelFormatter={(label) => xTickFormatter(label)}
              formatter={tooltipFormatter}
            />
            {showLegend ? (
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              />
            ) : null}
            {seriesIdx.map((s, i) => (
              <Line
                key={s.name}
                type="monotone"
                dataKey={s.name}
                stroke={palette[i % palette.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
                isAnimationActive
              />
            ))}
          </LineChart>
        ) : chart.kind === "bar" ? (
          <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="currentColor" strokeOpacity={0.08} vertical={false} />
            <XAxis dataKey={chart.x} tickFormatter={xTickFormatter} {...commonAxisProps} />
            <YAxis tickFormatter={yTickFormatter} width={48} {...commonAxisProps} />
            <Tooltip
              cursor={{ fill: "currentColor", fillOpacity: 0.04 }}
              wrapperStyle={{ outline: "none" }}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                boxShadow: "0 4px 12px oklch(0 0 0 / 0.08)",
              }}
              labelStyle={{ color: "var(--foreground)", fontWeight: 500 }}
              labelFormatter={(label) => xTickFormatter(label)}
              formatter={tooltipFormatter}
            />
            {showLegend ? (
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              />
            ) : null}
            {seriesIdx.map((s, i) => {
              // color_by_sign only applies to single-series bars: per-row
              // Cell color picked by sign. Stacked bars get radius=0
              // because per-segment rounded corners look like dents.
              const colorBySign =
                chart.color_by_sign === true && seriesIdx.length === 1;
              return (
                <Bar
                  key={s.name}
                  dataKey={s.name}
                  fill={palette[i % palette.length]}
                  radius={chart.stacked ? 0 : [3, 3, 0, 0]}
                  stackId={chart.stacked ? "stack" : undefined}
                  isAnimationActive
                >
                  {colorBySign
                    ? data.map((entry, idx) => {
                        const v = entry[s.name];
                        const n = typeof v === "number" ? v : null;
                        const fill =
                          n !== null && n < 0 ? palette[1] : palette[0];
                        return (
                          // biome-ignore lint/suspicious/noArrayIndexKey: row order is the natural key
                          <Cell key={idx} fill={fill} />
                        );
                      })
                    : null}
                </Bar>
              );
            })}
          </BarChart>
        ) : (
          <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <defs>
              {seriesIdx.map((s, i) => {
                const color = palette[i % palette.length];
                return (
                  <linearGradient key={s.name} id={`fill-${s.name}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.04} />
                  </linearGradient>
                );
              })}
            </defs>
            <CartesianGrid stroke="currentColor" strokeOpacity={0.08} vertical={false} />
            <XAxis dataKey={chart.x} tickFormatter={xTickFormatter} {...commonAxisProps} />
            <YAxis tickFormatter={yTickFormatter} width={48} {...commonAxisProps} />
            <Tooltip
              cursor={{ stroke: "currentColor", strokeOpacity: 0.15 }}
              wrapperStyle={{ outline: "none" }}
              contentStyle={{
                background: "var(--popover)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                boxShadow: "0 4px 12px oklch(0 0 0 / 0.08)",
              }}
              labelStyle={{ color: "var(--foreground)", fontWeight: 500 }}
              labelFormatter={(label) => xTickFormatter(label)}
              formatter={tooltipFormatter}
            />
            {showLegend ? (
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              />
            ) : null}
            {seriesIdx.map((s, i) => (
              <Area
                key={s.name}
                type="monotone"
                dataKey={s.name}
                stroke={palette[i % palette.length]}
                fill={`url(#fill-${s.name})`}
                strokeWidth={2}
                stackId={chart.stacked ? "stack" : undefined}
                isAnimationActive
              />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

// ----- Pie / Donut --------------------------------------------------

function PieChartBody({
  chart,
  state,
}: {
  chart: Extract<ChartSpec, { kind: "pie" | "donut" }>;
  state: Extract<DataViewState, { kind: "data" }>;
}) {
  const palette = useSeriesPalette();
  const labelIdx = state.columns.indexOf(chart.label);
  const valueIdx = state.columns.indexOf(chart.value);

  const data = useMemo(() => {
    type Slice = { name: string; value: number };
    let arr: Slice[] = state.rows.map((row) => {
      const v = row[valueIdx];
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : 0;
      return {
        name: String(row[labelIdx] ?? "—"),
        value: Number.isFinite(n) ? n : 0,
      };
    });
    if (chart.sort_desc !== false) {
      arr = arr.slice().sort((a, b) => b.value - a.value);
    }
    if (chart.max_slices && arr.length > chart.max_slices) {
      const head = arr.slice(0, chart.max_slices);
      const tail = arr.slice(chart.max_slices);
      const otherTotal = tail.reduce((sum, s) => sum + s.value, 0);
      head.push({ name: "Other", value: otherTotal });
      arr = head;
    }
    return arr;
  }, [state.rows, labelIdx, valueIdx, chart.sort_desc, chart.max_slices]);

  if (labelIdx < 0) {
    return <ChartConfigError msg={`label column "${chart.label}" not in projection.`} />;
  }
  if (valueIdx < 0) {
    return <ChartConfigError msg={`value column "${chart.value}" not in projection.`} />;
  }

  const isDonut = chart.kind === "donut";

  return (
    <div className="h-[280px] w-full text-muted-foreground">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius={isDonut ? 56 : 0}
            outerRadius={96}
            paddingAngle={isDonut ? 2 : 0}
            stroke="var(--background)"
            strokeWidth={2}
            isAnimationActive
          >
            {data.map((_, i) => (
              <Cell
                // biome-ignore lint/suspicious/noArrayIndexKey: palette index is the key
                key={i}
                fill={palette[i % palette.length]}
              />
            ))}
          </Pie>
          <Tooltip
            wrapperStyle={{ outline: "none" }}
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
              boxShadow: "0 4px 12px oklch(0 0 0 / 0.08)",
            }}
            labelStyle={{ color: "var(--foreground)", fontWeight: 500 }}
            formatter={(value: unknown, name: unknown) => [
              new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
                typeof value === "number" ? value : Number(value),
              ),
              String(name),
            ]}
          />
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

// ----- Helpers ------------------------------------------------------

function ChartConfigError({ msg }: { msg: string }) {
  return (
    <div className="my-3 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      Chart config: {msg}
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="h-[280px] w-full" aria-busy aria-label="Loading chart">
      <div className="flex h-full flex-col justify-end gap-2 px-4 pb-2">
        <div className="flex flex-1 items-end gap-2">
          {[44, 72, 56, 88, 64, 92, 68].map((h, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: skeleton order is decorative
              key={i}
              className="animate-shimmer flex-1 rounded-sm bg-fg-6"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground/0">
          <span>—</span>
          <span>—</span>
        </div>
      </div>
    </div>
  );
}
