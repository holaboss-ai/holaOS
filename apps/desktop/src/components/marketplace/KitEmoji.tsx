const FLUENT_CDN = "https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji/assets";
const DEFAULT_EMOJI_URL = `${FLUENT_CDN}/Package/3D/package_3d.png`;

function isUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function resolveEmojiSrc(emoji: string | null | undefined): string {
  if (!emoji) return DEFAULT_EMOJI_URL;
  if (isUrl(emoji)) return emoji;
  // If it's a raw emoji name (not a URL), build the Fluent CDN URL
  const slug = emoji.toLowerCase().replaceAll(" ", "_").replaceAll("%20", "_");
  return `${FLUENT_CDN}/${emoji}/3D/${slug}_3d.png`;
}

interface KitEmojiProps {
  emoji: string | null | undefined;
  size?: number;
  className?: string;
}

export function KitEmoji({ emoji, size = 40, className = "" }: KitEmojiProps) {
  return (
    <img
      src={resolveEmojiSrc(emoji)}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 object-contain ${className}`.trim()}
      loading="lazy"
    />
  );
}
