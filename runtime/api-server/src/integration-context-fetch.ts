import { type RuntimeStateStore, utcNowIso } from "@holaboss/runtime-state-store";

import {
  ComposioApiClient,
  ComposioApiClientError,
  createComposioApiClientFromEnv,
} from "./composio-api-client.js";
import {
  countSummaryLikeSemanticIntegrationNodes,
  persistIntegrationCandidate,
  queueIntegrationTreeRebuild,
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
const SLACK_USER_LIMIT = 50;
const SLACK_THREAD_TARGETS = 4;
const GOOGLE_CALENDAR_LIMIT = 6;
const GOOGLE_CALENDAR_EVENT_LIMIT = 8;
const GOOGLE_CALENDAR_SETTINGS_LIMIT = 20;
const GOOGLE_CALENDAR_RESOURCE_LIMIT = 12;
const GOOGLE_CALENDAR_BUILDING_LIMIT = 12;
const GOOGLE_DRIVE_SHARED_DRIVE_LIMIT = 10;
const GOOGLE_DRIVE_PERMISSION_TARGETS = 6;
const TWITTER_MENTION_LIMIT = 12;
const TWITTER_DM_EVENT_LIMIT = 12;
const OUTLOOK_MESSAGE_LIMIT = 20;
const OUTLOOK_CONTACT_LIMIT = 20;
const OUTLOOK_EVENT_LIMIT = 12;
const GOOGLE_SHEETS_SPREADSHEET_LIMIT = 10;
const GOOGLE_SHEETS_VALUE_TARGETS = 6;
const GOOGLE_DOCS_DOCUMENT_LIMIT = 10;
const HUBSPOT_CONTACT_LIMIT = 15;
const HUBSPOT_COMPANY_LIMIT = 15;
const HUBSPOT_DEAL_LIMIT = 15;
const LINEAR_ISSUE_LIMIT = 20;
const LINEAR_PROJECT_LIMIT = 10;
const LINEAR_TEAM_LIMIT = 10;
const JIRA_PROJECT_LIMIT = 12;
const JIRA_ISSUE_LIMIT = 20;

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

interface GoogleDriveAboutPayload {
  user?: unknown;
  storageQuota?: unknown;
}

interface GoogleDriveFilePayload {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  modifiedTime?: unknown;
  createdTime?: unknown;
  webViewLink?: unknown;
  iconLink?: unknown;
  owners?: unknown;
  parents?: unknown;
  shared?: unknown;
  starred?: unknown;
  trashed?: unknown;
  size?: unknown;
  description?: unknown;
}

interface GoogleDrivePermissionPayload {
  id?: unknown;
  role?: unknown;
  type?: unknown;
  emailAddress?: unknown;
  domain?: unknown;
  displayName?: unknown;
  deleted?: unknown;
  allowFileDiscovery?: unknown;
}

interface GoogleDriveSharedDrivePayload {
  id?: unknown;
  name?: unknown;
  createdTime?: unknown;
  hidden?: unknown;
  restrictions?: unknown;
}

interface TwitterUserPayload {
  id?: unknown;
  name?: unknown;
  username?: unknown;
  description?: unknown;
  created_at?: unknown;
  verified?: unknown;
  profile_image_url?: unknown;
  url?: unknown;
  location?: unknown;
  public_metrics?: unknown;
}

interface TwitterPostPayload {
  id?: unknown;
  text?: unknown;
  created_at?: unknown;
  author_id?: unknown;
  conversation_id?: unknown;
  lang?: unknown;
  public_metrics?: unknown;
  referenced_tweets?: unknown;
  entities?: unknown;
}

interface TwitterDmEventPayload {
  dm_conversation_id?: unknown;
  event_type?: unknown;
  id?: unknown;
  text?: unknown;
  created_at?: unknown;
  sender_id?: unknown;
  message_create?: unknown;
}

interface GoogleCalendarListEntryPayload {
  id?: unknown;
  summary?: unknown;
  description?: unknown;
  primary?: unknown;
  accessRole?: unknown;
  timeZone?: unknown;
}

interface GoogleCalendarEventPayload {
  id?: unknown;
  summary?: unknown;
  description?: unknown;
  status?: unknown;
  htmlLink?: unknown;
  start?: unknown;
  end?: unknown;
  organizer?: unknown;
  location?: unknown;
}

interface GoogleCalendarSettingPayload {
  id?: unknown;
  etag?: unknown;
  value?: unknown;
}

interface GoogleCalendarResourcePayload {
  resourceId?: unknown;
  resourceEmail?: unknown;
  resourceName?: unknown;
  resourceType?: unknown;
  resourceCategory?: unknown;
  generatedResourceName?: unknown;
  buildingId?: unknown;
  floorName?: unknown;
  floorSection?: unknown;
  capacity?: unknown;
}

interface GoogleCalendarBuildingPayload {
  buildingId?: unknown;
  buildingName?: unknown;
  description?: unknown;
  floors?: unknown;
  kind?: unknown;
}

interface LinkedInUserInfoPayload {
  id?: unknown;
  author?: unknown;
  sub?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  localizedFirstName?: unknown;
  localizedLastName?: unknown;
  picture?: unknown;
  email?: unknown;
  email_verified?: unknown;
  locale?: unknown;
}

interface LinkedInPersonPayload {
  id?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  localizedFirstName?: unknown;
  localizedLastName?: unknown;
  headline?: unknown;
  vanityName?: unknown;
  profilePicture?: unknown;
}

interface LinkedInCompanyPayload {
  id?: unknown;
  organization_id?: unknown;
  organization?: unknown;
  name?: unknown;
  vanityName?: unknown;
  description?: unknown;
  website?: unknown;
  industries?: unknown;
  staffCount?: unknown;
  followerCount?: unknown;
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

interface SlackUserPayload {
  id?: unknown;
  name?: unknown;
  deleted?: unknown;
  is_bot?: unknown;
  is_admin?: unknown;
  tz?: unknown;
  profile?: unknown;
  real_name?: unknown;
}

interface OutlookProfilePayload {
  id?: unknown;
  displayName?: unknown;
  givenName?: unknown;
  surname?: unknown;
  mail?: unknown;
  userPrincipalName?: unknown;
  jobTitle?: unknown;
}

interface OutlookMessagePayload {
  id?: unknown;
  subject?: unknown;
  bodyPreview?: unknown;
  conversationId?: unknown;
  receivedDateTime?: unknown;
  sentDateTime?: unknown;
  from?: unknown;
  categories?: unknown;
  hasAttachments?: unknown;
  webLink?: unknown;
}

interface OutlookContactPayload {
  id?: unknown;
  displayName?: unknown;
  givenName?: unknown;
  surname?: unknown;
  companyName?: unknown;
  jobTitle?: unknown;
  emailAddresses?: unknown;
}

interface OutlookEventPayload {
  id?: unknown;
  subject?: unknown;
  bodyPreview?: unknown;
  start?: unknown;
  end?: unknown;
  location?: unknown;
  organizer?: unknown;
  webLink?: unknown;
  isCancelled?: unknown;
}

interface GoogleSheetsSpreadsheetPayload {
  spreadsheetId?: unknown;
  id?: unknown;
  name?: unknown;
  title?: unknown;
  modifiedTime?: unknown;
  url?: unknown;
  webViewLink?: unknown;
}

interface GoogleSheetsInfoPayload {
  spreadsheetId?: unknown;
  properties?: unknown;
  sheets?: unknown;
  spreadsheetUrl?: unknown;
}

interface GoogleDocsSearchPayload {
  documentId?: unknown;
  id?: unknown;
  title?: unknown;
  name?: unknown;
  modifiedTime?: unknown;
  webViewLink?: unknown;
}

interface GoogleDocsDocumentPayload {
  documentId?: unknown;
  title?: unknown;
  revisionId?: unknown;
}

interface HubSpotContactPayload {
  id?: unknown;
  properties?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  archived?: unknown;
}

interface HubSpotCompanyPayload {
  id?: unknown;
  properties?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  archived?: unknown;
}

interface HubSpotDealPayload {
  id?: unknown;
  properties?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  archived?: unknown;
}

interface LinearUserPayload {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  email?: unknown;
  active?: unknown;
}

interface LinearIssuePayload {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  state?: unknown;
  priority?: unknown;
  team?: unknown;
}

interface LinearProjectPayload {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  url?: unknown;
  updatedAt?: unknown;
  createdAt?: unknown;
  state?: unknown;
}

interface LinearTeamPayload {
  id?: unknown;
  key?: unknown;
  name?: unknown;
  description?: unknown;
}

interface JiraCurrentUserPayload {
  accountId?: unknown;
  displayName?: unknown;
  emailAddress?: unknown;
  active?: unknown;
  timeZone?: unknown;
}

interface JiraProjectPayload {
  id?: unknown;
  key?: unknown;
  name?: unknown;
  projectTypeKey?: unknown;
  simplified?: unknown;
}

interface JiraIssuePayload {
  id?: unknown;
  key?: unknown;
  fields?: unknown;
  self?: unknown;
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

function googleDriveAboutFromData(value: unknown): GoogleDriveAboutPayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as GoogleDriveAboutPayload) : null;
}

function googleDriveFilesFromData(value: unknown): GoogleDriveFilePayload[] {
  return recordsFromData(value, ["files", "items"]) as GoogleDriveFilePayload[];
}

function googleDrivePermissionsFromData(value: unknown): GoogleDrivePermissionPayload[] {
  return recordsFromData(value, ["permissions"]) as GoogleDrivePermissionPayload[];
}

function googleDriveSharedDrivesFromData(value: unknown): GoogleDriveSharedDrivePayload[] {
  return recordsFromData(value, ["drives", "items"]) as GoogleDriveSharedDrivePayload[];
}

function twitterUserFromData(value: unknown): TwitterUserPayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as TwitterUserPayload) : null;
}

function twitterPostsFromData(value: unknown): TwitterPostPayload[] {
  return recordsFromData(value, ["data", "tweets", "posts"]) as TwitterPostPayload[];
}

function twitterDmEventsFromData(value: unknown): TwitterDmEventPayload[] {
  return recordsFromData(value, ["data", "events", "dm_events"]) as TwitterDmEventPayload[];
}

function googleCalendarListEntriesFromData(value: unknown): GoogleCalendarListEntryPayload[] {
  return recordsFromData(value, ["items", "calendars"]) as GoogleCalendarListEntryPayload[];
}

function googleCalendarEventsFromData(value: unknown): GoogleCalendarEventPayload[] {
  return recordsFromData(value, ["items", "events"]) as GoogleCalendarEventPayload[];
}

function googleCalendarSettingsFromData(value: unknown): GoogleCalendarSettingPayload[] {
  return recordsFromData(value, ["items", "settings"]) as GoogleCalendarSettingPayload[];
}

function googleCalendarResourcesFromData(value: unknown): GoogleCalendarResourcePayload[] {
  return recordsFromData(value, ["items", "resources"]) as GoogleCalendarResourcePayload[];
}

function googleCalendarBuildingsFromData(value: unknown): GoogleCalendarBuildingPayload[] {
  return recordsFromData(value, ["items", "buildings"]) as GoogleCalendarBuildingPayload[];
}

function linkedInUserInfoFromData(value: unknown): LinkedInUserInfoPayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as LinkedInUserInfoPayload) : null;
}

function linkedInPersonFromData(value: unknown): LinkedInPersonPayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as LinkedInPersonPayload) : null;
}

function linkedInCompaniesFromData(value: unknown): LinkedInCompanyPayload[] {
  const records = recordsFromData(value, ["elements", "organizations", "companies"]) as LinkedInCompanyPayload[];
  if (records.length > 0) {
    return records;
  }
  const single = recordFromData(value);
  return single ? [single as LinkedInCompanyPayload] : [];
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

function slackUsersFromData(value: unknown): SlackUserPayload[] {
  return recordsFromData(value, ["members", "users"]) as SlackUserPayload[];
}

function outlookProfileFromData(value: unknown): OutlookProfilePayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as OutlookProfilePayload) : null;
}

function outlookMessagesFromData(value: unknown): OutlookMessagePayload[] {
  return recordsFromData(value, ["value", "messages"]) as OutlookMessagePayload[];
}

function outlookContactsFromData(value: unknown): OutlookContactPayload[] {
  return recordsFromData(value, ["value", "contacts"]) as OutlookContactPayload[];
}

function outlookEventsFromData(value: unknown): OutlookEventPayload[] {
  return recordsFromData(value, ["value", "events"]) as OutlookEventPayload[];
}

function googleSheetsSpreadsheetsFromData(value: unknown): GoogleSheetsSpreadsheetPayload[] {
  return recordsFromData(value, ["spreadsheets", "files", "items", "results"]) as GoogleSheetsSpreadsheetPayload[];
}

function googleSheetsInfoFromData(value: unknown): GoogleSheetsInfoPayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as GoogleSheetsInfoPayload) : null;
}

function googleSheetNamesFromData(value: unknown): string[] {
  const unwrapped = unwrapActionData(value);
  if (Array.isArray(unwrapped)) {
    return stringList(unwrapped);
  }
  if (!isRecord(unwrapped)) {
    return [];
  }
  const rawSheets = Array.isArray(unwrapped.sheetNames)
    ? unwrapped.sheetNames
    : Array.isArray(unwrapped.sheets)
      ? unwrapped.sheets
      : [];
  const names = rawSheets
    .map((item) => {
      if (!isRecord(item)) {
        return normalizeString(item);
      }
      const properties = isRecord(item.properties) ? item.properties : null;
      return normalizeString(item.title)
        ?? normalizeString(properties?.title);
    })
    .filter((item): item is string => Boolean(item));
  return [...new Set(names)];
}

function googleSheetValuesFromData(value: unknown): string[][] {
  const unwrapped = unwrapActionData(value);
  if (!isRecord(unwrapped) || !Array.isArray(unwrapped.values)) {
    return [];
  }
  return unwrapped.values
    .filter(Array.isArray)
    .map((row) => row.map((cell) => normalizeString(cell) ?? String(cell ?? "")));
}

function googleDocsSearchFromData(value: unknown): GoogleDocsSearchPayload[] {
  return recordsFromData(value, ["documents", "items", "results"]) as GoogleDocsSearchPayload[];
}

function googleDocsDocumentFromData(value: unknown): GoogleDocsDocumentPayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as GoogleDocsDocumentPayload) : null;
}

function googleDocsPlainTextFromData(value: unknown): string | null {
  const unwrapped = unwrapActionData(value);
  if (typeof unwrapped === "string") {
    return compactWhitespace(unwrapped);
  }
  if (!isRecord(unwrapped)) {
    return null;
  }
  return normalizeString(unwrapped.text)
    ?? normalizeString(unwrapped.content)
    ?? normalizeString(unwrapped.plainText)
    ?? null;
}

function hubSpotContactsFromData(value: unknown): HubSpotContactPayload[] {
  return recordsFromData(value, ["results", "contacts", "items"]) as HubSpotContactPayload[];
}

function hubSpotCompaniesFromData(value: unknown): HubSpotCompanyPayload[] {
  return recordsFromData(value, ["results", "companies", "items"]) as HubSpotCompanyPayload[];
}

function hubSpotDealsFromData(value: unknown): HubSpotDealPayload[] {
  return recordsFromData(value, ["results", "deals", "items"]) as HubSpotDealPayload[];
}

function linearCurrentUserFromData(value: unknown): LinearUserPayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as LinearUserPayload) : null;
}

function linearIssuesFromData(value: unknown): LinearIssuePayload[] {
  return recordsFromData(value, ["issues", "nodes", "results"]) as LinearIssuePayload[];
}

function linearProjectsFromData(value: unknown): LinearProjectPayload[] {
  return recordsFromData(value, ["projects", "nodes", "results"]) as LinearProjectPayload[];
}

function linearTeamsFromData(value: unknown): LinearTeamPayload[] {
  return recordsFromData(value, ["teams", "nodes", "results"]) as LinearTeamPayload[];
}

function jiraCurrentUserFromData(value: unknown): JiraCurrentUserPayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as JiraCurrentUserPayload) : null;
}

function jiraProjectsFromData(value: unknown): JiraProjectPayload[] {
  return recordsFromData(value, ["values", "projects", "items"]) as JiraProjectPayload[];
}

function jiraIssuesFromData(value: unknown): JiraIssuePayload[] {
  return recordsFromData(value, ["issues", "results", "items"]) as JiraIssuePayload[];
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

function isGoogleDriveFolderMimeType(mimeType: string | null): boolean {
  return mimeType === "application/vnd.google-apps.folder";
}

function buildGoogleDriveProfileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  connectionId: string;
  about: GoogleDriveAboutPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const user = isRecord(params.about.user) ? params.about.user : null;
  const storageQuota = isRecord(params.about.storageQuota) ? params.about.storageQuota : null;
  const displayName = normalizeString(user?.displayName) ?? normalizeString(user?.name);
  const email = normalizeString(user?.emailAddress) ?? normalizeString(user?.email);
  const permissionId = normalizeString(user?.permissionId);
  const usage = normalizeString(storageQuota?.usage);
  const usageInDrive = normalizeString(storageQuota?.usageInDrive);
  const usageInDriveTrash = normalizeString(storageQuota?.usageInDriveTrash);
  const limit = normalizeString(storageQuota?.limit);
  const lines = [
    "# Google Drive profile",
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Google Drive",
    `- Connection ID: ${params.connectionId}`,
    displayName ? `- User: ${displayName}` : null,
    email ? `- Email: ${email}` : null,
    permissionId ? `- Permission ID: ${permissionId}` : null,
    limit ? `- Storage limit: ${limit}` : null,
    usage ? `- Storage used: ${usage}` : null,
    usageInDrive ? `- Storage used in Drive: ${usageInDrive}` : null,
    usageInDriveTrash ? `- Storage used in trash: ${usageInDriveTrash}` : null,
    "",
    "## Summary",
    "",
    `${params.accountLabel} Google Drive profile snapshot.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "googledrive",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    branchKey: "profile",
    branchLabel: "Profile",
    title: `Google Drive profile for ${params.accountLabel}`,
    summary: clipText(
      `${params.accountLabel} Google Drive profile snapshot${displayName ? ` for ${displayName}` : ""}.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["googledrive", "profile"],
    sourceType: "googledrive.profile",
    sourceEventId: `googledrive-profile:${params.accountKey}`,
    externalObjectId: params.accountKey,
    externalObjectType: "google_drive_profile",
    observedAt: params.fetchedAt,
    confidence: 0.95,
  };
}

function buildGoogleDriveFileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  file: GoogleDriveFilePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const fileId = normalizeString(params.file.id);
  const name = normalizeString(params.file.name);
  if (!fileId || !name) {
    return null;
  }
  const mimeType = normalizeString(params.file.mimeType);
  const modifiedAt = timestampToIso(params.file.modifiedTime)
    ?? timestampToIso(params.file.createdTime)
    ?? params.fetchedAt;
  const webViewLink = normalizeString(params.file.webViewLink);
  const size = normalizeString(params.file.size);
  const description = normalizeString(params.file.description);
  const ownerLabels = Array.isArray(params.file.owners)
    ? params.file.owners
      .filter(isRecord)
      .map((owner) => normalizeString(owner.displayName) ?? normalizeString(owner.emailAddress))
      .filter((owner): owner is string => Boolean(owner))
    : [];
  const isFolder = isGoogleDriveFolderMimeType(mimeType);
  const kindLabel = isFolder ? "Folder" : "File";
  const lines = [
    `# ${name}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Google Drive",
    `- Type: ${kindLabel}`,
    `- File ID: ${fileId}`,
    mimeType ? `- MIME type: ${mimeType}` : null,
    size ? `- Size: ${size}` : null,
    ownerLabels.length > 0 ? `- Owners: ${ownerLabels.join(", ")}` : null,
    modifiedAt ? `- Modified at: ${modifiedAt}` : null,
    webViewLink ? `- URL: ${webViewLink}` : null,
    "",
    "## Summary",
    "",
    description ?? `${kindLabel} in Google Drive.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "googledrive",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `file:${fileId}`,
    entityKey: `file:${fileId}`,
    entityLabel: name,
    branchKey: "overview",
    branchLabel: "Overview",
    title: name,
    summary: clipText(
      `${kindLabel} in Google Drive: ${name}${mimeType ? ` (${mimeType})` : ""}.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "googledrive",
      isFolder ? "folder" : "file",
      ...(mimeType ? [safeTag(`mime:${mimeType}`)] : []),
    ].filter((item): item is string => Boolean(item)),
    sourceType: isFolder ? "googledrive.folder" : "googledrive.file",
    sourceEventId: `googledrive-file:${fileId}`,
    externalObjectId: fileId,
    externalObjectType: isFolder ? "google_drive_folder" : "google_drive_file",
    observedAt: modifiedAt,
    confidence: 0.84,
  };
}

function buildGoogleDrivePermissionCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  fileId: string;
  fileTitle: string;
  permission: GoogleDrivePermissionPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const permissionId = normalizeString(params.permission.id);
  if (!permissionId) {
    return null;
  }
  const role = normalizeString(params.permission.role);
  const type = normalizeString(params.permission.type);
  const emailAddress = normalizeString(params.permission.emailAddress);
  const domain = normalizeString(params.permission.domain);
  const displayName = normalizeString(params.permission.displayName);
  const deleted = normalizeBoolean(params.permission.deleted);
  const allowFileDiscovery = normalizeBoolean(params.permission.allowFileDiscovery);
  const label = displayName ?? emailAddress ?? domain ?? permissionId;
  const lines = [
    `# Permission ${label}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Google Drive",
    `- File: ${params.fileTitle}`,
    `- File ID: ${params.fileId}`,
    `- Permission ID: ${permissionId}`,
    role ? `- Role: ${role}` : null,
    type ? `- Type: ${type}` : null,
    emailAddress ? `- Email: ${emailAddress}` : null,
    domain ? `- Domain: ${domain}` : null,
    deleted !== null ? `- Deleted: ${deleted ? "yes" : "no"}` : null,
    allowFileDiscovery !== null ? `- Discoverable: ${allowFileDiscovery ? "yes" : "no"}` : null,
    "",
    "## Summary",
    "",
    `${label} has ${role ?? "assigned"} access on ${params.fileTitle}.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "googledrive",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `permission:${params.fileId}:${permissionId}`,
    entityKey: `file:${params.fileId}`,
    entityLabel: params.fileTitle,
    branchKey: "permissions",
    branchLabel: "Permissions",
    title: label,
    summary: clipText(`${label} has ${role ?? "assigned"} access on ${params.fileTitle}.`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "googledrive",
      "permission",
      ...(role ? [safeTag(`role:${role}`)] : []),
      ...(type ? [safeTag(`type:${type}`)] : []),
    ].filter((item): item is string => Boolean(item)),
    sourceType: "googledrive.permission",
    sourceEventId: `googledrive-permission:${params.fileId}:${permissionId}`,
    externalObjectId: permissionId,
    externalObjectType: "google_drive_permission",
    observedAt: params.fetchedAt,
    confidence: 0.78,
  };
}

function buildGoogleDriveSharedDriveCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  sharedDrive: GoogleDriveSharedDrivePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const sharedDriveId = normalizeString(params.sharedDrive.id);
  const name = normalizeString(params.sharedDrive.name);
  if (!sharedDriveId || !name) {
    return null;
  }
  const createdAt = timestampToIso(params.sharedDrive.createdTime) ?? params.fetchedAt;
  const hidden = normalizeBoolean(params.sharedDrive.hidden);
  const lines = [
    `# ${name}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Google Drive",
    `- Shared drive ID: ${sharedDriveId}`,
    hidden !== null ? `- Hidden: ${hidden ? "yes" : "no"}` : null,
    createdAt ? `- Created at: ${createdAt}` : null,
    "",
    "## Summary",
    "",
    `${name} shared drive available in Google Drive.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "googledrive",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `shared-drive:${sharedDriveId}`,
    branchKey: "shared-drives",
    branchLabel: "Shared Drives",
    title: name,
    summary: clipText(`${name} shared drive available in Google Drive.`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["googledrive", "shared-drive"],
    sourceType: "googledrive.shared-drive",
    sourceEventId: `googledrive-shared-drive:${sharedDriveId}`,
    externalObjectId: sharedDriveId,
    externalObjectType: "google_drive_shared_drive",
    observedAt: createdAt,
    confidence: 0.8,
  };
}

function buildTwitterProfileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  connectionId: string;
  user: TwitterUserPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const userId = normalizeString(params.user.id);
  const name = normalizeString(params.user.name);
  const username = normalizeString(params.user.username);
  const description = normalizeString(params.user.description);
  const createdAt = timestampToIso(params.user.created_at);
  const verified = normalizeBoolean(params.user.verified);
  const profileImageUrl = normalizeString(params.user.profile_image_url);
  const url = normalizeString(params.user.url);
  const location = normalizeString(params.user.location);
  const publicMetrics = isRecord(params.user.public_metrics) ? params.user.public_metrics : null;
  const followersCount = parseInteger(publicMetrics?.followers_count);
  const followingCount = parseInteger(publicMetrics?.following_count);
  const tweetCount = parseInteger(publicMetrics?.tweet_count);
  const lines = [
    "# Twitter profile",
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Twitter / X",
    `- Connection ID: ${params.connectionId}`,
    name ? `- Name: ${name}` : null,
    username ? `- Username: @${username}` : null,
    userId ? `- User ID: ${userId}` : null,
    verified !== null ? `- Verified: ${verified ? "yes" : "no"}` : null,
    location ? `- Location: ${location}` : null,
    url ? `- URL: ${url}` : null,
    profileImageUrl ? `- Profile image: ${profileImageUrl}` : null,
    followersCount !== null ? `- Followers: ${followersCount}` : null,
    followingCount !== null ? `- Following: ${followingCount}` : null,
    tweetCount !== null ? `- Posts: ${tweetCount}` : null,
    createdAt ? `- Created at: ${createdAt}` : null,
    "",
    "## Summary",
    "",
    description ?? `${params.accountLabel} Twitter profile snapshot.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "twitter",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    branchKey: "profile",
    branchLabel: "Profile",
    title: `Twitter profile for ${params.accountLabel}`,
    summary: clipText(
      `${params.accountLabel} Twitter profile snapshot${description ? `: ${description}` : ""}`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["twitter", "profile"],
    sourceType: "twitter.profile",
    sourceEventId: `twitter-profile:${params.accountKey}`,
    externalObjectId: userId ?? params.accountKey,
    externalObjectType: "twitter_profile",
    observedAt: params.fetchedAt,
    confidence: 0.95,
  };
}

function buildTwitterPostCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  authorUsername: string | null;
  post: TwitterPostPayload;
  fetchedAt: string;
  branchKey?: string;
  branchLabel?: string;
  sourceType?: string;
  sourcePrefix?: string;
  subjectPrefix?: string;
  extraTags?: string[];
}): IntegrationLeafCandidate | null {
  const postId = normalizeString(params.post.id);
  const text = normalizeString(params.post.text);
  if (!postId || !text) {
    return null;
  }
  const createdAt = timestampToIso(params.post.created_at) ?? params.fetchedAt;
  const authorId = normalizeString(params.post.author_id);
  const conversationId = normalizeString(params.post.conversation_id);
  const lang = normalizeString(params.post.lang);
  const publicMetrics = isRecord(params.post.public_metrics) ? params.post.public_metrics : null;
  const likeCount = parseInteger(publicMetrics?.like_count);
  const replyCount = parseInteger(publicMetrics?.reply_count);
  const repostCount = parseInteger(publicMetrics?.retweet_count);
  const quoteCount = parseInteger(publicMetrics?.quote_count);
  const bookmarkCount = parseInteger(publicMetrics?.bookmark_count);
  const impressionCount = parseInteger(publicMetrics?.impression_count);
  const referencedTypes = Array.isArray(params.post.referenced_tweets)
    ? params.post.referenced_tweets
      .filter(isRecord)
      .map((item) => normalizeString(item.type))
      .filter((item): item is string => Boolean(item))
    : [];
  const lines = [
    `# ${clipText(text, 120)}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Twitter / X",
    `- Post ID: ${postId}`,
    params.authorUsername ? `- Author: @${params.authorUsername}` : null,
    authorId ? `- Author ID: ${authorId}` : null,
    conversationId ? `- Conversation ID: ${conversationId}` : null,
    lang ? `- Language: ${lang}` : null,
    referencedTypes.length > 0 ? `- References: ${referencedTypes.join(", ")}` : null,
    likeCount !== null ? `- Likes: ${likeCount}` : null,
    replyCount !== null ? `- Replies: ${replyCount}` : null,
    repostCount !== null ? `- Reposts: ${repostCount}` : null,
    quoteCount !== null ? `- Quotes: ${quoteCount}` : null,
    bookmarkCount !== null ? `- Bookmarks: ${bookmarkCount}` : null,
    impressionCount !== null ? `- Impressions: ${impressionCount}` : null,
    createdAt ? `- Created at: ${createdAt}` : null,
    "",
    "## Summary",
    "",
    text,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "twitter",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `${params.subjectPrefix ?? "post"}:${postId}`,
    entityKey: `post:${postId}`,
    entityLabel: clipText(text, 72),
    branchKey: params.branchKey ?? "overview",
    branchLabel: params.branchLabel ?? "Overview",
    title: clipText(text, 72),
    summary: clipText(
      `${params.authorUsername ? `@${params.authorUsername}: ` : ""}${text}`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "twitter",
      "post",
      ...(params.authorUsername ? [safeTag(`author:${params.authorUsername}`)] : []),
      ...referencedTypes.map((value) => safeTag(`reference:${value}`)),
      ...(params.extraTags ?? []),
    ].filter((item): item is string => Boolean(item)),
    sourceType: params.sourceType ?? "twitter.post",
    sourceEventId: `${params.sourcePrefix ?? "twitter-post"}:${postId}`,
    externalObjectId: postId,
    externalObjectType: "twitter_post",
    observedAt: createdAt,
    confidence: 0.82,
  };
}

function buildTwitterDirectMessageCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  event: TwitterDmEventPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const eventId = normalizeString(params.event.id);
  if (!eventId) {
    return null;
  }
  const messageCreate = isRecord(params.event.message_create) ? params.event.message_create : null;
  const text = normalizeString(params.event.text)
    ?? normalizeString(messageCreate?.text)
    ?? normalizeString(isRecord(messageCreate?.message_data) ? messageCreate?.message_data.text : null);
  if (!text) {
    return null;
  }
  const conversationId = normalizeString(params.event.dm_conversation_id)
    ?? normalizeString(messageCreate?.dm_conversation_id);
  const eventType = normalizeString(params.event.event_type) ?? "MessageCreate";
  const senderId = normalizeString(params.event.sender_id)
    ?? normalizeString(messageCreate?.sender_id);
  const createdAt = timestampToIso(params.event.created_at)
    ?? timestampToIso(messageCreate?.created_at)
    ?? params.fetchedAt;
  const lines = [
    `# Direct message ${eventId}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Twitter / X",
    `- Event ID: ${eventId}`,
    conversationId ? `- Conversation ID: ${conversationId}` : null,
    senderId ? `- Sender ID: ${senderId}` : null,
    eventType ? `- Event type: ${eventType}` : null,
    createdAt ? `- Created at: ${createdAt}` : null,
    "",
    "## Summary",
    "",
    clipText(text, 900),
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "twitter",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `dm:${eventId}`,
    branchKey: "direct-messages",
    branchLabel: "Direct Messages",
    title: clipText(text, 72),
    summary: clipText(`DM${senderId ? ` from ${senderId}` : ""}: ${text}`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["twitter", "direct-message", safeTag(`event:${eventType}`)].filter(
      (item): item is string => Boolean(item),
    ),
    sourceType: "twitter.direct-message",
    sourceEventId: `twitter-dm:${eventId}`,
    externalObjectId: eventId,
    externalObjectType: "twitter_dm_event",
    observedAt: createdAt,
    confidence: 0.79,
  };
}

function googleCalendarEventDateValue(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return timestampToIso(value.dateTime) ?? normalizeString(value.date);
}

function googleCalendarEventWindowText(
  start: unknown,
  end: unknown,
): string | null {
  const startValue = googleCalendarEventDateValue(start);
  const endValue = googleCalendarEventDateValue(end);
  if (startValue && endValue) {
    return `${startValue} -> ${endValue}`;
  }
  return startValue ?? endValue;
}

function buildGoogleCalendarProfileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  connectionId: string;
  primaryCalendar: GoogleCalendarListEntryPayload | null;
  calendarCount: number;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const primaryId = normalizeString(params.primaryCalendar?.id);
  const primarySummary = normalizeString(params.primaryCalendar?.summary);
  const primaryTimezone = normalizeString(params.primaryCalendar?.timeZone);
  const lines = [
    "# Google Calendar profile",
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Google Calendar",
    `- Connection ID: ${params.connectionId}`,
    primaryId ? `- Primary calendar ID: ${primaryId}` : null,
    primarySummary ? `- Primary calendar: ${primarySummary}` : null,
    primaryTimezone ? `- Primary timezone: ${primaryTimezone}` : null,
    `- Calendars fetched: ${params.calendarCount}`,
    "",
    "## Summary",
    "",
    `${params.accountLabel} Google Calendar snapshot across ${params.calendarCount} calendar${params.calendarCount === 1 ? "" : "s"}.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "googlecalendar",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    branchKey: "profile",
    branchLabel: "Profile",
    title: `Google Calendar profile for ${params.accountLabel}`,
    summary: clipText(
      `${params.accountLabel} Google Calendar snapshot across ${params.calendarCount} calendar${params.calendarCount === 1 ? "" : "s"}.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["googlecalendar", "profile"],
    sourceType: "googlecalendar.profile",
    sourceEventId: `googlecalendar-profile:${params.accountKey}`,
    externalObjectId: primaryId ?? params.accountKey,
    externalObjectType: "google_calendar_profile",
    observedAt: params.fetchedAt,
    confidence: 0.95,
  };
}

function buildGoogleCalendarCalendarCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  calendar: GoogleCalendarListEntryPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const calendarId = normalizeString(params.calendar.id);
  const summary = normalizeString(params.calendar.summary);
  if (!calendarId) {
    return null;
  }
  const title = summary ?? calendarId;
  const description = normalizeString(params.calendar.description);
  const accessRole = normalizeString(params.calendar.accessRole);
  const primary = normalizeBoolean(params.calendar.primary);
  const timeZone = normalizeString(params.calendar.timeZone);
  const lines = [
    `# ${title}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Google Calendar",
    `- Calendar ID: ${calendarId}`,
    primary !== null ? `- Primary: ${primary ? "yes" : "no"}` : null,
    accessRole ? `- Access role: ${accessRole}` : null,
    timeZone ? `- Time zone: ${timeZone}` : null,
    "",
    "## Summary",
    "",
    description ?? `${title} calendar available through Google Calendar.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "googlecalendar",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `calendar:${calendarId}`,
    entityKey: `calendar:${calendarId}`,
    entityLabel: title,
    branchKey: "overview",
    branchLabel: "Overview",
    title,
    summary: clipText(
      `${title} calendar${accessRole ? ` (${accessRole})` : ""}.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "googlecalendar",
      "calendar",
      ...(primary ? ["primary"] : []),
      ...(accessRole ? [safeTag(`access:${accessRole}`)] : []),
    ].filter((item): item is string => Boolean(item)),
    sourceType: "googlecalendar.calendar",
    sourceEventId: `googlecalendar-calendar:${calendarId}`,
    externalObjectId: calendarId,
    externalObjectType: "google_calendar",
    observedAt: params.fetchedAt,
    confidence: 0.88,
  };
}

function buildGoogleCalendarEventCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  calendarId: string;
  calendarTitle: string;
  event: GoogleCalendarEventPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const eventId = normalizeString(params.event.id);
  const summary = normalizeString(params.event.summary) ?? "Untitled event";
  if (!eventId) {
    return null;
  }
  const description = normalizeString(params.event.description);
  const status = normalizeString(params.event.status);
  const htmlLink = normalizeString(params.event.htmlLink);
  const location = normalizeString(params.event.location);
  const organizer = isRecord(params.event.organizer) ? params.event.organizer : null;
  const organizerLabel = normalizeString(organizer?.displayName) ?? normalizeString(organizer?.email);
  const windowText = googleCalendarEventWindowText(params.event.start, params.event.end);
  const observedAt = googleCalendarEventDateValue(params.event.start)
    ?? googleCalendarEventDateValue(params.event.end)
    ?? params.fetchedAt;
  const lines = [
    `# ${summary}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Google Calendar",
    `- Calendar: ${params.calendarTitle}`,
    `- Event ID: ${eventId}`,
    windowText ? `- When: ${windowText}` : null,
    organizerLabel ? `- Organizer: ${organizerLabel}` : null,
    location ? `- Location: ${location}` : null,
    status ? `- Status: ${status}` : null,
    htmlLink ? `- URL: ${htmlLink}` : null,
    "",
    "## Summary",
    "",
    description ?? `${summary} on ${params.calendarTitle}.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "googlecalendar",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `event:${params.calendarId}:${eventId}`,
    entityKey: `calendar:${params.calendarId}`,
    entityLabel: params.calendarTitle,
    branchKey: "events",
    branchLabel: "Events",
    title: summary,
    summary: clipText(
      `${summary}${windowText ? ` (${windowText})` : ""}.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "googlecalendar",
      "event",
      ...(status ? [safeTag(`status:${status}`)] : []),
    ].filter((item): item is string => Boolean(item)),
    sourceType: "googlecalendar.event",
    sourceEventId: `googlecalendar-event:${params.calendarId}:${eventId}`,
    externalObjectId: eventId,
    externalObjectType: "google_calendar_event",
    observedAt,
    confidence: 0.83,
  };
}

function buildGoogleCalendarSettingCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  setting: GoogleCalendarSettingPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const settingId = normalizeString(params.setting.id);
  if (!settingId) {
    return null;
  }
  const value = normalizeString(params.setting.value);
  const lines = [
    `# Calendar setting ${settingId}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Google Calendar",
    `- Setting ID: ${settingId}`,
    value ? `- Value: ${value}` : null,
    "",
    "## Summary",
    "",
    value ? `${settingId} is set to ${value}.` : `${settingId} is present in Google Calendar settings.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "googlecalendar",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `setting:${settingId}`,
    branchKey: "settings",
    branchLabel: "Settings",
    title: settingId,
    summary: clipText(value ? `${settingId} is set to ${value}.` : `${settingId} is present in Google Calendar settings.`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["googlecalendar", "setting"],
    sourceType: "googlecalendar.setting",
    sourceEventId: `googlecalendar-setting:${settingId}`,
    externalObjectId: settingId,
    externalObjectType: "google_calendar_setting",
    observedAt: params.fetchedAt,
    confidence: 0.78,
  };
}

function buildGoogleCalendarResourceCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  resource: GoogleCalendarResourcePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const resourceId = normalizeString(params.resource.resourceId) ?? normalizeString(params.resource.resourceEmail);
  const title = normalizeString(params.resource.resourceName)
    ?? normalizeString(params.resource.generatedResourceName)
    ?? normalizeString(params.resource.resourceEmail);
  if (!resourceId || !title) {
    return null;
  }
  const resourceEmail = normalizeString(params.resource.resourceEmail);
  const buildingId = normalizeString(params.resource.buildingId);
  const category = normalizeString(params.resource.resourceCategory);
  const type = normalizeString(params.resource.resourceType);
  const capacity = parseInteger(params.resource.capacity);
  const floorName = normalizeString(params.resource.floorName);
  const floorSection = normalizeString(params.resource.floorSection);
  const lines = [
    `# ${title}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Google Calendar",
    `- Resource ID: ${resourceId}`,
    resourceEmail ? `- Email: ${resourceEmail}` : null,
    buildingId ? `- Building: ${buildingId}` : null,
    floorName ? `- Floor: ${floorName}` : null,
    floorSection ? `- Floor section: ${floorSection}` : null,
    category ? `- Category: ${category}` : null,
    type ? `- Type: ${type}` : null,
    capacity !== null ? `- Capacity: ${capacity}` : null,
    "",
    "## Summary",
    "",
    `${title} is available as a Google Calendar resource${capacity !== null ? ` for up to ${capacity}` : ""}.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "googlecalendar",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `resource:${resourceId}`,
    branchKey: "resources",
    branchLabel: "Resources",
    title,
    summary: clipText(`${title} is available as a Google Calendar resource${capacity !== null ? ` for up to ${capacity}` : ""}.`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: [
      "googlecalendar",
      "resource",
      ...(category ? [safeTag(`category:${category}`)] : []),
      ...(type ? [safeTag(`type:${type}`)] : []),
    ].filter((item): item is string => Boolean(item)),
    sourceType: "googlecalendar.resource",
    sourceEventId: `googlecalendar-resource:${resourceId}`,
    externalObjectId: resourceId,
    externalObjectType: "google_calendar_resource",
    observedAt: params.fetchedAt,
    confidence: 0.79,
  };
}

function buildGoogleCalendarBuildingCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  building: GoogleCalendarBuildingPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const buildingId = normalizeString(params.building.buildingId);
  const title = normalizeString(params.building.buildingName) ?? buildingId;
  if (!buildingId || !title) {
    return null;
  }
  const description = normalizeString(params.building.description);
  const floors = Array.isArray(params.building.floors) ? params.building.floors.length : null;
  const lines = [
    `# ${title}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Google Calendar",
    `- Building ID: ${buildingId}`,
    floors !== null ? `- Floors: ${floors}` : null,
    "",
    "## Summary",
    "",
    description ?? `${title} is available as a Google Workspace building record.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "googlecalendar",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `building:${buildingId}`,
    branchKey: "buildings",
    branchLabel: "Buildings",
    title,
    summary: clipText(description ?? `${title} is available as a Google Workspace building record.`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["googlecalendar", "building"],
    sourceType: "googlecalendar.building",
    sourceEventId: `googlecalendar-building:${buildingId}`,
    externalObjectId: buildingId,
    externalObjectType: "google_calendar_building",
    observedAt: params.fetchedAt,
    confidence: 0.78,
  };
}

function linkedInProfileName(value: LinkedInUserInfoPayload): string | null {
  const direct = normalizeString(value.name);
  if (direct) {
    return direct;
  }
  const given = normalizeString(value.given_name)
    ?? normalizeString(value.firstName)
    ?? normalizeString(value.localizedFirstName);
  const family = normalizeString(value.family_name)
    ?? normalizeString(value.lastName)
    ?? normalizeString(value.localizedLastName);
  const combined = [given, family]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .trim();
  return combined.length > 0 ? combined : null;
}

function linkedInProfilePersonId(value: LinkedInUserInfoPayload): string | null {
  const direct = normalizeString(value.id);
  if (direct) {
    return direct;
  }
  const author = normalizeString(value.author);
  if (author?.startsWith("urn:li:person:")) {
    return author.slice("urn:li:person:".length);
  }
  return null;
}

function linkedInPersonName(value: LinkedInPersonPayload): string | null {
  const given = normalizeString(value.firstName) ?? normalizeString(value.localizedFirstName);
  const family = normalizeString(value.lastName) ?? normalizeString(value.localizedLastName);
  const combined = [given, family].filter((part): part is string => Boolean(part)).join(" ").trim();
  return combined.length > 0 ? combined : null;
}

function linkedInOrganizationId(value: LinkedInCompanyPayload): string | null {
  return normalizeString(value.organization_id)
    ?? normalizeString(value.id)
    ?? normalizeString(value.organization);
}

function linkedInOrganizationName(value: LinkedInCompanyPayload): string | null {
  return normalizeString(value.name) ?? normalizeString(value.vanityName);
}

function buildLinkedInProfileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  connectionId: string;
  userInfo: LinkedInUserInfoPayload;
  personId: string | null;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const name = linkedInProfileName(params.userInfo);
  const givenName = normalizeString(params.userInfo.given_name);
  const familyName = normalizeString(params.userInfo.family_name);
  const email = normalizeString(params.userInfo.email);
  const locale = normalizeString(params.userInfo.locale);
  const picture = normalizeString(params.userInfo.picture);
  const sub = normalizeString(params.userInfo.sub);
  const emailVerified = normalizeBoolean(params.userInfo.email_verified);
  const lines = [
    "# LinkedIn profile",
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: LinkedIn",
    `- Connection ID: ${params.connectionId}`,
    name ? `- Name: ${name}` : null,
    givenName ? `- First name: ${givenName}` : null,
    familyName ? `- Last name: ${familyName}` : null,
    email ? `- Email: ${email}` : null,
    emailVerified !== null ? `- Email verified: ${emailVerified ? "yes" : "no"}` : null,
    locale ? `- Locale: ${locale}` : null,
    picture ? `- Picture: ${picture}` : null,
    sub ? `- Subject ID: ${sub}` : null,
    params.personId ? `- Person ID: ${params.personId}` : null,
    "",
    "## Summary",
    "",
    `${params.accountLabel} LinkedIn profile snapshot.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "linkedin",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    branchKey: "profile",
    branchLabel: "Profile",
    title: `LinkedIn profile for ${params.accountLabel}`,
    summary: clipText(
      `${params.accountLabel} LinkedIn profile snapshot${name ? ` for ${name}` : ""}.`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["linkedin", "profile"],
    sourceType: "linkedin.profile",
    sourceEventId: `linkedin-profile:${params.accountKey}`,
    externalObjectId: params.personId ?? sub ?? params.accountKey,
    externalObjectType: "linkedin_profile",
    observedAt: params.fetchedAt,
    confidence: 0.95,
  };
}

function buildLinkedInPersonCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  personId: string;
  person: LinkedInPersonPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const name = linkedInPersonName(params.person) ?? params.personId;
  const headline = normalizeString(params.person.headline);
  const vanityName = normalizeString(params.person.vanityName);
  const lines = [
    `# ${name}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: LinkedIn",
    `- Person ID: ${params.personId}`,
    vanityName ? `- Vanity name: ${vanityName}` : null,
    headline ? `- Headline: ${headline}` : null,
    "",
    "## Summary",
    "",
    headline ?? `${name} LinkedIn person profile.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "linkedin",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `person:${params.personId}`,
    branchKey: "person",
    branchLabel: "Person",
    title: name,
    summary: clipText(headline ?? `${name} LinkedIn person profile.`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["linkedin", "person"],
    sourceType: "linkedin.person",
    sourceEventId: `linkedin-person:${params.personId}`,
    externalObjectId: params.personId,
    externalObjectType: "linkedin_person",
    observedAt: params.fetchedAt,
    confidence: 0.84,
  };
}

function buildLinkedInOrganizationCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  organization: LinkedInCompanyPayload;
  networkSize: number | null;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const organizationId = linkedInOrganizationId(params.organization);
  const name = linkedInOrganizationName(params.organization);
  if (!organizationId || !name) {
    return null;
  }
  const description = normalizeString(params.organization.description);
  const website = normalizeString(params.organization.website);
  const industries = stringList(params.organization.industries);
  const lines = [
    `# ${name}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: LinkedIn",
    `- Organization ID: ${organizationId}`,
    website ? `- Website: ${website}` : null,
    industries.length > 0 ? `- Industries: ${industries.join(", ")}` : null,
    params.networkSize !== null ? `- Network size: ${params.networkSize}` : null,
    "",
    "## Summary",
    "",
    description ?? `${name} LinkedIn organization context.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "linkedin",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `organization:${organizationId}`,
    branchKey: "organizations",
    branchLabel: "Organizations",
    title: name,
    summary: clipText(
      `${name}${params.networkSize !== null ? ` has network size ${params.networkSize}.` : " organization context is available."}`,
      220,
    ),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["linkedin", "organization"],
    sourceType: "linkedin.organization",
    sourceEventId: `linkedin-organization:${organizationId}`,
    externalObjectId: organizationId,
    externalObjectType: "linkedin_organization",
    observedAt: params.fetchedAt,
    confidence: 0.8,
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

function buildSlackUserCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  user: SlackUserPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const userId = normalizeString(params.user.id);
  const username = normalizeString(params.user.name);
  const profile = isRecord(params.user.profile) ? params.user.profile : null;
  const displayName = normalizeString(profile?.display_name)
    ?? normalizeString(profile?.real_name)
    ?? normalizeString(params.user.real_name)
    ?? username;
  if (!userId || !displayName) {
    return null;
  }
  const deleted = normalizeBoolean(params.user.deleted);
  const isBot = normalizeBoolean(params.user.is_bot);
  const isAdmin = normalizeBoolean(params.user.is_admin);
  const email = normalizeString(profile?.email);
  const timezone = normalizeString(params.user.tz);
  const lines = [
    `# ${displayName}`,
    "",
    `- Account: ${params.accountLabel}`,
    "- Provider: Slack",
    `- User ID: ${userId}`,
    username ? `- Username: ${username}` : null,
    email ? `- Email: ${email}` : null,
    timezone ? `- Time zone: ${timezone}` : null,
    deleted !== null ? `- Deleted: ${deleted ? "yes" : "no"}` : null,
    isBot !== null ? `- Bot: ${isBot ? "yes" : "no"}` : null,
    isAdmin !== null ? `- Admin: ${isAdmin ? "yes" : "no"}` : null,
    "",
    "## Summary",
    "",
    `${displayName} is part of the Slack workspace.`,
    "",
  ].filter((line): line is string => typeof line === "string");
  return {
    provider: "slack",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `user:${userId}`,
    branchKey: "directory",
    branchLabel: "Directory",
    title: displayName,
    summary: clipText(`${displayName} is part of the Slack workspace.`, 220),
    content: `${lines.join("\n").trim()}\n`,
    tags: ["slack", "user", ...(isBot ? ["bot"] : [])],
    sourceType: "slack.user",
    sourceEventId: `slack-user:${userId}`,
    externalObjectId: userId,
    externalObjectType: "slack_user",
    observedAt: params.fetchedAt,
    confidence: 0.78,
  };
}

function buildSlackMessageCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  channelId: string;
  channelName: string;
  message: SlackMessagePayload;
  branchKey?: string;
  branchLabel?: string;
  sourceType?: string;
  sourcePrefix?: string;
  subjectPrefix?: string;
  extraTags?: string[];
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
    subjectKey: `${params.subjectPrefix ?? "message"}:${params.channelId}:${ts}`,
    entityKey: `channel:${params.channelId}`,
    entityLabel: `#${params.channelName}`,
    branchKey: params.branchKey ?? "messages",
    branchLabel: params.branchLabel ?? "Messages",
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
      ...(params.extraTags ?? []),
    ].filter((item): item is string => Boolean(item)),
    sourceType: params.sourceType ?? "slack.message",
    sourceEventId: `${params.sourcePrefix ?? "slack-message"}:${params.channelId}:${ts}`,
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

function buildSimpleIntegrationCandidate(params: {
  provider: string;
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  subjectKey: string;
  title: string;
  summary: string;
  lines: Array<string | null>;
  tags: Array<string | null>;
  sourceType: string;
  sourceEventId: string;
  externalObjectId?: string | null;
  externalObjectType?: string | null;
  branchKey?: string | null;
  branchLabel?: string | null;
  entityKey?: string | null;
  entityLabel?: string | null;
  observedAt?: string | null;
  confidence?: number | null;
}): IntegrationLeafCandidate {
  return {
    provider: params.provider,
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: params.subjectKey,
    entityKey: params.entityKey ?? null,
    entityLabel: params.entityLabel ?? null,
    branchKey: params.branchKey ?? null,
    branchLabel: params.branchLabel ?? null,
    title: params.title,
    summary: params.summary,
    content: `${params.lines.filter((line): line is string => typeof line === "string").join("\n").trim()}\n`,
    tags: params.tags.filter((tag): tag is string => Boolean(tag)),
    sourceType: params.sourceType,
    sourceEventId: params.sourceEventId,
    externalObjectId: params.externalObjectId ?? null,
    externalObjectType: params.externalObjectType ?? null,
    observedAt: params.observedAt ?? null,
    confidence: params.confidence ?? 0.8,
  };
}

function buildSyntheticConnectionProfileCandidate(params: {
  provider: string;
  providerLabel: string;
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  summary: string;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  return buildSimpleIntegrationCandidate({
    provider: params.provider,
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    title: `${params.providerLabel} profile for ${params.accountLabel}`,
    summary: clipText(params.summary, 220),
    lines: [
      `# ${params.providerLabel} profile for ${params.accountLabel}`,
      "",
      `- Account: ${params.accountLabel}`,
      `- Provider: ${params.providerLabel}`,
      "",
      "## Summary",
      "",
      params.summary,
      "",
    ],
    tags: [params.provider, "profile"],
    sourceType: `${params.provider}.profile`,
    sourceEventId: `${params.provider}-profile:${params.accountKey}`,
    externalObjectId: params.accountKey,
    externalObjectType: `${params.provider}_profile`,
    branchKey: "profile",
    branchLabel: "Profile",
    observedAt: params.fetchedAt,
    confidence: 0.74,
  });
}

function outlookEmailAddress(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (isRecord(value.emailAddress)) {
    return normalizeString(value.emailAddress.address)
      ?? normalizeString(value.emailAddress.name);
  }
  return normalizeString(value.address) ?? normalizeString(value.name);
}

function hubSpotPropertyValue(properties: unknown, key: string): string | null {
  if (!isRecord(properties)) {
    return null;
  }
  return normalizeString(properties[key]);
}

function linearTeamName(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return normalizeString(value.name) ?? normalizeString(value.key);
}

function jiraIssueFields(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function buildOutlookProfileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  profile: OutlookProfilePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const displayName = normalizeString(params.profile.displayName) ?? params.accountLabel;
  const email = normalizeString(params.profile.mail) ?? normalizeString(params.profile.userPrincipalName);
  const jobTitle = normalizeString(params.profile.jobTitle);
  return buildSimpleIntegrationCandidate({
    provider: "outlook",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    title: `Outlook profile for ${displayName}`,
    summary: clipText(email ? `${displayName} Outlook profile (${email}).` : `${displayName} Outlook profile.`, 220),
    lines: [
      `# Outlook profile for ${displayName}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Outlook",
      email ? `- Email: ${email}` : null,
      jobTitle ? `- Job title: ${jobTitle}` : null,
      "",
      "## Summary",
      "",
      email ? `${displayName} Outlook profile (${email}).` : `${displayName} Outlook profile.`,
      "",
    ],
    tags: ["outlook", "profile"],
    sourceType: "outlook.profile",
    sourceEventId: `outlook-profile:${params.accountKey}`,
    externalObjectId: normalizeString(params.profile.id) ?? params.accountKey,
    externalObjectType: "outlook_profile",
    branchKey: "profile",
    branchLabel: "Profile",
    observedAt: params.fetchedAt,
    confidence: 0.86,
  });
}

function buildOutlookMessageCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  message: OutlookMessagePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const messageId = normalizeString(params.message.id);
  const subject = normalizeString(params.message.subject);
  if (!messageId || !subject) {
    return null;
  }
  const preview = normalizeString(params.message.bodyPreview) ?? subject;
  const from = outlookEmailAddress(params.message.from);
  const observedAt = timestampToIso(params.message.receivedDateTime)
    ?? timestampToIso(params.message.sentDateTime)
    ?? params.fetchedAt;
  return buildSimpleIntegrationCandidate({
    provider: "outlook",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `message:${messageId}`,
    title: subject,
    summary: clipText(from ? `${from}: ${preview}` : preview, 220),
    lines: [
      `# ${subject}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Outlook",
      `- Message ID: ${messageId}`,
      from ? `- From: ${from}` : null,
      observedAt ? `- Received at: ${observedAt}` : null,
      "",
      "## Summary",
      "",
      preview,
      "",
    ],
    tags: ["outlook", "message"],
    sourceType: "outlook.message",
    sourceEventId: `outlook-message:${messageId}`,
    externalObjectId: messageId,
    externalObjectType: "outlook_message",
    branchKey: "messages",
    branchLabel: "Messages",
    observedAt,
    confidence: 0.8,
  });
}

function buildOutlookContactCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  contact: OutlookContactPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const contactId = normalizeString(params.contact.id);
  const title = normalizeString(params.contact.displayName)
    ?? [normalizeString(params.contact.givenName), normalizeString(params.contact.surname)].filter(Boolean).join(" ");
  if (!contactId || !title) {
    return null;
  }
  const emails = Array.isArray(params.contact.emailAddresses)
    ? params.contact.emailAddresses.map((item) => outlookEmailAddress(item)).filter((item): item is string => Boolean(item))
    : [];
  return buildSimpleIntegrationCandidate({
    provider: "outlook",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `contact:${contactId}`,
    title,
    summary: clipText(emails[0] ? `${title} (${emails[0]})` : title, 220),
    lines: [
      `# ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Outlook",
      `- Contact ID: ${contactId}`,
      emails[0] ? `- Email: ${emails[0]}` : null,
      normalizeString(params.contact.companyName) ? `- Company: ${normalizeString(params.contact.companyName)}` : null,
      normalizeString(params.contact.jobTitle) ? `- Job title: ${normalizeString(params.contact.jobTitle)}` : null,
      "",
      "## Summary",
      "",
      emails[0] ? `${title} (${emails[0]})` : title,
      "",
    ],
    tags: ["outlook", "contact"],
    sourceType: "outlook.contact",
    sourceEventId: `outlook-contact:${contactId}`,
    externalObjectId: contactId,
    externalObjectType: "outlook_contact",
    branchKey: "contacts",
    branchLabel: "Contacts",
    observedAt: params.fetchedAt,
    confidence: 0.77,
  });
}

function buildOutlookEventCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  event: OutlookEventPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const eventId = normalizeString(params.event.id);
  const subject = normalizeString(params.event.subject);
  if (!eventId || !subject) {
    return null;
  }
  const start = isRecord(params.event.start)
    ? timestampToIso(params.event.start.dateTime) ?? normalizeString(params.event.start.dateTime)
    : null;
  const end = isRecord(params.event.end)
    ? timestampToIso(params.event.end.dateTime) ?? normalizeString(params.event.end.dateTime)
    : null;
  const location = isRecord(params.event.location)
    ? normalizeString(params.event.location.displayName)
    : normalizeString(params.event.location);
  return buildSimpleIntegrationCandidate({
    provider: "outlook",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `event:${eventId}`,
    title: subject,
    summary: clipText(`${subject}${start ? ` starting ${start}` : ""}`, 220),
    lines: [
      `# ${subject}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Outlook",
      `- Event ID: ${eventId}`,
      start ? `- Start: ${start}` : null,
      end ? `- End: ${end}` : null,
      location ? `- Location: ${location}` : null,
      "",
      "## Summary",
      "",
      `${subject}${start ? ` starting ${start}` : ""}`,
      "",
    ],
    tags: ["outlook", "event"],
    sourceType: "outlook.event",
    sourceEventId: `outlook-event:${eventId}`,
    externalObjectId: eventId,
    externalObjectType: "outlook_event",
    branchKey: "events",
    branchLabel: "Events",
    observedAt: start ?? params.fetchedAt,
    confidence: 0.79,
  });
}

function buildGoogleSheetsSpreadsheetCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  spreadsheet: GoogleSheetsSpreadsheetPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const spreadsheetId = normalizeString(params.spreadsheet.spreadsheetId) ?? normalizeString(params.spreadsheet.id);
  const title = normalizeString(params.spreadsheet.title) ?? normalizeString(params.spreadsheet.name);
  if (!spreadsheetId || !title) {
    return null;
  }
  const observedAt = timestampToIso(params.spreadsheet.modifiedTime) ?? params.fetchedAt;
  return buildSimpleIntegrationCandidate({
    provider: "googlesheets",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `spreadsheet:${spreadsheetId}`,
    title,
    summary: clipText(`Google Sheet ${title}.`, 220),
    lines: [
      `# ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Google Sheets",
      `- Spreadsheet ID: ${spreadsheetId}`,
      observedAt ? `- Updated at: ${observedAt}` : null,
      "",
      "## Summary",
      "",
      `Google Sheet ${title}.`,
      "",
    ],
    tags: ["googlesheets", "spreadsheet"],
    sourceType: "googlesheets.spreadsheet",
    sourceEventId: `googlesheets-spreadsheet:${spreadsheetId}`,
    externalObjectId: spreadsheetId,
    externalObjectType: "google_sheet",
    branchKey: "spreadsheets",
    branchLabel: "Spreadsheets",
    observedAt,
    confidence: 0.8,
  });
}

function buildGoogleSheetsWorksheetCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  spreadsheetId: string;
  spreadsheetTitle: string;
  sheetNames: string[];
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  if (params.sheetNames.length === 0) {
    return null;
  }
  return buildSimpleIntegrationCandidate({
    provider: "googlesheets",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `worksheet-list:${params.spreadsheetId}`,
    title: `${params.spreadsheetTitle} worksheets`,
    summary: clipText(`Worksheets in ${params.spreadsheetTitle}: ${params.sheetNames.join(", ")}`, 220),
    lines: [
      `# ${params.spreadsheetTitle} worksheets`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Google Sheets",
      `- Spreadsheet ID: ${params.spreadsheetId}`,
      "",
      "## Worksheets",
      "",
      ...params.sheetNames.map((sheetName) => `- ${sheetName}`),
      "",
    ],
    tags: ["googlesheets", "worksheet"],
    sourceType: "googlesheets.worksheets",
    sourceEventId: `googlesheets-worksheets:${params.spreadsheetId}`,
    externalObjectId: params.spreadsheetId,
    externalObjectType: "google_sheet_worksheets",
    branchKey: "worksheets",
    branchLabel: "Worksheets",
    observedAt: params.fetchedAt,
    confidence: 0.76,
  });
}

function buildGoogleSheetsValuesCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  spreadsheetId: string;
  spreadsheetTitle: string;
  range: string;
  values: string[][];
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  if (params.values.length === 0) {
    return null;
  }
  const previewLines = params.values.slice(0, 8).map((row) => `- ${row.join(" | ")}`);
  return buildSimpleIntegrationCandidate({
    provider: "googlesheets",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `values:${params.spreadsheetId}:${params.range}`,
    title: `${params.spreadsheetTitle} values preview`,
    summary: clipText(`Spreadsheet values preview for ${params.spreadsheetTitle} (${params.range}).`, 220),
    lines: [
      `# ${params.spreadsheetTitle} values preview`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Google Sheets",
      `- Spreadsheet ID: ${params.spreadsheetId}`,
      `- Range: ${params.range}`,
      "",
      "## Preview",
      "",
      ...previewLines,
      "",
    ],
    tags: ["googlesheets", "values"],
    sourceType: "googlesheets.values",
    sourceEventId: `googlesheets-values:${params.spreadsheetId}:${params.range}`,
    externalObjectId: params.spreadsheetId,
    externalObjectType: "google_sheet_values",
    branchKey: "values",
    branchLabel: "Values",
    observedAt: params.fetchedAt,
    confidence: 0.74,
  });
}

function buildGoogleDocsDocumentCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  document: GoogleDocsSearchPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const documentId = normalizeString(params.document.documentId) ?? normalizeString(params.document.id);
  const title = normalizeString(params.document.title) ?? normalizeString(params.document.name);
  if (!documentId || !title) {
    return null;
  }
  const observedAt = timestampToIso(params.document.modifiedTime) ?? params.fetchedAt;
  return buildSimpleIntegrationCandidate({
    provider: "googledocs",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `document:${documentId}`,
    title,
    summary: clipText(`Google Doc ${title}.`, 220),
    lines: [
      `# ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Google Docs",
      `- Document ID: ${documentId}`,
      observedAt ? `- Updated at: ${observedAt}` : null,
      "",
      "## Summary",
      "",
      `Google Doc ${title}.`,
      "",
    ],
    tags: ["googledocs", "document"],
    sourceType: "googledocs.document",
    sourceEventId: `googledocs-document:${documentId}`,
    externalObjectId: documentId,
    externalObjectType: "google_doc",
    branchKey: "documents",
    branchLabel: "Documents",
    observedAt,
    confidence: 0.8,
  });
}

function buildGoogleDocsContentCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  documentId: string;
  documentTitle: string;
  plainText: string;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  if (!params.plainText) {
    return null;
  }
  return buildSimpleIntegrationCandidate({
    provider: "googledocs",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `document_content:${params.documentId}`,
    title: `${params.documentTitle} content`,
    summary: clipText(`Google Doc content for ${params.documentTitle}: ${params.plainText}`, 220),
    lines: [
      `# ${params.documentTitle} content`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Google Docs",
      `- Document ID: ${params.documentId}`,
      "",
      "## Summary",
      "",
      clipText(params.plainText, 4000),
      "",
    ],
    tags: ["googledocs", "content"],
    sourceType: "googledocs.content",
    sourceEventId: `googledocs-content:${params.documentId}`,
    externalObjectId: params.documentId,
    externalObjectType: "google_doc_content",
    branchKey: "content",
    branchLabel: "Content",
    observedAt: params.fetchedAt,
    confidence: 0.78,
  });
}

function buildHubSpotContactCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  contact: HubSpotContactPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const contactId = normalizeString(params.contact.id);
  const firstName = hubSpotPropertyValue(params.contact.properties, "firstname");
  const lastName = hubSpotPropertyValue(params.contact.properties, "lastname");
  const email = hubSpotPropertyValue(params.contact.properties, "email");
  const title = [firstName, lastName].filter(Boolean).join(" ") || email || contactId;
  if (!contactId || !title) {
    return null;
  }
  const observedAt = timestampToIso(params.contact.updatedAt) ?? timestampToIso(params.contact.createdAt) ?? params.fetchedAt;
  return buildSimpleIntegrationCandidate({
    provider: "hubspot",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `contact:${contactId}`,
    title,
    summary: clipText(email ? `${title} (${email})` : title, 220),
    lines: [
      `# ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: HubSpot",
      `- Contact ID: ${contactId}`,
      email ? `- Email: ${email}` : null,
      hubSpotPropertyValue(params.contact.properties, "company") ? `- Company: ${hubSpotPropertyValue(params.contact.properties, "company")}` : null,
      "",
      "## Summary",
      "",
      email ? `${title} (${email})` : title,
      "",
    ],
    tags: ["hubspot", "contact"],
    sourceType: "hubspot.contact",
    sourceEventId: `hubspot-contact:${contactId}`,
    externalObjectId: contactId,
    externalObjectType: "hubspot_contact",
    branchKey: "contacts",
    branchLabel: "Contacts",
    observedAt,
    confidence: 0.79,
  });
}

function buildHubSpotCompanyCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  company: HubSpotCompanyPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const companyId = normalizeString(params.company.id);
  const title = hubSpotPropertyValue(params.company.properties, "name") ?? companyId;
  if (!companyId || !title) {
    return null;
  }
  const observedAt = timestampToIso(params.company.updatedAt) ?? timestampToIso(params.company.createdAt) ?? params.fetchedAt;
  return buildSimpleIntegrationCandidate({
    provider: "hubspot",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `company:${companyId}`,
    title,
    summary: clipText(`HubSpot company ${title}.`, 220),
    lines: [
      `# ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: HubSpot",
      `- Company ID: ${companyId}`,
      hubSpotPropertyValue(params.company.properties, "domain") ? `- Domain: ${hubSpotPropertyValue(params.company.properties, "domain")}` : null,
      hubSpotPropertyValue(params.company.properties, "industry") ? `- Industry: ${hubSpotPropertyValue(params.company.properties, "industry")}` : null,
      "",
      "## Summary",
      "",
      `HubSpot company ${title}.`,
      "",
    ],
    tags: ["hubspot", "company"],
    sourceType: "hubspot.company",
    sourceEventId: `hubspot-company:${companyId}`,
    externalObjectId: companyId,
    externalObjectType: "hubspot_company",
    branchKey: "companies",
    branchLabel: "Companies",
    observedAt,
    confidence: 0.78,
  });
}

function buildHubSpotDealCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  deal: HubSpotDealPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const dealId = normalizeString(params.deal.id);
  const title = hubSpotPropertyValue(params.deal.properties, "dealname") ?? dealId;
  if (!dealId || !title) {
    return null;
  }
  const stage = hubSpotPropertyValue(params.deal.properties, "dealstage");
  const amount = hubSpotPropertyValue(params.deal.properties, "amount");
  const observedAt = timestampToIso(params.deal.updatedAt) ?? timestampToIso(params.deal.createdAt) ?? params.fetchedAt;
  return buildSimpleIntegrationCandidate({
    provider: "hubspot",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `deal:${dealId}`,
    title,
    summary: clipText(`${title}${stage ? ` (${stage})` : ""}${amount ? ` amount ${amount}` : ""}`, 220),
    lines: [
      `# ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: HubSpot",
      `- Deal ID: ${dealId}`,
      stage ? `- Stage: ${stage}` : null,
      amount ? `- Amount: ${amount}` : null,
      "",
      "## Summary",
      "",
      `${title}${stage ? ` (${stage})` : ""}${amount ? ` amount ${amount}` : ""}`,
      "",
    ],
    tags: ["hubspot", "deal"],
    sourceType: "hubspot.deal",
    sourceEventId: `hubspot-deal:${dealId}`,
    externalObjectId: dealId,
    externalObjectType: "hubspot_deal",
    branchKey: "deals",
    branchLabel: "Deals",
    observedAt,
    confidence: 0.78,
  });
}

function buildLinearProfileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  user: LinearUserPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const title = normalizeString(params.user.displayName) ?? normalizeString(params.user.name) ?? params.accountLabel;
  const email = normalizeString(params.user.email);
  return buildSimpleIntegrationCandidate({
    provider: "linear",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    title: `Linear profile for ${title}`,
    summary: clipText(email ? `${title} Linear profile (${email}).` : `${title} Linear profile.`, 220),
    lines: [
      `# Linear profile for ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Linear",
      email ? `- Email: ${email}` : null,
      "",
      "## Summary",
      "",
      email ? `${title} Linear profile (${email}).` : `${title} Linear profile.`,
      "",
    ],
    tags: ["linear", "profile"],
    sourceType: "linear.profile",
    sourceEventId: `linear-profile:${params.accountKey}`,
    externalObjectId: normalizeString(params.user.id) ?? params.accountKey,
    externalObjectType: "linear_profile",
    branchKey: "profile",
    branchLabel: "Profile",
    observedAt: params.fetchedAt,
    confidence: 0.84,
  });
}

function buildLinearIssueCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  issue: LinearIssuePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const issueId = normalizeString(params.issue.id);
  const title = normalizeString(params.issue.title);
  if (!issueId || !title) {
    return null;
  }
  const identifier = normalizeString(params.issue.identifier);
  const teamName = linearTeamName(params.issue.team);
  const observedAt = timestampToIso(params.issue.updatedAt) ?? timestampToIso(params.issue.createdAt) ?? params.fetchedAt;
  return buildSimpleIntegrationCandidate({
    provider: "linear",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `issue:${issueId}`,
    title: identifier ? `${identifier}: ${title}` : title,
    summary: clipText(`${identifier ?? "Issue"} ${title}${teamName ? ` (${teamName})` : ""}`, 220),
    lines: [
      `# ${identifier ? `${identifier}: ` : ""}${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Linear",
      `- Issue ID: ${issueId}`,
      teamName ? `- Team: ${teamName}` : null,
      normalizeString(params.issue.url) ? `- URL: ${normalizeString(params.issue.url)}` : null,
      "",
      "## Summary",
      "",
      normalizeString(params.issue.description) ? clipText(normalizeString(params.issue.description)!, 4000) : title,
      "",
    ],
    tags: ["linear", "issue"],
    sourceType: "linear.issue",
    sourceEventId: `linear-issue:${issueId}`,
    externalObjectId: issueId,
    externalObjectType: "linear_issue",
    branchKey: "issues",
    branchLabel: "Issues",
    observedAt,
    confidence: 0.82,
  });
}

function buildLinearProjectCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  project: LinearProjectPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const projectId = normalizeString(params.project.id);
  const title = normalizeString(params.project.name);
  if (!projectId || !title) {
    return null;
  }
  const observedAt = timestampToIso(params.project.updatedAt) ?? timestampToIso(params.project.createdAt) ?? params.fetchedAt;
  return buildSimpleIntegrationCandidate({
    provider: "linear",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `project:${projectId}`,
    title,
    summary: clipText(`Linear project ${title}.`, 220),
    lines: [
      `# ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Linear",
      `- Project ID: ${projectId}`,
      normalizeString(params.project.url) ? `- URL: ${normalizeString(params.project.url)}` : null,
      "",
      "## Summary",
      "",
      normalizeString(params.project.description) ? clipText(normalizeString(params.project.description)!, 4000) : `Linear project ${title}.`,
      "",
    ],
    tags: ["linear", "project"],
    sourceType: "linear.project",
    sourceEventId: `linear-project:${projectId}`,
    externalObjectId: projectId,
    externalObjectType: "linear_project",
    branchKey: "projects",
    branchLabel: "Projects",
    observedAt,
    confidence: 0.8,
  });
}

function buildLinearTeamCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  team: LinearTeamPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const teamId = normalizeString(params.team.id);
  const title = normalizeString(params.team.name) ?? normalizeString(params.team.key);
  if (!teamId || !title) {
    return null;
  }
  return buildSimpleIntegrationCandidate({
    provider: "linear",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `team:${teamId}`,
    title,
    summary: clipText(`Linear team ${title}.`, 220),
    lines: [
      `# ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Linear",
      `- Team ID: ${teamId}`,
      normalizeString(params.team.key) ? `- Key: ${normalizeString(params.team.key)}` : null,
      "",
      "## Summary",
      "",
      normalizeString(params.team.description) ? clipText(normalizeString(params.team.description)!, 4000) : `Linear team ${title}.`,
      "",
    ],
    tags: ["linear", "team"],
    sourceType: "linear.team",
    sourceEventId: `linear-team:${teamId}`,
    externalObjectId: teamId,
    externalObjectType: "linear_team",
    branchKey: "teams",
    branchLabel: "Teams",
    observedAt: params.fetchedAt,
    confidence: 0.78,
  });
}

function buildJiraProfileCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  user: JiraCurrentUserPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate {
  const title = normalizeString(params.user.displayName) ?? params.accountLabel;
  const email = normalizeString(params.user.emailAddress);
  return buildSimpleIntegrationCandidate({
    provider: "jira",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: "profile",
    title: `Jira profile for ${title}`,
    summary: clipText(email ? `${title} Jira profile (${email}).` : `${title} Jira profile.`, 220),
    lines: [
      `# Jira profile for ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Jira",
      email ? `- Email: ${email}` : null,
      "",
      "## Summary",
      "",
      email ? `${title} Jira profile (${email}).` : `${title} Jira profile.`,
      "",
    ],
    tags: ["jira", "profile"],
    sourceType: "jira.profile",
    sourceEventId: `jira-profile:${params.accountKey}`,
    externalObjectId: normalizeString(params.user.accountId) ?? params.accountKey,
    externalObjectType: "jira_profile",
    branchKey: "profile",
    branchLabel: "Profile",
    observedAt: params.fetchedAt,
    confidence: 0.84,
  });
}

function buildJiraProjectCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  project: JiraProjectPayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const projectId = normalizeString(params.project.id) ?? normalizeString(params.project.key);
  const title = normalizeString(params.project.name) ?? normalizeString(params.project.key);
  if (!projectId || !title) {
    return null;
  }
  return buildSimpleIntegrationCandidate({
    provider: "jira",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `project:${projectId}`,
    title,
    summary: clipText(`Jira project ${title}.`, 220),
    lines: [
      `# ${title}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Jira",
      `- Project ID: ${projectId}`,
      normalizeString(params.project.key) ? `- Key: ${normalizeString(params.project.key)}` : null,
      normalizeString(params.project.projectTypeKey) ? `- Project type: ${normalizeString(params.project.projectTypeKey)}` : null,
      "",
      "## Summary",
      "",
      `Jira project ${title}.`,
      "",
    ],
    tags: ["jira", "project"],
    sourceType: "jira.project",
    sourceEventId: `jira-project:${projectId}`,
    externalObjectId: projectId,
    externalObjectType: "jira_project",
    branchKey: "projects",
    branchLabel: "Projects",
    observedAt: params.fetchedAt,
    confidence: 0.79,
  });
}

function buildJiraIssueCandidate(params: {
  ownerUserId: string;
  accountKey: string;
  accountLabel: string;
  issue: JiraIssuePayload;
  fetchedAt: string;
}): IntegrationLeafCandidate | null {
  const issueId = normalizeString(params.issue.id) ?? normalizeString(params.issue.key);
  const fields = jiraIssueFields(params.issue.fields);
  const summary = normalizeString(fields.summary);
  if (!issueId || !summary) {
    return null;
  }
  const key = normalizeString(params.issue.key);
  const observedAt = timestampToIso(fields.updated) ?? timestampToIso(fields.created) ?? params.fetchedAt;
  return buildSimpleIntegrationCandidate({
    provider: "jira",
    ownerUserId: params.ownerUserId,
    accountKey: params.accountKey,
    accountLabel: params.accountLabel,
    subjectKey: `issue:${issueId}`,
    title: key ? `${key}: ${summary}` : summary,
    summary: clipText(`${key ?? "Issue"} ${summary}`, 220),
    lines: [
      `# ${key ? `${key}: ` : ""}${summary}`,
      "",
      `- Account: ${params.accountLabel}`,
      "- Provider: Jira",
      `- Issue ID: ${issueId}`,
      key ? `- Key: ${key}` : null,
      normalizeString(fields.status && isRecord(fields.status) ? fields.status.name : null)
        ? `- Status: ${normalizeString(isRecord(fields.status) ? fields.status.name : null)}`
        : null,
      "",
      "## Summary",
      "",
      normalizeString(fields.description) ? clipText(normalizeString(fields.description)!, 4000) : summary,
      "",
    ],
    tags: ["jira", "issue"],
    sourceType: "jira.issue",
    sourceEventId: `jira-issue:${issueId}`,
    externalObjectId: issueId,
    externalObjectType: "jira_issue",
    branchKey: "issues",
    branchLabel: "Issues",
    observedAt,
    confidence: 0.82,
  });
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

function integrationTreeHasSemanticState(params: {
  store: RuntimeStateStore;
  treeId: string;
}): boolean {
  return params.store.listSemanticMemoryNodes({
    category: "integration",
    treeId: params.treeId,
    status: "active",
    limit: 1,
    offset: 0,
  }).length > 0;
}

async function finalizeIntegrationContextSummary(params: {
  store: RuntimeStateStore;
  treeId: string | null;
  providerLabel: string;
  treeChanged: boolean;
  syncProgress: (patch?: Partial<IntegrationContextFetchProgressSnapshot>) => void;
}): Promise<number> {
  if (!params.treeId) {
    return 0;
  }
  const shouldRebuild = params.treeChanged || !integrationTreeHasSemanticState({
    store: params.store,
    treeId: params.treeId,
  });
  params.syncProgress({
    current_chunk_label: `${shouldRebuild ? "Rebuilding" : "Reusing"} ${params.providerLabel} context summary`,
  });
  if (shouldRebuild) {
    await queueIntegrationTreeRebuild({
      store: params.store,
      treeId: params.treeId,
      embeddingClient: null,
      debounceMs: 0,
    });
  }
  return countSummaryLikeSemanticIntegrationNodes({
    store: params.store,
    treeId: params.treeId,
  });
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
  return normalized === "gmail"
    || normalized === "github"
    || normalized === "notion"
    || normalized === "slack"
    || normalized === "googlecalendar"
    || normalized === "googledrive"
    || normalized === "twitter"
    || normalized === "linkedin"
    || normalized === "outlook"
    || normalized === "googlesheets"
    || normalized === "googledocs"
    || normalized === "hubspot"
    || normalized === "linear"
    || normalized === "jira";
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

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Gmail",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0,
    syncProgress,
  });
  chunksCompleted += 1;
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
  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "GitHub",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0 || retiredRepoLeaves > 0,
    syncProgress,
  });
  chunksCompleted += 1;
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

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Notion",
    treeChanged: persistStats.created > 0
      || persistStats.superseding > 0
      || retiredPages > 0
      || retiredDatabases > 0,
    syncProgress,
  });
  chunksCompleted += 1;
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

async function fetchGoogleDriveIntegrationContext(params: {
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
  if (!params.composio.proxyRequest) {
    throw new Error("Google Drive context fetch requires Composio proxy support");
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

  syncProgress({ current_chunk_label: "Fetching Google Drive profile" });
  const aboutResult = await params.composio.proxyRequest({
    connectedAccountId,
    endpoint: "/drive/v3/about?fields=user(displayName,emailAddress,permissionId),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)",
    method: "GET",
  });
  actions.push("GOOGLEDRIVE_PROXY:/drive/v3/about");
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Saving Google Drive profile" });
  const about = googleDriveAboutFromData(aboutResult.data);
  const user = isRecord(about?.user) ? about.user : null;
  const email = normalizeString(user?.emailAddress) ?? normalizeString(user?.email);
  const displayName = normalizeString(user?.displayName) ?? normalizeString(user?.name);
  accountKey = email
    ?? normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  if (email) {
    persistConnectionIdentity({
      store: params.store,
      connectionId: connection.connectionId,
      accountEmail: email,
    });
  }
  accountLabel = displayName ?? email ?? accountKey;

  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildGoogleDriveProfileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      connectionId: connection.connectionId,
      about: about ?? {},
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Fetching Google Drive files" });

  const filesResult = await params.composio.proxyRequest({
    connectedAccountId,
    endpoint: "/drive/v3/files?pageSize=25&orderBy=modifiedTime%20desc&includeItemsFromAllDrives=true&supportsAllDrives=true&fields=nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink,owners(displayName,emailAddress),parents,shared,starred,trashed,size,description)",
    method: "GET",
  });
  actions.push("GOOGLEDRIVE_PROXY:/drive/v3/files");
  const files = googleDriveFilesFromData(filesResult.data)
    .filter((file) => normalizeBoolean(file.trashed) !== true);
  const fileEntityKeys = new Set(
    files
      .map((file) => normalizeString(file.id))
      .filter((id): id is string => Boolean(id))
      .map((id) => `file:${id}`),
  );
  chunksCompleted += 1;
  syncProgress({
    current_chunk_label:
      files.length > 0
        ? `Importing Google Drive files (0/${files.length})`
        : "Rebuilding Google Drive context summary",
  });

  chunksTotal += files.length;
  for (const [index, file] of files.entries()) {
    contentSeen += 1;
    const candidate = buildGoogleDriveFileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      file,
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
    chunksCompleted += 1;
    syncProgress({
      current_chunk_label:
        index + 1 < files.length
          ? `Importing Google Drive files (${index + 1}/${files.length})`
          : "Reconciling Google Drive files",
      });
  }

  chunksTotal += 1;
  syncProgress({ current_chunk_label: "Fetching Google Drive shared drives" });
  try {
    const sharedDrivesResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "GOOGLEDRIVE_LIST_SHARED_DRIVES",
      arguments: {
        pageSize: GOOGLE_DRIVE_SHARED_DRIVE_LIMIT,
      },
    });
    actions.push("GOOGLEDRIVE_LIST_SHARED_DRIVES");
    const sharedDrives = googleDriveSharedDrivesFromData(sharedDrivesResult.data);
    for (const sharedDrive of sharedDrives) {
      const candidate = buildGoogleDriveSharedDriveCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        sharedDrive,
        fetchedAt: params.fetchedAt,
      });
      contentSeen += 1;
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
    if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "GOOGLEDRIVE_LIST_SHARED_DRIVES")) {
      throw error;
    }
    actions.push(
      isComposioForbiddenError(error)
        ? "GOOGLEDRIVE_LIST_SHARED_DRIVES:forbidden"
        : "GOOGLEDRIVE_LIST_SHARED_DRIVES:missing",
    );
  }
  chunksCompleted += 1;

  const permissionFiles = files
    .filter((file) => !isGoogleDriveFolderMimeType(normalizeString(file.mimeType)))
    .map((file) => ({
      id: normalizeString(file.id),
      title: normalizeString(file.name) ?? "Drive file",
    }))
    .filter((file): file is { id: string; title: string } => Boolean(file.id))
    .slice(0, GOOGLE_DRIVE_PERMISSION_TARGETS);
  chunksTotal += permissionFiles.length;
  syncProgress({
    current_chunk_label:
      permissionFiles.length > 0
        ? `Fetching Google Drive permissions (0/${permissionFiles.length})`
        : "Reconciling Google Drive files",
  });
  for (const [index, file] of permissionFiles.entries()) {
    try {
      const permissionsResult = await params.composio.executeAction({
        connectedAccountId,
        toolSlug: "GOOGLEDRIVE_LIST_PERMISSIONS",
        arguments: {
          fileId: file.id,
        },
      });
      actions.push(`GOOGLEDRIVE_LIST_PERMISSIONS:${file.id}`);
      const permissions = googleDrivePermissionsFromData(permissionsResult.data);
      for (const permission of permissions) {
        const candidate = buildGoogleDrivePermissionCandidate({
          ownerUserId: connection.ownerUserId,
          accountKey,
          accountLabel,
          fileId: file.id,
          fileTitle: file.title,
          permission,
          fetchedAt: params.fetchedAt,
        });
        contentSeen += 1;
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
      if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "GOOGLEDRIVE_LIST_PERMISSIONS")) {
        throw error;
      }
      actions.push(
        isComposioForbiddenError(error)
          ? `GOOGLEDRIVE_LIST_PERMISSIONS:${file.id}:forbidden`
          : `GOOGLEDRIVE_LIST_PERMISSIONS:${file.id}:missing`,
      );
    }
    chunksCompleted += 1;
    syncProgress({
      current_chunk_label:
        index + 1 < permissionFiles.length
          ? `Fetching Google Drive permissions (${index + 1}/${permissionFiles.length})`
          : "Reconciling Google Drive files",
    });
  }

  const retiredFiles = retireIntegrationEntityLeaves({
    store: params.store,
    treeId,
    entityPrefix: "file:",
    keepEntityKeys: fileEntityKeys,
    supersededAt: params.fetchedAt,
  });
  if (retiredFiles > 0) {
    actions.push(`GOOGLEDRIVE_RETIRED_FILE_LEAVES:${retiredFiles}`);
  }
  chunksCompleted += 1;

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Google Drive",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0 || retiredFiles > 0,
    syncProgress,
  });
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Google Drive context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "googledrive",
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

async function fetchTwitterIntegrationContext(params: {
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

  syncProgress({ current_chunk_label: "Fetching Twitter profile" });
  let profile: TwitterUserPayload | null = null;
  if (params.composio.proxyRequest) {
    const profileResult = await params.composio.proxyRequest({
      connectedAccountId,
      endpoint: "/2/users/me?user.fields=created_at,description,id,location,name,profile_image_url,public_metrics,url,username,verified",
      method: "GET",
    });
    actions.push("TWITTER_PROXY:/2/users/me");
    profile = twitterUserFromData(profileResult.data);
  } else {
    const profileResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "TWITTER_USER_LOOKUP_ME",
      arguments: {},
    });
    actions.push("TWITTER_USER_LOOKUP_ME");
    profile = twitterUserFromData(profileResult.data);
  }
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Saving Twitter profile" });

  const userId = normalizeString(profile?.id);
  const username = normalizeString(profile?.username);
  const name = normalizeString(profile?.name);
  accountKey = username
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  if (username) {
    persistConnectionIdentity({
      store: params.store,
      connectionId: connection.connectionId,
      accountHandle: username,
    });
  }
  accountLabel = name && username ? `${name} (@${username})` : name ?? username ?? accountKey;

  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildTwitterProfileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      connectionId: connection.connectionId,
      user: profile ?? {},
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Fetching Twitter timeline" });

  let posts: TwitterPostPayload[] = [];
  if (userId) {
    if (params.composio.proxyRequest) {
      const timelineResult = await params.composio.proxyRequest({
        connectedAccountId,
        endpoint: `/2/users/${encodeURIComponent(userId)}/timelines/reverse_chronological?max_results=20&exclude=replies&tweet.fields=author_id,conversation_id,created_at,entities,lang,public_metrics,referenced_tweets`,
        method: "GET",
      });
      actions.push("TWITTER_PROXY:/2/users/{id}/timelines/reverse_chronological");
      posts = twitterPostsFromData(timelineResult.data);
    } else {
      const timelineResult = await params.composio.executeAction({
        connectedAccountId,
        toolSlug: "TWITTER_USER_HOME_TIMELINE_BY_USER_ID",
        arguments: {
          id: userId,
          max_results: 20,
          exclude: ["replies"],
        },
      });
      actions.push("TWITTER_USER_HOME_TIMELINE_BY_USER_ID");
      posts = twitterPostsFromData(timelineResult.data);
    }
  }
  const postEntityKeys = new Set(
    posts
      .map((post) => normalizeString(post.id))
      .filter((id): id is string => Boolean(id))
      .map((id) => `post:${id}`),
  );
  chunksCompleted += 1;
  chunksTotal += posts.length;
  syncProgress({
    current_chunk_label:
      posts.length > 0
        ? `Importing Twitter posts (0/${posts.length})`
        : "Rebuilding Twitter context summary",
  });

  for (const [index, post] of posts.entries()) {
    contentSeen += 1;
    const candidate = buildTwitterPostCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      authorUsername: username,
      post,
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
    chunksCompleted += 1;
    syncProgress({
      current_chunk_label:
        index + 1 < posts.length
          ? `Importing Twitter posts (${index + 1}/${posts.length})`
          : "Reconciling Twitter posts",
      });
  }

  if (username) {
    chunksTotal += 1;
    syncProgress({ current_chunk_label: `Searching recent Twitter mentions for @${username}` });
    try {
      const mentionsResult = await params.composio.executeAction({
        connectedAccountId,
        toolSlug: "TWITTER_RECENT_SEARCH",
        arguments: {
          query: `@${username}`,
          max_results: TWITTER_MENTION_LIMIT,
        },
      });
      actions.push("TWITTER_RECENT_SEARCH");
      const mentionPosts = twitterPostsFromData(mentionsResult.data);
      for (const post of mentionPosts) {
        const candidate = buildTwitterPostCandidate({
          ownerUserId: connection.ownerUserId,
          accountKey,
          accountLabel,
          authorUsername: username,
          post,
          fetchedAt: params.fetchedAt,
          branchKey: "mentions",
          branchLabel: "Mentions",
          sourceType: "twitter.mention",
          sourcePrefix: "twitter-mention",
          subjectPrefix: "mention",
          extraTags: ["mention"],
        });
        contentSeen += 1;
        if (!candidate) {
          continue;
        }
        if (candidate.entityKey?.startsWith("post:")) {
          postEntityKeys.add(candidate.entityKey);
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
      if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "TWITTER_RECENT_SEARCH")) {
        throw error;
      }
      actions.push(
        isComposioForbiddenError(error)
          ? "TWITTER_RECENT_SEARCH:forbidden"
          : "TWITTER_RECENT_SEARCH:missing",
      );
    }
    chunksCompleted += 1;
  }

  chunksTotal += 1;
  syncProgress({ current_chunk_label: "Fetching recent Twitter direct messages" });
  try {
    const dmEventsResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "TWITTER_GET_RECENT_DM_EVENTS",
      arguments: {
        max_results: TWITTER_DM_EVENT_LIMIT,
        event_types: ["MessageCreate"],
      },
    });
    actions.push("TWITTER_GET_RECENT_DM_EVENTS");
    const dmEvents = twitterDmEventsFromData(dmEventsResult.data);
    for (const event of dmEvents) {
      const candidate = buildTwitterDirectMessageCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        event,
        fetchedAt: params.fetchedAt,
      });
      contentSeen += 1;
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
    if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "TWITTER_GET_RECENT_DM_EVENTS")) {
      throw error;
    }
    actions.push(
      isComposioForbiddenError(error)
        ? "TWITTER_GET_RECENT_DM_EVENTS:forbidden"
        : "TWITTER_GET_RECENT_DM_EVENTS:missing",
    );
  }
  chunksCompleted += 1;

  const retiredPosts = retireIntegrationEntityLeaves({
    store: params.store,
    treeId,
    entityPrefix: "post:",
    keepEntityKeys: postEntityKeys,
    supersededAt: params.fetchedAt,
  });
  if (retiredPosts > 0) {
    actions.push(`TWITTER_RETIRED_POST_LEAVES:${retiredPosts}`);
  }
  chunksCompleted += 1;

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Twitter",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0 || retiredPosts > 0,
    syncProgress,
  });
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Twitter context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "twitter",
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

async function fetchGoogleCalendarIntegrationContext(params: {
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

  syncProgress({ current_chunk_label: "Fetching Google Calendar calendars" });
  const calendarsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GOOGLECALENDAR_LIST_CALENDARS",
    arguments: {
      max_results: GOOGLE_CALENDAR_LIMIT,
    },
  });
  actions.push("GOOGLECALENDAR_LIST_CALENDARS");
  const calendars = googleCalendarListEntriesFromData(calendarsResult.data);
  const sortedCalendars = [...calendars].sort((left, right) => {
    const leftPrimary = normalizeBoolean(left.primary) === true ? 0 : 1;
    const rightPrimary = normalizeBoolean(right.primary) === true ? 0 : 1;
    return leftPrimary - rightPrimary
      || (normalizeString(left.summary) ?? normalizeString(left.id) ?? "").localeCompare(
        normalizeString(right.summary) ?? normalizeString(right.id) ?? "",
      );
  });
  const primaryCalendar = sortedCalendars.find((calendar) => normalizeBoolean(calendar.primary) === true)
    ?? sortedCalendars[0]
    ?? null;
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Saving Google Calendar profile" });

  const primaryCalendarId = normalizeString(primaryCalendar?.id);
  const primaryCalendarSummary = normalizeString(primaryCalendar?.summary);
  accountKey = primaryCalendarId
    ?? normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  if (primaryCalendarId?.includes("@")) {
    persistConnectionIdentity({
      store: params.store,
      connectionId: connection.connectionId,
      accountEmail: primaryCalendarId,
    });
  }
  accountLabel = primaryCalendarSummary ?? primaryCalendarId ?? accountKey;

  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildGoogleCalendarProfileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      connectionId: connection.connectionId,
      primaryCalendar,
      calendarCount: sortedCalendars.length,
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;
  chunksTotal += sortedCalendars.length;
  syncProgress({
    current_chunk_label:
      sortedCalendars.length > 0
        ? `Importing Google Calendar calendars (0/${sortedCalendars.length})`
        : "Rebuilding Google Calendar context summary",
  });

  const calendarEntityKeys = new Set<string>();
  for (const [index, calendar] of sortedCalendars.entries()) {
    const calendarId = normalizeString(calendar.id);
    const calendarTitle = normalizeString(calendar.summary) ?? calendarId ?? "Calendar";
    if (calendarId) {
      calendarEntityKeys.add(`calendar:${calendarId}`);
    }

    const calendarCandidate = buildGoogleCalendarCalendarCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      calendar,
      fetchedAt: params.fetchedAt,
    });
    if (calendarCandidate) {
      contentSeen += 1;
      const persisted = await persistIntegrationCandidate({
        store: params.store,
        workspaceId: "",
        candidate: calendarCandidate,
        embeddingClient: null,
      });
      updatePersistStats(persisted, persistStats);
      contentPersisted += 1;
    }

    if (calendarId) {
      try {
        const eventsResult = await params.composio.executeAction({
          connectedAccountId,
          toolSlug: "GOOGLECALENDAR_EVENTS_LIST",
          arguments: {
            calendarId,
            maxResults: GOOGLE_CALENDAR_EVENT_LIMIT,
            singleEvents: true,
            orderBy: "startTime",
            timeMin: params.fetchedAt,
          },
        });
        actions.push(`GOOGLECALENDAR_EVENTS_LIST:${calendarId}`);
        const events = googleCalendarEventsFromData(eventsResult.data)
          .filter((event) => normalizeString(event.status) !== "cancelled");
        chunksTotal += events.length;
        for (const event of events) {
          const candidate = buildGoogleCalendarEventCandidate({
            ownerUserId: connection.ownerUserId,
            accountKey,
            accountLabel,
            calendarId,
            calendarTitle,
            event,
            fetchedAt: params.fetchedAt,
          });
          contentSeen += 1;
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
          chunksCompleted += 1;
        }
      } catch (error) {
        if (!isComposioForbiddenError(error) && !isComposioNotFoundError(error)) {
          throw error;
        }
        actions.push(
          isComposioForbiddenError(error)
            ? `GOOGLECALENDAR_EVENTS_LIST:${calendarId}:forbidden`
            : `GOOGLECALENDAR_EVENTS_LIST:${calendarId}:missing`,
        );
      }
    }

    chunksCompleted += 1;
    syncProgress({
      current_chunk_label:
        index + 1 < sortedCalendars.length
          ? `Importing Google Calendar calendars (${index + 1}/${sortedCalendars.length})`
          : "Reconciling Google Calendar calendars",
      });
  }

  chunksTotal += 1;
  syncProgress({ current_chunk_label: "Fetching Google Calendar settings" });
  try {
    const settingsResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "GOOGLECALENDAR_SETTINGS_LIST",
      arguments: {
        maxResults: GOOGLE_CALENDAR_SETTINGS_LIMIT,
      },
    });
    actions.push("GOOGLECALENDAR_SETTINGS_LIST");
    const settings = googleCalendarSettingsFromData(settingsResult.data);
    for (const setting of settings) {
      const candidate = buildGoogleCalendarSettingCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        setting,
        fetchedAt: params.fetchedAt,
      });
      contentSeen += 1;
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
    if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "GOOGLECALENDAR_SETTINGS_LIST")) {
      throw error;
    }
    actions.push(
      isComposioForbiddenError(error)
        ? "GOOGLECALENDAR_SETTINGS_LIST:forbidden"
        : "GOOGLECALENDAR_SETTINGS_LIST:missing",
    );
  }
  chunksCompleted += 1;

  chunksTotal += 1;
  syncProgress({ current_chunk_label: "Fetching Google Calendar resources" });
  try {
    const resourcesResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "GOOGLECALENDAR_LIST_CALENDAR_RESOURCES",
      arguments: {
        customer: "my_customer",
        maxResults: GOOGLE_CALENDAR_RESOURCE_LIMIT,
      },
    });
    actions.push("GOOGLECALENDAR_LIST_CALENDAR_RESOURCES");
    const resources = googleCalendarResourcesFromData(resourcesResult.data);
    for (const resource of resources) {
      const candidate = buildGoogleCalendarResourceCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        resource,
        fetchedAt: params.fetchedAt,
      });
      contentSeen += 1;
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
    if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "GOOGLECALENDAR_LIST_CALENDAR_RESOURCES")) {
      throw error;
    }
    actions.push(
      isComposioForbiddenError(error)
        ? "GOOGLECALENDAR_LIST_CALENDAR_RESOURCES:forbidden"
        : "GOOGLECALENDAR_LIST_CALENDAR_RESOURCES:missing",
    );
  }
  chunksCompleted += 1;

  chunksTotal += 1;
  syncProgress({ current_chunk_label: "Fetching Google Calendar buildings" });
  try {
    const buildingsResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "GOOGLECALENDAR_LIST_BUILDINGS",
      arguments: {
        customer: "my_customer",
        maxResults: GOOGLE_CALENDAR_BUILDING_LIMIT,
      },
    });
    actions.push("GOOGLECALENDAR_LIST_BUILDINGS");
    const buildings = googleCalendarBuildingsFromData(buildingsResult.data);
    for (const building of buildings) {
      const candidate = buildGoogleCalendarBuildingCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        building,
        fetchedAt: params.fetchedAt,
      });
      contentSeen += 1;
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
    if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "GOOGLECALENDAR_LIST_BUILDINGS")) {
      throw error;
    }
    actions.push(
      isComposioForbiddenError(error)
        ? "GOOGLECALENDAR_LIST_BUILDINGS:forbidden"
        : "GOOGLECALENDAR_LIST_BUILDINGS:missing",
    );
  }
  chunksCompleted += 1;

  const retiredCalendars = retireIntegrationEntityLeaves({
    store: params.store,
    treeId,
    entityPrefix: "calendar:",
    keepEntityKeys: calendarEntityKeys,
    supersededAt: params.fetchedAt,
  });
  if (retiredCalendars > 0) {
    actions.push(`GOOGLECALENDAR_RETIRED_CALENDAR_LEAVES:${retiredCalendars}`);
  }
  chunksCompleted += 1;

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Google Calendar",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0 || retiredCalendars > 0,
    syncProgress,
  });
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Google Calendar context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "googlecalendar",
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

async function fetchLinkedInIntegrationContext(params: {
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

  syncProgress({ current_chunk_label: "Fetching LinkedIn profile" });
  const userInfoResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "LINKEDIN_GET_MY_INFO",
    arguments: {},
  });
  actions.push("LINKEDIN_GET_MY_INFO");
  const userInfo = linkedInUserInfoFromData(userInfoResult.data) ?? {};
  chunksCompleted += 1;
  const personId = linkedInProfilePersonId(userInfo);

  syncProgress({ current_chunk_label: "Saving LinkedIn profile" });
  const email = normalizeString(userInfo.email);
  const name = linkedInProfileName(userInfo);
  const sub = normalizeString(userInfo.sub);
  accountKey = email
    ?? normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountHandle)
    ?? personId
    ?? sub
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  if (email) {
    persistConnectionIdentity({
      store: params.store,
      connectionId: connection.connectionId,
      accountEmail: email,
    });
  }
  accountLabel = name ?? email ?? accountKey;

  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildLinkedInProfileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      connectionId: connection.connectionId,
      userInfo,
      personId,
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;
  if (personId) {
    chunksTotal += 1;
    syncProgress({ current_chunk_label: "Fetching LinkedIn person profile" });
    try {
      const personResult = await params.composio.executeAction({
        connectedAccountId,
        toolSlug: "LINKEDIN_GET_PERSON",
        arguments: {
          person_id: personId,
        },
      });
      actions.push("LINKEDIN_GET_PERSON");
      const person = linkedInPersonFromData(personResult.data);
      const candidate = person
        ? buildLinkedInPersonCandidate({
          ownerUserId: connection.ownerUserId,
          accountKey,
          accountLabel,
          personId,
          person,
          fetchedAt: params.fetchedAt,
        })
        : null;
      contentSeen += 1;
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
    } catch (error) {
      if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "LINKEDIN_GET_PERSON")) {
        throw error;
      }
      actions.push(
        isComposioForbiddenError(error)
          ? "LINKEDIN_GET_PERSON:forbidden"
          : "LINKEDIN_GET_PERSON:missing",
      );
    }
    chunksCompleted += 1;
  }

  chunksTotal += 1;
  syncProgress({ current_chunk_label: "Fetching LinkedIn organizations" });
  try {
    const companyInfoResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "LINKEDIN_GET_COMPANY_INFO",
      arguments: {},
    });
    actions.push("LINKEDIN_GET_COMPANY_INFO");
    const organizations = linkedInCompaniesFromData(companyInfoResult.data);
    chunksTotal += organizations.length;
    for (const organization of organizations) {
      let networkSize: number | null = null;
      const organizationId = linkedInOrganizationId(organization);
      if (organizationId) {
        try {
          const networkSizeResult = await params.composio.executeAction({
            connectedAccountId,
            toolSlug: "LINKEDIN_GET_NETWORK_SIZE",
            arguments: {
              organization_id: organizationId,
            },
          });
          actions.push(`LINKEDIN_GET_NETWORK_SIZE:${organizationId}`);
          const networkRecord = recordFromData(networkSizeResult.data);
          networkSize = parseInteger(networkRecord?.network_size)
            ?? parseInteger(networkRecord?.follower_count)
            ?? parseInteger(networkRecord?.count)
            ?? parseInteger(networkRecord?.first_degree_size);
        } catch (error) {
          if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "LINKEDIN_GET_NETWORK_SIZE")) {
            throw error;
          }
          actions.push(
            isComposioForbiddenError(error)
              ? `LINKEDIN_GET_NETWORK_SIZE:${organizationId}:forbidden`
              : `LINKEDIN_GET_NETWORK_SIZE:${organizationId}:missing`,
          );
        }
      }
      const candidate = buildLinkedInOrganizationCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        organization,
        networkSize,
        fetchedAt: params.fetchedAt,
      });
      contentSeen += 1;
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
      chunksCompleted += 1;
    }
  } catch (error) {
    if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "LINKEDIN_GET_COMPANY_INFO")) {
      throw error;
    }
    actions.push(
      isComposioForbiddenError(error)
        ? "LINKEDIN_GET_COMPANY_INFO:forbidden"
        : "LINKEDIN_GET_COMPANY_INFO:missing",
    );
  }
  chunksCompleted += 1;
  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "LinkedIn",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0,
    syncProgress,
  });
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "LinkedIn context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "linkedin",
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

async function fetchOutlookIntegrationContext(params: {
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

  syncProgress({ current_chunk_label: "Fetching Outlook profile" });
  const profileResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "OUTLOOK_GET_PROFILE",
    arguments: {},
  });
  actions.push("OUTLOOK_GET_PROFILE");
  const profile = outlookProfileFromData(profileResult.data) ?? {};
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Saving Outlook profile" });
  const email = normalizeString(profile.mail) ?? normalizeString(profile.userPrincipalName);
  const displayName = normalizeString(profile.displayName);
  accountKey = email
    ?? normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  if (email) {
    persistConnectionIdentity({
      store: params.store,
      connectionId: connection.connectionId,
      accountEmail: email,
    });
  }
  accountLabel = displayName ?? email ?? accountKey;

  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildOutlookProfileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      profile,
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching Outlook messages" });
  const messagesResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "OUTLOOK_LIST_MESSAGES",
    arguments: {
      top: OUTLOOK_MESSAGE_LIMIT,
    },
  });
  actions.push("OUTLOOK_LIST_MESSAGES");
  for (const message of outlookMessagesFromData(messagesResult.data).slice(0, OUTLOOK_MESSAGE_LIMIT)) {
    const candidate = buildOutlookMessageCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      message,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching Outlook contacts" });
  let contactsToolSlug = "OUTLOOK_LIST_USER_CONTACTS";
  let contacts: OutlookContactPayload[] = [];
  try {
    const contactsResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: contactsToolSlug,
      arguments: {
        top: OUTLOOK_CONTACT_LIMIT,
      },
    });
    actions.push(contactsToolSlug);
    contacts = outlookContactsFromData(contactsResult.data);
  } catch (error) {
    if (!isMissingComposioToolError(error, contactsToolSlug)) {
      throw error;
    }
    contactsToolSlug = "OUTLOOK_LIST_CONTACTS";
    const contactsResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: contactsToolSlug,
      arguments: {
        top: OUTLOOK_CONTACT_LIMIT,
      },
    });
    actions.push(`${"OUTLOOK_LIST_USER_CONTACTS"}:missing`);
    actions.push(contactsToolSlug);
    contacts = outlookContactsFromData(contactsResult.data);
  }
  for (const contact of contacts.slice(0, OUTLOOK_CONTACT_LIMIT)) {
    const candidate = buildOutlookContactCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      contact,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching Outlook events" });
  const eventsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "OUTLOOK_LIST_EVENTS",
    arguments: {
      top: OUTLOOK_EVENT_LIMIT,
    },
  });
  actions.push("OUTLOOK_LIST_EVENTS");
  for (const event of outlookEventsFromData(eventsResult.data).slice(0, OUTLOOK_EVENT_LIMIT)) {
    if (normalizeBoolean(event.isCancelled) === true) {
      continue;
    }
    const candidate = buildOutlookEventCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      event,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Outlook",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0,
    syncProgress,
  });
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Outlook context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "outlook",
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

async function fetchGoogleSheetsIntegrationContext(params: {
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
  const accountKey = normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  const accountLabel = normalizeString(connection.accountLabel) ?? accountKey;
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

  syncProgress({ current_chunk_label: "Saving Google Sheets profile" });
  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildSyntheticConnectionProfileCandidate({
      provider: "googlesheets",
      providerLabel: "Google Sheets",
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      summary: `Connected Google Sheets account ${accountLabel}.`,
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Searching Google Sheets spreadsheets" });
  const searchResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GOOGLESHEETS_SEARCH_SPREADSHEETS",
    arguments: {
      query: "",
    },
  });
  actions.push("GOOGLESHEETS_SEARCH_SPREADSHEETS");
  const spreadsheets = googleSheetsSpreadsheetsFromData(searchResult.data).slice(0, GOOGLE_SHEETS_SPREADSHEET_LIMIT);
  chunksCompleted += 1;
  syncProgress({
    current_chunk_label:
      spreadsheets.length > 0
        ? `Importing Google Sheets spreadsheets (0/${spreadsheets.length})`
        : "Rebuilding Google Sheets context summary",
  });

  let valueTargetsRemaining = GOOGLE_SHEETS_VALUE_TARGETS;
  for (const [index, spreadsheet] of spreadsheets.entries()) {
    const spreadsheetId = normalizeString(spreadsheet.spreadsheetId) ?? normalizeString(spreadsheet.id);
    if (!spreadsheetId) {
      continue;
    }
    let info = googleSheetsInfoFromData(spreadsheet);
    try {
      const infoResult = await params.composio.executeAction({
        connectedAccountId,
        toolSlug: "GOOGLESHEETS_GET_SPREADSHEET_INFO",
        arguments: {
          spreadsheetId,
        },
      });
      actions.push(`GOOGLESHEETS_GET_SPREADSHEET_INFO:${spreadsheetId}`);
      info = googleSheetsInfoFromData(infoResult.data) ?? info;
    } catch (error) {
      if (!isMissingComposioToolError(error, "GOOGLESHEETS_GET_SPREADSHEET_INFO")) {
        throw error;
      }
      actions.push(`GOOGLESHEETS_GET_SPREADSHEET_INFO:${spreadsheetId}:missing`);
    }

    const properties = isRecord(info?.properties) ? info.properties : null;
    const spreadsheetTitle = normalizeString(properties?.title)
      ?? normalizeString(spreadsheet.title)
      ?? normalizeString(spreadsheet.name)
      ?? spreadsheetId;

    const spreadsheetCandidate = buildGoogleSheetsSpreadsheetCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      spreadsheet: {
        ...spreadsheet,
        spreadsheetId,
        title: spreadsheetTitle,
      },
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
    if (spreadsheetCandidate) {
      const persisted = await persistIntegrationCandidate({
        store: params.store,
        workspaceId: "",
        candidate: spreadsheetCandidate,
        embeddingClient: null,
      });
      updatePersistStats(persisted, persistStats);
      contentPersisted += 1;
    }

    let sheetNames = googleSheetNamesFromData(info);
    if (sheetNames.length === 0) {
      try {
        const sheetNamesResult = await params.composio.executeAction({
          connectedAccountId,
          toolSlug: "GOOGLESHEETS_GET_SHEET_NAMES",
          arguments: {
            spreadsheetId,
          },
        });
        actions.push(`GOOGLESHEETS_GET_SHEET_NAMES:${spreadsheetId}`);
        sheetNames = googleSheetNamesFromData(sheetNamesResult.data);
      } catch (error) {
        if (!isMissingComposioToolError(error, "GOOGLESHEETS_GET_SHEET_NAMES")) {
          throw error;
        }
        actions.push(`GOOGLESHEETS_GET_SHEET_NAMES:${spreadsheetId}:missing`);
      }
    }

    const worksheetCandidate = buildGoogleSheetsWorksheetCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      spreadsheetId,
      spreadsheetTitle,
      sheetNames,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
    if (worksheetCandidate) {
      const persisted = await persistIntegrationCandidate({
        store: params.store,
        workspaceId: "",
        candidate: worksheetCandidate,
        embeddingClient: null,
      });
      updatePersistStats(persisted, persistStats);
      contentPersisted += 1;
    }

    if (valueTargetsRemaining > 0 && sheetNames[0]) {
      const range = `${sheetNames[0]}!A1:E10`;
      try {
        const valuesResult = await params.composio.executeAction({
          connectedAccountId,
          toolSlug: "GOOGLESHEETS_VALUES_GET",
          arguments: {
            spreadsheetId,
            range,
          },
        });
        actions.push(`GOOGLESHEETS_VALUES_GET:${spreadsheetId}:${range}`);
        const valuesCandidate = buildGoogleSheetsValuesCandidate({
          ownerUserId: connection.ownerUserId,
          accountKey,
          accountLabel,
          spreadsheetId,
          spreadsheetTitle,
          range,
          values: googleSheetValuesFromData(valuesResult.data),
          fetchedAt: params.fetchedAt,
        });
        contentSeen += 1;
        if (valuesCandidate) {
          const persisted = await persistIntegrationCandidate({
            store: params.store,
            workspaceId: "",
            candidate: valuesCandidate,
            embeddingClient: null,
          });
          updatePersistStats(persisted, persistStats);
          contentPersisted += 1;
          valueTargetsRemaining -= 1;
        }
      } catch (error) {
        if (!isMissingComposioToolError(error, "GOOGLESHEETS_VALUES_GET")) {
          throw error;
        }
        actions.push(`GOOGLESHEETS_VALUES_GET:${spreadsheetId}:${range}:missing`);
      }
    }

    syncProgress({
      current_chunk_label:
        index + 1 < spreadsheets.length
          ? `Importing Google Sheets spreadsheets (${index + 1}/${spreadsheets.length})`
          : "Rebuilding Google Sheets context summary",
    });
  }

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Google Sheets",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0,
    syncProgress,
  });
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Google Sheets context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "googlesheets",
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

async function fetchGoogleDocsIntegrationContext(params: {
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
  const accountKey = normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  const accountLabel = normalizeString(connection.accountLabel) ?? accountKey;
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

  syncProgress({ current_chunk_label: "Saving Google Docs profile" });
  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildSyntheticConnectionProfileCandidate({
      provider: "googledocs",
      providerLabel: "Google Docs",
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      summary: `Connected Google Docs account ${accountLabel}.`,
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Searching Google Docs documents" });
  const searchResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "GOOGLEDOCS_SEARCH_DOCUMENTS",
    arguments: {
      query: "",
    },
  });
  actions.push("GOOGLEDOCS_SEARCH_DOCUMENTS");
  const documents = googleDocsSearchFromData(searchResult.data).slice(0, GOOGLE_DOCS_DOCUMENT_LIMIT);
  chunksCompleted += 1;
  syncProgress({
    current_chunk_label:
      documents.length > 0
        ? `Importing Google Docs documents (0/${documents.length})`
        : "Rebuilding Google Docs context summary",
  });

  for (const [index, document] of documents.entries()) {
    const documentId = normalizeString(document.documentId) ?? normalizeString(document.id);
    if (!documentId) {
      continue;
    }
    let resolvedDocument = document;
    try {
      const documentResult = await params.composio.executeAction({
        connectedAccountId,
        toolSlug: "GOOGLEDOCS_GET_DOCUMENT_BY_ID",
        arguments: {
          documentId,
        },
      });
      actions.push(`GOOGLEDOCS_GET_DOCUMENT_BY_ID:${documentId}`);
      const fetchedDocument = googleDocsDocumentFromData(documentResult.data);
      if (fetchedDocument) {
        resolvedDocument = {
          ...document,
          documentId,
          title: normalizeString(fetchedDocument.title) ?? normalizeString(document.title) ?? normalizeString(document.name),
        };
      }
    } catch (error) {
      if (!isMissingComposioToolError(error, "GOOGLEDOCS_GET_DOCUMENT_BY_ID")) {
        throw error;
      }
      actions.push(`GOOGLEDOCS_GET_DOCUMENT_BY_ID:${documentId}:missing`);
    }

    const documentCandidate = buildGoogleDocsDocumentCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      document: resolvedDocument,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
    if (documentCandidate) {
      const persisted = await persistIntegrationCandidate({
        store: params.store,
        workspaceId: "",
        candidate: documentCandidate,
        embeddingClient: null,
      });
      updatePersistStats(persisted, persistStats);
      contentPersisted += 1;
    }

    try {
      const plainTextResult = await params.composio.executeAction({
        connectedAccountId,
        toolSlug: "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT",
        arguments: {
          documentId,
        },
      });
      actions.push(`GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT:${documentId}`);
      const plainText = googleDocsPlainTextFromData(plainTextResult.data);
      const contentCandidate = plainText
        ? buildGoogleDocsContentCandidate({
          ownerUserId: connection.ownerUserId,
          accountKey,
          accountLabel,
          documentId,
          documentTitle: documentCandidate?.title ?? normalizeString(resolvedDocument.title) ?? normalizeString(resolvedDocument.name) ?? documentId,
          plainText,
          fetchedAt: params.fetchedAt,
        })
        : null;
      contentSeen += 1;
      if (contentCandidate) {
        const persisted = await persistIntegrationCandidate({
          store: params.store,
          workspaceId: "",
          candidate: contentCandidate,
          embeddingClient: null,
        });
        updatePersistStats(persisted, persistStats);
        contentPersisted += 1;
      }
    } catch (error) {
      if (!isMissingComposioToolError(error, "GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT")) {
        throw error;
      }
      actions.push(`GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT:${documentId}:missing`);
    }

    syncProgress({
      current_chunk_label:
        index + 1 < documents.length
          ? `Importing Google Docs documents (${index + 1}/${documents.length})`
          : "Rebuilding Google Docs context summary",
    });
  }

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Google Docs",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0,
    syncProgress,
  });
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Google Docs context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "googledocs",
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

async function fetchHubSpotIntegrationContext(params: {
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
  const accountKey = normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  const accountLabel = normalizeString(connection.accountLabel) ?? accountKey;
  let treeId: string | null = null;
  let contentSeen = 0;
  let contentPersisted = 0;
  let summaryNodes = 0;
  let chunksTotal = 5;
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

  syncProgress({ current_chunk_label: "Saving HubSpot profile" });
  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildSyntheticConnectionProfileCandidate({
      provider: "hubspot",
      providerLabel: "HubSpot",
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      summary: `Connected HubSpot account ${accountLabel}.`,
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching HubSpot contacts" });
  const contactsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "HUBSPOT_LIST_CONTACTS",
    arguments: {
      limit: HUBSPOT_CONTACT_LIMIT,
    },
  });
  actions.push("HUBSPOT_LIST_CONTACTS");
  for (const contact of hubSpotContactsFromData(contactsResult.data).slice(0, HUBSPOT_CONTACT_LIMIT)) {
    const candidate = buildHubSpotContactCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      contact,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching HubSpot companies" });
  const companiesResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "HUBSPOT_LIST_COMPANIES",
    arguments: {
      limit: HUBSPOT_COMPANY_LIMIT,
    },
  });
  actions.push("HUBSPOT_LIST_COMPANIES");
  for (const company of hubSpotCompaniesFromData(companiesResult.data).slice(0, HUBSPOT_COMPANY_LIMIT)) {
    const candidate = buildHubSpotCompanyCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      company,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching HubSpot deals" });
  const dealsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "HUBSPOT_LIST_DEALS",
    arguments: {
      limit: HUBSPOT_DEAL_LIMIT,
    },
  });
  actions.push("HUBSPOT_LIST_DEALS");
  for (const deal of hubSpotDealsFromData(dealsResult.data).slice(0, HUBSPOT_DEAL_LIMIT)) {
    const candidate = buildHubSpotDealCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      deal,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "HubSpot",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0,
    syncProgress,
  });
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "HubSpot context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "hubspot",
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

async function fetchLinearIntegrationContext(params: {
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

  syncProgress({ current_chunk_label: "Fetching Linear profile" });
  const profileResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "LINEAR_GET_CURRENT_USER",
    arguments: {},
  });
  actions.push("LINEAR_GET_CURRENT_USER");
  const user = linearCurrentUserFromData(profileResult.data) ?? {};
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Saving Linear profile" });
  const email = normalizeString(user.email);
  const displayName = normalizeString(user.displayName) ?? normalizeString(user.name);
  accountKey = email
    ?? normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  if (email) {
    persistConnectionIdentity({
      store: params.store,
      connectionId: connection.connectionId,
      accountEmail: email,
    });
  }
  accountLabel = displayName ?? email ?? accountKey;

  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildLinearProfileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      user,
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching Linear issues" });
  const issuesResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "LINEAR_LIST_LINEAR_ISSUES",
    arguments: {
      limit: LINEAR_ISSUE_LIMIT,
    },
  });
  actions.push("LINEAR_LIST_LINEAR_ISSUES");
  for (const issue of linearIssuesFromData(issuesResult.data).slice(0, LINEAR_ISSUE_LIMIT)) {
    const candidate = buildLinearIssueCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      issue,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching Linear projects" });
  const projectsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "LINEAR_LIST_LINEAR_PROJECTS",
    arguments: {
      limit: LINEAR_PROJECT_LIMIT,
    },
  });
  actions.push("LINEAR_LIST_LINEAR_PROJECTS");
  for (const project of linearProjectsFromData(projectsResult.data).slice(0, LINEAR_PROJECT_LIMIT)) {
    const candidate = buildLinearProjectCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      project,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching Linear teams" });
  const teamsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "LINEAR_LIST_LINEAR_TEAMS",
    arguments: {
      limit: LINEAR_TEAM_LIMIT,
    },
  });
  actions.push("LINEAR_LIST_LINEAR_TEAMS");
  for (const team of linearTeamsFromData(teamsResult.data).slice(0, LINEAR_TEAM_LIMIT)) {
    const candidate = buildLinearTeamCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      team,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Linear",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0,
    syncProgress,
  });
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Linear context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "linear",
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

async function fetchJiraIntegrationContext(params: {
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
  let chunksTotal = 5;
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

  syncProgress({ current_chunk_label: "Fetching Jira profile" });
  const profileResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "JIRA_GET_CURRENT_USER",
    arguments: {},
  });
  actions.push("JIRA_GET_CURRENT_USER");
  const user = jiraCurrentUserFromData(profileResult.data) ?? {};
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Saving Jira profile" });
  const email = normalizeString(user.emailAddress);
  const displayName = normalizeString(user.displayName);
  accountKey = email
    ?? normalizeString(connection.accountEmail)
    ?? normalizeString(connection.accountHandle)
    ?? normalizeString(connection.accountExternalId)
    ?? connection.connectionId;
  if (email) {
    persistConnectionIdentity({
      store: params.store,
      connectionId: connection.connectionId,
      accountEmail: email,
    });
  }
  accountLabel = displayName ?? email ?? accountKey;

  const profilePersist = await persistIntegrationCandidate({
    store: params.store,
    workspaceId: "",
    candidate: buildJiraProfileCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      user,
      fetchedAt: params.fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);
  treeId = profilePersist.tree.treeId;
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching Jira projects" });
  const projectsResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "JIRA_GET_ALL_PROJECTS",
    arguments: {
      maxResults: JIRA_PROJECT_LIMIT,
    },
  });
  actions.push("JIRA_GET_ALL_PROJECTS");
  for (const project of jiraProjectsFromData(projectsResult.data).slice(0, JIRA_PROJECT_LIMIT)) {
    const candidate = buildJiraProjectCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      project,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  syncProgress({ current_chunk_label: "Fetching Jira issues" });
  const issuesResult = await params.composio.executeAction({
    connectedAccountId,
    toolSlug: "JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET",
    arguments: {
      jql: "ORDER BY updated DESC",
      maxResults: JIRA_ISSUE_LIMIT,
    },
  });
  actions.push("JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET");
  for (const issue of jiraIssuesFromData(issuesResult.data).slice(0, JIRA_ISSUE_LIMIT)) {
    const candidate = buildJiraIssueCandidate({
      ownerUserId: connection.ownerUserId,
      accountKey,
      accountLabel,
      issue,
      fetchedAt: params.fetchedAt,
    });
    contentSeen += 1;
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
  chunksCompleted += 1;

  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Jira",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0,
    syncProgress,
  });
  chunksCompleted += 1;
  syncProgress({ current_chunk_label: "Jira context fetch complete" });

  return {
    ok: true,
    supported: true,
    provider_id: "jira",
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

  const threadTargets: Array<{ channelId: string; channelName: string; threadTs: string }> = [];
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
      const threadTs = normalizeString(message.thread_ts) ?? normalizeString(message.ts);
      const replyCount = parseInteger(message.reply_count);
      if (threadTs && replyCount !== null && replyCount > 0) {
        threadTargets.push({
          channelId: channel.id,
          channelName: channel.name,
          threadTs,
        });
      }
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

  chunksTotal += 1;
  syncProgress({ current_chunk_label: "Fetching Slack workspace users" });
  try {
    const usersResult = await params.composio.executeAction({
      connectedAccountId,
      toolSlug: "SLACK_LIST_ALL_USERS",
      arguments: {
        limit: SLACK_USER_LIMIT,
      },
    });
    actions.push("SLACK_LIST_ALL_USERS");
    const users = slackUsersFromData(usersResult.data)
      .filter((user) => normalizeBoolean(user.deleted) !== true);
    for (const user of users) {
      const candidate = buildSlackUserCandidate({
        ownerUserId: connection.ownerUserId,
        accountKey,
        accountLabel,
        user,
        fetchedAt: params.fetchedAt,
      });
      contentSeen += 1;
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
    if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "SLACK_LIST_ALL_USERS")) {
      throw error;
    }
    actions.push(
      isComposioForbiddenError(error)
        ? "SLACK_LIST_ALL_USERS:forbidden"
        : "SLACK_LIST_ALL_USERS:missing",
    );
  }
  chunksCompleted += 1;

  const uniqueThreadTargets = Array.from(
    new Map(
      threadTargets.map((target) => [`${target.channelId}:${target.threadTs}`, target] as const),
    ).values(),
  ).slice(0, SLACK_THREAD_TARGETS);
  chunksTotal += uniqueThreadTargets.length;
  syncProgress({
    current_chunk_label:
      uniqueThreadTargets.length > 0
        ? `Fetching Slack threads (0/${uniqueThreadTargets.length})`
        : "Rebuilding Slack context summary",
  });
  for (const [index, target] of uniqueThreadTargets.entries()) {
    try {
      const repliesResult = await params.composio.executeAction({
        connectedAccountId,
        toolSlug: "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION",
        arguments: {
          channel: target.channelId,
          ts: target.threadTs,
        },
      });
      actions.push(`SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION:${target.channelId}:${target.threadTs}`);
      const replies = slackMessagesFromData(repliesResult.data)
        .filter((message) => normalizeString(message.ts) !== target.threadTs);
      for (const reply of replies) {
        const candidate = buildSlackMessageCandidate({
          ownerUserId: connection.ownerUserId,
          accountKey,
          accountLabel,
          channelId: target.channelId,
          channelName: target.channelName,
          message: reply,
          branchKey: "threads",
          branchLabel: "Threads",
          sourceType: "slack.thread-reply",
          sourcePrefix: "slack-thread-reply",
          subjectPrefix: "thread",
          extraTags: ["thread-reply"],
        });
        contentSeen += 1;
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
      if (!isComposioForbiddenError(error) && !isMissingComposioToolError(error, "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION")) {
        throw error;
      }
      actions.push(
        isComposioForbiddenError(error)
          ? `SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION:${target.channelId}:${target.threadTs}:forbidden`
          : `SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION:${target.channelId}:${target.threadTs}:missing`,
      );
    }
    chunksCompleted += 1;
    syncProgress({
      current_chunk_label:
        index + 1 < uniqueThreadTargets.length
          ? `Fetching Slack threads (${index + 1}/${uniqueThreadTargets.length})`
          : "Rebuilding Slack context summary",
    });
  }
  summaryNodes = await finalizeIntegrationContextSummary({
    store: params.store,
    treeId,
    providerLabel: "Slack",
    treeChanged: persistStats.created > 0 || persistStats.superseding > 0,
    syncProgress,
  });
  chunksCompleted += 1;
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
  if (providerId === "googledrive") {
    return fetchGoogleDriveIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  if (providerId === "googlecalendar") {
    return fetchGoogleCalendarIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  if (providerId === "twitter") {
    return fetchTwitterIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  if (providerId === "linkedin") {
    return fetchLinkedInIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  if (providerId === "outlook") {
    return fetchOutlookIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  if (providerId === "googlesheets") {
    return fetchGoogleSheetsIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  if (providerId === "googledocs") {
    return fetchGoogleDocsIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  if (providerId === "hubspot") {
    return fetchHubSpotIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  if (providerId === "linear") {
    return fetchLinearIntegrationContext({
      store: params.store,
      connectionId: connection.connectionId,
      composio,
      fetchedAt,
      progress,
    });
  }
  if (providerId === "jira") {
    return fetchJiraIntegrationContext({
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
