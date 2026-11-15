import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";

import Fastify from "fastify";

import { registerLocalModelRoutes } from "./local-model-routes.js";

const servers: http.Server[] = [];
const tempDirs: string[] = [];
const originalConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;

after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

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

async function startLmStudioLikeServer(): Promise<string> {
  const server = http.createServer((request, response) => {
    const pathname = (request.url ?? "/").split("?")[0];
    const payloads: Record<string, unknown> = {
      "/v1/models": { object: "list", data: [{ id: "qwen/qwen3-8b" }, { id: "google/gemma-3-4b" }] },
      "/api/v0/models": {
        object: "list",
        data: [
          { id: "qwen/qwen3-8b", type: "llm", state: "loaded", loaded_context_length: 32768 },
          { id: "google/gemma-3-4b", type: "vlm", state: "not-loaded", max_context_length: 131072 },
        ],
      },
    };
    const payload = payloads[pathname];
    response.writeHead(payload ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(payload ?? { error: "not found" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function onlyReach(root: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(`${root}/`)) {
      throw new TypeError("fetch failed: connect ECONNREFUSED");
    }
    return await fetch(input, init);
  }) as typeof fetch;
}

function useConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-local-model-routes-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "runtime-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ providers: { other: { kind: "openrouter" } } }), "utf8");
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  return configPath;
}

test("discover → register subset → rediscover → delete", async () => {
  const root = await startLmStudioLikeServer();
  const configPath = useConfigPath();
  const port = new URL(root).port;
  const app = Fastify();
  registerLocalModelRoutes(app, { fetchImpl: onlyReach(root) });

  const discovered = await app.inject({
    method: "GET",
    url: `/api/v1/local-models/discover?base_url=${encodeURIComponent(root)}`,
  });
  assert.equal(discovered.statusCode, 200);
  const discoverBody = discovered.json();
  assert.equal(discoverBody.errors.length, 0);
  assert.equal(discoverBody.endpoints.length, 1);
  assert.equal(discoverBody.endpoints[0].engine, "lmstudio");
  assert.equal(discoverBody.endpoints[0].provider_id, `local_lmstudio_${port}`);
  assert.equal(discoverBody.endpoints[0].registered, false);
  assert.equal(discoverBody.endpoints[0].models[0].token, `local_lmstudio_${port}/qwen/qwen3-8b`);

  const unknown = await app.inject({
    method: "POST",
    url: "/api/v1/local-models/register",
    payload: { base_url: root, models: ["does-not-exist"] },
  });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.json().detail, /does-not-exist/);

  const registered = await app.inject({
    method: "POST",
    url: "/api/v1/local-models/register",
    payload: { base_url: `${root}/v1`, models: ["qwen/qwen3-8b"] },
  });
  assert.equal(registered.statusCode, 200);
  const registerBody = registered.json();
  assert.equal(registerBody.provider_id, `local_lmstudio_${port}`);
  assert.deepEqual(
    registerBody.models.map((model: { token: string }) => model.token),
    [`local_lmstudio_${port}/qwen/qwen3-8b`],
  );
  const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(written.providers.other, { kind: "openrouter" });
  assert.equal(written.models[`local_lmstudio_${port}/qwen/qwen3-8b`].context_window, 32768);

  const rediscovered = (
    await app.inject({ method: "GET", url: `/api/v1/local-models/discover?base_url=${encodeURIComponent(root)}` })
  ).json();
  assert.equal(rediscovered.endpoints[0].registered, true);
  assert.deepEqual(
    rediscovered.endpoints[0].models.map((model: { registered: boolean }) => model.registered),
    [true, false],
  );

  const removed = await app.inject({ method: "DELETE", url: `/api/v1/local-models/local_lmstudio_${port}` });
  assert.equal(removed.statusCode, 200);
  const missing = await app.inject({ method: "DELETE", url: `/api/v1/local-models/local_lmstudio_${port}` });
  assert.equal(missing.statusCode, 404);
  const protectedProvider = await app.inject({ method: "DELETE", url: "/api/v1/local-models/other" });
  assert.equal(protectedProvider.statusCode, 400);

  await app.close();
});

test("register reports an unreachable server and a bad engine clearly", async () => {
  useConfigPath();
  const app = Fastify();
  registerLocalModelRoutes(app, { fetchImpl: onlyReach("http://127.0.0.1:1") });

  const unreachable = await app.inject({
    method: "POST",
    url: "/api/v1/local-models/register",
    payload: { base_url: "http://127.0.0.1:65531" },
  });
  assert.equal(unreachable.statusCode, 502);
  assert.match(unreachable.json().detail, /already running/);

  const badEngine = await app.inject({
    method: "POST",
    url: "/api/v1/local-models/register",
    payload: { base_url: "http://127.0.0.1:65531", engine: "tensorrt" },
  });
  assert.equal(badEngine.statusCode, 400);

  const missingBaseUrl = await app.inject({ method: "POST", url: "/api/v1/local-models/register", payload: {} });
  assert.equal(missingBaseUrl.statusCode, 400);

  await app.close();
});
