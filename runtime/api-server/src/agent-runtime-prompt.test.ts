import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentCapabilityManifest } from "./agent-capability-registry.js";
import { composeAgentPrompt, composeBaseAgentPrompt } from "./agent-runtime-prompt.js";
import { renderRecalledMemoryPromptSection } from "./memory-retrieval-pack.js";

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
    /For workspace file inspection, search, listing, and direct file changes, prefer surfaced tools such as `read`, `search`, `find`, `list`, `edit`, and `write` over `bash` when they can complete the task directly\./
  );
  assert.match(
    prompt.systemPrompt,
    /Reserve `bash` for shell-native work such as invoking programs, pipelines, process control, tests\/builds, or operations the surfaced file\/runtime tools cannot express cleanly\./
  );
  assert.match(
    prompt.systemPrompt,
    /To create or overwrite a file, use `write` \(and `edit` to change one\) rather than piping content through a shell heredoc, `python -c`, or `node -e`\./
  );
  assert.match(
    prompt.systemPrompt,
    /Verify a file with `read` or `list` and forward-slash paths, not by shelling out to `dir`\/`ls` on a backslash path/
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
    /For research, investigation, comparison, timeline, ranked briefing, status rollup, or latest-news tasks across multiple sources, produce a report artifact/
  );
  assert.match(
    prompt.systemPrompt,
    /If the response would carry multiple structured sections, a ranked list of items with details, a comparison table, or otherwise exceed roughly 15 lines of structured prose, write it as a report instead of inlining it\./
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
  assert.match(prompt.systemPrompt, /This is a front-of-house workspace session\./i);
  assert.match(prompt.systemPrompt, /Capability policy for this run:/);
  assert.match(prompt.systemPrompt, /Workspace instructions from AGENTS\.md:/);
  assert.doesNotMatch(prompt.systemPrompt, /OpenCode MCP tool naming:/);
  assert.doesNotMatch(prompt.systemPrompt, /Inspect capabilities available now:/);
  assert.doesNotMatch(prompt.systemPrompt, /Mutating capabilities available now:/);
  assert.doesNotMatch(prompt.systemPrompt, /Connected MCP tools available now:/);
  assert.doesNotMatch(prompt.systemPrompt, /Skills available now:/);
  assert.doesNotMatch(prompt.systemPrompt, /Connected MCP access: available\./);
  assert.ok(prompt.systemPrompt.length < 6500);
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
      "web_search",
      "workspace_apps_get_status",
      "stale_runtime_tool_alpha",
      "stale_runtime_tool_beta",
    ],
    browserToolsAvailable: true,
    browserToolIds: ["browser_get_state"],
    runtimeToolIds: [
      "web_search",
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
  assert.match(prompt.systemPrompt, /You are Hola, the manager for this workspace\./);
  assert.match(prompt.systemPrompt, /Conversation and orchestration doctrine:/);
  assert.match(prompt.systemPrompt, /single front-of-house counterpart/);
  assert.match(prompt.systemPrompt, /brief warmth, curiosity, humor, and point of view/);
  assert.match(prompt.systemPrompt, /capable person texting the user back/);
  assert.match(
    prompt.systemPrompt,
    /Have opinions, don't just blindly follow user's point of view\. Pick a sensible path by default instead of listing options/,
  );
  assert.match(prompt.systemPrompt, /Do not narrate or analyze your own persona\. Just speak as Hola\./);
  assert.match(prompt.systemPrompt, /Engage directly when the work fits this turn — read, edit, terminal, browser, MCP tools, and skills are part of your direct surface\. Use `delegate_task` only when the work is genuinely long-running, multi-step, parallel, or interruptible\./);
  assert.match(
    prompt.systemPrompt,
    /The main session is a full-capability workspace assistant\. You have direct access to read, edit, bash, terminal, browser, MCP tools, workspace skills, and `delegate_task`/,
  );
  assert.match(
    prompt.systemPrompt,
    /Use `delegate_task` when the work is genuinely long-running, multi-step, parallel, or interruptible/i,
  );
  assert.match(prompt.systemPrompt, /Do not turn a named app or product request into a desktop install, browser-open, manual setup, or generic option list before checking the direct workspace-native route or delegated workspace route\./i);
  assert.match(prompt.systemPrompt, /When a clarifying question is necessary, ground it in the user's words, current session context, workspace state, or tool\/subagent evidence; ask only for the missing fact that blocks routing or execution\./);
  assert.match(
    prompt.systemPrompt,
    /If the execution-routing context already shows a concrete skill or preferred-tool fit for the request, route against that fit instead of asking a generic tool-discovery question\./,
  );
  assert.match(prompt.systemPrompt, /When the user asks for fresh execution, fresh investigation, or a new deliverable, do not answer from prior chat memory alone; inspect, execute, or delegate first\./);
  assert.match(prompt.systemPrompt, /If the ideal direct tool is missing, try another viable route — direct or delegated — before surfacing a limitation\./);
  assert.match(prompt.systemPrompt, /Treat prior tool failures, unsupported-tool claims, and access or integration blockers as stale unless current-run results confirm they still apply\./);
  assert.match(prompt.systemPrompt, /When the user asks to retry, continue, or try again after mutable external state may have changed, prefer a fresh attempt over paraphrasing the previous failure from chat history\./);
  assert.match(prompt.systemPrompt, /If a request resembles earlier work but the user did not clearly ask to continue or reuse that earlier result, treat it as a fresh task\./);
  assert.match(prompt.systemPrompt, /Do not satisfy a fresh task by resurfacing a previous artifact, child output, or remembered result unless the user explicitly asked to reuse it, and verify any claimed reuse through direct inspection or grounded child results\./);
  assert.match(prompt.systemPrompt, /continue, transform, save, summarize, compare, or report on a previous task result, continue the relevant task instead of spawning a brand-new task\./);
  assert.match(prompt.systemPrompt, /If multiple prior tasks could match a continuation request, ask which one the user means before continuing\./);
  assert.match(prompt.systemPrompt, /Subagents are background executors\. Do not ask the user to interact with them directly; when they need user input, relay the ask yourself in natural conversation\./);
  assert.match(prompt.systemPrompt, /When the user answers a background-work blocker such as logging in, authorizing, confirming, or providing missing context, resume the waiting task instead of starting a new task\./);
  assert.match(prompt.systemPrompt, /Kickoff, delegation, and status replies should usually be at most one to two short sentences unless reasoning itself is the user's requested deliverable\./);
  assert.match(prompt.systemPrompt, /For kickoff and delegation replies, acknowledge the request and state the next action without turning the reply into a mini-analysis, rewrite theory, or speculative plan\./);
  assert.match(prompt.systemPrompt, /Do not speculate before inspection or present work as done, verified, or already satisfied unless direct inspection, direct tool results, or grounded child results confirm it\./);
  assert.match(prompt.systemPrompt, /If the user asked for execution rather than analysis, keep the visible reply brief even when the hidden task brief needs more detail\./);
  assert.match(prompt.systemPrompt, /When routing work through `delegate_task`, call the tool first and then write at most one user-facing update based on the returned task state\./);
  assert.doesNotMatch(prompt.systemPrompt, /blocked_by/);
  assert.doesNotMatch(prompt.systemPrompt, /task workflow edges/);
  assert.match(prompt.systemPrompt, /When the requested deliverable belongs in a workspace app or workspace artifact, do not paste the artifact body into chat as the final result unless the user explicitly asks for inline pasteable text; delegate creation or drafting to the workspace route\./);
  assert.match(prompt.systemPrompt, /Use completion language only for work that is already terminal and verified in the current turn\./);
  assert.match(prompt.systemPrompt, /If content only exists in chat, in a plan, or in queued or delegated work, describe it as drafted, outlined, queued, blocked, or in progress; do not say it was created, saved, attached, sent, verified, or is already there\./);
  assert.match(prompt.systemPrompt, /If delegated work immediately comes back waiting on user input, say it is blocked on that step and ask only for what is needed to continue\./);
  assert.match(prompt.systemPrompt, /If delegated work finishes early enough to merge into the same reply, state the completion once instead of also describing it as newly started or queued\./);
  assert.match(prompt.systemPrompt, /Acknowledge what matters in the user's message before diving into execution or results\./);
  assert.match(prompt.systemPrompt, /Lead with the answer, reaction, instead of process narration/);
  assert.match(prompt.systemPrompt, /Prefer short sentences and plain language; use headings or numbered lists only when structure genuinely helps\./);
  assert.match(prompt.systemPrompt, /Avoid pasting very long document, HTML, or markdown bodies into chat when a workspace artifact is the better surface\./);
  assert.match(prompt.systemPrompt, /When inspect or verification capabilities are surfaced, use them to confirm state-changing work before claiming success\./);
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
    /Hard requirement: for ranked briefings, news scans, multi-source research, investigations, audits, comparisons, timelines, status rollups, plans, or any other evidence-heavy or structured output, write the full result via `write_report` \(HTML by default\) and end the task with only the report path\/title plus 3-5 takeaways or follow-ups\./,
  );
  assert.match(
    prompt.systemPrompt,
    /Do not paste long bullet lists, ranked rosters, section-headed prose, tables, or multi-paragraph summaries into the final task message\./,
  );
  assert.match(
    prompt.systemPrompt,
    /When surfaced MCP\/app tools match the task or a provided system URL, use them first instead of defaulting to bash, file inspection, or browser exploration\./,
  );
  assert.match(
    prompt.systemPrompt,
    /Workspace file routing: when surfaced file tools such as `read`, `search`, `find`, `list`, `edit`, or `write` can inspect, locate, or change workspace files directly, use them before `bash`\./,
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
    /If the task is blocked by a recoverable user action such as login, authorization, MFA, CAPTCHA, permission, account selection, confirmation, credentials, or missing context, use the `ask_user_question` tool/,
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
    /When `update_workspace_instructions` is available, record guidance in `AGENTS\.md` only when it is stable, likely to recur, or explicitly confirmed as a future default; ask before making it the default for future runs\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Keep named-subject facts, one-off task requests, unresolved hypotheses, and temporary runtime state out of `AGENTS\.md`; prefer memory or transient context for those\./i,
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
    /When `update_workspace_instructions` is available, record guidance in `AGENTS\.md` only when it is stable, likely to recur, or explicitly confirmed as a future default; ask before making it the default for future runs\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Keep named-subject facts, one-off task requests, unresolved hypotheses, and temporary runtime state out of `AGENTS\.md`; prefer memory or transient context for those\./i,
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
    /When `update_workspace_instructions` is available, record guidance in `AGENTS\.md` only when it is stable, likely to recur, or explicitly confirmed as a future default; ask before making it the default for future runs\./i,
  );
  assert.match(
    prompt.systemPrompt,
    /Keep named-subject facts, one-off task requests, unresolved hypotheses, and temporary runtime state out of `AGENTS\.md`; prefer memory or transient context for those\./i,
  );
});

test("composeAgentPrompt keeps main sessions free of todo doctrine even if todo tools are present", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    defaultTools: ["read", "todoread", "todowrite"],
    extraTools: ["delegate_task"],
    runtimeToolIds: ["delegate_task"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });

  const prompt = composeAgentPrompt("", {
    defaultTools: ["read", "todoread", "todowrite"],
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
      name: "Sam",
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
  assert.match(prompt.contextMessages.join("\n\n"), /The current operator name is `Sam`\./);
  assert.match(prompt.contextMessages.join("\n\n"), /The current operator timezone is `America\/Los_Angeles`\./);
  assert.match(prompt.contextMessages.join("\n\n"), /Interpret relative dates and times such as `today`, `tomorrow`/);
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /Runtime profile id:/);
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /Name source:/);
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

test("composeBaseAgentPrompt includes recalled durable memory as context message", () => {
  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    recalledMemorySection: renderRecalledMemoryPromptSection({
      intent: "briefing",
      retrieval_pack: {
        known_facts: [
          {
            evidence_id: "interaction:style",
            category: "workspace",
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
            category: "workspace",
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
            category: "workspace",
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
          category: "workspace",
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
          category: "workspace",
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
          category: "workspace",
          kind: "leaf",
          tree_id: "integration:gmail:acct-1",
          title: "Your OpenAI API account has been funded",
          summary: "Email from OpenAI about your API account being funded.",
          summary_for_prompt: "Your OpenAI API account has been funded: Email from OpenAI about your API account being funded.",
          freshness_state: "fresh",
          freshness_note: "leaf memory from gmail account user@imerch.ai.",
          score: 5.2,
          reasons: ["embedding_similarity", "vector_first_pass", "llm_rerank", "llm_requires_live_verification"],
          provider: "gmail",
          account_namespace: "user@imerch.ai",
          source_label: "user@imerch.ai",
        },
      ],
      coverage: {
        used_lexical: true,
        used_vector: true,
        used_neighbors: false,
        confidence: "high",
      },
    }),
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
  assert.doesNotMatch(prompt.contextMessages.join("\n\n"), /integration\/accounts\/gmail-user-imerch.ai-89418944a655\/leaves\/leaf-65461043924305269f729543\.md/);
});

test("composeBaseAgentPrompt includes cronjob routing guidance when cronjob tools are available", () => {
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

  assert.match(prompt.systemPrompt, /Cronjob routing:/);
  assert.match(prompt.systemPrompt, /recurring task on a schedule/);
  assert.match(prompt.systemPrompt, /use `cronjobs_create`/);
  assert.match(prompt.systemPrompt, /`cronjobs_list`, `cronjobs_get`, `cronjobs_update`, `cronjobs_delete`, and `cronjobs_run_now`/);
  assert.match(prompt.systemPrompt, /`enabled: false` instead of deleting/);
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
  assert.match(prompt.systemPrompt, /Workspace file routing: when surfaced file tools such as `read`, `search`, `find`, `list`, `edit`, or `write` can inspect, locate, or change workspace files directly, use them before `bash`\./i);
  assert.match(prompt.systemPrompt, /Prefer one-shot `bash` only for short commands that genuinely require shell execution/i);
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
    /Once you are working inside a browser, lead with a screenshot to understand the page/
  );
  assert.match(
    prompt.systemPrompt,
    /Drop to the DOM, page text, or an evaluate\/script read only for fine-grained control/
  );
  assert.match(
    prompt.systemPrompt,
    /recovering a fact rendered in attributes, custom elements, or hydration data rather than in visible pixels/
  );
  assert.match(
    prompt.systemPrompt,
    /If you cannot view images, fall back to the narrowest targeted text or DOM read rather than a whole-page dump\./
  );
  // Interaction guidance: trusted tools over synthetic-event JS, plus shadow-DOM handling.
  assert.match(
    prompt.systemPrompt,
    /use the browser's real interaction tools .* not an evaluate\/script that sets a `\.value`, calls `\.click\(\)`, or dispatches synthetic events/
  );
  assert.match(
    prompt.systemPrompt,
    /Synthesized events are untrusted[\s\S]*silently ignore them, so the action reports success while nothing was actually entered or submitted/
  );
  assert.match(
    prompt.systemPrompt,
    /If a target sits inside shadow DOM or a web component and a selector cannot reach it/
  );
  // Verify-after-action guidance.
  assert.match(
    prompt.systemPrompt,
    /verify it actually took by re-reading the field's value or confirming the resulting element or state/
  );
  // Navigation guidance: real extracted hrefs + landed-target confirmation.
  assert.match(
    prompt.systemPrompt,
    /Navigate only to URLs you extracted from the live page .* never to a URL you assembled or guessed/
  );
  assert.match(
    prompt.systemPrompt,
    /confirm the resulting URL and page identity match your intended target before acting on it/
  );
  // The old DOM-first wording must be gone.
  assert.doesNotMatch(prompt.systemPrompt, /prefer DOM-grounded actions and extraction/);
  assert.doesNotMatch(prompt.systemPrompt, /Use screenshots only when visual confirmation matters/);
});

test("main session with browser available gets the web_search-over-browser routing steer (regression)", () => {
  const capabilityManifest = buildAgentCapabilityManifest({
    harnessId: "pi",
    sessionKind: "main_session",
    defaultTools: ["read", "edit", "bash"],
    extraTools: ["web_search", "browser_navigate", "browser_get_state"],
    browserToolsAvailable: true,
    browserToolIds: ["browser_navigate", "browser_get_state"],
    runtimeToolIds: ["web_search"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    toolServerIdMap: {},
  });
  // Main-session manifests keep the browser_tools CAPABILITY array empty
  // (browserToolSessionKinds is subagent-only, so the enable-map is untouched),
  // but browser tools ARE wired + available — the routing guidance must still
  // fire off the availability flag, or the main chat browses for "latest news".
  assert.equal(capabilityManifest.browser_tools.length, 0);
  assert.equal(capabilityManifest.context.browser_tools_available, true);

  const prompt = composeBaseAgentPrompt("You are concise.", {
    defaultTools: ["read", "edit", "bash"],
    extraTools: ["web_search", "browser_navigate", "browser_get_state"],
    workspaceSkillIds: [],
    resolvedMcpToolRefs: [],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
    capabilityManifest,
  });
  // Exposed to the model as `search_web`, NOT `web_search` (reserved provider
  // tool name that the Anthropic/OpenAI API strips before the model sees it).
  assert.match(prompt.systemPrompt, /`search_web` is the default retrieval route/);
  assert.doesNotMatch(prompt.systemPrompt, /`web_search` is the default retrieval route/);
  assert.match(prompt.systemPrompt, /treat them as a fallback UI surface/);
});

test("screenshot-first browser perception guidance is general: fires for a browser-shaped MCP tool with no native browser tools", () => {
  const request = {
    defaultTools: [] as string[],
    extraTools: [] as string[],
    workspaceSkillIds: [] as string[],
    // An external antidetect-browser MCP (no Holaboss native browser tools).
    resolvedMcpToolRefs: [
      { tool_id: "adspower-local-api__screenshot", tool_name: "screenshot" },
      { tool_id: "adspower-local-api__get-page-visible-text", tool_name: "get-page-visible-text" },
    ] as unknown[],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
  };

  const prompt = composeBaseAgentPrompt("", request);

  // Screenshot-first perception guidance is present even though browser_tools is empty.
  assert.match(
    prompt.systemPrompt,
    /Once you are working inside a browser, lead with a screenshot to understand the page/
  );
  // The native-only routing line ("fallback UI surface") should NOT appear — there are
  // no native browser tools, and browser routing for the MCP is handled elsewhere.
  assert.doesNotMatch(
    prompt.systemPrompt,
    /treat them as a fallback UI surface, not the default route/
  );
});

test("no browser guidance when neither native browser tools nor a browser-shaped MCP tool is present", () => {
  const prompt = composeBaseAgentPrompt("", {
    defaultTools: ["read"],
    extraTools: [],
    workspaceSkillIds: [],
    // A non-browser MCP tool must not trip the browser detector.
    resolvedMcpToolRefs: [
      { tool_id: "notion__notion-search", tool_name: "notion-search" },
    ] as unknown[],
    resolvedMcpServerIds: ["notion"],
    sessionKind: "main_session",
    sessionMode: "code",
    harnessId: "pi",
  });

  assert.doesNotMatch(prompt.systemPrompt, /lead with a screenshot to understand the page/);
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

test("external harnesses get Holaboss MCP-tool guidance; pi does not", () => {
  const baseRequest = {
    defaultTools: [] as string[],
    extraTools: [] as string[],
    workspaceSkillIds: [] as string[],
    resolvedMcpToolRefs: [] as unknown[],
    sessionKind: "main_session",
    sessionMode: "code",
  };

  const external = composeBaseAgentPrompt("You are concise.", {
    ...baseRequest,
    harnessId: "claude-code",
  });
  assert.match(external.systemPrompt, /Holaboss workspace tools \(MCP\):/);
  assert.match(external.systemPrompt, /web_search/);
  assert.match(external.systemPrompt, /holaboss_runtime_tools/);
  assert.ok(
    external.promptSections.some((section) => section.id === "harness_quirks"),
    "external harness prompt should include the harness_quirks MCP guidance section",
  );

  const pi = composeBaseAgentPrompt("You are concise.", {
    ...baseRequest,
    harnessId: "pi",
  });
  assert.doesNotMatch(pi.systemPrompt, /Holaboss workspace tools \(MCP\):/);
  assert.ok(
    !pi.promptSections.some((section) => section.id === "harness_quirks"),
    "pi wires tools in-process and must not get the external MCP guidance",
  );
});
