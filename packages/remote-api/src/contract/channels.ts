import { oc } from "@orpc/contract";
import { z } from "zod";
import { workspaceScoped } from "./shared";

// On-the-wire channel connection record (snake_case, matching the runtime
// payload). Never carries the bot token — credentials stay server-side.
export const channelConnectionSchema = z
  .object({
    connection_id: z.string(),
    workspace_id: z.string(),
    platform: z.string(),
    enabled: z.boolean(),
    bot_username: z.string().nullable(),
    allow_from: z.array(z.string()),
    require_mention: z.boolean(),
    status: z.string(),
    status_detail: z.string().nullable(),
    // Harness this channel's sessions run under; null = workspace default (pi).
    harness: z.string().nullable(),
    // Model this channel's runs use; null = the harness/workspace default model.
    model: z.string().nullable(),
    updated_at: z.string(),
  })
  .catchall(z.unknown());

const listInputSchema = workspaceScoped;
const listOutputSchema = z.object({
  channels: z.array(channelConnectionSchema),
  count: z.number().int(),
});

const validateInputSchema = workspaceScoped.extend({
  platform: z.enum(["telegram", "discord", "slack", "qq", "wecom"]).default("telegram"),
  token: z.string().min(1),
  // Slack needs a second, app-level token (`xapp-…`) for the Socket Mode handshake.
  // QQ reuses these two: `token` = App ID, `appToken` = App Secret.
  // WeCom reuses them too: `token` = BotID, `appToken` = Secret.
  appToken: z.string().optional(),
});
const validateOutputSchema = z.object({
  ok: z.boolean(),
  bot_username: z.string().nullable(),
  error: z.string().nullable(),
  // Discord: a one-click "add the bot to your server" OAuth2 URL, built from the
  // validated app id. Absent for platforms that don't need an invite step.
  invite_url: z.string().nullable().optional(),
});

// Device-flow (QR scan-to-create / scan-to-login) onboarding: Feishu/Lark +
// DingTalk auto-create an app; WeChat (iLink) scans to log in a personal account.
const startDeviceAuthInputSchema = workspaceScoped.extend({
  platform: z.enum(["feishu", "dingtalk", "wechat"]).default("feishu"),
  domain: z.enum(["feishu", "lark"]).optional(),
});
const startDeviceAuthOutputSchema = z.object({
  device_code: z.string(),
  qr_url: z.string(),
  interval_sec: z.number().int(),
  expires_in_sec: z.number().int(),
});
const pollDeviceAuthInputSchema = workspaceScoped.extend({
  platform: z.enum(["feishu", "dingtalk", "wechat"]).default("feishu"),
  deviceCode: z.string().min(1),
  domain: z.enum(["feishu", "lark"]).optional(),
});
const pollDeviceAuthOutputSchema = z.object({
  status: z.enum(["pending", "success", "denied", "expired"]),
  connection: channelConnectionSchema.nullable(),
});

const createInputSchema = workspaceScoped.extend({
  platform: z.enum(["telegram", "discord", "slack", "qq", "wecom"]).default("telegram"),
  token: z.string().min(1),
  // Slack's app-level token (`xapp-…`); `token` holds the bot token (`xoxb-…`).
  // QQ: `token` = App ID, `appToken` = App Secret. WeCom: `token` = BotID,
  // `appToken` = Secret.
  appToken: z.string().optional(),
  allowFrom: z.array(z.string()).optional(),
  requireMention: z.boolean().optional(),
});

const deleteInputSchema = workspaceScoped.extend({
  connectionId: z.string().min(1),
});
const deleteOutputSchema = z.object({ success: z.boolean() });

// Set (or clear, with null) the harness a channel's sessions run under. Only
// affects conversations started after the change — a session's harness is fixed
// once it's created.
const setHarnessInputSchema = workspaceScoped.extend({
  connectionId: z.string().min(1),
  harness: z.string().min(1).nullable(),
});

// Set (or clear, with null) the model a channel's runs use. null falls back to the
// channel's harness/workspace default. Applies to the channel's next message.
const setModelInputSchema = workspaceScoped.extend({
  connectionId: z.string().min(1),
  model: z.string().min(1).nullable(),
});

// One agent session (conversation) a channel has spun up. A channel maps to many
// of these — one per chat / DM / thread. Read-only summary that feeds the
// "replicate view": a live, read-only mirror of the channel's agent session.
// Never carries transcript content; the transcript is streamed separately via
// the existing session-outputs stream, keyed by `session_id`.
export const channelSessionSchema = z.object({
  session_id: z.string(),
  conversation_key: z.string(),
  // Human label for the conversation (chat title), falling back to the key.
  title: z.string().nullable(),
  // dm / group / channel / thread, when the connector reports it.
  chat_type: z.string().nullable(),
  is_active: z.boolean(),
  last_active_at: z.string().nullable(),
});

const listSessionsInputSchema = workspaceScoped.extend({
  connectionId: z.string().min(1),
});
const listSessionsOutputSchema = z.object({
  sessions: z.array(channelSessionSchema),
  count: z.number().int(),
});

export const channelsContract = {
  list: oc.input(listInputSchema).output(listOutputSchema),
  validate: oc.input(validateInputSchema).output(validateOutputSchema),
  startDeviceAuth: oc.input(startDeviceAuthInputSchema).output(startDeviceAuthOutputSchema),
  pollDeviceAuth: oc.input(pollDeviceAuthInputSchema).output(pollDeviceAuthOutputSchema),
  create: oc
    .input(createInputSchema)
    .errors({ INVALID_TOKEN: { message: "invalid bot token" } })
    .output(channelConnectionSchema),
  delete: oc
    .input(deleteInputSchema)
    .errors({ NOT_FOUND: { message: "connection not found" } })
    .output(deleteOutputSchema),
  setHarness: oc
    .input(setHarnessInputSchema)
    .errors({ NOT_FOUND: { message: "connection not found" } })
    .output(channelConnectionSchema),
  setModel: oc
    .input(setModelInputSchema)
    .errors({ NOT_FOUND: { message: "connection not found" } })
    .output(channelConnectionSchema),
  listSessions: oc
    .input(listSessionsInputSchema)
    .errors({ NOT_FOUND: { message: "connection not found" } })
    .output(listSessionsOutputSchema),
};

export type ChannelConnection = z.infer<typeof channelConnectionSchema>;
export type ChannelSession = z.infer<typeof channelSessionSchema>;
