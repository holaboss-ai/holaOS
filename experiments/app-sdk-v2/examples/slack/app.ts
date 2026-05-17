// Slack — messaging app. Declares its own state alphabet.

import { createApp, z } from "../../src/index.ts"
import { SLACK } from "../../src/providers/slack.ts"

export function buildSlackApp() {
  const app = createApp({
    id: "slack",
    provider: SLACK,
    description: "Slack channel messaging, edits, reactions",
  })

  app.connection()

  const channel = app.resource("channel", {
    schema: z.object({
      id: z.string(),
      name: z.string(),
      is_private: z.boolean().optional(),
    }),
    states: ["cached"] as const,
    initialState: "cached",
    emit: { surface: "none" },
    refreshEvery: "1h",
    fetch: async ({ bridge }) => {
      const r = await bridge.call<{ channels: { id: string; name: string; is_private?: boolean }[] }>(
        "GET", "/conversations.list",
      )
      if (r.kind === "error") throw r
      return r.data.channels
    },
  })

  const message = app.resource("message", {
    schema: z.object({
      channel_id: channel.ref(),
      text: z.string().max(40_000),
      thread_ts: z.string().optional(),
      post_at: z.number().optional(),       // checkpoint for schedule_send
    }),
    states: ["draft", "scheduled", "sent", "edited", "deleted", "failed"] as const,
    initialState: "draft",
    failedState: "failed",
    emit: {
      surface: "ops_log",
      summary: r => (r.text ?? "").slice(0, 80),
      deepLink: r => r.external_id && r.channel_id
        ? `https://slack.com/archives/${r.channel_id}/p${String(r.external_id).replace(".", "")}`
        : null,
    },
  })

  app.action(message, "send_message", {
    fromStates: ["draft"],
    toState: "sent",
    run: async ({ row, bridge }) => {
      const r = await bridge.call<{ ok: boolean; ts: string; channel: string }>(
        "POST", "/chat.postMessage",
        { channel: row.channel_id, text: row.text, thread_ts: row.thread_ts },
      )
      if (r.kind === "error") return { fail: r }
      return { ok: true, externalId: r.data.ts }
    },
  })

  app.action(message, "schedule_send", {
    fromStates: ["draft"],
    toState: "scheduled",
    schema: z.object({ post_at: z.number().int().positive() }),
    reversible: {
      toState: "draft",
      run: async ({ row, bridge }) => {
        const r = await bridge.call("POST", "/chat.deleteScheduledMessage", {
          channel: row.channel_id,
          scheduled_message_id: row.external_id,
        })
        if (r.kind === "error" && r.code !== "not_found") return { fail: r }
        return { ok: true }
      },
    },
    run: async ({ row, input, bridge, persist }) => {
      const r = await bridge.call<{ ok: boolean; scheduled_message_id: string; post_at: number }>(
        "POST", "/chat.scheduleMessage",
        { channel: row.channel_id, text: row.text, post_at: input.post_at, thread_ts: row.thread_ts },
      )
      if (r.kind === "error") return { fail: r }
      await persist({ post_at: r.data.post_at })
      return { ok: true, externalId: r.data.scheduled_message_id }
    },
  })

  app.action(message, "edit_message", {
    fromStates: ["sent", "edited"],
    toState: "edited",
    schema: z.object({ text: z.string().min(1).max(40_000) }),
    run: async ({ row, input, bridge, persist }) => {
      const r = await bridge.call("POST", "/chat.update", {
        channel: row.channel_id, ts: row.external_id, text: input.text,
      })
      if (r.kind === "error") return { fail: r }
      await persist({ text: input.text })
      return { ok: true }
    },
  })

  app.action(message, "delete_message", {
    fromStates: ["draft", "scheduled", "sent", "edited"],
    toState: "deleted",
    run: async ({ row, bridge }) => {
      if (row.external_id) {
        const r = await bridge.call("POST", "/chat.delete", {
          channel: row.channel_id, ts: row.external_id,
        })
        if (r.kind === "error" && r.code !== "not_found") return { fail: r }
      }
      return { ok: true }
    },
  })

  app.action(message, "react", {
    fromStates: ["sent", "edited"],
    toState: null,
    toolName: "slack_react",
    schema: z.object({ emoji: z.string().min(1) }),
    run: async ({ row, input, bridge }) => {
      const r = await bridge.call("POST", "/reactions.add", {
        channel: row.channel_id, timestamp: row.external_id, name: input.emoji,
      })
      if (r.kind === "error") return { fail: r }
      return { ok: true }
    },
  })

  app.sync("channel_directory", {
    schedule: "0 * * * *",
    attachTo: channel,
    fetch: async ({ bridge }) => {
      const r = await bridge.call<{ channels: { id: string; name: string }[] }>(
        "GET", "/conversations.list",
      )
      if (r.kind === "error") return { ok: false, error: r }
      return { ok: true, items: r.data.channels }
    },
    upsert: { key: "id" },
    normalize: raw => ({ id: raw.id, name: raw.name }),
  })

  return { app, channel, message }
}
