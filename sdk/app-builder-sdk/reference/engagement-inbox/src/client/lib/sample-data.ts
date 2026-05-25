export type ThreadStatus =
  | "unread"
  | "replying"
  | "replied"
  | "resolved"
  | "escalated"

export type ThreadKind = "comment" | "mention" | "dm" | "review"

export type ThreadRow = {
  id: string
  /** Source platform — twitter, linkedin, instagram, reddit, gmail … */
  channel: string
  kind: ThreadKind
  /** Person engaging — display name, not @handle */
  authorName: string
  authorHandle: string
  /** The comment/mention/DM body the marketer is reacting to. */
  body: string
  /** One-line context of what they're replying to (post title, ad name, etc.). */
  contextLabel: string
  status: ThreadStatus
  /** Priority bucket — drives section grouping. */
  bucket: "overdue" | "today" | "this_week" | "later"
  /** Compact relative label: "12m", "3h", "Tue", "Aug 14". */
  timeLabel: string
  /** Set when the SLA window has expired without a reply. */
  overdueReason?: string
  /** CRM-flavored metadata. How many prior interactions across all channels. */
  priorTouches: number
  /** Optional role / org tag shown next to the name (Attio-style). */
  role?: string
}

export const sampleThreads: ThreadRow[] = [
  {
    id: "t1",
    channel: "twitter",
    kind: "mention",
    authorName: "Lena Park",
    authorHandle: "@lenacodes",
    role: "Engineering Lead · Loop",
    body: "Tried the new pricing page — the 'team' tier copy is a little confusing. Is per-seat the same as per-editor?",
    contextLabel: "Pricing page launch",
    status: "unread",
    bucket: "overdue",
    timeLabel: "26h",
    overdueReason: "SLA · respond within 24h on @ mentions",
    priorTouches: 4,
  },
  {
    id: "t2",
    channel: "instagram",
    kind: "comment",
    authorName: "Marco D.",
    authorHandle: "@marcoddd",
    body: "Where's the link for the bundle drop?? Can't find it anywhere",
    contextLabel: "Bundle teaser",
    status: "unread",
    bucket: "today",
    timeLabel: "42m",
    priorTouches: 0,
  },
  {
    id: "t3",
    channel: "linkedin",
    kind: "comment",
    authorName: "Priya Shah",
    authorHandle: "priya-shah",
    role: "VP Eng · Northforge",
    body: "Curious how this compares to a self-hosted setup — any latency numbers for the EU region?",
    contextLabel: "Launch announcement",
    status: "replying",
    bucket: "today",
    timeLabel: "2h",
    priorTouches: 12,
  },
  {
    id: "t4",
    channel: "reddit",
    kind: "mention",
    authorName: "u/forge_works",
    authorHandle: "u/forge_works",
    body: "Honest review after a week — agent UX is a step up, but the export workflow is rough. Happy to expand if you want.",
    contextLabel: "r/SaaS thread",
    status: "unread",
    bucket: "today",
    timeLabel: "5h",
    priorTouches: 1,
  },
  {
    id: "t5",
    channel: "gmail",
    kind: "dm",
    authorName: "Alex Romero",
    authorHandle: "alex@northforge.co",
    role: "Founder · Northforge",
    body: "Following up — we'd love to do a partnership post next month. Sent over the brief; let me know if the slot still works.",
    contextLabel: "Partnership outreach",
    status: "replying",
    bucket: "this_week",
    timeLabel: "Tue",
    priorTouches: 7,
  },
  {
    id: "t6",
    channel: "appstore",
    kind: "review",
    authorName: "kev_l",
    authorHandle: "★★★★☆",
    body: "Love the new release. The agent does ~80% of what I used to do manually. Wish the keyboard shortcuts were configurable.",
    contextLabel: "Review · 1.4.0",
    status: "replied",
    bucket: "this_week",
    timeLabel: "Wed",
    priorTouches: 0,
  },
  {
    id: "t7",
    channel: "twitter",
    kind: "dm",
    authorName: "Sora Kim",
    authorHandle: "@sora_writes",
    role: "Writer · solo",
    body: "Hey! Open to a quick chat about a guest post? Topic would be 'agentic workflows for solo creators'.",
    contextLabel: "Guest post pitch",
    status: "unread",
    bucket: "later",
    timeLabel: "Aug 14",
    priorTouches: 2,
  },
]
