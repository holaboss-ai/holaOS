import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentCapabilityManifest } from "./agent-capability-registry.js";
import { composeAgentPrompt, composeBaseAgentPrompt } from "./agent-runtime-prompt.js";

test("composeBaseAgentPrompt returns ordered runtime prompt layers", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "main_session",
    defaultTools: ["read", "edit"],
    extraTools: [],
    workspaceSkillIds: ["skill-creator"],
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

  const prompt = composeBaseAgentPrompt("You are concise.", {
    defaultTools: ["read", "edit"],
    extraTools: [],
    workspaceSkillIds: ["skill-creator"],
    resolvedMcpToolRefs: [
      {
        tool_id: "workspace.lookup",
        server_id: "workspace",
        tool_name: "lookup",
      },
    ],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.deepEqual(prompt.promptLayers.map((layer) => layer.id), [
    "runtime_core",
    "execution_policy",
    "response_delivery_policy",
    "session_policy",
    "capability_policy",
    "capability_tool_routing",
    "workspace_policy",
  ]);
  assert.deepEqual(prompt.promptSections.map((section) => section.id), [
    "runtime_core",
    "execution_policy",
    "response_delivery_policy",
    "session_policy",
    "capability_policy",
    "capability_tool_routing",
    "capability_availability_context",
    "workspace_policy",
  ]);
  assert.deepEqual(prompt.promptSections.map((section) => section.channel), [
    "system_prompt",
    "system_prompt",
    "system_prompt",
    "system_prompt",
    "system_prompt",
    "system_prompt",
    "context_message",
    "system_prompt",
  ]);
  assert.deepEqual(prompt.promptSections.map((section) => section.priority), [100, 200, 250, 300, 400, 425, 450, 600]);
  assert.deepEqual(prompt.promptSections.map((section) => section.volatility), [
    "stable",
    "stable",
    "stable",
    "workspace",
    "workspace",
    "workspace",
    "run",
    "workspace",
  ]);
  assert.deepEqual(prompt.promptSections.map((section) => section.precedence), [
    "base_runtime",
    "base_runtime",
    "base_runtime",
    "session_policy",
    "capability_policy",
    "capability_policy",
    "capability_policy",
    "workspace_policy",
  ]);
  assert.deepEqual(prompt.promptLayers.map((layer) => layer.apply_at), [
    "runtime_config",
    "runtime_config",
    "runtime_config",
    "runtime_config",
    "runtime_config",
    "runtime_config",
    "runtime_config",
  ]);
  assert.match(prompt.systemPrompt, /^Base runtime instructions:/);
  assert.match(prompt.systemPrompt, /Execution doctrine:/);
  assert.match(prompt.systemPrompt, /Response delivery policy:/);
  assert.match(
    prompt.systemPrompt,
    /Treat the final session reply as a handoff, not the full deliverable surface\./,
  );
  assert.match(
    prompt.systemPrompt,
    /For evidence-heavy work, keep the final session message short and put the full result in an artifact or report\./,
  );
  assert.match(
    prompt.systemPrompt,
    /Inspect before mutating workspace, app, browser, runtime state, or external systems when possible\./
  );
  assert.match(
    prompt.systemPrompt,
    /After edits, commands, browser actions, or state-changing tool calls, verify the result with the most direct inspection path available\./
  );
  assert.match(
    prompt.systemPrompt,
    /If evidence is incomplete, keep retrieving or say what remains unverified; do not claim side effects happened without proof in this turn\./
  );
  assert.match(
    prompt.systemPrompt,
    /Treat deleting files, wiping directories, `replace_existing`, or blanking a non-empty file as destructive; do them only when the user explicitly asked\./
  );
  assert.match(
    prompt.systemPrompt,
    /Use available tools, skills, and MCP integrations when they are more reliable than reasoning alone\./
  );
  assert.match(
    prompt.systemPrompt,
    /Use MCP tools directly, and prefer surfaced MCP\/app tools over browser work, web search, bash, or file inspection when they match the target system, including its URLs\./
  );
  assert.doesNotMatch(
    prompt.systemPrompt,
    /Do not route an MCP-backed task through the browser just because browser tools are available; use browser tools for that system only when the user explicitly asks for browser use, the task explicitly requires UI interaction, independent visual verification is required, or the MCP route is blocked\./
  );
  assert.match(
    prompt.systemPrompt,
    /Treat explicit user requirements and verification targets as completion criteria, not optional detail\./
  );
  assert.match(
    prompt.systemPrompt,
    /Treat the active workspace root as the default boundary\./
  );
  assert.match(
    prompt.systemPrompt,
    /Do not cross it unless the user explicitly asks\./
  );
  assert.match(
    prompt.systemPrompt,
    /If a surfaced path returns `ENOENT` or `Path not found`, stop guessing paths outside the active workspace\./
  );
  assert.match(
    prompt.systemPrompt,
    /Keep short lookups and straightforward explanations inline\./
  );
  assert.match(
    prompt.systemPrompt,
    /Do not create a report just because tools were used\./
  );
  assert.match(
    prompt.systemPrompt,
    /Use `write_report` for long, structured, evidence-heavy, or referenceable outputs/
  );
  assert.match(prompt.systemPrompt, /reports should be HTML by default/i);
  assert.match(
    prompt.systemPrompt,
    /For research, investigation, comparison, timeline, or latest-news tasks across multiple sources, prefer a report artifact/
  );
  assert.match(
    prompt.systemPrompt,
    /mention only the report path or title and the most important takeaways in chat/i
  );
  assert.match(
    prompt.systemPrompt,
    /Use tools, not hidden state\. The newest user message is primary\./
  );
  assert.match(
    prompt.systemPrompt,
    /Resume unfinished work only when the newest message asks to continue it/
  );
  assert.match(
    prompt.systemPrompt,
    /Use `AGENTS\.md` for workspace-wide operating rules, defaults, conventions, and recurring commands that should shape behavior by default on future runs; use local skills for situational workflows\./i
  );
  assert.match(prompt.systemPrompt, /Session policy:/);
  assert.match(prompt.systemPrompt, /front-of-house workspace session/i);
  assert.match(prompt.systemPrompt, /Capability policy for this run:/);
  assert.match(prompt.systemPrompt, /Workspace instructions from AGENTS\.md:/);
  assert.doesNotMatch(prompt.systemPrompt, /OpenCode MCP tool naming:/);
  assert.doesNotMatch(prompt.systemPrompt, /Inspect capabilities available now:/);
  assert.doesNotMatch(prompt.systemPrompt, /Mutating capabilities available now:/);
  assert.doesNotMatch(prompt.systemPrompt, /Connected MCP tools available now:/);
  assert.doesNotMatch(prompt.systemPrompt, /Skills available now:/);
  assert.doesNotMatch(prompt.systemPrompt, /Connected MCP access: available\./);
  assert.ok(prompt.systemPrompt.length < 7300);
  assert.equal(prompt.contextMessages.length, 1);
  assert.match(prompt.contextMessages.join("\n\n"), /Capability availability snapshot:/);
  assert.match(prompt.contextMessages.join("\n\n"), /Inspect tools: available \(\d+ enabled\)\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Mutating tools: available \(\d+ enabled\)\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Workspace skills: available \(1 enabled\)\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Connected MCP access: available\./);
  assert.match(
    prompt.contextMessages.join("\n\n"),
    /Use this only as a capability\/routing signal for the front session\. Do not rely on direct MCP callable inventories here\./,
  );
  assert.doesNotMatch(
    prompt.contextMessages.join("\n\n"),
    /MCP callable tool aliases for this run:/,
  );
  assert.deepEqual(prompt.promptCacheProfile.cacheable_section_ids, [
    "runtime_core",
    "execution_policy",
    "response_delivery_policy",
    "session_policy",
    "capability_policy",
    "capability_tool_routing",
    "workspace_policy",
  ]);
  assert.deepEqual(prompt.promptCacheProfile.volatile_section_ids, []);
  assert.deepEqual(prompt.promptCacheProfile.compatibility_context_ids, [
    "capability_availability_context",
  ]);
  assert.deepEqual(prompt.promptCacheProfile.precedence_order, [
    "base_runtime",
    "session_policy",
    "capability_policy",
    "runtime_context",
    "workspace_policy",
    "harness_addendum",
    "agent_override",
    "emergency_override",
  ]);
  assert.match(prompt.promptCacheProfile.cacheable_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(prompt.promptCacheProfile.full_system_prompt_fingerprint, /^[a-f0-9]{64}$/);
});

test("composeAgentPrompt uses a conversational main-session prompt for workspace sessions", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "main_session",
    defaultTools: ["read"],
    extraTools: ["delegate_task", "get_task", "list_tasks"],
    runtimeToolIds: ["delegate_task", "get_task", "list_tasks"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });
  const delegatedCapabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read", "edit", "bash"],
    extraTools: [
      "browser_get_state",
      "workspace_data_list_tables",
      "workspace_apps_get_status",
      "stale_runtime_tool_alpha",
      "stale_runtime_tool_beta",
    ],
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: [
      "workspace_data_list_tables",
      "workspace_apps_get_status",
      "stale_runtime_tool_alpha",
      "stale_runtime_tool_beta",
    ],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [
      {
        tool_id: "twitter.twitter_create_post",
        server_id: "twitter",
        tool_name: "twitter_create_post",
      },
    ],
    toolServerIdMap: {},
    sessionKind: "subagent",
  });

  const prompt = composeAgentPrompt("You are concise.", {
    defaultTools: ["read"],
    extraTools: ["delegate_task", "get_task", "list_tasks"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
    delegatedCapabilityManifest,
  });

  assert.deepEqual(prompt.promptLayers.map((layer) => layer.id), [
    "runtime_core",
    "assistant_soul",
    "execution_policy",
    "response_delivery_policy",
    "session_policy",
    "capability_policy",
    "capability_tool_routing",
    "workspace_policy",
  ]);
  assert.ok(prompt.promptSections.some((section) => section.id === "assistant_soul"));
  assert.ok(
    prompt.promptCacheProfile.cacheable_section_ids.includes("assistant_soul"),
  );
  assert.match(prompt.systemPrompt, /Assistant soul:/);
  assert.match(prompt.systemPrompt, /You are Hola, the user's front-of-house teammate for this workspace\./);
  assert.match(prompt.systemPrompt, /Perform Hola as a consistent character/);
  assert.match(prompt.systemPrompt, /Conversation and orchestration doctrine:/);
  assert.match(prompt.systemPrompt, /single front-of-house counterpart/);
  assert.match(prompt.systemPrompt, /real teammate with taste, memory, preferences, and reactions/);
  assert.match(prompt.systemPrompt, /brief warmth, curiosity, humor, and point of view/);
  assert.match(prompt.systemPrompt, /capable person texting the user back/);
  assert.match(prompt.systemPrompt, /React naturally before explaining/);
  assert.match(
    prompt.systemPrompt,
    /Have opinions, don't just blindly follow user's point of view\. Pick a sensible path by default instead of listing options/,
  );
  assert.match(prompt.systemPrompt, /Do not narrate or analyze your own persona\. Just speak as Hola\./);
  assert.match(prompt.systemPrompt, /Do not fake empathy or perform customer-support warmth/);
  assert.match(prompt.systemPrompt, /Be concise and on-point\. Do not ramble, over-explain, or pad replies just to sound helpful\./);
  assert.match(prompt.systemPrompt, /Keep replies tight\. Do not blabber, wander, or repeat yourself\./);
  assert.match(prompt.systemPrompt, /Keep this session to coordination, inspection, and user-facing conversation; route direct file edits, terminal execution, browser execution, and other state-changing implementation work to subagents\./);
  assert.match(prompt.systemPrompt, /The main session is a front-of-house coordinator with only a partial direct capability surface, not the default heavy executor\./);
  assert.match(prompt.systemPrompt, /Treat the surfaced tool and capability set for this run as your full direct authority\./);
  assert.match(prompt.systemPrompt, /Prefer delegating long-running, tool-heavy, interruptible, or execution-heavy work to hidden subagents\./);
  assert.match(prompt.systemPrompt, /For browser control, web research, terminal work, or other execution-heavy tasks, default to delegating unless the direct capability is surfaced here and the work is genuinely small enough to finish inline\./i);
  assert.match(prompt.systemPrompt, /Do not turn a named app or product request into a desktop install, browser-open, manual setup, or generic option list before checking the direct workspace-native route or delegated workspace route\./i);
  assert.match(prompt.systemPrompt, /Ask clarifying questions only when ambiguity affects user intent, safety, consent, credentials, account selection, or other user-owned context; do not ask merely because a preferred tool is missing from this run\./i);
  assert.match(prompt.systemPrompt, /When a clarifying question is truly needed, make it grounded in the user's words, current session context, workspace state, or tool\/subagent evidence; ask only for the concrete missing fact that blocks routing or execution\./);
  assert.match(prompt.systemPrompt, /Clarifying questions must be grounded in the current workspace\/session context or a concrete tool\/subagent result\. Do not ask abstract option-list questions or introduce unsupported alternatives from general product knowledge; inspect, execute, or delegate first when the current context is insufficient\./);
  assert.match(
    prompt.systemPrompt,
    /If the teammate routing roster already shows a concrete teammate, skill, or preferred-tool fit for the request, route against that fit instead of asking a generic tool-discovery question\./,
  );
  assert.match(prompt.systemPrompt, /When the user asks for fresh execution, fresh investigation, or a new deliverable, do not answer from prior chat memory alone; inspect, execute, or delegate first\./);
  assert.match(prompt.systemPrompt, /Default delegated browser work to the agent browser\./);
  assert.match(prompt.systemPrompt, /set `use_user_browser_surface: true` on `delegate_task`/i);
  assert.match(prompt.systemPrompt, /If the user asks for work that needs capabilities this run does not have directly, but delegated subagents can do it, delegate instead of replying that this run lacks those tools\./);
  assert.match(prompt.systemPrompt, /Treat missing direct web, browser, terminal, MCP, or other execution-heavy capabilities as a routing signal to delegate, not as the final answer to the user\./i);
  assert.match(prompt.systemPrompt, /When the ideal direct tool or integration is missing, do not stop there; try another viable route with available tools, such as delegated browser inspection, web research, terminal\/file inspection, or one precise question for missing access\/context\./i);
  assert.match(prompt.systemPrompt, /Only tell the user a request cannot be completed after checking viable direct and delegated alternatives, or when the remaining blocker genuinely requires user access, credentials, confirmation, or context\./);
  assert.match(prompt.systemPrompt, /Do not answer with a capability-apology or manual fallback first when `delegate_task` is available and the task can be routed there\./i);
  assert.match(prompt.systemPrompt, /If an earlier turn said a tool was unavailable or unsupported, but the current surfaced capability set now includes it, trust the current run and retry the tool when appropriate\./);
  assert.match(prompt.systemPrompt, /Treat prior tool failures, subagent failures, and access or integration blockers as observations about earlier attempts, not static truth about the current run\./);
  assert.match(prompt.systemPrompt, /When the user asks to retry, continue, or try again after mutable external state may have changed, prefer a fresh attempt over paraphrasing the previous failure from chat history\./);
  assert.match(prompt.systemPrompt, /Only restate an earlier access, authorization, or integration blocker after a current attempt or current tool result confirms it still applies\./);
  assert.match(prompt.systemPrompt, /If a request resembles earlier work but the user did not clearly ask to continue or reuse that earlier result, treat it as a fresh task\./);
  assert.match(prompt.systemPrompt, /Do not satisfy a fresh task by resurfacing a previous artifact, previous child output, or remembered result unless the user explicitly asked to reuse, continue, transform, summarize, compare, or save that exact prior result\./);
  assert.match(prompt.systemPrompt, /Before claiming the work is already done or that an existing artifact satisfies the current request, verify it through direct inspection, direct tool results, or a grounded child result\./);
  assert.match(prompt.systemPrompt, /continue, transform, save, summarize, compare, or report on a previous task result, continue the relevant task instead of spawning a brand-new task\./);
  assert.match(prompt.systemPrompt, /If multiple prior tasks could match a continuation request, ask which one the user means before continuing\./);
  assert.match(prompt.systemPrompt, /Subagents are backstage executors\. Do not ask the user to interact with them directly and do not present them as separate conversational agents\./);
  assert.match(prompt.systemPrompt, /When the user answers a background-work blocker such as logging in, authorizing, confirming, or providing missing context, resume the waiting task instead of starting a new task\./);
  assert.match(prompt.systemPrompt, /Treat chat like the user is messaging their assistant in an IM, not like the final deliverable surface\./);
  assert.match(prompt.systemPrompt, /Keep accepted, in-progress, waiting, and completed work clearly separate in how you speak\./);
  assert.match(prompt.systemPrompt, /Treat the main session as a coordination surface by default\./);
  assert.match(prompt.systemPrompt, /Kickoff, delegation, and status replies should usually be at most one to two short sentences unless reasoning itself is the user's requested deliverable\./);
  assert.match(prompt.systemPrompt, /For kickoff and delegation replies, acknowledge the request and state the next action without turning the reply into a mini-analysis, rewrite theory, or speculative plan\./);
  assert.match(prompt.systemPrompt, /Do not speculate before inspection\./);
  assert.match(prompt.systemPrompt, /Only surface specific claims that are grounded in the user's message, your direct inspection, tool results, subagent results, or immediate procedural facts about the current run\./);
  assert.match(prompt.systemPrompt, /Longer prose is allowed when you are synthesizing evidence you already gathered\./);
  assert.match(prompt.systemPrompt, /If the user asked for execution rather than analysis, keep the visible reply brief even when the hidden task brief needs more detail\./);
  assert.match(prompt.systemPrompt, /Do not expand a narrow request into a broader theory unless you already verified it\./);
  assert.match(prompt.systemPrompt, /Do not use visible chat to preload hidden assumptions into delegated work\./);
  assert.match(prompt.systemPrompt, /When routing work through `delegate_task`, call the tool first and then write at most one user-facing update based on the returned task state\./);
  assert.match(prompt.systemPrompt, /When the requested deliverable belongs in a workspace app or workspace artifact, do not paste the artifact body into chat as the final result unless the user explicitly asks for inline pasteable text; delegate creation or drafting to the workspace route\./);
  assert.match(prompt.systemPrompt, /Reserve completion language such as `done`, `finished`, `created`, `sent`, `navigated`, `verified`, or `it's there now`/i);
  assert.match(prompt.systemPrompt, /only when the current turn has direct grounded evidence such as a tool result, direct inspection, or a persisted deliverable\/output\./i);
  assert.match(prompt.systemPrompt, /If content only exists in chat, in a plan, or in queued or delegated work, describe it as drafted, outlined, queued, or in progress; do not say it was created, saved, attached, sent, verified, or is already there\./);
  assert.match(prompt.systemPrompt, /If delegated work immediately comes back waiting on user input, say it is blocked on that step and ask only for what is needed to continue\./);
  assert.match(prompt.systemPrompt, /If delegated work finishes early enough to merge into the same reply, state the completion once instead of also describing it as newly started or queued\./);
  assert.match(prompt.systemPrompt, /Do not treat report length alone as a reason to delegate or create an artifact\./i);
  assert.match(prompt.systemPrompt, /Use a delegated task or workspace artifact when the underlying work already fits delegated research, app-building, or an explicit artifact\/workspace route; otherwise answer inline when that best fits the request\./i);
  assert.match(prompt.systemPrompt, /Acknowledge what matters in the user's message before diving into execution or results\./);
  assert.match(prompt.systemPrompt, /Lead with the answer, reaction, instead of process narration/);
  assert.match(prompt.systemPrompt, /Prefer short sentences and plain language; use headings or numbered lists only when structure genuinely helps\./);
  assert.match(prompt.systemPrompt, /Use contractions and natural transitions when they fit\./);
  assert.match(prompt.systemPrompt, /Avoid repetitive canned phrasing or stiff assistant boilerplate/);
  assert.match(prompt.systemPrompt, /Avoid pasting very long document, HTML, or markdown bodies into chat when a workspace artifact is the better surface\./);
  assert.match(prompt.systemPrompt, /Use inspection capabilities to gather context before mutating workspace, app, browser, or runtime state whenever possible\./);
  assert.match(prompt.systemPrompt, /After edits, shell commands, browser actions, MCP mutations, or runtime mutations, run a follow-up inspection or verification step before claiming success\./);
  assert.match(prompt.systemPrompt, /Use coordination capabilities to track progress, consult available skills, route execution through delegated subagents when appropriate, or ask for clarification instead of keeping hidden state\./);
  assert.ok(
    !prompt.contextMessages.some((message) =>
      /This front session is intentionally capability-incomplete\. Treat the surfaced tools above as your full direct capability set for this run; if the request needs more and `delegate_task` is available, delegate it\./.test(message),
    ),
  );
  assert.doesNotMatch(prompt.systemPrompt, /default full-capability agent for this workspace/i);
  assert.doesNotMatch(prompt.systemPrompt, /may execute directly when that is the clearest path/i);
  assert.doesNotMatch(prompt.systemPrompt, /Delegate executable reasoning and task execution to hidden subagents\./);
  assert.equal(
    prompt.promptSections.some(
      (section) => section.id === "capability_availability_context",
    ),
    false,
  );
  assert.equal(
    prompt.promptSections.some(
      (section) => section.id === "delegated_capability_availability_context",
    ),
    false,
  );
  assert.equal(prompt.contextMessages.length, 0);
  assert.doesNotMatch(prompt.systemPrompt, /small direct edits inline/);
  assert.doesNotMatch(prompt.systemPrompt, /Execution doctrine:/);
  assert.doesNotMatch(prompt.systemPrompt, /Todo continuity policy:/);
  assert.doesNotMatch(prompt.systemPrompt, /Use `write_report` for long, structured, evidence-heavy, or referenceable outputs/);
});

test("composeAgentPrompt requires subagent outputs to stay self-contained", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read", "edit", "bash"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [
      {
        tool_id: "twitter.twitter_create_post",
        server_id: "twitter",
        tool_name: "twitter_create_post",
      },
    ],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("You are concise.", {
    defaultTools: ["read", "edit", "bash"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [
      {
        tool_id: "twitter.twitter_create_post",
        server_id: "twitter",
        tool_name: "twitter_create_post",
      },
    ],
    sessionKind: "subagent",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.doesNotMatch(prompt.systemPrompt, /Assistant soul:/);
  assert.match(prompt.systemPrompt, /This is a hidden subagent executor session\./);
  assert.match(
    prompt.systemPrompt,
    /Treat the final child output as a handoff artifact for the main session\./,
  );
  assert.match(
    prompt.systemPrompt,
    /Make it self-contained enough that the main session can rely on it later without reopening this trace\./,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not rely on intermediate tool steps, hidden reasoning, or `see above` references for essential context\./,
  );
  assert.match(
    prompt.systemPrompt,
    /When the task finds multiple items, options, or takeaways, include the actual items in the final output or deliverable instead of only a one-line lead summary\./,
  );
  assert.match(
    prompt.systemPrompt,
    /For multi-source research, latest-news scans, investigations, comparisons, or other evidence-heavy work, save the full findings as a report artifact and keep the final assistant message to a concise handoff plus key takeaways\./,
  );
  assert.match(
    prompt.systemPrompt,
    /When surfaced MCP\/app tools match the task or a provided system URL, use them first instead of defaulting to bash, file inspection, or browser exploration\./,
  );
  assert.match(
    prompt.systemPrompt,
    /Treat browser use as a last resort\./,
  );
  assert.match(
    prompt.systemPrompt,
    /only use the browser when the user explicitly asks for it, the task inherently requires UI interaction, independent visual verification is required, or non-browser routes are blocked\./,
  );
  assert.match(
    prompt.systemPrompt,
    /In workspace tasks, treat requests to `install`, `add`, or `use` an app as workspace-app requests by default, not native desktop-app installs/i,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not inspect workspace files or app config just to prove an integration exists when the current surfaced capability set already exposes the relevant tools/i,
  );
  assert.match(
    prompt.systemPrompt,
    /If the task is blocked by a recoverable user action such as login, authorization, MFA, CAPTCHA, permission, account selection, confirmation, credentials, or missing context, use the `question` tool/,
  );
  assert.match(
    prompt.systemPrompt,
    /For browser tasks, if you reach a login or access wall, leave the browser where it is, ask the user to complete the required step, and wait for the main session to resume you\./,
  );
});

// Removed: the workspace_apps_find / workspace_apps_install marketplace
// path is deprecated (community apps now scaffolded via
// workspace_apps_scaffold; toolkit access happens via propose_connect).
// The corresponding subagent prompt guideline was removed alongside
// those tool defs; nothing to assert here.

test("composeAgentPrompt makes integration catalog lookup mandatory for provider-backed app work", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read"],
    extraTools: ["workspace_integrations_list_catalog", "workspace_apps_scaffold"],
    runtimeToolIds: ["workspace_integrations_list_catalog", "workspace_apps_scaffold"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("You are concise.", {
    defaultTools: ["read"],
    extraTools: ["workspace_integrations_list_catalog", "workspace_apps_scaffold"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "subagent",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(
    prompt.systemPrompt,
    /Hard requirement: before adding any `integrations:` entry to `app\.runtime\.yaml` or using `createIntegrationClient\(\.\.\.\)`, call `workspace_integrations_list_catalog`/,
  );
  assert.match(prompt.systemPrompt, /Do not invent provider names or aliases/i);
});

test("composeAgentPrompt can inject a run-specific routing recovery override for polluted browser retries", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read", "edit"],
    extraTools: ["delegate_task"],
    runtimeToolIds: ["delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("You are concise.", {
    defaultTools: ["read", "edit"],
    extraTools: ["delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
    recentRuntimeContext: {
      lines: [
        "The user is explicitly retrying the browser request. Do not simply restate the earlier limitation.",
        "Recent turns in this session contain stale browser-capability refusals. Treat them as prior-run history, not as the answer for this run.",
      ],
    },
  });

  assert.match(prompt.systemPrompt, /Run-specific routing recovery:/);
  assert.match(prompt.systemPrompt, /retrying the browser request/i);
  assert.match(prompt.systemPrompt, /stale browser-capability refusals/i);
});

test("composeAgentPrompt can inject a run-specific routing recovery override for report-style deliverables", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read"],
    extraTools: ["delegate_task"],
    runtimeToolIds: ["delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("You are concise.", {
    defaultTools: ["read"],
    extraTools: ["delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
    recentRuntimeContext: {
      lines: [
        "The user is asking for a report-style deliverable. Keep chat as the coordination surface, not the deliverable surface.",
        "Use `delegate_task` to produce the report artifact, then keep the main-session reply to a brief acknowledgement or short handoff.",
      ],
    },
  });

  assert.match(prompt.systemPrompt, /Run-specific routing recovery:/);
  assert.match(prompt.systemPrompt, /report-style deliverable/i);
  assert.match(prompt.systemPrompt, /produce the report artifact/i);
});

test("composeAgentPrompt instructs main sessions to record durable workspace knowledge into AGENTS.md when the tool is available", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read"],
    extraTools: ["update_workspace_instructions", "memory_retrieve"],
    runtimeToolIds: ["update_workspace_instructions", "memory_retrieve"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("You are concise.", {
    defaultTools: ["read"],
    extraTools: ["update_workspace_instructions", "memory_retrieve"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(
    prompt.systemPrompt,
    /Record workspace-wide operating defaults in root `AGENTS\.md` with `update_workspace_instructions` when they are clearly stable, likely to recur, or explicitly confirmed by the user/i,
  );
  assert.match(
    prompt.systemPrompt,
    /Before writing to `AGENTS\.md`, ask whether the agent should obey the information by default on most future runs in this workspace even when the current subject is not in scope\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /durable requirements or preferences, verified recurring commands, default procedures, conventions, policies, decisions, and recurring blockers that should shape behavior by default in future runs/i,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not record named-subject knowledge in `AGENTS\.md` unless it is explicitly intended to become a workspace-wide default instruction\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /This includes customer, project, vendor, person, system, or workflow-specific facts such as contacts, owners, thresholds, URLs, channels, prior outcomes, and subject-specific procedures\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /A statement being durable or phrased as `remember this` does not by itself make it an `AGENTS\.md` item; if it is mainly contextual knowledge to recall later, keep it in memory instead\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not record one-off task requests, unresolved hypotheses, partial investigations, or temporary runtime state\. When in doubt, prefer memory or transient context over `AGENTS\.md`, and leave it out until the pattern repeats or the user confirms it should persist as a default\./i,
  );
  assert.doesNotMatch(
    prompt.systemPrompt,
    /For non-trivial requests, work in this order: inventory knowns and unknowns, confirm the unknowns that materially affect the next step, ask the user for confirmation if the remaining decision is high-stakes or judgment-based, then execute\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Build a temporary working model from current-turn context, recalled memory, and direct tool results before choosing retrieval or execution steps\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Before choosing a retrieval path, first infer the most likely source of truth for the answer and prefer the most local authoritative source\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /If the answer is not already established by the current turn, currently loaded context, or a direct tool result in this run, probe `memory_retrieve` before broadening to browser, web, file search, connected integrations, or other external retrieval routes\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /If the answer is likely to be workspace-specific or previously learned contextual knowledge such as customer, project, person, workflow, decision, procedure, owner, threshold, contact, internal URL, or other facts that could plausibly have come from prior interactions or previously ingested knowledge in this workspace, use `memory_retrieve` first\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Hard retrieval order for non-UI questions: current-turn context or direct tool result in this run, then `memory_retrieve`, then the narrowest authoritative local or connected source, and only then browser or web\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /If you are about to inspect an open browser surface first for a non-UI question while `memory_retrieve` is available, stop and call `memory_retrieve` instead\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not skip `memory_retrieve` just because a connected tool surface looks partial, because a relevant browser tab is already open, or because the browser shares auth state with that system\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not open a browser tab or other live external surface first for an unknown fact lookup when memory could plausibly already contain the answer\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Use browser as the top retrieval route only when the user is explicitly asking about the current page, current tab, or current browser UI state\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /For other freshness-sensitive questions, do not jump to browser first; prefer current-turn context, then `memory_retrieve`, then the most direct connected integration or MCP\/app route for that system before broader browser or web retrieval\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /If memory does not return a strong relevant result, then broaden outward to the next most plausible source, which may include local file search, connected integrations, workspace data\/tools, or web search depending on where the answer is most likely to live\./i,
  );
});

test("composeBaseAgentPrompt instructs direct sessions to record durable workspace knowledge into AGENTS.md when the tool is available", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read"],
    extraTools: ["update_workspace_instructions", "memory_retrieve"],
    runtimeToolIds: ["update_workspace_instructions", "memory_retrieve"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeBaseAgentPrompt("You are concise.", {
    defaultTools: ["read"],
    extraTools: ["update_workspace_instructions", "memory_retrieve"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(
    prompt.systemPrompt,
    /Record workspace-wide operating defaults in root `AGENTS\.md` with `update_workspace_instructions` when they are clearly stable, likely to recur, or explicitly confirmed by the user/i,
  );
  assert.match(
    prompt.systemPrompt,
    /Before writing to `AGENTS\.md`, ask whether the agent should obey the information by default on most future runs in this workspace even when the current subject is not in scope\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /durable requirements or preferences, verified recurring commands, default procedures, conventions, policies, decisions, and recurring blockers that should shape behavior by default in future runs/i,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not record named-subject knowledge in `AGENTS\.md` unless it is explicitly intended to become a workspace-wide default instruction\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /This includes customer, project, vendor, person, system, or workflow-specific facts such as contacts, owners, thresholds, URLs, channels, prior outcomes, and subject-specific procedures\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /A statement being durable or phrased as `remember this` does not by itself make it an `AGENTS\.md` item; if it is mainly contextual knowledge to recall later, keep it in memory instead\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not record one-off task requests, unresolved hypotheses, partial investigations, or temporary runtime state\. When in doubt, prefer memory or transient context over `AGENTS\.md`, and leave it out until the pattern repeats or the user confirms it should persist as a default\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /For non-trivial tasks, slow down: separate knowns, assumptions, and unknowns, then confirm the unknowns that materially affect the next action using the cheapest authoritative path available\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /If a remaining uncertainty affects a high-stakes, destructive, externally visible, costly, or hard-to-reverse action, do not guess; resolve it directly or ask the user for confirmation when the uncertainty is about intent, consent, account choice, judgment, or acceptable risk\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Build a temporary working model from current-turn context, recalled memory, and direct tool results before choosing tools\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Before choosing a retrieval path, first infer the most likely source of truth for the answer and prefer the most local authoritative source\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /If the answer is not already established by the current turn, currently loaded context, or a direct tool result in this run, probe `memory_retrieve` before broadening to browser, web, file search, connected integrations, or other external retrieval routes\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /If the answer is likely to be workspace-specific or previously learned contextual knowledge such as customer, project, person, workflow, decision, procedure, owner, threshold, contact, internal URL, or other facts that could plausibly have come from prior interactions or previously ingested knowledge in this workspace, use `memory_retrieve` first\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Hard retrieval order for non-UI questions: current-turn context or direct tool result in this run, then `memory_retrieve`, then the narrowest authoritative local or connected source, and only then browser or web\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /If you are about to inspect an open browser surface first for a non-UI question while `memory_retrieve` is available, stop and call `memory_retrieve` instead\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not skip `memory_retrieve` just because a connected tool surface looks partial, because a relevant browser tab is already open, or because the browser shares auth state with that system\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not open a browser tab or other live external surface first for an unknown fact lookup when memory could plausibly already contain the answer\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Use browser as the top retrieval route only when the user is explicitly asking about the current page, current tab, or current browser UI state\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /For other freshness-sensitive questions, do not jump to browser first; prefer current-turn context, then `memory_retrieve`, then the most direct connected integration or MCP\/app route for that system before broader browser or web retrieval\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /If memory does not return a strong relevant result, then broaden outward to the next most plausible source, which may include local file search, connected integrations, workspace data\/tools, or web search depending on where the answer is most likely to live\./i,
  );
});

test("composeAgentPrompt instructs subagents to record durable workspace knowledge into AGENTS.md when the tool is available", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read"],
    extraTools: ["update_workspace_instructions"],
    runtimeToolIds: ["update_workspace_instructions"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("You are concise.", {
    defaultTools: ["read"],
    extraTools: ["update_workspace_instructions"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "subagent",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(
    prompt.systemPrompt,
    /Record workspace-wide operating defaults in root `AGENTS\.md` with `update_workspace_instructions` when they are clearly stable, likely to recur, or explicitly confirmed by the user/i,
  );
  assert.match(
    prompt.systemPrompt,
    /durable requirements or preferences, verified recurring commands, default procedures, conventions, policies, decisions, and recurring blockers/i,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not record one-off task requests, unresolved hypotheses, partial investigations, or temporary runtime state\. When in doubt, prefer memory or transient context over `AGENTS\.md`, and leave it out until the pattern repeats or the user confirms it should persist as a default\./i,
  );
});

test("composeAgentPrompt keeps main sessions free of todo doctrine even if todo tools are present", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read", "todoread", "todowrite", "scratchpad_read", "scratchpad_write"],
    extraTools: ["delegate_task"],
    runtimeToolIds: ["delegate_task", "scratchpad_read", "scratchpad_write"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("", {
    defaultTools: ["read", "todoread", "todowrite", "scratchpad_read", "scratchpad_write"],
    extraTools: ["delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.doesNotMatch(prompt.systemPrompt, /Todo continuity policy:/);
  assert.doesNotMatch(
    prompt.systemPrompt,
    /When you need the current phase ids, task ids, or recorded state from an existing todo before continuing or updating it, use `todoread` first instead of guessing\./
  );
  assert.doesNotMatch(
    prompt.systemPrompt,
    /Use `todowrite` for task structure and status only; use the scratchpad/
  );
  assert.doesNotMatch(
    prompt.contextMessages.join("\n"),
    /Do not use `todowrite` as a substitute for scratchpad notes/
  );
  assert.equal(
    prompt.promptSections.some((section) => section.id === "scratchpad_context"),
    false,
  );
  assert.equal(
    prompt.promptCacheProfile.context_message_ids.includes("scratchpad_context"),
    false,
  );
});

test("composeAgentPrompt keeps onboarding sessions free of subagent delegation doctrine", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read", "edit"],
    extraTools: ["onboarding_status", "holaboss_onboarding_complete"],
    runtimeToolIds: ["onboarding_status", "holaboss_onboarding_complete"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("You are concise.", {
    defaultTools: ["read", "edit"],
    extraTools: ["onboarding_status", "holaboss_onboarding_complete"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "onboarding",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(prompt.systemPrompt, /This is an onboarding session\./);
  assert.match(prompt.systemPrompt, /Keep onboarding work in this session\./);
  assert.doesNotMatch(
    prompt.systemPrompt,
    /Delegate task execution to hidden subagents\./,
  );
  assert.doesNotMatch(
    prompt.systemPrompt,
    /delegate instead of replying that this run lacks those tools\./,
  );
  assert.doesNotMatch(prompt.systemPrompt, /Subagents are backstage executors\./);
});

test("composeAgentPrompt gives workspace onboarding its own controller prompt", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read", "edit", "bash"],
    extraTools: [
      "holaboss_create_alignment_question",
      "holaboss_create_alignment_report",
      "holaboss_create_verification_report",
    ],
    runtimeToolIds: [
      "holaboss_create_alignment_question",
      "holaboss_create_alignment_report",
      "holaboss_create_verification_report",
    ],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("You are concise.", {
    defaultTools: ["read", "edit", "bash"],
    extraTools: [
      "holaboss_create_alignment_question",
      "holaboss_create_alignment_report",
      "holaboss_create_verification_report",
    ],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "workspace_onboarding",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(prompt.systemPrompt, /workspace onboarding controller/);
  assert.match(prompt.systemPrompt, /user-facing architect and implementation orchestrator/);
  assert.match(prompt.systemPrompt, /user's intended outcome/);
  assert.match(prompt.systemPrompt, /real work context and systems involved/);
  assert.match(prompt.systemPrompt, /integrations required to understand or act on that work/);
  assert.match(prompt.systemPrompt, /teammates to create and how each should behave/);
  assert.match(prompt.systemPrompt, /workspace rules that belong in `AGENTS\.md`/);
  assert.match(prompt.systemPrompt, /teammate-owned cronjobs/);
  assert.match(prompt.systemPrompt, /gated design process/);
  assert.match(prompt.systemPrompt, /converse with the user/);
  assert.match(prompt.systemPrompt, /converge those requirements into a concrete design report/);
  assert.match(prompt.systemPrompt, /wait for user confirmation/);
  assert.match(prompt.systemPrompt, /treat implementation as a coordinated execution phase/);
  assert.match(prompt.systemPrompt, /route teammate provisioning to HR/);
  assert.match(prompt.systemPrompt, /app creation or migration work to App Builder/);
  assert.match(prompt.systemPrompt, /remaining generic workspace execution to General/);
  assert.match(prompt.systemPrompt, /Keep the onboarding thread conversational and uncluttered/);
  assert.match(prompt.systemPrompt, /holaboss_create_alignment_question/);
  assert.match(prompt.systemPrompt, /closed choices/);
  assert.match(prompt.systemPrompt, /inline answer card/);
  assert.match(prompt.systemPrompt, /Ground the alignment design in the user's actual work context/);
  assert.match(prompt.systemPrompt, /non-empty `summary` and `markdown` fields/);
  assert.match(prompt.systemPrompt, /`user_intent`, `work_context`, `research_basis`, `integrations`, `teammates`, `workspace_rules`, `workspace_structure`, `apps`, `cronjobs`, `open_questions`, and `implementation_notes`/);
  assert.match(prompt.systemPrompt, /Cronjobs should name an owner teammate/);
  assert.match(prompt.systemPrompt, /focused first pass instead of a full product spec/);
  assert.match(prompt.systemPrompt, /source of truth/);
  assert.match(prompt.systemPrompt, /route teammate creation and teammate-local skills to HR/);
  assert.match(prompt.systemPrompt, /route app creation, migration, and polish work to App Builder/);
  assert.match(prompt.systemPrompt, /Every implementation task brief should quote the relevant part of the approved alignment report/);
  assert.match(prompt.systemPrompt, /Stay responsible for sequencing, dependency management, blocker resolution with the user, and final verification/);
  assert.match(prompt.systemPrompt, /finishing the implementation work before moving to verification/);
  assert.match(prompt.systemPrompt, /verification report/);
  assert.match(prompt.systemPrompt, /including a concise human-readable `markdown` body/);
  assert.match(prompt.systemPrompt, /verified implementation/);
  assert.match(prompt.systemPrompt, /alignment review card/);
  assert.match(prompt.systemPrompt, /verification review card/);
  assert.doesNotMatch(prompt.systemPrompt, /Delegate implementation to subagents/);
  assert.doesNotMatch(prompt.systemPrompt, /holaboss_approve_alignment/);
  assert.doesNotMatch(prompt.systemPrompt, /holaboss_onboarding_complete/);
  assert.doesNotMatch(prompt.systemPrompt, /This is an onboarding session\./);
});

test("composeAgentPrompt gives meeting mode its own critique-lab prompt", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read", "edit", "bash"],
    extraTools: ["holaboss_delegate_task"],
    runtimeToolIds: ["holaboss_delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("You are concise.", {
    defaultTools: ["read", "edit", "bash"],
    extraTools: ["holaboss_delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "meeting_mode",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(prompt.systemPrompt, /meeting-mode design lab controller/);
  assert.match(prompt.systemPrompt, /already used/);
  assert.match(prompt.systemPrompt, /critique what did not work well/);
  assert.match(prompt.systemPrompt, /concrete backlog first/);
  assert.match(prompt.systemPrompt, /confirms priorities/);
  assert.match(prompt.systemPrompt, /explicit user acceptance before merging/);
  assert.doesNotMatch(prompt.systemPrompt, /workspace onboarding controller/);
});

test("composeBaseAgentPrompt includes shared todo continuity policy when todo tools are available", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read", "todoread", "todowrite"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read", "todoread", "todowrite"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    capabilityManifest,
  });

  assert.ok(prompt.promptSections.some((section) => section.id === "todo_continuity_policy"));
  assert.equal(
    prompt.promptSections.find((section) => section.id === "todo_continuity_policy")?.channel,
    "system_prompt"
  );
  assert.equal(
    prompt.promptSections.find((section) => section.id === "todo_continuity_policy")?.precedence,
    "capability_policy"
  );
  assert.deepEqual(prompt.promptLayers.map((layer) => layer.id), [
    "runtime_core",
    "execution_policy",
    "response_delivery_policy",
    "session_policy",
    "todo_continuity_policy",
    "capability_policy",
  ]);
  assert.match(prompt.systemPrompt, /Todo continuity policy:/);
  assert.match(
    prompt.systemPrompt,
    /Treat the user's newest message as the primary instruction for the current turn even when unfinished todo state may already exist\./
  );
  assert.match(
    prompt.systemPrompt,
    /When you need the current phase ids, task ids, or recorded state from an existing todo before continuing or updating it, use `todoread` first instead of guessing\./
  );
  assert.match(
    prompt.systemPrompt,
    /Do not stop only to give progress updates or ask whether to continue while executable todo items remain after the user already asked you to continue\./
  );
  assert.match(
    prompt.systemPrompt,
    /If the user's newest message clearly redirects to unrelated work, handle that new request first without marking the unfinished todo complete, then propose continuing it afterward\./
  );
  assert.deepEqual(prompt.promptCacheProfile.cacheable_section_ids, [
    "runtime_core",
    "execution_policy",
    "response_delivery_policy",
    "session_policy",
    "todo_continuity_policy",
    "capability_policy",
  ]);
  assert.deepEqual(prompt.promptCacheProfile.volatile_section_ids, []);
});

test("composeBaseAgentPrompt promotes scratchpad as working memory even before a scratchpad file exists", () => {
  const defaultTools = ["read", "todoread", "todowrite", "scratchpad_read", "scratchpad_write"];
  const capabilityManifest = buildAgentCapabilityManifest({
    runtimeToolIds: ["todoread", "todowrite", "scratchpad_read", "scratchpad_write"],
    defaultTools,
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const prompt = composeBaseAgentPrompt("", {
    defaultTools,
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    capabilityManifest,
  });

  assert.match(
    prompt.systemPrompt,
    /When a task becomes multi-step, evidence-heavy, or long-running, create or update the session scratchpad early and keep the current working state there\./
  );
  assert.match(
    prompt.systemPrompt,
    /Use `todowrite` for task structure and status only; use the scratchpad for verified findings, interim evidence, candidate lists, open questions, and compacted current state\./
  );
  assert.ok(prompt.promptSections.some((section) => section.id === "scratchpad_context"));
  assert.equal(
    prompt.promptSections.find((section) => section.id === "scratchpad_context")?.channel,
    "context_message"
  );
  assert.match(
    prompt.contextMessages.join("\n"),
    /A session-scoped scratchpad is available for this session, but no scratchpad file exists yet\./
  );
  assert.match(
    prompt.contextMessages.join("\n"),
    /Do not use `todowrite` as a substitute for scratchpad notes; todo state is for task coordination, not evidence or long-form working memory\./
  );
  assert.ok(prompt.promptCacheProfile.context_message_ids.includes("scratchpad_context"));
  assert.ok(prompt.promptCacheProfile.compatibility_context_ids.includes("scratchpad_context"));
});

test("composeBaseAgentPrompt exposes existing scratchpad metadata without collapsing it into todo state", () => {
  const defaultTools = ["read", "todoread", "todowrite", "scratchpad_read", "scratchpad_write"];
  const capabilityManifest = buildAgentCapabilityManifest({
    runtimeToolIds: ["todoread", "todowrite", "scratchpad_read", "scratchpad_write"],
    defaultTools,
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const prompt = composeBaseAgentPrompt("", {
    defaultTools,
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    capabilityManifest,
    scratchpadContext: {
      exists: true,
      file_path: ".holaboss/state/scratchpads/session-main.md",
      updated_at: "2026-04-23T15:00:00.000Z",
      size_bytes: 128,
      preview: "- verified finding\n- open question",
    },
  });

  const scratchpadMessage = prompt.contextMessages.join("\n");
  assert.match(scratchpadMessage, /A session-scoped scratchpad file already exists for this session\./);
  assert.match(
    scratchpadMessage,
    /Use the scratchpad as the session's working memory for multi-step execution, interim findings, open questions, candidate lists, and compacted current state\./
  );
  assert.match(scratchpadMessage, /Path: `\.holaboss\/state\/scratchpads\/session-main\.md`\./);
  assert.match(scratchpadMessage, /Preview: - verified finding/);
  assert.match(
    scratchpadMessage,
    /Do not use `todowrite` as a substitute for scratchpad notes; todo state is for task coordination, not evidence or long-form working memory\./
  );
});

test("composeBaseAgentPrompt keeps the cacheable fingerprint stable across runtime-only context changes", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "main_session",
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const basePrompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    capabilityManifest,
  });

  const promptWithRuntimeContext = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    capabilityManifest,
    operatorSurfaceContext: {
      active_surface_id: "browser:user",
      surfaces: [
        {
          surface_id: "browser:user",
          surface_type: "browser",
          owner: "user",
          active: true,
          mutability: "inspect_only",
          summary: "User browser currently focused on the release dashboard.",
        },
      ],
    },
    pendingUserMemoryContext: {
      entries: [
        {
          proposal_id: "proposal-1",
          proposal_kind: "preference",
          target_key: "response-style",
          title: "Response style",
          summary: "Prefer terse answers.",
        },
      ],
    },
  });

  assert.equal(
    basePrompt.promptCacheProfile.cacheable_fingerprint,
    promptWithRuntimeContext.promptCacheProfile.cacheable_fingerprint,
  );
  assert.equal(basePrompt.systemPrompt, promptWithRuntimeContext.systemPrompt);
  assert.notDeepEqual(basePrompt.contextMessages, promptWithRuntimeContext.contextMessages);
});

test("composeBaseAgentPrompt includes current user context when provided", () => {
  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    currentUserContext: {
      profile_id: "default",
      name: "Jeffrey",
      timezone: "America/Los_Angeles",
      name_source: "manual",
    },
  });

  assert.ok(prompt.promptSections.some((section) => section.id === "current_user_context"));
  assert.equal(
    prompt.promptSections.find((section) => section.id === "current_user_context")?.channel,
    "context_message"
  );
  assert.equal(
    prompt.promptSections.find((section) => section.id === "current_user_context")?.precedence,
    "runtime_context"
  );
  assert.equal(prompt.promptLayers.some((layer) => layer.id === "current_user_context"), false);
  assert.doesNotMatch(prompt.systemPrompt, /Current user context:/);
  assert.match(prompt.contextMessages.join("\n\n"), /Current user context:/);
  assert.match(prompt.contextMessages.join("\n\n"), /The current operator name is `Jeffrey`\./);
  assert.match(prompt.contextMessages.join("\n\n"), /The current operator timezone is `America\/Los_Angeles`\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Interpret relative dates and times such as `today`, `tomorrow`/);
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /Runtime profile id:/);
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /Name source:/);
});

test("composeBaseAgentPrompt includes teammate routing context when provided", () => {
  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    teammateRoutingContext: {
      teammates: [
        {
          teammate_id: "general",
          name: "General",
          kind: "system",
          status: "active",
          summary: "Fallback executor for general implementation and research work.",
          capabilities: ["generalist", "implementation", "research"],
          skills: [],
          skill_names: [],
        },
        {
          teammate_id: "hr",
          name: "HR",
          kind: "system",
          status: "active",
          summary: "Roster manager for teammate design, teammate creation, skills bootstrap, and integration readiness.",
          capabilities: ["teammates", "roster", "hiring", "skills", "bootstrap", "integrations"],
          skills: [],
          skill_names: [],
        },
        {
          teammate_id: "frontend",
          name: "Frontend",
          kind: "custom",
          status: "active",
          summary: "Best for React dashboard implementation and UI refactors.",
          capabilities: ["frontend", "react", "dashboard", "ui"],
          skills: [
            {
              name: "Dashboard UI",
              description: "Patterns for production dashboard UI implementation and refactors",
            },
          ],
          skill_names: ["Dashboard UI"],
        },
      ],
    },
  });

  assert.ok(prompt.promptSections.some((section) => section.id === "teammate_routing_context"));
  assert.equal(
    prompt.promptSections.find((section) => section.id === "teammate_routing_context")?.channel,
    "context_message",
  );
  assert.equal(
    prompt.promptSections.find((section) => section.id === "teammate_routing_context")?.precedence,
    "runtime_context",
  );
  assert.equal(prompt.promptLayers.some((layer) => layer.id === "teammate_routing_context"), false);
  assert.doesNotMatch(prompt.systemPrompt, /Teammate routing roster:/);
  assert.match(prompt.contextMessages.join("\n\n"), /Teammate routing roster:/);
  assert.match(prompt.contextMessages.join("\n\n"), /Fall back to `General` when no custom teammate is a clear fit\./);
  assert.match(prompt.contextMessages.join("\n\n"), /always pass an explicit `teammate_id`/i);
  assert.match(prompt.contextMessages.join("\n\n"), /Prefer `HR` for teammate creation, teammate reshaping, roster design, and teammate bootstrap work when that teammate is available\./);
  assert.match(prompt.contextMessages.join("\n\n"), /delegate that work to `HR` instead of trying to perform teammate bootstrap directly in the front session/i);
  assert.match(prompt.contextMessages.join("\n\n"), /Do not create a teammate until the stable remit is understood/i);
  assert.match(prompt.contextMessages.join("\n\n"), /ask for the concrete missing remit details before calling teammate-creation tools/i);
  assert.match(prompt.contextMessages.join("\n\n"), /identify required integrations, ask the user to connect missing prerequisites, and create teammate-local skills/i);
  assert.match(prompt.contextMessages.join("\n\n"), /`HR` \(id: `hr`\) \[system\/active\]: Roster manager for teammate design, teammate creation, skills bootstrap, and integration readiness\./);
  assert.match(prompt.contextMessages.join("\n\n"), /`Frontend` \(id: `frontend`\) \[custom\/active\]: Best for React dashboard implementation and UI refactors\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Capability tags: `frontend`, `react`, `dashboard`, `ui`\./);
  assert.match(
    prompt.contextMessages.join("\n\n"),
    /Skills: `Dashboard UI` — Patterns for production dashboard UI implementation and refactors\./,
  );
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /Skill names:/);
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /Preferred tools:/);
});

test("composeBaseAgentPrompt includes operator surface context when provided", () => {
  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    operatorSurfaceContext: {
      active_surface_id: "browser:user",
      surfaces: [
        {
          surface_id: "browser:user",
          surface_type: "browser",
          owner: "user",
          active: true,
          mutability: "inspect_only",
          summary: "User browser surface with 1 open tab. Active tab: \"Inbox\" at https://mail.google.com. It shares the workspace browser session and auth state with the other browser surface.",
        },
        {
          surface_id: "browser:agent",
          surface_type: "browser",
          owner: "agent",
          active: false,
          mutability: "agent_owned",
          summary: "Agent browser surface with 2 open tabs. Active tab: \"Docs\" at https://docs.example.com. It shares the workspace browser session and auth state with the other browser surface.",
        },
      ],
    },
  });

  assert.ok(prompt.promptSections.some((section) => section.id === "operator_surface_context"));
  assert.equal(
    prompt.promptSections.find((section) => section.id === "operator_surface_context")?.channel,
    "context_message"
  );
  assert.equal(
    prompt.promptSections.find((section) => section.id === "operator_surface_context")?.precedence,
    "runtime_context"
  );
  assert.equal(prompt.promptLayers.some((layer) => layer.id === "operator_surface_context"), false);
  assert.doesNotMatch(prompt.systemPrompt, /Operator surface context:/);
  assert.match(prompt.contextMessages.join("\n\n"), /Operator surface context:/);
  assert.match(prompt.contextMessages.join("\n\n"), /default referent for deictic questions such as `what am I looking at right now`/i);
  assert.match(prompt.contextMessages.join("\n\n"), /continue from what they already opened, navigated, selected, or prepared/i);
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /An active browser surface or already-open site is not by itself a routing signal for non-UI questions\./i);
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /For recall, triage, recent activity, or factual lookup requests, prefer current-turn context and other non-browser authoritative sources before inspecting browser state unless the user is asking about that surface\./i);
  assert.match(prompt.contextMessages.join("\n\n"), /do not answer from browser state just because browser tools are available/i);
  assert.match(prompt.contextMessages.join("\n\n"), /Operator surfaces are continuity context, not authority grants\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Do not mutate a user-owned surface unless surfaced runtime capabilities explicitly allow takeover or direct control\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Current active surface id: `browser:user`\./);
  assert.match(prompt.contextMessages.join("\n\n"), /\[user\/browser\] `browser:user` \(active, mutability=`inspect_only`\):/);
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /Prefer agent-owned surfaces/i);
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /\[agent\/browser\] `browser:agent` \(mutability=`agent_owned`\):/);
});

test("composeBaseAgentPrompt includes pending user memory context when provided", () => {
  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    pendingUserMemoryContext: {
      entries: [
        {
          proposal_id: "proposal-1",
          proposal_kind: "preference",
          target_key: "file-delivery",
          title: "File delivery preference",
          summary: "Do not compress or zip multiple files; deliver them individually.",
          evidence: "Please do not zip the files. Send them individually.",
        },
      ],
    },
  });

  assert.ok(prompt.promptSections.some((section) => section.id === "pending_user_memory"));
  assert.equal(
    prompt.promptSections.find((section) => section.id === "pending_user_memory")?.channel,
    "context_message"
  );
  assert.equal(
    prompt.promptSections.find((section) => section.id === "pending_user_memory")?.precedence,
    "runtime_context"
  );
  assert.equal(prompt.promptLayers.some((layer) => layer.id === "pending_user_memory"), false);
  assert.match(prompt.contextMessages.join("\n\n"), /Current-turn inferred user memory:/);
  assert.match(prompt.contextMessages.join("\n\n"), /not durably saved yet/i);
  assert.match(prompt.contextMessages.join("\n\n"), /File delivery preference: Do not compress or zip multiple files; deliver them individually\./);
});

test("composeBaseAgentPrompt includes accepted evolve candidate context when provided", () => {
  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "subagent",
    sessionMode: "code",
    evolveCandidateContext: {
      candidate_id: "evolve-skill-input-10",
      kind: "skill_create",
      title: "Release verification skill",
      summary: "Reusable release verification workflow.",
      slug: "release-verification",
      skill_path: "workspace/workspace-1/evolve/skills/evolve-skill-input-10/SKILL.md",
      target_skill_path: "skills/release-verification/SKILL.md",
      skill_markdown: [
        "---",
        "name: release-verification",
        "description: Reusable release verification workflow.",
        "---",
        "# Release verification skill",
      ].join("\n"),
      task_proposal_id: "evolve-proposal-1",
    },
  });

  assert.ok(prompt.promptSections.some((section) => section.id === "evolve_candidate_context"));
  assert.equal(
    prompt.promptSections.find((section) => section.id === "evolve_candidate_context")?.channel,
    "context_message"
  );
  assert.match(prompt.contextMessages.join("\n\n"), /Accepted evolve candidate:/);
  assert.match(prompt.contextMessages.join("\n\n"), /background evolve phase/i);
  assert.match(prompt.contextMessages.join("\n\n"), /Candidate id: `evolve-skill-input-10`\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Stored draft artifact in memory service: `workspace\/workspace-1\/evolve\/skills\/evolve-skill-input-10\/SKILL\.md`\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Target live workspace skill path: `skills\/release-verification\/SKILL\.md`\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Do not create or keep promoted workspace skills under `evolve\/`/);
  assert.match(prompt.contextMessages.join("\n\n"), /name: release-verification/);
});

test("composeBaseAgentPrompt includes recalled durable memory as context message", () => {
  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    recalledMemoryContext: {
      intent: "briefing",
      retrieval_pack: {
        known_facts: [
          {
            evidence_id: "interaction:style",
            category: "interaction",
            kind: "leaf",
            title: "User response style",
            summary: "User prefers concise responses.",
            freshness_state: "stable",
            score: 4.8,
            reason: "recalled_fact",
          },
        ],
        recent_high_signal_items: [
          {
            evidence_id: "integration:funded",
            category: "integration",
            kind: "leaf",
            title: "Your OpenAI API account has been funded",
            summary: "Email from OpenAI about your API account being funded.",
            freshness_state: "fresh",
            score: 5.2,
            reason: "high_signal",
          },
        ],
        constraints: [],
        blockers: [
          {
            evidence_id: "interaction:deploy",
            category: "interaction",
            kind: "leaf",
            title: "Deploy permission blocker",
            summary: "Deploy calls may be denied by workspace policy.",
            freshness_state: "fresh",
            score: 4.9,
            reason: "blocker_or_risk",
          },
        ],
        open_questions: [
          {
            question: "Does \"Your OpenAI API account has been funded\" still require attention right now?",
            best_source: "gmail",
          },
        ],
        recommended_next_source: "gmail",
        recommended_next_step: {
          type: "verify_live_state",
          source: "gmail",
          reason: "Top recalled items still have live-state uncertainty that should be narrowed through a direct source.",
        },
      },
      evidence: [
        {
          id: "interaction:style",
          category: "interaction",
          kind: "leaf",
          tree_id: "interaction:preferences:style",
          title: "User response style",
          summary: "User prefers concise responses.",
          summary_for_prompt: "User response style: User prefers concise responses.",
          freshness_state: "stable",
          freshness_note: "leaf memory from user preferences.",
          score: 4.8,
          reasons: ["embedding_similarity", "vector_first_pass", "llm_rerank"],
          entity_name: "User preferences",
        },
        {
          id: "interaction:deploy",
          category: "interaction",
          kind: "leaf",
          tree_id: "interaction:workflow:deploy",
          title: "Deploy permission blocker",
          summary: "Deploy calls may be denied by workspace policy.",
          summary_for_prompt: "Deploy permission blocker: Deploy calls may be denied by workspace policy.",
          freshness_state: "fresh",
          freshness_note: "leaf memory from deploy workflow.",
          score: 4.9,
          reasons: ["embedding_similarity", "vector_first_pass", "llm_rerank"],
          entity_name: "Deploy workflow",
        },
        {
          id: "integration:funded",
          category: "integration",
          kind: "leaf",
          tree_id: "integration:gmail:acct-1",
          title: "Your OpenAI API account has been funded",
          summary: "Email from OpenAI about your API account being funded.",
          summary_for_prompt: "Your OpenAI API account has been funded: Email from OpenAI about your API account being funded.",
          freshness_state: "fresh",
          freshness_note: "leaf memory from gmail account jeffreyli@imerch.ai.",
          score: 5.2,
          reasons: ["embedding_similarity", "vector_first_pass", "llm_rerank", "llm_requires_live_verification"],
          provider: "gmail",
          account_label: "jeffreyli@imerch.ai",
          source_label: "jeffreyli@imerch.ai",
        },
      ],
      coverage: {
        used_lexical: true,
        used_vector: true,
        used_neighbors: false,
        confidence: "high",
      },
    },
  });

  assert.ok(prompt.promptSections.some((section) => section.id === "memory_recall"));
  assert.equal(
    prompt.promptSections.find((section) => section.id === "memory_recall")?.channel,
    "context_message"
  );
  assert.equal(
    prompt.promptSections.find((section) => section.id === "memory_recall")?.precedence,
    "runtime_context"
  );
  assert.equal(prompt.promptLayers.some((layer) => layer.id === "memory_recall"), false);
  assert.doesNotMatch(prompt.systemPrompt, /Recalled durable memory:/);
  assert.match(prompt.contextMessages.join("\n\n"), /Recalled durable memory:/);
  assert.match(prompt.contextMessages.join("\n\n"), /Known facts:/);
  assert.match(prompt.contextMessages.join("\n\n"), /User response style/);
  assert.match(prompt.contextMessages.join("\n\n"), /Deploy permission blocker/);
  assert.match(prompt.contextMessages.join("\n\n"), /Recommended next source: `gmail`\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Coverage: confidence=`high`, vector=yes, lexical=yes, neighbors=no\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Reasons: embedding_similarity, vector_first_pass, llm_rerank/);
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /integration\/accounts\/gmail-jeffreyli-imerch.ai-89418944a655\/leaves\/leaf-65461043924305269f729543\.md/);
});

test("composeBaseAgentPrompt includes cronjob delivery routing guidance when cronjob tools are available", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read"],
    extraTools: ["cronjobs_create"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    harnessId: "pi",
  });

  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: ["cronjobs_create"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(prompt.systemPrompt, /Cronjob delivery routing:/);
  assert.match(prompt.systemPrompt, /use `session_run` for recurring agent work/i);
  assert.match(prompt.systemPrompt, /Use `system_notification` only for lightweight reminders or notifications/i);
  assert.match(prompt.systemPrompt, /put the executable task in `instruction`/i);
  assert.match(prompt.systemPrompt, /Do not repeat schedule wording/i);
});

test("composeBaseAgentPrompt includes background terminal guidance when terminal session tools are available", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read", "bash"],
    extraTools: ["terminal_session_start", "terminal_session_wait", "terminal_session_read"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    harnessId: "pi",
  });

  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read", "bash"],
    extraTools: ["terminal_session_start", "terminal_session_wait", "terminal_session_read"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(prompt.systemPrompt, /Background terminal routing:/);
  assert.match(prompt.systemPrompt, /prefer `terminal_session_start` for long-running, interactive, or revisitable shell work/i);
  assert.match(prompt.systemPrompt, /Prefer one-shot `bash` for short commands/i);
  assert.match(prompt.systemPrompt, /inspect it with `terminal_session_read` or `terminal_session_wait` before claiming success/i);
});

test("composeBaseAgentPrompt requires proactive fallback when partial retrieval cannot satisfy required facts", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "subagent",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    defaultTools: ["read"],
    extraTools: ["browser_get_state", "web_search"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
  });

  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: ["browser_get_state", "web_search"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "subagent",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(
    prompt.systemPrompt,
    /Treat explicit user requirements and verification targets as completion criteria, not optional detail\./
  );
  assert.match(
    prompt.systemPrompt,
    /If evidence is incomplete, keep retrieving or say what remains unverified; do not claim side effects happened without proof in this turn\./
  );
  assert.match(
    prompt.systemPrompt,
    /Treat deleting files, wiping directories, `replace_existing`, or blanking a non-empty file as destructive; do them only when the user explicitly asked\./
  );
  assert.match(
    prompt.systemPrompt,
    /Use available tools, skills, and MCP integrations when they are more reliable than reasoning alone\./
  );
  assert.match(
    prompt.systemPrompt,
    /When browser tools are available, treat them as a fallback UI surface, not the default route\./
  );
  assert.match(
    prompt.systemPrompt,
    /Browser is the top option only for questions about the current page, current tab, or current browser UI state\./
  );
  assert.match(
    prompt.systemPrompt,
    /Otherwise use it only when the user explicitly asks for browser use, the task inherently requires UI interaction, visual confirmation matters, or non-browser routes are blocked\./
  );
  assert.match(
    prompt.systemPrompt,
    /When you do use it, prefer DOM-grounded actions and extraction\./
  );
  assert.match(
    prompt.systemPrompt,
    /If a required fact may be rendered in attributes, custom elements, or hydration data instead of visible text, inspect those page-local DOM sources before concluding it is unavailable\./
  );
  assert.match(
    prompt.systemPrompt,
    /Use screenshots only when visual confirmation matters\./
  );
});

test("composeBaseAgentPrompt keeps connected MCP server routes ahead of browser fallback when tool refs are absent", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "subagent",
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    defaultTools: ["read"],
    extraTools: ["browser_get_state"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    resolvedMcpServerIds: ["notion"],
  });

  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: ["browser_get_state"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    resolvedMcpServerIds: ["notion"],
    sessionKind: "subagent",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });

  assert.match(
    prompt.systemPrompt,
    /If connected MCP access exists without tool names listed here, do not assume MCP is unavailable; use surfaced MCP tools when relevant\./,
  );
  assert.match(
    prompt.systemPrompt,
    /For connected systems, recent-activity questions should broaden from current-turn context and memory to the connected MCP\/app route before browser exploration\./,
  );
  assert.match(
    prompt.systemPrompt,
    /If browser tools are also available, do not default to browser exploration for the same connected system; keep MCP as the first route unless the user explicitly asks for browser use, the task explicitly requires UI interaction, or the MCP path is blocked\./,
  );
});
