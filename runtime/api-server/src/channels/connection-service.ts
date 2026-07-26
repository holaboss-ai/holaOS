import {
  validateDiscordToken,
  validateQQCredentials,
  validateSlackTokens,
  validateTelegramToken,
  validateWecomCredentials,
} from "@holaboss/runtime-channel-gateway";
import type { ChannelConnectionRecord, RuntimeStateStore } from "@holaboss/runtime-state-store";

/** Connection as exposed to the desktop — never includes the bot token. */
export interface ConnectionView {
  connectionId: string;
  workspaceId: string;
  platform: string;
  enabled: boolean;
  botUsername: string | null;
  allowFrom: string[];
  requireMention: boolean;
  status: string;
  statusDetail: string | null;
  /** Harness this channel's sessions run under; null falls back to the
   *  workspace default (pi/Hola). Stored in the connection's config_json. */
  harness: string | null;
  /** Model this channel's runs use; null falls back to the harness/workspace
   *  default model. Stored in the connection's config_json. */
  model: string | null;
  updatedAt: string;
}

/** Read the per-connection harness preference out of the config_json blob. */
function readConnectionHarness(config: Record<string, unknown>): string | null {
  const raw = config.harness;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Read the per-connection model override out of the config_json blob. */
function readConnectionModel(config: Record<string, unknown>): string | null {
  const raw = config.model;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toConnectionView(record: ChannelConnectionRecord): ConnectionView {
  return {
    connectionId: record.connectionId,
    workspaceId: record.workspaceId,
    platform: record.platform,
    enabled: record.enabled,
    botUsername: record.botUsername,
    allowFrom: record.allowFrom,
    requireMention: record.requireMention,
    status: record.status,
    statusDetail: record.statusDetail,
    harness: readConnectionHarness(record.config),
    model: readConnectionModel(record.config),
    updatedAt: record.updatedAt,
  };
}

export interface CreateTelegramConnectionInput {
  workspaceId: string;
  connectionId?: string;
  token: string;
  allowFrom?: string[];
  requireMention?: boolean;
  apiBaseUrl?: string;
}

export interface CreateConnectionResult {
  ok: boolean;
  connection?: ConnectionView;
  error?: string;
}

/**
 * Validate a Telegram token (getMe) and persist the connection. On success the
 * connection is enabled + `connected` (the manager then starts polling it); on
 * failure it is stored disabled + `error` so the UI can show why.
 */
export async function createTelegramConnection(
  store: RuntimeStateStore,
  input: CreateTelegramConnectionInput,
): Promise<CreateConnectionResult> {
  const token = input.token.trim();
  if (!token) return { ok: false, error: "A bot token is required." };
  if (!store.getWorkspace(input.workspaceId)) {
    return { ok: false, error: "Workspace not found." };
  }

  const validation = await validateTelegramToken(token, input.apiBaseUrl);
  if (!validation.ok) {
    const record = store.upsertChannelConnection({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      platform: "telegram",
      token,
      allowFrom: input.allowFrom,
      requireMention: input.requireMention,
      apiBaseUrl: input.apiBaseUrl ?? null,
      enabled: false,
      status: "error",
      statusDetail: validation.error ?? "Invalid token",
    });
    return { ok: false, error: validation.error ?? "Invalid token", connection: toConnectionView(record) };
  }

  const record = store.upsertChannelConnection({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    platform: "telegram",
    token,
    botUsername: validation.username ?? null,
    allowFrom: input.allowFrom,
    requireMention: input.requireMention,
    apiBaseUrl: input.apiBaseUrl ?? null,
    enabled: true,
    status: "connected",
    statusDetail: null,
  });
  return { ok: true, connection: toConnectionView(record) };
}

export interface CreateDiscordConnectionInput {
  workspaceId: string;
  connectionId?: string;
  token: string;
  allowFrom?: string[];
  requireMention?: boolean;
}

/**
 * Validate a Discord bot token (GET /users/@me) and persist the connection. Like
 * Telegram it is token-based: on success it lands enabled + `connected` (the
 * manager starts the gateway connector); on failure it is stored disabled +
 * `error` so the UI can show why.
 */
export async function createDiscordConnection(
  store: RuntimeStateStore,
  input: CreateDiscordConnectionInput,
): Promise<CreateConnectionResult> {
  const token = input.token.trim();
  if (!token) return { ok: false, error: "A bot token is required." };
  if (!store.getWorkspace(input.workspaceId)) {
    return { ok: false, error: "Workspace not found." };
  }

  const validation = await validateDiscordToken(token);
  if (!validation.ok) {
    const record = store.upsertChannelConnection({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      platform: "discord",
      token,
      allowFrom: input.allowFrom,
      requireMention: input.requireMention,
      enabled: false,
      status: "error",
      statusDetail: validation.error ?? "Invalid token",
    });
    return {
      ok: false,
      error: validation.error ?? "Invalid token",
      connection: toConnectionView(record),
    };
  }

  const record = store.upsertChannelConnection({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    platform: "discord",
    token,
    botUsername: validation.username ?? null,
    allowFrom: input.allowFrom,
    requireMention: input.requireMention,
    enabled: true,
    status: "connected",
    statusDetail: null,
    config: validation.botId ? { botId: validation.botId } : undefined,
  });
  return { ok: true, connection: toConnectionView(record) };
}

export interface CreateSlackConnectionInput {
  workspaceId: string;
  connectionId?: string;
  token: string; // bot token (xoxb-…)
  appToken: string; // app-level token (xapp-…) for Socket Mode
  allowFrom?: string[];
  requireMention?: boolean;
}

/**
 * Validate a Slack connection (bot token via auth.test + app token via
 * apps.connections.open) and persist it. The bot token lives in the `token`
 * column; the app-level token lives in config_json (never exposed in the view).
 * On success it lands enabled + connected so the manager opens the Socket Mode
 * connection.
 */
export async function createSlackConnection(
  store: RuntimeStateStore,
  input: CreateSlackConnectionInput,
): Promise<CreateConnectionResult> {
  const token = input.token.trim();
  const appToken = input.appToken.trim();
  if (!token || !appToken) return { ok: false, error: "Both a bot token and an app token are required." };
  if (!store.getWorkspace(input.workspaceId)) {
    return { ok: false, error: "Workspace not found." };
  }

  const validation = await validateSlackTokens(token, appToken);
  if (!validation.ok) {
    const record = store.upsertChannelConnection({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      platform: "slack",
      token,
      allowFrom: input.allowFrom,
      requireMention: input.requireMention,
      enabled: false,
      status: "error",
      statusDetail: validation.error ?? "Invalid tokens",
      config: { appToken },
    });
    return {
      ok: false,
      error: validation.error ?? "Invalid tokens",
      connection: toConnectionView(record),
    };
  }

  const record = store.upsertChannelConnection({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    platform: "slack",
    token,
    botUsername: validation.botName ?? null,
    allowFrom: input.allowFrom,
    requireMention: input.requireMention,
    enabled: true,
    status: "connected",
    statusDetail: null,
    config: { appToken },
  });
  return { ok: true, connection: toConnectionView(record) };
}

export interface CreateQQConnectionInput {
  workspaceId: string;
  connectionId?: string;
  appId: string; // QQ Bot App ID
  appSecret: string; // QQ Bot App Secret
  botName?: string;
  allowFrom?: string[];
}

/**
 * Validate QQ bot credentials (by fetching an app access token) and persist the
 * connection. Credentials live in config_json (appId + appSecret), like DingTalk;
 * `token` stays null. On success it lands enabled + connected so the manager opens
 * the QQ gateway connection.
 */
export async function createQQConnection(
  store: RuntimeStateStore,
  input: CreateQQConnectionInput,
): Promise<CreateConnectionResult> {
  const appId = input.appId.trim();
  const appSecret = input.appSecret.trim();
  if (!appId || !appSecret) return { ok: false, error: "Both an App ID and App Secret are required." };
  if (!store.getWorkspace(input.workspaceId)) {
    return { ok: false, error: "Workspace not found." };
  }

  const validation = await validateQQCredentials(appId, appSecret);
  if (!validation.ok) {
    const record = store.upsertChannelConnection({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      platform: "qq",
      token: null,
      allowFrom: input.allowFrom,
      enabled: false,
      status: "error",
      statusDetail: validation.error ?? "Invalid credentials",
      config: { appId, appSecret },
    });
    return {
      ok: false,
      error: validation.error ?? "Invalid credentials",
      connection: toConnectionView(record),
    };
  }

  const record = store.upsertChannelConnection({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    platform: "qq",
    token: null,
    botUsername: input.botName ?? null,
    allowFrom: input.allowFrom,
    enabled: true,
    status: "connected",
    statusDetail: null,
    config: { appId, appSecret },
  });
  return { ok: true, connection: toConnectionView(record) };
}

export interface CreateWecomConnectionInput {
  workspaceId: string;
  connectionId?: string;
  botId: string; // WeCom Smart Bot BotID
  secret: string; // WeCom Smart Bot Secret
  botName?: string;
  allowFrom?: string[];
}

/**
 * Validate WeCom Smart Bot credentials (a short-lived WebSocket auth handshake)
 * and persist the connection. BotID + Secret live in config_json (appId/appSecret
 * slots, like DingTalk); `token` stays null. On success it lands enabled +
 * connected so the manager opens the long-connection.
 */
export async function createWecomConnection(
  store: RuntimeStateStore,
  input: CreateWecomConnectionInput,
): Promise<CreateConnectionResult> {
  const botId = input.botId.trim();
  const secret = input.secret.trim();
  if (!botId || !secret) return { ok: false, error: "Both a BotID and Secret are required." };
  if (!store.getWorkspace(input.workspaceId)) {
    return { ok: false, error: "Workspace not found." };
  }

  const validation = await validateWecomCredentials(botId, secret);
  if (!validation.ok) {
    const record = store.upsertChannelConnection({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      platform: "wecom",
      token: null,
      allowFrom: input.allowFrom,
      enabled: false,
      status: "error",
      statusDetail: validation.error ?? "Invalid credentials",
      config: { appId: botId, appSecret: secret },
    });
    return {
      ok: false,
      error: validation.error ?? "Invalid credentials",
      connection: toConnectionView(record),
    };
  }

  const record = store.upsertChannelConnection({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    platform: "wecom",
    token: null,
    botUsername: input.botName ?? null,
    allowFrom: input.allowFrom,
    enabled: true,
    status: "connected",
    statusDetail: null,
    config: { appId: botId, appSecret: secret },
  });
  return { ok: true, connection: toConnectionView(record) };
}

export interface CreateWechatConnectionInput {
  workspaceId: string;
  connectionId?: string;
  botId: string; // iLink bot identity (account id)
  token: string; // bot session token
  baseUrl: string; // per-account iLink API base
  userId?: string; // logged-in user's iLink id
  allowFrom?: string[];
}

/**
 * Persist a personal-WeChat (iLink) connection from a completed QR login. The
 * session token lives in the `token` column; the per-account base URL in
 * apiBaseUrl; the iLink bot/user ids in config_json (used to ignore self). The
 * QR flow already authenticated, so it lands enabled + connected.
 */
export function createWechatConnection(
  store: RuntimeStateStore,
  input: CreateWechatConnectionInput,
): ConnectionView {
  const record = store.upsertChannelConnection({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    platform: "wechat",
    token: input.token,
    apiBaseUrl: input.baseUrl,
    allowFrom: input.allowFrom,
    enabled: true,
    status: "connected",
    statusDetail: null,
    config: { accountId: input.botId, userId: input.userId ?? null },
  });
  return toConnectionView(record);
}

export function listConnectionViews(store: RuntimeStateStore, workspaceId: string): ConnectionView[] {
  return store.listChannelConnections({ workspaceId }).map(toConnectionView);
}

export function deleteConnection(
  store: RuntimeStateStore,
  workspaceId: string,
  connectionId: string,
): boolean {
  return store.deleteChannelConnection({ workspaceId, connectionId });
}

/**
 * Set (or clear, with null) the harness a channel's sessions run under. Stored
 * inside the connection's config_json so no schema change is needed — merged in
 * so credential fields already in config are preserved. Returns null when the
 * connection doesn't exist.
 */
export function setConnectionHarness(
  store: RuntimeStateStore,
  params: { workspaceId: string; connectionId: string; harness: string | null },
): ConnectionView | null {
  const existing = store.getChannelConnection({
    workspaceId: params.workspaceId,
    connectionId: params.connectionId,
  });
  if (!existing) return null;
  const nextHarness = params.harness?.trim() || null;
  const nextConfig = { ...existing.config };
  if (nextHarness) {
    nextConfig.harness = nextHarness;
  } else {
    delete nextConfig.harness;
  }
  // A model belongs to a harness's namespace (pi's catalogue vs a CLI harness's
  // own ids), so a harness switch invalidates any model override — drop it so the
  // new harness runs on its own default until the user picks a model for it.
  if (readConnectionModel(existing.config) !== null) {
    delete nextConfig.model;
  }
  const record = store.upsertChannelConnection({
    workspaceId: params.workspaceId,
    connectionId: params.connectionId,
    platform: existing.platform,
    config: nextConfig,
  });
  return toConnectionView(record);
}

/**
 * Set (or clear, with null) the model a channel's runs use. Stored inside the
 * connection's config_json (merged in, so credentials + harness are preserved).
 * Returns null when the connection doesn't exist.
 */
export function setConnectionModel(
  store: RuntimeStateStore,
  params: { workspaceId: string; connectionId: string; model: string | null },
): ConnectionView | null {
  const existing = store.getChannelConnection({
    workspaceId: params.workspaceId,
    connectionId: params.connectionId,
  });
  if (!existing) return null;
  const nextModel = params.model?.trim() || null;
  const nextConfig = { ...existing.config };
  if (nextModel) {
    nextConfig.model = nextModel;
  } else {
    delete nextConfig.model;
  }
  const record = store.upsertChannelConnection({
    workspaceId: params.workspaceId,
    connectionId: params.connectionId,
    platform: existing.platform,
    config: nextConfig,
  });
  return toConnectionView(record);
}

export interface CreateFeishuConnectionInput {
  workspaceId: string;
  connectionId?: string;
  appId: string;
  appSecret: string;
  domain: string;
  openId?: string;
  botName?: string;
  allowFrom?: string[];
  requireMention?: boolean;
}

/**
 * Persist a Feishu/Lark connection from a completed device-flow. Credentials live
 * in config_json (app id + secret + domain), never in the `token` column or the
 * view. The device-flow already validated them, so it lands enabled + connected.
 */
export function createFeishuConnection(
  store: RuntimeStateStore,
  input: CreateFeishuConnectionInput,
): ConnectionView {
  const record = store.upsertChannelConnection({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    platform: "feishu",
    token: null,
    botUsername: input.botName ?? null,
    allowFrom: input.allowFrom,
    requireMention: input.requireMention ?? true,
    enabled: true,
    status: "connected",
    statusDetail: null,
    config: {
      appId: input.appId,
      appSecret: input.appSecret,
      domain: input.domain,
      openId: input.openId ?? null,
    },
  });
  return toConnectionView(record);
}

export interface CreateDingtalkConnectionInput {
  workspaceId: string;
  connectionId?: string;
  appId: string; // DingTalk clientId (AppKey)
  appSecret: string; // DingTalk clientSecret (AppSecret)
  botName?: string;
  allowFrom?: string[];
}

/** Persist a DingTalk connection from a completed device-flow (creds in config_json). */
export function createDingtalkConnection(
  store: RuntimeStateStore,
  input: CreateDingtalkConnectionInput,
): ConnectionView {
  const record = store.upsertChannelConnection({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    platform: "dingtalk",
    token: null,
    botUsername: input.botName ?? null,
    allowFrom: input.allowFrom,
    enabled: true,
    status: "connected",
    statusDetail: null,
    config: { appId: input.appId, appSecret: input.appSecret },
  });
  return toConnectionView(record);
}
