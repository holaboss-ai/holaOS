import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { ensureLocalModelReady, LocalModelNotReadyError } from "./local-model-preflight.js";

const tempDirs: string[] = [];
const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (previousConfigPath === undefined) {
    delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  } else {
    process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
  }
});

function useLocalProvider(providerId: string, engine: string, modelId: string, contextWindow?: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-local-preflight-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "runtime-config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        holaboss_model_proxy: { kind: "holaboss_proxy" },
        [providerId]: { kind: "openai_compatible", base_url: "http://127.0.0.1:9999/v1", api_key: "local", local: true, engine },
      },
      models: {
        [`${providerId}/${modelId}`]: {
          provider: providerId,
          model: modelId,
          ...(contextWindow ? { context_window: contextWindow } : {}),
        },
      },
    }),
    "utf8",
  );
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  return configPath;
}

function fakeFetch(routes: Record<string, () => unknown>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    calls.push(key);
    const handler = routes[key];
    if (!handler) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(handler()), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function contextWindowIn(configPath: string, token: string): unknown {
  return JSON.parse(fs.readFileSync(configPath, "utf8")).models[token].context_window;
}

test("llama.cpp served with a small context is refused with -c advice, and the real size is recorded", async () => {
  const configPath = useLocalProvider("local_llamacpp_1234", "llamacpp", "m", 32768);
  const fetchImpl = fakeFetch({ "GET /props": () => ({ default_generation_settings: { n_ctx: 8192 } }) });
  await assert.rejects(
    ensureLocalModelReady({ providerId: "local_llamacpp_1234", modelId: "m" }, { fetchImpl }),
    (error: unknown) =>
      error instanceof LocalModelNotReadyError && /context window of 8,192 tokens/.test(error.message) && /-c 32768/.test(error.message),
  );
  assert.equal(contextWindowIn(configPath, "local_llamacpp_1234/m"), 8192);
});

test("llama.cpp with enough context passes", async () => {
  const configPath = useLocalProvider("local_llamacpp", "llamacpp", "m");
  const fetchImpl = fakeFetch({ "GET /props": () => ({ default_generation_settings: { n_ctx: 32768 } }) });
  await ensureLocalModelReady({ providerId: "local_llamacpp", modelId: "m" }, { fetchImpl });
  assert.equal(contextWindowIn(configPath, "local_llamacpp/m"), 32768);
});

test("ollama loads an unloaded model to read the context it actually serves", async () => {
  useLocalProvider("local_ollama", "ollama", "qwen3:8b");
  let loaded = false;
  const calls: string[] = [];
  const fetchImpl = fakeFetch(
    {
      "GET /api/ps": () => ({ models: loaded ? [{ name: "qwen3:8b", context_length: 4096 }] : [] }),
      "POST /api/generate": () => {
        loaded = true;
        return { done: true };
      },
    },
    calls,
  );
  await assert.rejects(
    ensureLocalModelReady({ providerId: "local_ollama", modelId: "qwen3:8b" }, { fetchImpl }),
    (error: unknown) => error instanceof LocalModelNotReadyError && /OLLAMA_CONTEXT_LENGTH=32768/.test(error.message),
  );
  assert.deepEqual(calls, ["GET /api/ps", "POST /api/generate", "GET /api/ps"]);
});

test("lmstudio uses the loaded context length", async () => {
  useLocalProvider("local_lmstudio", "lmstudio", "qwen/qwen3-8b");
  const fetchImpl = fakeFetch({
    "GET /api/v0/models": () => ({ data: [{ id: "qwen/qwen3-8b", state: "loaded", loaded_context_length: 32768 }] }),
  });
  await ensureLocalModelReady({ providerId: "local_lmstudio", modelId: "qwen/qwen3-8b" }, { fetchImpl });
});

test("an unreachable server gets a clear message", async () => {
  useLocalProvider("local_llamacpp", "llamacpp", "m");
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(
    ensureLocalModelReady({ providerId: "local_llamacpp", modelId: "m" }, { fetchImpl }),
    (error: unknown) => error instanceof LocalModelNotReadyError && /not responding/.test(error.message),
  );
});

test("engines without a served-context API and non-local providers are not checked", async () => {
  useLocalProvider("local_mlx", "mlx", "m");
  const calls: string[] = [];
  await ensureLocalModelReady({ providerId: "local_mlx", modelId: "m" }, { fetchImpl: fakeFetch({}, calls) });
  await ensureLocalModelReady({ providerId: "holaboss_model_proxy", modelId: "gpt-5.5" }, { fetchImpl: fakeFetch({}, calls) });
  await ensureLocalModelReady({ providerId: "openai", modelId: "gpt-5.5" }, { fetchImpl: fakeFetch({}, calls) });
  assert.deepEqual(calls, []);
});
