import {
  executeRuntimeToolCapability,
  resolveRuntimeToolCapabilityBaseUrl,
  runtimeToolCapabilityAvailable,
} from "./runtime-tool-capability-client.js";
import {
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  RUNTIME_AGENT_TOOL_IDS,
  type RuntimeAgentToolId,
} from "./runtime-agent-tools.js";

const CRONJOB_DELIVERY_CHANNELS = ["system_notification", "session_run"] as const;
const CRONJOB_DELIVERY_MODES = ["deliver", "none"] as const;
const SCRATCHPAD_WRITE_OPS = ["append", "replace", "clear"] as const;
const SUBAGENT_TOOL_BUCKETS = ["web", "browser", "terminal", "file"] as const;
const TODO_STATUSES = ["pending", "in_progress", "blocked", "completed", "abandoned"] as const;
const TODO_WRITE_OPS_TEXT = "`replace`, `add_phase`, `add_task`, `update`, and `remove_task`";
const TODO_WRITE_ALIAS_WARNING =
  "Do not invent alias op names such as `replace_all`, `update_task`, or `set_status`.";

export interface HarnessRuntimeToolOptions {
  runtimeApiBaseUrl: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  inputId?: string | null;
  selectedModel?: string | null;
  fetchImpl?: typeof fetch;
}

export interface HarnessRuntimeToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  execute: (...args: any[]) => Promise<any>;
}

function literalStringUnion(values: readonly string[], description: string): Record<string, unknown> {
  return {
    anyOf: values.map((value) => ({ type: "string", const: value })),
    description,
  };
}

function cronjobDeliveryChannelSchema(): Record<string, unknown> {
  return literalStringUnion(
    CRONJOB_DELIVERY_CHANNELS,
    "Delivery channel. Use `session_run` for recurring agent work such as running instructions, tasks, analysis, browsing, or writing. Use `system_notification` only for lightweight reminder/notification messages.",
  );
}

function cronjobDeliveryModeSchema(): Record<string, unknown> {
  return literalStringUnion(
    CRONJOB_DELIVERY_MODES,
    "Delivery mode. Allowed values: `deliver` or `none`. Use `deliver` for the normal visible delivery path.",
  );
}

function scratchpadWriteOpSchema(): Record<string, unknown> {
  return literalStringUnion(
    SCRATCHPAD_WRITE_OPS,
    "Scratchpad write operation. Use `append` to add notes, `replace` to compact the scratchpad into a new summary, or `clear` to remove it.",
  );
}

function todoStatusSchema(): Record<string, unknown> {
  return literalStringUnion(TODO_STATUSES, "Todo task status.");
}

function subagentToolBucketSchema(): Record<string, unknown> {
  return literalStringUnion(
    SUBAGENT_TOOL_BUCKETS,
    "Delegated capability bucket. Use `web`, `browser`, `terminal`, or `file`.",
  );
}

function runtimeToolLabel(toolId: RuntimeAgentToolId): string {
  return toolId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function runtimeToolParameters(toolId: RuntimeAgentToolId): Record<string, unknown> {
  switch (toolId) {
    case "holaboss_onboarding_status":
      return { type: "object", properties: {}, additionalProperties: false };
    case "holaboss_onboarding_complete":
      return {
        type: "object",
        properties: {
          summary: { type: "string", description: "Summary of the onboarding outcome." },
          requested_by: { type: "string", description: "Actor requesting completion." },
        },
        required: ["summary"],
        additionalProperties: false,
      };
    case "holaboss_cronjobs_list":
      return {
        type: "object",
        properties: {
          enabled_only: { type: "boolean", description: "Only return enabled cronjobs." },
        },
        additionalProperties: false,
      };
    case "holaboss_cronjobs_get":
    case "holaboss_cronjobs_delete":
      return {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Cronjob id." },
        },
        required: ["job_id"],
        additionalProperties: false,
      };
    case "holaboss_cronjobs_create":
      return {
        type: "object",
        properties: {
          cron: { type: "string", description: "Cron expression." },
          description: { type: "string", description: "Short display description for the cronjob." },
          instruction: {
            type: "string",
            description: "The exact task to execute when the cronjob runs. Keep schedule wording out of this field.",
          },
          initiated_by: { type: "string", description: "Actor creating the cronjob." },
          name: { type: "string", description: "Optional cronjob name." },
          enabled: { type: "boolean", description: "Whether the cronjob is enabled." },
          delivery_channel: cronjobDeliveryChannelSchema(),
          delivery_mode: cronjobDeliveryModeSchema(),
          delivery_to: { type: "string", description: "Optional delivery target." },
          metadata_json: {
            type: "string",
            description:
              "JSON object string for cronjob metadata. For `system_notification`, include a short `message`. For `session_run`, use metadata for execution context only; keep the actual task instruction in `instruction`.",
          },
        },
        required: ["cron", "description", "instruction"],
        additionalProperties: false,
      };
    case "holaboss_cronjobs_update":
      return {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Cronjob id." },
          name: { type: "string", description: "Optional cronjob name." },
          cron: { type: "string", description: "Cron expression." },
          description: { type: "string", description: "Short display description for the cronjob." },
          instruction: {
            type: "string",
            description: "The exact task to execute when the cronjob runs. Keep schedule wording out of this field.",
          },
          enabled: { type: "boolean", description: "Whether the cronjob is enabled." },
          delivery_channel: cronjobDeliveryChannelSchema(),
          delivery_mode: cronjobDeliveryModeSchema(),
          delivery_to: { type: "string", description: "Optional delivery target." },
          metadata_json: {
            type: "string",
            description:
              "JSON object string for cronjob metadata. For `system_notification`, include a short `message`. For `session_run`, use metadata for execution context only; keep the actual task instruction in `instruction`.",
          },
        },
        required: ["job_id"],
        additionalProperties: false,
      };
    case "holaboss_delegate_task":
      return {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description:
              "Background tasks to delegate. Prefer this canonical batched form when delegating multiple tasks at once.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Optional short task title." },
                goal: { type: "string", description: "Required task goal or instruction." },
                context: { type: "string", description: "Optional supporting context for this task." },
                tools: {
                  type: "array",
                  description: "Optional task-scoped capability buckets for the delegated worker.",
                  items: subagentToolBucketSchema(),
                },
                model: { type: "string", description: "Optional model override for this delegated task." },
                use_user_browser_surface: {
                  type: "boolean",
                  description:
                    "Set true only when the user explicitly says `use my browser`. Omit otherwise so the task uses the agent browser.",
                },
                timeout_ms: {
                  type: "integer",
                  description: "Optional timeout hint for this delegated task in milliseconds.",
                  minimum: 1,
                },
              },
              required: ["goal"],
              additionalProperties: false,
            },
          },
          title: { type: "string", description: "Singleton alias: optional short task title." },
          goal: { type: "string", description: "Singleton alias: task goal or instruction." },
          context: { type: "string", description: "Singleton alias: supporting context for the task." },
          tools: {
            type: "array",
            description: "Singleton alias: task-scoped capability buckets for the delegated worker.",
            items: subagentToolBucketSchema(),
          },
          model: { type: "string", description: "Singleton alias: model override for the delegated task." },
          use_user_browser_surface: {
            type: "boolean",
            description:
              "Singleton alias: set true only when the user explicitly says `use my browser`.",
          },
          timeout_ms: {
            type: "integer",
            description: "Singleton alias: timeout hint for the delegated task in milliseconds.",
            minimum: 1,
          },
        },
        additionalProperties: false,
      };
    case "holaboss_get_subagent":
      return {
        type: "object",
        properties: {
          subagent_id: {
            type: "string",
            description: "Delegated background task id to inspect.",
          },
        },
        required: ["subagent_id"],
        additionalProperties: false,
      };
    case "holaboss_list_background_tasks":
      return {
        type: "object",
        properties: {
          statuses: {
            type: "array",
            description: "Optional delegated background task statuses to include.",
            items: literalStringUnion(
              ["queued", "running", "waiting_on_user", "completed", "failed", "cancelled"],
              "Background task status filter.",
            ),
          },
          owner_main_session_id: {
            type: "string",
            description: "Optional owner main session id filter.",
          },
          limit: {
            type: "integer",
            description: "Optional maximum number of background tasks to return.",
            minimum: 1,
          },
        },
        additionalProperties: false,
      };
    case "holaboss_cancel_subagent":
      return {
        type: "object",
        properties: {
          subagent_id: { type: "string", description: "Delegated background task id to cancel." },
        },
        required: ["subagent_id"],
        additionalProperties: false,
      };
    case "holaboss_resume_subagent":
      return {
        type: "object",
        properties: {
          subagent_id: { type: "string", description: "Delegated background task id to resume." },
          answer: { type: "string", description: "The user's answer that should resume the paused task." },
          model: { type: "string", description: "Optional model override for the resumed task turn." },
        },
        required: ["subagent_id", "answer"],
        additionalProperties: false,
      };
    case "holaboss_continue_subagent":
      return {
        type: "object",
        properties: {
          subagent_id: {
            type: "string",
            description: "Delegated background task id whose child session should receive the continuation.",
          },
          instruction: {
            type: "string",
            description: "The follow-up instruction to run in the same child session.",
          },
          title: {
            type: "string",
            description: "Optional updated display title for the continued task.",
          },
          model: { type: "string", description: "Optional model override for the continuation turn." },
        },
        required: ["subagent_id", "instruction"],
        additionalProperties: false,
      };
    case "image_generate":
      return {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Prompt describing the image to generate." },
          filename: { type: "string", description: "Optional output filename for the generated image." },
          size: { type: "string", description: "Optional provider-specific size hint such as `1024x1024`." },
        },
        required: ["prompt"],
        additionalProperties: false,
      };
    case "download_url":
      return {
        type: "object",
        properties: {
          url: { type: "string", description: "Direct http or https URL to download." },
          output_path: {
            type: "string",
            description:
              "Optional workspace-relative destination path. If omitted, the runtime saves the file under Downloads/ with an inferred filename.",
          },
          expected_mime_prefix: {
            type: "string",
            description:
              "Optional MIME prefix such as `image/` or `application/pdf` used to fail fast if the response type is not what you expect.",
          },
          overwrite: {
            type: "boolean",
            description:
              "Overwrite an existing file when output_path is provided. Ignored when output_path is omitted.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      };
    case "write_report":
      return {
        type: "object",
        properties: {
          title: { type: "string", description: "Optional report title shown in the artifact list." },
          filename: { type: "string", description: "Optional markdown filename stem for the saved report." },
          summary: { type: "string", description: "Optional short summary for artifact metadata and follow-up context." },
          content: {
            type: "string",
            description:
              "Full markdown report content to save as an artifact. Put the detailed research findings in this field instead of in chat.",
          },
        },
        required: ["content"],
        additionalProperties: false,
      };
    case "web_search":
      return {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query for the public web.", minLength: 1 },
          num_results: {
            type: "integer",
            description: "Number of search results to return (1-10). Defaults to 8.",
            minimum: 1,
            maximum: 10,
          },
          max_results: {
            type: "integer",
            description: "Compatibility alias for num_results (1-10).",
            minimum: 1,
            maximum: 10,
          },
          livecrawl: literalStringUnion(
            ["fallback", "preferred"] as const,
            "Whether to prefer live crawling or only use it as fallback.",
          ),
          type: literalStringUnion(["auto", "fast", "deep"] as const, "Search depth mode."),
          context_max_characters: {
            type: "integer",
            description: "Maximum number of context characters to request from the search backend.",
            minimum: 1,
          },
          text_offset: {
            type: "integer",
            description:
              "Optional character offset for paginating long web_search responses.",
            minimum: 0,
          },
          text_limit: {
            type: "integer",
            description:
              "Optional maximum number of characters to return in this page of web_search text.",
            minimum: 1,
          },
        },
        required: ["query"],
        additionalProperties: false,
      };
    case "skill":
      return {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill id or skill name to invoke." },
          args: {
            type: "string",
            description: "Optional follow-up instructions appended after the invoked skill content.",
          },
        },
        required: ["name"],
        additionalProperties: false,
      };
    case "todoread":
      return { type: "object", properties: {}, additionalProperties: false };
    case "todowrite":
      return {
        type: "object",
        properties: {
          ops: {
            type: "array",
            items: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    op: { type: "string", const: "replace" },
                    phases: {
                      type: "array",
                      description: "Full replacement list of phases. Each phase requires `name`.",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string", description: "Human-readable phase title." },
                          tasks: {
                            type: "array",
                            description: "Task objects for this phase. Use `content`, not `title`.",
                            items: {
                              type: "object",
                              properties: {
                                content: { type: "string", description: "Required task text." },
                                status: todoStatusSchema(),
                                notes: { type: "string", description: "Short note for the task." },
                                details: { type: "string", description: "Longer supporting detail for the task." },
                              },
                              required: ["content"],
                              additionalProperties: false,
                            },
                          },
                        },
                        required: ["name"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["op", "phases"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    op: { type: "string", const: "add_phase" },
                    name: { type: "string", description: "Human-readable phase title." },
                    tasks: {
                      type: "array",
                      description: "Optional initial tasks for the new phase.",
                      items: {
                        type: "object",
                        properties: {
                          content: { type: "string", description: "Required task text." },
                          status: todoStatusSchema(),
                          notes: { type: "string", description: "Short note for the task." },
                          details: { type: "string", description: "Longer supporting detail for the task." },
                        },
                        required: ["content"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["op", "name"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    op: { type: "string", const: "add_task" },
                    phase: {
                      type: "string",
                      description: "Existing phase id from `todoread` or a prior `todowrite` result, for example `phase-2`.",
                    },
                    content: { type: "string", description: "Required task text." },
                    status: todoStatusSchema(),
                    notes: { type: "string", description: "Short note for the task." },
                    details: { type: "string", description: "Longer supporting detail for the task." },
                  },
                  required: ["op", "phase", "content"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    op: { type: "string", const: "update" },
                    id: {
                      type: "string",
                      description: "Existing task id from `todoread` or a prior `todowrite` result, for example `task-3`.",
                    },
                    status: todoStatusSchema(),
                    content: { type: "string", description: "Replacement task text." },
                    notes: { type: "string", description: "Replacement short note for the task." },
                    details: { type: "string", description: "Replacement longer supporting detail for the task." },
                  },
                  required: ["op", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    op: { type: "string", const: "remove_task" },
                    id: {
                      type: "string",
                      description: "Existing task id from `todoread` or a prior `todowrite` result.",
                    },
                  },
                  required: ["op", "id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    op: { type: "string" },
                    id: { type: "string" },
                    phase: { type: "string" },
                    name: { type: "string" },
                    title: { type: "string" },
                    content: { type: "string" },
                    status: { type: "string" },
                    notes: { type: "string" },
                    details: { type: "string" },
                  },
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        required: ["ops"],
        additionalProperties: false,
      };
    case "holaboss_scratchpad_read":
      return { type: "object", properties: {}, additionalProperties: false };
    case "holaboss_scratchpad_write":
      return {
        type: "object",
        properties: {
          op: scratchpadWriteOpSchema(),
          content: {
            type: "string",
            description:
              "Scratchpad markdown or plain-text content. Required for `append` and `replace`, omitted for `clear`.",
          },
        },
        required: ["op"],
        additionalProperties: false,
      };
    case "holaboss_update_workspace_instructions":
      return {
        type: "object",
        properties: {
          op: literalStringUnion(
            ["read_current", "append_rule", "remove_rule", "replace_managed_section"],
            "Workspace-instruction update operation.",
          ),
          rule: {
            type: "string",
            description:
              "Rule text for `append_rule` or `remove_rule`. Use concise one-line durable rules here.",
          },
          content: {
            type: "string",
            description:
              "Managed-section markdown content for `replace_managed_section`. Use this for structured rule sets, multi-line templates, or code fences.",
          },
        },
        required: ["op"],
        additionalProperties: false,
      };
    case "terminal_sessions_list":
      return { type: "object", properties: {}, additionalProperties: false };
    case "terminal_session_start":
      return {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "Shell command text to run in a background PTY session. This command is already executed through the workspace shell.",
          },
          title: { type: "string", description: "Optional display title for the terminal session." },
          cwd: {
            type: "string",
            description: "Optional workspace-relative working directory. Defaults to the workspace root.",
          },
          cols: { type: "number", description: "Optional terminal width in columns." },
          rows: { type: "number", description: "Optional terminal height in rows." },
        },
        required: ["command"],
        additionalProperties: false,
      };
    case "terminal_session_get":
    case "terminal_session_close":
      return {
        type: "object",
        properties: {
          terminal_id: { type: "string", description: "Terminal session id." },
        },
        required: ["terminal_id"],
        additionalProperties: false,
      };
    case "terminal_session_read":
    case "terminal_session_wait":
      return {
        type: "object",
        properties: {
          terminal_id: { type: "string", description: "Terminal session id." },
          after_sequence: {
            type: "number",
            description: "Only return events with sequence greater than this number.",
          },
          limit: {
            type: "number",
            description: "Maximum number of events to return.",
          },
          ...(toolId === "terminal_session_wait"
            ? {
                timeout_ms: {
                  type: "number",
                  description:
                    "Maximum time to wait for new output or a status change before returning with timed_out=true.",
                },
              }
            : {}),
        },
        required: ["terminal_id"],
        additionalProperties: false,
      };
    case "terminal_session_send_input":
      return {
        type: "object",
        properties: {
          terminal_id: { type: "string", description: "Terminal session id." },
          data: {
            type: "string",
            description:
              "Input to write to the terminal session. Include a trailing newline or carriage return when the command expects Enter.",
          },
        },
        required: ["terminal_id", "data"],
        additionalProperties: false,
      };
    case "terminal_session_signal":
      return {
        type: "object",
        properties: {
          terminal_id: { type: "string", description: "Terminal session id." },
          signal: { type: "string", description: "Optional signal name such as SIGINT, SIGTERM, or SIGHUP." },
        },
        required: ["terminal_id"],
        additionalProperties: false,
      };
    case "workspace_apps_find":
      return {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional case-insensitive substring filter applied to app id, name, and description.",
          },
          source: {
            type: "string",
            enum: ["marketplace", "local", "installed", "all"],
            description:
              "Optional source filter. `marketplace` and `local` only return catalog candidates from those sources. `installed` only returns apps already in `workspace.yaml`. `all` (default) merges everything and dedupes by app_id.",
          },
        },
        additionalProperties: false,
      };
    case "workspace_apps_install":
      return {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            description:
              "Catalog app id to install. Must exist in the marketplace or local catalog (call `workspace_apps_find` first if unsure).",
          },
        },
        required: ["app_id"],
        additionalProperties: false,
      };
    case "workspace_apps_scaffold":
      return {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            description:
              "Workspace app id. The scaffold is created under `apps/<app_id>/` and the manifest `app_id` must match.",
          },
          name: {
            type: "string",
            description: "Optional human-readable app name used in the generated manifest and starter UI.",
          },
          overwrite: {
            type: "boolean",
            description:
              "Overwrite the managed starter files if the app directory already exists. Default false.",
          },
        },
        required: ["app_id"],
        additionalProperties: false,
      };
    case "workspace_apps_register":
      return {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            description: "Workspace app id to register in `workspace.yaml`.",
          },
          config_path: {
            type: "string",
            description:
              "Optional workspace-relative path to the app manifest. Defaults to `apps/<app_id>/app.runtime.yaml`.",
          },
        },
        required: ["app_id"],
        additionalProperties: false,
      };
    case "workspace_apps_build":
      return {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            description: "Registered workspace app id to build from its app directory.",
          },
          timeout_ms: {
            type: "integer",
            description:
              "Optional build timeout in milliseconds. Defaults to a reasonable managed-app build timeout.",
            minimum: 1,
          },
        },
        required: ["app_id"],
        additionalProperties: false,
      };
    case "workspace_apps_ensure_running":
      return {
        type: "object",
        properties: {
          app_ids: {
            type: "array",
            description:
              "Optional subset of registered app ids to start. Omit to ensure all registered workspace apps are running.",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      };
    case "workspace_apps_restart":
      return {
        type: "object",
        properties: {
          app_id: { type: "string", description: "Registered workspace app id to restart." },
        },
        required: ["app_id"],
        additionalProperties: false,
      };
    case "workspace_apps_restart_and_wait_ready":
      return {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            description: "Registered workspace app id to restart and wait on.",
          },
          timeout_ms: {
            type: "integer",
            description: "Maximum time to wait before returning with `timed_out=true`.",
            minimum: 1,
          },
          poll_interval_ms: {
            type: "integer",
            description: "Polling interval between status checks while waiting for readiness.",
            minimum: 1,
          },
        },
        required: ["app_id"],
        additionalProperties: false,
      };
    case "workspace_apps_wait_until_ready":
      return {
        type: "object",
        properties: {
          app_id: { type: "string", description: "Registered workspace app id to wait on." },
          timeout_ms: {
            type: "integer",
            description: "Maximum time to wait before returning with `timed_out=true`.",
            minimum: 1,
          },
          poll_interval_ms: {
            type: "integer",
            description: "Polling interval between status checks while waiting for readiness.",
            minimum: 1,
          },
        },
        required: ["app_id"],
        additionalProperties: false,
      };
    case "workspace_apps_get_status":
      return {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            description:
              "Optional registered workspace app id. Omit to list status for every registered app. This is the primary inspection surface for readiness, ports, runtime contract, and revision hints.",
          },
        },
        additionalProperties: false,
      };
    case "workspace_apps_get_ports":
      return {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            description:
              "Optional registered workspace app id. Legacy helper: prefer `workspace_apps_get_status`, which already returns deterministic HTTP and MCP ports.",
          },
        },
        additionalProperties: false,
      };
    case "workspace_apps_probe_endpoints":
      return {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            description: "Registered workspace app id whose managed endpoints should be probed.",
          },
          checks: {
            type: "array",
            description:
              "Optional subset of deterministic endpoint checks. Defaults to `ui`, `mcp_health`, `mcp_initialize`, and `mcp_tools_list`.",
            items: {
              type: "string",
              enum: ["ui", "mcp_health", "mcp_initialize", "mcp_tools_list"],
            },
          },
          timeout_ms: {
            type: "integer",
            description: "Per-request timeout in milliseconds for each endpoint probe.",
            minimum: 1,
          },
        },
        required: ["app_id"],
        additionalProperties: false,
      };
    case "workspace_data_list_tables":
      return {
        type: "object",
        properties: {
          include_system: {
            type: "boolean",
            description:
              "Include app-internal tables (publish queues, scheduler logs, api_usage, settings). Default false.",
          },
        },
        additionalProperties: false,
      };
    case "workspace_data_describe_table":
      return {
        type: "object",
        properties: {
          table_name: {
            type: "string",
            description: "Exact table name in `.holaboss/state/data.db` to describe.",
          },
        },
        required: ["table_name"],
        additionalProperties: false,
      };
    case "workspace_data_sample_rows":
      return {
        type: "object",
        properties: {
          table_name: {
            type: "string",
            description: "Exact table name in `.holaboss/state/data.db` to sample.",
          },
          limit: {
            type: "integer",
            description: "Maximum number of rows to return. Defaults to 5 and is capped to a small safe value.",
            minimum: 1,
          },
          offset: {
            type: "integer",
            description: "Optional row offset for paginating through a table sample.",
            minimum: 0,
          },
        },
        required: ["table_name"],
        additionalProperties: false,
      };
    case "workspace_data_query":
      return {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Single read-only SQL query to run against the workspace shared SQLite. Only SELECT and WITH ... SELECT queries are allowed.",
          },
          limit: {
            type: "integer",
            description: "Maximum rows to return. Defaults to 100 and is capped to a safe value.",
            minimum: 1,
          },
          offset: {
            type: "integer",
            description: "Optional row offset applied to the returned result set.",
            minimum: 0,
          },
          timeout_ms: {
            type: "integer",
            description:
              "Optional advisory timeout in milliseconds for lock waits and deterministic query shaping.",
            minimum: 1,
          },
        },
        required: ["query"],
        additionalProperties: false,
      };
  }
}

function runtimeToolPromptGuidelines(toolId: RuntimeAgentToolId): string[] {
  if (toolId === "download_url") {
    return [
      "Use `download_url` when you already have a direct asset URL and need the file saved into the workspace.",
      "Prefer `download_url` over browser-only downloads or ad hoc shell fetches for straightforward remote file saves.",
      "Omit `output_path` when the default workspace Downloads folder is fine; provide a workspace-relative path when the file must land in a specific location.",
      "Set `expected_mime_prefix` when the user asked for a specific file type such as an image or PDF, or when saving the wrong content would be risky.",
    ];
  }
  if (toolId === "write_report") {
    return [
      "Use `write_report` for research summaries, investigations, audits, plans, reviews, comparisons, timelines, and other long or evidence-heavy answers that should be saved as artifacts.",
      "Do not use `write_report` for a simple fact lookup, definition, brief clarification, current-page answer, or any other reply that is naturally short and self-contained.",
      "Prefer `write_report` when you are synthesizing multiple sources, summarizing current or latest developments, or producing findings the user may want to reference later.",
      "If the user explicitly asked for research, latest news, analysis, comparison, or a timeline and you gathered findings from multiple sources, call `write_report` before your final answer.",
      "A step like 'summarize findings for the user' still means: save the full findings with `write_report`, then keep the chat reply brief.",
      "After calling `write_report`, keep the chat reply short: mention the report title or path and give only the key takeaways.",
      "Write the full markdown report in `content` instead of pasting the full report inline in chat.",
    ];
  }
  if (toolId === "web_search") {
    return [
      "Use `web_search` for exploratory research, source discovery, and approximate or aggregated answers across multiple public sources.",
      "Do not rely on `web_search` alone for exact live values, UI-only state, or tasks that require direct interaction with a site or product surface.",
      "When searching for recent information, include the current year in the query.",
      "If required facts remain unverified after search, escalate to browser tools or another more direct capability.",
    ];
  }
  if (toolId === "holaboss_update_workspace_instructions") {
    return [
      "Use `holaboss_update_workspace_instructions` when durable workspace knowledge should be recorded in root `AGENTS.md`.",
      "Record durable user requirements and preferences, verified commands and procedures, stable workspace facts, conventions, decisions, and recurring blockers that future runs should reuse, whether they came from the user, direct inspection, or grounded tool or subagent results.",
      "Do not record narrow one-off task requests, unresolved hypotheses, partial investigations, or temporary runtime state. Only skip a durable item when the user explicitly says not to record it.",
      "After recording durable guidance in `AGENTS.md`, if it is conditional, situational, or procedural rather than always-on policy, also create or update a workspace-local skill and keep a short skills index entry in `AGENTS.md`.",
      "Use `read_current` before replacing the managed section when you need to preserve or refine existing workspace instructions.",
      "Use `append_rule` for concise rules, `remove_rule` to retract one, and `replace_managed_section` for structured markdown templates, indexes, or larger rule sets.",
    ];
  }
  if (toolId === "skill") {
    return [
      "Use `skill` when a workspace or embedded skill is relevant and you need its canonical guidance block.",
      "When creating or updating a workspace-local skill from a recorded requirement, load `skill-creator` when available and follow its canonical `skills/<skill-id>/SKILL.md` format.",
      "Pass the specific skill id or name in `name` instead of paraphrasing the skill body yourself.",
      "Use `args` only for short follow-up instructions that should accompany the skill block.",
    ];
  }
  if (toolId === "holaboss_delegate_task") {
    return [
      "Use `holaboss_delegate_task` for longer-running, multi-step, or interruptible work that should continue while the main conversation remains free.",
      "Keep each delegated task narrowly scoped and self-contained. Use the canonical `tasks` array for batched delegation and the singleton top-level fields only for one task.",
      "Use `tools` as coarse capability buckets such as `web`, `browser`, `terminal`, or `file`; do not treat them as raw low-level tool ids.",
      "Default delegated browser work to the agent browser. Set `use_user_browser_surface` only when the user explicitly says `use my browser`.",
      "Do not infer user-browser intent from `current tab`, `current page`, `this page`, generic browser requests, or operator-surface context alone.",
      "Delegate execution-heavy work instead of narrating that you will do it later without actually spawning the background task.",
      "When the user asks for work that needs capability missing from the current main-session run, delegate it instead of replying that the current run lacks those tools.",
      "For latest-news, source discovery, and similar external research, usually delegate with `tools: [\"web\"]` and escalate to `browser` only when direct interaction or UI verification is needed.",
      "When the ideal direct integration is missing, delegate with the capability bucket that can still solve the task: `browser` for UI/app state, `web` for public information, and `terminal` or `file` for workspace inspection.",
    ];
  }
  if (toolId === "holaboss_get_subagent") {
    return [
      "Use `holaboss_get_subagent` when you need the latest structured state for one delegated background task.",
      "Use this for targeted status questions like whether one task is done, failed, or waiting on user input.",
      "This reads persisted task state only; it does not block waiting for the task to change.",
      "Do not call this repeatedly in the same turn right after delegating a fresh task just to see if it finished; return control unless the task is already in a terminal or waiting-on-user state.",
    ];
  }
  if (toolId === "holaboss_list_background_tasks") {
    return [
      "Use `holaboss_list_background_tasks` when you need a compact overview of delegated background work for the current workspace.",
      "Use optional filters to narrow the list instead of asking every task to report in full.",
      "This reads persisted task state only; it does not block waiting for any task to change.",
      "Do not use this as a polling loop in the same turn after spawning fresh delegated work.",
    ];
  }
  if (toolId === "holaboss_cancel_subagent") {
    return [
      "Use `holaboss_cancel_subagent` only when the user clearly wants to stop a specific delegated task.",
      "Resolve which delegated task the user means before calling this tool; do not guess if multiple background tasks are plausible matches.",
    ];
  }
  if (toolId === "holaboss_resume_subagent") {
    return [
      "Use `holaboss_resume_subagent` when a delegated task is waiting on user input and the user has provided that answer.",
      "Resume the same paused subagent run instead of delegating a brand-new task when the user is answering an explicit blocker question.",
      "Pass only the answer needed to continue the task; do not restate the entire conversation unless it materially changes the task.",
    ];
  }
  if (toolId === "holaboss_continue_subagent") {
    return [
      "Use `holaboss_continue_subagent` when the user asks to transform, save, refine, compare, or otherwise continue the result of a completed delegated task.",
      "Prefer continuing the existing child session for referential requests like 'turn that into a report', 'save item 2', 'summarize those', or 'compare them'.",
      "If it is unclear which delegated task the user means, ask a short clarifying question before continuing.",
      "Do not start a fresh delegated task for a true continuation of the most recent relevant child result.",
    ];
  }
  if (toolId === "todoread") {
    return [
      "Use `todoread` before changing an existing phased plan when current todo state may matter.",
      "Use `todoread` to recover the exact phase ids and task ids before calling `update`, `add_task`, or `remove_task` on an existing plan.",
      "When current task ids or phase ids matter, read them instead of guessing.",
    ];
  }
  if (toolId === "todowrite") {
    return [
      "Use `todowrite` for complex or long-running tasks that benefit from an explicit phased plan.",
      "Use `todowrite` for task coordination only, not as a ledger for evidence, extracted facts, or long-form working notes; keep those in the session scratchpad.",
      "The top-level phases are grouped tasks, and each phase's `tasks` entries are the actionable task items within that grouped task.",
      `Valid \`op\` values are exactly ${TODO_WRITE_OPS_TEXT}.`,
      TODO_WRITE_ALIAS_WARNING,
      "Use `replace` only for the initial plan or a full rewrite of the entire plan, not for a single task status change.",
      "Use `update` to change an existing task's status, content, notes, or details by task id.",
      "Use `add_phase` to append a new phase, `add_task` to append a task to an existing phase by phase id, and `remove_task` to delete a task by task id.",
      "On an existing plan, call `todoread` first so you have the current phase ids and task ids before writing mutations.",
      "Keep exactly one task `in_progress` whenever unfinished tasks remain unless the current task is blocked on user input or another external dependency.",
    ];
  }
  if (toolId === "holaboss_scratchpad_read") {
    return [
      "Use `holaboss_scratchpad_read` when a resumed or long-running session likely has session-scoped notes that matter for the current turn.",
      "Treat scratchpad notes as session continuity, not as durable memory or verified current truth.",
      "Read the scratchpad when you need the saved notes again; do not assume they are already in prompt context.",
      "When the scratchpad already contains the needed working state, prefer reading it instead of reopening or re-parsing large prior tool artifacts.",
    ];
  }
  if (toolId === "holaboss_scratchpad_write") {
    return [
      "Use `holaboss_scratchpad_write` for long-running working notes, interim findings, open questions, evidence ledgers, or compacted current state that should survive beyond the current prompt window.",
      "After the first material findings in a multi-step task, start or update the scratchpad so verified state does not live only in transient prompt context.",
      "Use `append` while accumulating notes, `replace` when compacting the scratchpad into a fresher shorter summary, and `clear` when the notes are no longer useful.",
      "Use the scratchpad as working memory for verified findings, extracted facts, candidate lists, artifact handles, open questions, and compacted current state.",
      "Do not use `todowrite` as a substitute for scratchpad notes; todo state is for coordination, not evidence.",
      "When replay or context pressure rises, or when a tool returns a large artifact, compact the verified findings and next questions into the scratchpad before continuing.",
      "Keep durable memory, user-visible deliverables, and final answers out of the scratchpad unless they are explicitly session-scoped working notes.",
    ];
  }
  if (
    toolId === "terminal_session_start" ||
    toolId === "terminal_session_read" ||
    toolId === "terminal_session_wait"
  ) {
    return [
      "Prefer `bash` for short one-shot commands that should complete within the current tool call.",
      "Prefer background terminal sessions for long-running commands, dev servers, watch processes, interactive prompts, or work you may need to revisit later in the run.",
      "After starting a terminal session, use `terminal_session_read` or `terminal_session_wait` to inspect output before claiming success.",
      "Use workspace-relative `cwd` values when you need a subdirectory; otherwise let the session start at the workspace root.",
      "When a background terminal is no longer needed, stop it with `terminal_session_signal` or `terminal_session_close` instead of leaving it running indefinitely.",
    ];
  }
  return [];
}

export function createHarnessRuntimeToolDefinition(
  toolId: RuntimeAgentToolId,
  description: string,
  options: HarnessRuntimeToolOptions,
): HarnessRuntimeToolDefinitionLike {
  return {
    name: toolId,
    label: runtimeToolLabel(toolId),
    description,
    promptSnippet: `${toolId}: ${description}`,
    promptGuidelines: runtimeToolPromptGuidelines(toolId),
    parameters: runtimeToolParameters(toolId),
    execute: async (_toolCallId, toolParams, signal) =>
      await executeRuntimeToolCapability({
        toolId,
        toolParams,
        runtimeApiBaseUrl: options.runtimeApiBaseUrl,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        inputId: options.inputId,
        selectedModel: options.selectedModel,
        fetchImpl: options.fetchImpl,
        signal,
      }),
  };
}

export async function resolveHarnessRuntimeToolDefinitions(
  options: {
    runtimeApiBaseUrl?: string | null;
    workspaceId?: string | null;
    sessionId?: string | null;
    inputId?: string | null;
    selectedModel?: string | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<HarnessRuntimeToolDefinitionLike[]> {
  const runtimeApiBaseUrl = resolveRuntimeToolCapabilityBaseUrl(
    options.runtimeApiBaseUrl ?? process.env.SANDBOX_RUNTIME_API_URL,
  );
  if (!runtimeApiBaseUrl) {
    return [];
  }

  const available = await runtimeToolCapabilityAvailable({
    runtimeApiBaseUrl,
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    inputId: options.inputId,
    selectedModel: options.selectedModel,
    fetchImpl: options.fetchImpl,
  });
  if (!available) {
    return [];
  }

  return RUNTIME_AGENT_TOOL_DEFINITIONS.map((tool) =>
    createHarnessRuntimeToolDefinition(tool.id, tool.description, {
      runtimeApiBaseUrl,
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
      inputId: options.inputId,
      selectedModel: options.selectedModel,
      fetchImpl: options.fetchImpl,
    }),
  );
}

export { RUNTIME_AGENT_TOOL_IDS };
