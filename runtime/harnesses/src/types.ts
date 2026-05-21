export interface HarnessBootstrapPayload {
  workspaceRoot: string;
  workspaceDir: string;
  requestedHarnessSessionId: string | null;
  persistedHarnessSessionId: string | null;
}

export interface HarnessToolRefPayload {
  tool_id: string;
  server_id: string;
  tool_name: string;
}

export interface HarnessInputAttachmentPayload {
  id: string;
  kind: "image" | "file" | "folder";
  name: string;
  mime_type: string;
  size_bytes: number;
  workspace_path: string;
}

export interface HarnessRunnerRequestLike {
  workspace_id: string;
  session_id: string;
  session_kind?: string | null;
  input_id: string;
  instruction: string;
  attachments?: HarnessInputAttachmentPayload[];
  image_urls?: string[];
  thinking_value?: string | null;
  debug?: boolean;
}

export interface HarnessModelClientPayload {
  model_proxy_provider: string;
  api_key: string;
  base_url?: string | null;
  default_headers?: Record<string, string> | null;
}

export type HarnessPromptLayerApplyAt = "runtime_config" | "harness_adapter";

export type HarnessPromptSectionChannel =
  | "system_prompt"
  | "context_message"
  | "resume_context"
  | "attachment";

export type HarnessPromptSectionPrecedence =
  | "base_runtime"
  | "session_policy"
  | "capability_policy"
  | "runtime_context"
  | "workspace_policy"
  | "harness_addendum"
  | "agent_override"
  | "emergency_override";

export type HarnessPromptLayerId =
  | "runtime_core"
  | "assistant_soul"
  | "execution_policy"
  | "response_delivery_policy"
  | "todo_continuity_policy"
  | "session_policy"
  | "capability_policy"
  | "capability_tool_routing"
  | "capability_availability_context"
  | "delegated_capability_availability_context"
  | "current_user_context"
  | "operator_surface_context"
  | "pending_user_memory"
  | "legacy_session_history"
  | "scratchpad_context"
  | "evolve_candidate_context"
  | "memory_recall"
  | "session_attachment_context"
  | "workspace_policy"
  | "resume_context"
  | "harness_quirks"
  | "recent_runtime_context";

export interface HarnessPromptLayerPayload {
  id: HarnessPromptLayerId;
  apply_at: HarnessPromptLayerApplyAt;
  content: string;
}

export interface HarnessPromptCacheProfilePayload {
  cacheable_section_ids: HarnessPromptLayerId[];
  volatile_section_ids: HarnessPromptLayerId[];
  context_message_ids: HarnessPromptLayerId[];
  resume_context_ids: HarnessPromptLayerId[];
  attachment_ids: HarnessPromptLayerId[];
  compatibility_context_ids: HarnessPromptLayerId[];
  delta_section_ids: HarnessPromptLayerId[];
  channel_section_ids: Partial<Record<HarnessPromptSectionChannel, HarnessPromptLayerId[]>>;
  precedence_order: HarnessPromptSectionPrecedence[];
  cacheable_system_prompt: string;
  volatile_system_prompt: string;
  cacheable_fingerprint: string;
  volatile_fingerprint: string | null;
  full_system_prompt_fingerprint: string;
}

export interface HarnessRuntimeConfigPayload {
  provider_id: string;
  model_id: string;
  mode: string;
  system_prompt: string;
  context_messages?: string[];
  prompt_layers?: HarnessPromptLayerPayload[];
  prompt_cache_profile?: HarnessPromptCacheProfilePayload;
  model_client: HarnessModelClientPayload;
  tools: Record<string, boolean>;
  workspace_tool_ids: string[];
  workspace_skill_ids: string[];
  output_schema_member_id?: string | null;
  output_format?: Record<string, unknown> | null;
  workspace_config_checksum: string;
}

export interface HarnessPreparedMcpServerPayload {
  name: string;
  config: {
    type: "local" | "remote";
    enabled: boolean;
    command?: string[];
    environment?: Record<string, string>;
    headers?: Record<string, string>;
    url?: string | null;
    timeout: number;
  };
  _holaboss_force_refresh?: boolean;
}

export interface HarnessHostRequestBuildParams {
  request: HarnessRunnerRequestLike;
  bootstrap: HarnessBootstrapPayload;
  runtimeConfig: HarnessRuntimeConfigPayload;
  prepared_instruction?: unknown;
  browserSpace?: "agent" | "user" | null;
  runtimeApiBaseUrl?: string | null;
  workspaceSkills: Array<{
    skill_id: string;
    source_dir: string;
  }>;
  mcpServers: HarnessPreparedMcpServerPayload[];
  mcpToolRefs: HarnessToolRefPayload[];
  runStartedPayload: Record<string, unknown>;
  backendBaseUrl: string;
  timeoutSeconds: number;
}

export interface HarnessModelConfigSyncRequest {
  workspace_root: string;
  provider_id: string;
  model_id: string;
  model_client: HarnessModelClientPayload;
}

export interface HarnessModelConfigSyncResult {
  path: string;
  backend_config_changed: boolean;
  model_selection_changed: boolean;
}

export interface HarnessBackendRestartRequest {
  workspace_root: string;
  workspace_id: string;
  backend_fingerprint: string;
  allow_reuse_existing: boolean;
  host: string;
  port: number;
  ready_timeout_s: number;
}

export interface HarnessPrepareRunParams {
  request: HarnessRunnerRequestLike;
  bootstrap: HarnessBootstrapPayload;
  runtimeConfig: HarnessRuntimeConfigPayload;
  stagedSkillsChanged: boolean;
  syncModelConfig: (request: HarnessModelConfigSyncRequest) => HarnessModelConfigSyncResult;
  restartBackend: (request: HarnessBackendRestartRequest) => Promise<void>;
  backendBaseUrl: string;
  backendHost: string;
  backendPort: number;
  backendReadyTimeoutSeconds: number;
  buildBackendFingerprint: (runtimeConfig: HarnessRuntimeConfigPayload, workspaceId: string) => string;
}

export interface HarnessRuntimeStatusContext {
  configLoaded: boolean;
  backendConfigPresent: boolean;
  backendReadinessTarget: string | null;
  probeBackendReadiness: (target: string) => Promise<boolean>;
}

export interface HarnessRuntimeStatus {
  ready: boolean;
  state: string;
}

export interface HarnessCapabilities {
  requiresBackend: boolean;
  supportsStructuredOutput: boolean;
  supportsWaitingUser: boolean;
  supportsSkills: boolean;
  supportsMcpTools: boolean;
}

export interface HarnessRunnerPrepPlan {
  stageWorkspaceSkills: boolean;
  stageWorkspaceCommands: boolean;
  prepareMcpTooling: boolean;
  startWorkspaceMcpSidecar: boolean;
  bootstrapResolvedApplications: boolean;
}

export interface HarnessRuntimeConfigUpdateContext {
  writeBootstrapConfigIfAvailable: () => void;
  ensureSelectedHarnessReady: () => Promise<void>;
}

export interface HarnessEnsureReadyContext {
  ensureHarnessBackendReady: () => Promise<void>;
}

export interface RuntimeHarnessAdapter {
  id: string;
  hostCommand: string;
  capabilities: HarnessCapabilities;
  buildRunnerPrepPlan: (params: {
    request: HarnessRunnerRequestLike;
    bootstrap: HarnessBootstrapPayload;
  }) => HarnessRunnerPrepPlan;
  buildHarnessHostRequest: (params: HarnessHostRequestBuildParams) => Record<string, unknown>;
  prepareRun?: (params: HarnessPrepareRunParams) => Promise<void>;
  describeRuntimeStatus: (params: HarnessRuntimeStatusContext) => Promise<HarnessRuntimeStatus>;
  handleRuntimeConfigUpdated?: (params: HarnessRuntimeConfigUpdateContext) => Promise<void>;
  ensureReady?: (params: HarnessEnsureReadyContext) => Promise<void>;
}

export interface HarnessHostPlugin {
  id: string;
  command: string;
  decodeRequestBase64: (encoded: string) => unknown;
  run: (request: unknown) => Promise<number>;
}

export interface HarnessHostImplementation {
  decodeRequestBase64: (encoded: string) => unknown;
  run: (request: unknown) => Promise<number>;
}

export interface HarnessDefinition {
  id: string;
  hostCommand: string;
  runtimeAdapter: RuntimeHarnessAdapter;
  bindHostPlugin: (implementation: HarnessHostImplementation) => HarnessHostPlugin;
}

export function bindHarnessHostPlugin(
  definition: Pick<HarnessDefinition, "id" | "hostCommand">,
  implementation: HarnessHostImplementation
): HarnessHostPlugin {
  return {
    id: definition.id,
    command: definition.hostCommand,
    decodeRequestBase64: implementation.decodeRequestBase64,
    run: implementation.run,
  };
}
