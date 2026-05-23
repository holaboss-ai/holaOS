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

const GMAIL_RECENT_THREAD_LIMIT = 100;
const GITHUB_NOTIFICATIONS_LIMIT = 50;
const GITHUB_REPOSITORY_LIMIT = 12;
const GITHUB_REPOSITORY_PULL_REQUEST_LIMIT = 10;
const GITHUB_REPOSITORY_ISSUE_LIMIT = 10;
const NOTION_SEARCH_LIMIT = 30;
const NOTION_DATABASE_ROW_LIMIT = 15;
const SLACK_CHANNEL_LIMIT = 8;
const SLACK_CHANNEL_HISTORY_LIMIT = 12;
const SLACK_CHANNEL_HISTORY_TARGETS = 4;

type ComposioExecuteClient = Pick<ComposioApiClient, "executeAction"> & {
  proxyRequest?: ComposioApiClient["proxyRequest"];
};

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

export interface IntegrationContextFetchProgressSnapshot {
  provider_id: string;
  connection_id: string;
  account_key: string | null;
  account_label: string | null;
  tree_id: string | null;
  current_chunk_label: string | null;
  chunks_total: number;
  chunks_completed: number;
  messages_seen: number;
  messages_persisted: number;
  leaves_created: number;
  leaves_superseding: number;
  leaves_unchanged: number;
  summary_nodes: number;
  actions: string[];
}

interface IntegrationContextFetchProgressReporter {
  patch(
    next: Partial<IntegrationContextFetchProgressSnapshot>,
  ): IntegrationContextFetchProgressSnapshot;
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

interface GmailThreadPayload {
  id?: unknown;
  threadId?: unknown;
  snippet?: unknown;
  historyId?: unknown;
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

interface NotionSearchObjectPayload {
  object?: unknown;
  id?: unknown;
  url?: unknown;
  public_url?: unknown;
  created_time?: unknown;
  last_edited_time?: unknown;
  title?: unknown;
  properties?: unknown;
  parent?: unknown;
}

interface NotionDatabasePayload extends NotionSearchObjectPayload {}

interface NotionRowPayload extends NotionSearchObjectPayload {}

function isMissingComposioToolError(error: unknown, toolSlug: string): boolean {
  if (!(error instanceof ComposioApiClientError)) {
    return false;
  }
  const code = String(error.info.code ?? "").toLowerCase();
  const message = String(error.info.message ?? error.message ?? "").toLowerCase();
  const slug = String(error.info.slug ?? "").toLowerCase();
  const target = toolSlug.toLowerCase();
  return (
    (code.includes("not_found") || code.includes("notfound"))
    && (message.includes("tool") || slug.includes("tool"))
  ) || (
    message.includes(target) && message.includes("not found")
  ) || (
    slug.includes(target) && slug.includes("notfound")
  );
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isComposioNotFoundError(error: unknown): boolean {
  if (!(error instanceof ComposioApiClientError)) {
    return false;
  }
  if (error.httpStatus === 404) {
    return true;
  }
  const code = String(error.info.code ?? "").toLowerCase();
  if (code.includes("not_found") || code.includes("notfound")) {
    return true;
  }
  const message = String(error.info.message ?? error.message ?? "");
  const payload = parseJsonObject(message);
  const status = payload?.status;
  const statusString = typeof status === "string" ? status : null;
  const statusNumber = typeof status === "number"
    ? status
    : typeof statusString === "string" && /^\d+$/.test(statusString)
      ? Number(statusString)
      : null;
  if (statusNumber === 404) {
    return true;
  }
  const messageText = typeof payload?.message === "string"
    ? payload.message.toLowerCase()
    : message.toLowerCase();
  return messageText.includes("not found");
}

function isComposioForbiddenError(error: unknown): boolean {
  if (!(error instanceof ComposioApiClientError)) {
    return false;
  }
  if (error.httpStatus === 403) {
    return true;
  }
  const code = String(error.info.code ?? "").toLowerCase();
  if (code === "403" || code.includes("forbidden")) {
    return true;
  }
  const message = String(error.info.message ?? error.message ?? "");
  const payload = parseJsonObject(message);
  const nestedError = isRecord(payload?.error) ? payload.error : null;
  const status = payload?.status ?? nestedError?.status ?? nestedError?.code;
  const statusString = typeof status === "string" ? status : null;
  const statusNumber = typeof status === "number"
    ? status
    : typeof statusString === "string" && /^\d+$/.test(statusString)
      ? Number(statusString)
      : null;
  if (statusNumber === 403) {
    return true;
  }
  const messageText = typeof nestedError?.message === "string"
    ? nestedError.message.toLowerCase()
    : typeof payload?.message === "string"
      ? payload.message.toLowerCase()
      : message.toLowerCase();
  return messageText.includes("forbidden");
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

function gmailThreadsFromData(value: unknown): GmailThreadPayload[] {
  return recordsFromData(value, ["threads"]) as GmailThreadPayload[];
}

function nextPageTokenFromData(value: unknown): string | null {
  const unwrapped = unwrapActionData(value);
  if (!isRecord(unwrapped)) {
    return null;
  }
  return normalizeString(unwrapped.nextPageToken)
    ?? normalizeString(unwrapped.next_page_token)
    ?? normalizeString(unwrapped.nextCursor)
    ?? normalizeString(unwrapped.next_cursor);
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

async function fetchGitHubRepositoriesForAccount(params: {
  composio: ComposioExecuteClient;
  connectedAccountId: string;
  accountKey: string;
  actions: string[];
}): Promise<GitHubRepositoryPayload[]> {
  if (params.composio.proxyRequest) {
    try {
      const result = await params.composio.proxyRequest({
        connectedAccountId: params.connectedAccountId,
        endpoint: `/user/repos?type=owner&sort=updated&direction=desc&per_page=${GITHUB_REPOSITORY_LIMIT}`,
        method: "GET",
      });
      params.actions.push("GITHUB_PROXY:/user/repos?type=owner");
      return gitHubRepositoriesFromData(result.data);
    } catch (error) {
      if (!isComposioForbiddenError(error)) {
        throw error;
      }
      params.actions.push("GITHUB_PROXY:/user/repos?type=owner:forbidden");
    }
    try {
      const result = await params.composio.proxyRequest({
        connectedAccountId: params.connectedAccountId,
        endpoint: `/users/${encodeURIComponent(params.accountKey)}/repos?type=owner&sort=updated&direction=desc&per_page=${GITHUB_REPOSITORY_LIMIT}`,
        method: "GET",
      });
      params.actions.push("GITHUB_PROXY:/users/{username}/repos?type=owner");
      return gitHubRepositoriesFromData(result.data);
    } catch (error) {
      if (!isComposioForbiddenError(error) && !isComposioNotFoundError(error)) {
        throw error;
      }
      params.actions.push("GITHUB_PROXY:/users/{username}/repos?type=owner:unavailable");
      return [];
    }
  }
  try {
    const repositoriesResult = await params.composio.executeAction({
      connectedAccountId: params.connectedAccountId,
      toolSlug: "GITHUB_FIND_REPOSITORIES",
      arguments: {
        query: "stars:>=0",
        owner: params.accountKey,
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
    params.actions.push("GITHUB_FIND_REPOSITORIES");
    return gitHubRepositoriesFromData(repositoriesResult.data);
  } catch (error) {
    if (!isComposioForbiddenError(error)) {
      throw error;
    }
    params.actions.push("GITHUB_FIND_REPOSITORIES:forbidden");
    return [];
  }
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

function notionObjectsFromData(value: unknown): NotionSearchObjectPayload[] {
  return recordsFromData(value, ["results", "pages", "databases"]) as NotionSearchObjectPayload[];
}

function notionDatabaseFromData(value: unknown): NotionDatabasePayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as NotionDatabasePayload) : null;
}

function notionMarkdownFromData(value: unknown): string | null {
  const unwrapped = unwrapActionData(value);
  if (typeof unwrapped === "string") {
    const trimmed = unwrapped.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!isRecord(unwrapped)) {
    return null;
  }
  return normalizeString(unwrapped.markdown)
    ?? normalizeString(unwrapped.content)
    ?? normalizeString(unwrapped.text);
}

function notionRichTextText(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeString(value);
  }
  if (Array.isArray(value)) {
    const text = value
      .map((item) => notionRichTextText(item))
      .filter((item): item is string => Boolean(item))
      .join(" ")
      .trim();
    return text.length > 0 ? text : null;
  }
  if (!isRecord(value)) {
    return null;
  }
  return normalizeString(value.plain_text)
    ?? normalizeString(value.content)
    ?? (isRecord(value.text) ? normalizeString(value.text.content) : null)
    ?? normalizeString(value.name)
    ?? (Array.isArray(value.title) ? notionRichTextText(value.title) : null)
    ?? (Array.isArray(value.rich_text) ? notionRichTextText(value.rich_text) : null);
}

function notionPropertyText(value: unknown): string | null {
  if (!isRecord(value)) {
    return notionRichTextText(value);
  }
  const type = normalizeString(value.type);
  if (type && type in value) {
    const nested = value[type];
    if (nested !== undefined) {
      const nestedText = notionPropertyText(nested);
      if (nestedText) {
        return nestedText;
      }
    }
  }
  if (Array.isArray(value.title)) {
    return notionRichTextText(value.title);
  }
  if (Array.isArray(value.rich_text)) {
    return notionRichTextText(value.rich_text);
  }
  if (isRecord(value.select)) {
    return normalizeString(value.select.name);
  }
  if (isRecord(value.status)) {
    return normalizeString(value.status.name);
  }
  if (Array.isArray(value.multi_select)) {
    const labels = value.multi_select
      .filter(isRecord)
      .map((item) => normalizeString(item.name))
      .filter((item): item is string => Boolean(item));
    return labels.length > 0 ? labels.join(", ") : null;
  }
  if (Array.isArray(value.people)) {
    const labels = value.people
      .filter(isRecord)
      .map((item) => normalizeString(item.name) ?? (isRecord(item.person) ? normalizeString(item.person.email) : null))
      .filter((item): item is string => Boolean(item));
    return labels.length > 0 ? labels.join(", ") : null;
  }
  if (Array.isArray(value.relation)) {
    const ids = value.relation
      .filter(isRecord)
      .map((item) => normalizeString(item.id))
      .filter((item): item is string => Boolean(item));
    return ids.length > 0 ? ids.join(", ") : null;
  }
  if (typeof value.checkbox === "boolean") {
    return value.checkbox ? "true" : "false";
  }
  if (typeof value.number === "number" && Number.isFinite(value.number)) {
    return String(value.number);
  }
  if (typeof value.url === "string") {
    return normalizeString(value.url);
  }
  if (typeof value.email === "string") {
    return normalizeString(value.email);
  }
  if (typeof value.phone_number === "string") {
    return normalizeString(value.phone_number);
  }
  if (isRecord(value.date)) {
    return normalizeString(value.date.start)
      ?? normalizeString(value.date.end);
  }
  if (isRecord(value.formula)) {
    return notionPropertyText(value.formula);
  }
  return notionRichTextText(value);
}

function notionPageTitle(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const titleFromTopLevel = notionRichTextText(value.title);
  if (titleFromTopLevel) {
    return titleFromTopLevel;
  }
  if (!isRecord(value.properties)) {
    return null;
  }
  for (const property of Object.values(value.properties)) {
    if (!isRecord(property)) {
      continue;
    }
    if (normalizeString(property.type) === "title" || Array.isArray(property.title)) {
      const title = notionPropertyText(property);
      if (title) {
        return title;
      }
    }
  }
  return null;
}

function notionDatabaseTitle(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return notionRichTextText(value.title)
    ?? notionPageTitle(value);
}

function notionParentDatabaseId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.parent)) {
    return null;
  }
  return normalizeString(value.parent.database_id);
}

function notionDatabasePropertyLabels(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value)
    .map(([name, property]) => {
      const type = isRecord(property) ? normalizeString(property.type) : null;
      return type ? `${name} (${type})` : name;
    })
    .filter((item) => item.trim().length > 0);
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
    branchKey: "profile",
    branchLabel: "Profile",
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
    entityKey: `thread:${threadId ?? messageId}`,
    entityLabel: subject,
    branchKey: "messages",
    branchLabel: "Messages",
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
    branchKey: "profile",
    branchLabel: "Profile",
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
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "github",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `repository:${fullName}`,
    entityKey: `repo:${fullName}`,
    entityLabel: fullName,
    branchKey: "overview",
    branchLabel: "Overview",
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

function buildGitHubReadmeCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  repository: GitHubRepositoryPayload;
  readmeText: string;
}): IntegrationLeafCandidate | null {
  const fullName = githubRepositoryFullName(params.repository);
  if (!fullName) {
    return null;
  }
  const htmlUrl = normalizeString(params.repository.html_url);
  const excerpt = clipText(params.readmeText, 4000);
  const lines = [
    `# README for ${fullName}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: GitHub",
    `- Repository: ${fullName}`,
    htmlUrl ? `- Repository URL: ${htmlUrl}` : null,
    "",
    "## Summary",
    "",
    excerpt,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "github",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `readme:${fullName}`,
    entityKey: `repo:${fullName}`,
    entityLabel: fullName,
    branchKey: "readme",
    branchLabel: "README",
    title: `${fullName} README`,
    summary: clipText(
      `README for ${fullName}: ${excerpt}`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "github",
      "readme",
      safeTag(`repo:${fullName}`),
    ].filter((item): item is string => Boolean(item)),
    sourceType: "github.readme",
    sourceEventId: `github-readme:${fullName}`,
    externalObjectId: fullName,
    externalObjectType: "github_readme",
    observedAt: timestampToIso(params.repository.updated_at) ?? timestampToIso(params.repository.pushed_at) ?? utcNowIso(),
    confidence: 0.88,
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
    entityKey: repositoryName ? `repo:${repositoryName}` : null,
    entityLabel: repositoryName,
    branchKey: "notifications",
    branchLabel: "Notifications",
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
    entityKey: repositoryName ? `repo:${repositoryName}` : null,
    entityLabel: repositoryName,
    branchKey: isPullRequest ? "pull_requests" : "issues",
    branchLabel: isPullRequest ? "Pull requests" : "Issues",
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
    branchKey: "profile",
    branchLabel: "Profile",
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
    entityKey: `channel:${channelId}`,
    entityLabel: `#${channelName}`,
    branchKey: "overview",
    branchLabel: "Overview",
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
    entityKey: `channel:${params.channelId}`,
    entityLabel: `#${params.channelName}`,
    branchKey: "messages",
    branchLabel: "Messages",
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

function buildNotionWorkspaceCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  connectionId: string;
  pagesCount: number;
  databasesCount: number;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const lines = [
    "# Notion workspace snapshot",
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Notion",
    `- Connection ID: ${params.connectionId}`,
    `- Pages discovered: ${params.pagesCount}`,
    `- Databases discovered: ${params.databasesCount}`,
    "",
    "## Summary",
    "",
    `${params.accountLabel} Notion workspace snapshot with ${params.pagesCount} pages and ${params.databasesCount} databases discovered by the current search window.`,
    "",
  ];
  return {
    provider: "notion",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "workspace_snapshot",
    branchKey: "workspace",
    branchLabel: "Workspace",
    title: `Notion workspace for ${params.accountLabel}`,
    summary: clipText(
      `${params.accountLabel} Notion workspace snapshot with ${params.pagesCount} pages and ${params.databasesCount} databases.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["notion", "workspace"],
    sourceType: "notion.workspace",
    sourceEventId: `notion-workspace:${params.accountKey}`,
    externalObjectId: params.accountKey,
    externalObjectType: "notion_workspace",
    observedAt: params.fetchedAt,
    confidence: 0.95,
  };
}

function buildNotionPageOverviewCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  page: NotionSearchObjectPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const pageId = normalizeString(params.page.id);
  if (!pageId) {
    return null;
  }
  const title = notionPageTitle(params.page) ?? `Notion page ${pageId}`;
  const url = normalizeString(params.page.url);
  const publicUrl = normalizeString(params.page.public_url);
  const createdAt = timestampToIso(params.page.created_time);
  const editedAt = timestampToIso(params.page.last_edited_time) ?? params.fetchedAt;
  const lines = [
    `# ${title}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Notion",
    `- Page ID: ${pageId}`,
    url ? `- URL: ${url}` : null,
    publicUrl ? `- Public URL: ${publicUrl}` : null,
    createdAt ? `- Created at: ${createdAt}` : null,
    editedAt ? `- Last edited at: ${editedAt}` : null,
    "",
    "## Summary",
    "",
    `Notion page overview for ${title}.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "notion",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `page:${pageId}`,
    entityKey: `page:${pageId}`,
    entityLabel: title,
    branchKey: "overview",
    branchLabel: "Overview",
    title,
    summary: clipText(`Notion page ${title}.`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["notion", "page"],
    sourceType: "notion.page",
    sourceEventId: `notion-page:${pageId}`,
    externalObjectId: pageId,
    externalObjectType: "notion_page",
    observedAt: editedAt,
    confidence: 0.86,
  };
}

function buildNotionPageMarkdownCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  page: NotionSearchObjectPayload;
  markdown: string;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const pageId = normalizeString(params.page.id);
  if (!pageId) {
    return null;
  }
  const title = notionPageTitle(params.page) ?? `Notion page ${pageId}`;
  const url = normalizeString(params.page.url);
  const editedAt = timestampToIso(params.page.last_edited_time) ?? params.fetchedAt;
  const excerpt = clipText(params.markdown, 4000);
  const lines = [
    `# ${title}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Notion",
    `- Page ID: ${pageId}`,
    url ? `- URL: ${url}` : null,
    editedAt ? `- Last edited at: ${editedAt}` : null,
    "",
    "## Summary",
    "",
    excerpt,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "notion",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `page_markdown:${pageId}`,
    entityKey: `page:${pageId}`,
    entityLabel: title,
    branchKey: "content",
    branchLabel: "Content",
    title: `${title} content`,
    summary: clipText(`Notion page content for ${title}: ${excerpt}`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["notion", "page", "content"],
    sourceType: "notion.page_markdown",
    sourceEventId: `notion-page-markdown:${pageId}`,
    externalObjectId: pageId,
    externalObjectType: "notion_page_markdown",
    observedAt: editedAt,
    confidence: 0.88,
  };
}

function buildNotionDatabaseOverviewCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  database: NotionDatabasePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const databaseId = normalizeString(params.database.id);
  if (!databaseId) {
    return null;
  }
  const title = notionDatabaseTitle(params.database) ?? `Notion database ${databaseId}`;
  const url = normalizeString(params.database.url);
  const propertyLabels = notionDatabasePropertyLabels(params.database.properties).slice(0, 12);
  const editedAt = timestampToIso(params.database.last_edited_time) ?? params.fetchedAt;
  const lines = [
    `# ${title}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Notion",
    `- Database ID: ${databaseId}`,
    url ? `- URL: ${url}` : null,
    editedAt ? `- Last edited at: ${editedAt}` : null,
    propertyLabels.length > 0 ? `- Properties: ${propertyLabels.join(", ")}` : null,
    "",
    "## Summary",
    "",
    propertyLabels.length > 0
      ? `Database properties: ${propertyLabels.join(", ")}`
      : "No database property metadata available.",
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "notion",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `database:${databaseId}`,
    entityKey: `database:${databaseId}`,
    entityLabel: title,
    branchKey: "overview",
    branchLabel: "Overview",
    title,
    summary: clipText(`Notion database ${title}.`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["notion", "database"],
    sourceType: "notion.database",
    sourceEventId: `notion-database:${databaseId}`,
    externalObjectId: databaseId,
    externalObjectType: "notion_database",
    observedAt: editedAt,
    confidence: 0.86,
  };
}

function buildNotionRowCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  databaseId: string;
  databaseTitle: string;
  row: NotionRowPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const rowId = normalizeString(params.row.id);
  if (!rowId) {
    return null;
  }
  const title = notionPageTitle(params.row) ?? `Row ${rowId}`;
  const url = normalizeString(params.row.url);
  const editedAt = timestampToIso(params.row.last_edited_time) ?? params.fetchedAt;
  const propertyLines = isRecord(params.row.properties)
    ? Object.entries(params.row.properties)
      .map(([name, property]) => {
        const text = notionPropertyText(property);
        return text ? `- ${name}: ${clipText(text, 180)}` : null;
      })
      .filter((line): line is string => Boolean(line))
      .slice(0, 12)
    : [];
  const lines = [
    `# ${title}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Notion",
    `- Database: ${params.databaseTitle}`,
    `- Row ID: ${rowId}`,
    url ? `- URL: ${url}` : null,
    editedAt ? `- Last edited at: ${editedAt}` : null,
    "",
    "## Properties",
    "",
    ...(propertyLines.length > 0 ? propertyLines : ["- No row properties available."]),
    "",
  ];
  return {
    provider: "notion",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `row:${params.databaseId}:${rowId}`,
    entityKey: `database:${params.databaseId}`,
    entityLabel: params.databaseTitle,
    branchKey: "rows",
    branchLabel: "Rows",
    title: `${params.databaseTitle}: ${title}`,
    summary: clipText(`Notion row in ${params.databaseTitle}: ${title}`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["notion", "database-row"],
    sourceType: "notion.database_row",
    sourceEventId: `notion-row:${params.databaseId}:${rowId}`,
    externalObjectId: rowId,
    externalObjectType: "notion_database_row",
    observedAt: editedAt,
    confidence: 0.82,
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

function createIntegrationContextFetchProgressReporter(params: {
  providerId: string;
  connectionId: string;
  accountLabel: string | null;
  onProgress?: ((snapshot: IntegrationContextFetchProgressSnapshot) => void) | null;
}): IntegrationContextFetchProgressReporter {
  let snapshot: IntegrationContextFetchProgressSnapshot = {
    provider_id: params.providerId,
    connection_id: params.connectionId,
    account_key: null,
    account_label: params.accountLabel,
    tree_id: null,
    current_chunk_label: null,
    chunks_total: 0,
    chunks_completed: 0,
    messages_seen: 0,
    messages_persisted: 0,
    leaves_created: 0,
    leaves_superseding: 0,
    leaves_unchanged: 0,
    summary_nodes: 0,
    actions: [],
  };
  return {
    patch(next) {
      snapshot = {
        ...snapshot,
        ...next,
        actions: next.actions ? [...next.actions] : snapshot.actions,
      };
      params.onProgress?.({
        ...snapshot,
        actions: [...snapshot.actions],
      });
      return {
        ...snapshot,
        actions: [...snapshot.actions],
      };
    },
  };
}

function retireIntegrationEntityLeaves(params: {
  store: RuntimeStateStore;
  treeId: string;
  entityPrefix: string;
  keepEntityKeys: Set<string>;
  supersededAt: string;
}): number {
  let retired = 0;
  for (const leaf of params.store.listIntegrationLeaves({
    treeId: params.treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  })) {
    if (!leaf.entityKey?.startsWith(params.entityPrefix)) {
      continue;
    }
    if (params.keepEntityKeys.has(leaf.entityKey)) {
      continue;
    }
    params.store.updateIntegrationLeafStatus({
      leafId: leaf.leafId,
      status: "superseded",
      supersededAt: params.supersededAt,
    });
    retired += 1;
  }
  return retired;
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
  return normalized === "gmail" || normalized === "github" || normalized === "notion" || normalized === "slack";
}

async function fetchGmailIntegrationContext(params: {
  store: RuntimeStateStore;
  connectionId: string;
  composio: ComposioExecuteClient;
  fetchedAt: string;
  progress?: IntegrationContextFetchProgressReporter | null;
}): Promise<IntegrationContextFetchResult> {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const connectedAccountId = connection.accountExternalId ?? "";
  const persistStats = { created: 0, superseding: 0, unchanged: 0 };
  const actions: string[] = [];
  let accountKey: string | null = null;
  let accountLabel: string | null = connection.accountLabel;
  let treeId: string | null = null;
  let messagesSeen = 0;
  let messagesPersisted = 0;
  let summaryNodes = 0;
  let chunksTotal = 4;
  let chunksCompleted = 0;
  const syncProgress = (patch: Partial<IntegrationContextFetchProgressSnapshot> = {}) => {
    params.progress?.patch({
      account_key: accountKey,
      account_label: accountLabel,
      tree_id: treeId,
      chunks_total: chunksTotal,
      chunks_completed: chunksCompleted,
      messages_seen: messagesSeen,
      messages_persisted: messagesPersisted,
      leaves_created: persistStats.created,
      leaves_superseding: persistStats.superseding,
      leaves_unchanged: persistStats.unchanged,
      summary_nodes: summaryNodes,
      actions,
      ...patch,
    });
  };

  syncProgress({ current_chunk_label: "Fetching Gmail profile" });
  const profileResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GMAIL_GET_PROFILE",
    arguments: { user_id: "me" },
  });
  actions.push("GMAIL_GET_PROFILE");
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Saving Gmail profile" });
  const profile = gmailProfileFromData(profileResult.data);
  const resolvedEmail = normalizeString(profile?.emailAddress);
  accountKey = resolvedEmail
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
  accountLabel = resolvedEmail ?? accountKey;

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
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Listing recent Gmail threads" });

  const threadsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GMAIL_LIST_THREADS",
    arguments: {
      user_id: "me",
      max_results: GMAIL_RECENT_THREAD_LIMIT,
      verbose: false,
    },
  });
  actions.push("GMAIL_LIST_THREADS");
  chunksCompleted += 1;
  const threads = gmailThreadsFromData(threadsResult.data);
  chunksTotal += threads.length;
  syncProgress({
    current_chunk_label:
      threads.length > 0
        ? `Hydrating Gmail threads (0/${threads.length})`
        : "Rebuilding Gmail context summary",
  });

  for (const [index, thread] of threads.entries()) {
    const threadId = normalizeString(thread.id) ?? normalizeString(thread.threadId);
    if (!threadId) {
      chunksCompleted += 1;
      syncProgress({
        current_chunk_label:
          index + 1 < threads.length
            ? `Hydrating Gmail threads (${index + 1}/${threads.length})`
            : "Rebuilding Gmail context summary",
      });
      continue;
    }

    const fetchedThreadMessages: GmailMessagePayload[] = [];
    let pageToken: string | null = null;
    let pageCount = 0;
    do {
      if (pageCount > 0) {
        chunksTotal += 1;
      }
      const threadMessagesResult = await params.composio.executeAction({
        connectedAccountId,
        toolSlug: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
        arguments: {
          user_id: "me",
          thread_id: threadId,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      actions.push(pageCount === 0
        ? `GMAIL_FETCH_MESSAGE_BY_THREAD_ID:${threadId}`
        : `GMAIL_FETCH_MESSAGE_BY_THREAD_ID:${threadId}:page:${pageCount + 1}`);
      pageCount += 1;
      fetchedThreadMessages.push(...gmailMessagesFromData(threadMessagesResult.data));
      pageToken = nextPageTokenFromData(threadMessagesResult.data);
    } while (pageToken);

    const messages = fetchedThreadMessages.sort((left, right) => {
      const leftTime = Number.parseInt(String(left.internalDate ?? 0), 10);
      const rightTime = Number.parseInt(String(right.internalDate ?? 0), 10);
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });
    messagesSeen += messages.length;
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
    chunksCompleted += pageCount;
    syncProgress({
      current_chunk_label:
        index + 1 < threads.length
          ? `Hydrating Gmail threads (${index + 1}/${threads.length})`
          : "Rebuilding Gmail context summary",
    });
  }

  await rebuildIntegrationTree({
    store: params.store,
    workspaceId: "",
    treeId,
    summaryModelClient: null,
    embeddingClient: null,
  });
  chunksCompleted += 1;

  summaryNodes = params.store.listIntegrationSummaryNodes({
    treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  }).length;
  syncProgress({ current_chunk_label: "Gmail context fetch complete" });

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
    messages_seen: messagesSeen,
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
  progress?: IntegrationContextFetchProgressReporter | null;
}): Promise<IntegrationContextFetchResult> {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const connectedAccountId = connection.accountExternalId ?? "";
  const persistStats = { created: 0, superseding: 0, unchanged: 0 };
  const actions: string[] = [];
  let accountKey: string | null = null;
  let accountLabel: string | null = connection.accountLabel;
  let treeId: string | null = null;
  let contentSeen = 0;
  let contentPersisted = 0;
  let summaryNodes = 0;
  let chunksTotal = 6;
  let chunksCompleted = 0;
  const syncProgress = (patch: Partial<IntegrationContextFetchProgressSnapshot> = {}) => {
    params.progress?.patch({
      account_key: accountKey,
      account_label: accountLabel,
      tree_id: treeId,
      chunks_total: chunksTotal,
      chunks_completed: chunksCompleted,
      messages_seen: contentSeen,
      messages_persisted: contentPersisted,
      leaves_created: persistStats.created,
      leaves_superseding: persistStats.superseding,
      leaves_unchanged: persistStats.unchanged,
      summary_nodes: summaryNodes,
      actions,
      ...patch,
    });
  };

  syncProgress({ current_chunk_label: "Fetching GitHub profile" });
  const profileResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GITHUB_GET_THE_AUTHENTICATED_USER",
    arguments: {},
  });
  actions.push("GITHUB_GET_THE_AUTHENTICATED_USER");
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Saving GitHub profile" });
  const profile = gitHubProfileFromData(profileResult.data);
  const login = normalizeString(profile?.login);
  const email = normalizeString(profile?.email);
  accountKey = login
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
  accountLabel = normalizeString(profile?.name) ?? login ?? email ?? accountKey;

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
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Fetching GitHub notifications" });

  let notifications: GitHubNotificationPayload[] = [];
  try {
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
    notifications = gitHubNotificationsFromData(notificationsResult.data);
  } catch (error) {
    if (
      !isMissingComposioToolError(error, "GITHUB_LIST_NOTIFICATIONS")
      && !isComposioForbiddenError(error)
    ) {
      throw error;
    }
    actions.push(
      isComposioForbiddenError(error)
        ? "GITHUB_LIST_NOTIFICATIONS:forbidden"
        : "GITHUB_LIST_NOTIFICATIONS:missing",
    );
  }
  chunksCompleted += 1;
  chunksTotal += notifications.length;
  syncProgress({
    current_chunk_label: "Fetching GitHub repositories",
  });

  const repositories = await fetchGitHubRepositoriesForAccount({
    composio: params.composio,
    connectedAccountId,
    accountKey: login ?? accountKey,
    actions,
  });
  chunksCompleted += 1;
  const fetchedRepositoryEntityKeys = new Set(
    repositories
      .map((repository) => githubRepositoryFullName(repository))
      .filter((fullName): fullName is string => Boolean(fullName))
      .map((fullName) => `repo:${fullName}`),
  );
  chunksTotal += repositories.length * 3;
  syncProgress({
    current_chunk_label:
      notifications.length > 0
        ? `Importing GitHub notifications (0/${notifications.length})`
        : repositories.length > 0
          ? `Importing GitHub repositories (0/${repositories.length})`
          : "Rebuilding GitHub context summary",
  });

  for (const [index, notification] of notifications.entries()) {
    contentSeen += 1;
    const candidate = buildGitHubNotificationCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      notification,
    });
    if (!candidate) {
      chunksCompleted += 1;
      syncProgress({
        current_chunk_label:
          index + 1 < notifications.length
            ? `Importing GitHub notifications (${index + 1}/${notifications.length})`
            : repositories.length > 0
              ? `Importing GitHub repositories (0/${repositories.length})`
              : "Rebuilding GitHub context summary",
      });
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
    chunksCompleted += 1;
    syncProgress({
      current_chunk_label:
        index + 1 < notifications.length
          ? `Importing GitHub notifications (${index + 1}/${notifications.length})`
          : repositories.length > 0
            ? `Importing GitHub repositories (0/${repositories.length})`
            : "Rebuilding GitHub context summary",
    });
  }

  for (const [index, repository] of repositories.entries()) {
    contentSeen += 1;
    const repoIdentity = githubRepositoryOwnerAndName(repository);
    const fullName = githubRepositoryFullName(repository);
    if (!repoIdentity || !fullName) {
      chunksCompleted += 3;
      syncProgress({
        current_chunk_label:
          index + 1 < repositories.length
            ? `Importing GitHub repositories (${index + 1}/${repositories.length})`
            : "Rebuilding GitHub context summary",
      });
      continue;
    }

    let readmeText: string | null = null;
    syncProgress({
      current_chunk_label: `Fetching GitHub README for ${fullName}`,
    });
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
      if (!isComposioNotFoundError(error) && !isComposioForbiddenError(error)) {
        throw error;
      }
      actions.push(
        isComposioForbiddenError(error)
          ? `GITHUB_GET_A_REPOSITORY_README:${fullName}:forbidden`
          : `GITHUB_GET_A_REPOSITORY_README:${fullName}:missing`,
      );
    }

    syncProgress({
      current_chunk_label: `Saving GitHub repository ${fullName}`,
    });
    const repoCandidate = buildGitHubRepositoryCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      repository,
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
    chunksCompleted += 1;
    syncProgress({
      current_chunk_label: `Fetching pull requests for ${fullName}`,
    });

    if (readmeText) {
      contentSeen += 1;
      const readmeCandidate = buildGitHubReadmeCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        repository,
        readmeText,
      });
      if (readmeCandidate) {
        const persisted = await persistIntegrationCandidate({
          store: params.store,
          workspaceId: "",
          candidate: readmeCandidate,
          embeddingClient: null,
        });
        updatePersistStats(persisted, persistStats);
        contentPersisted += 1;
      }
    }
    chunksCompleted += 1;

    try {
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
    } catch (error) {
      if (!isComposioForbiddenError(error)) {
        throw error;
      }
      actions.push(`GITHUB_LIST_PULL_REQUESTS:${fullName}:forbidden`);
    }
    chunksCompleted += 1;
    syncProgress({
      current_chunk_label:
        index + 1 < repositories.length
          ? `Importing GitHub repositories (${index + 1}/${repositories.length})`
          : "Rebuilding GitHub context summary",
    });

    try {
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
    } catch (error) {
      if (!isComposioForbiddenError(error)) {
        throw error;
      }
      actions.push(`GITHUB_LIST_REPOSITORY_ISSUES:${fullName}:forbidden`);
    }
  }

  syncProgress({ current_chunk_label: "Reconciling GitHub repositories" });
  const retiredRepoLeaves = retireIntegrationEntityLeaves({
    store: params.store,
    treeId,
    entityPrefix: "repo:",
    keepEntityKeys: fetchedRepositoryEntityKeys,
    supersededAt: params.fetchedAt,
  });
  if (retiredRepoLeaves > 0) {
    actions.push(`GITHUB_RETIRED_REPO_LEAVES:${retiredRepoLeaves}`);
  }
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Rebuilding GitHub context summary" });
  await rebuildIntegrationTree({
    store: params.store,
    workspaceId: "",
    treeId,
    summaryModelClient: null,
    embeddingClient: null,
  });
  chunksCompleted += 1;

  summaryNodes = params.store.listIntegrationSummaryNodes({
    treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  }).length;
  syncProgress({ current_chunk_label: "GitHub context fetch complete" });

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

async function fetchNotionIntegrationContext(params: {
  store: RuntimeStateStore;
  connectionId: string;
  composio: ComposioExecuteClient;
  fetchedAt: string;
  progress?: IntegrationContextFetchProgressReporter | null;
}): Promise<IntegrationContextFetchResult> {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const connectedAccountId = connection.accountExternalId ?? "";
  const persistStats = { created: 0, superseding: 0, unchanged: 0 };
  const actions: string[] = [];
  let accountKey = normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  let accountLabel = normalizeString(connection.accountLabel) ?? accountKey;
  let treeId: string | null = null;
  let contentSeen = 0;
  let contentPersisted = 0;
  let summaryNodes = 0;
  let chunksTotal = 3;
  let chunksCompleted = 0;
  const syncProgress = (patch: Partial<IntegrationContextFetchProgressSnapshot> = {}) => {
    params.progress?.patch({
      account_key: accountKey,
      account_label: accountLabel,
      tree_id: treeId,
      chunks_total: chunksTotal,
      chunks_completed: chunksCompleted,
      messages_seen: contentSeen,
      messages_persisted: contentPersisted,
      leaves_created: persistStats.created,
      leaves_superseding: persistStats.superseding,
      leaves_unchanged: persistStats.unchanged,
      summary_nodes: summaryNodes,
      actions,
      ...patch,
    });
  };

  syncProgress({ current_chunk_label: "Searching Notion pages and databases" });
  const searchResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "NOTION_SEARCH_NOTION_PAGE",
    arguments: {
      query: "",
      fetch_type: "all",
      page_size: NOTION_SEARCH_LIMIT,
    },
  });
  actions.push("NOTION_SEARCH_NOTION_PAGE");
  chunksCompleted += 1;
  const searchItems = notionObjectsFromData(searchResult.data);
  const pages = searchItems.filter((item) => normalizeString(item.object) === "page");
  const databaseSearchItems = searchItems.filter((item) => normalizeString(item.object) === "database");
  const pageEntityKeys = new Set(
    pages
      .map((page) => normalizeString(page.id))
      .filter((id): id is string => Boolean(id))
      .map((id) => `page:${id}`),
  );
  const databaseEntityKeys = new Set(
    databaseSearchItems
      .map((database) => normalizeString(database.id))
      .filter((id): id is string => Boolean(id))
      .map((id) => `database:${id}`),
  );

  const workspacePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildNotionWorkspaceCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      connectionId: connection.connectionId,
      pagesCount: pages.length,
      databasesCount: databaseSearchItems.length,
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(workspacePersist, persistStats);
  treeId = workspacePersist.tree.treeId;
  chunksCompleted += 1;

  chunksTotal += pages.length * 2 + databaseSearchItems.length * 2;
  syncProgress({
    current_chunk_label:
      pages.length > 0
        ? `Importing Notion pages (0/${pages.length})`
        : databaseSearchItems.length > 0
          ? `Importing Notion databases (0/${databaseSearchItems.length})`
          : "Rebuilding Notion context summary",
  });

  for (const [index, page] of pages.entries()) {
    contentSeen += 1;
    const pageOverviewCandidate = buildNotionPageOverviewCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      page,
      fetchedAt: params.fetchedAt,
    });
    if (pageOverviewCandidate) {
      const persisted = await persistIntegrationCandidate({
        store: params.store,
        workspaceId: "",
        candidate: pageOverviewCandidate,
        embeddingClient: null,
      });
      updatePersistStats(persisted, persistStats);
      contentPersisted += 1;
    }

    const pageId = normalizeString(page.id);
    if (pageId) {
      try {
        const markdownResult = await params.composio.executeAction({
          connectedAccountId,
          toolSlug: "NOTION_GET_PAGE_MARKDOWN",
          arguments: {
            page_id: pageId,
            include_transcript: false,
          },
        });
        actions.push(`NOTION_GET_PAGE_MARKDOWN:${pageId}`);
        const markdown = notionMarkdownFromData(markdownResult.data);
        if (markdown) {
          contentSeen += 1;
          const candidate = buildNotionPageMarkdownCandidate({
            ownerUserId: connection.ownerUserId,
            accountKey,
            accountLabel,
            page,
            markdown,
            fetchedAt: params.fetchedAt,
          });
          if (candidate) {
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
      } catch (error) {
        if (!isComposioNotFoundError(error)) {
          throw error;
        }
        actions.push(`NOTION_GET_PAGE_MARKDOWN:${pageId}:missing`);
      }
    }

    chunksCompleted += 2;
    syncProgress({
      current_chunk_label:
        index + 1 < pages.length
          ? `Importing Notion pages (${index + 1}/${pages.length})`
          : databaseSearchItems.length > 0
            ? `Importing Notion databases (0/${databaseSearchItems.length})`
            : "Rebuilding Notion context summary",
    });
  }

  for (const [index, databaseItem] of databaseSearchItems.entries()) {
    const databaseId = normalizeString(databaseItem.id);
    if (!databaseId) {
      chunksCompleted += 2;
      syncProgress({
        current_chunk_label:
          index + 1 < databaseSearchItems.length
            ? `Importing Notion databases (${index + 1}/${databaseSearchItems.length})`
            : "Rebuilding Notion context summary",
      });
      continue;
    }
    syncProgress({
      current_chunk_label: `Fetching Notion database ${databaseId}`,
    });
    const databaseResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "NOTION_FETCH_DATABASE",
      arguments: {
        database_id: databaseId,
      },
    });
    actions.push(`NOTION_FETCH_DATABASE:${databaseId}`);
    const database = notionDatabaseFromData(databaseResult.data) ?? databaseItem;
    const databaseTitle = notionDatabaseTitle(database) ?? `Notion database ${databaseId}`;
    contentSeen += 1;
    const databaseOverviewCandidate = buildNotionDatabaseOverviewCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      database,
      fetchedAt: params.fetchedAt,
    });
    if (databaseOverviewCandidate) {
      const persisted = await persistIntegrationCandidate({
        store: params.store,
        workspaceId: "",
        candidate: databaseOverviewCandidate,
        embeddingClient: null,
      });
      updatePersistStats(persisted, persistStats);
      contentPersisted += 1;
    }

    syncProgress({
      current_chunk_label: `Querying rows for ${databaseTitle}`,
    });
    const rowsResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "NOTION_QUERY_DATABASE",
      arguments: {
        database_id: databaseId,
        page_size: NOTION_DATABASE_ROW_LIMIT,
        sorts: [
          {
            property_name: "last_edited_time",
            ascending: false,
          },
        ],
      },
    });
    actions.push(`NOTION_QUERY_DATABASE:${databaseId}`);
    const rows = notionObjectsFromData(rowsResult.data).map((row) => ({
      ...row,
      parent: row.parent ?? { database_id: databaseId },
    }));
    contentSeen += rows.length;
    for (const row of rows) {
      const candidate = buildNotionRowCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        databaseId,
        databaseTitle,
        row,
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

    chunksCompleted += 2;
    syncProgress({
      current_chunk_label:
        index + 1 < databaseSearchItems.length
          ? `Importing Notion databases (${index + 1}/${databaseSearchItems.length})`
          : "Reconciling Notion entities",
    });
  }

  const retiredPages = retireIntegrationEntityLeaves({
    store: params.store,
    treeId,
    entityPrefix: "page:",
    keepEntityKeys: pageEntityKeys,
    supersededAt: params.fetchedAt,
  });
  const retiredDatabases = retireIntegrationEntityLeaves({
    store: params.store,
    treeId,
    entityPrefix: "database:",
    keepEntityKeys: databaseEntityKeys,
    supersededAt: params.fetchedAt,
  });
  if (retiredPages > 0) {
    actions.push(`NOTION_RETIRED_PAGE_LEAVES:${retiredPages}`);
  }
  if (retiredDatabases > 0) {
    actions.push(`NOTION_RETIRED_DATABASE_LEAVES:${retiredDatabases}`);
  }
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Rebuilding Notion context summary" });
  await rebuildIntegrationTree({
    store: params.store,
    workspaceId: "",
    treeId,
    summaryModelClient: null,
    embeddingClient: null,
  });
  chunksCompleted += 1;

  summaryNodes = params.store.listIntegrationSummaryNodes({
    treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  }).length;
  syncProgress({ current_chunk_label: "Notion context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "notion",
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
  progress?: IntegrationContextFetchProgressReporter | null;
}): Promise<IntegrationContextFetchResult> {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const connectedAccountId = connection.accountExternalId ?? "";
  const persistStats = { created: 0, superseding: 0, unchanged: 0 };
  const actions: string[] = [];
  let accountKey: string | null = null;
  let accountLabel: string | null = connection.accountLabel;
  let treeId: string | null = null;
  let contentSeen = 0;
  let contentPersisted = 0;
  let summaryNodes = 0;
  let chunksTotal = 4;
  let chunksCompleted = 0;
  const syncProgress = (patch: Partial<IntegrationContextFetchProgressSnapshot> = {}) => {
    params.progress?.patch({
      account_key: accountKey,
      account_label: accountLabel,
      tree_id: treeId,
      chunks_total: chunksTotal,
      chunks_completed: chunksCompleted,
      messages_seen: contentSeen,
      messages_persisted: contentPersisted,
      leaves_created: persistStats.created,
      leaves_superseding: persistStats.superseding,
      leaves_unchanged: persistStats.unchanged,
      summary_nodes: summaryNodes,
      actions,
      ...patch,
    });
  };

  syncProgress({ current_chunk_label: "Fetching Slack workspace profile" });
  const authResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "SLACK_TEST_AUTH",
    arguments: {},
  });
  actions.push("SLACK_TEST_AUTH");
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Saving Slack workspace profile" });
  const auth = slackAuthFromData(authResult.data);
  const teamId = normalizeString(auth?.team_id);
  const team = normalizeString(auth?.team);
  const workspaceUrl = normalizeString(auth?.url);
  accountKey = teamId
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
  accountLabel = team ?? workspaceUrl ?? teamId ?? accountKey;

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
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Fetching Slack channels" });

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
  chunksCompleted += 1;
  chunksTotal += channels.length;
  syncProgress({
    current_chunk_label:
      channels.length > 0
        ? `Importing Slack channels (0/${channels.length})`
        : "Rebuilding Slack context summary",
  });

  for (const [index, channel] of channels.entries()) {
    contentSeen += 1;
    const candidate = buildSlackChannelCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      channel,
      fetchedAt: params.fetchedAt,
    });
    if (!candidate) {
      chunksCompleted += 1;
      syncProgress({
        current_chunk_label:
          index + 1 < channels.length
            ? `Importing Slack channels (${index + 1}/${channels.length})`
            : "Fetching Slack channel history",
      });
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
    chunksCompleted += 1;
    syncProgress({
      current_chunk_label:
        index + 1 < channels.length
          ? `Importing Slack channels (${index + 1}/${channels.length})`
          : "Fetching Slack channel history",
    });
  }

  const historyChannels = channels
    .map((channel) => ({
      id: normalizeString(channel.id),
      name: normalizeString(channel.name),
    }))
    .filter((channel): channel is { id: string; name: string } => Boolean(channel.id && channel.name))
    .slice(0, SLACK_CHANNEL_HISTORY_TARGETS);
  chunksTotal += historyChannels.length;
  syncProgress({
    current_chunk_label:
      historyChannels.length > 0
        ? `Fetching Slack channel history (0/${historyChannels.length})`
        : "Rebuilding Slack context summary",
  });

  for (const [index, channel] of historyChannels.entries()) {
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
    chunksCompleted += 1;
    const messages = slackMessagesFromData(historyResult.data);
    syncProgress({
      current_chunk_label:
        index + 1 < historyChannels.length
          ? `Fetching Slack channel history (${index + 1}/${historyChannels.length})`
          : messages.length > 0
            ? `Importing Slack messages for #${channel.name}`
            : "Rebuilding Slack context summary",
    });
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

  syncProgress({ current_chunk_label: "Rebuilding Slack context summary" });
  await rebuildIntegrationTree({
    store: params.store,
    workspaceId: "",
    treeId,
    summaryModelClient: null,
    embeddingClient: null,
  });
  chunksCompleted += 1;

  summaryNodes = params.store.listIntegrationSummaryNodes({
    treeId,
    status: "active",
    limit: 10_000,
    offset: 0,
  }).length;
  syncProgress({ current_chunk_label: "Slack context fetch complete" });

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
  onProgress?: ((snapshot: IntegrationContextFetchProgressSnapshot) => void) | null;
}): Promise<IntegrationContextFetchResult> {
  const connection = params.store.getIntegrationConnection(params.connectionId);
  if (!connection) {
    throw new Error(`integration connection ${params.connectionId} not found`);
  }
  const providerId = connection.providerId.trim().toLowerCase();
  const progress = createIntegrationContextFetchProgressReporter({
    providerId,
    connectionId: connection.connectionId,
    accountLabel: connection.accountLabel,
    onProgress: params.onProgress ?? null,
  });
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
      progress,
    });
  }
  if (providerId === "github") {
    return fetchGitHubIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  if (providerId === "notion") {
    return fetchNotionIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  return fetchSlackIntegrationContext({
    store: params.store,
    connectionId: connection.connectionId,
    composio,
    fetchedAt,
    progress,
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
