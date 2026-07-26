import { resolveProductRuntimeConfig } from "./runtime-config.js";

export interface ResolvedSubagentExecutionProfile {
  model: string;
  thinkingValue: string | null;
}

function normalizedValue(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function canonicalModelId(modelToken: string): string {
  const normalized = normalizedValue(modelToken);
  if (!normalized) {
    return "";
  }
  const parts = normalized.split("/");
  return (parts.at(-1) ?? normalized).trim().toLowerCase();
}

function defaultThinkingValueForModel(modelToken: string): string | null {
  const modelId = canonicalModelId(modelToken);
  if (!modelId) {
    return null;
  }
  if (
    modelId === "gpt-5.4" ||
    modelId === "gpt-5.5" ||
    modelId === "gpt-5.3-codex" ||
    modelId.startsWith("gpt-5.")
  ) {
    return "medium";
  }
  if (modelId === "claude-haiku-4-5") {
    return "8192";
  }
  if (modelId.startsWith("claude-sonnet-") || modelId.startsWith("claude-opus-")) {
    return "medium";
  }
  if (modelId === "gemini-2.5-pro" || modelId === "gemini-2.5-flash") {
    return "8192";
  }
  if (
    modelId.startsWith("openai/") ||
    modelId.startsWith("anthropic/") ||
    modelId.startsWith("qwen/") ||
    modelId.startsWith("xiaomi/") ||
    modelId.startsWith("z-ai/")
  ) {
    return "medium";
  }
  return null;
}

function resolvedThinkingValue(params: {
  model: string;
  selectedThinkingValue?: string | null;
  forceModelDefault?: boolean;
}): string | null {
  const selectedThinkingValue = normalizedValue(params.selectedThinkingValue);
  if (!params.forceModelDefault && selectedThinkingValue) {
    return selectedThinkingValue;
  }
  return defaultThinkingValueForModel(params.model);
}

export function resolveSubagentExecutionProfile(params?: {
  selectedModel?: string | null;
  selectedThinkingValue?: string | null;
  ignoreConfiguredSubagentModel?: boolean;
}): ResolvedSubagentExecutionProfile {
  const runtimeConfig = resolveProductRuntimeConfig({
    requireAuth: false,
    requireUser: false,
    requireBaseUrl: false,
    includeDefaultBaseUrl: false,
  });
  const configuredSubagentModel = params?.ignoreConfiguredSubagentModel
    ? ""
    : normalizedValue(runtimeConfig.subagentModel);
  if (configuredSubagentModel) {
    return {
      model: configuredSubagentModel,
      thinkingValue: resolvedThinkingValue({
        model: configuredSubagentModel,
        forceModelDefault: true,
      }),
    };
  }
  const selectedModel = normalizedValue(params?.selectedModel);
  if (selectedModel) {
    return {
      model: selectedModel,
      thinkingValue: resolvedThinkingValue({
        model: selectedModel,
        selectedThinkingValue: params?.selectedThinkingValue,
      }),
    };
  }
  const defaultModel = normalizedValue(runtimeConfig.defaultModel);
  return {
    model: defaultModel,
    thinkingValue: resolvedThinkingValue({
      model: defaultModel,
      forceModelDefault: true,
    }),
  };
}

export function resolveSubagentExecutionModel(params?: {
  selectedModel?: string | null;
  ignoreConfiguredSubagentModel?: boolean;
}): string {
  return resolveSubagentExecutionProfile(params).model;
}
