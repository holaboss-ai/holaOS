export type PostStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"

/** Channels supported by the calendar. Each gets a stable token-driven tint
 *  in CHANNEL_META below. Add new channels here; the grid auto-picks them
 *  up via lookup. */
export type Channel =
  | "twitter"
  | "linkedin"
  | "instagram"
  | "reddit"
  | "youtube"
  | "tiktok"
  | "blog"

export type PostCard = {
  id: string
  channel: Channel
  /** 0 = Monday, 6 = Sunday — column index in the weekly grid. */
  dayIndex: number
  /** "HH:MM" 24h, mono-aligned in the card. */
  timeLabel: string
  /** Short title or first line of body — clamped to 2 lines in the card. */
  title: string
  status: PostStatus
  /** Optional short author handle shown only on hover. */
  authorHandle?: string
}

/** Visual metadata per channel. Color is the token-driven left-stripe on
 *  the post card; letter is the 1-char monogram shown in the corner.
 *  Tokens — chosen so each is distinguishable in BOTH light and dark
 *  themes without using `oklch()` literals. */
export const CHANNEL_META: Record<
  Channel,
  { label: string; letter: string; tint: string; ring: string }
> = {
  twitter: {
    label: "X / Twitter",
    letter: "X",
    tint: "bg-info",
    ring: "ring-info/30",
  },
  linkedin: {
    label: "LinkedIn",
    letter: "in",
    tint: "bg-primary",
    ring: "ring-primary/30",
  },
  instagram: {
    label: "Instagram",
    letter: "ig",
    tint: "bg-destructive",
    ring: "ring-destructive/25",
  },
  reddit: {
    label: "Reddit",
    letter: "r",
    tint: "bg-warning",
    ring: "ring-warning/30",
  },
  youtube: {
    label: "YouTube",
    letter: "yt",
    tint: "bg-destructive",
    ring: "ring-destructive/30",
  },
  tiktok: {
    label: "TikTok",
    letter: "tt",
    tint: "bg-foreground",
    ring: "ring-foreground/20",
  },
  blog: {
    label: "Blog",
    letter: "b",
    tint: "bg-success",
    ring: "ring-success/30",
  },
}

export const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const

/** Sample week — May 26 (Mon) → Jun 1 (Sun) 2026.
 *  Deliberately uneven: Tue is overbooked, Thu is empty (so the underbooked
 *  signal is visible), Sat has a failure. */
export const samplePosts: PostCard[] = [
  // Monday
  {
    id: "p1",
    channel: "linkedin",
    dayIndex: 0,
    timeLabel: "09:00",
    title: "Launch announcement — agent + 1M context",
    status: "scheduled",
    authorHandle: "@joshua",
  },
  {
    id: "p2",
    channel: "twitter",
    dayIndex: 0,
    timeLabel: "12:30",
    title: "Quote of the week — 'Build small, ship daily.'",
    status: "draft",
  },
  // Tuesday — overbooked
  {
    id: "p3",
    channel: "twitter",
    dayIndex: 1,
    timeLabel: "08:00",
    title: "Morning thread on agent UX patterns",
    status: "scheduled",
  },
  {
    id: "p4",
    channel: "instagram",
    dayIndex: 1,
    timeLabel: "11:00",
    title: "Behind-the-scenes reel · pricing page",
    status: "scheduled",
  },
  {
    id: "p5",
    channel: "linkedin",
    dayIndex: 1,
    timeLabel: "14:00",
    title: "Customer story · NorthForge co.",
    status: "draft",
  },
  {
    id: "p6",
    channel: "blog",
    dayIndex: 1,
    timeLabel: "16:00",
    title: "Long-form: why we shipped the inbox",
    status: "scheduled",
  },
  // Wednesday
  {
    id: "p7",
    channel: "reddit",
    dayIndex: 2,
    timeLabel: "10:00",
    title: "AMA prep — r/SaaS founders thread",
    status: "draft",
  },
  {
    id: "p8",
    channel: "youtube",
    dayIndex: 2,
    timeLabel: "15:00",
    title: "Demo cut · 90s walkthrough",
    status: "publishing",
  },
  // Thursday — empty (gap signal)
  // Friday
  {
    id: "p9",
    channel: "tiktok",
    dayIndex: 4,
    timeLabel: "12:00",
    title: "Trend hijack · 'office tour'",
    status: "draft",
  },
  // Saturday
  {
    id: "p10",
    channel: "twitter",
    dayIndex: 5,
    timeLabel: "09:30",
    title: "Recap thread — week in review",
    status: "failed",
  },
  // Sunday
  {
    id: "p11",
    channel: "instagram",
    dayIndex: 6,
    timeLabel: "18:00",
    title: "Weekend mood reel",
    status: "scheduled",
  },
]

/** Sample iso dates for the column headers — corresponds to dayIndex. */
export const SAMPLE_WEEK_DATES = [
  "May 26",
  "May 27",
  "May 28",
  "May 29",
  "May 30",
  "May 31",
  "Jun 1",
]
