import assert from "node:assert/strict";
import { test } from "node:test";

import {
  automationModelChoiceForHarness,
  automationThinkingChoiceForModel,
  reconcileAutomationModel,
  reconcileAutomationThinkingValue,
} from "./automationModelOptions.js";

// Minimal harness inventory: pi has no namespace (uses the runtime catalogue),
// claude-code ships its own models with an explicit default.
const HARNESSES = [
  { id: "pi", supported_models: [] },
  {
    id: "claude-code",
    supported_models: [
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic" },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        provider: "anthropic",
        default: true,
      },
    ],
  },
  // biome-ignore lint/suspicious/noExplicitAny: test doubles for the global payload type.
] as any;

const CHAT = [
  { value: "openai/gpt-5.4", label: "GPT-5.4" },
  { value: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
];

test("pi (empty supported_models) uses the runtime catalogue", () => {
  const choice = automationModelChoiceForHarness({
    harness: "pi",
    harnesses: HARNESSES,
    chatModelOptions: CHAT,
  });
  assert.equal(choice.usesHarnessNamespace, false);
  assert.deepEqual(choice.options, CHAT);
  assert.equal(choice.defaultModel, null);
});

test("a CLI harness exposes only its own namespace + flagged default", () => {
  const choice = automationModelChoiceForHarness({
    harness: "claude-code",
    harnesses: HARNESSES,
    chatModelOptions: CHAT,
  });
  assert.equal(choice.usesHarnessNamespace, true);
  assert.deepEqual(
    choice.options.map((o) => o.value),
    ["claude-opus-4-8", "claude-sonnet-5"],
  );
  assert.equal(choice.defaultModel, "claude-sonnet-5");
});

test("reconcile keeps a valid pin, else falls back to harness default / null", () => {
  const cli = automationModelChoiceForHarness({
    harness: "claude-code",
    harnesses: HARNESSES,
    chatModelOptions: CHAT,
  });
  const pi = automationModelChoiceForHarness({
    harness: "pi",
    harnesses: HARNESSES,
    chatModelOptions: CHAT,
  });

  // A model still valid for the new agent is kept.
  assert.equal(
    reconcileAutomationModel({ model: "claude-opus-4-8", choice: cli }),
    "claude-opus-4-8",
  );
  // A pi model switched into claude-code is invalid → the harness default.
  assert.equal(
    reconcileAutomationModel({ model: "openai/gpt-5.4", choice: cli }),
    "claude-sonnet-5",
  );
  // A claude model switched into pi is invalid → null (workspace default).
  assert.equal(
    reconcileAutomationModel({ model: "claude-opus-4-8", choice: pi }),
    null,
  );
  // A valid pi pin is kept.
  assert.equal(
    reconcileAutomationModel({ model: "deepseek/deepseek-v4-pro", choice: pi }),
    "deepseek/deepseek-v4-pro",
  );
});

// A runtime provider group carrying explicit thinking metadata for a model.
const PROVIDER_GROUPS = [
  {
    providerId: "holaboss_model_proxy",
    providerLabel: "Holaboss",
    kind: "backend",
    models: [
      {
        token: "claude-sonnet-4-6",
        modelId: "claude-sonnet-4-6",
        reasoning: true,
        thinkingValues: ["low", "medium", "high", "medium"], // dup on purpose
        defaultThinkingValue: "medium",
      },
      {
        token: "deepseek/deepseek-v4-pro",
        modelId: "deepseek-v4-pro",
        reasoning: false,
        thinkingValues: [],
      },
    ],
  },
  // biome-ignore lint/suspicious/noExplicitAny: test double for the global payload type.
] as any;

test("thinking choice reads a configured model's effort levels (deduped)", () => {
  const choice = automationThinkingChoiceForModel({
    model: "claude-sonnet-4-6",
    providerModelGroups: PROVIDER_GROUPS,
  });
  assert.deepEqual(choice.thinkingValues, ["low", "medium", "high"]);
  assert.equal(choice.defaultThinkingValue, "medium");
});

test("thinking choice is empty for a non-reasoning model", () => {
  const choice = automationThinkingChoiceForModel({
    model: "deepseek/deepseek-v4-pro",
    providerModelGroups: PROVIDER_GROUPS,
  });
  assert.deepEqual(choice.thinkingValues, []);
  assert.equal(choice.defaultThinkingValue, null);
});

test("thinking choice falls back to the bundled catalogue for a known model", () => {
  // gpt-5.4 isn't in PROVIDER_GROUPS but ships in the local model catalogue.
  const choice = automationThinkingChoiceForModel({
    model: "gpt-5.4",
    providerModelGroups: PROVIDER_GROUPS,
  });
  assert.ok(choice.thinkingValues.includes("medium"));
  assert.equal(choice.defaultThinkingValue, "medium");
});

test("thinking choice resolves the workspace default model when none is pinned", () => {
  // model=null + a pi default model => the picker reflects the default's effort.
  const choice = automationThinkingChoiceForModel({
    model: null,
    providerModelGroups: PROVIDER_GROUPS,
    defaultModel: "claude-sonnet-4-6",
  });
  assert.deepEqual(choice.thinkingValues, ["low", "medium", "high"]);
});

test("thinking choice is empty when the model is unknown / absent", () => {
  assert.deepEqual(
    automationThinkingChoiceForModel({
      model: "some/unknown-model",
      providerModelGroups: PROVIDER_GROUPS,
    }),
    { thinkingValues: [], defaultThinkingValue: null },
  );
  assert.deepEqual(
    automationThinkingChoiceForModel({
      model: null,
      providerModelGroups: PROVIDER_GROUPS,
    }),
    { thinkingValues: [], defaultThinkingValue: null },
  );
});

test("reconcile keeps a still-offered effort, else drops to the model default", () => {
  const choice = automationThinkingChoiceForModel({
    model: "claude-sonnet-4-6",
    providerModelGroups: PROVIDER_GROUPS,
  });
  // A pin the model still offers is kept.
  assert.equal(
    reconcileAutomationThinkingValue({ thinkingValue: "high", choice }),
    "high",
  );
  // A pin the model no longer offers drops to null = "model default".
  assert.equal(
    reconcileAutomationThinkingValue({ thinkingValue: "xhigh", choice }),
    null,
  );
  // Null stays null.
  assert.equal(
    reconcileAutomationThinkingValue({ thinkingValue: null, choice }),
    null,
  );
});
