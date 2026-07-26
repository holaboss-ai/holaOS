import assert from "node:assert/strict";
import test from "node:test";

import { resolvePushCallbackConfig, type TsRunnerRequest } from "./ts-runner-contracts.js";
import { buildTsRunnerEvent, emitTsRunnerEventWithPush } from "./ts-runner-events.js";

function requestWithPushContext(): TsRunnerRequest {
  return {
    workspace_id: "workspace-1",
    session_id: "session-1",
    input_id: "input-1",
    instruction: "hello",
    context: {
      _sandbox_runtime_push_v1: {
        protocol_version: "1.0",
        run_id: "run-1",
        callback_url: "https://example.invalid/callback",
        callback_token: "token-1",
        ack_timeout_ms: 250,
        max_retries: 2
      }
    },
    model: null,
    debug: false
  };
}

test("resolvePushCallbackConfig parses supported request context", () => {
  const config = resolvePushCallbackConfig(requestWithPushContext());

  assert.deepEqual(config, {
    protocol_version: "1.0",
    run_id: "run-1",
    callback_url: "https://example.invalid/callback",
    callback_token: "token-1",
    ack_timeout_ms: 250,
    max_retries: 2
  });
});

test("resolvePushCallbackConfig ignores unsupported protocol versions", () => {
  const warnings: string[] = [];
  const request = requestWithPushContext();
  (request.context._sandbox_runtime_push_v1 as Record<string, unknown>).protocol_version = "2.0";

  const config = resolvePushCallbackConfig(request, {
    logger: { warn(message: string) { warnings.push(message); } }
  });

  assert.equal(config, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unsupported push protocol version/);
});

test("emitTsRunnerEventWithPush writes stdout and posts push callback payload", async () => {
  let stdout = "";
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const event = buildTsRunnerEvent({
    sessionId: "session-1",
    inputId: "input-1",
    sequence: 3,
    eventType: "run_failed",
    payload: { type: "RuntimeError", message: "boom" }
  });

  await emitTsRunnerEventWithPush({
    io: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        }
      } as unknown as NodeJS.WritableStream
    },
    event,
    pushClient: {
      config: resolvePushCallbackConfig(requestWithPushContext())!
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(null, { status: 202 });
    }
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0]?.url, "https://example.invalid/callback");
  assert.equal(fetchCalls[0]?.init?.method, "POST");
  assert.match(String(fetchCalls[0]?.init?.headers && (fetchCalls[0]?.init?.headers as Record<string, string>)["Idempotency-Key"]), /run-1:3/);

  const pushedPayload = JSON.parse(String(fetchCalls[0]?.init?.body));
  assert.equal(pushedPayload.run_id, "run-1");
  assert.equal(pushedPayload.sequence, 3);
  assert.equal(pushedPayload.event_type, "run_failed");
  assert.match(stdout.trim(), /"event_type":"run_failed"/);
});
