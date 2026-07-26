import { describe, expect, it, vi } from "vitest";

import {
  createRequestFn,
  isTransientRuntimeError,
  runtimeErrorFromBody,
} from "./request";

const baseURL = "http://127.0.0.1:38090";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("isTransientRuntimeError", () => {
  it("classifies TypeError as transient", () => {
    expect(isTransientRuntimeError(new TypeError("boom"))).toBe(true);
  });

  it("classifies known runtime ready / network errors as transient", () => {
    for (const message of [
      "embedded runtime is not ready yet",
      "fetch failed",
      "ECONNREFUSED 127.0.0.1:38090",
      "socket hang up",
    ]) {
      expect(isTransientRuntimeError(new Error(message))).toBe(true);
    }
  });

  it("rejects unrelated errors", () => {
    expect(isTransientRuntimeError(new Error("invalid payload"))).toBe(false);
    expect(isTransientRuntimeError("not an error")).toBe(false);
  });
});

describe("runtimeErrorFromBody", () => {
  it("uses JSON detail/message/error fields when present", () => {
    expect(runtimeErrorFromBody(400, "Bad Request", '{"detail":"nope"}').message).toBe(
      "nope"
    );
    expect(runtimeErrorFromBody(500, "Server", '{"message":"explode"}').message).toBe(
      "explode"
    );
    expect(runtimeErrorFromBody(500, "Server", '{"error":"blew up"}').message).toBe(
      "blew up"
    );
  });

  it("falls back to body text when JSON has no recognizable field", () => {
    expect(
      runtimeErrorFromBody(400, "Bad Request", '{"unknown":"shape"}').message
    ).toBe("400 Bad Request");
  });

  it("falls back to status when body is empty", () => {
    expect(runtimeErrorFromBody(503, "Service Unavailable", "").message).toBe(
      "503 Service Unavailable"
    );
  });

  it("treats non-JSON body as the error message", () => {
    expect(runtimeErrorFromBody(502, undefined, "upstream gone").message).toBe(
      "upstream gone"
    );
  });

  it("attaches numeric status to thrown error", () => {
    const err = runtimeErrorFromBody(404, "Not Found", '{"detail":"missing"}') as Error & {
      status?: number;
    };
    expect(err.status).toBe(404);
  });
});

describe("createRequestFn", () => {
  it("issues a GET, parses JSON, and resolves", async () => {
    type FetchArgs = [URL | string, RequestInit | undefined];
    const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>(
      async () => jsonResponse(200, { hello: "world" })
    );
    const request = createRequestFn({
      getBaseURL: async () => baseURL,
      fetch: fetchFn as unknown as typeof fetch,
    });
    const data = await request<{ hello: string }>({
      method: "GET",
      path: "/api/v1/things",
    });
    expect(data).toEqual({ hello: "world" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${baseURL}/api/v1/things`);
    expect(init?.method).toBe("GET");
  });

  it("serializes payload + sets content-type for non-GET", async () => {
    type FetchArgs = [URL | string, RequestInit | undefined];
    const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>(
      async () => jsonResponse(200, { ok: true })
    );
    const request = createRequestFn({
      getBaseURL: async () => baseURL,
      fetch: fetchFn as unknown as typeof fetch,
    });
    await request({
      method: "POST",
      path: "/api/v1/widgets",
      payload: { name: "wat" },
    });
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.body).toBe('{"name":"wat"}');
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json"
    );
  });

  it("appends params, dropping null/undefined/empty-string", async () => {
    type FetchArgs = [URL | string, RequestInit | undefined];
    const fetchFn = vi.fn<(...args: FetchArgs) => Promise<Response>>(
      async () => jsonResponse(200, {})
    );
    const request = createRequestFn({
      getBaseURL: async () => baseURL,
      fetch: fetchFn as unknown as typeof fetch,
    });
    await request({
      method: "GET",
      path: "/api/v1/items",
      params: { workspace_id: "abc", limit: 10, cursor: null, q: "" },
    });
    const url = fetchFn.mock.calls[0]?.[0];
    if (!(url instanceof URL)) {
      throw new Error("expected URL");
    }
    expect(url.searchParams.get("workspace_id")).toBe("abc");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(url.searchParams.has("q")).toBe(false);
  });

  it("throws runtime-error on 4xx with JSON detail", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(404, { detail: "workspace not found" })
    );
    const request = createRequestFn({
      getBaseURL: async () => baseURL,
      fetch: fetchFn,
    });
    await expect(
      request({ method: "GET", path: "/api/v1/workspaces/xxx" })
    ).rejects.toThrow("workspace not found");
  });

  it("retries GET up to 3 times on transient error", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse(200, { ok: true });
    });
    const request = createRequestFn({
      getBaseURL: async () => baseURL,
      fetch: fetchFn,
    });
    const data = await request<{ ok: boolean }>({
      method: "GET",
      path: "/api/v1/things",
    });
    expect(data).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it("does not retry POST by default", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    });
    const request = createRequestFn({
      getBaseURL: async () => baseURL,
      fetch: fetchFn,
    });
    await expect(
      request({
        method: "POST",
        path: "/api/v1/things",
        payload: {},
      })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("retries POST when retryTransientErrors=true", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        throw new TypeError("ECONNREFUSED");
      }
      return jsonResponse(200, { ok: true });
    });
    const request = createRequestFn({
      getBaseURL: async () => baseURL,
      fetch: fetchFn,
    });
    await request({
      method: "POST",
      path: "/api/v1/things",
      payload: {},
      retryTransientErrors: true,
    });
    expect(calls).toBe(2);
  });

  it("times out and aborts the underlying fetch", async () => {
    const fetchFn = vi.fn(
      (_url: URL | string, init: RequestInit | undefined): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        })
    );
    const request = createRequestFn({
      getBaseURL: async () => baseURL,
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(
      request({
        method: "GET",
        path: "/api/v1/slow",
        timeoutMs: 25,
      })
    ).rejects.toThrow();
  });

  it("returns null on 204", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const request = createRequestFn({
      getBaseURL: async () => baseURL,
      fetch: fetchFn,
    });
    const data = await request({ method: "DELETE", path: "/api/v1/items/1" });
    expect(data).toBeNull();
  });

  it("re-resolves baseURL on each attempt", async () => {
    const baseURLs = ["http://127.0.0.1:1111", "http://127.0.0.1:2222"];
    let baseIdx = 0;
    let calls = 0;
    const fetchFn = vi.fn(async (url: URL | string) => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("fetch failed");
      }
      expect(String(url)).toContain("2222");
      return jsonResponse(200, { ok: true });
    });
    const request = createRequestFn({
      getBaseURL: async () => baseURLs[baseIdx++ % 2]!,
      fetch: fetchFn as unknown as typeof fetch,
    });
    await request({ method: "GET", path: "/api/v1/things" });
    expect(calls).toBe(2);
  });
});
