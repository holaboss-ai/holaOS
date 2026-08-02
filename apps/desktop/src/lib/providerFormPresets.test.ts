import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CUSTOM_PROVIDER_PRESET_ID,
  providerFormPreset,
} from "./providerFormPresets.js";

test("Atlas Cloud preset uses the OpenAI-compatible endpoint", () => {
  assert.deepEqual(providerFormPreset("atlascloud"), {
    id: "atlascloud",
    label: "Atlas Cloud",
    displayName: "Atlas Cloud",
    providerType: "openai_compatible",
    apiHost: "https://api.atlascloud.ai/v1",
    keyPlaceholder: "sk-…",
  });
});

test("unknown provider presets fall back to an empty custom form", () => {
  const preset = providerFormPreset("unknown");

  assert.equal(preset.id, CUSTOM_PROVIDER_PRESET_ID);
  assert.equal(preset.displayName, "");
  assert.equal(preset.apiHost, "");
});
