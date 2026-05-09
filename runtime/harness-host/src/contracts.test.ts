import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeAgentRuntimeConfigCliRequestBase64,
  decodeHarnessHostPiRequestBase64,
  decodeRunnerRequestBase64,
  decodeWorkspaceMcpSidecarCliRequestBase64,
} from "./contracts.js";
import type {
  HarnessHostModelClientPayload,
  HarnessHostPiMcpToolRef,
  HarnessHostPiRequest,
  JsonObject,
  ModelClientConfigPayload,
  RunnerOutputEvent,
  RunnerOutputEventPayload,
} from "./contracts.js";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

test("contract exports keep the shared payload aliases compatible", () => {
  const payload = {
    phase: "booting",
    details: {
      attempt: 1,
      warm: true,
    },
  } satisfies JsonObject;
  const event = {
    session_id: "session-1",
    input_id: "input-1",
    sequence: 1,
    event_type: "run_started",
    payload,
  } satisfies RunnerOutputEvent;
  const legacyEvent: RunnerOutputEventPayload = event;

  const modelClient = {
    model_proxy_provider: "openai_compatible",
    api_key: "token",
    base_url: "http://127.0.0.1:4000/openai/v1",
    default_headers: { "X-Test": "1" },
  } satisfies HarnessHostModelClientPayload;
  const legacyModelClient: ModelClientConfigPayload = modelClient;

  assert.equal(legacyEvent.payload.phase, "booting");
  assert.equal(legacyModelClient.base_url, "http://127.0.0.1:4000/openai/v1");
});

test("decodeRunnerRequestBase64 applies defaults for optional fields", () => {
  const request = decodeRunnerRequestBase64(
    encode({
      workspace_id: "workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "Ship it",
      context: {
        nested: {
          ok: true,
        },
      },
    })
  );

  assert.deepEqual(request, {
    holaboss_user_id: undefined,
    workspace_id: "workspace-1",
    session_id: "session-1",
    session_kind: undefined,
    input_id: "input-1",
    instruction: "Ship it",
    attachments: [],
    image_urls: [],
    context: {
      nested: {
        ok: true,
      },
    },
    model: undefined,
    thinking_value: undefined,
    debug: false,
  });
});

test("decodeRunnerRequestBase64 rejects non-object payloads", () => {
  assert.throws(
    () => decodeRunnerRequestBase64(encode(["not", "an", "object"])),
    /runner request payload must be an object/
  );
});

test("decodeHarnessHostPiRequestBase64 validates and normalizes request payloads", () => {
  const request = decodeHarnessHostPiRequestBase64(
    encode({
      workspace_id: "workspace-1",
      workspace_dir: "/tmp/workspace-1",
      session_id: "session-1",
      browser_tools_enabled: true,
      browser_space: "user",
      input_id: "input-1",
      instruction: "Do the thing",
      context_messages: ["Recent runtime context"],
      tools: { read: true, web_search: false, ignore: "x" },
      image_urls: ["https://example.com/reference.png"],
      thinking_value: "medium",
      provider_id: "openai",
      model_id: "gpt-5.1",
      timeout_seconds: 30,
      runtime_api_base_url: "http://127.0.0.1:5060",
      system_prompt: "system",
      workspace_skill_dirs: ["/tmp/workspace-1/skills/skill-a"],
      mcp_servers: [{ name: "workspace", config: { type: "remote", url: "http://127.0.0.1:5000" } }],
      mcp_tool_refs: [{ tool_id: "workspace.lookup", server_id: "workspace", tool_name: "lookup" }],
      workspace_config_checksum: "checksum-1",
      run_started_payload: { phase: "booting" },
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token",
        default_headers: {
          "X-Test": "1",
          ignore: 2,
        },
      },
    })
  );

  assert.deepEqual(request, {
    workspace_id: "workspace-1",
    workspace_dir: "/tmp/workspace-1",
    session_id: "session-1",
    browser_tools_enabled: true,
    browser_space: "user",
    input_id: "input-1",
    instruction: "Do the thing",
    context_messages: ["Recent runtime context"],
    tools: { read: true, web_search: false },
    attachments: [],
    image_urls: ["https://example.com/reference.png"],
    thinking_value: "medium",
    debug: false,
    harness_session_id: undefined,
    persisted_harness_session_id: undefined,
    provider_id: "openai",
    model_id: "gpt-5.1",
    timeout_seconds: 30,
    runtime_api_base_url: "http://127.0.0.1:5060",
    system_prompt: "system",
    workspace_skill_dirs: ["/tmp/workspace-1/skills/skill-a"],
    mcp_servers: [{ name: "workspace", config: { type: "remote", url: "http://127.0.0.1:5000" } }],
    mcp_tool_refs: [{ tool_id: "workspace.lookup", server_id: "workspace", tool_name: "lookup" } satisfies HarnessHostPiMcpToolRef],
    workspace_config_checksum: "checksum-1",
    run_started_payload: { phase: "booting" },
    model_client: {
      model_proxy_provider: "openai_compatible",
      api_key: "token",
      base_url: undefined,
      default_headers: { "X-Test": "1" },
    },
  } satisfies HarnessHostPiRequest);
});

test("decodeHarnessHostPiRequestBase64 allows empty or missing system_prompt", () => {
  const emptyPrompt = decodeHarnessHostPiRequestBase64(
    encode({
      workspace_id: "workspace-1",
      workspace_dir: "/tmp/workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "Do the thing",
      context_messages: ["Recent runtime context"],
      provider_id: "openai",
      model_id: "gpt-5.1",
      timeout_seconds: 30,
      system_prompt: "",
      workspace_skill_dirs: [],
      mcp_servers: [],
      mcp_tool_refs: [],
      workspace_config_checksum: "checksum-1",
      run_started_payload: {},
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token"
      }
    })
  );
  const missingPrompt = decodeHarnessHostPiRequestBase64(
    encode({
      workspace_id: "workspace-1",
      workspace_dir: "/tmp/workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "Do the thing",
      context_messages: ["Recent runtime context"],
      provider_id: "openai",
      model_id: "gpt-5.1",
      timeout_seconds: 30,
      workspace_skill_dirs: [],
      mcp_servers: [],
      mcp_tool_refs: [],
      workspace_config_checksum: "checksum-1",
      run_started_payload: {},
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token"
      }
    })
  );

  assert.equal(emptyPrompt.system_prompt, "");
  assert.equal(missingPrompt.system_prompt, "");
  assert.deepEqual(emptyPrompt.context_messages, ["Recent runtime context"]);
  assert.deepEqual(missingPrompt.context_messages, ["Recent runtime context"]);
});

test("decodeAgentRuntimeConfigCliRequestBase64 defaults optional arrays and objects", () => {
  const request = decodeAgentRuntimeConfigCliRequestBase64(
    encode({
      session_id: "session-1",
      workspace_id: "workspace-1",
      input_id: "input-1",
      default_provider_id: "openai",
      session_mode: "code",
      workspace_config_checksum: "checksum-1",
      agent: {
        id: "agent-1",
        model: "openai/gpt-5.1",
        prompt: "system",
      }
    })
  );

  assert.deepEqual(request, {
    session_id: "session-1",
    workspace_id: "workspace-1",
    input_id: "input-1",
    runtime_exec_model_proxy_api_key: undefined,
    runtime_exec_sandbox_id: undefined,
    runtime_exec_run_id: undefined,
    selected_model: undefined,
    default_provider_id: "openai",
    session_mode: "code",
    workspace_config_checksum: "checksum-1",
    workspace_skill_ids: [],
    default_tools: [],
    extra_tools: [],
    tool_server_id_map: null,
    resolved_mcp_tool_refs: [],
    resolved_mcp_server_ids: [],
    resolved_output_schemas: {},
    agent: {
      id: "agent-1",
      model: "openai/gpt-5.1",
      prompt: "system",
      role: undefined,
    }
  });
});

test("decodeAgentRuntimeConfigCliRequestBase64 requires a single agent payload", () => {
  assert.throws(
    () =>
      decodeAgentRuntimeConfigCliRequestBase64(
        encode({
          session_id: "session-1",
          workspace_id: "workspace-1",
          input_id: "input-1",
          default_provider_id: "openai",
          session_mode: "code",
          workspace_config_checksum: "checksum-1"
        })
      ),
    /agent is required/
  );
});

test("decode workspace MCP sidecar request payloads", () => {
  assert.deepEqual(
    decodeWorkspaceMcpSidecarCliRequestBase64(
      encode({
        workspace_dir: "/tmp/workspace-1",
        physical_server_id: "workspace",
        expected_fingerprint: "fingerprint-1",
        timeout_ms: 15000,
        readiness_timeout_s: 10.5,
        catalog_json_base64: "eyJ0ZXN0Ijp0cnVlfQ==",
      })
    ),
    {
      workspace_dir: "/tmp/workspace-1",
      physical_server_id: "workspace",
      expected_fingerprint: "fingerprint-1",
      timeout_ms: 15000,
      readiness_timeout_s: 10.5,
      catalog_json_base64: "eyJ0ZXN0Ijp0cnVlfQ==",
    }
  );
});
