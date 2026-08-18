import assert from "node:assert/strict";
import test from "node:test";

import { piHarnessDefinition } from "./pi.js";

test("pi harness enables browser tools for every session kind except onboarding", () => {
  const buildHarnessHostRequest = piHarnessDefinition.runtimeAdapter.buildHarnessHostRequest;
  const baseParams = {
    request: {
      workspace_id: "workspace-1",
      session_id: "session-1",
      input_id: "input-1",
      instruction: "Inspect the project",
      context: {},
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
    browserSpace: "agent",
    request: {
      ...baseParams.request,
      model: "holaboss_model_proxy/gpt-5.4",
      session_kind: "subagent",
      context: { workflow_owned_subagent: true },
    },
  });
  const workspaceRequest = buildHarnessHostRequest({
    ...baseParams,
    browserSpace: "agent",
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
  assert.equal(subagentRequest.browser_space, "agent");
  // The main workspace loop gets browser tools too — its system prompt already
  // advertises "direct access to … browser". browserToolsEnabledForSessionKind
  // excludes only onboarding, so this asserted the reverse of the live policy.
  assert.equal(workspaceRequest.browser_tools_enabled, true);
  assert.equal(workspaceRequest.browser_space, "agent");
  assert.equal(onboardingRequest.browser_tools_enabled, false);
  assert.equal(onboardingRequest.browser_space, null);
  assert.equal(subagentRequest.selected_model, "holaboss_model_proxy/gpt-5.4");
  assert.equal(workspaceRequest.selected_model, null);
  assert.equal(onboardingRequest.selected_model, null);
  assert.equal(subagentRequest.workflow_owned_subagent, true);
  assert.equal(workspaceRequest.workflow_owned_subagent, false);
  assert.equal(onboardingRequest.workflow_owned_subagent, false);
  assert.deepEqual(subagentRequest.context_messages, []);
  assert.deepEqual(workspaceRequest.context_messages, []);
  assert.deepEqual(onboardingRequest.context_messages, []);
  // Both agent-operating kinds get the browser tool family folded into `tools`;
  // pinning the full list here would just re-break whenever a browser tool is
  // added, so assert the property that matters.
  for (const request of [subagentRequest, workspaceRequest]) {
    const tools = request.tools as Record<string, boolean>;
    assert.equal(tools.read, true);
    assert.ok(
      Object.keys(tools).some((name) => name.startsWith("browser_")),
      "an agent-operating session should carry browser tools",
    );
  }
  // Onboarding is the one exclusion — a constrained first-run flow with no
  // place for browser control.
  assert.deepEqual(onboardingRequest.tools, { read: true });
});
