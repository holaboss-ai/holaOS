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
