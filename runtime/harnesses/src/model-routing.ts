export type HarnessModelApi =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "google-generative-ai"
  | "anthropic-messages";

export type HarnessThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export type HarnessRequestedThinkingLevel = HarnessThinkingLevel | "off";
export type HarnessThinkingBudgetLevel = Exclude<HarnessThinkingLevel, "xhigh">;

export interface HarnessThinkingSelection {
  rawValue: string | null;
  level: HarnessRequestedThinkingLevel | null;
  thinkingBudgets?: Partial<Record<HarnessThinkingBudgetLevel, number>>;
}

export interface HarnessModelBudget {
  contextWindow: number;
  maxTokens: number;
}

export interface HarnessModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface HarnessOpenAiCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  reasoningEffortMap?: Partial<Record<HarnessThinkingLevel, string>>;
}

export interface HarnessCatalogModelEntry {
  contextWindow?: unknown;
  maxTokens?: unknown;
  cost?: {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
  };
}

export interface HarnessModelClientConfig {
  model_proxy_provider: string;
  api_key: string;
  base_url?: string | null;
  default_headers?: Record<string, string> | null;
}

export interface HarnessModelRoutingRequest {
  provider_id: string;
  model_id: string;
  thinking_value?: string | null;
  model_client: HarnessModelClientConfig;
}

export interface HarnessResolvedModelProfile {
  api: HarnessModelApi;
  baseUrl: string;
  authHeader: boolean;
  headers?: Record<string, string>;
  compat?: HarnessOpenAiCompat;
  reasoning: boolean;
  requestedThinkingLevel: HarnessRequestedThinkingLevel | null;
  requestedThinkingBudgets?: Partial<Record<HarnessThinkingBudgetLevel, number>>;
  input: Array<"text" | "image">;
  cost: HarnessModelCost;
  budget: HarnessModelBudget;
}

const DEFAULT_FALLBACK_CONTEXT_WINDOW = 65_536;
const DEFAULT_FALLBACK_MAX_TOKENS = 128_000;
const UNIFORM_MODEL_MAX_TOKENS = 128_000;

function firstNonEmptyString(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = (value ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeHarnessModelId(modelId: string): string {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedModelId) {
    return "";
  }
  if (normalizedModelId.startsWith("openai/")) {
    return normalizedModelId.slice("openai/".length);
  }
  if (normalizedModelId.startsWith("holaboss_model_proxy/")) {
    return normalizedModelId.slice("holaboss_model_proxy/".length);
  }
  return normalizedModelId;
}

function isOpenAiGpt5Model(modelId: string): boolean {
  return /^gpt-5(?:[.-]|$)/.test(modelId);
}

function shouldUseNativeGoogleProvider(request: HarnessModelRoutingRequest): boolean {
  const normalizedProvider = request.model_client.model_proxy_provider.trim().toLowerCase();
  const providerId = request.provider_id.trim().toLowerCase();
  return normalizedProvider === "google_compatible" && providerId === "gemini_direct";
}

function shouldUseOpenAiCodexResponsesProvider(request: HarnessModelRoutingRequest): boolean {
  const normalizedProvider = request.model_client.model_proxy_provider.trim().toLowerCase();
  const providerId = request.provider_id.trim().toLowerCase();
  return normalizedProvider === "openai_compatible" && providerId === "openai_codex";
}

function shouldUseOpenAiResponsesProvider(request: HarnessModelRoutingRequest): boolean {
  const normalizedProvider = request.model_client.model_proxy_provider.trim().toLowerCase();
  const providerId = request.provider_id.trim().toLowerCase();
  if (normalizedProvider !== "openai_compatible") {
    return false;
  }
  if (
    providerId !== "openai_direct" &&
    providerId !== "openai" &&
    providerId !== "holaboss_model_proxy" &&
    providerId !== "holaboss"
  ) {
    return false;
  }
  return isOpenAiGpt5Model(normalizeHarnessModelId(request.model_id));
}

export function resolveHarnessModelApi(request: HarnessModelRoutingRequest): HarnessModelApi {
  const normalizedProvider = request.model_client.model_proxy_provider.trim().toLowerCase();
  if (normalizedProvider === "anthropic_native") {
    return "anthropic-messages";
  }
  if (shouldUseNativeGoogleProvider(request)) {
    return "google-generative-ai";
  }
  if (shouldUseOpenAiCodexResponsesProvider(request)) {
    return "openai-codex-responses";
  }
  if (shouldUseOpenAiResponsesProvider(request)) {
    return "openai-responses";
  }
  return "openai-completions";
}

function googleGenerativeAiBaseUrlForRequest(request: HarnessModelRoutingRequest): string {
  const baseUrl = firstNonEmptyString(request.model_client.base_url);
  const normalized = baseUrl ? baseUrl.replace(/\/+$/, "") : "";
  if (!normalized) {
    return "https://generativelanguage.googleapis.com/v1beta";
  }
  return normalized.replace(/\/openai$/i, "") || "https://generativelanguage.googleapis.com/v1beta";
}

function anthropicBaseUrlForRequest(request: HarnessModelRoutingRequest): string {
  const baseUrl = firstNonEmptyString(request.model_client.base_url);
  const normalized = baseUrl ? baseUrl.replace(/\/+$/, "") : "";
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\/v1$/i, "");
}

function numericThinkingLevel(value: number): HarnessThinkingBudgetLevel | "off" {
  if (value === 0) {
    return "off";
  }
  if (value < 0) {
    return "high";
  }
  if (value <= 1024) {
    return "minimal";
  }
  if (value <= 4096) {
    return "low";
  }
  if (value <= 12288) {
    return "medium";
  }
  return "high";
}

function harnessThinkingSelection(thinkingValue: string | null | undefined): HarnessThinkingSelection {
  const rawValue = thinkingValue?.trim() ?? "";
  const normalizedValue = rawValue.toLowerCase();
  if (!normalizedValue) {
    return {
      rawValue: null,
      level: null,
    };
  }
  if (normalizedValue === "off" || normalizedValue === "none" || normalizedValue === "false") {
    return {
      rawValue,
      level: "off",
    };
  }
  if (
    normalizedValue === "minimal" ||
    normalizedValue === "low" ||
    normalizedValue === "medium" ||
    normalizedValue === "high" ||
    normalizedValue === "xhigh"
  ) {
    return {
      rawValue,
      level: normalizedValue,
    };
  }
  if (normalizedValue === "max") {
    return {
      rawValue,
      level: "xhigh",
    };
  }
  if (normalizedValue === "default") {
    return {
      rawValue,
      level: "low",
    };
  }
  if (normalizedValue === "true" || normalizedValue === "enabled") {
    return {
      rawValue,
      level: "medium",
    };
  }
  const numericValue = Number(normalizedValue);
  if (!Number.isFinite(numericValue)) {
    return {
      rawValue,
      level: null,
    };
  }
  const level = numericThinkingLevel(numericValue);
  if (level === "off") {
    return {
      rawValue,
      level,
    };
  }
  return {
    rawValue,
    level,
    thinkingBudgets: {
      [level]: numericValue,
    },
  };
}

export function requestedHarnessThinkingLevel(
  request: Pick<HarnessModelRoutingRequest, "thinking_value">,
): HarnessRequestedThinkingLevel | null {
  return harnessThinkingSelection(request.thinking_value).level;
}

export function requestedHarnessThinkingBudgets(
  request: Pick<HarnessModelRoutingRequest, "thinking_value">,
): Partial<Record<HarnessThinkingBudgetLevel, number>> | undefined {
  const selection = harnessThinkingSelection(request.thinking_value);
  return selection.thinkingBudgets ? { ...selection.thinkingBudgets } : undefined;
}

export function requestedHarnessThinkingConfig(
  request: Pick<HarnessModelRoutingRequest, "thinking_value">,
): HarnessThinkingSelection {
  const selection = harnessThinkingSelection(request.thinking_value);
  return {
    rawValue: selection.rawValue,
    level: selection.level,
    ...(selection.thinkingBudgets ? { thinkingBudgets: { ...selection.thinkingBudgets } } : {}),
  };
}

function openAiCompatForThinkingSelection(
  selection: HarnessThinkingSelection,
): HarnessOpenAiCompat | undefined {
  if (!selection.rawValue || !selection.level || selection.level === "off") {
    return undefined;
  }
  const normalizedLevel = selection.level.toLowerCase();
  const normalizedRawValue = selection.rawValue.trim().toLowerCase();
  if (normalizedRawValue === normalizedLevel || Number.isFinite(Number(normalizedRawValue))) {
    return undefined;
  }
  return {
    reasoningEffortMap: {
      [selection.level]: selection.rawValue,
    },
  };
}

function requestedOpenAiCompat(
  request: Pick<HarnessModelRoutingRequest, "thinking_value">,
): HarnessOpenAiCompat | undefined {
  return openAiCompatForThinkingSelection(harnessThinkingSelection(request.thinking_value));
}

function openAiCompatForRequest(request: HarnessModelRoutingRequest): HarnessOpenAiCompat | undefined {
  const modelProxyProvider = request.model_client.model_proxy_provider.trim().toLowerCase();
  const providerId = request.provider_id.trim().toLowerCase();
  const baseUrl = firstNonEmptyString(request.model_client.base_url)?.toLowerCase() ?? "";
  if (providerId.includes("ollama") || baseUrl.includes("localhost:11434") || baseUrl.includes("ollama")) {
    return {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    };
  }
  if (
    modelProxyProvider === "google_compatible" ||
    providerId.includes("gemini") ||
    providerId.includes("google") ||
    baseUrl.includes("generativelanguage.googleapis.com")
  ) {
    return {
      supportsStore: false,
    };
  }
  return undefined;
}

function mergeOpenAiCompat(
  base: HarnessOpenAiCompat | undefined,
  extra: HarnessOpenAiCompat | undefined,
): HarnessOpenAiCompat | undefined {
  if (!base) {
    return extra;
  }
  if (!extra) {
    return base;
  }
  return {
    ...base,
    ...extra,
    ...(base.reasoningEffortMap || extra.reasoningEffortMap
      ? {
          reasoningEffortMap: {
            ...(base.reasoningEffortMap ?? {}),
            ...(extra.reasoningEffortMap ?? {}),
          },
        }
      : {}),
  };
}

function inputModalitiesForRequest(request: HarnessModelRoutingRequest): Array<"text" | "image"> {
  const providerId = request.provider_id.trim().toLowerCase();
  const modelId = request.model_id.trim().toLowerCase();
  if (
    providerId.includes("ollama") ||
    providerId.includes("minimax") ||
    modelId.startsWith("llama") ||
    modelId.startsWith("qwen3:") ||
    modelId.startsWith("gpt-oss:")
  ) {
    return ["text"];
  }
  return ["text", "image"];
}

function knownModelBudgetOverride(
  request: Pick<HarnessModelRoutingRequest, "model_id">,
  api: HarnessModelApi,
): HarnessModelBudget | null {
  const normalizedModelId = normalizeHarnessModelId(request.model_id);
  if (api !== "openai-responses" && api !== "openai-codex-responses") {
    return null;
  }
  if (api === "openai-codex-responses") {
    switch (normalizedModelId) {
      case "gpt-5.5":
      case "gpt-5.3-codex":
        return {
          contextWindow: 400_000,
          maxTokens: 128_000,
        };
      case "gpt-5.4":
      case "gpt-5.4-pro":
        return {
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        };
      default:
        return null;
    }
  }
  switch (normalizedModelId) {
    case "gpt-5.5":
      return {
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4":
    case "gpt-5.4-pro":
      return {
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      };
    case "gpt-5.4-mini":
    case "gpt-5.4-nano":
      return {
        contextWindow: 400_000,
        maxTokens: 128_000,
      };
    default:
      return null;
  }
}

function catalogProviderCandidatesForRequest(
  request: HarnessModelRoutingRequest,
  api: HarnessModelApi,
  modelCatalog: Record<string, Record<string, HarnessCatalogModelEntry>>,
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null | undefined) => {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (!normalized || seen.has(normalized) || !(normalized in modelCatalog)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  const providerId = request.provider_id.trim().toLowerCase();
  const modelProxyProvider = request.model_client.model_proxy_provider.trim().toLowerCase();
  const baseUrl = firstNonEmptyString(request.model_client.base_url)?.toLowerCase() ?? "";

  push(providerId);
  if (providerId.endsWith("_direct")) {
    push(providerId.slice(0, -"_direct".length));
  }
  if (providerId === "gemini_direct") {
    push("google");
  }
  if (providerId === "openai_codex") {
    push("openai-codex");
  }
  if (providerId.includes("openrouter") || baseUrl.includes("openrouter.ai")) {
    push("openrouter");
  }
  if (api === "openai-responses") {
    push("openai");
  }
  if (api === "openai-codex-responses") {
    push("openai-codex");
  }
  if (modelProxyProvider === "anthropic_native") {
    push("anthropic");
  }
  if (modelProxyProvider === "google_compatible") {
    push("google");
  }

  return candidates;
}

function catalogModelIdCandidates(request: Pick<HarnessModelRoutingRequest, "model_id">): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  push(request.model_id);
  push(normalizeHarnessModelId(request.model_id));
  return candidates;
}

function modelBudgetFromCatalogEntry(entry: {
  contextWindow?: unknown;
  maxTokens?: unknown;
} | null | undefined): HarnessModelBudget | null {
  if (
    typeof entry?.contextWindow !== "number" ||
    !Number.isFinite(entry.contextWindow) ||
    entry.contextWindow <= 0 ||
    typeof entry.maxTokens !== "number" ||
    !Number.isFinite(entry.maxTokens) ||
    entry.maxTokens <= 0
  ) {
    return null;
  }
  return {
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

function modelCostFromCatalogEntry(entry: HarnessCatalogModelEntry | null | undefined): HarnessModelCost | null {
  if (
    typeof entry?.cost?.input !== "number" ||
    !Number.isFinite(entry.cost.input) ||
    entry.cost.input < 0 ||
    typeof entry.cost.output !== "number" ||
    !Number.isFinite(entry.cost.output) ||
    entry.cost.output < 0 ||
    typeof entry.cost.cacheRead !== "number" ||
    !Number.isFinite(entry.cost.cacheRead) ||
    entry.cost.cacheRead < 0 ||
    typeof entry.cost.cacheWrite !== "number" ||
    !Number.isFinite(entry.cost.cacheWrite) ||
    entry.cost.cacheWrite < 0
  ) {
    return null;
  }
  return {
    input: entry.cost.input,
    output: entry.cost.output,
    cacheRead: entry.cost.cacheRead,
    cacheWrite: entry.cost.cacheWrite,
  };
}

function catalogModelBudgetForRequest(params: {
  request: HarnessModelRoutingRequest;
  api: HarnessModelApi;
  modelCatalog: Record<string, Record<string, HarnessCatalogModelEntry>>;
}): HarnessModelBudget | null {
  const providerCandidates = catalogProviderCandidatesForRequest(params.request, params.api, params.modelCatalog);
  const modelIdCandidates = catalogModelIdCandidates(params.request);

  for (const provider of providerCandidates) {
    for (const modelId of modelIdCandidates) {
      const matched = modelBudgetFromCatalogEntry(params.modelCatalog[provider]?.[modelId]);
      if (matched) {
        return matched;
      }
    }
  }

  const globalMatches = new Map<string, HarnessModelBudget>();
  for (const provider of Object.keys(params.modelCatalog)) {
    for (const modelId of modelIdCandidates) {
      const matched = modelBudgetFromCatalogEntry(params.modelCatalog[provider]?.[modelId]);
      if (!matched) {
        continue;
      }
      globalMatches.set(`${matched.contextWindow}:${matched.maxTokens}`, matched);
    }
  }

  return globalMatches.size === 1 ? Array.from(globalMatches.values())[0] ?? null : null;
}

function catalogModelCostForRequest(params: {
  request: HarnessModelRoutingRequest;
  api: HarnessModelApi;
  modelCatalog: Record<string, Record<string, HarnessCatalogModelEntry>>;
}): HarnessModelCost | null {
  const providerCandidates = catalogProviderCandidatesForRequest(params.request, params.api, params.modelCatalog);
  const modelIdCandidates = catalogModelIdCandidates(params.request);

  for (const provider of providerCandidates) {
    for (const modelId of modelIdCandidates) {
      const matched = modelCostFromCatalogEntry(params.modelCatalog[provider]?.[modelId]);
      if (matched) {
        return matched;
      }
    }
  }

  const globalMatches = new Map<string, HarnessModelCost>();
  for (const provider of Object.keys(params.modelCatalog)) {
    for (const modelId of modelIdCandidates) {
      const matched = modelCostFromCatalogEntry(params.modelCatalog[provider]?.[modelId]);
      if (!matched) {
        continue;
      }
      globalMatches.set(
        `${matched.input}:${matched.output}:${matched.cacheRead}:${matched.cacheWrite}`,
        matched,
      );
    }
  }

  return globalMatches.size === 1 ? Array.from(globalMatches.values())[0] ?? null : null;
}

export function resolveHarnessModelBudget(
  request: HarnessModelRoutingRequest,
  options: {
    modelCatalog: Record<string, Record<string, HarnessCatalogModelEntry>>;
    fallbackBudget?: HarnessModelBudget;
  },
): HarnessModelBudget {
  const api = resolveHarnessModelApi(request);
  const budget =
    knownModelBudgetOverride(request, api) ??
    catalogModelBudgetForRequest({
      request,
      api,
      modelCatalog: options.modelCatalog,
    }) ??
    options.fallbackBudget ?? {
      contextWindow: DEFAULT_FALLBACK_CONTEXT_WINDOW,
      maxTokens: DEFAULT_FALLBACK_MAX_TOKENS,
    };

  return {
    ...budget,
    // Keep provider registration on a uniform completion budget even when
    // catalog entries advertise smaller per-model output caps.
    maxTokens: UNIFORM_MODEL_MAX_TOKENS,
  };
}

export function resolveHarnessModelProfile(
  request: HarnessModelRoutingRequest,
  options: {
    modelCatalog: Record<string, Record<string, HarnessCatalogModelEntry>>;
    fallbackBudget?: HarnessModelBudget;
  },
): HarnessResolvedModelProfile {
  const headers = stringHeaders(request.model_client.default_headers);
  const hasExplicitAuthHeader = Object.keys(headers ?? {}).some((headerName) => {
    const normalizedHeaderName = headerName.trim().toLowerCase();
    return normalizedHeaderName === "x-api-key" || normalizedHeaderName === "authorization";
  });
  const api = resolveHarnessModelApi(request);
  const baseUrl =
    api === "google-generative-ai"
      ? googleGenerativeAiBaseUrlForRequest(request)
      : api === "anthropic-messages"
        ? anthropicBaseUrlForRequest(request)
        : firstNonEmptyString(request.model_client.base_url);
  if (!baseUrl) {
    throw new Error(`Pi provider ${request.provider_id} is missing a model client base URL`);
  }

  const compat = api === "openai-completions" ? openAiCompatForRequest(request) : undefined;
  const requestedThinkingLevel = requestedHarnessThinkingLevel(request);
  const requestedThinkingBudgets = requestedHarnessThinkingBudgets(request);
  const requestedCompat = api === "openai-completions" ? requestedOpenAiCompat(request) : undefined;
  const budget = resolveHarnessModelBudget(request, options);
  const cost =
    catalogModelCostForRequest({
      request,
      api,
      modelCatalog: options.modelCatalog,
    }) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };

  return {
    api,
    baseUrl,
    authHeader: api !== "google-generative-ai" && !hasExplicitAuthHeader,
    ...(headers ? { headers } : {}),
    ...(compat || requestedCompat ? { compat: mergeOpenAiCompat(compat, requestedCompat) } : {}),
    reasoning: requestedThinkingLevel !== null,
    requestedThinkingLevel,
    ...(requestedThinkingBudgets ? { requestedThinkingBudgets } : {}),
    input: inputModalitiesForRequest(request),
    cost,
    budget,
  };
}
