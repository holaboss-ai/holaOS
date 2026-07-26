import {
  bindHarnessHostPlugin,
  type HarnessCapabilities,
  type HarnessDefinition,
  type HarnessHostRequestBuildParams,
  type HarnessSupportedModel,
} from "./types.js";
import { buildHarnessMcpServers } from "./harness-mcp.js";

/**
 * Shared factory for CLI-based harness definitions. A CLI harness builds the
 * identical pi-shaped host request — instruction + system prompt + attachments
 * + the workspace MCP server list with the runtime `/mcp` endpoint prepended —
 * and differs only in id / displayName / model catalogue / capabilities. The
 * host-side runner is what makes each one distinct. (Kept as reusable
 * infrastructure; the shipped CLI harnesses claude-code/codex currently define
 * their definitions inline rather than through this factory.)
 */

/**
 * Sentinel model id meaning "no explicit model — let the CLI use its own
 * default." Used as the single static fallback entry for harnesses whose
 * real catalogue is only known via live discovery: a non-empty
 * `supportedModels` makes the desktop render a scoped picker (an empty list
 * would instead fall back to the pi provider combobox, which is wrong for a
 * CLI harness), while the runners treat this id as "unset" so the agent picks
 * its configured default rather than being handed a bogus id.
 */
export const AUTO_HARNESS_MODEL_ID = "__auto__";

/** Single "Default (auto)" fallback catalogue for discovery-only harnesses. */
export function autoModelFallback(provider: string): HarnessSupportedModel[] {
  return [{ id: AUTO_HARNESS_MODEL_ID, label: "Default (auto)", provider, default: true }];
}

const DEFAULT_CLI_CAPABILITIES: HarnessCapabilities = {
  requiresBackend: false,
  supportsStructuredOutput: false,
  supportsWaitingUser: true,
  supportsSkills: true,
  supportsMcpTools: true,
};

/** Build the pi-shaped host request every CLI harness sends, with the
 *  runtime `/mcp` server prepended to `mcp_servers`. */
export function buildCliHarnessHostRequest(
  params: HarnessHostRequestBuildParams,
): Record<string, unknown> {
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
    // Re-expose the runtime /mcp endpoint by prepending it to mcp_servers,
    // so the workspace tool surface (gofunds/holatag/etc.) reaches the CLI.
    mcp_servers: buildHarnessMcpServers(params),
    mcp_tool_refs: params.mcpToolRefs.map((toolRef) => ({ ...toolRef })),
    workspace_config_checksum: params.runtimeConfig.workspace_config_checksum,
    run_started_payload: params.runStartedPayload,
    // CLI runners use native auth and never read model_client, but the wire
    // decoder requires it as an object of non-empty strings — forward the
    // runtime's config verbatim so the payload type-checks at the boundary.
    model_client: {
      model_proxy_provider: params.runtimeConfig.model_client.model_proxy_provider,
      api_key: params.runtimeConfig.model_client.api_key,
      base_url: params.runtimeConfig.model_client.base_url,
      default_headers: params.runtimeConfig.model_client.default_headers,
    },
    agent_role: "main-loop",
  };
}

export interface CliHarnessDefinitionInput {
  id: string;
  /** Host command the ts-runner dispatches on; defaults to `run-<id>`. */
  hostCommand?: string;
  displayName: string;
  /** Static fallback catalogue (used when discovery is off or fails). */
  supportedModels: HarnessSupportedModel[];
  /** Discover the live model catalogue from the CLI (cached upstream). */
  dynamicModelDiscovery?: boolean;
  capabilities?: Partial<HarnessCapabilities>;
}

export function createCliHarnessDefinition(input: CliHarnessDefinitionInput): HarnessDefinition {
  const hostCommand = input.hostCommand ?? `run-${input.id}`;
  const definition: HarnessDefinition = {
    id: input.id,
    hostCommand,
    displayName: input.displayName,
    runtimeAdapter: {
      id: input.id,
      hostCommand,
      displayName: input.displayName,
      capabilities: { ...DEFAULT_CLI_CAPABILITIES, ...input.capabilities },
      supportedModels: input.supportedModels,
      ...(input.dynamicModelDiscovery ? { dynamicModelDiscovery: true } : {}),
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
        return buildCliHarnessHostRequest(params);
      },
      async describeRuntimeStatus() {
        return { ready: true, state: "ready" };
      },
    },
    bindHostPlugin(implementation) {
      return bindHarnessHostPlugin(definition, implementation);
    },
  };
  return definition;
}
