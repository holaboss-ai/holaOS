import {
  bindHarnessHostPlugin,
  type HarnessDefinition,
} from "./types.js";
// Bossman injects the same Holaboss runtime MCP servers as every other harness
// (`holaboss_runtime` + `holaboss_runtime_tools`, runtime entries first) so it
// inherits full tool parity with pi/claude-code with no per-tool wiring.
import { buildHarnessMcpServers } from "./harness-mcp.js";

/**
 * Bossman — a Claude Agent SDK harness.
 *
 * Structurally this adapter is identical to claude-code's (same shared wire
 * payload), but the HOST RUNNER differs fundamentally: instead of shelling out
 * to the `claude` CLI with the user's own native auth, `runBossman` drives the
 * Agent SDK in-process and points it at the Holaboss MODEL PROXY via
 * `model_client`. That means Bossman is billed (consume_user_token), needs no
 * per-user Claude subscription, and can run any proxied model — while still
 * inheriting Claude's native tool-use / planning / context-compaction loop
 * (the reliability win over pi's hand-rolled loop).
 */
export const bossmanHarnessDefinition: HarnessDefinition = {
  id: "bossman",
  hostCommand: "run-bossman",
  displayName: "Bossman",
  runtimeAdapter: {
    id: "bossman",
    hostCommand: "run-bossman",
    displayName: "Bossman",
    capabilities: {
      requiresBackend: false,
      supportsStructuredOutput: false,
      supportsWaitingUser: true,
      supportsSkills: true,
      supportsMcpTools: true,
    },
    // Full catalogue, like Hola: empty means the desktop shows the runtime's
    // dynamic provider catalogue. Bossman can run ANY catalog model because the
    // engine's Anthropic-format request hits the proxy's /anthropic route, which
    // now accepts any catalog model and lets LiteLLM translate Anthropic→target
    // (chat + tool_use verified for gpt-5.5 / gemini). runBossman always forces
    // the /anthropic route regardless of the selected model's provider.
    supportedModels: [],
    buildRunnerPrepPlan() {
      return {
        stageWorkspaceSkills: false,
        stageWorkspaceCommands: false,
        prepareMcpTooling: true,
        startWorkspaceMcpSidecar: false,
        bootstrapResolvedApplications: true,
      };
    },
    buildHarnessHostRequest(params) {
      return {
        workspace_id: params.request.workspace_id,
        workspace_dir: params.bootstrap.workspaceDir,
        agent_cwd: params.bootstrap.agentCwd ?? params.bootstrap.workspaceDir,
        session_id: params.request.session_id,
        input_id: params.request.input_id,
        instruction: params.request.instruction,
        context_messages: params.runtimeConfig.context_messages ?? [],
        tools: { ...params.runtimeConfig.tools },
        attachments: params.request.attachments ?? [],
        image_urls: params.request.image_urls ?? [],
        thinking_value: params.request.thinking_value ?? null,
        debug: Boolean(params.request.debug),
        harness_session_id: params.bootstrap.requestedHarnessSessionId,
        persisted_harness_session_id: params.bootstrap.persistedHarnessSessionId,
        provider_id: params.runtimeConfig.provider_id,
        model_id: params.runtimeConfig.model_id,
        selected_model:
          typeof params.request.model === "string" && params.request.model.trim().length > 0
            ? params.request.model.trim()
            : null,
        timeout_seconds: params.timeoutSeconds,
        runtime_api_base_url: params.runtimeApiBaseUrl ?? null,
        system_prompt: params.runtimeConfig.system_prompt,
        workspace_skill_dirs: params.workspaceSkills.map((skill) => skill.source_dir),
        // Same unified MCP surface every harness gets: runtime endpoints
        // re-exposed as regular MCP servers. The Bossman runner maps these
        // straight into the Agent SDK's `mcpServers` option (identical schema).
        mcp_servers: buildHarnessMcpServers(params),
        mcp_tool_refs: params.mcpToolRefs.map((toolRef) => ({ ...toolRef })),
        workspace_config_checksum: params.runtimeConfig.workspace_config_checksum,
        run_started_payload: params.runStartedPayload,
        // Unlike claude-code, the Bossman runner DOES read model_client — it
        // points the Agent SDK's ANTHROPIC_BASE_URL + auth token at the proxy.
        model_client: {
          model_proxy_provider: params.runtimeConfig.model_client.model_proxy_provider,
          api_key: params.runtimeConfig.model_client.api_key,
          base_url: params.runtimeConfig.model_client.base_url,
          default_headers: params.runtimeConfig.model_client.default_headers,
        },
        agent_role: "main-loop",
      };
    },
    async describeRuntimeStatus() {
      return { ready: true, state: "ready" };
    },
  },
  bindHostPlugin(implementation) {
    return bindHarnessHostPlugin(bossmanHarnessDefinition, implementation);
  },
};
