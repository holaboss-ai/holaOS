export const CUSTOM_PROVIDER_PRESET_ID = "custom";

export interface ProviderFormPreset {
  id: string;
  label: string;
  displayName: string;
  providerType: "openai_compatible" | "anthropic_compatible";
  apiHost: string;
  keyPlaceholder: string;
}

export const PROVIDER_FORM_PRESETS = [
  {
    id: CUSTOM_PROVIDER_PRESET_ID,
    label: "Custom",
    displayName: "",
    providerType: "openai_compatible",
    apiHost: "",
    keyPlaceholder: "sk-…",
  },
  {
    id: "atlascloud",
    label: "Atlas Cloud",
    displayName: "Atlas Cloud",
    providerType: "openai_compatible",
    apiHost: "https://api.atlascloud.ai/v1",
    keyPlaceholder: "sk-…",
  },
] as const satisfies readonly ProviderFormPreset[];

export function providerFormPreset(presetId: string): ProviderFormPreset {
  return (
    PROVIDER_FORM_PRESETS.find((preset) => preset.id === presetId) ??
    PROVIDER_FORM_PRESETS[0]
  );
}
