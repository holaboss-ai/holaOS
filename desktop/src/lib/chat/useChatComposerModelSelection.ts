import { useCallback, useEffect, useState } from "react";
import {
  CHAT_MODEL_PRESETS,
  CHAT_MODEL_STORAGE_KEY,
  CHAT_MODEL_USE_RUNTIME_DEFAULT,
  DEPRECATED_CHAT_MODELS,
  LEGACY_UNAVAILABLE_CHAT_MODELS,
  RUNTIME_MODEL_CAPABILITY_ALIASES,
} from "@/components/panes/ChatPane/constants";
import { displayModelLabel } from "@/components/panes/ChatPane/helpers";
import type {
  ChatModelOption,
  ChatModelOptionGroup,
} from "@/components/panes/ChatPane/types";
import { DEFAULT_RUNTIME_MODEL, useDesktopAuthSession } from "@/lib/auth/authClient";
import { useWorkspaceDesktop } from "@/lib/workspaceDesktop";

function sessionUserId(
  session: { user?: { id?: string | null } | null } | null | undefined,
): string {
  return session?.user?.id?.trim() || "";
}

function isHolabossProxyModel(model: string) {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.startsWith("openai/") ||
    normalized.startsWith("google/") ||
    normalized.startsWith("anthropic/") ||
    normalized.startsWith("gpt-") ||
    normalized.startsWith("claude-") ||
    normalized.startsWith("gemini-")
  );
}

function isHolabossProviderId(providerId: string) {
  const normalized = providerId.trim().toLowerCase();
  return (
    normalized === "holaboss_model_proxy" ||
    normalized === "holaboss" ||
    normalized.includes("holaboss")
  );
}

function isDeprecatedChatModel(model: string) {
  return DEPRECATED_CHAT_MODELS.has(model.trim().toLowerCase());
}

function normalizeRuntimeModelCapability(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return "";
  return RUNTIME_MODEL_CAPABILITY_ALIASES[normalized] ?? normalized;
}

function runtimeModelCapabilities(model: RuntimeProviderModelPayload) {
  if (!Array.isArray(model.capabilities)) return [];
  const seen = new Set<string>();
  const capabilities: string[] = [];
  for (const value of model.capabilities) {
    if (typeof value !== "string") continue;
    const normalized = normalizeRuntimeModelCapability(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    capabilities.push(normalized);
  }
  return capabilities;
}

function runtimeModelHasChatCapability(model: RuntimeProviderModelPayload) {
  const capabilities = runtimeModelCapabilities(model);
  return capabilities.length === 0 || capabilities.includes("chat");
}

function runtimeModelDisplayLabel(model: RuntimeProviderModelPayload) {
  return model.label?.trim() || displayModelLabel(model.modelId || model.token);
}

function modelTokenLabel(token: string): string {
  if (!token) return "";
  const segments = token.split("/").filter(Boolean);
  const focus = segments.length > 2 ? segments.slice(-2).join("/") : token;
  return displayModelLabel(focus);
}

function normalizeStoredChatModelPreference(value: string | null | undefined) {
  const stored = value?.trim();
  if (!stored) return CHAT_MODEL_USE_RUNTIME_DEFAULT;
  if (LEGACY_UNAVAILABLE_CHAT_MODELS.has(stored.toLowerCase())) {
    return CHAT_MODEL_USE_RUNTIME_DEFAULT;
  }
  return stored;
}

function loadStoredChatModelPreference() {
  try {
    return normalizeStoredChatModelPreference(
      localStorage.getItem(CHAT_MODEL_STORAGE_KEY),
    );
  } catch {
    return CHAT_MODEL_USE_RUNTIME_DEFAULT;
  }
}

export interface ChatComposerModelSelection {
  isSignedIn: boolean;
  chatModelPreference: string;
  setChatModelPreference: (value: string) => void;
  effectiveChatModelPreference: string;
  resolvedChatModel: string;
  availableChatModelOptions: ChatModelOption[];
  availableChatModelOptionGroups: ChatModelOptionGroup[];
  runtimeDefaultModel: string;
  runtimeDefaultModelLabel: string;
  runtimeDefaultModelAvailable: boolean;
  resolvedModelLabel: string;
  modelSelectionUnavailableReason: string;
  requiresModelProviderSetup: boolean;
  hasConfiguredProviderCatalog: boolean;
}

export function useChatComposerModelSelection(): ChatComposerModelSelection {
  const authSessionState = useDesktopAuthSession();
  const { runtimeConfig } = useWorkspaceDesktop();

  const [chatModelPreference, setChatModelPreferenceRaw] = useState(
    loadStoredChatModelPreference,
  );

  useEffect(() => {
    const normalized = normalizeStoredChatModelPreference(chatModelPreference);
    if (normalized !== chatModelPreference) {
      setChatModelPreferenceRaw(normalized);
    }
  }, [chatModelPreference]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_MODEL_STORAGE_KEY, chatModelPreference);
    } catch {
      // ignore persistence failures
    }
  }, [chatModelPreference]);

  const setChatModelPreference = useCallback((value: string) => {
    setChatModelPreferenceRaw(value);
  }, []);

  const isSignedIn = Boolean(sessionUserId(authSessionState.data));
  const holabossProxyModelsAvailable =
    isSignedIn &&
    Boolean(runtimeConfig?.authTokenPresent) &&
    Boolean((runtimeConfig?.modelProxyBaseUrl || "").trim());

  const configuredProviderModelGroups = runtimeConfig?.providerModelGroups ?? [];
  const visibleConfiguredProviderModelGroups = configuredProviderModelGroups
    .filter(
      (providerGroup) =>
        isSignedIn || !isHolabossProviderId(providerGroup.providerId),
    )
    .map((providerGroup) => ({
      ...providerGroup,
      pending:
        isSignedIn &&
        isHolabossProviderId(providerGroup.providerId) &&
        !holabossProxyModelsAvailable,
      models: providerGroup.models.filter((model) => {
        const normalizedToken = model.token.trim();
        if (!normalizedToken || isDeprecatedChatModel(normalizedToken)) {
          return false;
        }
        if (!runtimeModelHasChatCapability(model)) return false;
        return true;
      }),
    }))
    .filter((providerGroup) => providerGroup.models.length > 0);

  const hasConfiguredProviderCatalog =
    visibleConfiguredProviderModelGroups.length > 0;
  const hasPendingConfiguredProviderCatalog =
    visibleConfiguredProviderModelGroups.some(
      (providerGroup) => providerGroup.pending,
    );

  const providerModelLabelCounts = new Map<string, number>();
  for (const providerGroup of visibleConfiguredProviderModelGroups) {
    for (const model of providerGroup.models) {
      const modelLabel = runtimeModelDisplayLabel(model);
      providerModelLabelCounts.set(
        modelLabel,
        (providerModelLabelCounts.get(modelLabel) ?? 0) + 1,
      );
    }
  }

  const runtimeDefaultModel =
    runtimeConfig?.defaultModel?.trim() || DEFAULT_RUNTIME_MODEL;
  const requiresModelProviderSetup =
    !hasConfiguredProviderCatalog && !holabossProxyModelsAvailable;
  const runtimeDefaultModelAvailable =
    !requiresModelProviderSetup &&
    (hasConfiguredProviderCatalog
      ? visibleConfiguredProviderModelGroups.some((providerGroup) =>
          providerGroup.models.some(
            (model) => model.token.trim() === runtimeDefaultModel,
          ),
        )
      : holabossProxyModelsAvailable ||
        !isHolabossProxyModel(runtimeDefaultModel));

  const availableChatModelOptionGroups: ChatModelOptionGroup[] =
    hasConfiguredProviderCatalog
      ? visibleConfiguredProviderModelGroups.map((providerGroup) => ({
          label: providerGroup.providerLabel,
          options: providerGroup.models.map((model) => {
            const modelLabel = runtimeModelDisplayLabel(model);
            const needsProviderPrefix =
              visibleConfiguredProviderModelGroups.length > 1 &&
              (providerModelLabelCounts.get(modelLabel) ?? 0) > 1;
            return {
              value: model.token,
              label: modelLabel,
              selectedLabel: needsProviderPrefix
                ? `${providerGroup.providerLabel} · ${modelLabel}`
                : modelLabel,
              searchText: `${providerGroup.providerLabel} ${modelLabel} ${model.token}`,
              disabled: providerGroup.pending,
              statusLabel: providerGroup.pending ? "Pending" : undefined,
            };
          }),
        }))
      : [];

  const availableChatModelOptions = hasConfiguredProviderCatalog
    ? availableChatModelOptionGroups.flatMap((group) =>
        group.options.filter((option) => !option.disabled),
      )
    : requiresModelProviderSetup
      ? []
      : Array.from(
          new Set([
            runtimeDefaultModel,
            DEFAULT_RUNTIME_MODEL,
            ...(chatModelPreference !== CHAT_MODEL_USE_RUNTIME_DEFAULT
              ? [chatModelPreference]
              : []),
            ...CHAT_MODEL_PRESETS,
          ]),
        )
          .filter(Boolean)
          .filter((model) => !isDeprecatedChatModel(model))
          .filter(
            (model) =>
              holabossProxyModelsAvailable || !isHolabossProxyModel(model),
          )
          .map((model) => ({
            value: model,
            label: displayModelLabel(model),
          }));

  const normalizedModelPreference = chatModelPreference.trim();
  const modelPreferenceAvailable = hasConfiguredProviderCatalog
    ? normalizedModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? runtimeDefaultModelAvailable
      : normalizedModelPreference.length > 0 &&
        availableChatModelOptions.some(
          (option) => option.value === normalizedModelPreference,
        )
    : chatModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? runtimeDefaultModelAvailable
      : availableChatModelOptions.some(
          (option) => option.value === normalizedModelPreference,
        );

  const effectiveChatModelPreference = hasConfiguredProviderCatalog
    ? modelPreferenceAvailable
      ? normalizedModelPreference
      : availableChatModelOptions[0]?.value || ""
    : modelPreferenceAvailable
      ? chatModelPreference
      : runtimeDefaultModelAvailable
        ? CHAT_MODEL_USE_RUNTIME_DEFAULT
        : availableChatModelOptions[0]?.value || CHAT_MODEL_USE_RUNTIME_DEFAULT;

  const resolvedChatModel = hasConfiguredProviderCatalog
    ? effectiveChatModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? runtimeDefaultModelAvailable
        ? runtimeDefaultModel
        : availableChatModelOptions[0]?.value || ""
      : effectiveChatModelPreference
    : effectiveChatModelPreference === CHAT_MODEL_USE_RUNTIME_DEFAULT
      ? runtimeDefaultModelAvailable
        ? runtimeDefaultModel
        : ""
      : effectiveChatModelPreference.trim() ||
        (runtimeDefaultModelAvailable ? runtimeDefaultModel : "");

  const resolvedModelLabel = resolvedChatModel
    ? modelTokenLabel(resolvedChatModel)
    : "";
  const runtimeDefaultModelLabel = modelTokenLabel(runtimeDefaultModel);

  const modelSelectionUnavailableReason =
    availableChatModelOptions.length > 0
      ? ""
      : hasPendingConfiguredProviderCatalog
        ? "Managed models are finishing setup. Refresh runtime binding or use another provider."
        : "No models available. Configure a provider to start chatting.";

  return {
    isSignedIn,
    chatModelPreference,
    setChatModelPreference,
    effectiveChatModelPreference,
    resolvedChatModel,
    availableChatModelOptions,
    availableChatModelOptionGroups,
    runtimeDefaultModel,
    runtimeDefaultModelLabel,
    runtimeDefaultModelAvailable,
    resolvedModelLabel,
    modelSelectionUnavailableReason,
    requiresModelProviderSetup,
    hasConfiguredProviderCatalog,
  };
}
