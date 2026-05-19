// SDK REFERENCE — NOT a production module.
//
// Purpose: demonstrate that the SDK supports messaging-shape apps with
// integer external IDs (Telegram message_id is int — see RowOf doc in
// types.ts for the stringify pattern). Built end-to-end by a cold
// subagent given ONLY the SDK meta-skill + the user request "add
// Telegram" — first time pass, 0 `as any`, 9 unit tests. Useful as a
// "did our agent-build flow really work" artifact.
//
// Known: real-API E2E NOT run yet (Composio proxy path convention for
// Telegram bot tokens is unverified — depends on whether Composio's
// `API_KEY` auth toolkit injects the token into the URL path).
//
// Copy this directory as a template when building a real Telegram /
// Discord / bot-style messaging module; do not deploy it as-is.
//
// Telegram — messaging app (bot API). Same shape as Slack: chats + messages,
// custom state alphabet, side-effect react action.
//
// Telegram-specific contract: like Slack, errors come back as HTTP 200 with
// { ok: false, description, error_code } in the body. SDK's BridgeClient only
// maps HTTP status, so each action must check r.data.ok via `tgUnwrap` below.
//
// Telegram-specific behavior notes:
//   - message_id is a numeric int (not a string ts like Slack). Persisted as
//     `String(message_id)` so it fits the SDK's external_id contract.
//   - There is NO scheduleMessage in the Bot API and NO server-side edit
//     window beyond 48h for non-bot messages — bots can edit their own
//     messages indefinitely. No schedule action declared.
//   - setMessageReaction REPLACES the bot's prior reactions on that message
//     (it doesn't append). Passing an empty array clears.
//   - chat_id can be a numeric id OR an @channelusername. Persisted as a
//     string for both.

import { createApp, z, type CreateAppOptions, type ProxyResult, type BridgeError } from "../../src/index.ts"
import { TELEGRAM } from "./provider.ts"

type TgBody = {
  ok?: boolean
  description?: string
  error_code?: number
  result?: unknown
  [k: string]: unknown
}

function tgUnwrap<T extends TgBody>(
  r: ProxyResult<T>,
):
  | { ok: true; data: T }
  | { ok: false; fail: BridgeError | { kind: "error"; code: string; message: string } } {
  if (r.kind === "error") return { ok: false, fail: r }
  if (r.data.ok === false) {
    const description = r.data.description ?? "telegram_error"
    const code = r.data.error_code ? `telegram_${r.data.error_code}` : "telegram_error"
    return { ok: false, fail: { kind: "error", code, message: description } }
  }
  return { ok: true, data: r.data }
}

export function buildTelegramApp(options: CreateAppOptions = {}) {
  const app = createApp({
    id: "telegram",
    provider: TELEGRAM,
    description: "Telegram bot messaging, edits, reactions",
  }, options)

  app.connection()

  const chat = app.resource("chat", {
    schema: z.object({
      id: z.string(),
      title: z.string().optional(),
      type: z.string().optional(),
    }),
    states: ["cached"] as const,
    initialState: "cached",
    emit: { surface: "none" },
  })

  const message = app.resource("message", {
    schema: z.object({
      chat_id: chat.ref(),
      text: z.string().min(1).max(4096),
      reply_to_message_id: z.number().int().optional(),
      parse_mode: z.enum(["HTML", "MarkdownV2"]).optional(),
    }),
    states: ["draft", "sent", "edited", "deleted", "failed"] as const,
    initialState: "draft",
    failedState: "failed",
    emit: {
      surface: "ops_log",
      summary: r => (r.text ?? "").slice(0, 80),
      deepLink: r => {
        if (!r.external_id) return null
        // Public channel/group URL only resolves when chat_id is @username.
        const ref = String(r.chat_id ?? "")
        if (ref.startsWith("@")) {
          return `https://t.me/${ref.slice(1)}/${r.external_id}`
        }
        return null
      },
    },
  })

  app.action(message, "send_message", {
    fromStates: ["draft"],
    toState: "sent",
    run: async ({ row, bridge }) => {
      type SendResult = TgBody & {
        result?: { message_id: number; chat: { id: number | string } }
      }
      const r = await bridge.call<SendResult>("POST", "/sendMessage", {
        chat_id: row.chat_id,
        text: row.text,
        reply_to_message_id: row.reply_to_message_id,
        parse_mode: row.parse_mode,
      })
      const u = tgUnwrap(r)
      if (!u.ok) return { fail: u.fail }
      const messageId = u.data.result?.message_id
      if (messageId === undefined) {
        return { fail: { kind: "error", code: "telegram_missing_message_id", message: "no message_id in result" } }
      }
      return { ok: true, externalId: String(messageId) }
    },
  })

  app.action(message, "edit_message", {
    fromStates: ["sent", "edited"],
    toState: "edited",
    schema: z.object({ text: z.string().min(1).max(4096) }),
    run: async ({ row, input, bridge, persist }) => {
      if (!row.external_id) {
        return { fail: { kind: "error", code: "missing_external_id", message: "edit requires external_id" } }
      }
      const r = await bridge.call<TgBody>("POST", "/editMessageText", {
        chat_id: row.chat_id,
        message_id: Number(row.external_id),
        text: input.text,
        parse_mode: row.parse_mode,
      })
      const u = tgUnwrap(r)
      if (!u.ok) return { fail: u.fail }
      await persist({ text: input.text })
      return { ok: true }
    },
  })

  app.action(message, "delete_message", {
    fromStates: ["draft", "sent", "edited"],
    toState: "deleted",
    run: async ({ row, bridge }) => {
      if (row.external_id) {
        const r = await bridge.call<TgBody>("POST", "/deleteMessage", {
          chat_id: row.chat_id,
          message_id: Number(row.external_id),
        })
        const u = tgUnwrap(r)
        // Propagate all errors — let the agent decide. Telegram returns
        // 'message to delete not found' as ok:false; don't swallow it.
        if (!u.ok) return { fail: u.fail }
      }
      return { ok: true }
    },
  })

  app.action(message, "react", {
    fromStates: ["sent", "edited"],
    toState: null,
    toolName: "telegram_react",
    schema: z.object({ emoji: z.string().min(1) }),
    run: async ({ row, input, bridge }) => {
      if (!row.external_id) {
        return { fail: { kind: "error", code: "missing_external_id", message: "react requires external_id" } }
      }
      // setMessageReaction replaces prior bot reactions; pass single emoji.
      const r = await bridge.call<TgBody>("POST", "/setMessageReaction", {
        chat_id: row.chat_id,
        message_id: Number(row.external_id),
        reaction: [{ type: "emoji", emoji: input.emoji }],
      })
      const u = tgUnwrap(r)
      if (!u.ok) return { fail: u.fail }
      return { ok: true }
    },
  })

  return { app, chat, message }
}
