import fs from "node:fs";

import {
  resolveRuntimeModelClient,
  resolveRuntimeModelReference,
} from "./agent-runtime-config.js";
import { resolveProductRuntimeConfig } from "./runtime-config.js";

/**
 * Video generation model resolution — the video analogue of
 * image-generation-model.ts. v1 routes through the Holaboss model proxy
 * (OpenAI-compatible), defaulting to `bytedance/seedance-2.0`. A model is
 * eligible if its runtime-config entry declares the `video_generation`
 * capability, or it looks like a known text-to-video model.
 */
const HOLABOSS_PROVIDER_ID = "holaboss_model_proxy";
const VIDEO_GENERATION_ALLOWED_PROVIDER_IDS = new Set([
  HOLABOSS_PROVIDER_ID,
  "openai_direct",
]);
const PROVIDER_ID_ALIASES: Record<string, string> = {
  holaboss: HOLABOSS_PROVIDER_ID,
  [HOLABOSS_PROVIDER_ID]: HOLABOSS_PROVIDER_ID,
  openai: "openai_direct",
  openai_direct: "openai_direct",
};
const VIDEO_GENERATION_MODEL_DEFAULTS: Record<string, string | null> = {
  [HOLABOSS_PROVIDER_ID]: "bytedance/seedance-2.0",
  openai_direct: "sora-2",
};
const OPENAI_COMPATIBLE_MODEL_PROXY_PROVIDERS = new Set(["openai_compatible"]);

export interface VideoGenerationModelSelection {
  providerId: string;
  modelId: string | null;
  source: "selected" | "configured" | "default" | "disabled";
}

export interface VideoGenerationModelClient {
  baseUrl: string;
  apiKey: string;
  defaultHeaders: Record<string, string> | null;
  modelId: string;
}

export interface CreateVideoGenerationModelClientParams {
  workspaceId: string;
  sessionId: string;
  inputId: string;
  selectedModel?: string | null;
  defaultProviderId?: string | null;
  explicitProviderId?: string | null;
  runtimeExecModelProxyApiKey?: string | null;
  runtimeExecSandboxId?: string | null;
  runtimeExecRunId?: string | null;
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string {
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

function normalizeVideoGenerationProviderId(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const providerId = PROVIDER_ID_ALIASES[normalized] ?? normalized;
  return VIDEO_GENERATION_ALLOWED_PROVIDER_IDS.has(providerId) ? providerId : "";
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

function providerPayloadForId(
  document: Record<string, unknown>,
  providerId: string,
): Record<string, unknown> {
  const providersPayload = asRecord(document.providers);
  if (providerId === HOLABOSS_PROVIDER_ID) {
    return asRecord(providersPayload[HOLABOSS_PROVIDER_ID] ?? providersPayload.holaboss);
  }
  return asRecord(providersPayload[providerId]);
}

function configuredVideoGenerationSettings(document: Record<string, unknown>): {
  providerId: string;
  modelId: string;
} {
  const runtimeSettings = asRecord(document.runtime);
  const payload = asRecord(
    runtimeSettings.video_generation ?? runtimeSettings.videoGeneration,
  );
  const providerId = normalizeVideoGenerationProviderId(
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

function configuredModelsPayload(document: Record<string, unknown>): Record<string, unknown> {
  return asRecord(document.models);
}

function modelCapabilities(modelPayload: Record<string, unknown>): string[] {
  const capabilities = modelPayload.capabilities;
  if (!Array.isArray(capabilities)) {
    return [];
  }
  return capabilities
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function looksLikeVideoGenerationModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("happyhorse") ||
    normalized.includes("video") ||
    normalized.startsWith("sora") ||
    normalized.includes("/sora") ||
    normalized.startsWith("wan") ||
    normalized.includes("wanx") ||
    normalized.startsWith("veo") ||
    normalized.includes("/veo") ||
    normalized.startsWith("kling") ||
    normalized.includes("seedance") ||
    normalized.includes("text-to-video") ||
    normalized.includes("t2v")
  );
}

function selectedModelSupportsVideoGeneration(params: {
  document: Record<string, unknown>;
  selectedModel: string;
  providerId: string;
  configuredProviderId: string | null;
  modelId: string;
  modelToken: string;
}): boolean {
  const modelsPayload = configuredModelsPayload(params.document);
  const candidateKeys = new Set(
    [
      params.selectedModel,
      params.modelToken,
      `${params.providerId}/${params.modelId}`,
      params.configuredProviderId ? `${params.configuredProviderId}/${params.modelId}` : null,
      params.modelId,
    ]
      .map((value) => (value ?? "").trim())
      .filter(Boolean),
  );
  let sawCapabilities = false;
  for (const key of candidateKeys) {
    const capabilities = modelCapabilities(asRecord(modelsPayload[key]));
    if (capabilities.length === 0) {
      continue;
    }
    sawCapabilities = true;
    if (capabilities.includes("video_generation")) {
      return true;
    }
  }
  if (sawCapabilities) {
    return false;
  }
  return looksLikeVideoGenerationModelId(params.modelId);
}

function selectedVideoGenerationSettings(
  document: Record<string, unknown>,
  runtimeConfig: ReturnType<typeof resolveProductRuntimeConfig>,
  params: { selectedModel?: string | null; defaultProviderId?: string | null },
): { providerId: string; modelId: string } | null {
  const selectedModel = firstNonEmptyString(params.selectedModel);
  if (!selectedModel) {
    return null;
  }
  let resolved;
  try {
    resolved = resolveRuntimeModelReference(
      selectedModel,
      firstNonEmptyString(params.defaultProviderId, runtimeConfig.defaultProvider),
    );
  } catch {
    return null;
  }
  const providerId = normalizeVideoGenerationProviderId(
    resolved.configuredProviderId ?? resolved.providerId,
  );
  const modelId = firstNonEmptyString(resolved.modelId);
  if (!providerId || !modelId) {
    return null;
  }
  if (
    !selectedModelSupportsVideoGeneration({
      document,
      selectedModel,
      providerId: resolved.providerId,
      configuredProviderId: resolved.configuredProviderId,
      modelId,
      modelToken: resolved.modelToken,
    })
  ) {
    return null;
  }
  return { providerId, modelId };
}

function videoGenerationProviderIsAvailable(
  document: Record<string, unknown>,
  providerId: string,
  runtimeConfig: ReturnType<typeof resolveProductRuntimeConfig>,
): boolean {
  const normalizedProviderId = normalizeVideoGenerationProviderId(providerId);
  if (!normalizedProviderId) {
    return false;
  }
  if (normalizedProviderId === HOLABOSS_PROVIDER_ID) {
    return Boolean(
      runtimeConfig.authToken.trim() ||
        runtimeConfig.modelProxyBaseUrl.trim() ||
        Object.keys(providerPayloadForId(document, normalizedProviderId)).length > 0,
    );
  }
  return Object.keys(providerPayloadForId(document, normalizedProviderId)).length > 0;
}

export function defaultVideoGenerationModelForProvider(providerId: string): string | null {
  const normalizedProviderId = normalizeVideoGenerationProviderId(providerId);
  const value = VIDEO_GENERATION_MODEL_DEFAULTS[normalizedProviderId];
  return typeof value === "string" ? value : null;
}

export function resolveVideoGenerationModelSelection(params: {
  selectedModel?: string | null;
  defaultProviderId?: string | null;
  explicitProviderId?: string | null;
}): VideoGenerationModelSelection {
  const runtimeConfig = resolveProductRuntimeConfig({
    requireAuth: false,
    requireUser: false,
    requireBaseUrl: false,
    includeDefaultBaseUrl: false,
  });
  const document = runtimeConfigDocument();

  const selectedSettings = selectedVideoGenerationSettings(document, runtimeConfig, {
    selectedModel: params.selectedModel,
    defaultProviderId: params.defaultProviderId,
  });
  if (selectedSettings) {
    return videoGenerationProviderIsAvailable(document, selectedSettings.providerId, runtimeConfig)
      ? { providerId: selectedSettings.providerId, modelId: selectedSettings.modelId, source: "selected" }
      : { providerId: selectedSettings.providerId, modelId: null, source: "disabled" };
  }

  const configuredSettings = configuredVideoGenerationSettings(document);
  if (configuredSettings.providerId) {
    if (!videoGenerationProviderIsAvailable(document, configuredSettings.providerId, runtimeConfig)) {
      return { providerId: configuredSettings.providerId, modelId: null, source: "disabled" };
    }
    return {
      providerId: configuredSettings.providerId,
      modelId: configuredSettings.modelId || defaultVideoGenerationModelForProvider(configuredSettings.providerId),
      source: configuredSettings.modelId ? "configured" : "default",
    };
  }

  // No explicit/selected/configured video model — fall back to the proxy
  // default (seedance) when the model proxy is available.
  let providerId = normalizeVideoGenerationProviderId(params.explicitProviderId);
  if (!providerId && runtimeConfig.modelProxyBaseUrl.trim()) {
    providerId = HOLABOSS_PROVIDER_ID;
  }
  if (!providerId || !videoGenerationProviderIsAvailable(document, providerId, runtimeConfig)) {
    return { providerId, modelId: null, source: "disabled" };
  }
  const defaultModelId = defaultVideoGenerationModelForProvider(providerId);
  return defaultModelId
    ? { providerId, modelId: defaultModelId, source: "default" }
    : { providerId, modelId: null, source: "disabled" };
}

export function createVideoGenerationModelClient(
  params: CreateVideoGenerationModelClientParams,
): VideoGenerationModelClient | null {
  const runtimeConfig = resolveProductRuntimeConfig({
    requireAuth: false,
    requireUser: false,
    requireBaseUrl: false,
    includeDefaultBaseUrl: false,
  });
  const selection = resolveVideoGenerationModelSelection({
    selectedModel: params.selectedModel,
    defaultProviderId: params.defaultProviderId,
    explicitProviderId: params.explicitProviderId,
  });
  if (!selection.providerId || !selection.modelId) {
    return null;
  }

  let resolved;
  try {
    resolved = resolveRuntimeModelClient({
      selectedModel: `${selection.providerId}/${selection.modelId}`,
      defaultProviderId:
        normalizeVideoGenerationProviderId(
          firstNonEmptyString(
            params.defaultProviderId,
            runtimeConfig.defaultProvider,
            selection.providerId,
          ),
        ) || selection.providerId,
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

  // v1 only supports OpenAI-compatible proxy routing (the same channel the
  // image tool uses). Direct google/openrouter-native video isn't wired yet.
  if (!OPENAI_COMPATIBLE_MODEL_PROXY_PROVIDERS.has(resolved.modelClient.model_proxy_provider)) {
    return null;
  }
  const baseUrl = (resolved.modelClient.base_url ?? "").trim();
  const apiKey = resolved.modelClient.api_key.trim();
  if (!baseUrl || !apiKey) {
    return null;
  }
  return {
    baseUrl,
    apiKey,
    defaultHeaders: resolved.modelClient.default_headers ?? null,
    modelId: resolved.modelId,
  };
}
