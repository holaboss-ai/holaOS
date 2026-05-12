export const RUNTIME_AGENT_TOOL_DEFINITIONS = [
  {
    id: "holaboss_onboarding_status",
    description: "Read the local onboarding status for the current workspace.",
    policy: "inspect"
  },
  {
    id: "holaboss_onboarding_complete",
    description: "Mark local workspace onboarding complete with a summary.",
    policy: "mutate"
  },
  {
    id: "holaboss_cronjobs_list",
    description: "List local cronjobs for the current workspace.",
    policy: "inspect"
  },
  {
    id: "holaboss_cronjobs_create",
    description: "Create a local cronjob for the current workspace.",
    policy: "mutate"
  },
  {
    id: "holaboss_cronjobs_get",
    description: "Read one local cronjob by id.",
    policy: "inspect"
  },
  {
    id: "holaboss_cronjobs_update",
    description: "Update one local cronjob by id.",
    policy: "mutate"
  },
  {
    id: "holaboss_cronjobs_delete",
    description: "Delete one local cronjob by id.",
    policy: "mutate"
  },
  {
    id: "holaboss_delegate_task",
    description:
      "Delegate one or more background tasks to hidden subagents for the current workspace session while keeping the main conversation free.",
    policy: "coordinate"
  },
  {
    id: "holaboss_get_subagent",
    description:
      "Read one delegated background task by subagent id and return its latest structured state.",
    policy: "inspect"
  },
  {
    id: "holaboss_list_background_tasks",
    description:
      "List delegated background tasks for the current workspace session using persisted task state instead of a blocking wait.",
    policy: "inspect"
  },
  {
    id: "holaboss_cancel_subagent",
    description: "Cancel one delegated background task by subagent id when it is still queued or waiting on user input.",
    policy: "mutate"
  },
  {
    id: "holaboss_resume_subagent",
    description:
      "Resume a delegated background task that is waiting on user input by sending the user's answer back into the paused subagent run.",
    policy: "mutate"
  },
  {
    id: "holaboss_continue_subagent",
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
      "Create a report artifact for the current workspace session, save it under outputs/reports/, and return the created report metadata.",
    policy: "mutate"
  },
  {
    id: "web_search",
    description:
      "Search the public web to discover and summarize information across multiple sources. Best for exploratory research, source discovery, and approximate or aggregated answers. Do not rely on it alone for exact live values, platform-native rankings or filters, UI-only state, or tasks that require interaction. If required facts remain unverified after search, escalate to browser tools or another more direct capability.",
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
    id: "holaboss_scratchpad_read",
    description:
      "Read the current session scratchpad stored in the workspace-local runtime folder for working notes and compacted current state.",
    policy: "inspect"
  },
  {
    id: "holaboss_scratchpad_write",
    description:
      "Append to, replace, or clear the current session scratchpad stored in the workspace-local runtime folder for working notes, evidence, and compacted current state.",
    policy: "mutate"
  },
  {
    id: "holaboss_update_workspace_instructions",
    description:
      "Read or update the root AGENTS.md file to record durable workspace instructions, verified knowledge, commands, procedures, conventions, decisions, and constraints while preserving user-authored content outside the managed section.",
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
    id: "workspace_apps_find",
    description:
      "Discover apps the user could install in the current workspace. Returns deduped candidates from the marketplace catalog and any locally synced sources, plus apps already installed in this workspace. Use the optional `query` to filter by app id, name, or description (case-insensitive substring). Use this BEFORE `workspace_apps_install` to confirm an `app_id` exists in the catalog.",
    policy: "inspect"
  },
  {
    id: "workspace_apps_install",
    description:
      "Install a marketplace or local-catalog app into the current workspace. Downloads the archive, extracts under `apps/<app_id>/`, registers it in `workspace.yaml`, and starts the managed app process so its MCP tools become available. The result will include `requires_session_refresh: true` along with `new_mcp_servers: [...]` — when that happens, finish your current message without invoking the new tools (they will become callable starting from the next user message). The result also surfaces `provider_id` and `credential_source`; if the app needs an external account, mention that in your message so the user can authorize it.",
    policy: "mutate"
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
  }
] as const;

export type RuntimeAgentToolId = (typeof RUNTIME_AGENT_TOOL_DEFINITIONS)[number]["id"];

export const RUNTIME_AGENT_TOOL_IDS: RuntimeAgentToolId[] = RUNTIME_AGENT_TOOL_DEFINITIONS.map((tool) => tool.id);
