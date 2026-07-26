import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUrl, createClient } from "./base";

describe("app-sdk base client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes credentials through to fetch when configured", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: {
            "content-type": "application/json",
          },
          status: 200,
        })
    );

    vi.stubGlobal("fetch", fetchMock);

    const client = createClient({
      baseURL: "http://localhost:4000/api/marketplace",
      credentials: "include",
      headers: undefined,
    });

    await client({
      method: "GET",
      url: "/templates",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as unknown as
      | [RequestInfo | URL, RequestInit | undefined]
      | undefined;
    expect(firstCall).toBeDefined();
    expect(firstCall?.[1]).toMatchObject({
      credentials: "include",
      method: "GET",
    });
    expect(firstCall?.[0]?.toString()).toBe(
      "http://localhost:4000/api/marketplace/templates"
    );
  });

  it("preserves the baseURL path when joining a leading-slash url", () => {
    expect(
      buildUrl({
        baseURL: "http://localhost:4000/api/marketplace",
        url: "/templates",
      }).toString()
    ).toBe("http://localhost:4000/api/marketplace/templates");
  });

  it("preserves the baseURL path when the baseURL has a trailing slash", () => {
    expect(
      buildUrl({
        baseURL: "http://localhost:4000/api/marketplace/",
        url: "/templates",
      }).toString()
    ).toBe("http://localhost:4000/api/marketplace/templates");
  });

  it("appends query params to the resolved url", () => {
    expect(
      buildUrl({
        baseURL: "http://localhost:4000/api/marketplace",
        params: { limit: 10, q: "social" },
        url: "/templates",
      }).toString()
    ).toBe("http://localhost:4000/api/marketplace/templates?limit=10&q=social");
  });

  it("uses an absolute url verbatim", () => {
    expect(
      buildUrl({
        baseURL: "http://localhost:4000/api/marketplace",
        url: "https://api.example.com/v2/items",
      }).toString()
    ).toBe("https://api.example.com/v2/items");
  });
});
