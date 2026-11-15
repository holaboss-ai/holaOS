import { listStoreCatalog } from "./integration-store-catalog.js";

export interface PublishAction {
  platform: string;
  platformLabel: string;
  toolSlug: string;
  actionLabel: string;
}

const PLATFORM_LABELS: Record<string, string> = {
  twitter: "X",
  x: "X",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  facebook: "Facebook",
  instagram: "Instagram",
  threads: "Threads",
  tiktok: "TikTok",
  youtube: "YouTube",
  pinterest: "Pinterest",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
};

const SOCIAL_PLATFORMS: ReadonlySet<string> = new Set([
  ...Object.keys(PLATFORM_LABELS),
  ...listStoreCatalog()
    .filter((entry) => entry.category === "social")
    .map((entry) => entry.slug.toLowerCase()),
]);

const PLATFORM_PREFIXES = [...SOCIAL_PLATFORMS]
  .map((platform) => ({ platform, prefix: `${platform.toUpperCase()}_` }))
  .sort((left, right) => right.prefix.length - left.prefix.length);

const READ_VERBS: ReadonlySet<string> = new Set([
  "GET",
  "LIST",
  "FETCH",
  "RETRIEVE",
  "SEARCH",
  "LOOKUP",
  "FIND",
  "READ",
  "QUERY",
  "DESCRIBE",
  "COUNT",
  "VIEW",
  "DOWNLOAD",
  "EXPORT",
  "CHECK",
  "VALIDATE",
  "VERIFY",
]);

const NON_PUBLISHING_VERBS: ReadonlySet<string> = new Set([
  "DELETE",
  "REMOVE",
  "UNDO",
  "HIDE",
  "UNHIDE",
  "MUTE",
  "UNMUTE",
  "BLOCK",
  "UNBLOCK",
  "FOLLOW",
  "UNFOLLOW",
  "LIKE",
  "UNLIKE",
  "BOOKMARK",
  "UNBOOKMARK",
  "SUBSCRIBE",
  "UNSUBSCRIBE",
  "ARCHIVE",
  "DISMISS",
  "MARK",
]);

const PUBLISHING_TOKENS: ReadonlySet<string> = new Set([
  "CREATE",
  "CREATION",
  "PUBLISH",
  "SUBMIT",
  "SEND",
  "REPLY",
  "COMMENT",
  "SCHEDULE",
  "UPLOAD",
  "SHARE",
  "RESHARE",
  "REPOST",
  "RETWEET",
  "QUOTE",
  "INSERT",
  "EDIT",
  "UPDATE",
]);

const POSTING_LEAD_VERBS: ReadonlySet<string> = new Set([
  "POST",
  "TWEET",
  "PIN",
  "TOOT",
]);

const DRAFT_TOKENS: ReadonlySet<string> = new Set(["DRAFT", "DRAFTS"]);

const DRAFT_RELEASE_TOKENS: ReadonlySet<string> = new Set([
  "PUBLISH",
  "SUBMIT",
  "SEND",
  "SCHEDULE",
]);

function platformForSlug(toolSlug: string, toolkitSlug: string): string | null {
  for (const { platform, prefix } of PLATFORM_PREFIXES) {
    if (toolSlug.startsWith(prefix)) {
      return platform;
    }
  }
  return SOCIAL_PLATFORMS.has(toolkitSlug) ? toolkitSlug : null;
}

function isPublishingActionTokens(tokens: string[]): boolean {
  const lead = tokens[0];
  if (!lead || READ_VERBS.has(lead) || NON_PUBLISHING_VERBS.has(lead)) {
    return false;
  }
  if (
    tokens.some((token) => DRAFT_TOKENS.has(token)) &&
    !tokens.some((token) => DRAFT_RELEASE_TOKENS.has(token))
  ) {
    return false;
  }
  if (tokens.some((token) => PUBLISHING_TOKENS.has(token))) {
    return true;
  }
  return (
    POSTING_LEAD_VERBS.has(lead) &&
    !tokens.some(
      (token) => READ_VERBS.has(token) || NON_PUBLISHING_VERBS.has(token),
    )
  );
}

function humanizeAction(tokens: string[]): string {
  const text = tokens.join(" ").toLowerCase();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "Publish";
}

export function classifyPublishAction(params: {
  toolkitSlug: string;
  toolSlug: string;
}): PublishAction | null {
  const toolSlug = params.toolSlug.trim().toUpperCase();
  const toolkitSlug = params.toolkitSlug.trim().toLowerCase();
  if (!toolSlug) {
    return null;
  }
  const platform = platformForSlug(toolSlug, toolkitSlug);
  if (!platform) {
    return null;
  }
  const prefix = `${platform.toUpperCase()}_`;
  const action = toolSlug.startsWith(prefix)
    ? toolSlug.slice(prefix.length)
    : toolSlug;
  const tokens = action.split("_").filter(Boolean);
  if (!isPublishingActionTokens(tokens)) {
    return null;
  }
  return {
    platform,
    platformLabel:
      PLATFORM_LABELS[platform] ??
      `${platform.charAt(0).toUpperCase()}${platform.slice(1)}`,
    toolSlug,
    actionLabel: humanizeAction(tokens),
  };
}
