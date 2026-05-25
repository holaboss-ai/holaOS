export type MessageStatus =
  | "draft"
  | "scheduled"
  | "sent"
  | "edited"
  | "failed"

export type MessageRow = {
  id: string
  channel: string
  text: string
  status: MessageStatus
  /** ISO-ish bucket; component groups on this. */
  bucket: "today" | "tomorrow" | "later" | "past"
  /** Mono-aligned column on the left. Keep 5 chars (`HH:MM`) or short label. */
  timeLabel: string
  authorHandle: string
  errorReason?: string
}

export const sampleMessages: MessageRow[] = [
  {
    id: "m1",
    channel: "general",
    text: "Heads-up: the new pricing page goes live at 09:00 PT — please hold non-critical posts until then.",
    status: "scheduled",
    bucket: "today",
    timeLabel: "09:00",
    authorHandle: "@joshua",
  },
  {
    id: "m2",
    channel: "growth",
    text: "Weekly recap — KPI strip + waterfall chart. Need a final read before I queue it.",
    status: "draft",
    bucket: "today",
    timeLabel: "17:00",
    authorHandle: "@joshua",
  },
  {
    id: "m3",
    channel: "founders",
    text: "Investor update reminder — replies route to founders@.",
    status: "scheduled",
    bucket: "tomorrow",
    timeLabel: "17:00",
    authorHandle: "@joshua",
  },
  {
    id: "m4",
    channel: "engineering",
    text: "Sprint retro notes from yesterday's session — three threads to follow up on.",
    status: "draft",
    bucket: "tomorrow",
    timeLabel: "10:00",
    authorHandle: "@joshua",
  },
  {
    id: "m5",
    channel: "support",
    text: "Reply template ready for the workspace-bind flow — pasted in the doc, take a look when you can.",
    status: "draft",
    bucket: "later",
    timeLabel: "Fri",
    authorHandle: "@joshua",
  },
  {
    id: "m6",
    channel: "ops",
    text: "Composio rate-limit retry exhausted on /chat.postMessage. Marked for manual replay.",
    status: "failed",
    bucket: "past",
    timeLabel: "3h ago",
    authorHandle: "@joshua",
    errorReason: "rate_limit_exceeded · last attempt 14:32",
  },
]
