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
const OPENROUTER_THINKING_VALUES = [
  "minimal",
  "low",
  "medium",
  "high",
] as const;
const ANTHROPIC_BUDGET_THINKING_VALUES = [
  "1024",
  "2048",
  "8192",
  "16384",
] as const;
const ANTHROPIC_ADAPTIVE_THINKING_VALUES = ["low", "medium", "high"] as const;
const ANTHROPIC_OPUS_ADAPTIVE_THINKING_VALUES = [
  "low",
  "medium",
  "high",
  "max",
] as const;
const GEMINI_PRO_THINKING_VALUES = [
  "-1",
  "128",
  "2048",
  "8192",
  "32768",
] as const;
const GEMINI_FLASH_THINKING_VALUES = [
  "0",
  "-1",
  "128",
  "2048",
  "8192",
  "24576",
] as const;

export const PROVIDER_MODEL_CATALOG: ProviderModelCatalog = {
  holaboss_model_proxy: {
    source: "backend",
    models: [],
  },
  openai_direct: {
    source: "local",
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
        model_id: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
        reasoning: true,
        thinking_values: [...OPENAI_GPT53_CODEX_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text", "image"],
      },
    ],
  },
  openai_codex: {
    source: "local",
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
  anthropic_direct: {
    source: "local",
    models: [
      {
        model_id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        reasoning: true,
        thinking_values: [...ANTHROPIC_ADAPTIVE_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text", "image"],
      },
      {
        model_id: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        reasoning: true,
        thinking_values: [...ANTHROPIC_OPUS_ADAPTIVE_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text", "image"],
      },
      {
        model_id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        reasoning: true,
        thinking_values: [...ANTHROPIC_BUDGET_THINKING_VALUES],
        default_thinking_value: "8192",
        input_modalities: ["text", "image"],
      },
    ],
  },
  openrouter_direct: {
    source: "local",
    models: [
      {
        model_id: "openai/gpt-5.4",
        label: "GPT-5.4",
        reasoning: true,
        thinking_values: [...OPENROUTER_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text", "image"],
      },
      {
        model_id: "anthropic/claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        reasoning: true,
        thinking_values: [...OPENROUTER_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text", "image"],
      },
      {
        model_id: "qwen/qwen3.6-plus",
        label: "Qwen 3.6 Plus",
        reasoning: true,
        thinking_values: [...OPENROUTER_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text", "image"],
      },
      {
        model_id: "xiaomi/mimo-v2-pro",
        label: "MiMo V2 Pro",
        reasoning: true,
        thinking_values: [...OPENROUTER_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text"],
      },
      {
        model_id: "z-ai/glm-5-turbo",
        label: "GLM 5 Turbo",
        reasoning: true,
        thinking_values: [...OPENROUTER_THINKING_VALUES],
        default_thinking_value: "medium",
        input_modalities: ["text"],
      },
    ],
  },
  gemini_direct: {
    source: "local",
    models: [
      {
        model_id: "gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
        reasoning: true,
        thinking_values: [...GEMINI_PRO_THINKING_VALUES],
        default_thinking_value: "8192",
        input_modalities: ["text", "image"],
      },
      {
        model_id: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
        reasoning: true,
        thinking_values: [...GEMINI_FLASH_THINKING_VALUES],
        default_thinking_value: "8192",
        input_modalities: ["text", "image"],
      },
    ],
  },
  ollama_direct: {
    source: "local",
    models: [
      {
        model_id: "llama3.1:8b",
        label: "Llama 3.1 8B",
        reasoning: false,
        thinking_values: [],
        input_modalities: ["text"],
      },
      {
        model_id: "qwen3:8b",
        label: "Qwen3 8B",
        reasoning: false,
        thinking_values: [],
        input_modalities: ["text"],
      },
      {
        model_id: "gpt-oss:20b",
        label: "gpt-oss 20B",
        reasoning: false,
        thinking_values: [],
        input_modalities: ["text"],
      },
    ],
  },
  minimax_direct: {
    source: "local",
    models: [
      {
        model_id: "MiniMax-M2.7",
        label: "MiniMax M2.7",
        reasoning: false,
        thinking_values: [],
        input_modalities: ["text"],
      },
      {
        model_id: "MiniMax-M2.7-highspeed",
        label: "MiniMax M2.7 Highspeed",
        reasoning: false,
        thinking_values: [],
        input_modalities: ["text"],
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
  if (normalized === "openrouter") {
    return "openrouter_direct";
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

function mappedHolabossProxyProviderModel(
  modelId: string,
): { providerId: string; modelId: string } | null {
  const normalizedModelId = normalizeModelId(modelId);
  if (!normalizedModelId) {
    return null;
  }
  const [prefix, rest] = normalizedModelId.split("/", 2);
  if (rest) {
    const normalizedPrefix = prefix.trim().toLowerCase();
    if (normalizedPrefix === "openai") {
      return { providerId: "openai_direct", modelId: rest.trim() };
    }
    if (normalizedPrefix === "anthropic") {
      return { providerId: "anthropic_direct", modelId: rest.trim() };
    }
    if (normalizedPrefix === "google") {
      return { providerId: "gemini_direct", modelId: rest.trim() };
    }
    if (
      normalizedPrefix === "qwen" ||
      normalizedPrefix === "xiaomi" ||
      normalizedPrefix === "z-ai"
    ) {
      return { providerId: "openrouter_direct", modelId: normalizedModelId };
    }
  }
  if (/^gpt-5(?:[.-]|$)/i.test(normalizedModelId)) {
    return { providerId: "openai_direct", modelId: normalizedModelId };
  }
  if (/^claude-/i.test(normalizedModelId)) {
    return { providerId: "anthropic_direct", modelId: normalizedModelId };
  }
  if (/^gemini-/i.test(normalizedModelId)) {
    return { providerId: "gemini_direct", modelId: normalizedModelId };
  }
  if (
    /^qwen\/qwen3\.6-plus$/i.test(normalizedModelId) ||
    /^xiaomi\/mimo-v2-pro$/i.test(normalizedModelId) ||
    /^z-ai\/glm-5-turbo$/i.test(normalizedModelId)
  ) {
    return { providerId: "openrouter_direct", modelId: normalizedModelId };
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

  const mapped = mappedHolabossProxyProviderModel(modelId);
  if (!mapped) {
    return null;
  }
  const fallback = catalogEntryForProviderModel(mapped.providerId, mapped.modelId);
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
