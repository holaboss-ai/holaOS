import assert from "node:assert/strict";
import test from "node:test";

import { piHarnessDefinition } from "./pi.js";

test("pi harness enables browser tools only for executor sessions", () => {
  const buildHarnessHostRequest = piHarnessDefinition.runtimeAdapter.buildHarnessHostRequest;
  const baseParams = {
    request: {
      workspace_id: "workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "Inspect the project",
      debug: false,
    },
    bootstrap: {
      workspaceRoot: "/tmp",
      workspaceDir: "/tmp/workspace-1",
      requestedHarnessSessionId: null,
      persistedHarnessSessionId: null,
    },
    runtimeConfig: {
      provider_id: "openai",
      model_id: "gpt-5.4",
      mode: "code",
      system_prompt: "You are concise.",
      workspace_config_checksum: "checksum-1",
      context_messages: [],
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token",
        base_url: "http://127.0.0.1:4000/openai/v1",
        default_headers: { "X-Test": "1" },
      },
      tools: { read: true },
      workspace_tool_ids: [],
      workspace_skill_ids: [],
    },
    runtimeApiBaseUrl: "http://127.0.0.1:5060",
    workspaceSkills: [],
    mcpServers: [],
    mcpToolRefs: [],
    runStartedPayload: {},
    backendBaseUrl: "",
    timeoutSeconds: 60,
  };

  const subagentRequest = buildHarnessHostRequest({
    ...baseParams,
    browserSpace: "user",
    request: {
      ...baseParams.request,
      session_kind: "subagent",
    },
  });
  const taskProposalRequest = buildHarnessHostRequest({
    ...baseParams,
    browserSpace: "agent",
    request: {
      ...baseParams.request,
      session_kind: "task_proposal",
    },
  });
  const workspaceRequest = buildHarnessHostRequest({
    ...baseParams,
    browserSpace: "user",
    request: {
      ...baseParams.request,
      session_kind: "workspace_session",
    },
  });
  const onboardingRequest = buildHarnessHostRequest({
    ...baseParams,
    request: {
      ...baseParams.request,
      session_kind: "onboarding",
    },
  });

  assert.equal(subagentRequest.browser_tools_enabled, true);
  assert.equal(subagentRequest.browser_space, "user");
  assert.equal(taskProposalRequest.browser_tools_enabled, true);
  assert.equal(taskProposalRequest.browser_space, "agent");
  assert.equal(workspaceRequest.browser_tools_enabled, false);
  assert.equal(workspaceRequest.browser_space, "user");
  assert.equal(onboardingRequest.browser_tools_enabled, false);
  assert.equal(onboardingRequest.browser_space, null);
  assert.deepEqual(subagentRequest.context_messages, []);
  assert.deepEqual(taskProposalRequest.context_messages, []);
  assert.deepEqual(workspaceRequest.context_messages, []);
  assert.deepEqual(onboardingRequest.context_messages, []);
  assert.deepEqual(subagentRequest.tools, { read: true });
  assert.deepEqual(taskProposalRequest.tools, { read: true });
  assert.deepEqual(workspaceRequest.tools, { read: true });
  assert.deepEqual(onboardingRequest.tools, { read: true });
});
