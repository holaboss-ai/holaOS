import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  nativeWebSearchPayload,
  searchPublicWeb,
  webSearchDescription,
} from "./native-web-search.js";

test("searchPublicWeb proxies hosted Exa MCP and returns the raw text block", async () => {
  const requests: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  const result = await searchPublicWeb({
    query: "latest alpha 2026",
    numResults: 3,
    livecrawl: "preferred",
    type: "deep",
    contextMaxCharacters: 12000,
    providerKind: "exa_hosted_mcp",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        [
          "event: message",
          'data: {"result":{"content":[{"type":"text","text":"Title: Alpha Result\\nURL: https://example.com/alpha\\nPublished: 2026-04-03T10:00:00.000Z\\nAuthor: Sam\\nHighlights:\\nAlpha summary"}]},"jsonrpc":"2.0","id":1}',
          "",
        ].join("\n"),
        {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }
      );
    },
  });

  assert.equal(result.text, "Title: Alpha Result\nURL: https://example.com/alpha\nPublished: 2026-04-03T10:00:00.000Z\nAuthor: Sam\nHighlights:\nAlpha summary");
  assert.equal(result.providerId, "exa_hosted_mcp");
  assert.equal(requests[0]?.url, "https://mcp.exa.ai/mcp");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query: "latest alpha 2026",
        numResults: 3,
        livecrawl: "preferred",
        type: "deep",
        contextMaxCharacters: 12000,
      },
    },
  });
});

test("nativeWebSearchPayload normalizes compatibility aliases and optional fields", () => {
  assert.deepEqual(
    nativeWebSearchPayload({
      query: "latest alpha 2026",
      max_results: 2,
      livecrawl: "preferred",
      type: "fast",
      context_max_characters: 9000,
    }),
    {
      query: "latest alpha 2026",
      numResults: 2,
      livecrawl: "preferred",
      type: "fast",
      contextMaxCharacters: 9000,
    }
  );
});

test("searchPublicWeb sends configured Exa API keys through hosted MCP query params", async () => {
  const requests: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  await searchPublicWeb({
    query: "latest alpha 2026",
    providerKind: "exa_hosted_mcp",
    apiKey: "exa-test-key",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        'event: message\ndata: {"result":{"content":[{"type":"text","text":"ok"}]},"jsonrpc":"2.0","id":1}\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }
      );
    },
  });

  const url = new URL(requests[0]?.url ?? "");
  assert.equal(url.origin + url.pathname, "https://mcp.exa.ai/mcp");
  assert.equal(url.searchParams.get("exaApiKey"), "exa-test-key");
  assert.equal(url.searchParams.get("tools"), "web_search_exa");
});

test("searchPublicWeb fails closed for the Holaboss provider when no user is resolved", async (t) => {
  // No runtime config → no user id. The Holaboss proxy path must refuse rather
  // than fire an unattributed request (the backend now rejects OpenRouter-bound
  // calls with no X-Holaboss-User-Id). Exa/BYO search (searchExa) is unaffected.
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  t.after(() => {
    if (previousConfigPath === undefined) {
      delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
    } else {
      process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
    }
  });

  let fetchCalled = false;
  await assert.rejects(
    () =>
      searchPublicWeb({
        query: "latest alpha 2026",
        numResults: 2,
        providerId: "holaboss_search",
        providerKind: "holaboss_search",
        baseUrl: "https://api.holaboss.test/api/v1/search/web",
        apiKey: "hb-search-key",
        fetchImpl: async () => {
          fetchCalled = true;
          return new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        },
      }),
    /requires a signed-in Holaboss account/,
  );
  // Must not have fired the request before failing closed.
  assert.equal(fetchCalled, false);
});

test("searchPublicWeb reads provider settings from runtime config", async (t) => {
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holaboss-search-"));
  t.after(async () => {
    if (previousConfigPath === undefined) {
      delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
    } else {
      process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
    }
    await rm(tempDir, { force: true, recursive: true });
  });

  const configPath = path.join(tempDir, "runtime-config.json");
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  await writeFile(
    configPath,
    JSON.stringify({
      control_plane_base_url: "https://api.holaboss.test",
      integrations: {
        holaboss: {
          auth_token: "runtime-search-key",
          user_id: "user-1",
          sandbox_id: "desktop:sandbox-1",
        },
      },
      web_search: {
        provider: "holaboss_search",
        providers: {
          holaboss_search: {
            kind: "holaboss_search",
          },
        },
      },
    }),
  );

  const requests: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  const result = await searchPublicWeb({
    query: "runtime configured search",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ text: "runtime result" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });

  assert.equal(result.providerId, "holaboss_search");
  assert.equal(result.text, "runtime result");
  assert.equal(requests[0]?.url, "https://api.holaboss.test/api/v1/search/web");
  assert.deepEqual(requests[0]?.init?.headers, {
    accept: "application/json",
    "content-type": "application/json",
    authorization: "Bearer runtime-search-key",
    "x-api-key": "runtime-search-key",
    "X-Holaboss-User-Id": "user-1",
    "X-Holaboss-Sandbox-Id": "desktop:sandbox-1",
  });
});

test("searchPublicWeb derives local Holaboss search URL from model proxy config", async (t) => {
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holaboss-search-"));
  t.after(async () => {
    if (previousConfigPath === undefined) {
      delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
    } else {
      process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
    }
    await rm(tempDir, { force: true, recursive: true });
  });

  const configPath = path.join(tempDir, "runtime-config.json");
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  await writeFile(
    configPath,
    JSON.stringify({
      model_proxy_base_url: "http://127.0.0.1:3060/api/v1/model-proxy",
      integrations: {
        holaboss: {
          auth_token: "runtime-search-key",
          user_id: "user-1",
          sandbox_id: "desktop:sandbox-1",
        },
      },
      web_search: {
        provider: "holaboss_search",
        providers: {
          holaboss_search: {
            kind: "holaboss_search",
          },
        },
      },
    }),
  );

  const requests: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  const result = await searchPublicWeb({
    query: "runtime configured search",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ text: "runtime result" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });

  assert.equal(result.providerId, "holaboss_search");
  assert.equal(result.text, "runtime result");
  assert.equal(requests[0]?.url, "http://127.0.0.1:3060/api/v1/search/web");
  assert.deepEqual(requests[0]?.init?.headers, {
    accept: "application/json",
    "content-type": "application/json",
    authorization: "Bearer runtime-search-key",
    "x-api-key": "runtime-search-key",
    "X-Holaboss-User-Id": "user-1",
    "X-Holaboss-Sandbox-Id": "desktop:sandbox-1",
  });
});

test("searchPublicWeb falls back to Exa when stale Holaboss search config has no managed binding", async (t) => {
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holaboss-search-"));
  t.after(async () => {
    if (previousConfigPath === undefined) {
      delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
    } else {
      process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
    }
    await rm(tempDir, { force: true, recursive: true });
  });

  const configPath = path.join(tempDir, "runtime-config.json");
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  await writeFile(
    configPath,
    JSON.stringify({
      control_plane_base_url: "https://api.imerchstaging.com/gateway/sandbox",
      web_search: {
        provider: "holaboss_search",
        providers: {
          holaboss_search: {
            kind: "holaboss_search",
          },
          exa: {
            kind: "exa_hosted_mcp",
          },
        },
      },
    }),
  );

  const requests: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  const result = await searchPublicWeb({
    query: "runtime configured search",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        'event: message\ndata: {"result":{"content":[{"type":"text","text":"exa fallback result"}]},"jsonrpc":"2.0","id":1}\n',
        {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        },
      );
    },
  });

  assert.equal(result.providerId, "exa_hosted_mcp");
  assert.equal(result.text, "exa fallback result");
  assert.equal(requests[0]?.url, "https://mcp.exa.ai/mcp");
});

test("searchPublicWeb preserves sandbox gateway prefixes when deriving Holaboss search URL from model proxy config", async (t) => {
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holaboss-search-"));
  t.after(async () => {
    if (previousConfigPath === undefined) {
      delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
    } else {
      process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
    }
    await rm(tempDir, { force: true, recursive: true });
  });

  const configPath = path.join(tempDir, "runtime-config.json");
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  await writeFile(
    configPath,
    JSON.stringify({
      model_proxy_base_url:
        "https://api.imerchstaging.com/gateway/sandbox/api/v1/model-proxy",
      integrations: {
        holaboss: {
          auth_token: "runtime-search-key",
          user_id: "user-1",
          sandbox_id: "desktop:sandbox-1",
        },
      },
      web_search: {
        provider: "holaboss_search",
        providers: {
          holaboss_search: {
            kind: "holaboss_search",
          },
        },
      },
    }),
  );

  const requests: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  const result = await searchPublicWeb({
    query: "gateway configured search",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ text: "gateway result" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });

  assert.equal(result.providerId, "holaboss_search");
  assert.equal(result.text, "gateway result");
  assert.equal(
    requests[0]?.url,
    "https://api.imerchstaging.com/gateway/sandbox/api/v1/search/web",
  );
});

test("searchPublicWeb maps local control plane URL to Holaboss search service", async (t) => {
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holaboss-search-"));
  t.after(async () => {
    if (previousConfigPath === undefined) {
      delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
    } else {
      process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
    }
    await rm(tempDir, { force: true, recursive: true });
  });

  const configPath = path.join(tempDir, "runtime-config.json");
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  await writeFile(
    configPath,
    JSON.stringify({
      control_plane_base_url: "http://127.0.0.1:3060",
      integrations: {
        holaboss: {
          auth_token: "runtime-search-key",
          user_id: "user-1",
          sandbox_id: "desktop:sandbox-1",
        },
      },
    }),
  );

  const requests: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  await searchPublicWeb({
    query: "runtime configured search",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ text: "runtime result" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });

  assert.equal(requests[0]?.url, "http://127.0.0.1:3060/api/v1/search/web");
});

test("searchPublicWeb explicit Holaboss provider inherits runtime binding", async (t) => {
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holaboss-search-"));
  t.after(async () => {
    if (previousConfigPath === undefined) {
      delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
    } else {
      process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
    }
    await rm(tempDir, { force: true, recursive: true });
  });

  const configPath = path.join(tempDir, "runtime-config.json");
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  await writeFile(
    configPath,
    JSON.stringify({
      model_proxy_base_url: "http://127.0.0.1:3060/api/v1/model-proxy",
      integrations: {
        holaboss: {
          auth_token: "runtime-search-key",
          user_id: "user-1",
          sandbox_id: "desktop:sandbox-1",
        },
      },
    }),
  );

  const requests: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  await searchPublicWeb({
    query: "runtime configured search",
    providerKind: "holaboss_search",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ text: "runtime result" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });

  assert.equal(requests[0]?.url, "http://127.0.0.1:3060/api/v1/search/web");
  assert.deepEqual(requests[0]?.init?.headers, {
    accept: "application/json",
    "content-type": "application/json",
    authorization: "Bearer runtime-search-key",
    "x-api-key": "runtime-search-key",
    "X-Holaboss-User-Id": "user-1",
    "X-Holaboss-Sandbox-Id": "desktop:sandbox-1",
  });
});

test("searchPublicWeb preserves sandbox gateway prefixes when deriving Holaboss search URL from control plane config", async (t) => {
  const previousConfigPath = process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "holaboss-search-"));
  t.after(async () => {
    if (previousConfigPath === undefined) {
      delete process.env.HOLABOSS_RUNTIME_CONFIG_PATH;
    } else {
      process.env.HOLABOSS_RUNTIME_CONFIG_PATH = previousConfigPath;
    }
    await rm(tempDir, { force: true, recursive: true });
  });

  const configPath = path.join(tempDir, "runtime-config.json");
  process.env.HOLABOSS_RUNTIME_CONFIG_PATH = configPath;
  await writeFile(
    configPath,
    JSON.stringify({
      control_plane_base_url: "https://api.imerchstaging.com/gateway/sandbox",
      integrations: {
        holaboss: {
          auth_token: "runtime-search-key",
          user_id: "user-1",
          sandbox_id: "desktop:sandbox-1",
        },
      },
    }),
  );

  const requests: Array<{
    url: string;
    init?: RequestInit;
  }> = [];
  const result = await searchPublicWeb({
    query: "gateway control plane search",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(
        JSON.stringify({ text: "gateway control plane result" }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    },
  });

  assert.equal(result.providerId, "holaboss_search");
  assert.equal(result.text, "gateway control plane result");
  assert.equal(
    requests[0]?.url,
    "https://api.imerchstaging.com/gateway/sandbox/api/v1/search/web",
  );
});

test("searchPublicWeb requires a non-empty query", async () => {
  await assert.rejects(async () => await searchPublicWeb({ query: "   " }), /query is required/);
});

test("searchPublicWeb surfaces HTTP errors from the hosted MCP endpoint", async () => {
  await assert.rejects(
    async () =>
      await searchPublicWeb({
        query: "alpha 2026",
        providerKind: "exa_hosted_mcp",
        fetchImpl: async () =>
          new Response("upstream unavailable", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      }),
    /web_search failed with status 503: upstream unavailable/
  );
});

test("webSearchDescription includes the current year guidance", () => {
  assert.match(webSearchDescription("Search the web."), new RegExp(String(new Date().getFullYear())));
});
