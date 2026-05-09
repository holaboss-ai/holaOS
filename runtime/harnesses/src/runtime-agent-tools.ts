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
    id: "list_data_tables",
    description:
      "List the user-facing tables in the workspace's shared SQLite at `.holaboss/state/data.db` so you can compose SQL for `create_dashboard`. The runtime already provisions that DB file; if this returns count=0, the DB exists but no user-facing tables have been created yet. Each row reports a table's name, its columns with types, and approximate row count. Module apps write app-namespaced tables (e.g. twitter_posts, linkedin_posts, twitter_post_metrics) — read across them freely; never create a separate root `./data.db` yourself. App-internal tables (publish queues, scheduler logs, api usage counters, settings flags) are hidden by default — pass include_system=true if you actually need them, but they're rarely useful for dashboards.",
    policy: "inspect"
  },
  {
    id: "create_data_table",
    description:
      "Create a user-facing table in the workspace's shared SQLite at `.holaboss/state/data.db`, optionally inserting rows at the same time. Use this when you need sample or lightweight structured data before calling `create_dashboard`. The runtime already provisions the shared DB file, so write through this tool instead of creating a separate root `./data.db`.",
    policy: "mutate"
  },
  {
    id: "create_dashboard",
    description:
      "Author a `.dashboard` file for the current workspace from a structured spec (title, optional description, list of panels). Panels are either `kpi` (single-value SELECT, prefer aliasing the answer as `value`) or `data_view` (one SELECT shared across one or more views — `table` or read-only `board`; for board, set `group_by` to a low-cardinality enum-like column like status/category). Each query is validated against the shared workspace DB at `.holaboss/state/data.db` before the file is written. Use `list_data_tables` first to discover what's queryable, or `create_data_table` first when you need sample data.",
    policy: "mutate"
  }
] as const;

export type RuntimeAgentToolId = (typeof RUNTIME_AGENT_TOOL_DEFINITIONS)[number]["id"];

export const RUNTIME_AGENT_TOOL_IDS: RuntimeAgentToolId[] = RUNTIME_AGENT_TOOL_DEFINITIONS.map((tool) => tool.id);
