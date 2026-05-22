import { type RuntimeStateStore, utcNowIso } from "@holaboss/runtime-state-store";

import {
  ComposioApiClient,
  ComposioApiClientError,
  createComposioApiClientFromEnv,
} from "./composio-api-client.js";
import {
  persistIntegrationCandidate,
  rebuildIntegrationTree,
  type IntegrationLeafCandidate,
  type PersistedIntegrationLeafResult,
} from "./integration-memory.js";

const GMAIL_RECENT_MESSAGE_LIMIT = 25;
const GITHUB_NOTIFICATIONS_LIMIT = 25;
const GITHUB_REPOSITORY_LIMIT = 4;
const GITHUB_REPOSITORY_PULL_REQUEST_LIMIT = 5;
const GITHUB_REPOSITORY_ISSUE_LIMIT = 5;
const SLACK_CHANNEL_LIMIT = 8;
const SLACK_CHANNEL_HISTORY_LIMIT = 12;
const SLACK_CHANNEL_HISTORY_TARGETS = 4;

type ComposioExecuteClient = Pick<ComposioApiClient, "executeAction">;

export interface IntegrationContextFetchResult {
  ok: true;
  supported: boolean;
  provider_id: string;
  connection_id: string;
  account_key: string | null;
  account_label: string | null;
  tree_id: string | null;
  fetched_at: string;
  leaves_created: number;
  leaves_superseding: number;
  leaves_unchanged: number;
  messages_seen: number;
  messages_persisted: number;
  summary_nodes: number;
  actions: string[];
  reason?: string;
}

interface GmailProfilePayload {
  emailAddress?: unknown;
  messagesTotal?: unknown;
  threadsTotal?: unknown;
  historyId?: unknown;
}

interface GmailMessagePayload {
  id?: unknown;
  messageId?: unknown;
  threadId?: unknown;
  subject?: unknown;
  sender?: unknown;
  from?: unknown;
  recipient?: unknown;
  to?: unknown;
  snippet?: unknown;
  internalDate?: unknown;
  date?: unknown;
  labelIds?: unknown;
  labels?: unknown;
  historyId?: unknown;
  payload?: unknown;
}

interface GitHubProfilePayload {
  id?: unknown;
  login?: unknown;
  name?: unknown;
  email?: unknown;
  html_url?: unknown;
  avatar_url?: unknown;
  bio?: unknown;
  company?: unknown;
  public_repos?: unknown;
  followers?: unknown;
  following?: unknown;
}

interface GitHubNotificationPayload {
  id?: unknown;
  unread?: unknown;
  reason?: unknown;
  updated_at?: unknown;
  last_read_at?: unknown;
  url?: unknown;
  subject?: unknown;
  repository?: unknown;
}

interface GitHubIssuePayload {
  id?: unknown;
  node_id?: unknown;
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  html_url?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  user?: unknown;
  labels?: unknown;
  repository?: unknown;
  repository_url?: unknown;
  pull_request?: unknown;
}

interface GitHubRepositoryPayload {
  id?: unknown;
  node_id?: unknown;
  name?: unknown;
  full_name?: unknown;
  description?: unknown;
  html_url?: unknown;
  updated_at?: unknown;
  pushed_at?: unknown;
  private?: unknown;
  fork?: unknown;
  stargazers_count?: unknown;
  watchers_count?: unknown;
  forks_count?: unknown;
  language?: unknown;
  topics?: unknown;
  default_branch?: unknown;
  owner?: unknown;
}

interface GitHubReadmePayload {
  name?: unknown;
  path?: unknown;
  sha?: unknown;
  html_url?: unknown;
  download_url?: unknown;
  content?: unknown;
  encoding?: unknown;
}

interface SlackAuthPayload {
  ok?: unknown;
  url?: unknown;
  team?: unknown;
  team_id?: unknown;
  user?: unknown;
  user_id?: unknown;
  bot_id?: unknown;
}

interface SlackChannelPayload {
  id?: unknown;
  name?: unknown;
  is_private?: unknown;
  is_archived?: unknown;
  is_im?: unknown;
  is_mpim?: unknown;
  num_members?: unknown;
  purpose?: unknown;
  topic?: unknown;
}

interface SlackMessagePayload {
  type?: unknown;
  user?: unknown;
  text?: unknown;
  ts?: unknown;
  subtype?: unknown;
  thread_ts?: unknown;
  reply_count?: unknown;
  latest_reply?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const token = value.trim().toLowerCase();
    if (token === "true") {
      return true;
    }
    if (token === "false") {
      return false;
    }
  }
  return null;
}

function unwrapActionData(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current === "string") {
      try {
        current = JSON.parse(current) as unknown;
        continue;
      } catch {
        return current;
      }
    }
    if (isRecord(current) && "data" in current) {
      current = current.data;
      continue;
    }
    return current;
  }
  return current;
}

function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function safeTag(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function timestampToIso(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    if (/^\d+\.\d+$/.test(trimmed)) {
      const seconds = Number.parseFloat(trimmed);
      if (Number.isFinite(seconds)) {
        return new Date(seconds * 1000).toISOString();
      }
    }
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number.parseInt(trimmed, 10);
      if (Number.isFinite(numeric)) {
        const millis = numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
        return new Date(millis).toISOString();
      }
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value >= 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => normalizeString(item)).filter((item): item is string => Boolean(item))
    : [];
}

function recordsFromData(value: unknown, collectionKeys: string[] = []): Record<string, unknown>[] {
  const unwrapped = unwrapActionData(value);
  if (Array.isArray(unwrapped)) {
    return unwrapped.filter(isRecord);
  }
  if (isRecord(unwrapped)) {
    for (const key of collectionKeys) {
      const nested = unwrapped[key];
      if (Array.isArray(nested)) {
        return nested.filter(isRecord);
      }
    }
  }
  return [];
}

function recordFromData(value: unknown): Record<string, unknown> | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? unwrapped : null;
}

function gmailHeaderValue(payload: unknown, name: string): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  for (const header of headers) {
    if (!isRecord(header)) {
      continue;
    }
    const headerName = normalizeString(header.name);
    if (!headerName || headerName.toLowerCase() !== name.toLowerCase()) {
      continue;
    }
    return normalizeString(header.value);
  }
  return null;
}

function githubRepositoryFullName(value: unknown): string | null {
  if (isRecord(value)) {
    return normalizeString(value.full_name)
      ?? [normalizeString(value.owner), normalizeString(value.name)].filter(Boolean).join("/");
  }
  const raw = normalizeString(value);
  if (!raw) {
    return null;
  }
  const match = raw.match(/repos\/([^/]+\/[^/]+)$/i);
  return match ? match[1] ?? null : raw;
}

function githubRepositoryOwnerAndName(value: unknown): { owner: string; repo: string } | null {
  const fullName = githubRepositoryFullName(value);
  if (!fullName) {
    return null;
  }
  const [owner, repo] = fullName.split("/", 2);
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

function decodeMaybeBase64(value: unknown, encoding: unknown): string | null {
  const raw = normalizeString(value);
  if (!raw) {
    return null;
  }
  const normalizedEncoding = normalizeString(encoding)?.toLowerCase();
  if (normalizedEncoding === "base64") {
    try {
      return Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  return raw;
}

function slackNestedText(value: unknown): string | null {
  if (isRecord(value)) {
    return normalizeString(value.value) ?? normalizeString(value.text);
  }
  return normalizeString(value);
}

function gmailProfileFromData(value: unknown): GmailProfilePayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as GmailProfilePayload) : null;
}

function gmailMessagesFromData(value: unknown): GmailMessagePayload[] {
  return recordsFromData(value, ["messages"]) as GmailMessagePayload[];
}

function gitHubProfileFromData(value: unknown): GitHubProfilePayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as GitHubProfilePayload) : null;
}

function gitHubNotificationsFromData(value: unknown): GitHubNotificationPayload[] {
  return recordsFromData(value) as GitHubNotificationPayload[];
}

function gitHubIssuesFromData(value: unknown): GitHubIssuePayload[] {
  return recordsFromData(value) as GitHubIssuePayload[];
}

function gitHubRepositoriesFromData(value: unknown): GitHubRepositoryPayload[] {
  return recordsFromData(value, ["items", "repositories"]) as GitHubRepositoryPayload[];
}

function gitHubReadmeFromData(value: unknown): GitHubReadmePayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as GitHubReadmePayload) : null;
}

function slackAuthFromData(value: unknown): SlackAuthPayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as SlackAuthPayload) : null;
}

function slackChannelsFromData(value: unknown): SlackChannelPayload[] {
  return recordsFromData(value, ["channels", "conversations"]) as SlackChannelPayload[];
}

function slackMessagesFromData(value: unknown): SlackMessagePayload[] {
  return recordsFromData(value, ["messages"]) as SlackMessagePayload[];
}

function buildGmailProfileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  connectionId: string;
  profile: GmailProfilePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const messagesTotal = parseInteger(params.profile.messagesTotal);
  const threadsTotal = parseInteger(params.profile.threadsTotal);
  const historyId = normalizeString(params.profile.historyId);
  const lines = [
    "# Gmail account profile",
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Gmail",
    `- Connection ID: ${params.connectionId}`,
    messagesTotal !== null ? `- Messages total: ${messagesTotal}` : null,
    threadsTotal !== null ? `- Threads total: ${threadsTotal}` : null,
    historyId ? `- History ID: ${historyId}` : null,
    `- Fetched at: ${params.fetchedAt}`,
    "",
    "## Summary",
    "",
    `${params.accountLabel} Gmail profile snapshot.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "gmail",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    title: `Gmail profile for ${params.accountLabel}`,
    summary: clipText(
      `${params.accountLabel} Gmail profile snapshot${messagesTotal !== null ? ` with ${messagesTotal} messages` : ""}${threadsTotal !== null ? ` and ${threadsTotal} threads` : ""}.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["gmail", "profile"],
    sourceType: "gmail.profile",
    sourceEventId: `gmail-profile:${params.accountKey}`,
    externalObjectId: params.accountKey,
    externalObjectType: "gmail_profile",
    observedAt: params.fetchedAt,
    confidence: 0.95,
  };
}

function buildGmailMessageCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  message: GmailMessagePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const messageId = normalizeString(params.message.id) ?? normalizeString(params.message.messageId);
  if (!messageId) {
    return null;
  }
  const threadId = normalizeString(params.message.threadId);
  const payload = isRecord(params.message.payload) ? params.message.payload : null;
  const subject = normalizeString(params.message.subject)
    ?? normalizeString(gmailHeaderValue(payload, "Subject"))
    ?? `Gmail message ${messageId}`;
  const sender = normalizeString(params.message.sender)
    ?? normalizeString(params.message.from)
    ?? normalizeString(gmailHeaderValue(payload, "From"));
  const recipient = normalizeString(params.message.recipient)
    ?? normalizeString(params.message.to)
    ?? normalizeString(gmailHeaderValue(payload, "To"));
  const snippet = normalizeString(params.message.snippet);
  const internalDate = timestampToIso(params.message.internalDate)
    ?? timestampToIso(params.message.date)
    ?? params.fetchedAt;
  const historyId = normalizeString(params.message.historyId);
  const labelIds = stringList(params.message.labelIds).length > 0
    ? stringList(params.message.labelIds)
    : stringList(params.message.labels);
  const tags = [
    "gmail",
    "message",
    ...labelIds.map((label) => safeTag(`label:${label}`)).filter((item): item is string => Boolean(item)),
  ];
  const summaryParts = [
    sender ? `Email from ${sender}` : "Email",
    subject ? `about ${subject}` : null,
    snippet ? `- ${clipText(snippet, 120)}` : null,
  ].filter((part): part is string => Boolean(part));
  const lines = [
    `# ${subject}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Gmail",
    `- Message ID: ${messageId}`,
    threadId ? `- Thread ID: ${threadId}` : null,
    sender ? `- From: ${sender}` : null,
    recipient ? `- To: ${recipient}` : null,
    internalDate ? `- Received at: ${internalDate}` : null,
    historyId ? `- History ID: ${historyId}` : null,
    labelIds.length > 0 ? `- Labels: ${labelIds.join(", ")}` : null,
    "",
    "## Summary",
    "",
    snippet ?? "No snippet available.",
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "gmail",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `message:${messageId}`,
    title: subject,
    summary: clipText(summaryParts.join(" "), 220) || `Gmail message ${messageId}`,
    content: `${lines.join("\n").trim()}\n`,
    tags,
    sourceType: "gmail.message",
    sourceEventId: `gmail-message:${messageId}`,
    externalObjectId: messageId,
    externalObjectType: "gmail_message",
    observedAt: internalDate,
    confidence: 0.85,
  };
}

function buildGitHubProfileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  connectionId: string;
  profile: GitHubProfilePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const publicRepos = parseInteger(params.profile.public_repos);
  const followers = parseInteger(params.profile.followers);
  const following = parseInteger(params.profile.following);
  const email = normalizeString(params.profile.email);
  const name = normalizeString(params.profile.name);
  const login = normalizeString(params.profile.login) ?? params.accountKey;
  const bio = normalizeString(params.profile.bio);
  const company = normalizeString(params.profile.company);
  const profileUrl = normalizeString(params.profile.html_url);
  const lines = [
    "# GitHub account profile",
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: GitHub",
    `- Connection ID: ${params.connectionId}`,
    `- Login: ${login}`,
    name ? `- Name: ${name}` : null,
    email ? `- Email: ${email}` : null,
    company ? `- Company: ${company}` : null,
    profileUrl ? `- Profile URL: ${profileUrl}` : null,
    publicRepos !== null ? `- Public repositories: ${publicRepos}` : null,
    followers !== null ? `- Followers: ${followers}` : null,
    following !== null ? `- Following: ${following}` : null,
    `- Fetched at: ${params.fetchedAt}`,
    "",
    "## Summary",
    "",
    bio ?? `${params.accountLabel} GitHub profile snapshot.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "github",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    title: `GitHub profile for ${params.accountLabel}`,
    summary: clipText(
      `${login}${name ? ` (${name})` : ""} GitHub profile snapshot${publicRepos !== null ? ` with ${publicRepos} public repos` : ""}.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["github", "profile"],
    sourceType: "github.profile",
    sourceEventId: `github-profile:${params.accountKey}`,
    externalObjectId: params.accountKey,
    externalObjectType: "github_profile",
    observedAt: params.fetchedAt,
    confidence: 0.95,
  };
}

function buildGitHubRepositoryCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  repository: GitHubRepositoryPayload;
  readmeText: string | null;
}): IntegrationLeafCandidate | null {
  const repoIdentity = githubRepositoryOwnerAndName(params.repository);
  const fullName = githubRepositoryFullName(params.repository);
  if (!repoIdentity || !fullName) {
    return null;
  }
  const description = normalizeString(params.repository.description);
  const htmlUrl = normalizeString(params.repository.html_url);
  const updatedAt = timestampToIso(params.repository.updated_at)
    ?? timestampToIso(params.repository.pushed_at)
    ?? utcNowIso();
  const language = normalizeString(params.repository.language);
  const topics = stringList(params.repository.topics);
  const stars = parseInteger(params.repository.stargazers_count);
  const watchers = parseInteger(params.repository.watchers_count);
  const forks = parseInteger(params.repository.forks_count);
  const defaultBranch = normalizeString(params.repository.default_branch);
  const isPrivate = normalizeBoolean(params.repository.private);
  const isFork = normalizeBoolean(params.repository.fork);
  const readmeExcerpt = params.readmeText ? clipText(params.readmeText, 1800) : null;
  const lines = [
    `# ${fullName}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: GitHub",
    `- Repository: ${fullName}`,
    htmlUrl ? `- URL: ${htmlUrl}` : null,
    language ? `- Language: ${language}` : null,
    defaultBranch ? `- Default branch: ${defaultBranch}` : null,
    isPrivate !== null ? `- Private: ${isPrivate ? "yes" : "no"}` : null,
    isFork !== null ? `- Fork: ${isFork ? "yes" : "no"}` : null,
    stars !== null ? `- Stars: ${stars}` : null,
    watchers !== null ? `- Watchers: ${watchers}` : null,
    forks !== null ? `- Forks: ${forks}` : null,
    topics.length > 0 ? `- Topics: ${topics.join(", ")}` : null,
    updatedAt ? `- Updated at: ${updatedAt}` : null,
    "",
    "## Summary",
    "",
    description ?? "No repository description available.",
    "",
    readmeExcerpt ? "## README" : null,
    readmeExcerpt ? "" : null,
    readmeExcerpt,
    readmeExcerpt ? "" : null,
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "github",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `repository:${fullName}`,
    title: fullName,
    summary: clipText(
      [
        `Repository ${fullName}`,
        description ?? null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" - "),
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "github",
      "repository",
      safeTag(`repo:${fullName}`),
      ...(language ? [safeTag(`language:${language}`)] : []),
      ...topics.map((topic) => safeTag(`topic:${topic}`)),
    ].filter((item): item is string => Boolean(item)),
    sourceType: "github.repository",
    sourceEventId: `github-repository:${fullName}`,
    externalObjectId: fullName,
    externalObjectType: "github_repository",
    observedAt: updatedAt,
    confidence: 0.9,
  };
}

function buildGitHubNotificationCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  notification: GitHubNotificationPayload;
}): IntegrationLeafCandidate | null {
  const notificationId = normalizeString(params.notification.id);
  if (!notificationId) {
    return null;
  }
  const subject = isRecord(params.notification.subject) ? params.notification.subject : null;
  const repository = isRecord(params.notification.repository) ? params.notification.repository : null;
  const title = normalizeString(subject?.title) ?? `GitHub notification ${notificationId}`;
  const subjectType = normalizeString(subject?.type);
  const repositoryName = githubRepositoryFullName(repository);
  const reason = normalizeString(params.notification.reason);
  const unread = normalizeBoolean(params.notification.unread);
  const updatedAt = timestampToIso(params.notification.updated_at) ?? utcNowIso();
  const lastReadAt = timestampToIso(params.notification.last_read_at);
  const apiUrl = normalizeString(params.notification.url);
  const lines = [
    `# ${title}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: GitHub",
    `- Notification ID: ${notificationId}`,
    repositoryName ? `- Repository: ${repositoryName}` : null,
    subjectType ? `- Subject type: ${subjectType}` : null,
    reason ? `- Reason: ${reason}` : null,
    unread !== null ? `- Unread: ${unread ? "yes" : "no"}` : null,
    updatedAt ? `- Updated at: ${updatedAt}` : null,
    lastReadAt ? `- Last read at: ${lastReadAt}` : null,
    apiUrl ? `- API URL: ${apiUrl}` : null,
    "",
    "## Summary",
    "",
    clipText(
      [
        repositoryName ? `${repositoryName}:` : null,
        title,
        reason ? `(reason: ${reason})` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" "),
      260,
    ),
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "github",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `notification:${notificationId}`,
    title,
    summary: clipText(
      [
        repositoryName ? `Notification in ${repositoryName}` : "GitHub notification",
        title,
        reason ? `because ${reason}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" "),
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "github",
      "notification",
      ...(repositoryName ? [safeTag(`repo:${repositoryName}`)] : []),
      ...(reason ? [safeTag(`reason:${reason}`)] : []),
    ].filter((item): item is string => Boolean(item)),
    sourceType: "github.notification",
    sourceEventId: `github-notification:${notificationId}`,
    externalObjectId: notificationId,
    externalObjectType: "github_notification",
    observedAt: updatedAt,
    confidence: 0.82,
  };
}

function buildGitHubIssueCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  issue: GitHubIssuePayload;
  kindOverride?: "issue" | "pull";
}): IntegrationLeafCandidate | null {
  const id = normalizeString(params.issue.id) ?? normalizeString(params.issue.node_id);
  const number = parseInteger(params.issue.number);
  const title = normalizeString(params.issue.title);
  if (!id || !title) {
    return null;
  }
  const repositoryName = githubRepositoryFullName(params.issue.repository)
    ?? githubRepositoryFullName(params.issue.repository_url);
  const state = normalizeString(params.issue.state);
  const body = normalizeString(params.issue.body);
  const htmlUrl = normalizeString(params.issue.html_url);
  const updatedAt = timestampToIso(params.issue.updated_at)
    ?? timestampToIso(params.issue.created_at)
    ?? utcNowIso();
  const author = isRecord(params.issue.user) ? normalizeString(params.issue.user.login) : null;
  const inferredPullRequest = isRecord(params.issue.pull_request);
  const isPullRequest = params.kindOverride
    ? params.kindOverride === "pull"
    : inferredPullRequest;
  const labelNames = Array.isArray(params.issue.labels)
    ? params.issue.labels
      .filter(isRecord)
      .map((label) => normalizeString(label.name))
      .filter((label): label is string => Boolean(label))
    : [];
  const kindLabel = isPullRequest ? "Pull request" : "Issue";
  const lines = [
    `# ${title}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: GitHub",
    `- Type: ${kindLabel}`,
    number !== null ? `- Number: #${number}` : null,
    repositoryName ? `- Repository: ${repositoryName}` : null,
    state ? `- State: ${state}` : null,
    author ? `- Author: ${author}` : null,
    labelNames.length > 0 ? `- Labels: ${labelNames.join(", ")}` : null,
    updatedAt ? `- Updated at: ${updatedAt}` : null,
    htmlUrl ? `- URL: ${htmlUrl}` : null,
    "",
    "## Summary",
    "",
    body ? clipText(body, 900) : "No body available.",
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "github",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `${isPullRequest ? "pull" : "issue"}:${repositoryName ?? "github"}:${number ?? id}`,
    title: repositoryName && number !== null ? `${repositoryName} #${number}: ${title}` : title,
    summary: clipText(
      [
        repositoryName ? `${kindLabel} in ${repositoryName}` : kindLabel,
        number !== null ? `#${number}` : null,
        title,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" "),
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "github",
      isPullRequest ? "pull-request" : "issue",
      ...(repositoryName ? [safeTag(`repo:${repositoryName}`)] : []),
      ...(state ? [safeTag(`state:${state}`)] : []),
      ...labelNames.map((label) => safeTag(`label:${label}`)),
    ].filter((item): item is string => Boolean(item)),
    sourceType: isPullRequest ? "github.pull_request" : "github.issue",
    sourceEventId: `${isPullRequest ? "github-pr" : "github-issue"}:${repositoryName ?? "github"}:${number ?? id}`,
    externalObjectId: repositoryName && number !== null ? `${repositoryName}#${number}` : id,
    externalObjectType: isPullRequest ? "github_pull_request" : "github_issue",
    observedAt: updatedAt,
    confidence: 0.84,
  };
}

function buildSlackProfileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  connectionId: string;
  auth: SlackAuthPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const teamId = normalizeString(params.auth.team_id);
  const team = normalizeString(params.auth.team);
  const user = normalizeString(params.auth.user);
  const userId = normalizeString(params.auth.user_id);
  const botId = normalizeString(params.auth.bot_id);
  const workspaceUrl = normalizeString(params.auth.url);
  const lines = [
    "# Slack workspace profile",
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Slack",
    `- Connection ID: ${params.connectionId}`,
    team ? `- Team: ${team}` : null,
    teamId ? `- Team ID: ${teamId}` : null,
    user ? `- User: ${user}` : null,
    userId ? `- User ID: ${userId}` : null,
    botId ? `- Bot ID: ${botId}` : null,
    workspaceUrl ? `- Workspace URL: ${workspaceUrl}` : null,
    `- Fetched at: ${params.fetchedAt}`,
    "",
    "## Summary",
    "",
    `${params.accountLabel} Slack workspace snapshot.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "slack",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    title: `Slack profile for ${params.accountLabel}`,
    summary: clipText(
      `${params.accountLabel} Slack workspace snapshot${user ? ` for ${user}` : ""}.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["slack", "profile"],
    sourceType: "slack.profile",
    sourceEventId: `slack-profile:${params.accountKey}`,
    externalObjectId: params.accountKey,
    externalObjectType: "slack_workspace",
    observedAt: params.fetchedAt,
    confidence: 0.95,
  };
}

function buildSlackChannelCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  channel: SlackChannelPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const channelId = normalizeString(params.channel.id);
  const channelName = normalizeString(params.channel.name);
  if (!channelId || !channelName) {
    return null;
  }
  const isPrivate = normalizeBoolean(params.channel.is_private);
  const isArchived = normalizeBoolean(params.channel.is_archived);
  const isIm = normalizeBoolean(params.channel.is_im);
  const isMpim = normalizeBoolean(params.channel.is_mpim);
  const numMembers = parseInteger(params.channel.num_members);
  const purpose = slackNestedText(params.channel.purpose);
  const topic = slackNestedText(params.channel.topic);
  const visibility = isIm ? "dm" : isMpim ? "group-dm" : isPrivate ? "private channel" : "public channel";
  const lines = [
    `# #${channelName}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Slack",
    `- Channel ID: ${channelId}`,
    `- Visibility: ${visibility}`,
    isArchived !== null ? `- Archived: ${isArchived ? "yes" : "no"}` : null,
    numMembers !== null ? `- Members: ${numMembers}` : null,
    topic ? `- Topic: ${topic}` : null,
    purpose ? `- Purpose: ${purpose}` : null,
    `- Fetched at: ${params.fetchedAt}`,
    "",
    "## Summary",
    "",
    purpose ?? topic ?? `Slack ${visibility} ${channelName}.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "slack",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `channel:${channelId}`,
    title: `#${channelName}`,
    summary: clipText(
      `Slack ${visibility} #${channelName}${topic ? ` about ${topic}` : purpose ? ` - ${purpose}` : ""}.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "slack",
      "channel",
      safeTag(`channel:${channelName}`),
      safeTag(`visibility:${visibility}`),
    ].filter((item): item is string => Boolean(item)),
    sourceType: "slack.channel",
    sourceEventId: `slack-channel:${channelId}`,
    externalObjectId: channelId,
    externalObjectType: "slack_channel",
    observedAt: params.fetchedAt,
    confidence: 0.84,
  };
}

function buildSlackMessageCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  channelId: string;
  channelName: string;
  message: SlackMessagePayload;
}): IntegrationLeafCandidate | null {
  const ts = normalizeString(params.message.ts);
  const text = normalizeString(params.message.text);
  if (!ts || !text) {
    return null;
  }
  const user = normalizeString(params.message.user);
  const subtype = normalizeString(params.message.subtype);
  const threadTs = normalizeString(params.message.thread_ts);
  const replyCount = parseInteger(params.message.reply_count);
  const latestReply = timestampToIso(params.message.latest_reply);
  const observedAt = timestampToIso(ts) ?? utcNowIso();
  const lines = [
    `# Slack message in #${params.channelName}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Slack",
    `- Channel: #${params.channelName}`,
    `- Channel ID: ${params.channelId}`,
    `- Timestamp: ${ts}`,
    user ? `- User: ${user}` : null,
    subtype ? `- Subtype: ${subtype}` : null,
    threadTs ? `- Thread TS: ${threadTs}` : null,
    replyCount !== null ? `- Reply count: ${replyCount}` : null,
    latestReply ? `- Latest reply: ${latestReply}` : null,
    observedAt ? `- Observed at: ${observedAt}` : null,
    "",
    "## Summary",
    "",
    clipText(text, 900),
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "slack",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `message:${params.channelId}:${ts}`,
    title: `#${params.channelName}: ${clipText(text, 72)}`,
    summary: clipText(
      `${user ? `${user} in ` : ""}#${params.channelName}: ${text}`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "slack",
      "message",
      safeTag(`channel:${params.channelName}`),
      ...(threadTs ? ["thread"] : []),
    ].filter((item): item is string => Boolean(item)),
    sourceType: "slack.message",
    sourceEventId: `slack-message:${params.channelId}:${ts}`,
    externalObjectId: `${params.channelId}:${ts}`,
    externalObjectType: "slack_message",
    observedAt,
    confidence: 0.8,
  };
}

function updatePersistStats(
  result: PersistedIntegrationLeafResult,
  stats: { created: number; superseding: number; unchanged: number },
): void {
  if (result.outcome === "created") {
    stats.created += 1;
    return;
  }
  if (result.outcome === "superseding") {
    stats.superseding += 1;
    return;
  }
  stats.unchanged += 1;
}

function resolveComposioClient(client?: ComposioExecuteClient | null): ComposioExecuteClient {
  if (client) {
    return client;
  }
  const resolved = createComposioApiClientFromEnv();
  if (!resolved) {
    throw new Error(
      "HOLABOSS_AUTH_BEARER_TOKEN and/or HOLABOSS_AUTH_BASE_URL not set — desktop hasn't injected the session token yet.",
    );
  }
  return resolved;
}

function persistConnectionIdentity(params: {
  store: RuntimeStateStore;
  connectionId: string;
  accountHandle?: string | null;
  accountEmail?: string | null;
}): void {
  const existing = params.store.getIntegrationConnection(params.connectionId);
  if (!existing) {
    return;
  }
  const nextHandle = params.accountHandle ?? existing.accountHandle;
  const nextEmail = params.accountEmail ?? existing.accountEmail;
  const sameHandle = (existing.accountHandle ?? "").trim().toLowerCase() === (nextHandle ?? "").trim().toLowerCase();
  const sameEmail = (existing.accountEmail ?? "").trim().toLowerCase() === (nextEmail ?? "").trim().toLowerCase();
  if (sameHandle && sameEmail) {
    return;
  }
  params.store.upsertIntegrationConnection({
    connectionId: existing.connectionId,
    providerId: existing.providerId,
    ownerUserId: existing.ownerUserId,
    accountLabel: existing.accountLabel,
    accountExternalId: existing.accountExternalId,
    accountHandle: nextHandle,
    accountEmail: nextEmail,
    authMode: existing.authMode,
    grantedScopes: existing.grantedScopes,
    status: existing.status,
    secretRef: existing.secretRef,
  });
}

export function supportsIntegrationContextFetchProvider(providerId: string): boolean {
  const normalized = providerId.trim().toLowerCase();
  return normalized === "gmail" || normalized === "github" || normalized === "slack";
}

async function fetchGmailIntegrationContext(params: {
  store: RuntimeStateStore;
  connectionId: string;
  composio: ComposioExecuteClient;
  fetchedAt: string;
}): Promise<IntegrationContextFetchResult> {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const connectedAccountId = connection.accountExternalId ?? "";
  const persistStats = { created: 0, superseding: 0, unchanged: 0 };
  const actions: string[] = [];

  const profileResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GMAIL_GET_PROFILE",
    arguments: { user_id: "me" },
  });
  actions.push("GMAIL_GET_PROFILE");
  const profile = gmailProfileFromData(profileResult.data);
  const resolvedEmail = normalizeString(profile?.emailAddress);
  const accountKey = resolvedEmail
    ?? normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  if (resolvedEmail) {
    persistConnectionIdentity({
      store: params.store,
      connectionId: connection.connectionId,
      accountEmail: resolvedEmail,
    });
  }
  const accountLabel = resolvedEmail ?? accountKey;

  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildGmailProfileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      connectionId: connection.connectionId,
      profile: profile ?? {},
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);

  const emailsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GMAIL_FETCH_EMAILS",
    arguments: {
      user_id: "me",
      max_results: GMAIL_RECENT_MESSAGE_LIMIT,
      verbose: false,
      include_payload: false,
      include_spam_trash: false,
    },
  });
  actions.push("GMAIL_FETCH_EMAILS");
  const messages = gmailMessagesFromData(emailsResult.data).sort((left, right) => {
    const leftTime = Number.parseInt(String(left.internalDate ?? 0), 10);
    const rightTime = Number.parseInt(String(right.internalDate ?? 0), 10);
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
  });

  let messagesPersisted = 0;
  for (const message of messages) {
    const candidate = buildGmailMessageCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      message,
      fetchedAt: params.fetchedAt,
    });
    if (!candidate) {
      continue;
    }
    const persisted = await persistIntegrationCandidate({
      store: params.store,
      workspaceId: "",
      candidate,
      embeddingClient: null,
    });
    updatePersistStats(persisted, persistStats);
    messagesPersisted += 1;
  }

  const treeId = profilePersist.tree.treeId;
  await rebuildIntegrationTree({
    store: params.store,
    workspaceId: "",
    treeId,
    summaryModelClient: null,
    embeddingClient: null,
  });

  const summaryNodes = params.store.listIntegrationSummaryNodes({
    treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  }).length;

  return {
    ok: true,
    supported: true,
    provider_id: "gmail",
    connection_id: connection.connectionId,
    account_key: accountKey,
    account_label: accountLabel,
    tree_id: treeId,
    fetched_at: params.fetchedAt,
    leaves_created: persistStats.created,
    leaves_superseding: persistStats.superseding,
    leaves_unchanged: persistStats.unchanged,
    messages_seen: messages.length,
    messages_persisted: messagesPersisted,
    summary_nodes: summaryNodes,
    actions,
  };
}

async function fetchGitHubIntegrationContext(params: {
  store: RuntimeStateStore;
  connectionId: string;
  composio: ComposioExecuteClient;
  fetchedAt: string;
}): Promise<IntegrationContextFetchResult> {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const connectedAccountId = connection.accountExternalId ?? "";
  const persistStats = { created: 0, superseding: 0, unchanged: 0 };
  const actions: string[] = [];

  const profileResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GITHUB_GET_THE_AUTHENTICATED_USER",
    arguments: {},
  });
  actions.push("GITHUB_GET_THE_AUTHENTICATED_USER");
  const profile = gitHubProfileFromData(profileResult.data);
  const login = normalizeString(profile?.login);
  const email = normalizeString(profile?.email);
  const accountKey = login
    ?? email
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  if (login || email) {
    persistConnectionIdentity({
      store: params.store,
      connectionId: connection.connectionId,
      accountHandle: login,
      accountEmail: email,
    });
  }
  const accountLabel = normalizeString(profile?.name) ?? login ?? email ?? accountKey;

  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildGitHubProfileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      connectionId: connection.connectionId,
      profile: profile ?? {},
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);

  const notificationsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GITHUB_LIST_NOTIFICATIONS",
    arguments: {
      all: false,
      participating: true,
      per_page: GITHUB_NOTIFICATIONS_LIMIT,
      page: 1,
    },
  });
  actions.push("GITHUB_LIST_NOTIFICATIONS");
  const notifications = gitHubNotificationsFromData(notificationsResult.data);

  const repositoriesResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GITHUB_FIND_REPOSITORIES",
    arguments: {
      query: "stars:>=0",
      owner: login ?? accountKey,
      sort: "updated",
      order: "desc",
      per_page: GITHUB_REPOSITORY_LIMIT,
      page: 1,
      response_detail: "full",
      for_authenticated_user: true,
      archived: false,
      fork_filter: "exclude",
    },
  });
  actions.push("GITHUB_FIND_REPOSITORIES");
  const repositories = gitHubRepositoriesFromData(repositoriesResult.data);

  let contentSeen = 0;
  let contentPersisted = 0;
  for (const notification of notifications) {
    contentSeen += 1;
    const candidate = buildGitHubNotificationCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      notification,
    });
    if (!candidate) {
      continue;
    }
    const persisted = await persistIntegrationCandidate({
      store: params.store,
      workspaceId: "",
      candidate,
      embeddingClient: null,
    });
    updatePersistStats(persisted, persistStats);
    contentPersisted += 1;
  }

  for (const repository of repositories) {
    contentSeen += 1;
    const repoIdentity = githubRepositoryOwnerAndName(repository);
    const fullName = githubRepositoryFullName(repository);
    if (!repoIdentity || !fullName) {
      continue;
    }

    let readmeText: string | null = null;
    try {
      const readmeResult = await params.composio.executeAction({
        connectedAccountId,
        toolSlug: "GITHUB_GET_A_REPOSITORY_README",
        arguments: {
          owner: repoIdentity.owner,
          repo: repoIdentity.repo,
        },
      });
      actions.push(`GITHUB_GET_A_REPOSITORY_README:${fullName}`);
      const readme = gitHubReadmeFromData(readmeResult.data);
      readmeText = decodeMaybeBase64(readme?.content, readme?.encoding);
    } catch (error) {
      if (!(error instanceof ComposioApiClientError) || error.httpStatus !== 404) {
        throw error;
      }
    }

    const repoCandidate = buildGitHubRepositoryCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      repository,
      readmeText,
    });
    if (repoCandidate) {
      const persisted = await persistIntegrationCandidate({
        store: params.store,
        workspaceId: "",
        candidate: repoCandidate,
        embeddingClient: null,
      });
      updatePersistStats(persisted, persistStats);
      contentPersisted += 1;
    }

    const pullRequestsResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "GITHUB_LIST_PULL_REQUESTS",
      arguments: {
        owner: repoIdentity.owner,
        repo: repoIdentity.repo,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: GITHUB_REPOSITORY_PULL_REQUEST_LIMIT,
        page: 1,
      },
    });
    actions.push(`GITHUB_LIST_PULL_REQUESTS:${fullName}`);
    const pullRequests = gitHubIssuesFromData(pullRequestsResult.data);
    for (const pullRequest of pullRequests) {
      contentSeen += 1;
      const candidate = buildGitHubIssueCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        issue: {
          ...pullRequest,
          repository: pullRequest.repository ?? repository,
          pull_request: isRecord(pullRequest.pull_request) ? pullRequest.pull_request : { url: true },
        },
        kindOverride: "pull",
      });
      if (!candidate) {
        continue;
      }
      const persisted = await persistIntegrationCandidate({
        store: params.store,
        workspaceId: "",
        candidate,
        embeddingClient: null,
      });
      updatePersistStats(persisted, persistStats);
      contentPersisted += 1;
    }

    const issuesResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "GITHUB_LIST_REPOSITORY_ISSUES",
      arguments: {
        owner: repoIdentity.owner,
        repo: repoIdentity.repo,
        state: "open",
        per_page: GITHUB_REPOSITORY_ISSUE_LIMIT,
        page: 1,
      },
    });
    actions.push(`GITHUB_LIST_REPOSITORY_ISSUES:${fullName}`);
    const issues = gitHubIssuesFromData(issuesResult.data);
    for (const issue of issues) {
      if (isRecord(issue.pull_request)) {
        continue;
      }
      contentSeen += 1;
      const candidate = buildGitHubIssueCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        issue: {
          ...issue,
          repository: issue.repository ?? repository,
        },
        kindOverride: "issue",
      });
      if (!candidate) {
        continue;
      }
      const persisted = await persistIntegrationCandidate({
        store: params.store,
        workspaceId: "",
        candidate,
        embeddingClient: null,
      });
      updatePersistStats(persisted, persistStats);
      contentPersisted += 1;
    }
  }

  const treeId = profilePersist.tree.treeId;
  await rebuildIntegrationTree({
    store: params.store,
    workspaceId: "",
    treeId,
    summaryModelClient: null,
    embeddingClient: null,
  });

  const summaryNodes = params.store.listIntegrationSummaryNodes({
    treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  }).length;

  return {
    ok: true,
    supported: true,
    provider_id: "github",
    connection_id: connection.connectionId,
    account_key: accountKey,
    account_label: accountLabel,
    tree_id: treeId,
    fetched_at: params.fetchedAt,
    leaves_created: persistStats.created,
    leaves_superseding: persistStats.superseding,
    leaves_unchanged: persistStats.unchanged,
    messages_seen: contentSeen,
    messages_persisted: contentPersisted,
    summary_nodes: summaryNodes,
    actions,
  };
}

async function fetchSlackIntegrationContext(params: {
  store: RuntimeStateStore;
  connectionId: string;
  composio: ComposioExecuteClient;
  fetchedAt: string;
}): Promise<IntegrationContextFetchResult> {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const connectedAccountId = connection.accountExternalId ?? "";
  const persistStats = { created: 0, superseding: 0, unchanged: 0 };
  const actions: string[] = [];

  const authResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "SLACK_TEST_AUTH",
    arguments: {},
  });
  actions.push("SLACK_TEST_AUTH");
  const auth = slackAuthFromData(authResult.data);
  const teamId = normalizeString(auth?.team_id);
  const team = normalizeString(auth?.team);
  const workspaceUrl = normalizeString(auth?.url);
  const accountKey = teamId
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  if (teamId) {
    persistConnectionIdentity({
      store: params.store,
      connectionId: connection.connectionId,
      accountHandle: teamId,
    });
  }
  const accountLabel = team ?? workspaceUrl ?? teamId ?? accountKey;

  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildSlackProfileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      connectionId: connection.connectionId,
      auth: auth ?? {},
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);

  const channelsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "SLACK_LIST_ALL_CHANNELS",
    arguments: {
      limit: SLACK_CHANNEL_LIMIT,
      types: "public_channel,private_channel",
      exclude_archived: true,
    },
  });
  actions.push("SLACK_LIST_ALL_CHANNELS");
  const channels = slackChannelsFromData(channelsResult.data)
    .filter((channel) => normalizeBoolean(channel.is_archived) !== true);

  let contentSeen = 0;
  let contentPersisted = 0;
  for (const channel of channels) {
    contentSeen += 1;
    const candidate = buildSlackChannelCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      channel,
      fetchedAt: params.fetchedAt,
    });
    if (!candidate) {
      continue;
    }
    const persisted = await persistIntegrationCandidate({
      store: params.store,
      workspaceId: "",
      candidate,
      embeddingClient: null,
    });
    updatePersistStats(persisted, persistStats);
    contentPersisted += 1;
  }

  const historyChannels = channels
    .map((channel) => ({
      id: normalizeString(channel.id),
      name: normalizeString(channel.name),
    }))
    .filter((channel): channel is { id: string; name: string } => Boolean(channel.id && channel.name))
    .slice(0, SLACK_CHANNEL_HISTORY_TARGETS);

  for (const channel of historyChannels) {
    const historyResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "SLACK_FETCH_CONVERSATION_HISTORY",
      arguments: {
        channel: channel.id,
        limit: SLACK_CHANNEL_HISTORY_LIMIT,
        include_all_metadata: false,
      },
    });
    actions.push(`SLACK_FETCH_CONVERSATION_HISTORY:${channel.id}`);
    const messages = slackMessagesFromData(historyResult.data);
    for (const message of messages) {
      contentSeen += 1;
      const candidate = buildSlackMessageCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        channelId: channel.id,
        channelName: channel.name,
        message,
      });
      if (!candidate) {
        continue;
      }
      const persisted = await persistIntegrationCandidate({
        store: params.store,
        workspaceId: "",
        candidate,
        embeddingClient: null,
      });
      updatePersistStats(persisted, persistStats);
      contentPersisted += 1;
    }
  }

  const treeId = profilePersist.tree.treeId;
  await rebuildIntegrationTree({
    store: params.store,
    workspaceId: "",
    treeId,
    summaryModelClient: null,
    embeddingClient: null,
  });

  const summaryNodes = params.store.listIntegrationSummaryNodes({
    treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  }).length;

  return {
    ok: true,
    supported: true,
    provider_id: "slack",
    connection_id: connection.connectionId,
    account_key: accountKey,
    account_label: accountLabel,
    tree_id: treeId,
    fetched_at: params.fetchedAt,
    leaves_created: persistStats.created,
    leaves_superseding: persistStats.superseding,
    leaves_unchanged: persistStats.unchanged,
    messages_seen: contentSeen,
    messages_persisted: contentPersisted,
    summary_nodes: summaryNodes,
    actions,
  };
}

export async function fetchIntegrationContextForConnection(params: {
  store: RuntimeStateStore;
  connectionId: string;
  composioClient?: ComposioExecuteClient | null;
}): Promise<IntegrationContextFetchResult> {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const providerId = connection.providerId.trim().toLowerCase();
  const fetchedAt = utcNowIso();
  if (!supportsIntegrationContextFetchProvider(providerId)) {
    return {
      ok: true,
      supported: false,
      provider_id: providerId,
      connection_id: connection.connectionId,
      account_key: null,
      account_label: connection.accountLabel,
      tree_id: null,
      fetched_at: fetchedAt,
      leaves_created: 0,
      leaves_superseding: 0,
      leaves_unchanged: 0,
      messages_seen: 0,
      messages_persisted: 0,
      summary_nodes: 0,
      actions: [],
      reason: "provider_not_supported",
    };
  }
  if ((connection.accountExternalId ?? "").trim().length === 0) {
    throw new Error(`integration connection ${connection.connectionId} has no connected account id`);
  }

  const composio = resolveComposioClient(params.composioClient ?? null);
  if (providerId === "gmail") {
    return fetchGmailIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
    });
  }
  if (providerId === "github") {
    return fetchGitHubIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
    });
  }
  return fetchSlackIntegrationContext({
    store: params.store,
    connectionId: connection.connectionId,
    composio,
    fetchedAt,
  });
}

export function normalizeComposioError(error: unknown): { statusCode: number; message: string } {
  if (error instanceof ComposioApiClientError) {
    return {
      statusCode: error.httpStatus,
      message: error.info.message ?? error.info.code,
    };
  }
  return {
    statusCode: 500,
    message: error instanceof Error ? error.message : String(error),
  };
}
