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

function unwrapActionData(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
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
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || null;
}

function clipText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function timestampToIso(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    const asNumber = Number.parseInt(value, 10);
    if (Number.isFinite(asNumber)) {
      return new Date(asNumber).toISOString();
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
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

function gmailProfileFromData(value: unknown): GmailProfilePayload | null {
  const unwrapped = unwrapActionData(value);
  return isRecord(unwrapped) ? (unwrapped as GmailProfilePayload) : null;
}

function gmailMessagesFromData(value: unknown): GmailMessagePayload[] {
  const unwrapped = unwrapActionData(value);
  if (Array.isArray(unwrapped)) {
    return unwrapped.filter(isRecord) as GmailMessagePayload[];
  }
  if (isRecord(unwrapped) && Array.isArray(unwrapped.messages)) {
    return unwrapped.messages.filter(isRecord) as GmailMessagePayload[];
  }
  return [];
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
    `# Gmail account profile`,
    "",
    `- Account: ${params.accountLabel}`,
    `- Provider: Gmail`,
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
  const labelIds = Array.isArray(params.message.labelIds)
    ? params.message.labelIds.map((item) => normalizeString(item)).filter((item): item is string => Boolean(item))
    : Array.isArray(params.message.labels)
      ? params.message.labels.map((item) => normalizeString(item)).filter((item): item is string => Boolean(item))
      : [];
  const tags = [
    "gmail",
    "message",
    ...labelIds.map((label) => safeTag(`label:${label}`)).filter((item): item is string => Boolean(item)),
  ];
  const title = subject;
  const summaryParts = [
    sender ? `Email from ${sender}` : "Email",
    subject ? `about ${subject}` : null,
    snippet ? `- ${clipText(snippet, 120)}` : null,
  ].filter((part): part is string => Boolean(part));
  const lines = [
    `# ${title}`,
    "",
    `- Account: ${params.accountLabel}`,
    `- Provider: Gmail`,
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
    title,
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
  accountEmail: string;
}): void {
  const existing = params.store.getIntegrationConnection(params.connectionId);
  if (!existing) {
    return;
  }
  if ((existing.accountEmail ?? "").trim().toLowerCase() === params.accountEmail.toLowerCase()) {
    return;
  }
  params.store.upsertIntegrationConnection({
    connectionId: existing.connectionId,
    providerId: existing.providerId,
    ownerUserId: existing.ownerUserId,
    accountLabel: existing.accountLabel,
    accountExternalId: existing.accountExternalId,
    accountHandle: existing.accountHandle,
    accountEmail: params.accountEmail,
    authMode: existing.authMode,
    grantedScopes: existing.grantedScopes,
    status: existing.status,
    secretRef: existing.secretRef,
  });
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
  if (providerId !== "gmail") {
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
  const connectedAccountId = connection.accountExternalId ?? "";

  const composio = resolveComposioClient(params.composioClient ?? null);
  const persistStats = { created: 0, superseding: 0, unchanged: 0 };
  const actions: string[] = [];

  const profileResult = await composio.executeAction({
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
      fetchedAt,
    }),
    embeddingClient: null,
  });
  updatePersistStats(profilePersist, persistStats);

  const emailsResult = await composio.executeAction({
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
  const messages = gmailMessagesFromData(emailsResult.data)
    .sort((left, right) => {
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
      fetchedAt,
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
    provider_id: providerId,
    connection_id: connection.connectionId,
    account_key: accountKey,
    account_label: accountLabel,
    tree_id: treeId,
    fetched_at: fetchedAt,
    leaves_created: persistStats.created,
    leaves_superseding: persistStats.superseding,
    leaves_unchanged: persistStats.unchanged,
    messages_seen: messages.length,
    messages_persisted: messagesPersisted,
    summary_nodes: summaryNodes,
    actions,
  };
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
