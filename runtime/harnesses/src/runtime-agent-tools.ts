export const RUNTIME_AGENT_TOOL_DEFINITIONS = [
  {
    id: "ask_user_question",
    description:
      "Pause and ask the user one or more multiple-choice questions in an inline answer card on the current session. Prefer this over listing questions as prose whenever you need setup details, scope, or a decision before acting — the card lets the user confirm or tweak with a tap instead of composing a reply. For each question offer concrete options and mark the single best default with `recommended: true`, deriving it from connected integrations, workspace context, and sensible convention, so the user can accept the whole set at once; leave a question without a recommended option only when it is genuinely unknowable and you truly need the user to pick. Keep freeform on as an escape hatch. Each option's `answer_text` is what routes back into the session, so write it as a clear standalone statement. Keep the deck short — at most 4 questions per ask (extras are dropped), and ask only what actually changes what you do, inferring or safely defaulting the rest. The user's answers return as the next user message.",
    policy: "mutate"
  },
  {
    id: "cronjobs_list",
    description:
      "List scheduled cronjobs for the current workspace. Each cronjob runs an instruction on a cron schedule by spawning a subagent run. Optional `enabled_only` filters to active schedules. Optional `limit` + `offset` paginate the roster (oldest first); when either is set the result also carries `total` (all matching jobs) and `has_more`. Omit `limit` to get every job in one call. To keep the list compact, a long `instruction` is NOT returned in full here: entries carry `instruction_chars` (the full length) and, when trimmed, an `instruction_preview` plus `instruction_truncated: true` instead of `instruction`. Call `cronjobs_get` for a single job's complete instruction. TIMEZONE: each entry carries `runs_in_timezone` (the timezone the cron fires in) and `next_run_local` (the next run as wall-clock time in that timezone). Report those to the user; do NOT convert the raw `cron` hour or the `next_run_at` UTC instant yourself.",
    policy: "inspect"
  },
  {
    id: "cronjobs_get",
    description:
      "Read one cronjob by job_id, including its cron expression, instruction prompt, delivery target, and metadata. The response also carries `runs_in_timezone` (the timezone the cron fires in) and `next_run_local` (its next run as wall-clock time in that timezone) — use those when telling the user when it runs; the raw `cron` hour is timezone-agnostic and `next_run_at` is a UTC instant, so don't convert them yourself.",
    policy: "inspect"
  },
  {
    id: "cronjobs_create",
    description:
      "Create a cronjob: schedule a recurring subagent run that fires on `cron` and executes `instruction`. `description` is the human-facing summary; `instruction` is the prompt handed to the subagent. Use this for workspace-scoped automations (distinct from plugin workflow cron triggers). TIMEZONE — READ THIS: the `cron` you pass is evaluated in the USER'S timezone, NOT UTC. Write the hour as the user's local wall-clock time (e.g. \"10 AM\" → `0 10 * * *`); do not convert to UTC. The response echoes `runs_in_timezone` (the pinned timezone) and `next_run_local` (the first run as wall-clock time in that timezone) — report THOSE to the user when confirming the schedule, and never build a UTC-vs-local table by converting the cron hour yourself.",
    policy: "mutate"
  },
  {
    id: "cronjobs_update",
    description:
      "Update a cronjob by job_id. Pass only the fields you want to change — `cron`, `instruction`, `description`, `name`, `enabled`, `delivery`, or `metadata`. Toggling `enabled` is how you pause or resume a schedule. TIMEZONE: a new `cron` is evaluated in the user's timezone (not UTC) — write the hour as their local wall-clock time. The response echoes `runs_in_timezone` and `next_run_local`; report those rather than converting the cron hour yourself.",
    policy: "mutate"
  },
  {
    id: "cronjobs_delete",
    description:
      "Delete a cronjob by job_id. Use sparingly — prefer `cronjobs_update` with `enabled: false` to pause a schedule the user may want back.",
    policy: "mutate"
  },
  {
    id: "cronjobs_run_now",
    description:
      "Fire one cronjob immediately, off-schedule, by job_id. Returns the spawned workflow_run_id and session_id so the caller can surface the run to the user.",
    policy: "mutate"
  },
  {
    id: "delegate_task",
    description:
      "Delegate one or more background tasks to hidden shared-executor subagents for the current workspace session while keeping the main conversation free. Delegated work runs on the shared executor by default. Follow-up task tools use the returned task_id, not the subagent_id.",
    policy: "coordinate"
  },
  {
    id: "get_task",
    description:
      "Read one delegated task by task id and return its current task state plus linked run details when available. Pass the stable task_id such as U5-2, not the subagent_id UUID.",
    policy: "inspect"
  },
  {
    id: "list_tasks",
    description:
      "List delegated tasks for the current workspace, with optional task-status filters, using persisted task state instead of blocking waits.",
    policy: "inspect"
  },
  {
    id: "reply_task",
    description:
      "Reply to one delegated task by task id, usually when that task is waiting on user input. Pass the stable task_id such as U5-2, not the subagent_id UUID.",
    policy: "mutate"
  },
  {
    id: "cancel_task",
    description:
      "Cancel the active execution for one delegated task by task id when that task currently has running work. Pass the stable task_id such as U5-2, not the subagent_id UUID.",
    policy: "mutate"
  },
  {
    id: "rerun_task",
    description:
      "Restart one delegated task by task id using its existing task brief and linked child session routing. Pass the stable task_id such as U5-2, not the subagent_id UUID.",
    policy: "mutate"
  },
  {
    id: "image_generate",
    description: "Generate an image file in the current workspace using the configured image generation provider and model.",
    policy: "mutate"
  },
  {
    id: "video_generate",
    description: "Generate a video file (MP4) in the current workspace from a text prompt using the configured video generation provider and model. Video generation can take a few minutes.",
    policy: "mutate"
  },
  {
    id: "download_url",
    description:
      "Download a remote file from a URL into the current workspace and return the saved file metadata. Prefer this over ad hoc shell downloads when you already have a direct asset URL.",
    policy: "mutate"
  },
  {
    id: "send_file",
    description:
      "Deliver an EXISTING file to the user by registering it as this turn's output, so it is sent to them as an attachment (image, document, etc.) — not summarized. Use this whenever the user asks you to send, share, fetch, get, or give them a file itself (as opposed to its contents). Pass the path to the file you already found or created; do not paste or describe the file in place of sending it.",
    policy: "mutate"
  },
  {
    id: "holahub_upload_image",
    description:
      "Upload a LOCAL image file to HolaHub and get back an { image_id }. Use this to attach an image (e.g. one the user gave you — pass its workspace_path) to a HolaHub post: upload it here first, then pass the returned id in the HolaHub create_post tool's imageIds. Accepts png/jpeg/webp/gif up to 4 MB.",
    policy: "mutate"
  },
  {
    id: "open_macos_settings",
    description:
      "Open a macOS System Settings → Privacy & Security pane (Screen Recording, Accessibility, Full Disk Access, Automation, Files & Folders, Input Monitoring, Camera, Microphone, Location) so the user can grant Holaboss a permission. Use this when an operation fails because the macOS host lacks a privacy permission (e.g. `screencapture` reporting `could not create image from display`): open the relevant pane, tell the user to enable Holaboss there, then retry the original operation. macOS desktop host only — a no-op elsewhere.",
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
      "Resolve workspace memory into a reasoning-ready retrieval pack with recalled facts, recent high-signal items, supporting evidence, unresolved gaps, and a recommended next source. Use this for memory-first context building and problem solving, not for tree browsing.",
    policy: "inspect"
  },
  {
    id: "remember",
    description:
      "Record ONE durable memory the moment you learn something worth keeping across sessions: a stable user fact or preference, a project decision or constraint, a verified procedure, or a reference. Provide a short `title` and a specific `summary` (the fact itself). Optional: `scope` ('workspace' default, or 'user' for facts about the person), `memory_type` (fact | preference | identity | procedure | blocker | reference), `subject_key` (stable slug for updates/dedup), `evidence`, `tags`, `confidence`. Do NOT use it for transient turn state, tool output, or anything already in context — only durable, reusable knowledge. Recall with `memory_retrieve`.",
    policy: "mutate"
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
    id: "holaboss_workspace_integrations_propose_connect",
    description:
      "Ask the user to connect a Composio-backed integration (Gmail / Slack / Notion / Linear / GitHub / …) via OAuth. Use this when the user expresses intent to connect or use a known third-party service AND that toolkit is not already exposing tools to you (i.e. no `<toolkit>_<verb>` tool is currently in your tool list). DO NOT chain this with `workspace_apps_*` — connecting an integration does NOT require building an app; once OAuth completes, the toolkit's `<toolkit>_<verb>` tools become available automatically. The chat UI renders a Connect card from the result; do not write your own connect instructions, just briefly explain why this integration is needed. Args: `toolkit_slug` (one of the supported toolkit slugs from the workspace integration store catalog), optional `reason` (short user-facing one-liner shown on the card).",
    policy: "coordinate"
  },
  {
    id: "holaboss_workspace_integrations_set_default_account",
    description:
      "Set the workspace's default account for a Composio provider when the user has multiple active accounts for the same toolkit (e.g. two Gmail accounts, three GitHub accounts). This binding persists across sessions and devices for the same workspace — it answers 'when this workspace makes a Gmail call, which of my Gmail accounts should it use?'. Setting it drops the cached integration tool listing, so your NEXT turn resolves the new account's tools; the current turn still holds the previous account's. Use when (a) the user explicitly says 'use my work gmail / personal account / etc.' in a workspace that already has multiple active accounts for that provider, or (b) the user has multiple active accounts and no default is set and you would otherwise have to guess which one to call. Args: `provider_id` (lowercase Composio slug, e.g. 'gmail'), `connection_id` (the integration connection id; obtain from `workspace_integrations_list_catalog` which lists each provider's connected accounts).",
    policy: "mutate"
  },
  {
    id: "capability_install",
    description:
      "Install a workspace-authored capability from the workspace's `capabilities/<capability_id>/` directory. Reads `capability.yaml`, registers the capability's skills and agent prompt into the workspace, and returns the installed record. Use after you have finished authoring a capability directory to activate it in the current workspace.",
    policy: "mutate"
  },
  {
    id: "mcp_connect",
    description:
      "Connect an MCP (Model Context Protocol) server to this workspace so its tools become available to you. Use this ONLY to ADD a NEW server. If the server is ALREADY connected and the user wants to reconnect / reload / refresh / re-fetch its tools — including phrasings like 'reconnect the adspower mcp', 'refresh the mcp', or 'the X tools are missing/stale' — call `mcp_refresh` instead, NOT this tool (re-running mcp_connect on an already-connected server does not re-discover its tools). This is the ONLY supported way to add an MCP server here — use it whenever the user asks to add / connect / install an MCP server, whether they give a URL/webpage endpoint (e.g. 'connect https://mcp.example.com/sse'), a run command, or paste a standard MCP JSON config block. DO NOT instead edit the agent CLI's own MCP config (e.g. ~/.claude/settings.json, ~/.claude.json, ~/.codex/config.toml, ~/.mcp.json) or use an update-config / settings skill: this runtime launches the CLI against a config it generates per run (strict MCP config), so edits to those native files are IGNORED and do nothing — you must call mcp_connect. Supports every MCP transport: a REMOTE server via `url` (streamable-HTTP or SSE, with optional `headers` for auth), or a LOCAL stdio server via `command` (executable + args, with optional `env`). Pass exactly one of `url` or `command`. Mapping a pasted config block: `{\"mcpServers\":{\"NAME\":{\"command\":\"npx\",\"args\":[\"-y\",\"pkg\"],\"env\":{…}}}}` (with or without the mcpServers wrapper) → name:\"NAME\", command:[\"npx\",\"-y\",\"pkg\"], env:{…}; a `{\"NAME\":{\"url\":\"…\",\"headers\":{…}}}` entry → name, url, headers. The server is written to the workspace config and its tools become callable on your NEXT turn (not the current one) — tell the user to send one more message. Args: optional `name` (short label/id; derived from the url host or command if omitted), `url` (remote), `headers` (remote auth, e.g. {\"Authorization\":\"Bearer …\"}), `command` (local, e.g. [\"npx\",\"-y\",\"some-mcp\"]), `env` (local). Prefer remote `url` — a local `command` runs an arbitrary process on the user's machine, so only use it when the user explicitly provides the command.",
    policy: "mutate"
  },
  {
    id: "mcp_refresh",
    description:
      "Force a re-discovery of the tools exposed by the MCP servers AND the connected integrations (X/Twitter, Gmail, Reddit, …) already available to this workspace. This is the tool to use whenever the user asks to RECONNECT / reload / refresh / re-fetch an already-connected server, integration, or its tools (e.g. 'reconnect the adspower mcp', 'refresh the mcp tools') — reach for this, NOT `mcp_connect` (which only ADDS new servers). Also use it when a connected MCP server's tool set changed (the server was updated or restarted) but its tools look stale, or the user says an expected tool is missing or returns 'not found' — INCLUDING the case where an integration the user just connected has no tools yet (e.g. you cannot find the publish/post tool for an account they just authorized). This does NOT add a server (use `mcp_connect` for that) and takes NO arguments — it invalidates the whole-workspace MCP tool cache and the cached integration tool listing, so ALL connected servers and integrations are re-discovered on your NEXT turn. Tools are NOT refreshed on the current turn: end your turn and tell the user to send one more message.",
    policy: "mutate"
  },
  {
    id: "mcp_reauthorize",
    description:
      "Re-run the OAuth sign-in for an already-connected REMOTE MCP server so the user can SWITCH the connected account (or refresh an expired / revoked authorization). Use this when the user asks to 'switch/change the <server> account', 're-authorize', 're-login', or 'sign in as a different user' for a connected MCP server — NOT `mcp_connect` (which adds a new server) or `mcp_refresh` (which only reloads tools without touching auth). Takes a single `server` arg: the id or name of the connected server (e.g. 'heygen'). It does NOT complete the sign-in itself — it surfaces an inline 'Re-authorize' button in the chat that the user clicks to open the browser and pick a different account. Tell the user to click it. (Note: to land on a DIFFERENT account they may need to sign out of that service in their browser first.)",
    policy: "mutate"
  }
] as const;

export type RuntimeAgentToolId = (typeof RUNTIME_AGENT_TOOL_DEFINITIONS)[number]["id"];

export const RUNTIME_AGENT_TOOL_IDS: RuntimeAgentToolId[] = RUNTIME_AGENT_TOOL_DEFINITIONS.map((tool) => tool.id);
