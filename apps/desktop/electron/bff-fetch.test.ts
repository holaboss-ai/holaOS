import test from "node:test";
import assert from "node:assert/strict";
import type { IpcMainInvokeEvent } from "electron";

import {
  installBffFetchHandler,
  BffFetchAllowlistError,
  type BffFetchHandlerDeps,
  type BffFetchLogEvent,
} from "./bff-fetch.js";
import {
  BFF_FETCH_CHANNEL,
  type BffFetchRequest,
  type BffFetchResponse,
} from "../shared/bff-fetch-protocol.js";

interface Harness {
  invoke: (req: BffFetchRequest) => Promise<BffFetchResponse>;
  events: BffFetchLogEvent[];
  fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
}

function harness(
  overrides: Partial<BffFetchHandlerDeps> = {},
  responder: (req: BffFetchRequest) => Promise<Response> | Response = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
): Harness {
  const events: BffFetchLogEvent[] = [];
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    const signal = init?.signal;
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }
    const work = Promise.resolve(
      responder({
        url: String(url),
        method: init?.method ?? "GET",
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: typeof init?.body === "string" ? init.body : undefined,
      }),
    );
    if (!signal) {
      return work;
    }
    // Race the responder against the abort signal so the in-test timeout
    // path actually rejects instead of hanging forever.
    return await new Promise<Response>((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("aborted")),
        { once: true },
      );
      work.then(resolve, reject);
    });
  }) as typeof fetch;

  let registered: ((event: IpcMainInvokeEvent, req: BffFetchRequest) => Promise<BffFetchResponse>) | null = null;
  installBffFetchHandler({
    getCookieHeader: () => "session=abc; csrf=xyz",
    allowedHosts: () => ["api.holaboss.ai", "api.imerchstaging.com"],
    register: (channel, handler) => {
      assert.equal(channel, BFF_FETCH_CHANNEL);
      registered = handler as (
        event: IpcMainInvokeEvent,
        req: BffFetchRequest,
      ) => Promise<BffFetchResponse>;
    },
    log: (event) => {
      events.push(event);
    },
    timeoutMs: 200,
    ...overrides,
  });

  return {
    invoke: async (req) => {
      if (!registered) {
        // Restore even on early failure so other tests aren't affected
        globalThis.fetch = originalFetch;
        throw new Error("handler was never registered");
      }
      try {
        return await registered({} as IpcMainInvokeEvent, req);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
    events,
    fetchCalls,
  };
}

test("registers on the BFF_FETCH_CHANNEL constant", () => {
  let seen = "";
  installBffFetchHandler({
    getCookieHeader: () => "",
    allowedHosts: () => ["api.holaboss.ai"],
    register: (channel) => {
      seen = channel;
    },
  });
  assert.equal(seen, "bff:fetch");
  assert.equal(BFF_FETCH_CHANNEL, seen);
});

test("forwards a GET to an allowlisted host and returns a serialized response", async () => {
  const h = harness();
  const resp = await h.invoke({
    url: "https://api.holaboss.ai/rpc/billing",
    method: "GET",
    headers: { accept: "application/json" },
  });
  assert.equal(resp.ok, true);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers["content-type"], "application/json");
  assert.equal(resp.body, JSON.stringify({ ok: true }));
});

test("injects the auth cookie even when the renderer didn't send one", async () => {
  const h = harness();
  await h.invoke({
    url: "https://api.holaboss.ai/rpc/billing",
    method: "GET",
    headers: {},
  });
  const init = h.fetchCalls[0]?.init;
  const cookie = new Headers(init?.headers).get("cookie");
  assert.equal(cookie, "session=abc; csrf=xyz");
});

test("strips a renderer-supplied Cookie header (the dep-injected cookie wins)", async () => {
  const h = harness();
  await h.invoke({
    url: "https://api.holaboss.ai/rpc/billing",
    method: "POST",
    headers: { cookie: "evil=injected", "content-type": "application/json" },
    body: '{"x":1}',
  });
  const init = h.fetchCalls[0]?.init;
  const cookie = new Headers(init?.headers).get("cookie");
  assert.equal(cookie, "session=abc; csrf=xyz");
  assert.equal(/evil/.test(cookie ?? ""), false);
});

test("strips other forbidden headers (host, content-length, connection)", async () => {
  const h = harness();
  await h.invoke({
    url: "https://api.holaboss.ai/rpc/billing",
    method: "POST",
    headers: {
      host: "evil.example.com",
      "content-length": "999",
      connection: "keep-alive",
      "x-allowed": "yes",
    },
    body: '{}',
  });
  const headers = new Headers(h.fetchCalls[0]?.init?.headers);
  assert.equal(headers.get("host"), null);
  assert.equal(headers.get("content-length"), null);
  assert.equal(headers.get("connection"), null);
  assert.equal(headers.get("x-allowed"), "yes");
});

test("forwards body verbatim on non-GET", async () => {
  const h = harness();
  await h.invoke({
    url: "https://api.holaboss.ai/rpc/widgets",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"hello":"world"}',
  });
  assert.equal(h.fetchCalls[0]?.init?.body, '{"hello":"world"}');
});

test("rejects requests to a host outside the allowlist", async () => {
  const h = harness();
  await assert.rejects(
    h.invoke({
      url: "https://evil.example.com/steal",
      method: "GET",
      headers: {},
    }),
    BffFetchAllowlistError,
  );
});

test("allowlist is re-evaluated per request (no startup-time freezing)", async () => {
  let allowed = ["api.holaboss.ai"];
  const events: BffFetchLogEvent[] = [];
  let registered: ((event: IpcMainInvokeEvent, req: BffFetchRequest) => Promise<BffFetchResponse>) | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    installBffFetchHandler({
      getCookieHeader: () => "",
      allowedHosts: () => allowed,
      register: (_, handler) => {
        registered = handler as typeof registered;
      },
      log: (e) => events.push(e),
    });

    // First call: api.imerchstaging.com NOT yet in allowlist
    await assert.rejects(
      registered!({} as IpcMainInvokeEvent, {
        url: "https://api.imerchstaging.com/rpc",
        method: "GET",
        headers: {},
      }),
      BffFetchAllowlistError,
    );

    // Mutate allowlist; next call should now succeed (config-reload semantics)
    allowed = ["api.imerchstaging.com"];
    const resp = await registered!({} as IpcMainInvokeEvent, {
      url: "https://api.imerchstaging.com/rpc",
      method: "GET",
      headers: {},
    });
    assert.equal(resp.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects malformed urls (parsable but no host)", async () => {
  const h = harness();
  await assert.rejects(
    h.invoke({ url: "not-a-url", method: "GET", headers: {} }),
    BffFetchAllowlistError,
  );
});

test("times out long-running fetches and surfaces an abort error", async () => {
  const h = harness({}, () =>
    new Promise<Response>(() => {
      // never resolves
    }),
  );
  const startedAt = Date.now();
  await assert.rejects(
    h.invoke({
      url: "https://api.holaboss.ai/slow",
      method: "GET",
      headers: {},
    }),
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `expected fast abort but elapsed=${elapsed}ms`);
});

test("emits structured log events on success", async () => {
  const h = harness();
  await h.invoke({
    url: "https://api.holaboss.ai/rpc/billing",
    method: "GET",
    headers: {},
  });
  const names = h.events.map((e) => e.event);
  assert.deepEqual(names, ["bff_fetch.start", "bff_fetch.success"]);
  const success = h.events[1];
  assert.ok(success && success.event === "bff_fetch.success");
  assert.equal(success.status, 200);
  assert.equal(typeof success.durationMs, "number");
});

test("emits structured error log when fetch throws", async () => {
  const h = harness({}, () => {
    throw new Error("network down");
  });
  await assert.rejects(
    h.invoke({
      url: "https://api.holaboss.ai/rpc/billing",
      method: "GET",
      headers: {},
    }),
    /network down/,
  );
  const errorEvent = h.events.find((e) => e.event === "bff_fetch.error");
  assert.ok(errorEvent);
  if (errorEvent && errorEvent.event === "bff_fetch.error") {
    assert.match(errorEvent.error, /network down/);
  }
});

test("propagates non-2xx response bodies as ok=false (caller decides what to do)", async () => {
  const h = harness({}, () =>
    new Response(JSON.stringify({ detail: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }),
  );
  const resp = await h.invoke({
    url: "https://api.holaboss.ai/rpc/private",
    method: "GET",
    headers: {},
  });
  assert.equal(resp.ok, false);
  assert.equal(resp.status, 403);
  assert.match(resp.body, /forbidden/);
});

test("does not auto-follow redirects (BFF stays explicit about 3xx)", async () => {
  // Redirect responses return as-is. We don't actually fire a second request,
  // we just check that the handler doesn't transparently follow.
  const h = harness({}, () =>
    new Response("", {
      status: 302,
      headers: {
        location: "https://api.holaboss.ai/elsewhere",
        "content-type": "text/plain",
      },
    }),
  );
  const resp = await h.invoke({
    url: "https://api.holaboss.ai/rpc/redir",
    method: "GET",
    headers: {},
  });
  assert.equal(resp.status, 302);
  assert.equal(resp.headers["location"], "https://api.holaboss.ai/elsewhere");
});

test("handles empty cookie (unauthenticated) by not sending Cookie header", async () => {
  const h = harness({ getCookieHeader: () => "" });
  await h.invoke({
    url: "https://api.holaboss.ai/rpc/public",
    method: "GET",
    headers: {},
  });
  const cookie = new Headers(h.fetchCalls[0]?.init?.headers).get("cookie");
  assert.equal(cookie, null);
});

test("forbidden-header drop is case-insensitive", async () => {
  const h = harness();
  await h.invoke({
    url: "https://api.holaboss.ai/rpc/x",
    method: "POST",
    headers: { COOKIE: "evil=1", "Content-Length": "9", "Content-Type": "application/json" },
    body: '{"x":1}',
  });
  const headers = new Headers(h.fetchCalls[0]?.init?.headers);
  assert.equal(headers.get("cookie"), "session=abc; csrf=xyz");
  assert.equal(headers.get("content-length"), null);
  assert.equal(headers.get("content-type"), "application/json");
});

test("default register works without an Electron context (lazy ipcMain access)", async () => {
  // installBffFetchHandler must not eagerly touch electron's ipcMain when a
  // custom `register` is provided — otherwise tests would crash on import.
  // Just exercising the constructor path proves the lazy path stays lazy.
  let called = false;
  installBffFetchHandler({
    getCookieHeader: () => "",
    allowedHosts: () => [],
    register: () => {
      called = true;
    },
  });
  assert.equal(called, true);
});
