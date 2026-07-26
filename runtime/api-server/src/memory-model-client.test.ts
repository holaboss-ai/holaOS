import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
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
