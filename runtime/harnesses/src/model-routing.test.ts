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
