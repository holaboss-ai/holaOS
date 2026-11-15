import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  localModelProviderId,
  readLocalModelProviders,
  registerLocalModelProvider,
  RuntimeConfigServiceError,
  unregisterLocalModelProvider,
  updateRuntimeConfigDocument,
} from "./runtime-config.js";

const tempDirs: string[] = [];
const originalConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalConfigPath === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = originalConfigPath;
  }
});

function useConfig(document: Record<string, unknown> | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-local-models-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "state", "runtime-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (document) {
    fs.writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  return configPath;
}

function readConfig(configPath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

const existingDocument = {
  runtime: { default_model: "holaboss_model_proxy/gpt-5.4", custom_flag: true },
  providers: {
    holaboss_model_proxy: { kind: "holaboss_proxy", base_url: "https://proxy.example/v1", api_key: "secret" },
    my_openrouter: { kind: "openrouter", api_key: "or-key" },
  },
  models: {
    "my_openrouter/meta-llama/llama-4": { provider: "my_openrouter", model: "meta-llama/llama-4" },
  },
  integrations: { holaboss: { auth_token: "secret", user_id: "u1" } },
  unknown_top_level: { keep: ["me"] },
};

test("provider ids: local_<engine> on the default port, port suffix otherwise, host for non-loopback", () => {
  assert.equal(localModelProviderId("http://127.0.0.1:1234/v1", "lmstudio"), "local_lmstudio");
  assert.equal(localModelProviderId("http://localhost:11434", "ollama"), "local_ollama");
  assert.equal(localModelProviderId("http://127.0.0.1:8080/v1", "mlx"), "local_mlx");
  assert.equal(localModelProviderId("http://127.0.0.1:4321/v1", "lmstudio"), "local_lmstudio_4321");
  assert.equal(localModelProviderId("http://127.0.0.1:9000/v1", "openai_compatible"), "local_openai_compatible_9000");
  assert.equal(localModelProviderId("http://192.168.1.20:11434/v1", "ollama"), "local_ollama_192_168_1_20_11434");
});

test("register writes the canonical provider + models and preserves every other key", () => {
  const configPath = useConfig(existingDocument);

  const result = registerLocalModelProvider({
    baseUrl: "http://127.0.0.1:1234",
    engine: "lmstudio",
    models: [
      { id: "qwen/qwen3-8b", context_window: 32768 },
      { id: "google/gemma-3-4b", supports_vision: true },
    ],
  });

  assert.equal(result.provider_id, "local_lmstudio");
  assert.equal(result.base_url, "http://127.0.0.1:1234/v1");
  assert.deepEqual(
    result.models.map((model) => model.token),
    ["local_lmstudio/qwen/qwen3-8b", "local_lmstudio/google/gemma-3-4b"],
  );

  const written = readConfig(configPath);
  assert.deepEqual(written.providers.local_lmstudio, {
    kind: "openai_compatible",
    base_url: "http://127.0.0.1:1234/v1",
    api_key: "local",
    local: true,
    engine: "lmstudio",
  });
  assert.deepEqual(written.models["local_lmstudio/qwen/qwen3-8b"], {
    provider: "local_lmstudio",
    model: "qwen/qwen3-8b",
    context_window: 32768,
    input_modalities: ["text"],
  });
  assert.deepEqual(written.models["local_lmstudio/google/gemma-3-4b"], {
    provider: "local_lmstudio",
    model: "google/gemma-3-4b",
    input_modalities: ["text", "image"],
  });
  assert.deepEqual(written.runtime, existingDocument.runtime);
  assert.deepEqual(written.integrations, existingDocument.integrations);
  assert.deepEqual(written.unknown_top_level, existingDocument.unknown_top_level);
  assert.deepEqual(written.providers.holaboss_model_proxy, existingDocument.providers.holaboss_model_proxy);
  assert.deepEqual(written.providers.my_openrouter, existingDocument.providers.my_openrouter);
  assert.deepEqual(
    written.models["my_openrouter/meta-llama/llama-4"],
    existingDocument.models["my_openrouter/meta-llama/llama-4"],
  );
  assert.deepEqual(
    fs.readdirSync(path.dirname(configPath)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("re-registering replaces that provider's models, keeps per-model extras and other providers", () => {
  const configPath = useConfig({
    ...existingDocument,
    providers: {
      ...existingDocument.providers,
      local_ollama: { kind: "openai_compatible", base_url: "http://127.0.0.1:11434/v1", local: true, headers: { x: "1" } },
    },
    models: {
      ...existingDocument.models,
      "local_ollama/llama3.2:3b": { provider: "local_ollama", model: "llama3.2:3b", label: "Llama (mine)" },
      "local_ollama/old-model": { provider: "local_ollama", model: "old-model" },
      "stray-token": { provider_id: "local_ollama", model_id: "stray" },
    },
  });

  const result = registerLocalModelProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    engine: "ollama",
    models: [{ id: "llama3.2:3b", context_window: 131072 }],
  });

  assert.deepEqual(result.removed_model_tokens.sort(), ["local_ollama/old-model", "stray-token"]);
  const written = readConfig(configPath);
  assert.deepEqual(Object.keys(written.models).sort(), [
    "local_ollama/llama3.2:3b",
    "my_openrouter/meta-llama/llama-4",
  ]);
  assert.deepEqual(written.models["local_ollama/llama3.2:3b"], {
    label: "Llama (mine)",
    provider: "local_ollama",
    model: "llama3.2:3b",
    context_window: 131072,
    input_modalities: ["text"],
  });
  assert.deepEqual(written.providers.local_ollama.headers, { x: "1" });
  assert.equal(written.providers.local_ollama.engine, "ollama");
  assert.equal(written.providers.local_ollama.api_key, "local");

  assert.deepEqual(readLocalModelProviders(), [
    {
      provider_id: "local_ollama",
      base_url: "http://127.0.0.1:11434/v1",
      engine: "ollama",
      model_ids: ["llama3.2:3b"],
      context_windows: { "llama3.2:3b": 131072 },
    },
  ]);
});

test("register creates the config file when missing and refuses an empty model list", () => {
  const configPath = useConfig(null);
  assert.throws(
    () => registerLocalModelProvider({ baseUrl: "http://127.0.0.1:8080", engine: "llamacpp", models: [] }),
    (error: unknown) => error instanceof RuntimeConfigServiceError && error.statusCode === 400,
  );
  assert.equal(fs.existsSync(configPath), false);

  registerLocalModelProvider({
    baseUrl: "http://127.0.0.1:8080",
    engine: "llamacpp",
    models: [{ id: "MiniCPM5-2B-Q4_K_M.gguf", context_window: 8192 }],
  });
  const written = readConfig(configPath);
  assert.equal(written.providers.local_llamacpp.base_url, "http://127.0.0.1:8080/v1");
  assert.ok(written.models["local_llamacpp/MiniCPM5-2B-Q4_K_M.gguf"]);
});

test("register leaves a corrupt config untouched", () => {
  const configPath = useConfig(null);
  fs.writeFileSync(configPath, "{ not json", "utf8");
  assert.throws(
    () =>
      registerLocalModelProvider({
        baseUrl: "http://127.0.0.1:1234",
        engine: "lmstudio",
        models: [{ id: "m" }],
      }),
    RuntimeConfigServiceError,
  );
  assert.equal(fs.readFileSync(configPath, "utf8"), "{ not json");
});

test("unregister removes only that provider and its models, and refuses non-local ids", () => {
  const configPath = useConfig(existingDocument);
  registerLocalModelProvider({
    baseUrl: "http://127.0.0.1:1234",
    engine: "lmstudio",
    models: [{ id: "qwen/qwen3-8b" }],
  });

  assert.throws(() => unregisterLocalModelProvider("my_openrouter"), RuntimeConfigServiceError);
  assert.equal(unregisterLocalModelProvider("local_unknown").removed, false);

  const result = unregisterLocalModelProvider("local_lmstudio");
  assert.equal(result.removed, true);
  assert.deepEqual(result.removed_model_tokens, ["local_lmstudio/qwen/qwen3-8b"]);
  const written = readConfig(configPath);
  assert.deepEqual(written.providers, existingDocument.providers);
  assert.deepEqual(written.models, existingDocument.models);
  assert.deepEqual(written.unknown_top_level, existingDocument.unknown_top_level);
});

test("the runtime config update path keeps registered local providers", () => {
  const configPath = useConfig(existingDocument);
  registerLocalModelProvider({
    baseUrl: "http://127.0.0.1:1234",
    engine: "lmstudio",
    models: [{ id: "qwen/qwen3-8b" }],
  });

  updateRuntimeConfigDocument({ default_model: "local_lmstudio/qwen/qwen3-8b" });

  const written = readConfig(configPath);
  assert.equal(written.runtime.default_model, "local_lmstudio/qwen/qwen3-8b");
  assert.equal(written.providers.local_lmstudio.engine, "lmstudio");
  assert.ok(written.models["local_lmstudio/qwen/qwen3-8b"]);
});
