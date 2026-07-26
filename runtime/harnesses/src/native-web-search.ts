import fs from "node:fs";
import path from "node:path";

import {
  NATIVE_WEB_SEARCH_EXPOSED_TOOL_NAME,
  NATIVE_WEB_SEARCH_TOOL_DEFINITIONS,
  type NativeWebSearchToolId,
} from "./native-web-search-tools.js";

export type ExaWebSearchLivecrawlMode = "fallback" | "preferred";
export type ExaWebSearchType = "auto" | "fast" | "deep";
export type NativeWebSearchProviderKind = "exa_hosted_mcp" | "holaboss_search";

export interface NativeWebSearchProviderOptions {
  providerId?: string | null;
  providerKind?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface NativeWebSearchParams extends NativeWebSearchProviderOptions {
  query: string;
  numResults?: number | null;
  maxResults?: number | null;
  livecrawl?: string | null;
  type?: string | null;
  contextMaxCharacters?: number | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  toolCallId?: string | null;
}

export interface HarnessNativeWebSearchToolOptions
  extends NativeWebSearchProviderOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface HarnessNativeWebSearchToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: Record<string, unknown>;
  execute: (...args: any[]) => Promise<any>;
}

interface ExaMcpSearchRequest {
  jsonrpc: "2.0";
  id: number;
  method: "tools/call";
  params: {
    name: "web_search_exa";
    arguments: {
      query: string;
      numResults: number;
      livecrawl: ExaWebSearchLivecrawlMode;
      type: ExaWebSearchType;
      contextMaxCharacters?: number;
    };
  };
}

interface ExaMcpSseResponse {
  result?: {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
  error?: {
    message?: string;
  };
}

interface ResolvedWebSearchProvider {
  providerId: string;
  kind: NativeWebSearchProviderKind;
  baseUrl: string;
  apiKey: string;
  userId: string;
  orgId: string;
  sandboxId: string;
}

export const EXA_WEB_SEARCH_BASE_URL = "https://mcp.exa.ai";
export const EXA_WEB_SEARCH_ENDPOINT = "/mcp";
export const EXA_WEB_SEARCH_ENDPOINT_URL = `${EXA_WEB_SEARCH_BASE_URL}${EXA_WEB_SEARCH_ENDPOINT}`;
export const HOLABOSS_WEB_SEARCH_ENDPOINT_URL =
  "https://api.holaboss.ai/api/v1/search/web";
export const DEFAULT_WEB_SEARCH_NUM_RESULTS = 8;
export const MAX_WEB_SEARCH_NUM_RESULTS = 10;
export const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 25_000;
export const EXA_WEB_SEARCH_PROVIDER_ID = "exa_hosted_mcp";
export const HOLABOSS_WEB_SEARCH_PROVIDER_ID = "holaboss_search";

const WEB_SEARCH_CONFIG_KEYS = ["web_search", "webSearch", "search"];
const RUNTIME_CONFIG_PATH_ENV = "HOLABOSS_RUNTIME_CONFIG_PATH";
const SANDBOX_ROOT_ENV = "HB_SANDBOX_ROOT";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = Array.isArray(value)
      ? value.map(stringValue).filter(Boolean).join("\n")
      : stringValue(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function runtimeConfigPath(): string {
  const explicit = (process.env[RUNTIME_CONFIG_PATH_ENV] ?? "").trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  const sandboxRoot = (process.env[SANDBOX_ROOT_ENV] ?? "").trim() || "/holaboss";
  return path.join(sandboxRoot, "state", "runtime-config.json");
}

function readRuntimeConfigDocument(): Record<string, unknown> {
  const configPath = runtimeConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function runtimeWebSearchConfig(
  document: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of WEB_SEARCH_CONFIG_KEYS) {
    const value = asRecord(document[key]);
    if (Object.keys(value).length > 0) {
      return value;
    }
  }
  return {};
}

function providerAliases(providerId: string): string[] {
  const normalized = providerId.trim();
  if (!normalized) {
    return [];
  }
  const aliases = [normalized];
  if (normalized === "exa") {
    aliases.push(EXA_WEB_SEARCH_PROVIDER_ID);
  }
  if (normalized === EXA_WEB_SEARCH_PROVIDER_ID) {
    aliases.push("exa");
  }
  if (normalized === "holaboss") {
    aliases.push(HOLABOSS_WEB_SEARCH_PROVIDER_ID);
  }
  if (normalized === HOLABOSS_WEB_SEARCH_PROVIDER_ID) {
    aliases.push("holaboss");
  }
  return aliases;
}

function normalizeProviderKind(
  kind: string | null | undefined,
  providerId: string,
): NativeWebSearchProviderKind {
  const normalized = firstNonEmptyString(kind, providerId)
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
  if (normalized.includes("holaboss")) {
    return "holaboss_search";
  }
  return "exa_hosted_mcp";
}

function providerIdForKind(kind: NativeWebSearchProviderKind): string {
  return kind === "holaboss_search"
    ? HOLABOSS_WEB_SEARCH_PROVIDER_ID
    : EXA_WEB_SEARCH_PROVIDER_ID;
}

function hasManagedHolabossSearchBinding(document: Record<string, unknown>): boolean {
  const integrations = asRecord(document.integrations);
  const holabossIntegration = asRecord(integrations.holaboss);
  const providers = asRecord(document.providers);
  const holabossProvider = asRecord(
    providers.holaboss_model_proxy ?? providers.holaboss,
  );
  const runtimePayload = asRecord(document.runtime);
  const holabossAuthToken = firstNonEmptyString(
    holabossIntegration.auth_token as string | undefined,
    holabossProvider.api_key as string | undefined,
    document.auth_token as string | undefined,
    document.model_proxy_api_key as string | undefined,
  );
  const holabossUserId = firstNonEmptyString(
    holabossIntegration.user_id as string | undefined,
    document.user_id as string | undefined,
  );
  const holabossSandboxId = firstNonEmptyString(
    holabossIntegration.sandbox_id as string | undefined,
    runtimePayload.sandbox_id as string | undefined,
    document.sandbox_id as string | undefined,
  );
  return Boolean(holabossAuthToken && holabossUserId && holabossSandboxId);
}

function holabossSearchEndpointFromDocument(
  document: Record<string, unknown>,
): string {
  const explicitSearchBaseUrl = firstNonEmptyString(
    document.search_service_base_url,
    document.searchServiceBaseUrl,
    document.search_service_url,
    document.searchServiceUrl,
  );
  if (explicitSearchBaseUrl) {
    return holabossSearchEndpointFromBaseUrl(explicitSearchBaseUrl);
  }

  const controlPlaneBaseUrl = firstNonEmptyString(
    document.control_plane_base_url,
    document.controlPlaneBaseUrl,
  );
  if (controlPlaneBaseUrl) {
    return holabossSearchEndpointFromBaseUrl(controlPlaneBaseUrl, {
      useSearchServicePort: true,
    });
  }

  const providers = asRecord(document.providers);
  const holabossProvider = asRecord(
    providers.holaboss_model_proxy ?? providers.holaboss,
  );
  const modelProxyBaseUrl = firstNonEmptyString(
    holabossProvider.base_url,
    holabossProvider.baseURL,
    document.model_proxy_base_url,
    document.modelProxyBaseUrl,
  );
  if (modelProxyBaseUrl) {
    return holabossSearchEndpointFromModelProxyUrl(modelProxyBaseUrl);
  }

  return HOLABOSS_WEB_SEARCH_ENDPOINT_URL;
}

function holabossSearchEndpointFromBaseUrl(
  baseUrl: string,
  _options: { useSearchServicePort?: boolean } = {},
): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return HOLABOSS_WEB_SEARCH_ENDPOINT_URL;
  }
  if (normalized.endsWith("/api/v1/search/web")) {
    return normalized;
  }
  try {
    const url = new URL(normalized);
    const nextPathname = url.pathname.replace(
      /\/api\/v1\/(?:model-proxy|search\/web)(?:\/.*)?$/,
      "/api/v1/search/web",
    );
    url.pathname =
      nextPathname && nextPathname !== url.pathname
        ? nextPathname
        : `${url.pathname.replace(/\/+$/, "") || ""}/api/v1/search/web`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `${normalized}/api/v1/search/web`;
  }
}

function holabossSearchEndpointFromModelProxyUrl(modelProxyBaseUrl: string): string {
  const normalized = modelProxyBaseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    return HOLABOSS_WEB_SEARCH_ENDPOINT_URL;
  }
  try {
    const url = new URL(normalized);
    const nextPathname = url.pathname.replace(
      /\/api\/v1\/model-proxy(?:\/.*)?$/,
      "/api/v1/search/web",
    );
    url.pathname =
      nextPathname && nextPathname !== url.pathname
        ? nextPathname
        : "/api/v1/search/web";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return normalized.replace(/\/api\/v1\/model-proxy(?:\/.*)?$/, "/api/v1/search/web");
  }
}

function configuredProviderPayload(
  config: Record<string, unknown>,
  providerId: string,
): Record<string, unknown> {
  const providers = asRecord(config.providers);
  for (const alias of providerAliases(providerId)) {
    const payload = asRecord(providers[alias]);
    if (Object.keys(payload).length > 0) {
      return payload;
    }
  }
  return {};
}

function resolveProviderFromRuntimeConfig(): Partial<ResolvedWebSearchProvider> {
  const document = readRuntimeConfigDocument();
  const config = runtimeWebSearchConfig(document);
  const integrations = asRecord(document.integrations);
  const holabossIntegration = asRecord(integrations.holaboss);
  const providers = asRecord(document.providers);
  const holabossProvider = asRecord(
    providers.holaboss_model_proxy ?? providers.holaboss,
  );
  const runtimePayload = asRecord(document.runtime);
  const holabossAuthToken = firstNonEmptyString(
    holabossIntegration.auth_token as string | undefined,
    holabossProvider.api_key as string | undefined,
    document.auth_token as string | undefined,
    document.model_proxy_api_key as string | undefined,
  );
  const holabossUserId = firstNonEmptyString(
    holabossIntegration.user_id as string | undefined,
    document.user_id as string | undefined,
  );
  const holabossOrgId = firstNonEmptyString(
    holabossIntegration.org_id as string | undefined,
    document.org_id as string | undefined,
  );
  const holabossSandboxId = firstNonEmptyString(
    holabossIntegration.sandbox_id as string | undefined,
    runtimePayload.sandbox_id as string | undefined,
    document.sandbox_id as string | undefined,
  );
  const configuredProviderId = firstNonEmptyString(
    config.provider as string | undefined,
    config.provider_id as string | undefined,
    config.providerId as string | undefined,
    config.default_provider as string | undefined,
  );
  const managedHolabossSearchBinding = hasManagedHolabossSearchBinding(document);
  const selectedProviderId =
    configuredProviderId === HOLABOSS_WEB_SEARCH_PROVIDER_ID
      ? managedHolabossSearchBinding
        ? HOLABOSS_WEB_SEARCH_PROVIDER_ID
        : EXA_WEB_SEARCH_PROVIDER_ID
      : configuredProviderId ||
        (managedHolabossSearchBinding
          ? HOLABOSS_WEB_SEARCH_PROVIDER_ID
          : EXA_WEB_SEARCH_PROVIDER_ID);
  const providerPayload = configuredProviderPayload(config, selectedProviderId);
  const providerKind = normalizeProviderKind(
    firstNonEmptyString(
      providerPayload.kind as string | undefined,
      config.kind as string | undefined,
    ),
    selectedProviderId,
  );

  return {
    providerId: selectedProviderId || providerIdForKind(providerKind),
    kind: providerKind,
    baseUrl: firstNonEmptyString(
      providerPayload.base_url as string | undefined,
      providerPayload.baseURL as string | undefined,
      providerPayload.url as string | undefined,
      config.base_url as string | undefined,
      config.baseURL as string | undefined,
      config.url as string | undefined,
      providerKind === "holaboss_search"
        ? holabossSearchEndpointFromDocument(document)
        : "",
    ),
    apiKey: firstNonEmptyString(
      providerPayload.api_key as string | undefined,
      providerPayload.apiKey as string | undefined,
      providerPayload.auth_token as string | undefined,
      providerPayload.authToken as string | undefined,
      config.api_key as string | undefined,
      config.apiKey as string | undefined,
      providerKind === "holaboss_search"
        ? (holabossIntegration.auth_token as string | undefined)
        : "",
      providerKind === "holaboss_search"
        ? (holabossProvider.api_key as string | undefined)
        : "",
    ),
    userId: providerKind === "holaboss_search" ? holabossUserId : "",
    orgId: providerKind === "holaboss_search" ? holabossOrgId : "",
    sandboxId: providerKind === "holaboss_search" ? holabossSandboxId : "",
  };
}

function resolveWebSearchProvider(
  options: NativeWebSearchProviderOptions = {},
): ResolvedWebSearchProvider {
  const runtimeProvider = resolveProviderFromRuntimeConfig();
  const explicitProviderId = firstNonEmptyString(options.providerId);
  const explicitKind = firstNonEmptyString(options.providerKind);
  const hasExplicitProvider = Boolean(explicitProviderId || explicitKind);
  const providerId =
    explicitProviderId ||
    firstNonEmptyString(runtimeProvider.providerId) ||
    EXA_WEB_SEARCH_PROVIDER_ID;
  const kind = normalizeProviderKind(
    explicitKind || runtimeProvider.kind,
    providerId,
  );
  const shouldUseRuntimeProvider =
    !hasExplicitProvider || runtimeProvider.kind === kind;
  return {
    providerId: providerIdForKind(kind),
    kind,
    baseUrl:
      firstNonEmptyString(
        options.baseUrl,
        shouldUseRuntimeProvider ? runtimeProvider.baseUrl : "",
      ) ||
      (kind === "holaboss_search"
        ? HOLABOSS_WEB_SEARCH_ENDPOINT_URL
        : EXA_WEB_SEARCH_ENDPOINT_URL),
    apiKey: firstNonEmptyString(
      options.apiKey,
      shouldUseRuntimeProvider ? runtimeProvider.apiKey : "",
    ),
    userId: firstNonEmptyString(
      shouldUseRuntimeProvider ? runtimeProvider.userId : "",
    ),
    orgId: firstNonEmptyString(
      shouldUseRuntimeProvider ? runtimeProvider.orgId : "",
    ),
    sandboxId: firstNonEmptyString(
      shouldUseRuntimeProvider ? runtimeProvider.sandboxId : "",
    ),
  };
}

export function parseWebSearchNumResults(params: {
  numResults?: number | null;
  maxResults?: number | null;
}): number {
  const value = Number.isInteger(params.numResults)
    ? params.numResults
    : Number.isInteger(params.maxResults)
      ? params.maxResults
      : DEFAULT_WEB_SEARCH_NUM_RESULTS;
  return Math.max(1, Math.min(MAX_WEB_SEARCH_NUM_RESULTS, Number(value)));
}

export function parseWebSearchQuery(value: unknown): string {
  const query = typeof value === "string" ? value.trim() : "";
  if (!query) {
    throw new Error("query is required");
  }
  return query;
}

export function parseWebSearchLivecrawl(
  value: unknown,
): ExaWebSearchLivecrawlMode {
  return typeof value === "string" && value.trim().toLowerCase() === "preferred"
    ? "preferred"
    : "fallback";
}

export function parseWebSearchType(value: unknown): ExaWebSearchType {
  const normalized =
    typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (normalized) {
    case "fast":
    case "deep":
      return normalized;
    default:
      return "auto";
  }
}

export function parseWebSearchContextMaxCharacters(
  value: unknown,
): number | undefined {
  if (!Number.isInteger(value)) {
    return undefined;
  }
  return Math.max(1, Number(value));
}

export function webSearchDescription(
  baseDescription: string,
  options: NativeWebSearchProviderOptions = {},
): string {
  const currentYear = new Date().getFullYear();
  const provider = resolveWebSearchProvider(options);
  const providerLabel =
    provider.kind === "holaboss_search"
      ? "configured Holaboss Search"
      : provider.apiKey
        ? "configured Exa web search"
        : "hosted Exa web search without authentication";
  return [
    baseDescription,
    `Uses ${providerLabel}.`,
    `The current year is ${currentYear}; include ${currentYear} in recent-information queries.`,
  ].join(" ");
}

function exaMcpEndpointUrl(provider: ResolvedWebSearchProvider): string {
  const url = new URL(provider.baseUrl.trim() || EXA_WEB_SEARCH_ENDPOINT_URL);
  if (!url.pathname.endsWith(EXA_WEB_SEARCH_ENDPOINT)) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${EXA_WEB_SEARCH_ENDPOINT}`;
  }
  if (provider.apiKey) {
    url.searchParams.set("exaApiKey", provider.apiKey);
    if (!url.searchParams.has("tools")) {
      url.searchParams.set("tools", "web_search_exa");
    }
  }
  return url.toString();
}

function createSearchRequest(params: {
  query: string;
  numResults: number;
  livecrawl: ExaWebSearchLivecrawlMode;
  type: ExaWebSearchType;
  contextMaxCharacters?: number;
}): ExaMcpSearchRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query: params.query,
        numResults: params.numResults,
        livecrawl: params.livecrawl,
        type: params.type,
        ...(typeof params.contextMaxCharacters === "number"
          ? { contextMaxCharacters: params.contextMaxCharacters }
          : {}),
      },
    },
  };
}

function requestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
}

function parseSseText(responseText: string): string {
  const lines = responseText.split(/\r?\n/g);
  for (const line of lines) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const payloadText = line.slice(6).trim();
    if (!payloadText) {
      continue;
    }
    const payload = JSON.parse(payloadText) as ExaMcpSseResponse;
    const errorMessage = payload.error?.message?.trim();
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    const text = payload.result?.content
      ?.find(
        (entry) => entry?.type === "text" && typeof entry.text === "string",
      )
      ?.text?.trim();
    if (text) {
      return text;
    }
  }
  return "No search results found. Please try a different query.";
}

function resultTextFromRecord(value: Record<string, unknown>): string {
  return firstNonEmptyString(
    value.text as string | undefined,
    value.summary as string | undefined,
    value.snippet as string | undefined,
    value.highlights as string | undefined,
    value.content as string | undefined,
    value.description as string | undefined,
  );
}

function formatSearchResult(value: unknown, index: number): string {
  if (!isRecord(value)) {
    return String(value ?? "").trim();
  }
  const title = firstNonEmptyString(
    value.title as string | undefined,
    value.name as string | undefined,
    `Result ${index + 1}`,
  );
  const url = firstNonEmptyString(
    value.url as string | undefined,
    value.link as string | undefined,
  );
  const published = firstNonEmptyString(
    value.published as string | undefined,
    value.published_at as string | undefined,
    value.publishedAt as string | undefined,
    value.date as string | undefined,
  );
  const text = resultTextFromRecord(value);
  return [
    `Title: ${title}`,
    url ? `URL: ${url}` : "",
    published ? `Published: ${published}` : "",
    text ? `Highlights:\n${text}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseJsonSearchText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.trim() || "No search results found. Please try a different query.";
  }
  if (!isRecord(payload)) {
    return "No search results found. Please try a different query.";
  }
  const directText = firstNonEmptyString(
    payload.text as string | undefined,
    payload.answer as string | undefined,
    payload.summary as string | undefined,
    payload.content as string | undefined,
  );
  const rawResults =
    (Array.isArray(payload.results) && payload.results) ||
    (Array.isArray(payload.data) && payload.data) ||
    (Array.isArray(payload.items) && payload.items) ||
    [];
  const resultText = rawResults
    .map((entry, index) => formatSearchResult(entry, index))
    .filter(Boolean)
    .join("\n\n");
  if (directText && resultText) {
    return `${directText}\n\n${resultText}`;
  }
  if (directText) {
    return directText;
  }
  if (resultText) {
    return resultText;
  }
  return JSON.stringify(payload, null, 2);
}

async function searchExaHostedMcp(params: {
  provider: ResolvedWebSearchProvider;
  query: string;
  numResults: number;
  livecrawl: ExaWebSearchLivecrawlMode;
  type: ExaWebSearchType;
  contextMaxCharacters?: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs: number;
}): Promise<{ text: string; providerId: string }> {
  const response = await params.fetchImpl(exaMcpEndpointUrl(params.provider), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(
      createSearchRequest({
        query: params.query,
        numResults: params.numResults,
        livecrawl: params.livecrawl,
        type: params.type,
        contextMaxCharacters: params.contextMaxCharacters,
      }),
    ),
    signal: requestSignal(params.signal, params.requestTimeoutMs),
  });

  if (!response.ok) {
    const errorText = (await response.text()).trim();
    throw new Error(
      `web_search failed with status ${response.status}${errorText ? `: ${errorText}` : ""}`,
    );
  }

  return {
    providerId: EXA_WEB_SEARCH_PROVIDER_ID,
    text: parseSseText(await response.text()),
  };
}

async function searchHolaboss(params: {
  provider: ResolvedWebSearchProvider;
  query: string;
  numResults: number;
  livecrawl: ExaWebSearchLivecrawlMode;
  type: ExaWebSearchType;
  contextMaxCharacters?: number;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  requestTimeoutMs: number;
  toolCallId?: string | null;
}): Promise<{ text: string; providerId: string }> {
  // Fail closed: the Holaboss search service meters per user, and its downstream
  // model-proxy call now REQUIRES X-Holaboss-User-Id (the backend rejects
  // unattributed OpenRouter-bound calls). Surface a clear tool error instead of
  // firing a request that would be rejected downstream / go unmetered. (Exa/BYO
  // web search uses searchExa and is unaffected.)
  if (!params.provider.userId) {
    throw new Error(
      "web_search via Holaboss Search requires a signed-in Holaboss account (no user id resolved)",
    );
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (params.provider.apiKey) {
    headers.authorization = `Bearer ${params.provider.apiKey}`;
    headers["x-api-key"] = params.provider.apiKey;
  }
  headers["X-Holaboss-User-Id"] = params.provider.userId;
  if (params.provider.orgId) {
    headers["X-Holaboss-Org-Id"] = params.provider.orgId;
  }
  if (params.provider.sandboxId) {
    headers["X-Holaboss-Sandbox-Id"] = params.provider.sandboxId;
  }
  if (params.toolCallId?.trim()) {
    headers["X-Holaboss-Tool-Call-Id"] = params.toolCallId.trim();
  }
  const response = await params.fetchImpl(params.provider.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: params.query,
      num_results: params.numResults,
      livecrawl: params.livecrawl,
      type: params.type,
      ...(typeof params.contextMaxCharacters === "number"
        ? { context_max_characters: params.contextMaxCharacters }
        : {}),
    }),
    signal: requestSignal(params.signal, params.requestTimeoutMs),
  });

  if (!response.ok) {
    const errorText = (await response.text()).trim();
    throw new Error(
      `web_search failed with status ${response.status}${errorText ? `: ${errorText}` : ""}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text =
    contentType.includes("application/json")
      ? parseJsonSearchText(await response.json())
      : (await response.text()).trim();
  return {
    providerId: HOLABOSS_WEB_SEARCH_PROVIDER_ID,
    text: text || "No search results found. Please try a different query.",
  };
}

export async function searchPublicWeb(
  params: NativeWebSearchParams,
): Promise<{ text: string; providerId: string }> {
  const query = parseWebSearchQuery(params.query);
  const numResults = parseWebSearchNumResults({
    numResults: params.numResults,
    maxResults: params.maxResults,
  });
  const livecrawl = parseWebSearchLivecrawl(params.livecrawl);
  const type = parseWebSearchType(params.type);
  const contextMaxCharacters = parseWebSearchContextMaxCharacters(
    params.contextMaxCharacters,
  );
  const fetchImpl = params.fetchImpl ?? fetch;
  const requestTimeoutMs =
    params.requestTimeoutMs ?? DEFAULT_WEB_SEARCH_TIMEOUT_MS;
  const provider = resolveWebSearchProvider(params);
  const commonParams = {
    provider,
    query,
    numResults,
    livecrawl,
    type,
    contextMaxCharacters,
    fetchImpl,
    signal: params.signal,
    requestTimeoutMs,
    toolCallId: params.toolCallId,
  };
  if (provider.kind === "holaboss_search") {
    return searchHolaboss(commonParams);
  }
  return searchExaHostedMcp(commonParams);
}

export function nativeWebSearchPayload(payload: unknown): {
  query: string;
  numResults: number;
  livecrawl: ExaWebSearchLivecrawlMode;
  type: ExaWebSearchType;
  contextMaxCharacters?: number;
} {
  const params = isRecord(payload) ? payload : {};
  const contextMaxCharacters = parseWebSearchContextMaxCharacters(
    params.context_max_characters,
  );
  return {
    query: parseWebSearchQuery(params.query),
    numResults: parseWebSearchNumResults({
      numResults: Number.isInteger(params.num_results)
        ? Number(params.num_results)
        : null,
      maxResults: Number.isInteger(params.max_results)
        ? Number(params.max_results)
        : null,
    }),
    livecrawl: parseWebSearchLivecrawl(params.livecrawl),
    type: parseWebSearchType(params.type),
    ...(typeof contextMaxCharacters === "number"
      ? { contextMaxCharacters }
      : {}),
  };
}

function webSearchParameters(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query for the public web.",
        minLength: 1,
      },
      num_results: {
        type: "integer",
        description: [
          `Number of search results to return (1-${MAX_WEB_SEARCH_NUM_RESULTS}).`,
          `Defaults to ${DEFAULT_WEB_SEARCH_NUM_RESULTS}.`,
        ].join(" "),
        minimum: 1,
        maximum: MAX_WEB_SEARCH_NUM_RESULTS,
      },
      max_results: {
        type: "integer",
        description: `Compatibility alias for num_results (1-${MAX_WEB_SEARCH_NUM_RESULTS}).`,
        minimum: 1,
        maximum: MAX_WEB_SEARCH_NUM_RESULTS,
      },
      livecrawl: {
        type: "string",
        enum: ["fallback", "preferred"],
        description: "Whether to prefer live crawling or only use it as fallback.",
      },
      type: {
        type: "string",
        enum: ["auto", "fast", "deep"],
        description: "Search depth mode.",
      },
      context_max_characters: {
        type: "integer",
        description: "Maximum number of context characters to request from the search backend.",
        minimum: 1,
      },
    },
    required: ["query"],
    additionalProperties: false,
  };
}

export function createHarnessNativeWebSearchToolDefinition(
  toolId: NativeWebSearchToolId,
  options: HarnessNativeWebSearchToolOptions = {},
): HarnessNativeWebSearchToolDefinitionLike {
  const definition = NATIVE_WEB_SEARCH_TOOL_DEFINITIONS.find((entry) => entry.id === toolId);
  if (!definition) {
    throw new Error(`Unknown web search tool '${toolId}'`);
  }

  const description = webSearchDescription(definition.description, options);
  // Expose under a non-reserved alias (see NATIVE_WEB_SEARCH_EXPOSED_TOOL_NAME):
  // a custom tool literally named `web_search` is stripped by the Anthropic/OpenAI
  // API before the model sees it. `details.tool_id` below keeps the internal id.
  return {
    name: NATIVE_WEB_SEARCH_EXPOSED_TOOL_NAME,
    label: "Web Search",
    description,
    promptSnippet: `${NATIVE_WEB_SEARCH_EXPOSED_TOOL_NAME}: ${description}`,
    parameters: webSearchParameters(),
    execute: async (toolCallId, toolParams, signal) => {
      const payload = nativeWebSearchPayload(toolParams);
      const { text, providerId } = await searchPublicWeb({
        ...payload,
        fetchImpl: options.fetchImpl,
        signal,
        providerId: options.providerId,
        providerKind: options.providerKind,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        requestTimeoutMs: options.requestTimeoutMs,
        toolCallId: typeof toolCallId === "string" ? toolCallId : null,
      });
      return {
        content: [{ type: "text" as const, text }],
        details: {
          tool_id: definition.id,
          provider: providerId,
        },
      };
    },
  };
}

export async function resolveHarnessNativeWebSearchToolDefinitions(
  options: HarnessNativeWebSearchToolOptions = {},
): Promise<HarnessNativeWebSearchToolDefinitionLike[]> {
  return NATIVE_WEB_SEARCH_TOOL_DEFINITIONS.map((definition) =>
    createHarnessNativeWebSearchToolDefinition(definition.id, options),
  );
}
