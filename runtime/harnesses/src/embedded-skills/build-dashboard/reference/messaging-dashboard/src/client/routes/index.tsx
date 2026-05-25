/*
 * Spatial sketch
 *
 *   Region 1 — ATTENTION strip (only when something failed).
 *     Bordered + tinted, sits above the timeline. Inline Retry/Edit so
 *     action is one click, not a drill-down.
 *
 *   Region 2 — TIMELINE queue (everything not failed, sorted by time).
 *     A 1px vertical rail runs down the column; each queued row hangs
 *     off the rail with a marker dot at its scheduled time. The
 *     "next-to-send" row gets a bigger primary-tinted marker.
 *     Day boundaries (Today → Tomorrow → Later) are thin labelled
 *     dividers; the rail visually carries the time grouping.
 *
 *   Above the fold (1280×800): attention strip + the next 3–4 queued
 *   items. Eye lands on attention if anything's wrong, else on the
 *   primary-marked "next send".
 */

import { useMemo } from "react"
import { ConnectionPill } from "../components/connection-pill"
import { HeaderBar } from "../components/header-bar"
import { AttentionList, MessageList } from "../components/messages-table"
import { sampleMessages, type MessageRow } from "../lib/sample-data"

const DAY_DIVIDERS: { bucket: MessageRow["bucket"]; label: string }[] = [
  { bucket: "today", label: "Today" },
  { bucket: "tomorrow", label: "Tomorrow" },
  { bucket: "later", label: "Later" },
]

export function Dashboard() {
  const { failed, upcomingByDay, nextIdByBucket } = useMemo(() => {
    const fail: MessageRow[] = []
    const upcoming = new Map<MessageRow["bucket"], MessageRow[]>()
    for (const m of sampleMessages) {
      if (m.status === "failed") {
        fail.push(m)
        continue
      }
      const arr = upcoming.get(m.bucket) ?? []
      arr.push(m)
      upcoming.set(m.bucket, arr)
    }
    const todayList = upcoming.get("today") ?? []
    const next = new Map<MessageRow["bucket"], number>()
    if (todayList.length > 0) next.set("today", 0)
    return { failed: fail, upcomingByDay: upcoming, nextIdByBucket: next }
  }, [])

  const queuedCount = sampleMessages.filter((m) => m.status !== "failed").length

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col bg-background text-foreground">
      <HeaderBar
        title="Outgoing"
        subtitle={`${queuedCount} queued · agent will send on schedule`}
        rightSlot={<ConnectionPill state="ready" handle="@joshua" />}
      />

      <div className="flex flex-1 flex-col px-10 pb-16">
        {failed.length > 0 ? (
          <section className="mb-8">
            <h2 className="mb-2 text-[10px] tracking-[0.08em] text-warning uppercase">
              Needs attention
            </h2>
            <AttentionList rows={failed} />
          </section>
        ) : null}

        <section>
          {DAY_DIVIDERS.map((day, i) => {
            const rows = upcomingByDay.get(day.bucket) ?? []
            if (rows.length === 0) return null
            return (
              <div key={day.bucket} className={i === 0 ? "" : "mt-7"}>
                <div className="mb-1 flex items-center gap-3">
                  <span className="text-[10px] tracking-[0.08em] text-fg-48 uppercase">
                    {day.label}
                  </span>
                  <div className="h-px flex-1 bg-border" />
                  <span className="font-mono text-[10px] text-fg-32 tabular-nums">
                    {rows.length.toString().padStart(2, "0")}
                  </span>
                </div>
                <MessageList
                  rows={rows}
                  nextIndex={nextIdByBucket.get(day.bucket)}
                  nowLabel={day.bucket === "today" ? "08:42" : undefined}
                />
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}

export default Dashboard
