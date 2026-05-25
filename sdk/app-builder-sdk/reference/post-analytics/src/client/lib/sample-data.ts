/** Metric kinds tracked per post. The order here is the order they appear
 *  in the KPI strip + chart legend. */
export type MetricKey = "impressions" | "engagement" | "clicks"

export type PostStatus = "live" | "boosted" | "underperforming" | "archived"

export type Post = {
  id: string
  body: string
  /** When the post went out. Compact label: "Mon 09:00", "2d ago". */
  postedAt: string
  status: PostStatus
  /** Aggregate totals — the numbers shown on the card metric pills. */
  totals: Record<MetricKey, number>
  /** Per-checkpoint history for THIS post — drives the card sparkline.
   *  Same length as the global CHECKPOINTS array, indexed by checkpoint. */
  series: Record<MetricKey, number[]>
}

/** A snapshot time. The chart x-axis is built from these; the digest log
 *  is a subset where `digestSent === true`. */
export type Checkpoint = {
  /** "HH:MM" — what shows on the chart axis. */
  label: string
  /** Wall-time hint for grouping ("Today", "Yesterday", "2d"). */
  dayBucket: "today" | "yesterday" | "earlier"
  /** Whether the agent shipped a Gmail digest for this checkpoint. */
  digestSent: boolean
}

/** One entry in the right-rail digest log — a Gmail message the agent
 *  composed and sent on a checkpoint boundary. */
export type DigestEntry = {
  id: string
  /** ISO-ish label: "Today · 14:00". */
  sentAt: string
  /** Index into CHECKPOINTS the digest was cut from. */
  checkpointIndex: number
  /** Number of posts included in this digest. */
  postCount: number
  /** Summed metrics across all posts in the digest, used for the
   *  one-line recap text under the timestamp. */
  totals: Record<MetricKey, number>
  /** Deep-link to the actual sent message in Gmail. */
  gmailUrl: string
}

/** Metric metadata — drives chart line color + KPI tile rendering.
 *  Uses token-driven semantic colors (info/success/warning) so dark mode
 *  adapts without a separate palette. */
export const METRIC_META: Record<
  MetricKey,
  {
    label: string
    /** Solid stroke color for the chart line. */
    stroke: string
    /** Tonal background for the corresponding KPI tile chip. */
    tint: string
  }
> = {
  impressions: {
    label: "Impressions",
    stroke: "var(--info)",
    tint: "bg-info/10",
  },
  engagement: {
    label: "Engagement",
    stroke: "var(--success)",
    tint: "bg-success/10",
  },
  clicks: {
    label: "Clicks",
    stroke: "var(--primary)",
    tint: "bg-primary/10",
  },
}

/** 12 checkpoints, every 4h for the past 48h. Digests sent at 06:00 and
 *  18:00 each day — twice a day cadence. */
export const CHECKPOINTS: Checkpoint[] = [
  { label: "02:00", dayBucket: "earlier", digestSent: false },
  { label: "06:00", dayBucket: "earlier", digestSent: true },
  { label: "10:00", dayBucket: "earlier", digestSent: false },
  { label: "14:00", dayBucket: "earlier", digestSent: false },
  { label: "18:00", dayBucket: "earlier", digestSent: true },
  { label: "22:00", dayBucket: "yesterday", digestSent: false },
  { label: "02:00", dayBucket: "yesterday", digestSent: false },
  { label: "06:00", dayBucket: "yesterday", digestSent: true },
  { label: "10:00", dayBucket: "yesterday", digestSent: false },
  { label: "14:00", dayBucket: "today", digestSent: false },
  { label: "18:00", dayBucket: "today", digestSent: true },
  { label: "22:00", dayBucket: "today", digestSent: false },
]

/** Sample posts with cumulative metric series. Series values are the
 *  CUMULATIVE total at each checkpoint — they should only ever go up
 *  (or stay flat) over time per post. The chart sums these per
 *  checkpoint to get the "all posts" trend. */
export const samplePosts: Post[] = [
  {
    id: "p1",
    body: "Just shipped the new pricing page — clearer team tier, side-by-side comparison, and per-seat trial credit. Take it for a spin.",
    postedAt: "Mon 09:00",
    status: "boosted",
    totals: { impressions: 12_400, engagement: 540, clicks: 92 },
    series: {
      impressions: [800, 1_900, 3_400, 5_100, 7_200, 9_000, 10_100, 10_900, 11_500, 11_900, 12_200, 12_400],
      engagement: [40, 90, 160, 240, 320, 400, 450, 480, 500, 515, 530, 540],
      clicks: [6, 14, 28, 42, 58, 70, 76, 82, 86, 89, 91, 92],
    },
  },
  {
    id: "p2",
    body: "'Build small, ship daily.' — Quote of the week. We've shipped 38 production releases this month. Compounding works.",
    postedAt: "Mon 12:30",
    status: "live",
    totals: { impressions: 4_800, engagement: 210, clicks: 14 },
    series: {
      impressions: [200, 600, 1_200, 1_900, 2_700, 3_400, 3_900, 4_200, 4_500, 4_650, 4_750, 4_800],
      engagement: [10, 35, 65, 95, 130, 160, 175, 185, 195, 200, 205, 210],
      clicks: [1, 3, 5, 7, 9, 11, 12, 13, 13, 14, 14, 14],
    },
  },
  {
    id: "p3",
    body: "We rebuilt the inbox triage flow this week — 2-pane, full-text search, ⌘K to jump. Single keystroke handoff to draft replies.",
    postedAt: "Mon 17:00",
    status: "live",
    totals: { impressions: 6_900, engagement: 320, clicks: 41 },
    series: {
      impressions: [100, 400, 1_000, 1_900, 3_000, 4_100, 5_000, 5_700, 6_200, 6_500, 6_800, 6_900],
      engagement: [5, 25, 60, 110, 170, 220, 255, 280, 295, 305, 315, 320],
      clicks: [0, 2, 6, 12, 19, 25, 30, 33, 36, 38, 40, 41],
    },
  },
  {
    id: "p4",
    body: "If your CRM doesn't show you what changed yesterday, it's not telling you the truth. Diff-first is the only honest view.",
    postedAt: "Tue 08:00",
    status: "live",
    totals: { impressions: 3_200, engagement: 145, clicks: 22 },
    series: {
      impressions: [0, 0, 200, 600, 1_100, 1_700, 2_100, 2_500, 2_800, 3_000, 3_150, 3_200],
      engagement: [0, 0, 10, 30, 55, 80, 100, 115, 125, 135, 142, 145],
      clicks: [0, 0, 2, 5, 9, 13, 16, 18, 20, 21, 22, 22],
    },
  },
  {
    id: "p5",
    body: "BTS reel — pricing page redesign in 90 seconds.",
    postedAt: "Tue 11:00",
    status: "underperforming",
    totals: { impressions: 1_100, engagement: 24, clicks: 3 },
    series: {
      impressions: [0, 0, 0, 100, 280, 460, 620, 760, 880, 970, 1_050, 1_100],
      engagement: [0, 0, 0, 2, 6, 10, 14, 17, 20, 22, 23, 24],
      clicks: [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 3, 3],
    },
  },
  {
    id: "p6",
    body: "Customer story — how @northforge cut their content scheduling time from 8h/week to 30min using the calendar grid.",
    postedAt: "Tue 14:00",
    status: "live",
    totals: { impressions: 5_400, engagement: 280, clicks: 38 },
    series: {
      impressions: [0, 0, 0, 0, 400, 1_200, 2_100, 3_000, 3_900, 4_600, 5_100, 5_400],
      engagement: [0, 0, 0, 0, 20, 60, 110, 160, 200, 235, 260, 280],
      clicks: [0, 0, 0, 0, 2, 7, 13, 20, 26, 31, 35, 38],
    },
  },
  {
    id: "p7",
    body: "Long-form post: why we shipped the inbox before the analytics. Doing the messy thing first, measuring later.",
    postedAt: "Tue 16:00",
    status: "live",
    totals: { impressions: 8_200, engagement: 410, clicks: 67 },
    series: {
      impressions: [0, 0, 0, 0, 200, 800, 1_700, 2_900, 4_200, 5_500, 6_900, 8_200],
      engagement: [0, 0, 0, 0, 10, 40, 90, 150, 220, 285, 350, 410],
      clicks: [0, 0, 0, 0, 1, 5, 12, 22, 33, 45, 56, 67],
    },
  },
  {
    id: "p8",
    body: "AMA prep — drop me your questions about agent UX and we'll talk about them Thursday.",
    postedAt: "Wed 10:00",
    status: "live",
    totals: { impressions: 2_100, engagement: 95, clicks: 8 },
    series: {
      impressions: [0, 0, 0, 0, 0, 0, 100, 400, 800, 1_300, 1_750, 2_100],
      engagement: [0, 0, 0, 0, 0, 0, 5, 20, 40, 60, 80, 95],
      clicks: [0, 0, 0, 0, 0, 0, 0, 1, 3, 5, 7, 8],
    },
  },
]

export const sampleDigests: DigestEntry[] = [
  {
    id: "d1",
    sentAt: "Today · 18:00",
    checkpointIndex: 10,
    postCount: 8,
    totals: { impressions: 44_100, engagement: 2_024, clicks: 285 },
    gmailUrl: "https://mail.google.com/mail/u/0/#sent/abc",
  },
  {
    id: "d2",
    sentAt: "Yesterday · 06:00",
    checkpointIndex: 7,
    postCount: 7,
    totals: { impressions: 28_400, engagement: 1_310, clicks: 178 },
    gmailUrl: "https://mail.google.com/mail/u/0/#sent/def",
  },
  {
    id: "d3",
    sentAt: "2d ago · 18:00",
    checkpointIndex: 4,
    postCount: 4,
    totals: { impressions: 12_900, engagement: 540, clicks: 64 },
    gmailUrl: "https://mail.google.com/mail/u/0/#sent/ghi",
  },
  {
    id: "d4",
    sentAt: "2d ago · 06:00",
    checkpointIndex: 1,
    postCount: 2,
    totals: { impressions: 2_500, engagement: 100, clicks: 12 },
    gmailUrl: "https://mail.google.com/mail/u/0/#sent/jkl",
  },
]

/** Aggregate metric trend across ALL posts, per checkpoint.
 *  Computed once at module load — drives the big line chart. */
export function aggregateSeries(metric: MetricKey): number[] {
  return CHECKPOINTS.map((_, idx) =>
    samplePosts.reduce((sum, p) => sum + (p.series[metric][idx] ?? 0), 0),
  )
}

/** Latest-vs-previous-checkpoint delta as a percent (positive = growing).
 *  Used in the KPI trend chip. */
export function trendDelta(metric: MetricKey): number {
  const series = aggregateSeries(metric)
  const last = series[series.length - 1] ?? 0
  const prev = series[series.length - 2] ?? 0
  if (prev === 0) return 0
  return ((last - prev) / prev) * 100
}
