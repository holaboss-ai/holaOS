import fs from "node:fs";

import {
  resolveRuntimeModelClient,
  resolveRuntimeModelReference,
} from "./agent-runtime-config.js";
import type { MemoryModelClientConfig } from "./memory-model-client.js";
import { resolveProductRuntimeConfig } from "./runtime-config.js";

const HOLABOSS_PROVIDER_ID = "holaboss_model_proxy";
const PROVIDER_ID_ALIASES: Record<string, string> = {
  holaboss: HOLABOSS_PROVIDER_ID,
  [HOLABOSS_PROVIDER_ID]: HOLABOSS_PROVIDER_ID,
  openai: "openai_direct",
  anthropic: "anthropic_direct",
  openrouter: "openrouter_direct",
  gemini: "gemini_direct",
  google: "gemini_direct",
  ollama: "ollama_direct",
  minimax: "minimax_direct",
};
const LEGACY_DIRECT_PROVIDER_MODEL_ALIASES: Record<
  string,
  Record<string, string>
> = {
  anthropic_direct: {
    "claude-sonnet-4-5": "claude-sonnet-4-6",
  },
  gemini_direct: {
    "gemini-3.1-pro-preview": "gemini-2.5-pro",
    "gemini-2.5-flash-lite": "gemini-2.5-flash",
    "gemini-3.1-flash-lite-preview": "gemini-2.5-flash",
  },
};
const BACKGROUND_TASK_MODEL_DEFAULTS: Record<string, string | null> = {
  [HOLABOSS_PROVIDER_ID]: "gpt-5.4",
  openai_direct: "gpt-5.4",
  anthropic_direct: "claude-sonnet-4-6",
  openrouter_direct: "openai/gpt-5.4",
  gemini_direct: "gemini-2.5-flash",
  ollama_direct: null,
  minimax_direct: "MiniMax-M2.7",
};

export interface BackgroundTaskModelSelection {
  providerId: string;
  modelId: string | null;
  source: "configured" | "default" | "disabled";
}

export interface CreateBackgroundTaskMemoryModelClientParams {
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

function normalizeBackgroundProviderId(
  value: string | null | undefined,
): string {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return PROVIDER_ID_ALIASES[normalized] ?? normalized;
}

function normalizeBackgroundModelId(
  providerId: string,
  value: string | null | undefined,
): string {
  const normalizedProviderId = normalizeBackgroundProviderId(providerId);
  const normalizedValue = (value ?? "").trim();
  if (!normalizedProviderId || !normalizedValue) {
    return normalizedValue;
  }
  return (
    LEGACY_DIRECT_PROVIDER_MODEL_ALIASES[normalizedProviderId]?.[
      normalizedValue
    ] ?? normalizedValue
  );
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
    return asRecord(
      providersPayload[HOLABOSS_PROVIDER_ID] ?? providersPayload.holaboss,
    );
  }
  return asRecord(providersPayload[providerId]);
}

function runtimePayload(
  document: Record<string, unknown>,
): Record<string, unknown> {
  return asRecord(document.runtime);
}

function configuredBackgroundTaskSettings(document: Record<string, unknown>): {
  providerId: string;
  modelId: string;
} {
  const runtimeSettings = runtimePayload(document);
  const backgroundTasksPayload = asRecord(
    runtimeSettings.background_tasks ?? runtimeSettings.backgroundTasks,
  );
  const providerId = normalizeBackgroundProviderId(
    firstNonEmptyString(
      backgroundTasksPayload.provider as string | undefined,
      backgroundTasksPayload.provider_id as string | undefined,
      backgroundTasksPayload.providerId as string | undefined,
    ),
  );
  return {
    providerId,
    modelId: normalizeBackgroundModelId(
      providerId,
      firstNonEmptyString(
        backgroundTasksPayload.model as string | undefined,
        backgroundTasksPayload.model_id as string | undefined,
        backgroundTasksPayload.modelId as string | undefined,
      ),
    ),
  };
}

function configuredBackgroundModelForProvider(
  document: Record<string, unknown>,
  providerId: string,
): string {
  const providerPayload = providerPayloadForId(document, providerId);
  const optionsPayload = asRecord(providerPayload.options);
  return firstNonEmptyString(
    providerPayload.background_model as string | undefined,
    providerPayload.backgroundModel as string | undefined,
    optionsPayload.background_model as string | undefined,
    optionsPayload.backgroundModel as string | undefined,
  );
}

function backgroundProviderIsAvailable(
  document: Record<string, unknown>,
  providerId: string,
  runtimeConfig: ReturnType<typeof resolveProductRuntimeConfig>,
): boolean {
  const normalizedProviderId = normalizeBackgroundProviderId(providerId);
  if (!normalizedProviderId) {
    return false;
  }
  if (normalizedProviderId === HOLABOSS_PROVIDER_ID) {
    return Boolean(
      runtimeConfig.authToken.trim() ||
      runtimeConfig.modelProxyBaseUrl.trim() ||
      Object.keys(providerPayloadForId(document, normalizedProviderId)).length >
        0,
    );
  }
  return (
    Object.keys(providerPayloadForId(document, normalizedProviderId)).length > 0
  );
}

export function defaultBackgroundTaskModelForProvider(
  providerId: string,
): string | null {
  const normalizedProviderId = normalizeBackgroundProviderId(providerId);
  const value = BACKGROUND_TASK_MODEL_DEFAULTS[normalizedProviderId];
  return typeof value === "string"
    ? normalizeBackgroundModelId(normalizedProviderId, value)
    : null;
}

export function resolveBackgroundTaskModelSelection(params: {
  selectedModel?: string | null;
  defaultProviderId?: string | null;
  explicitProviderId?: string | null;
}): BackgroundTaskModelSelection {
  const runtimeConfig = resolveProductRuntimeConfig({
    requireAuth: false,
    requireUser: false,
    requireBaseUrl: false,
    includeDefaultBaseUrl: false,
  });
  const document = runtimeConfigDocument();
  const configuredSettings = configuredBackgroundTaskSettings(document);
  if (configuredSettings.providerId) {
    if (
      !backgroundProviderIsAvailable(
        document,
        configuredSettings.providerId,
        runtimeConfig,
      )
    ) {
      return {
        providerId: configuredSettings.providerId,
        modelId: null,
        source: "disabled",
      };
    }
    return {
      providerId: configuredSettings.providerId,
      modelId: configuredSettings.modelId || null,
      source: configuredSettings.modelId ? "configured" : "disabled",
    };
  }

  const defaultProviderId = normalizeBackgroundProviderId(
    firstNonEmptyString(
      params.defaultProviderId,
      runtimeConfig.defaultProvider,
    ),
  );
  let providerId = normalizeBackgroundProviderId(params.explicitProviderId);
  if (!providerId) {
    const selectedModel = firstNonEmptyString(
      params.selectedModel,
      runtimeConfig.defaultModel,
    );
    if (selectedModel) {
      try {
        const resolved = resolveRuntimeModelReference(
          selectedModel,
          defaultProviderId || runtimeConfig.defaultProvider,
        );
        const resolvedProviderId =
          resolved.configuredProviderId ??
          (defaultProviderId === HOLABOSS_PROVIDER_ID &&
          selectedModel.includes("/")
            ? HOLABOSS_PROVIDER_ID
            : resolved.providerId);
        providerId = normalizeBackgroundProviderId(resolvedProviderId);
      } catch {
        providerId = "";
      }
    }
  }
  if (!providerId) {
    providerId = defaultProviderId;
  }
  if (!providerId && runtimeConfig.modelProxyBaseUrl.trim()) {
    providerId = HOLABOSS_PROVIDER_ID;
  }

  if (!backgroundProviderIsAvailable(document, providerId, runtimeConfig)) {
    return {
      providerId,
      modelId: null,
      source: "disabled",
    };
  }

  const configuredModelId = normalizeBackgroundModelId(
    providerId,
    configuredBackgroundModelForProvider(document, providerId),
  );
  if (configuredModelId) {
    return {
      providerId,
      modelId: configuredModelId,
      source: "configured",
    };
  }

  return {
    providerId,
    modelId: null,
    source: "disabled",
  };
}

export function createBackgroundTaskMemoryModelClient(
  params: CreateBackgroundTaskMemoryModelClientParams,
): MemoryModelClientConfig | null {
  const runtimeConfig = resolveProductRuntimeConfig({
    requireAuth: false,
    requireUser: false,
    requireBaseUrl: false,
    includeDefaultBaseUrl: false,
  });
  const selection = resolveBackgroundTaskModelSelection({
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
        normalizeBackgroundProviderId(
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
    apiStyle:
      resolved.modelClient.model_proxy_provider === "anthropic_native"
        ? "anthropic_native"
        : "openai_compatible",
  };
}
