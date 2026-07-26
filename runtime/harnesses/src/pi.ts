import { bindHarnessHostPlugin, type HarnessDefinition } from "./types.js";
import { buildHarnessMcpToolName } from "./mcp.js";
import { browserToolsEnabledForSessionKind } from "./browser-session-gate.js";
import { ALL_BROWSER_TOOL_NAMES } from "./browser-capability-tools.js";

function agentRoleFromSessionKind(
  sessionKind: string | null | undefined,
): string {
  const normalized = String(sessionKind ?? "").trim().toLowerCase();
  if (!normalized || normalized === "workspace_session" || normalized === "main") {
    return "main-loop";
  }
  if (normalized === "task_proposal" || normalized === "subagent") {
    return "subagent";
  }
  if (normalized === "onboarding") {
    return "onboarding";
  }
  return normalized;
}

export const piHarnessDefinition: HarnessDefinition = {
  id: "pi",
  hostCommand: "run-pi",
  displayName: "Hola",
  runtimeAdapter: {
    id: "pi",
    hostCommand: "run-pi",
    displayName: "Hola",
    capabilities: {
      requiresBackend: false,
      supportsStructuredOutput: false,
      supportsWaitingUser: true,
      supportsSkills: true,
      supportsMcpTools: true,
      // Pi resumes from the session file handed in via the exec-context
      // (harness_session_id); the bootstrap must not also apply the cwd-scoped
      // workspace-file id. CLI harnesses resume from persisted_harness_session_id.
      resumesFromExecContextSessionId: true,
    },
    // Pi dispatches through the model proxy; the desktop uses the
    // runtime's dynamic provider catalogue (gpt-5.4, claude, …) via
    // ModelCombobox, so this list stays empty.
    supportedModels: [],
    buildRunnerPrepPlan() {
      return {
        stageWorkspaceSkills: false,
        stageWorkspaceCommands: false,
        prepareMcpTooling: true,
        startWorkspaceMcpSidecar: true,
        bootstrapResolvedApplications: true,
      };
    },
    buildHarnessHostRequest(params) {
      return {
        workspace_id: params.request.workspace_id,
        workspace_dir: params.bootstrap.workspaceDir,
        // Agent's actual cwd, separate from the workspace metadata root.
        // The harness loads workspace.yaml/skills/resources from
        // workspace_dir but spawns the agent (and the boundary policy)
        // around agent_cwd.
        agent_cwd: params.bootstrap.agentCwd ?? params.bootstrap.workspaceDir,
        session_id: params.request.session_id,
        browser_tools_enabled: browserToolsEnabledForSessionKind(
          params.request.session_kind,
        ),
        browser_space: params.browserSpace ?? null,
        input_id: params.request.input_id,
        instruction: params.request.instruction,
        workflow_owned_subagent:
          params.request.context?.workflow_owned_subagent === true,
        context_messages: params.runtimeConfig.context_messages ?? [],
        // The harness-host treats a non-empty `tools` map as an allowlist
        // (toolEnabledForPiRequest): a tool surfaces only if its name maps to
        // `true`. runtimeConfig.tools is derived from the capability manifest,
        // which only knows MCP tools that were in the runtime-config request's
        // resolved refs — so auto-attached workspace.yaml MCP servers (e.g. a
        // web HolaApp's need-review tools) are MISSING from it even though they
        // ARE in mcp_tool_refs and connect/discover fine. That desync made pi
        // silently filter every such tool out. Enable every resolved MCP tool
        // by its harness name here so `tools` can never lag `mcp_tool_refs`.
        tools: {
          ...params.runtimeConfig.tools,
          ...Object.fromEntries(
            params.mcpToolRefs.map((toolRef) => [
              buildHarnessMcpToolName(toolRef.server_id, toolRef.tool_name),
              true,
            ]),
          ),
          // Same desync as the MCP tools above: the desktop browser tools AND
          // the profile tools are resolved outside mcp_tool_refs, so none of
          // them land in `runtimeConfig.tools` and all would be filtered out.
          // Enable the whole browser family whenever it's active — the desktop
          // driving tools (navigate/get_state/click/type/…) act on the launched
          // profile window over CDP.
          ...(browserToolsEnabledForSessionKind(params.request.session_kind)
            ? Object.fromEntries(
                ALL_BROWSER_TOOL_NAMES.map((name) => [name, true]),
              )
            : {}),
        },
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
        mcp_servers: params.mcpServers.map((server) => ({
          name: server.name,
          config: { ...server.config },
          ...(server._holaboss_force_refresh ? { _holaboss_force_refresh: true } : {}),
        })),
        mcp_tool_refs: params.mcpToolRefs.map((toolRef) => ({ ...toolRef })),
        workspace_config_checksum: params.runtimeConfig.workspace_config_checksum,
        run_started_payload: params.runStartedPayload,
        model_client: {
          model_proxy_provider: params.runtimeConfig.model_client.model_proxy_provider,
          api_key: params.runtimeConfig.model_client.api_key,
          base_url: params.runtimeConfig.model_client.base_url,
          default_headers: params.runtimeConfig.model_client.default_headers,
        },
        agent_role: agentRoleFromSessionKind(params.request.session_kind),
      };
    },
    async describeRuntimeStatus() {
      return { ready: true, state: "ready" };
    },
  },
  bindHostPlugin(implementation) {
    return bindHarnessHostPlugin(piHarnessDefinition, implementation);
  },
};
