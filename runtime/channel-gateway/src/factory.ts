import type { ChannelConnectionConfig } from "./config.js";
import type { ChannelConnector } from "./connector.js";
import { DingTalkConnector } from "./connectors/dingtalk.js";
import { DiscordConnector } from "./connectors/discord.js";
import { FeishuConnector } from "./connectors/feishu.js";
import { QQConnector } from "./connectors/qq.js";
import { SlackConnector } from "./connectors/slack.js";
import { TelegramConnector } from "./connectors/telegram.js";
import { WeChatConnector } from "./connectors/wechat.js";
import { WecomConnector } from "./connectors/wecom.js";
import type { LoggerLike } from "./egress.js";

/** Builds a connector for a connection config, or null for an unsupported platform. */
export type ConnectorFactory = (config: ChannelConnectionConfig) => ChannelConnector | null;

export function createDefaultConnectorFactory(logger?: LoggerLike): ConnectorFactory {
  return (config) => {
    switch (config.platform) {
      case "telegram":
        return new TelegramConnector({ config, logger });
      case "feishu":
      case "lark":
        return new FeishuConnector({ config, logger });
      case "dingtalk":
        return new DingTalkConnector({ config, logger });
      case "discord":
        return new DiscordConnector({ config, logger });
      case "slack":
        return new SlackConnector({ config, logger });
      case "qq":
        return new QQConnector({ config, logger });
      case "wecom":
        return new WecomConnector({ config, logger });
      case "wechat":
        return new WeChatConnector({ config, logger });
      default:
        return null;
    }
  };
}
