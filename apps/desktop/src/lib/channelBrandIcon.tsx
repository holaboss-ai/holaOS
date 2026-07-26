/**
 * ChannelBrandIcon — single source of truth for the brand mark of an IM
 * channel platform (Telegram, Feishu/Lark, DingTalk, …).
 *
 * Brand SVGs live in src/assets/channels/ and carry their own brand colors
 * (unlike the model-provider marks in providerBrandIcon.tsx, which use
 * `currentColor`). These are nominative brand-identification icons — the
 * same use as IntegrationLogo for third-party integrations.
 *
 * Anything we don't recognise renders nothing — callers fall back to a
 * generic icon via {@link hasChannelBrandIcon}.
 */

import dingtalkLogoMarkup from "@/assets/channels/dingtalk.svg?raw";
import discordLogoMarkup from "@/assets/channels/discord.svg?raw";
import feishuLogoMarkup from "@/assets/channels/feishu.svg?raw";
import qqLogoMarkup from "@/assets/channels/qq.svg?raw";
import slackLogoMarkup from "@/assets/channels/slack.svg?raw";
import telegramLogoMarkup from "@/assets/channels/telegram.svg?raw";
import wechatLogoMarkup from "@/assets/channels/wechat.svg?raw";
import wecomLogoMarkup from "@/assets/channels/wecom.svg?raw";

/** Coarse brand bucket. `feishu` and `lark` share one mark. */
export type ChannelBrand =
  | "telegram"
  | "feishu"
  | "dingtalk"
  | "discord"
  | "slack"
  | "qq"
  | "wecom"
  | "wechat"
  | "unknown";

/** Map a connector platform id to its brand bucket. */
export function channelBrand(platform: string): ChannelBrand {
  switch (platform) {
    case "telegram":
      return "telegram";
    case "feishu":
    case "lark":
      return "feishu";
    case "dingtalk":
      return "dingtalk";
    case "discord":
      return "discord";
    case "slack":
      return "slack";
    case "qq":
      return "qq";
    case "wecom":
      return "wecom";
    case "wechat":
      return "wechat";
    default:
      return "unknown";
  }
}

function resolveSvgMarkup(brand: ChannelBrand): string | null {
  switch (brand) {
    case "telegram":
      return telegramLogoMarkup;
    case "feishu":
      return feishuLogoMarkup;
    case "dingtalk":
      return dingtalkLogoMarkup;
    case "discord":
      return discordLogoMarkup;
    case "slack":
      return slackLogoMarkup;
    case "qq":
      return qqLogoMarkup;
    case "wecom":
      return wecomLogoMarkup;
    case "wechat":
      return wechatLogoMarkup;
    default:
      return null;
  }
}

/** True when we have a brand mark for this platform (caller fallback gate). */
export function hasChannelBrandIcon(platform: string): boolean {
  return resolveSvgMarkup(channelBrand(platform)) !== null;
}

/**
 * Renders the platform's brand mark inline. Returns null for unknown
 * platforms — gate the call with {@link hasChannelBrandIcon} and render a
 * generic fallback when false.
 */
export function ChannelBrandIcon({
  platform,
  className,
}: {
  platform: string;
  className?: string;
}) {
  const markup = resolveSvgMarkup(channelBrand(platform));
  if (!markup) return null;
  const sizeClass = className ?? "size-4";
  return (
    <span
      aria-hidden="true"
      className={`block ${sizeClass} [&_svg]:h-full [&_svg]:w-full`}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
