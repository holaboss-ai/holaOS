import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAgentCapabilityManifest,
  buildEnabledToolMapFromManifest,
  evaluateAgentCapabilities,
  renderDelegatedCapabilityAvailabilityContextPromptSection,
  renderCapabilityToolRoutingPromptSection,
  renderCapabilityPolicyPromptSection,
} from "./agent-capability-registry.js";

test("buildAgentCapabilityManifest classifies tools, skills, and MCP aliases", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: ["holaboss_onboarding_complete", "todoread", "todowrite"],
    workspaceCommandIds: ["hello"],
    defaultTools: ["read", "edit", "question", "todoread", "todowrite"],
    extraTools: ["browser_get_state", "holaboss_onboarding_complete", "todoread", "todowrite"],
    workspaceSkillIds: ["skill-creator"],
    resolvedMcpToolRefs: [
      {
        tool_id: "workspace.lookup",
        server_id: "workspace",
        tool_name: "lookup",
      },
    ],
  });

  assert.deepEqual(manifest.context, {
    harness_id: "pi",
    session_kind: "workspace_session",
    browser_tools_available: true,
    browser_tool_ids: ["browser_get_state"],
    runtime_tool_ids: ["holaboss_onboarding_complete", "todoread", "todowrite"],
    workspace_command_ids: ["hello"],
    workspace_commands_available: true,
    workspace_skills_available: true,
    mcp_tools_available: true,
  });
  assert.deepEqual(manifest.workspace_commands, ["hello"]);
  assert.deepEqual(manifest.workspace_skills, ["skill-creator"]);
  assert.deepEqual(manifest.browser_tools.map((capability) => capability.callable_name), ["browser_get_state"]);
  assert.deepEqual(
    manifest.runtime_tools.map((capability) => capability.callable_name).sort(),
    ["holaboss_onboarding_complete", "todoread", "todowrite"]
  );
  assert.ok(manifest.inspect.some((capability) => capability.callable_name === "read"));
  assert.ok(manifest.inspect.some((capability) => capability.callable_name === "browser_get_state"));
  assert.ok(
    manifest.inspect.some(
      (capability) => capability.callable_name === "mcp__workspace__lookup"
    )
  );
  assert.ok(manifest.mutate.some((capability) => capability.callable_name === "edit"));
  assert.ok(
    manifest.mutate.some((capability) => capability.callable_name === "holaboss_onboarding_complete")
  );
  assert.ok(manifest.coordinate.some((capability) => capability.callable_name === "question"));
  assert.ok(manifest.coordinate.some((capability) => capability.callable_name === "skill"));
  const todoWriteCapability = manifest.coordinate.find((capability) => capability.callable_name === "todowrite");
  const todoReadCapability = manifest.coordinate.find((capability) => capability.callable_name === "todoread");
  assert.ok(todoWriteCapability);
  assert.ok(todoReadCapability);
  assert.match(String(todoWriteCapability?.description ?? ""), /current phased todo plan/i);
  assert.match(String(todoReadCapability?.description ?? ""), /current phased todo plan/i);
  assert.ok(manifest.capabilities.some((capability) => capability.kind === "skill" && capability.id === "skill-creator"));
  assert.deepEqual(manifest.refresh_semantics, {
    evaluation_scope: "per_run",
    skills_resolved_at: "run_start",
    commands_resolved_at: "run_start",
    supports_live_deltas: false,
  });
  assert.deepEqual(
    manifest.reserved_surfaces.map((surface) => surface.kind),
    ["mcp_resource", "mcp_prompt", "mcp_command", "plugin_capability", "local_capability"]
  );
  assert.match(manifest.fingerprint, /^[a-f0-9]{64}$/);

  const toolMap = buildEnabledToolMapFromManifest(manifest);
  assert.equal(toolMap.read, true);
  assert.equal(toolMap.edit, true);
  assert.equal(toolMap.question, true);
  assert.equal(toolMap.todoread, true);
  assert.equal(toolMap.todowrite, true);
  assert.equal(toolMap.browser_get_state, true);
  assert.equal(toolMap.mcp__workspace__lookup, true);
  assert.equal(toolMap.skill, true);
});

test("buildAgentCapabilityManifest applies tool server id mappings to MCP callable names", () => {
  const manifest = buildAgentCapabilityManifest({
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [
      {
        tool_id: "workspace.lookup",
        server_id: "workspace",
        tool_name: "lookup",
      },
    ],
    toolServerIdMap: {
      workspace: "workspace__sandbox123",
    },
  });

  assert.deepEqual(manifest.mcp_tool_aliases, [
    {
      tool_id: "workspace.lookup",
      server_id: "workspace__sandbox123",
      tool_name: "lookup",
      callable_name: "mcp__workspace_sandbox123__lookup",
    },
  ]);
  assert.equal(
    buildEnabledToolMapFromManifest(manifest).mcp__workspace_sandbox123__lookup,
    true,
  );
});

test("buildAgentCapabilityManifest filters browser tools when policy context does not allow them", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "task_proposal",
    browserToolsAvailable: false,
    browserToolIds: [],
    runtimeToolIds: ["holaboss_onboarding_complete"],
    defaultTools: ["read"],
    extraTools: ["browser_get_state", "holaboss_onboarding_complete"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  assert.deepEqual(manifest.context, {
    harness_id: "pi",
    session_kind: "task_proposal",
    browser_tools_available: false,
    browser_tool_ids: [],
    runtime_tool_ids: ["holaboss_onboarding_complete"],
    workspace_command_ids: [],
    workspace_commands_available: false,
    workspace_skills_available: false,
    mcp_tools_available: false,
  });
  assert.equal(manifest.inspect.some((capability) => capability.callable_name === "browser_get_state"), false);
  assert.equal(manifest.mutate.some((capability) => capability.callable_name === "holaboss_onboarding_complete"), true);
  assert.equal(buildEnabledToolMapFromManifest(manifest).browser_get_state, undefined);
});

test("buildAgentCapabilityManifest includes staged browser tools for subagent sessions", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "subagent",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: [],
    defaultTools: ["read"],
    extraTools: ["browser_get_state"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  assert.equal(manifest.inspect.some((capability) => capability.callable_name === "browser_get_state"), true);
  assert.equal(buildEnabledToolMapFromManifest(manifest).browser_get_state, true);
});

test("buildAgentCapabilityManifest excludes browser tools for onboarding sessions even when staged", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "onboarding",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: ["holaboss_onboarding_complete"],
    defaultTools: ["read"],
    extraTools: ["browser_get_state", "holaboss_onboarding_complete"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  assert.equal(manifest.inspect.some((capability) => capability.callable_name === "browser_get_state"), false);
  assert.equal(manifest.mutate.some((capability) => capability.callable_name === "holaboss_onboarding_complete"), true);
  assert.equal(buildEnabledToolMapFromManifest(manifest).browser_get_state, undefined);
});

test("buildAgentCapabilityManifest includes native web search as a runtime tool", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: false,
    browserToolIds: [],
    runtimeToolIds: ["web_search"],
    defaultTools: ["read"],
    extraTools: ["web_search"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const capability = manifest.runtime_tools.find((entry) => entry.id === "web_search");
  assert.ok(capability);
  assert.equal(capability.title, "Web Search");
  assert.match(capability.description, /discover and summarize information across multiple sources/i);
  assert.match(capability.description, /exact live values, platform-native rankings or filters, UI-only state/i);
  assert.match(capability.description, /escalate to browser tools or another more direct capability/i);
  assert.equal(buildEnabledToolMapFromManifest(manifest).web_search, true);
});

test("renderCapabilityToolRoutingPromptSection tells main sessions to delegate when direct capability is missing", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: false,
    browserToolIds: [],
    runtimeToolIds: ["holaboss_delegate_task", "holaboss_continue_subagent"],
    defaultTools: ["read", "edit"],
    extraTools: ["holaboss_delegate_task", "holaboss_continue_subagent"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const section = renderCapabilityToolRoutingPromptSection(manifest);
  assert.match(section, /Delegation routing:/);
  assert.match(section, /use `holaboss_delegate_task` instead of replying that the current run lacks those tools/i);
  assert.match(section, /main session as a coordinator first/i);
  assert.match(section, /browser-heavy, web-heavy, terminal-heavy, multi-step, or interruptible/i);
  assert.match(section, /Available-tool fallback:/);
  assert.match(section, /missing the ideal MCP, API, browser, web, terminal, or file tool is not enough to stop/i);
  assert.match(section, /choose another viable direct or delegated route/i);
  assert.match(section, /Deliverable routing: when the user asks for a report, brief, memo, digest, recap, or other long-form deliverable, prefer `holaboss_delegate_task`/);
  assert.match(section, /Do not lead with a capability apology, manual workaround, or "I can't do that here" answer when delegation is available/i);
  assert.match(section, /trust the current run and retry the tool when it is the right path/i);
  assert.match(section, /Only surface a hard capability limitation to the user when neither the current run nor delegated subagents can actually carry out the request/i);
  assert.match(section, /Continuation routing:/);
  assert.match(section, /use `holaboss_continue_subagent` on the relevant completed child session instead of creating a brand-new delegated task/i);
  assert.match(section, /ask which one the user means before continuing/i);
});

test("renderCapabilityToolRoutingPromptSection prefers surfaced MCP tools before diagnostic fallbacks in executor sessions", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "subagent",
    defaultTools: ["read", "bash"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [
      {
        tool_id: "twitter.twitter_create_post",
        server_id: "twitter",
        tool_name: "twitter_create_post",
      },
    ],
  });

  const section = renderCapabilityToolRoutingPromptSection(manifest);
  assert.match(section, /MCP-first routing:/);
  assert.match(section, /when surfaced MCP\/app tools match the target system or supplied URL, use them before opening the web app, web search, bash, or file inspection/i);
  assert.match(section, /Do not open that system in the browser, run web search, or rediscover it from files or config when surfaced MCP\/app tools already cover it/i);
  assert.match(section, /Use file, config, browser, or web inspection around an MCP\/app route only after a surfaced tool call is blocked, fails/i);
  assert.match(section, /In executor sessions, prefer proving capability by actually invoking the relevant surfaced MCP\/app tool/i);
});

test("renderDelegatedCapabilityAvailabilityContextPromptSection exposes backstage tools without expanding direct authority", () => {
  const directManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "workspace_session",
    defaultTools: ["read", "question"],
    extraTools: ["holaboss_delegate_task"],
    runtimeToolIds: ["holaboss_delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });
  const delegatedManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "subagent",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: ["list_data_tables", "create_dashboard"],
    defaultTools: ["read", "edit", "bash"],
    extraTools: ["browser_get_state", "list_data_tables", "create_dashboard"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [
      {
        tool_id: "twitter.twitter_create_post",
        server_id: "twitter",
        tool_name: "twitter_create_post",
      },
    ],
  });

  const section = renderDelegatedCapabilityAvailabilityContextPromptSection(
    directManifest,
    delegatedManifest,
  );
  assert.match(section, /Delegated executor capability snapshot:/);
  assert.match(section, /do not expand your own direct authority in this front session/i);
  assert.match(section, /Delegated browser tools: available \(1 enabled\)\./);
  assert.match(section, /Delegated runtime tools: available \(2 enabled\)\./);
  assert.match(section, /Delegated connected MCP\/app access: available\./);
  assert.match(section, /Delegated browser execution is available even though this front session has no direct browser tools\./);
  assert.match(section, /Delegated app integrations available via: `twitter`\./);
  assert.match(section, /Delegated MCP callable tool aliases for routing only:/);
  assert.match(section, /`twitter\.twitter_create_post` -> call `mcp__twitter__twitter_create_post`/);
  assert.match(section, /Notable delegated-only tools for this run:/);
  assert.match(section, /Create Dashboard \(`create_dashboard`\)/);
  assert.match(section, /List Data Tables \(`list_data_tables`\)/);
  assert.match(section, /Twitter Create Post \(`mcp__twitter__twitter_create_post`\)/);
});

test("renderDelegatedCapabilityAvailabilityContextPromptSection keeps delegated MCP detail even when front session has direct MCP", () => {
  const directManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "workspace_session",
    defaultTools: ["read", "question"],
    extraTools: ["holaboss_delegate_task"],
    runtimeToolIds: ["holaboss_delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [
      {
        tool_id: "workspace.lookup",
        server_id: "workspace",
        tool_name: "lookup",
      },
    ],
  });
  const delegatedManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "subagent",
    defaultTools: ["read", "edit", "bash"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [
      {
        tool_id: "notion.notion_get_page",
        server_id: "notion",
        tool_name: "notion_get_page",
      },
    ],
  });

  const section = renderDelegatedCapabilityAvailabilityContextPromptSection(
    directManifest,
    delegatedManifest,
  );

  assert.match(section, /Delegated connected MCP\/app access: available\./);
  assert.match(section, /Delegated app integrations available via: `notion`\./);
  assert.match(section, /Delegated MCP callable tool aliases for routing only:/);
  assert.match(section, /`notion\.notion_get_page` -> call `mcp__notion__notion_get_page`/);
});

test("buildAgentCapabilityManifest marks connected MCP servers as available without pre-enumerated tool refs", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "workspace_session",
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    resolvedMcpServerIds: ["context7"],
  });

  assert.deepEqual(manifest.context, {
    harness_id: "pi",
    session_kind: "workspace_session",
    browser_tools_available: false,
    browser_tool_ids: [],
    runtime_tool_ids: [],
    workspace_command_ids: [],
    mcp_server_ids: ["context7"],
    workspace_commands_available: false,
    workspace_skills_available: false,
    mcp_tools_available: true,
  });
  assert.deepEqual(manifest.mcp_tools, []);

  const section = renderCapabilityPolicyPromptSection(manifest);
  assert.match(section, /Connected MCP access: available\./);
  assert.match(section, /Use surfaced MCP tools when relevant; tool names may be resolved dynamically by the runtime\./i);
  assert.doesNotMatch(section, /MCP callable tool aliases for this run:/);
});

test("buildAgentCapabilityManifest carries browser tool descriptions that emphasize live verification", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: [],
    defaultTools: ["read"],
    extraTools: ["browser_get_state"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const capability = manifest.browser_tools.find((entry) => entry.id === "browser_get_state");
  assert.ok(capability);
  assert.match(capability.description, /DOM-first browser inspection tool for actions and structured extraction/i);
  assert.match(capability.description, /visible media such as images/i);
  assert.match(capability.description, /include_screenshot=true/i);
  assert.match(capability.description, /user-visible confirmation matters,? or when DOM signals are ambiguous/i);
});

test("evaluateAgentCapabilities keeps command and skill surfaces while excluding non-staged browser tools", () => {
  const evaluation = evaluateAgentCapabilities({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: true,
    browserToolIds: [],
    runtimeToolIds: ["holaboss_onboarding_complete"],
    workspaceCommandIds: ["hello"],
    defaultTools: ["read"],
    extraTools: ["browser_get_state", "holaboss_onboarding_complete"],
    workspaceSkillIds: ["skill-creator"],
    resolvedMcpToolRefs: [],
  });

  const browserCapability = evaluation.capabilities.find((capability) => capability.id === "browser_get_state");
  assert.ok(browserCapability);
  assert.equal(browserCapability.visible_to_model, false);
  assert.equal(browserCapability.call_allowed, false);
  assert.equal(browserCapability.can_execute, false);
  assert.equal(browserCapability.unavailable_reason, "browser_tool_not_staged");

  const commandCapability = evaluation.capabilities.find((capability) => capability.kind === "workspace_command");
  assert.ok(commandCapability);
  assert.equal(commandCapability.id, "hello");
  assert.equal(commandCapability.visible_to_model, true);
  assert.equal(commandCapability.call_allowed, false);
  assert.equal(commandCapability.can_execute, false);
  assert.equal(commandCapability.permission_surface, "workspace_command");
  assert.equal(commandCapability.execution_mode, "command_reference");
  assert.equal(commandCapability.trust_level, "workspace");
  assert.deepEqual(commandCapability.execution_semantics, {
    concurrency: "serial_only",
    requires_runtime_service: false,
    requires_browser: false,
    requires_user_confirmation: false,
  });
  assert.deepEqual(commandCapability.authority_boundary, {
    filesystem: false,
    shell: false,
    network: false,
    browser: false,
    runtime_state: false,
  });
  assert.equal(commandCapability.unavailable_reason, "command_reference_only");

  const skillCapability = evaluation.capabilities.find(
    (capability) => capability.kind === "skill" && capability.id === "skill-creator"
  );
  assert.ok(skillCapability);
  assert.equal(skillCapability.visible_to_model, true);
  assert.equal(skillCapability.call_allowed, false);
  assert.equal(skillCapability.can_execute, true);
  assert.equal(skillCapability.permission_surface, "workspace_skill");
  assert.equal(skillCapability.execution_mode, "skill_reference");
  assert.deepEqual(skillCapability.execution_semantics, {
    concurrency: "parallel_safe",
    requires_runtime_service: false,
    requires_browser: false,
    requires_user_confirmation: false,
  });
  assert.deepEqual(
    evaluation.reserved_surfaces.map((surface) => surface.kind),
    ["mcp_resource", "mcp_prompt", "mcp_command", "plugin_capability", "local_capability"]
  );
});

test("evaluateAgentCapabilities includes richer execution and authority metadata", () => {
  const evaluation = evaluateAgentCapabilities({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: ["holaboss_onboarding_complete"],
    defaultTools: ["bash", "question"],
    extraTools: ["browser_get_state", "holaboss_onboarding_complete"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const browserCapability = evaluation.capabilities.find((capability) => capability.id === "browser_get_state");
  assert.ok(browserCapability);
  assert.deepEqual(browserCapability.execution_semantics, {
    concurrency: "session_exclusive",
    requires_runtime_service: false,
    requires_browser: true,
    requires_user_confirmation: false,
  });
  assert.deepEqual(browserCapability.authority_boundary, {
    filesystem: false,
    shell: false,
    network: false,
    browser: true,
    runtime_state: false,
  });

  const runtimeCapability = evaluation.capabilities.find((capability) => capability.id === "holaboss_onboarding_complete");
  assert.ok(runtimeCapability);
  assert.deepEqual(runtimeCapability.execution_semantics, {
    concurrency: "serial_only",
    requires_runtime_service: true,
    requires_browser: false,
    requires_user_confirmation: true,
  });
  assert.deepEqual(runtimeCapability.authority_boundary, {
    filesystem: false,
    shell: false,
    network: false,
    browser: false,
    runtime_state: true,
  });

  const bashCapability = evaluation.capabilities.find((capability) => capability.id === "bash");
  assert.ok(bashCapability);
  assert.deepEqual(bashCapability.authority_boundary, {
    filesystem: true,
    shell: true,
    network: true,
    browser: false,
    runtime_state: false,
  });

  const questionCapability = evaluation.capabilities.find((capability) => capability.id === "question");
  assert.ok(questionCapability);
  assert.equal(questionCapability.execution_semantics.requires_user_confirmation, true);
  assert.equal(questionCapability.execution_semantics.concurrency, "session_exclusive");
});

test("runtime download capability advertises network and filesystem authority", () => {
  const evaluation = evaluateAgentCapabilities({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: false,
    browserToolIds: [],
    runtimeToolIds: ["download_url"],
    defaultTools: ["read"],
    extraTools: ["download_url"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const capability = evaluation.capabilities.find((entry) => entry.id === "download_url");
  assert.ok(capability);
  assert.deepEqual(capability.authority_boundary, {
    filesystem: true,
    shell: false,
    network: true,
    browser: false,
    runtime_state: true,
  });

  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "workspace_session",
    runtimeToolIds: ["download_url"],
    defaultTools: ["read"],
    extraTools: ["download_url"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });
  const section = renderCapabilityPolicyPromptSection(manifest);
  assert.match(section, /prefer `download_url` when you already have a direct asset URL/i);
});

test("evaluateAgentCapabilities fingerprints the run snapshot", () => {
  const base = evaluateAgentCapabilities({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: ["holaboss_onboarding_complete"],
    workspaceCommandIds: ["hello"],
    defaultTools: ["read"],
    extraTools: ["browser_get_state", "holaboss_onboarding_complete"],
    workspaceSkillIds: ["skill-creator"],
    resolvedMcpToolRefs: [],
  });
  const same = evaluateAgentCapabilities({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: ["holaboss_onboarding_complete"],
    workspaceCommandIds: ["hello"],
    defaultTools: ["read"],
    extraTools: ["browser_get_state", "holaboss_onboarding_complete"],
    workspaceSkillIds: ["skill-creator"],
    resolvedMcpToolRefs: [],
  });
  const changed = evaluateAgentCapabilities({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: ["holaboss_onboarding_complete"],
    workspaceCommandIds: ["hello"],
    defaultTools: ["read"],
    extraTools: ["browser_get_state", "holaboss_onboarding_complete"],
    workspaceSkillIds: ["skill-creator", "extra-skill"],
    resolvedMcpToolRefs: [],
  });

  assert.equal(base.fingerprint, same.fingerprint);
  assert.notEqual(base.fingerprint, changed.fingerprint);
});

test("renderCapabilityPolicyPromptSection summarizes grouped capabilities", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: false,
    runtimeToolIds: ["holaboss_onboarding_complete"],
    workspaceCommandIds: ["hello"],
    defaultTools: ["read", "edit", "question"],
    extraTools: ["browser_get_state", "holaboss_onboarding_complete"],
    workspaceSkillIds: ["skill-creator"],
    resolvedMcpToolRefs: [
      {
        tool_id: "workspace.lookup",
        server_id: "workspace",
        tool_name: "lookup",
      },
    ],
  });

  const section = renderCapabilityPolicyPromptSection(manifest);
  assert.match(section, /Capability policy for this run:/);
  assert.match(section, /Harness: pi\./);
  assert.match(section, /Session kind: workspace_session\./);
  assert.match(section, /Inspect tools: available \(2 enabled\)\./);
  assert.match(section, /Mutating tools: available \(2 enabled\)\./);
  assert.match(section, /Coordination tools: available \(3 enabled\)\./);
  assert.match(section, /Runtime tools: available \(1 enabled\)\./);
  assert.match(section, /Workspace commands: available \(1 enabled\)\./);
  assert.match(section, /Workspace skills: available \(1 enabled\)\./);
  assert.match(section, /Browser tools: none\./);
  assert.match(section, /Connected MCP access: available\./);
  assert.match(section, /Use surfaced MCP tools when relevant/);
  assert.match(
    section,
    /When the capability snapshot lists an MCP tool id alongside a callable alias, use the callable alias for tool invocation\./i,
  );
  assert.match(section, /MCP callable tool aliases for this run:/);
  assert.match(
    section,
    /`workspace\.lookup` -> call `mcp__workspace__lookup`/,
  );
  assert.doesNotMatch(section, /Skills available now:/);
  assert.doesNotMatch(section, /Connected MCP tools available now:/);
});

test("renderCapabilityPolicyPromptSection surfaces front-session delegation semantics", () => {
  const manifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "workspace_session",
    browserToolsAvailable: false,
    browserToolIds: [],
    runtimeToolIds: ["holaboss_delegate_task"],
    defaultTools: ["read"],
    extraTools: ["holaboss_delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const section = renderCapabilityPolicyPromptSection(manifest);
  assert.match(section, /Browser tools: none\./);
  assert.match(section, /This front session is intentionally capability-incomplete\./);
  assert.match(section, /Treat the surfaced tools above as your full direct capability set for this run/i);
  assert.match(section, /if the request needs more and `holaboss_delegate_task` is available, delegate it/i);
});
