import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  clipToEmbeddingBudget,
  estimateEmbeddingTokens,
  queryMemoryModelEmbedding,
  queryMemoryModelJson,
  queryMemoryModelVisionJson,
} from "./memory-model-client.js";

const ORIGINAL_FETCH = globalThis.fetch;
type RecordedCall = { url: string; headers: HeadersInit | undefined; body: Record<string, unknown> | null };

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("queryMemoryModelJson uses OpenAI-compatible chat completions", async () => {
  let call: RecordedCall | null = null;
  globalThis.fetch = (async (input, init) => {
    call = {
      url: String(input),
      headers: init?.headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ ok: true }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const payload = await queryMemoryModelJson(
    {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-1",
      modelId: "gpt-5.4-mini",
      apiStyle: "openai_compatible",
    },
    {
      systemPrompt: "Return JSON.",
      userPrompt: "Hello",
    },
  );

  assert.deepEqual(payload, { ok: true });
  assert.ok(call);
  const recordedCall = call as RecordedCall;
  assert.equal(recordedCall.url, "https://runtime.example/api/v1/model-proxy/openai/v1/chat/completions");
  assert.equal((recordedCall.headers as Record<string, string>).Authorization, "Bearer token-1");
  assert.equal(recordedCall.body?.model, "gpt-5.4-mini");
  assert.deepEqual(recordedCall.body?.response_format, { type: "json_object" });
});

test("queryMemoryModelJson treats dedicated Google proxy routes as OpenAI-compatible chat completions", async () => {
  let call: RecordedCall | null = null;
  globalThis.fetch = (async (input, init) => {
    call = {
      url: String(input),
      headers: init?.headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ provider: "google" }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const payload = await queryMemoryModelJson(
    {
      baseUrl: "https://runtime.example/api/v1/model-proxy/google/v1",
      apiKey: "token-google",
      modelId: "gemini-2.5-flash",
    },
    {
      systemPrompt: "Return JSON.",
      userPrompt: "Hello",
    },
  );

  assert.deepEqual(payload, { provider: "google" });
  assert.ok(call);
  const recordedCall = call as RecordedCall;
  assert.equal(recordedCall.url, "https://runtime.example/api/v1/model-proxy/google/v1/chat/completions");
  assert.equal((recordedCall.headers as Record<string, string>).Authorization, "Bearer token-google");
  assert.equal(recordedCall.body?.model, "gemini-2.5-flash");
});

test("queryMemoryModelJson uses Anthropic native messages with strict JSON prompting", async () => {
  let call: RecordedCall | null = null;
  globalThis.fetch = (async (input, init) => {
    call = {
      url: String(input),
      headers: init?.headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: '{"stage":"ok"}',
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const payload = await queryMemoryModelJson(
    {
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-4-6",
      apiStyle: "anthropic_native",
    },
    {
      systemPrompt: "Return JSON.",
      userPrompt: "Hello",
    },
  );

  assert.deepEqual(payload, { stage: "ok" });
  assert.ok(call);
  const recordedCall = call as RecordedCall;
  assert.equal(recordedCall.url, "https://api.anthropic.com/v1/messages");
  assert.equal((recordedCall.headers as Record<string, string>)["x-api-key"], "sk-ant-test");
  assert.equal((recordedCall.headers as Record<string, string>)["anthropic-version"], "2023-06-01");
  assert.equal(recordedCall.body?.model, "claude-sonnet-4-6");
  assert.equal(recordedCall.body?.system, "Return JSON.");
  assert.deepEqual(recordedCall.body?.messages, [{ role: "user", content: "Hello" }]);
});

test("queryMemoryModelVisionJson uses OpenAI-compatible chat completions with image_url content parts", async () => {
  let call: RecordedCall | null = null;
  globalThis.fetch = (async (input, init) => {
    call = {
      url: String(input),
      headers: init?.headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ extracted_text: "Nina Patel owns Pine Harbor billing escalation", summary: "Escalation ownership note." }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const payload = await queryMemoryModelVisionJson(
    {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-1",
      modelId: "gpt-4.1-mini",
      apiStyle: "openai_compatible",
    },
    {
      systemPrompt: "Return JSON.",
      userPrompt: "Extract the durable text from this image.",
      images: [
        {
          mimeType: "image/png",
          bytes: Buffer.from("fake-image-bytes"),
          detail: "high",
        },
      ],
    },
  );

  assert.deepEqual(payload, {
    extracted_text: "Nina Patel owns Pine Harbor billing escalation",
    summary: "Escalation ownership note.",
  });
  assert.ok(call);
  const recordedCall = call as RecordedCall;
  assert.equal(recordedCall.url, "https://runtime.example/api/v1/model-proxy/openai/v1/chat/completions");
  assert.deepEqual(recordedCall.body?.response_format, { type: "json_object" });
  const messages = recordedCall.body?.messages as Array<Record<string, unknown>>;
  assert.equal(messages[1]?.role, "user");
  const content = messages[1]?.content as Array<Record<string, unknown>>;
  assert.equal(content[0]?.type, "text");
  assert.equal(content[1]?.type, "image_url");
  assert.match(String((content[1]?.image_url as Record<string, unknown>)?.url ?? ""), /^data:image\/png;base64,/);
});

test("queryMemoryModelVisionJson uses Anthropic native messages with base64 image blocks", async () => {
  let call: RecordedCall | null = null;
  globalThis.fetch = (async (input, init) => {
    call = {
      url: String(input),
      headers: init?.headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: '{"extracted_text":"Nina Patel owns Pine Harbor billing escalation","summary":"Escalation ownership note."}',
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const payload = await queryMemoryModelVisionJson(
    {
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      modelId: "claude-sonnet-4-6",
      apiStyle: "anthropic_native",
    },
    {
      systemPrompt: "Return JSON.",
      userPrompt: "Extract the durable text from this image.",
      images: [
        {
          mimeType: "image/png",
          bytes: Buffer.from("fake-image-bytes"),
        },
      ],
    },
  );

  assert.deepEqual(payload, {
    extracted_text: "Nina Patel owns Pine Harbor billing escalation",
    summary: "Escalation ownership note.",
  });
  assert.ok(call);
  const recordedCall = call as RecordedCall;
  assert.equal(recordedCall.url, "https://api.anthropic.com/v1/messages");
  const messages = recordedCall.body?.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.role, "user");
  const content = messages[0]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(content[0], {
    type: "text",
    text: "Extract the durable text from this image.",
  });
  assert.deepEqual(content[1], {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: Buffer.from("fake-image-bytes").toString("base64"),
    },
  });
});

test("queryMemoryModelEmbedding uses OpenAI-compatible embeddings", async () => {
  let call: RecordedCall | null = null;
  globalThis.fetch = (async (input, init) => {
    call = {
      url: String(input),
      headers: init?.headers,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    };
    return new Response(
      JSON.stringify({
        data: [
          {
            embedding: [0.25, 0.5, 0.75],
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const embedding = await queryMemoryModelEmbedding(
    {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-embedding",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    },
    {
      input: "Remember this workspace fact.",
      purpose: "document",
    },
  );

  assert.ok(embedding);
  assert.deepEqual(Array.from(embedding ?? []), [0.25, 0.5, 0.75]);
  assert.ok(call);
  const recordedCall = call as RecordedCall;
  assert.equal(
    recordedCall.url,
    "https://runtime.example/api/v1/model-proxy/openai/v1/embeddings",
  );
  assert.equal(
    (recordedCall.headers as Record<string, string>).Authorization,
    "Bearer token-embedding",
  );
  assert.deepEqual(recordedCall.body, {
    model: "text-embedding-3-small",
    input: "Remember this workspace fact.",
    encoding_format: "float",
  });
});

/**
 * The cap is a TOKEN bound, so assert tokens. The first version of this test
 * asserted `chars <= 6000` and passed on an input of 12,000 tokens — the shipped
 * constant was safe for English and 2x too generous for CJK, and the assertion
 * could not see the difference. `宇` costs 2 tokens; some scripts cost ~3.
 */
test("a query is clipped to a token budget, not a character count", async () => {
  let call: RecordedCall | null = null;
  globalThis.fetch = (async (_input, init) => {
    call = {
      url: String(_input),
      headers: init?.headers,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    };
    return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  // 40k CJK characters — the case the previous constant let through.
  await queryMemoryModelEmbedding(
    {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-embedding",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    },
    { input: "宇".repeat(40_000), purpose: "query" },
  );

  const sent = (call as unknown as RecordedCall).body?.input as string;
  assert.ok(
    estimateEmbeddingTokens(sent) <= 8192,
    `sent ~${estimateEmbeddingTokens(sent)} est. tokens — over the model cap`,
  );
});

test("an ordinary English query keeps its length", () => {
  // A blunt character cap safe for CJK (~2730) would gut these; the estimator
  // charges ASCII at ~4 chars/token so they pass through untouched.
  const english = "what did we decide about the pricing page? ".repeat(200);
  assert.equal(clipToEmbeddingBudget(english), english);
});

test("clipping never splits a surrogate pair", () => {
  // Iterating by code point (for..of) makes a mid-pair cut structurally
  // impossible; `.slice()` on code UNITS does not. A lone surrogate would show up
  // here as a code point in the D800-DFFF range.
  const clipped = clipToEmbeddingBudget("𠀀".repeat(20_000));
  const lone = [...clipped].some((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp >= 0xd800 && cp <= 0xdfff;
  });
  assert.equal(lone, false, "clip produced a lone surrogate");
});

/**
 * The asymmetry that makes `purpose` necessary: a persisted vector must not be
 * silently truncated, because a content fingerprint suppresses recomputation —
 * a bad vector written once stays wrong until the source content changes.
 */
test("a document is NEVER clipped, so a truncated vector cannot be persisted", async () => {
  let call: RecordedCall | null = null;
  globalThis.fetch = (async (_input, init) => {
    call = {
      url: String(_input),
      headers: init?.headers,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    };
    return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const huge = "宇".repeat(40_000);
  await queryMemoryModelEmbedding(
    {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-embedding",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    },
    { input: huge, purpose: "document" },
  );

  assert.equal(
    (call as unknown as RecordedCall).body?.input,
    huge,
    "a document was clipped — it would be stored as a truncated vector and never recomputed",
  );
});

test("queryMemoryModelEmbedding leaves an ordinary input untouched", async () => {
  let call: RecordedCall | null = null;
  globalThis.fetch = (async (_input, init) => {
    call = {
      url: String(_input),
      headers: init?.headers,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    };
    return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await queryMemoryModelEmbedding(
    {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-embedding",
      modelId: "text-embedding-3-small",
      apiStyle: "openai_compatible",
    },
    { input: "  what did we decide about the pricing page?  ", purpose: "query" },
  );

  assert.equal(
    (call as unknown as RecordedCall).body?.input,
    "what did we decide about the pricing page?",
  );
});
