import fs from "node:fs";

import { resolveRuntimeModelClient } from "./agent-runtime-config.js";
import { resolveBackgroundTaskModelSelection } from "./background-task-model.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { resolveProductRuntimeConfig } from "./runtime-config.js";

const HOLABOSS_PROVIDER_ID = "holaboss_model_proxy";
const PROVIDER_ID_ALIASES: Record<string, string> = {
  holaboss: HOLABOSS_PROVIDER_ID,
  [HOLABOSS_PROVIDER_ID]: HOLABOSS_PROVIDER_ID,
  openai: "openai_direct",
  openai_direct: "openai_direct",
  anthropic: "anthropic_direct",
  anthropic_direct: "anthropic_direct",
  openrouter: "openrouter_direct",
  openrouter_direct: "openrouter_direct",
  gemini: "gemini_direct",
  google: "gemini_direct",
  gemini_direct: "gemini_direct",
  ollama: "ollama_direct",
  ollama_direct: "ollama_direct",
  minimax: "minimax_direct",
  minimax_direct: "minimax_direct",
};
const RECALL_EMBEDDING_MODEL_DEFAULTS: Record<string, string | null> = {
  [HOLABOSS_PROVIDER_ID]: "text-embedding-3-small",
  openai_direct: "text-embedding-3-small",
  openrouter_direct: "openai/text-embedding-3-small",
  anthropic_direct: null,
  gemini_direct: null,
  ollama_direct: null,
  minimax_direct: null,
};
const OPENAI_COMPATIBLE_MODEL_PROXY_PROVIDERS = new Set([
  "openai_compatible",
  "google_compatible",
]);

function firstNonEmptyString(
  ...values: Array<string | null | undefined>
): string {
  for (const value of values) {
    const normalized = (value ?? "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeProviderId(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return PROVIDER_ID_ALIASES[normalized] ?? normalized;
}

function runtimeConfigDocument(): Record<string, unknown> {
  const runtimeConfig = resolveProductRuntimeConfig({
    requireAuth: false,
    requireUser: false,
    requireBaseUrl: false,
    includeDefaultBaseUrl: false,
  });
  const configPath = runtimeConfig.configPath?.trim() ?? "";
  if (!configPath || !fs.existsSync(configPath)) {
    return {};
  }
  try {
    return asRecord(JSON.parse(fs.readFileSync(configPath, "utf8")));
  } catch {
    return {};
  }
}

function runtimePayload(
  document: Record<string, unknown>,
): Record<string, unknown> {
  return asRecord(document.runtime);
}

function configuredProviderIds(document: Record<string, unknown>): string[] {
  const providers = asRecord(document.providers);
  return Object.keys(providers)
    .map((providerId) => normalizeProviderId(providerId))
    .filter(Boolean);
}

function firstEmbeddingCapableProvider(
  candidateIds: Array<string | null | undefined>,
): string {
  for (const candidateId of candidateIds) {
    const normalized = normalizeProviderId(candidateId);
    if (!normalized) {
      continue;
    }
    if (defaultRecallEmbeddingModelForProvider(normalized)) {
      return normalized;
    }
  }
  return "";
}

function configuredRecallEmbeddingSettings(document: Record<string, unknown>): {
  providerId: string;
  modelId: string;
} {
  const runtimeSettings = runtimePayload(document);
  const payload = asRecord(
    runtimeSettings.recall_embeddings ?? runtimeSettings.recallEmbeddings,
  );
  const providerId = normalizeProviderId(
    firstNonEmptyString(
      payload.provider as string | undefined,
      payload.provider_id as string | undefined,
      payload.providerId as string | undefined,
    ),
  );
  return {
    providerId,
    modelId: firstNonEmptyString(
      payload.model as string | undefined,
      payload.model_id as string | undefined,
      payload.modelId as string | undefined,
    ),
  };
}

export function defaultRecallEmbeddingModelForProvider(
  providerId: string,
): string | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  const value = RECALL_EMBEDDING_MODEL_DEFAULTS[normalizedProviderId];
  return typeof value === "string" ? value : null;
}

export function createRecallEmbeddingModelClient(params: {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  selectedModel?: string | null;
  defaultProviderId?: string | null;
  explicitProviderId?: string | null;
  runtimeExecModelProxyApiKey?: string | null;
  runtimeExecSandboxId?: string | null;
  runtimeExecRunId?: string | null;
}): MemoryModelClientConfig | null {
  const runtimeConfig = resolveProductRuntimeConfig({
    requireAuth: false,
    requireUser: false,
    requireBaseUrl: false,
    includeDefaultBaseUrl: false,
  });
  const document = runtimeConfigDocument();
  const configured = configuredRecallEmbeddingSettings(document);
  const backgroundSelection = resolveBackgroundTaskModelSelection({
    selectedModel: params.selectedModel,
    defaultProviderId: params.defaultProviderId,
    explicitProviderId: params.explicitProviderId,
  });
  const providerId =
    normalizeProviderId(configured.providerId) ||
    firstEmbeddingCapableProvider([
      params.explicitProviderId,
      backgroundSelection.providerId,
      params.defaultProviderId,
      ...configuredProviderIds(document),
    ]);
  const modelId =
    firstNonEmptyString(configured.modelId) ||
    defaultRecallEmbeddingModelForProvider(providerId);
  if (!providerId || !modelId) {
    return null;
  }
  let resolved;
  try {
    resolved = resolveRuntimeModelClient({
      selectedModel: `${providerId}/${modelId}`,
      defaultProviderId:
        normalizeProviderId(
          firstNonEmptyString(params.defaultProviderId, providerId),
        ) || providerId,
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      inputId: params.inputId,
      runtimeExecModelProxyApiKey: firstNonEmptyString(
        params.runtimeExecModelProxyApiKey,
        runtimeConfig.authToken,
      ),
      runtimeExecSandboxId: firstNonEmptyString(
        params.runtimeExecSandboxId,
        runtimeConfig.sandboxId,
      ),
      runtimeExecRunId: params.runtimeExecRunId ?? null,
    });
  } catch {
    return null;
  }
  const baseUrl = (resolved.modelClient.base_url ?? "").trim();
  const apiKey = resolved.modelClient.api_key.trim();
  if (
    !baseUrl ||
    !apiKey ||
    !OPENAI_COMPATIBLE_MODEL_PROXY_PROVIDERS.has(
      resolved.modelClient.model_proxy_provider,
    )
  ) {
    return null;
  }
  return {
    baseUrl,
    apiKey,
    defaultHeaders: resolved.modelClient.default_headers ?? null,
    modelId: resolved.modelId,
    apiStyle: "openai_compatible",
  };
}
