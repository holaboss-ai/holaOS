import {
  bindHarnessHostPlugin,
  type HarnessDefinition,
} from "./types.js";
// claude-code injects the same Holaboss runtime MCP servers as every other CLI
// harness (`holaboss_runtime` + `holaboss_runtime_tools`, runtime entries
// first). Claude lists servers in order and ties ambiguous tool names to the
// earliest server, so runtime-first keeps the Holaboss surface winning on
// collision — which is exactly the shared builder's ordering.
import { buildHarnessMcpServers } from "./harness-mcp.js";

export const claudeCodeHarnessDefinition: HarnessDefinition = {
  id: "claude-code",
  hostCommand: "run-claude-code",
  displayName: "Claude Code",
  runtimeAdapter: {
    id: "claude-code",
    hostCommand: "run-claude-code",
    displayName: "Claude Code",
    capabilities: {
      requiresBackend: false,
      supportsStructuredOutput: false,
      supportsWaitingUser: true,
      supportsSkills: true,
      supportsMcpTools: true,
    },
    // Forwarded as `claude --model <id>` by the host runner. List +
    // labels are a static fallback catalogue. `default: true` on Sonnet 4.6 marks the
    // harness's preferred pick — the desktop picker uses this when
    // there's no per-session override.
    supportedModels: [
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", default: true },
      { id: "claude-fable-5", label: "Claude Fable 5", provider: "anthropic" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic" },
      { id: "claude-opus-4-7", label: "Claude Opus 4.7", provider: "anthropic" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", provider: "anthropic" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6", provider: "anthropic" },
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", provider: "anthropic" },
    ],
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
        // The unified MCP surface: re-expose the runtime's MCP endpoints as
        // regular MCP servers in the adapter payload so the host runner's
        // materializer adds them to `claude --mcp-config`. The oRPC `/mcp`
        // surfaces `outputs_list`; `/mcp/runtime-tools` surfaces the curated
        // runtime tools AND the workspace's connected Composio integration
        // tools (resolved per run, same as pi). Claude Code picks up new tool
        // categories automatically — no adapter change per addition.
        mcp_servers: buildHarnessMcpServers(params),
        mcp_tool_refs: params.mcpToolRefs.map((toolRef) => ({ ...toolRef })),
        workspace_config_checksum: params.runtimeConfig.workspace_config_checksum,
        run_started_payload: params.runStartedPayload,
        // The Claude Code runner uses native CLI auth and never reads
        // model_client, but the shared wire decoder (contracts.ts)
        // requires it as an object with non-empty strings. Forward
        // the runtime's config verbatim — same as pi — so the payload
        // type-checks at the host boundary even though it's unused
        // downstream.
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
    return bindHarnessHostPlugin(claudeCodeHarnessDefinition, implementation);
  },
};
