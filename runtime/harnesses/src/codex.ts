import {
  bindHarnessHostPlugin,
  type HarnessDefinition,
} from "./types.js";
import { buildHarnessMcpServers } from "./harness-mcp.js";

export const codexHarnessDefinition: HarnessDefinition = {
  id: "codex",
  hostCommand: "run-codex",
  displayName: "Codex",
  runtimeAdapter: {
    id: "codex",
    hostCommand: "run-codex",
    displayName: "Codex",
    capabilities: {
      requiresBackend: false,
      supportsStructuredOutput: false,
      supportsWaitingUser: true,
      supportsSkills: true,
      supportsMcpTools: true,
    },
    // Live-discovered per account from `codex app-server`'s `model/list`
    // (see harness-host discoverCodexModels) — the only surface that reports
    // the models the account can actually use on the app-server path (a
    // ChatGPT-plan login gets a different set than an API key). This static
    // list is the fallback when discovery fails. GPT-5.5 is the preferred pick.
    dynamicModelDiscovery: true,
    supportedModels: [
      { id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true },
      { id: "gpt-5.5-mini", label: "GPT-5.5 mini", provider: "openai" },
      { id: "gpt-5.4", label: "GPT-5.4", provider: "openai" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", provider: "openai" },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", provider: "openai" },
      { id: "gpt-5", label: "GPT-5", provider: "openai" },
      { id: "o3", label: "o3", provider: "openai" },
      { id: "o3-mini", label: "o3-mini", provider: "openai" },
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
        // Re-expose the runtime /mcp endpoint to codex by prepending
        // it to mcp_servers — symmetrical to the Claude Code adapter.
        // The materializer translates it into a [mcp_servers.NAME]
        // TOML table with url + headers.
        mcp_servers: buildHarnessMcpServers(params),
        mcp_tool_refs: params.mcpToolRefs.map((toolRef) => ({ ...toolRef })),
        workspace_config_checksum: params.runtimeConfig.workspace_config_checksum,
        run_started_payload: params.runStartedPayload,
        // The Codex runner uses native CLI auth and never reads
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
    return bindHarnessHostPlugin(codexHarnessDefinition, implementation);
  },
};
