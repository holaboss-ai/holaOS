import { StatusDot } from "@holaboss/ui"
import type { MessageStatus } from "../lib/sample-data"

const MAP: Record<
  MessageStatus,
  { label: string; dot: "success" | "warning" | "destructive" | "muted" | "info" }
> = {
  draft: { label: "Draft", dot: "muted" },
  scheduled: { label: "Scheduled", dot: "info" },
  sent: { label: "Sent", dot: "success" },
  edited: { label: "Edited", dot: "info" },
  failed: { label: "Failed", dot: "destructive" },
}

export function StatusBadge({ status }: { status: MessageStatus }) {
  const { label, dot } = MAP[status]
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-fg-64">
      <StatusDot variant={dot} size="sm" />
      {label}
    </span>
  )
}
