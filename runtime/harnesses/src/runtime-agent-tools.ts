export const RUNTIME_AGENT_TOOL_DEFINITIONS = [
  {
    id: "onboarding_status",
    description: "Read the local onboarding status for the current workspace.",
    policy: "inspect"
  },
  {
    id: "holaboss_create_alignment_report",
    description:
      "Persist the current onboarding alignment report for the current workspace and move the controller into alignment review.",
    policy: "mutate"
  },
  {
    id: "holaboss_create_alignment_question",
    description:
      "Persist one or more multiple-choice onboarding alignment questions for the current workspace and pause for the user's inline answer card. Questions may allow freeform responses in addition to option picks.",
    policy: "mutate"
  },
  {
    id: "holaboss_create_verification_report",
    description:
      "Persist the current onboarding verification report for the current workspace and move the controller into verification review.",
    policy: "mutate"
  },
  {
    id: "holaboss_onboarding_complete",
    description:
      "After the user explicitly accepts the verification result, complete workspace onboarding and merge the lab when applicable.",
    policy: "mutate"
  },
  {
    id: "cronjobs_list",
    description: "List local cronjobs for the current workspace.",
    policy: "inspect"
  },
  {
    id: "cronjobs_create",
    description: "Create a local cronjob for the current workspace.",
    policy: "mutate"
  },
  {
    id: "cronjobs_get",
    description: "Read one local cronjob by id.",
    policy: "inspect"
  },
  {
    id: "cronjobs_update",
    description: "Update one local cronjob by id.",
    policy: "mutate"
  },
  {
    id: "cronjobs_delete",
    description: "Delete one local cronjob by id.",
    policy: "mutate"
  },
  {
    id: "delegate_task",
    description:
      "Delegate one or more background tasks to hidden subagents for the current workspace session while keeping the main conversation free.",
    policy: "coordinate"
  },
  {
    id: "get_subagent",
    description:
      "Read one delegated background task by subagent id and return its latest structured state.",
    policy: "inspect"
  },
  {
    id: "list_background_tasks",
    description:
      "List delegated background tasks for the current workspace session using persisted task state instead of a blocking wait.",
    policy: "inspect"
  },
  {
    id: "cancel_subagent",
    description: "Cancel one delegated background task by subagent id when it is still queued or waiting on user input.",
    policy: "mutate"
  },
  {
    id: "resume_subagent",
    description:
      "Resume a delegated background task that is waiting on user input by sending the user's answer back into the paused subagent run.",
    policy: "mutate"
  },
  {
    id: "continue_subagent",
    description:
      "Continue a completed delegated background task by sending a new instruction into the same child session.",
    policy: "mutate"
  },
  {
    id: "image_generate",
    description: "Generate an image file in the current workspace using the configured image generation provider and model.",
    policy: "mutate"
  },
  {
    id: "download_url",
    description:
      "Download a remote file from a URL into the current workspace and return the saved file metadata. Prefer this over ad hoc shell downloads when you already have a direct asset URL.",
    policy: "mutate"
  },
  {
    id: "write_report",
    description:
      "Create an HTML report artifact for the current workspace session, save it under outputs/reports/, and return the created report metadata.",
    policy: "mutate"
  },
  {
    id: "web_search",
    description:
      "Search the public web to discover and summarize information across multiple sources. Best for exploratory research, source discovery, and approximate or aggregated answers. Do not rely on it alone for exact live values, platform-native rankings or filters, UI-only state, or tasks that require interaction. If required facts remain unverified after search, escalate to browser tools or another more direct capability.",
    policy: "inspect"
  },
  {
    id: "memory_retrieve",
    description:
      "Retrieve durable interaction memory from the workspace-local memory tree. Supports broad summary recall, exact leaf recall, tree-scoped retrieval, and drill-down from one summary node into its direct children.",
    policy: "inspect"
  },
  {
    id: "todoread",
    description:
      "Read the current phased todo plan for the current workspace session, including the phase ids and task ids needed for later `todowrite` calls.",
    policy: "coordinate"
  },
  {
    id: "todowrite",
    description:
      "Update the current phased todo plan for the current workspace session. Use it for task coordination, not working notes or evidence. Valid `op` values are exactly `replace`, `add_phase`, `add_task`, `update`, and `remove_task`.",
    policy: "coordinate"
  },
  {
    id: "scratchpad_read",
    description:
      "Read the current session scratchpad stored in the workspace-local runtime folder for working notes and compacted current state.",
    policy: "inspect"
  },
  {
    id: "scratchpad_write",
    description:
      "Append to, replace, or clear the current session scratchpad stored in the workspace-local runtime folder for working notes, evidence, and compacted current state.",
    policy: "mutate"
  },
  {
    id: "update_workspace_instructions",
    description:
      "Read or update the root AGENTS.md file to record durable workspace instructions, verified knowledge, commands, procedures, conventions, decisions, and constraints while preserving user-authored content outside the managed section. Valid `op` values are `read_current`, `append_rule`, `remove_rule`, and `replace_managed_section`; use `read_current` for reads, not `read`.",
    policy: "mutate"
  },
  {
    id: "skill",
    description:
      "Load a workspace skill by id or name and return its canonical skill block, including any declared tool or command grants.",
    policy: "coordinate"
  },
  {
    id: "terminal_sessions_list",
    description: "List background terminal sessions for the current workspace.",
    policy: "inspect"
  },
  {
    id: "terminal_session_start",
    description:
      "Start a PTY-backed background terminal session in the current workspace and return its terminal session metadata.",
    policy: "mutate"
  },
  {
    id: "terminal_session_get",
    description: "Read one background terminal session by id.",
    policy: "inspect"
  },
  {
    id: "terminal_session_read",
    description:
      "Read terminal output events for a background terminal session, optionally after a known sequence number.",
    policy: "inspect"
  },
  {
    id: "terminal_session_wait",
    description:
      "Wait briefly for new output or a status change on a background terminal session, then return the current events and status.",
    policy: "inspect"
  },
  {
    id: "terminal_session_send_input",
    description: "Send input text to a running background terminal session.",
    policy: "mutate"
  },
  {
    id: "terminal_session_signal",
    description: "Send a signal such as SIGINT or SIGTERM to a background terminal session.",
    policy: "mutate"
  },
  {
    id: "terminal_session_close",
    description: "Close a background terminal session.",
    policy: "mutate"
  },
  {
    id: "workspace_integrations_list_catalog",
    description:
      "List the canonical integration provider ids available to app manifests and bridge clients in this workspace. Before adding any `integrations:` entry to `app.runtime.yaml` or using `createIntegrationClient(...)`, call this tool and use the exact returned `provider_id`; do not invent aliases or product names.",
    policy: "inspect"
  },
  {
    id: "workspace_apps_scaffold",
    description:
      "Create the minimum valid holaOS app skeleton under `apps/<app_id>/` for the current workspace using the canonical runtime-managed Node/TypeScript/Express starter files.",
    policy: "mutate"
  },
  {
    id: "workspace_apps_register",
    description:
      "Register or update one app entry in `workspace.yaml` for the current workspace after validating the target `app.runtime.yaml` file.",
    policy: "mutate"
  },
  {
    id: "workspace_apps_build",
    description:
      "Run a deterministic managed build step for one registered workspace app by invoking its `package.json` build script from the app directory and returning structured stdout, stderr, and exit status.",
    policy: "mutate"
  },
  {
    id: "workspace_apps_ensure_running",
    description:
      "Start all registered workspace apps, or a selected subset, through the managed holaOS runtime lifecycle instead of using an unmanaged preview server. If this call brings up a NEW MCP server (one not visible at the start of this turn), the result will include `requires_session_refresh: true` and `new_mcp_servers: [...]`. When that happens, finish your current message without invoking the new tools — they will become callable starting from the next user message. The result also surfaces `pending_integrations` for any of the started apps that declared a required `integrations:` entry; the chat UI renders a Connect card automatically — do not call any extra tool, just mention the Connect button in your reply.",
    policy: "mutate"
  },
  {
    id: "workspace_apps_restart",
    description:
      "Restart one managed workspace app through the holaOS runtime after code or config changes so the managed app surface serves fresh code.",
    policy: "mutate"
  },
  {
    id: "workspace_apps_restart_and_wait_ready",
    description:
      "Restart one managed workspace app and then wait until runtime truth reports `ready: true`, returning the final structured managed status in one deterministic step.",
    policy: "mutate"
  },
  {
    id: "workspace_apps_wait_until_ready",
    description:
      "Poll one managed workspace app until the runtime reports `ready: true`, or return the latest structured status on timeout or failure.",
    policy: "inspect"
  },
  {
    id: "workspace_apps_get_status",
    description:
      "Read runtime truth for one registered workspace app, or list all registered apps, including build status, readiness, ports, runtime contract details, revision hints, config path, and current error state.",
    policy: "inspect"
  },
  {
    id: "workspace_apps_get_ports",
    description:
      "Legacy helper for reading runtime-managed HTTP and MCP ports. Prefer `workspace_apps_get_status`, which already includes ports along with readiness, revision, and runtime contract details.",
    policy: "inspect"
  },
  {
    id: "workspace_apps_probe_endpoints",
    description:
      "Probe the managed UI and MCP endpoints for one registered workspace app using deterministic fetches instead of ad hoc curl or browser verification. Supports `ui`, `mcp_health`, `mcp_initialize`, and `mcp_tools_list` checks.",
    policy: "inspect"
  },
  {
    id: "workspace_data_list_tables",
    description:
      "List the user-facing tables in the workspace's shared SQLite at `.holaboss/state/data.db`. Prefer this deterministic workspace-data surface when discovering existing sources of truth.",
    policy: "inspect"
  },
  {
    id: "workspace_data_describe_table",
    description:
      "Describe one table in the workspace's shared SQLite by returning its columns, types, and approximate row count.",
    policy: "inspect"
  },
  {
    id: "workspace_data_sample_rows",
    description:
      "Return a small sample of rows from one table in the workspace's shared SQLite so you can shape UI and queries against real data.",
    policy: "inspect"
  },
  {
    id: "workspace_data_query",
    description:
      "Run a deterministic read-only SQL query against the workspace's shared SQLite so you can preview joins, aggregations, and mixed-source data before generating app logic.",
    policy: "inspect"
  },
  {
    id: "holaboss_workspace_integrations_propose_connect",
    description:
      "Ask the user to connect a Composio-backed integration (Gmail / Slack / Notion / Linear / GitHub / …) via OAuth. Use this when the user expresses intent to connect or use a known third-party service AND that toolkit is not already exposing tools to you (i.e. no `<toolkit>_<verb>` tool is currently in your tool list). DO NOT chain this with `workspace_apps_*` — connecting an integration does NOT require building an app; once OAuth completes, the toolkit's `<toolkit>_<verb>` tools become available automatically. The chat UI renders a Connect card from the result; do not write your own connect instructions, just briefly explain why this integration is needed. Args: `toolkit_slug` (one of the supported toolkit slugs from the workspace integration store catalog), optional `reason` (short user-facing one-liner shown on the card).",
    policy: "coordinate"
  }
] as const;

export type RuntimeAgentToolId = (typeof RUNTIME_AGENT_TOOL_DEFINITIONS)[number]["id"];

export const RUNTIME_AGENT_TOOL_IDS: RuntimeAgentToolId[] = RUNTIME_AGENT_TOOL_DEFINITIONS.map((tool) => tool.id);
