import assert from "node:assert/strict";
import { test } from "node:test";

import {
  automationModelChoiceForHarness,
  reconcileAutomationModel,
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
