import { catalogMetadataForProviderModel } from "../../../shared/model-catalog";

/**
 * Model options for an automation, scoped to its selected agent (harness).
 *
 * Each harness reports `supported_models`: EMPTY means it uses the runtime
 * model catalogue (pi/Hola), so the automation offers the same models as the
 * chat composer; NON-EMPTY means the harness ships its OWN namespace
 * (claude-code, codex) and only those models are valid. So changing the agent
 * changes which models are selectable — mirroring the composer
 * (ChatPane/index.tsx ~10163).
 */
export interface AutomationModelOption {
  value: string;
  label: string;
}

export interface AutomationModelChoice {
  /** True when the harness has its own model namespace (claude-code, codex). */
  usesHarnessNamespace: boolean;
  /** Selectable models for the current harness. */
  options: AutomationModelOption[];
  /** The harness's default model id (namespace harnesses only; null for pi). */
  defaultModel: string | null;
}

/** Resolve the model choices for `harness` from the harness inventory, falling
 *  back to the composer's runtime catalogue when the harness has no namespace. */
export function automationModelChoiceForHarness(params: {
  harness: string;
  harnesses: HarnessAvailabilityEntryPayload[];
  chatModelOptions: AutomationModelOption[];
}): AutomationModelChoice {
  const entry = params.harnesses.find((h) => h.id === params.harness);
  const supported = entry?.supported_models ?? [];
  if (supported.length > 0) {
    return {
      usesHarnessNamespace: true,
      options: supported.map((m) => ({ value: m.id, label: m.label })),
      defaultModel:
        (supported.find((m) => m.default) ?? supported[0])?.id ?? null,
    };
  }
  return {
    usesHarnessNamespace: false,
    options: params.chatModelOptions,
    defaultModel: null,
  };
}

/**
 * Reconcile a pinned model against a harness's model set — used when the agent
 * changes. A model still valid for the new harness is kept; otherwise fall back
 * to the harness default (namespace harnesses) or null = "default" (pi, where
 * null means follow the workspace default).
 */
export function reconcileAutomationModel(params: {
  model: string | null;
  choice: AutomationModelChoice;
}): string | null {
  const { model, choice } = params;
  if (model !== null && choice.options.some((o) => o.value === model)) {
    return model;
  }
  return choice.usesHarnessNamespace ? choice.defaultModel : null;
}

function dedupeThinkingValues(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** The reasoning-effort levels a pinned automation model exposes, plus its
 *  own default. Empty `thinkingValues` ⇒ the model has no selectable effort
 *  (non-reasoning model, or a CLI-namespace model whose effort isn't declared),
 *  so the dialog hides the field. */
export interface AutomationThinkingChoice {
  thinkingValues: string[];
  defaultThinkingValue: string | null;
}

/**
 * Reasoning-effort options for an automation's pinned model — the same source
 * the composer uses: the model's `thinkingValues` from the runtime catalogue
 * (`providerModelGroups`), falling back to the bundled model catalogue. When no
 * model is pinned (`model` is null → follow the workspace default) pass the
 * runtime `defaultModel` so the picker still reflects what will actually run;
 * for a CLI-namespace harness leave `defaultModel` null (its effort levels
 * aren't model-declared, so the dialog simply hides the field).
 */
export function automationThinkingChoiceForModel(params: {
  model: string | null;
  providerModelGroups: RuntimeProviderModelGroupPayload[];
  defaultModel?: string | null;
}): AutomationThinkingChoice {
  const token = params.model?.trim() || params.defaultModel?.trim() || "";
  if (!token) {
    return { thinkingValues: [], defaultThinkingValue: null };
  }
  const configured = params.providerModelGroups
    .flatMap((group) => group.models)
    .find((entry) => entry.token === token);
  if (configured) {
    return {
      thinkingValues: dedupeThinkingValues(configured.thinkingValues),
      defaultThinkingValue: configured.defaultThinkingValue?.trim() || null,
    };
  }
  const fallback = catalogMetadataForProviderModel(
    "holaboss_model_proxy",
    token,
  );
  if (fallback) {
    return {
      thinkingValues: dedupeThinkingValues(fallback.thinkingValues),
      defaultThinkingValue: fallback.defaultThinkingValue,
    };
  }
  return { thinkingValues: [], defaultThinkingValue: null };
}

/** Keep a pinned thinking value only while the current model still offers it;
 *  otherwise drop to null = "follow the model's default reasoning effort". */
export function reconcileAutomationThinkingValue(params: {
  thinkingValue: string | null;
  choice: AutomationThinkingChoice;
}): string | null {
  const { thinkingValue, choice } = params;
  if (thinkingValue && choice.thinkingValues.includes(thinkingValue)) {
    return thinkingValue;
  }
  return null;
}
