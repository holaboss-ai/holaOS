import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  __resetUpstreamErrorCaptureForTests,
  extractDeepProviderMessage,
  installUpstreamErrorCapture,
  peekLatestUpstreamError,
} from "./upstream-error-capture.js";

const originalFetch = globalThis.fetch;

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function withStubbedFetch(stub: FetchStub) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    stub(input, init)) as typeof globalThis.fetch;
}

describe("upstream-error-capture", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    __resetUpstreamErrorCaptureForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetUpstreamErrorCaptureForTests();
  });

  test("captures 4xx JSON body from a responses endpoint and exposes parsed body", async () => {
    withStubbedFetch(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Provider returned error",
            code: 400,
            metadata: {
              raw_provider_error: {
                message: "Invalid 'reasoning.effort' value: xhigh",
              },
            },
          },
        }),
        { status: 400, statusText: "Bad Request", headers: { "content-type": "application/json" } },
      ),
    );
    installUpstreamErrorCapture();

    await globalThis.fetch("https://api.example.com/v1/responses", { method: "POST" });

    const capture = peekLatestUpstreamError();
    assert.ok(capture, "expected a capture");
    assert.equal(capture.status, 400);
    assert.equal(capture.method, "POST");
    assert.equal(capture.url, "https://api.example.com/v1/responses");
    assert.equal(capture.body_truncated, false);
    const parsed = capture.parsed_body as { error: { metadata: { raw_provider_error: { message: string } } } };
    assert.equal(parsed.error.metadata.raw_provider_error.message, "Invalid 'reasoning.effort' value: xhigh");
  });

  test("skips 2xx responses entirely", async () => {
    withStubbedFetch(async () => new Response("ok", { status: 200 }));
    installUpstreamErrorCapture();

    await globalThis.fetch("https://api.example.com/v1/responses");

    assert.equal(peekLatestUpstreamError(), null);
  });

  test("skips 4xx responses from non-LLM endpoints", async () => {
    withStubbedFetch(async () => new Response("bad", { status: 400 }));
    installUpstreamErrorCapture();

    await globalThis.fetch("https://example.com/api/v1/notifications");

    assert.equal(peekLatestUpstreamError(), null);
  });

  test("captures matches against the /model-proxy/ pattern", async () => {
    withStubbedFetch(async () => new Response("denied", { status: 403, statusText: "Forbidden" }));
    installUpstreamErrorCapture();

    await globalThis.fetch("https://gw.example.com/gateway/sandbox/api/v1/model-proxy/v1/anything");

    const capture = peekLatestUpstreamError();
    assert.ok(capture);
    assert.equal(capture.status, 403);
    assert.equal(capture.parsed_body, null); // not JSON
    assert.equal(capture.body, "denied");
  });

  test("truncates bodies larger than the cap", async () => {
    const big = "x".repeat(70_000);
    withStubbedFetch(async () =>
      new Response(big, { status: 400, headers: { "content-type": "text/plain" } }),
    );
    installUpstreamErrorCapture();

    await globalThis.fetch("https://api.example.com/v1/chat/completions");

    const capture = peekLatestUpstreamError();
    assert.ok(capture);
    assert.equal(capture.body_truncated, true);
    assert.equal(capture.body.length, 64 * 1024);
  });

  test("installation is idempotent — wrapping once never doubles", async () => {
    let calls = 0;
    withStubbedFetch(async () => {
      calls += 1;
      return new Response("err", { status: 400 });
    });
    installUpstreamErrorCapture();
    installUpstreamErrorCapture();
    installUpstreamErrorCapture();

    await globalThis.fetch("https://api.example.com/v1/responses");

    assert.equal(calls, 1);
  });

  test("peekLatestUpstreamError honors withinMs cutoff", async () => {
    withStubbedFetch(async () => new Response("err", { status: 400 }));
    installUpstreamErrorCapture();
    await globalThis.fetch("https://api.example.com/v1/responses");
    const capture = peekLatestUpstreamError();
    assert.ok(capture);
    // Force the captured timestamp into the distant past.
    (capture as { captured_at_ms: number }).captured_at_ms = Date.now() - 120_000;

    assert.equal(peekLatestUpstreamError({ withinMs: 30_000 }), null);
    assert.ok(peekLatestUpstreamError({ withinMs: 300_000 }));
  });
});

describe("extractDeepProviderMessage", () => {
  test("prefers nested raw_provider_error over the outer message", () => {
    const body = {
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: {
          raw_provider_error: {
            message: "Invalid 'reasoning.effort' value: xhigh",
          },
        },
      },
    };
    assert.equal(
      extractDeepProviderMessage(body),
      "Invalid 'reasoning.effort' value: xhigh",
    );
  });

  test("falls back to a flat error.message when there is no nested metadata", () => {
    const body = { error: { message: "rate limited", code: 429 } };
    assert.equal(extractDeepProviderMessage(body), "rate limited");
  });

  test("handles arrays of errors", () => {
    const body = { errors: [{ message: "first" }, { message: "second" }] };
    assert.equal(extractDeepProviderMessage(body), "first");
  });

  test("returns null when no meaningful string exists", () => {
    assert.equal(extractDeepProviderMessage({}), null);
    assert.equal(extractDeepProviderMessage(null), null);
    assert.equal(extractDeepProviderMessage({ error: { code: 400 } }), null);
  });

  test("unwraps OpenRouter metadata.raw escaped JSON to surface the upstream OpenAI error", () => {
    // Real captured shape: OpenRouter wraps the upstream OpenAI body in
    // `error.metadata.raw` as an escaped JSON string. Without parsing the
    // inner string, the walker would stop at the outer "Provider returned
    // error" message.
    const body = {
      error: {
        message: "Provider returned error",
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: {
              message:
                "Invalid schema for function 'base_object_define': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the top level.",
              type: "invalid_request_error",
              param: "tools[59].parameters",
              code: "invalid_function_parameters",
            },
          }),
          provider_name: "Azure",
        },
      },
    };
    assert.equal(
      extractDeepProviderMessage(body),
      "Invalid schema for function 'base_object_define': schema must have type 'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'not' at the top level.",
    );
  });

  test("walks nested cause chains", () => {
    const body = {
      error: {
        cause: {
          body: {
            details: ["something went wrong: tools[42].function.parameters invalid"],
          },
        },
      },
    };
    assert.equal(
      extractDeepProviderMessage(body),
      "something went wrong: tools[42].function.parameters invalid",
    );
  });
});
