import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  mergeHarnessModelCatalogs,
  resolveHarnessModelBudget,
  resolveHarnessModelProfile,
  runtimeConfigModelCatalog,
  type HarnessModelRoutingRequest,
} from "./model-routing.js";

function baseRequest(): HarnessModelRoutingRequest {
  return {
    provider_id: "openai",
    model_id: "gpt-5.4",
    thinking_value: "medium",
    model_client: {
      model_proxy_provider: "openai_compatible",
      api_key: "token",
      base_url: "https://runtime.example/api/v1/model-proxy/openai/v1",
      default_headers: {
        "X-API-Key": "token",
      },
    },
  };
}

test("resolveHarnessModelProfile disables developer role for qwen models on the managed OpenAI-compatible path", () => {
  const profile = resolveHarnessModelProfile(
    {
      ...baseRequest(),
      model_id: "qwen/qwen3.6-plus",
    },
    {
      modelCatalog: {},
    },
  );

  assert.equal(profile.api, "openai-completions");
  assert.equal(profile.reasoning, true);
  assert.equal(profile.requestedThinkingLevel, "medium");
  assert.deepEqual(profile.compat, {
    supportsDeveloperRole: false,
  });
});

test("resolveHarnessModelBudget falls back to a 500k context window for unknown models", () => {
  const budget = resolveHarnessModelBudget(
    {
      provider_id: "custom_openai_compat",
      model_id: "custom-reasoner",
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token",
        base_url: "https://api.example.com/v1",
      },
    },
    {
      modelCatalog: {},
    },
  );

  assert.equal(budget.contextWindow, 500_000);
  assert.equal(budget.maxTokens, 128_000);
});

test("runtime-config model catalog contributes managed proxy context windows to budget resolution", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-model-routing-config-"));
  const configPath = path.join(root, "runtime-config.json");
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      models: {
        "holaboss_model_proxy/claude-opus-4-7": {
          provider_id: "holaboss_model_proxy",
          model_id: "claude-opus-4-7",
          context_window: 1_000_000,
          max_tokens: 128_000,
        },
      },
    }),
    "utf8",
  );
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;

  try {
    const catalog = runtimeConfigModelCatalog();
    assert.equal(
      catalog.holaboss_model_proxy?.["claude-opus-4-7"]?.contextWindow,
      1_000_000,
    );
    const budget = resolveHarnessModelBudget(
      {
        provider_id: "anthropic",
        model_id: "claude-opus-4-7",
        model_client: {
          model_proxy_provider: "anthropic_native",
          api_key: "token",
          base_url: "https://runtime.example/api/v1/model-proxy/anthropic/v1",
        },
      },
      {
        modelCatalog: mergeHarnessModelCatalogs(catalog),
      },
    );
    assert.equal(budget.contextWindow, 1_000_000);
    assert.equal(budget.maxTokens, 128_000);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
    } else {
      process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The completion budget is a CEILING, not a value to stamp on every model.
 *
 * Seven entries in the live catalogue cap output below the uniform 128k (two at
 * 32k, five in the 64k family). Every request to those carried a `max_tokens`
 * their own API rejects — the budget resolved from the catalogue was discarded
 * and replaced wholesale.
 */
function budgetFor(maxTokens: number | undefined) {
  return resolveHarnessModelBudget(
    {
      provider_id: "holaboss_model_proxy",
      model_id: "some-model",
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token",
        base_url: "https://api.example.com/v1",
      },
    },
    {
      modelCatalog: {
        holaboss_model_proxy: {
          "some-model": {
            contextWindow: 200_000,
            ...(maxTokens === undefined ? {} : { maxTokens }),
          },
        },
      },
    },
  );
}

test("a model that caps output below the uniform budget is not asked for more", () => {
  assert.equal(budgetFor(32_768).maxTokens, 32_768);
  assert.equal(budgetFor(65_536).maxTokens, 65_536);
});

test("a model at or above the uniform budget is unchanged", () => {
  // Clamping only ever lowers, so nothing that works today gets shorter.
  assert.equal(budgetFor(128_000).maxTokens, 128_000);
  assert.equal(budgetFor(131_072).maxTokens, 128_000);
  assert.equal(budgetFor(384_000).maxTokens, 128_000);
});

test("a catalogue entry with no declared output cap keeps the uniform budget", () => {
  assert.equal(budgetFor(undefined).maxTokens, 128_000);
});
