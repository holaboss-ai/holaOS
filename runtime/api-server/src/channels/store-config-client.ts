import type { ChannelConfigClient, ChannelConnectionConfig } from "@holaboss/runtime-channel-gateway";
import type { RuntimeStateStore } from "@holaboss/runtime-state-store";

/**
 * Config source backed by the `channel_connections` table. Enumerates enabled
 * connections across all workspaces so the manager can run a connector per
 * connection. This is how the desktop "Connect" UI feeds the gateway.
 */
export function createStoreChannelConfigClient(store: RuntimeStateStore): ChannelConfigClient {
  return {
    async listConfigs(): Promise<ChannelConnectionConfig[]> {
      const configs: ChannelConnectionConfig[] = [];
      for (const workspace of store.listWorkspaces()) {
        for (const connection of store.listChannelConnections({
          workspaceId: workspace.id,
          enabledOnly: true,
        })) {
          const appId =
          typeof connection.config.appId === "string" ? connection.config.appId : undefined;
        const appSecret =
          typeof connection.config.appSecret === "string" ? connection.config.appSecret : undefined;
        const appToken =
          typeof connection.config.appToken === "string" ? connection.config.appToken : undefined;
        // Telegram/Discord use `token`; Feishu/Lark/DingTalk use app id + secret;
        // Slack uses `token` (bot) + `appToken` (app-level), both in config_json.
        if (!connection.token && !(appId && appSecret)) continue;
        configs.push({
          platform: connection.platform,
          connectionId: connection.connectionId,
          enabled: connection.enabled,
          workspaceId: connection.workspaceId,
          token: connection.token ?? undefined,
          allowFrom: connection.allowFrom,
          requireMention: connection.requireMention,
          apiBaseUrl: connection.apiBaseUrl ?? undefined,
          appId,
          appSecret,
          appToken,
          domain: typeof connection.config.domain === "string" ? connection.config.domain : undefined,
          // Per-platform passthrough (e.g. WeChat iLink accountId/cdnBaseUrl).
          extra: connection.config,
        });
        }
      }
      return configs;
    },
  };
}
