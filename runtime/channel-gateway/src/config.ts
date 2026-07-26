import type { ChannelPlatform } from "./connector.js";

/** One configured IM connection (a bot/account bound to a workspace). */
export interface ChannelConnectionConfig {
  platform: ChannelPlatform;
  connectionId: string;
  enabled: boolean;
  /** Workspace this connection binds to; null → the runtime resolves a default. */
  workspaceId?: string | null;
  token?: string;
  /** Sender ids / @usernames allowed to talk to the bot; empty = allow all. */
  allowFrom?: string[];
  requireMention?: boolean;
  /** Override the platform API base (self-hosted Bot API server, or tests). */
  apiBaseUrl?: string;
  /** App-credential platforms (Feishu/Lark, …): app id + secret + domain. */
  appId?: string;
  appSecret?: string;
  domain?: string;
  /** Slack Socket Mode app-level token (`xapp-…`); `token` holds the bot token. */
  appToken?: string;
  /** Arbitrary per-platform config passthrough (e.g. WeChat iLink accountId). */
  extra?: Record<string, unknown>;
}

export interface ChannelConfigClient {
  listConfigs(): Promise<ChannelConnectionConfig[]>;
}

/** Merges several config sources (e.g. store-backed + env) into one list. */
export class CompositeChannelConfigClient implements ChannelConfigClient {
  readonly #clients: ChannelConfigClient[];

  constructor(...clients: ChannelConfigClient[]) {
    this.#clients = clients;
  }

  async listConfigs(): Promise<ChannelConnectionConfig[]> {
    const lists = await Promise.all(this.#clients.map((client) => client.listConfigs().catch(() => [])));
    return lists.flat();
  }
}

/**
 * v1 quick-connect: reads a single Telegram connection from environment variables.
 *   HOLABOSS_TELEGRAM_BOT_TOKEN   (required to enable)
 *   HOLABOSS_TELEGRAM_WORKSPACE_ID(optional; default = sole workspace)
 *   HOLABOSS_TELEGRAM_ALLOW_FROM  (optional, comma-separated ids/@usernames)
 *   HOLABOSS_TELEGRAM_CONNECTION_ID(optional, default "default")
 * A store-backed client (with a desktop UI) can replace this later without
 * touching the manager.
 */
export class EnvChannelConfigClient implements ChannelConfigClient {
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  async listConfigs(): Promise<ChannelConnectionConfig[]> {
    const configs: ChannelConnectionConfig[] = [];
    const token = this.#env.HOLABOSS_TELEGRAM_BOT_TOKEN?.trim();
    if (token) {
      configs.push({
        platform: "telegram",
        connectionId: this.#env.HOLABOSS_TELEGRAM_CONNECTION_ID?.trim() || "default",
        enabled: true,
        workspaceId: this.#env.HOLABOSS_TELEGRAM_WORKSPACE_ID?.trim() || null,
        token,
        allowFrom: (this.#env.HOLABOSS_TELEGRAM_ALLOW_FROM ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        requireMention: false,
        apiBaseUrl: this.#env.HOLABOSS_TELEGRAM_API_BASE_URL?.trim() || undefined,
      });
    }
    return configs;
  }
}
