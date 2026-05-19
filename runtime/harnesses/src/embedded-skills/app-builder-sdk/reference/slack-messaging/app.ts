// SDK REFERENCE — NOT a production module.
//
// Purpose: demonstrate the "messaging" shape via Slack — custom state
// alphabet (draft/scheduled/sent/edited/deleted/failed), side-effect
// actions (react), provider quirks (body.ok pattern, DM channel
// resolution, 60s scheduled-message cancellation window), real reverse
// handler. Also serves as the SDK's test fixture and the most-stressed
// example (3 real production quirks were found and fixed via real-API
// E2E against live Slack).
//
// For a production Slack module: see hola-boss-apps/slack/ (legacy
// @holaboss/bridge SDK, ~600 lines, broader tool coverage including
// list_channels / search_messages / list_users / send_dm). To replace
// it, write a new workspace app under <workspace>/apps/ or
// hola-boss-apps/ that uses this reference as a template plus the full
// v1 tool surface — NOT a job for this reference dir.
//
// Per-provider Slack quirks (kept as inline comments at the call sites
// they apply to; no separate SKILL.md — that conflicts with Holaboss's
// real skill system at runtime/harnesses/src/embedded-skills/):
//   - Slack returns errors as HTTP 200 + { ok:false, error:"..." }, not
//     4xx/5xx. Every action checks body.ok via `slackUnwrap` below.
//   - chat.postMessage with channel=user_id auto-resolves to a DM
//     channel ("D0..."); we persist the resolved channel back to the
//     row so subsequent edit/delete/react use the right id.
//   - chat.deleteScheduledMessage rejects with
//     invalid_scheduled_message_id if <60s remain before post_at —
//     schedule with sufficient lead time.

import { createApp, z, type CreateAppOptions, type ProxyResult, type BridgeError } from "../../src/index.ts"
import { SLACK } from "./provider.ts"

// Slack returns its own errors in body.ok / body.error.
type SlackBody = { ok?: boolean; error?: string; [k: string]: unknown }

function slackUnwrap<T extends SlackBody>(
  r: ProxyResult<T>,
):
  | { ok: true; data: T }
  | { ok: false; fail: BridgeError | { kind: "error"; code: string; message: string } } {
  if (r.kind === "error") return { ok: false, fail: r }
  if (r.data.ok === false) {
    const code = r.data.error ?? "slack_error"
    return { ok: false, fail: { kind: "error", code, message: code } }
  }
  return { ok: true, data: r.data }
}

export function buildSlackApp(options: CreateAppOptions = {}) {
  const app = createApp({
    id: "slack",
    provider: SLACK,
    description: "Slack channel messaging, edits, reactions",
  }, options)

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
      const r = await bridge.call<SlackBody & {
        channels?: { id: string; name: string; is_private?: boolean }[]
      }>("GET", "/conversations.list")
      const u = slackUnwrap(r)
      if (!u.ok) throw u.fail
      return u.data.channels ?? []
    },
  })

  const message = app.resource("message", {
    schema: z.object({
      channel_id: channel.ref(),
      text: z.string().max(40_000),
      thread_ts: z.string().optional(),
      post_at: z.number().optional(),
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
    run: async ({ row, bridge, persist }) => {
      const r = await bridge.call<SlackBody & { ts?: string; channel?: string }>(
        "POST", "/chat.postMessage",
        { channel: row.channel_id, text: row.text, thread_ts: row.thread_ts },
      )
      const u = slackUnwrap(r)
      if (!u.ok) return { fail: u.fail }
      // Slack DM auto-resolution: when input channel is a user_id, the response
      // carries the actual DM channel id ("D0..."). Persist it for subsequent ops.
      if (u.data.channel && u.data.channel !== row.channel_id) {
        await persist({ channel_id: u.data.channel })
      }
      return { ok: true, externalId: u.data.ts }
    },
  })

  app.action(message, "schedule_send", {
    fromStates: ["draft"],
    toState: "scheduled",
    schema: z.object({ post_at: z.number().int().positive() }),
    reversible: {
      toState: "draft",
      run: async ({ row, bridge }) => {
        // Slack-specific: this WILL fail with invalid_scheduled_message_id if
        // less than 60 seconds remain before post_at. Schedule with sufficient
        // lead time to give the cancel a chance. Agent should propagate the
        // error and let the user know they hit the window.
        const r = await bridge.call<SlackBody>("POST", "/chat.deleteScheduledMessage", {
          channel: row.channel_id,
          scheduled_message_id: row.external_id,
        })
        const u = slackUnwrap(r)
        if (!u.ok) return { fail: u.fail }
        return { ok: true }
      },
    },
    run: async ({ row, input, bridge, persist }) => {
      const r = await bridge.call<SlackBody & {
        scheduled_message_id?: string; post_at?: number; channel?: string
      }>("POST", "/chat.scheduleMessage", {
        channel: row.channel_id, text: row.text, post_at: input.post_at, thread_ts: row.thread_ts,
      })
      const u = slackUnwrap(r)
      if (!u.ok) return { fail: u.fail }
      // Persist the DM-resolved channel id. chat.scheduledMessages.list
      // verifies the scheduled message is keyed under this channel, so the
      // delete must use it too. (Note: cancel will only succeed if invoked
      // more than 60 seconds before post_at — Slack's hard rule.)
      const patch: { post_at?: number; channel_id?: string } = {}
      if (u.data.post_at) patch.post_at = u.data.post_at
      if (u.data.channel && u.data.channel !== row.channel_id) patch.channel_id = u.data.channel
      if (Object.keys(patch).length) await persist(patch)
      return { ok: true, externalId: u.data.scheduled_message_id }
    },
  })

  app.action(message, "edit_message", {
    fromStates: ["sent", "edited"],
    toState: "edited",
    schema: z.object({ text: z.string().min(1).max(40_000) }),
    run: async ({ row, input, bridge, persist }) => {
      const r = await bridge.call<SlackBody>("POST", "/chat.update", {
        channel: row.channel_id, ts: row.external_id, text: input.text,
      })
      const u = slackUnwrap(r)
      if (!u.ok) return { fail: u.fail }
      await persist({ text: input.text })
      return { ok: true }
    },
  })

  app.action(message, "delete_message", {
    fromStates: ["draft", "scheduled", "sent", "edited"],
    toState: "deleted",
    run: async ({ row, bridge }) => {
      if (row.external_id) {
        const r = await bridge.call<SlackBody>("POST", "/chat.delete", {
          channel: row.channel_id, ts: row.external_id,
        })
        const u = slackUnwrap(r)
        // Propagate all errors (including not_found) — let the agent decide.
        if (!u.ok) return { fail: u.fail }
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
      const r = await bridge.call<SlackBody>("POST", "/reactions.add", {
        channel: row.channel_id, timestamp: row.external_id, name: input.emoji,
      })
      const u = slackUnwrap(r)
      if (!u.ok) return { fail: u.fail }
      return { ok: true }
    },
  })

  app.sync("channel_directory", {
    schedule: "0 * * * *",
    attachTo: channel,
    fetch: async ({ bridge }) => {
      const r = await bridge.call<SlackBody & { channels?: { id: string; name: string }[] }>(
        "GET", "/conversations.list",
      )
      const u = slackUnwrap(r)
      if (!u.ok) return { ok: false, error: u.fail }
      return { ok: true, items: u.data.channels ?? [] }
    },
    upsert: { key: "id" },
    normalize: raw => ({ id: raw.id, name: raw.name }),
  })

  return { app, channel, message }
}
