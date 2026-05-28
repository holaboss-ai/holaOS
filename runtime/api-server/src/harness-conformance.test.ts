import assert from "node:assert/strict";
import test from "node:test";

import { HARNESS_DEFINITIONS } from "../../harnesses/src/index.js";

function baseBuildParams() {
  return {
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
      requestedHarnessSessionId: "requested-session-1",
      persistedHarnessSessionId: "persisted-session-1",
    },
    runtimeConfig: {
      provider_id: "hb_openai",
      model_id: "gpt-5.4",
      mode: "code",
      system_prompt: "You are concise.",
      prompt_layers: [],
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "token",
        base_url: "http://127.0.0.1:4000/openai/v1",
        default_headers: { "X-Test": "1" },
      },
      tools: { read: true, skill: true },
      workspace_tool_ids: ["workspace.lookup"],
      workspace_skill_ids: ["skill-creator"],
      output_schema_member_id: "main",
      output_format: { type: "json_schema", schema: { type: "object" } },
      workspace_config_checksum: "checksum-1",
    },
    workspaceSkills: [
      {
        skill_id: "skill-creator",
        skill_name: "skill-creator",
        description: "Skill creator",
        source_dir: "/tmp/workspace-1/skills/skill-creator",
        file_path: "/tmp/workspace-1/skills/skill-creator/SKILL.md",
        origin: "workspace" as const,
        owner_teammate_id: null,
        granted_tools: ["bash"],
        granted_commands: ["deploy-docs"],
      },
    ],
    mcpServers: [
      {
        name: "workspace",
        config: {
          type: "remote" as const,
          enabled: true,
          url: "http://127.0.0.1:5000/mcp",
          headers: {},
          timeout: 30000,
        },
      },
    ],
    mcpToolRefs: [{ tool_id: "workspace.lookup", server_id: "workspace", tool_name: "lookup" }],
    runStartedPayload: { phase: "booting" },
    backendBaseUrl: "",
    timeoutSeconds: 30,
  };
}

test("shared harness definitions expose only the pi harness", () => {
  assert.deepEqual(
    HARNESS_DEFINITIONS.map((definition) => ({
      id: definition.id,
      hostCommand: definition.hostCommand,
      capabilities: definition.runtimeAdapter.capabilities,
      prepPlan: definition.runtimeAdapter.buildRunnerPrepPlan({
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
      }),
    })),
    [
      {
        id: "pi",
        hostCommand: "run-pi",
        capabilities: {
          requiresBackend: false,
          supportsStructuredOutput: false,
          supportsWaitingUser: true,
          supportsSkills: true,
          supportsMcpTools: true,
        },
        prepPlan: {
          stageWorkspaceSkills: false,
          stageWorkspaceCommands: false,
          prepareMcpTooling: true,
          startWorkspaceMcpSidecar: true,
          bootstrapResolvedApplications: true,
        },
      },
    ]
  );
});

test("shared harness definitions build pi harness request shapes", () => {
  const [piDefinition] = HARNESS_DEFINITIONS;
  const piRequest = piDefinition.runtimeAdapter.buildHarnessHostRequest(baseBuildParams());

  assert.equal(piRequest.system_prompt, "You are concise.");
  assert.deepEqual(piRequest.context_messages, []);
  assert.deepEqual(piRequest.workspace_skill_dirs, [
    "/tmp/workspace-1/skills/skill-creator",
  ]);
  assert.deepEqual(piRequest.mcp_tool_refs, [{ tool_id: "workspace.lookup", server_id: "workspace", tool_name: "lookup" }]);
  assert.equal("output_format" in piRequest, false);
});
