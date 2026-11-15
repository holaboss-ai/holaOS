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

function localRequest(
  overrides: Partial<HarnessModelRoutingRequest> = {},
): HarnessModelRoutingRequest {
  return {
    provider_id: "local_lmstudio",
    model_id: "qwen/qwen3-8b",
    model_client: {
      model_proxy_provider: "openai_compatible",
      api_key: "local",
      base_url: "http://127.0.0.1:1234/v1",
    },
    ...overrides,
  };
}

test("resolveHarnessModelProfile disables store, developer role and reasoning effort for local endpoints on any port", () => {
  for (const baseUrl of [
    "http://127.0.0.1:1234/v1",
    "http://localhost:8080/v1",
    "http://192.168.1.20:8000/v1",
    "http://mac-studio.local:30000/v1",
  ]) {
    const profile = resolveHarnessModelProfile(
      localRequest({
        model_id: "gpt-oss-20b",
        thinking_value: "medium",
        model_client: {
          model_proxy_provider: "openai_compatible",
          api_key: "local",
          base_url: baseUrl,
        },
      }),
      { modelCatalog: {} },
    );
    assert.equal(profile.api, "openai-completions", baseUrl);
    assert.deepEqual(
      profile.compat,
      {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      baseUrl,
    );
  }
});

test("resolveHarnessModelProfile keeps cloud OpenAI-compatible compat unchanged", () => {
  const profile = resolveHarnessModelProfile(
    {
      provider_id: "custom_openai_compat",
      model_id: "custom-reasoner",
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token",
        base_url: "https://api.example.com/v1",
      },
    },
    { modelCatalog: {} },
  );
  assert.equal(profile.compat, undefined);
  assert.deepEqual(profile.input, ["text", "image"]);
  assert.deepEqual(profile.budget, { contextWindow: 500_000, maxTokens: 128_000 });
});

test("resolveHarnessModelProfile treats localhost model-proxy routes as the managed proxy, not a local model", () => {
  const profile = resolveHarnessModelProfile(
    {
      provider_id: "openai",
      model_id: "gpt-4.1",
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token",
        base_url: "http://127.0.0.1:3060/api/v1/model-proxy/openai/v1",
      },
    },
    { modelCatalog: {} },
  );
  assert.equal(profile.compat, undefined);
  assert.deepEqual(profile.input, ["text", "image"]);
  assert.equal(profile.budget.contextWindow, 500_000);
});

test("local endpoints default to text input unless runtime-config declares image input", () => {
  const textOnly = resolveHarnessModelProfile(localRequest(), { modelCatalog: {} });
  assert.deepEqual(textOnly.input, ["text"]);

  const vision = resolveHarnessModelProfile(localRequest({ model_id: "qwen/qwen2.5-vl-7b" }), {
    modelCatalog: {
      local_lmstudio: {
        "qwen/qwen2.5-vl-7b": { input: ["text", "image"] },
      },
    },
  });
  assert.deepEqual(vision.input, ["text", "image"]);
});

test("local endpoint budgets use the configured context window or a conservative fallback", () => {
  assert.deepEqual(
    resolveHarnessModelBudget(localRequest(), {
      modelCatalog: {},
      fallbackBudget: { contextWindow: 500_000, maxTokens: 128_000 },
    }),
    { contextWindow: 32_768, maxTokens: 16_384 },
  );
  assert.deepEqual(
    resolveHarnessModelBudget(localRequest(), {
      modelCatalog: {
        local_lmstudio: { "qwen/qwen3-8b": { context_window: 8_192 } },
      },
    }),
    { contextWindow: 8_192, maxTokens: 4_096 },
  );
  assert.deepEqual(
    resolveHarnessModelBudget(localRequest(), {
      modelCatalog: {
        local_lmstudio: { "qwen/qwen3-8b": { context_window: 131_072 } },
      },
    }),
    { contextWindow: 131_072, maxTokens: 16_384 },
  );
  assert.deepEqual(
    resolveHarnessModelBudget(localRequest(), {
      modelCatalog: {
        local_lmstudio: {
          "qwen/qwen3-8b": { context_window: 65_536, max_tokens: 2_048 },
        },
      },
    }),
    { contextWindow: 65_536, maxTokens: 2_048 },
  );
});

test("runtime-config catalog threads input modalities and explicit local providers on non-local hosts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-model-routing-local-"));
  const configPath = path.join(root, "runtime-config.json");
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        local_box: {
          kind: "openai_compatible",
          base_url: "http://gpu-box.tailnet.ts.net:8000/v1",
          local: true,
        },
      },
      models: {
        "local_box/mlx-community/Qwen2.5-VL-7B-Instruct-4bit": {
          provider: "local_box",
          model: "mlx-community/Qwen2.5-VL-7B-Instruct-4bit",
          context_window: 16_384,
          input_modalities: ["text", "image"],
        },
      },
    }),
    "utf8",
  );
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;

  try {
    const catalog = runtimeConfigModelCatalog();
    const entry = catalog.local_box?.["mlx-community/Qwen2.5-VL-7B-Instruct-4bit"];
    assert.equal(entry?.local, true);
    assert.deepEqual(entry?.input, ["text", "image"]);

    const profile = resolveHarnessModelProfile(
      {
        provider_id: "local_box",
        model_id: "mlx-community/Qwen2.5-VL-7B-Instruct-4bit",
        model_client: {
          model_proxy_provider: "openai_compatible",
          api_key: "local",
          base_url: "http://gpu-box.tailnet.ts.net:8000/v1",
        },
      },
      { modelCatalog: mergeHarnessModelCatalogs(catalog) },
    );
    assert.deepEqual(profile.input, ["text", "image"]);
    assert.deepEqual(profile.budget, { contextWindow: 16_384, maxTokens: 8_192 });
    assert.equal(profile.compat?.supportsDeveloperRole, false);
  } finally {
    if (previousConfigPath === undefined) {
      delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
    } else {
      process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
