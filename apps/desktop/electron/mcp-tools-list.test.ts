import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MCP_TOOLS_LIST_PAGES,
  MCP_TOOLS_LIST_PAGE_TIMEOUT_MS,
  fetchAllMcpToolNames,
  parseMcpToolsListPage,
  parseMcpToolsListResponse,
} from "./mcp-tools-list.js";

/** A transport that answers each `tools/list` with the next scripted page. */
function scriptedFetch(
  pages: Array<{ tools: string[]; nextCursor?: string | null; status?: number }>,
) {
  const cursors: Array<string | undefined> = [];
  let call = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      params?: { cursor?: string };
    };
    cursors.push(body.params?.cursor);
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    if (page.status && page.status >= 400) {
      return { ok: false, status: page.status, text: async () => "" } as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          result: {
            tools: page.tools.map((name) => ({ name })),
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          },
        }),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, cursors, calls: () => call };
}

const BASE = { url: "https://app.example/mcp", headers: {}, label: "[test]" };

test("parseMcpToolsListPage carries nextCursor out of the body", () => {
  const page = parseMcpToolsListPage(
    JSON.stringify({ result: { tools: [{ name: "a" }], nextCursor: "c1" } }),
  );
  assert.deepEqual(page, { tools: ["a"], nextCursor: "c1" });
});

test("parseMcpToolsListPage reads an SSE-framed body", () => {
  const page = parseMcpToolsListPage(
    `event: message\ndata: ${JSON.stringify({ result: { tools: [{ name: "b" }], nextCursor: "c2" } })}\n\n`,
  );
  assert.deepEqual(page, { tools: ["b"], nextCursor: "c2" });
});

test("parseMcpToolsListPage treats a missing/empty cursor as the end", () => {
  assert.equal(
    parseMcpToolsListPage(JSON.stringify({ result: { tools: [] } }))?.nextCursor,
    null,
  );
  assert.equal(
    parseMcpToolsListPage(
      JSON.stringify({ result: { tools: [], nextCursor: "" } }),
    )?.nextCursor,
    null,
  );
});

test("parseMcpToolsListPage returns null when there is no tools array to read", () => {
  // Distinct from a page that legitimately has zero tools — see the callers.
  assert.equal(parseMcpToolsListPage("not json at all"), null);
  assert.equal(
    parseMcpToolsListPage(JSON.stringify({ error: { code: -32601 } })),
    null,
  );
});

test("parseMcpToolsListResponse still returns just the names", () => {
  assert.deepEqual(
    parseMcpToolsListResponse(
      JSON.stringify({ result: { tools: [{ name: "x" }, { name: "y" }] } }),
    ),
    ["x", "y"],
  );
});

/**
 * The regression: a server whose tools span two pages used to yield only page one,
 * and the missing names were then filtered out of the agent's allowlist with no
 * error anywhere — `upload_image` present, `create_post` simply absent.
 */
test("fetchAllMcpToolNames follows the cursor across pages", async () => {
  const { impl, cursors } = scriptedFetch([
    { tools: ["upload_image"], nextCursor: "page2" },
    { tools: ["create_post"] },
  ]);

  const result = await fetchAllMcpToolNames({ ...BASE, fetchImpl: impl });

  assert.deepEqual(result.tools, ["upload_image", "create_post"]);
  assert.equal(result.complete, true);
  // First request carries no cursor; the second echoes the server's.
  assert.deepEqual(cursors, [undefined, "page2"]);
});

test("fetchAllMcpToolNames reports incomplete when a later page fails", async () => {
  const { impl } = scriptedFetch([
    { tools: ["first"], nextCursor: "page2" },
    { tools: [], status: 500 },
  ]);

  const result = await fetchAllMcpToolNames({
    ...BASE,
    fetchImpl: impl,
    log: () => {},
  });

  // The names we did get are still returned — but `complete` is false so the
  // caller must not cache a truncated set.
  assert.deepEqual(result.tools, ["first"]);
  assert.equal(result.complete, false);
});

test("fetchAllMcpToolNames de-duplicates names repeated across pages", async () => {
  const { impl } = scriptedFetch([
    { tools: ["dup", "a"], nextCursor: "page2" },
    { tools: ["dup", "b"] },
  ]);

  const result = await fetchAllMcpToolNames({ ...BASE, fetchImpl: impl });

  assert.deepEqual(result.tools, ["dup", "a", "b"]);
});

test("a repeated cursor stops the loop AND reports incomplete", async () => {
  // A server reusing a cursor is looping. Stopping is right; calling it complete
  // is not — the remaining pages were never read, and a "complete" partial list
  // gets cached until uninstall, which is the bug this module exists to prevent.
  const { impl, calls } = scriptedFetch([
    { tools: ["a"], nextCursor: "same" },
    { tools: ["b"], nextCursor: "same" },
  ]);
  const warnings: string[] = [];

  const result = await fetchAllMcpToolNames({
    ...BASE,
    fetchImpl: impl,
    log: (m) => warnings.push(m),
  });

  assert.equal(result.complete, false, "a truncated read must not be cacheable");
  assert.equal(calls(), 2, "must not keep requesting the same cursor");
  assert.match(warnings.join("\n"), /repeated cursor/);
});

test("a thrown transport on page 2 keeps page 1 instead of losing everything", async () => {
  // Regression guard: propagating would hit the caller's catch and yield NO
  // tools — strictly worse than the single-page behaviour this replaced.
  let call = 0;
  const impl = (async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            result: { tools: [{ name: "p1" }], nextCursor: "page2" },
          }),
      } as Response;
    }
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;

  const result = await fetchAllMcpToolNames({
    ...BASE,
    fetchImpl: impl,
    log: () => {},
  });

  assert.deepEqual(result.tools, ["p1"]);
  assert.equal(result.complete, false);
});

test("an unparseable body is incomplete, not an empty complete list", async () => {
  // A JSON-RPC error body parses as JSON but carries no tools array. Treating
  // that as "complete with zero tools" would cache a wrong answer.
  const impl = (async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "no" } }),
  })) as unknown as typeof fetch;

  const result = await fetchAllMcpToolNames({
    ...BASE,
    fetchImpl: impl,
    log: () => {},
  });

  assert.deepEqual(result.tools, []);
  assert.equal(result.complete, false);
});

test("fetchAllMcpToolNames stops at the page cap and reports incomplete", async () => {
  // Every page hands back a fresh cursor, so only the cap can end this.
  let n = 0;
  const impl = (async () => ({
    ok: true,
    status: 200,
    text: async () => {
      n += 1;
      return JSON.stringify({
        result: { tools: [{ name: `tool${n}` }], nextCursor: `cursor${n}` },
      });
    },
  })) as unknown as typeof fetch;

  const result = await fetchAllMcpToolNames({
    ...BASE,
    fetchImpl: impl,
    log: () => {},
  });

  assert.equal(result.complete, false);
  assert.equal(result.tools.length, MAX_MCP_TOOLS_LIST_PAGES);
});

test("each page request carries an abort signal so a hung server can't stall a turn", async () => {
  const signals: Array<AbortSignal | undefined | null> = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    signals.push(init?.signal);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: { tools: [{ name: "t" }] } }),
    } as Response;
  }) as unknown as typeof fetch;

  await fetchAllMcpToolNames({ ...BASE, fetchImpl: impl });

  assert.equal(signals.length, 1);
  assert.ok(
    signals[0] instanceof AbortSignal,
    "no timeout signal — discovery runs before every turn and would stall unbounded",
  );
});

test("the per-page timeout is overridable and actually aborts", async () => {
  // A server that never answers must not hold the loop open.
  const impl = (async (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    })) as unknown as typeof fetch;

  const started = Date.now();
  const result = await fetchAllMcpToolNames({
    ...BASE,
    fetchImpl: impl,
    timeoutMs: 50,
    log: () => {},
  });

  assert.equal(result.complete, false);
  assert.deepEqual(result.tools, []);
  assert.ok(
    Date.now() - started < MCP_TOOLS_LIST_PAGE_TIMEOUT_MS,
    "the request was not bounded by the supplied timeout",
  );
});
