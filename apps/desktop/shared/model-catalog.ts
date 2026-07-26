export type ModelCatalogInputModality = "text" | "image" | "audio" | "video";

export interface ModelCatalogEntry {
  model_id: string;
  label?: string;
  reasoning: boolean;
  thinking_values: string[];
  default_thinking_value?: string | null;
  input_modalities: ModelCatalogInputModality[];
}

export interface ProviderCatalogEntry {
  source: "local" | "backend";
  models: ModelCatalogEntry[];
}

export type ProviderModelCatalog = Record<string, ProviderCatalogEntry>;

export interface ModelCatalogMetadata {
  label?: string;
  reasoning: boolean;
  thinkingValues: string[];
  defaultThinkingValue: string | null;
  inputModalities: ModelCatalogInputModality[];
}

const OPENAI_GPT54_THINKING_VALUES = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
const OPENAI_GPT53_CODEX_THINKING_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export const PROVIDER_MODEL_CATALOG: ProviderModelCatalog = {
  holaboss_model_proxy: {
    source: "backend",
    models: [
      {
        model_id: "gpt-5.4",
        label: "GPT-5.4",
        reasoning: true,
        thinking_values: [...OPENAI_GPT54_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text", "image"],
      },
      {
        model_id: "gpt-5.5",
        label: "GPT-5.5",
        reasoning: true,
        thinking_values: [...OPENAI_GPT54_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text", "image"],
      },
      {
        model_id: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
        reasoning: true,
        thinking_values: [...OPENAI_GPT53_CODEX_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text", "image"],
      },
    ],
  },
};

function normalizeProviderId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "holaboss") {
    return "holaboss_model_proxy";
  }
  return normalized;
}

function normalizeModelId(modelId: string): string {
  return modelId.trim();
}

function cloneMetadata(entry: ModelCatalogEntry): ModelCatalogMetadata {
  return {
    ...(entry.label ? { label: entry.label } : {}),
    reasoning: entry.reasoning,
    thinkingValues: [...entry.thinking_values],
    defaultThinkingValue: entry.default_thinking_value ?? null,
    inputModalities: [...entry.input_modalities],
  };
}

function mappedHolabossProxyModelId(modelId: string): string | null {
  const normalizedModelId = normalizeModelId(modelId);
  if (!normalizedModelId) {
    return null;
  }
  const [prefix, rest] = normalizedModelId.split("/", 2);
  if (rest) {
    const normalizedPrefix = prefix.trim().toLowerCase();
    if (
      normalizedPrefix === "openai" ||
      normalizedPrefix === "holaboss" ||
      normalizedPrefix === "holaboss_model_proxy"
    ) {
      return rest.trim();
    }
  }
  if (/^gpt-5(?:[.-]|$)/i.test(normalizedModelId)) {
    return normalizedModelId;
  }
  return null;
}

export function catalogEntryForProviderModel(
  providerId: string,
  modelId: string,
): ModelCatalogEntry | null {
  const normalizedProviderId = normalizeProviderId(providerId);
  const normalizedModelId = normalizeModelId(modelId);
  if (!normalizedProviderId || !normalizedModelId) {
    return null;
  }
  const providerCatalog = PROVIDER_MODEL_CATALOG[normalizedProviderId];
  if (!providerCatalog) {
    return null;
  }
  return (
    providerCatalog.models.find(
      (entry) => normalizeModelId(entry.model_id) === normalizedModelId,
    ) ?? null
  );
}

export function catalogMetadataForProviderModel(
  providerId: string,
  modelId: string,
): ModelCatalogMetadata | null {
  const exact = catalogEntryForProviderModel(providerId, modelId);
  if (exact) {
    return cloneMetadata(exact);
  }

  if (normalizeProviderId(providerId) !== "holaboss_model_proxy") {
    return null;
  }

  const fallbackModelId = mappedHolabossProxyModelId(modelId);
  if (!fallbackModelId) {
    return null;
  }
  const fallback = catalogEntryForProviderModel(
    "holaboss_model_proxy",
    fallbackModelId,
  );
  return fallback ? cloneMetadata(fallback) : null;
}

export function catalogConfigShapeForProviderModel(
  providerId: string,
  modelId: string,
): Record<string, unknown> | null {
  const entry = catalogEntryForProviderModel(providerId, modelId);
  if (!entry) {
    return null;
  }
  return {
    ...(entry.label ? { label: entry.label } : {}),
    reasoning: entry.reasoning,
    thinking_values: [...entry.thinking_values],
    ...(entry.default_thinking_value !== undefined
      ? { default_thinking_value: entry.default_thinking_value }
      : {}),
    input_modalities: [...entry.input_modalities],
  };
}
