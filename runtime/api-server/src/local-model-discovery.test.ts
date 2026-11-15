import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";

import {
  discoverLocalModelEndpoints,
  isLocalModelEndpointError,
  localModelServerRoot,
  normalizeLocalModelBaseUrl,
  probeLocalModelEndpoint,
  type LocalModelEndpoint,
} from "./local-model-discovery.js";

type RouteHandler = (body: unknown) => { status?: number; json?: unknown; hang?: boolean };
type Routes = Record<string, RouteHandler>;

const servers: http.Server[] = [];

after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

async function startFakeServer(routes: Routes): Promise<string> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const pathname = (request.url ?? "/").split("?")[0];
      const handler = routes[`${request.method} ${pathname}`];
      if (!handler) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const result = handler(raw ? JSON.parse(raw) : undefined);
      if (result.hang) {
        return;
      }
      response.writeHead(result.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(result.json ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function onlyReach(...roots: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!roots.some((root) => url.startsWith(`${root}/`))) {
      throw new TypeError("fetch failed: connect ECONNREFUSED");
    }
    return await fetch(input, init);
  }) as typeof fetch;
}

function endpointsOnly(entries: Awaited<ReturnType<typeof discoverLocalModelEndpoints>>): LocalModelEndpoint[] {
  return entries.filter((entry): entry is LocalModelEndpoint => !isLocalModelEndpointError(entry));
}

test("base URLs normalize with or without scheme and /v1", () => {
  assert.equal(localModelServerRoot("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234");
  assert.equal(localModelServerRoot("localhost:11434"), "http://localhost:11434");
  assert.equal(normalizeLocalModelBaseUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1");
  assert.equal(normalizeLocalModelBaseUrl("https://gpu-box:8000/proxy/v1"), "https://gpu-box:8000/proxy/v1");
  assert.throws(() => localModelServerRoot("ftp://example.com"), /http/);
});

test("ollama: served context from /api/ps or Modelfile num_ctx, model max kept separately", async () => {
  const shows: Record<string, unknown> = {
    "llama3.2:3b": {
      capabilities: ["completion", "tools"],
      model_info: { "general.architecture": "llama", "llama.context_length": 131072 },
      parameters: "stop <|eot_id|>",
    },
    "llava:7b": {
      capabilities: ["completion", "vision"],
      model_info: { "llama.context_length": 32768 },
      parameters: "num_ctx 8192\nstop </s>",
    },
    "nomic-embed-text:latest": {
      capabilities: ["embedding"],
      model_info: { "nomic-bert.context_length": 2048 },
    },
  };
  const root = await startFakeServer({
    "GET /api/version": () => ({ json: { version: "0.12.3" } }),
    "GET /v1/models": () => ({ json: { object: "list", data: [] } }),
    "GET /api/tags": () => ({
      json: { models: Object.keys(shows).map((name) => ({ name, model: name })) },
    }),
    "GET /api/ps": () => ({ json: { models: [{ name: "llama3.2:3b", model: "llama3.2:3b", context_length: 4096 }] } }),
    "POST /api/show": (body) => {
      const name = (body as { model?: string }).model ?? "";
      return shows[name] ? { json: shows[name] } : { status: 404, json: { error: "missing" } };
    },
  });

  const endpoint = await probeLocalModelEndpoint(root);
  assert.equal(endpoint.engine, "ollama");
  assert.equal(endpoint.engine_version, "0.12.3");
  assert.equal(endpoint.base_url, `${root}/v1`);
  assert.deepEqual(endpoint.models, [
    { id: "llama3.2:3b", context_window: 4096, max_context_window: 131072, loaded: true, supports_vision: false },
    { id: "llava:7b", context_window: 8192, max_context_window: 32768, loaded: false, supports_vision: true },
  ]);
});

test("lmstudio: loaded context is served context; unloaded models only report their max", async () => {
  const root = await startFakeServer({
    "GET /v1/models": () => ({
      json: { object: "list", data: [{ id: "qwen/qwen3-8b", object: "model", owned_by: "organization_owner" }] },
    }),
    "GET /api/v0/models": () => ({
      json: {
        object: "list",
        data: [
          {
            id: "qwen/qwen3-8b",
            type: "llm",
            state: "loaded",
            max_context_length: 40960,
            loaded_context_length: 32768,
          },
          { id: "google/gemma-3-4b", type: "vlm", state: "not-loaded", max_context_length: 131072 },
          { id: "text-embedding-nomic-embed-text-v1.5", type: "embeddings", state: "not-loaded" },
        ],
      },
    }),
  });

  const endpoint = await probeLocalModelEndpoint(`${root}/v1`);
  assert.equal(endpoint.engine, "lmstudio");
  assert.deepEqual(endpoint.models, [
    { id: "qwen/qwen3-8b", context_window: 32768, max_context_window: 40960, loaded: true, supports_vision: false },
    { id: "google/gemma-3-4b", max_context_window: 131072, loaded: false, supports_vision: true },
  ]);
});

test("llama.cpp: /props n_ctx, build_info, modalities", async () => {
  const root = await startFakeServer({
    "GET /v1/models": () => ({
      json: {
        object: "list",
        data: [{ id: "MiniCPM5-2B-Q4_K_M.gguf", object: "model", owned_by: "llamacpp", meta: { n_ctx_train: 32768 } }],
      },
    }),
    "GET /props": () => ({
      json: {
        default_generation_settings: { n_ctx: 8192 },
        total_slots: 1,
        model_path: "/models/MiniCPM5-2B-Q4_K_M.gguf",
        modalities: { vision: false, audio: false },
        build_info: "b6500-abc123",
      },
    }),
  });

  const endpoint = await probeLocalModelEndpoint(root);
  assert.equal(endpoint.engine, "llamacpp");
  assert.equal(endpoint.engine_version, "b6500-abc123");
  assert.deepEqual(endpoint.models, [
    { id: "MiniCPM5-2B-Q4_K_M.gguf", context_window: 8192, loaded: true, supports_vision: false },
  ]);
});

test("llama.cpp: a single model reported as a GGUF path is exposed by its file name", async () => {
  const modelPath = "/Users/me/models/MiniCPM5-2B-Q4_K_M.gguf";
  const root = await startFakeServer({
    "GET /v1/models": () => ({ json: { object: "list", data: [{ id: modelPath, owned_by: "llamacpp" }] } }),
    "GET /props": () => ({
      json: { default_generation_settings: { n_ctx: 8192 }, model_alias: modelPath, model_path: modelPath },
    }),
  });

  const endpoint = await probeLocalModelEndpoint(root);
  assert.deepEqual(endpoint.models, [{ id: "MiniCPM5-2B-Q4_K_M", context_window: 8192, loaded: true }]);
});

test("vllm: /version and max_model_len", async () => {
  const root = await startFakeServer({
    "GET /version": () => ({ json: { version: "0.11.0" } }),
    "GET /v1/models": () => ({
      json: {
        object: "list",
        data: [{ id: "Qwen/Qwen3-8B", object: "model", owned_by: "vllm", max_model_len: 40960 }],
      },
    }),
  });

  const endpoint = await probeLocalModelEndpoint(root);
  assert.equal(endpoint.engine, "vllm");
  assert.equal(endpoint.engine_version, "0.11.0");
  assert.deepEqual(endpoint.models, [{ id: "Qwen/Qwen3-8B", context_window: 40960, loaded: true }]);
});

test("sglang: /get_model_info and server context length", async () => {
  const root = await startFakeServer({
    "GET /get_model_info": () => ({ json: { model_path: "Qwen/Qwen3-4B", is_generation: true } }),
    "GET /get_server_info": () => ({ json: { version: "0.5.2", context_length: 32768 } }),
    "GET /v1/models": () => ({
      json: { object: "list", data: [{ id: "Qwen/Qwen3-4B", object: "model", owned_by: "sglang" }] },
    }),
  });

  const endpoint = await probeLocalModelEndpoint(root);
  assert.equal(endpoint.engine, "sglang");
  assert.equal(endpoint.engine_version, "0.5.2");
  assert.deepEqual(endpoint.models, [{ id: "Qwen/Qwen3-4B", context_window: 32768, loaded: true }]);
});

test("generic /v1/models falls back to openai_compatible, or mlx for mlx models", async () => {
  const generic = await startFakeServer({
    "GET /v1/models": () => ({
      json: {
        object: "list",
        data: [
          { id: "my-model", object: "model", context_length: 16384 },
          { id: "bge-embedding-small", object: "model" },
        ],
      },
    }),
  });
  const mlx = await startFakeServer({
    "GET /v1/models": () => ({
      json: { object: "list", data: [{ id: "mlx-community/Qwen3-4B-4bit", object: "model", created: 1 }] },
    }),
  });

  const genericEndpoint = await probeLocalModelEndpoint(generic);
  assert.equal(genericEndpoint.engine, "openai_compatible");
  assert.deepEqual(genericEndpoint.models, [{ id: "my-model", context_window: 16384 }]);

  const mlxEndpoint = await probeLocalModelEndpoint(mlx);
  assert.equal(mlxEndpoint.engine, "mlx");
  assert.deepEqual(mlxEndpoint.models, [{ id: "mlx-community/Qwen3-4B-4bit" }]);
});

test("discover omits unreachable defaults, reports explicit failures, and dedupes explicit URLs", async () => {
  const vllm = await startFakeServer({
    "GET /version": () => ({ json: { version: "0.11.0" } }),
    "GET /v1/models": () => ({ json: { object: "list", data: [{ id: "m", owned_by: "vllm" }] } }),
  });
  const notAModelServer = await startFakeServer({});
  const deadUrl = "http://127.0.0.1:9";

  const entries = await discoverLocalModelEndpoints({
    baseUrls: [`${vllm}/v1`, vllm.replace("http://", ""), notAModelServer, deadUrl, "ftp://nope"],
    fetchImpl: onlyReach(vllm, notAModelServer),
  });

  const endpoints = endpointsOnly(entries);
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].base_url, `${vllm}/v1`);
  assert.equal(endpoints[0].engine, "vllm");

  const errors = entries.filter(isLocalModelEndpointError);
  assert.deepEqual(
    errors.map((entry) => entry.base_url).sort(),
    [`${deadUrl}/v1`, `${notAModelServer}/v1`, "ftp://nope"].sort(),
  );
  assert.match(errors.find((entry) => entry.base_url === `${deadUrl}/v1`)!.error, /already running/);
  assert.match(
    errors.find((entry) => entry.base_url === `${notAModelServer}/v1`)!.error,
    /not like a model server/,
  );
});

test("a server that never answers is bounded by the probe timeout", async () => {
  const hanging = await startFakeServer({
    "GET /v1/models": () => ({ hang: true }),
    "GET /api/version": () => ({ hang: true }),
  });

  const startedAt = Date.now();
  const entries = await discoverLocalModelEndpoints({
    baseUrls: [hanging],
    timeoutMs: 200,
    fetchImpl: onlyReach(hanging),
  });
  assert.ok(Date.now() - startedAt < 2000, "discovery should finish within a few timeouts");
  assert.equal(entries.length, 1);
  assert.ok(isLocalModelEndpointError(entries[0]));
});
