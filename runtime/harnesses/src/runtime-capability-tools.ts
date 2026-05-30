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
const APP_BUILDER_RUNTIME_TOOL_IDS = new Set<RuntimeAgentToolId>([
  "workspace_apps_scaffold",
  "workspace_apps_register",
  "workspace_apps_build",
  "workspace_apps_ensure_running",
  "workspace_apps_restart",
  "workspace_apps_restart_and_wait_ready",
  "workspace_apps_wait_until_ready",
  "workspace_apps_get_status",
  "workspace_apps_get_ports",
  "workspace_apps_probe_endpoints",
]);

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

function alignmentQuestionOptionSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string", description: "Optional stable option id." },
      label: { type: "string", description: "Visible answer label shown to the user." },
      description: { type: "string", description: "Optional helper detail for this option." },
      answer_text: {
        type: "string",
        description: "Optional normalized answer text to store instead of the visible label.",
      },
      recommended: { type: "boolean", description: "Mark the recommended default option." },
    },
    required: ["label"],
    additionalProperties: false,
  };
}

function alignmentQuestionItemSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string", description: "Optional stable question id." },
      title: { type: "string", description: "Optional short heading above the prompt." },
      prompt: { type: "string", description: "Required question text shown to the user." },
      details: { type: "string", description: "Optional supporting detail under the prompt." },
      allow_notes: { type: "boolean", description: "Allow a short notes field." },
      notes_placeholder: { type: "string", description: "Optional notes input placeholder." },
      allow_freeform: {
        type: "boolean",
        description: "Allow a natural-language answer box in addition to options.",
      },
      freeform_placeholder: {
        type: "string",
        description: "Optional placeholder for the freeform answer box.",
      },
      options: {
        type: "array",
        description: "Two or more answer choices.",
        minItems: 2,
        items: alignmentQuestionOptionSchema(),
      },
    },
    required: ["prompt", "options"],
    additionalProperties: false,
  };
}

function alignmentQuestionDeckSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      title: { type: "string", description: "Optional deck heading above the questions." },
      details: { type: "string", description: "Optional deck-level context." },
      allow_notes: {
        type: "boolean",
        description: "Default notes toggle inherited by questions unless overridden.",
      },
      notes_placeholder: {
        type: "string",
        description: "Default notes placeholder inherited by questions unless overridden.",
      },
      allow_freeform: {
        type: "boolean",
        description: "Default freeform-answer toggle inherited by questions unless overridden.",
      },
      freeform_placeholder: {
        type: "string",
        description: "Default freeform placeholder inherited by questions unless overridden.",
      },
      questions: {
        type: "array",
        description: "One or more structured alignment questions.",
        minItems: 1,
        items: alignmentQuestionItemSchema(),
      },
    },
    required: ["questions"],
    additionalProperties: false,
  };
}

function runtimeToolParameters(toolId: RuntimeAgentToolId): Record<string, unknown> {
  switch (toolId) {
    case "onboarding_status":
      return { type: "object", properties: {}, additionalProperties: false };
    case "holaboss_create_alignment_question":
      return {
        type: "object",
        properties: {
          question: {
            description:
              "Structured onboarding question payload. Use either one question object with `prompt` and `options`, or a deck object with `questions: [...]` where each item also has `prompt` and `options`.",
            anyOf: [alignmentQuestionItemSchema(), alignmentQuestionDeckSchema()],
          },
        },
        required: ["question"],
        additionalProperties: false,
      };
    case "holaboss_create_alignment_report":
    case "holaboss_create_verification_report":
      return {
        type: "object",
        properties: {
          report: {
            type: "object",
            description:
              "Structured onboarding report payload. Include a human-readable `markdown` string for the review card, then add any machine-readable fields the implementation phase should keep.",
            properties: {
              markdown: {
                type: "string",
                description:
                  "Primary human-readable onboarding report body rendered in the review card as markdown.",
              },
              summary: {
                type: "string",
                description:
                  "Optional short summary kept for fallback surfaces and machine-readable state.",
              },
            },
            additionalProperties: true,
          },
        },
        required: ["report"],
        additionalProperties: false,
      };
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
    case "memory_retrieve":
      return {
        type: "object",
        properties: {
          query: { type: "string", description: "Memory retrieval query or question." },
          mode: literalStringUnion(
            ["mixed", "summaries", "leaves"],
            "Retrieval mode. Use `mixed` by default, `summaries` for broad context, and `leaves` for exact evidence.",
          ),
          tree_id: { type: "string", description: "Optional interaction tree id to scope retrieval." },
          node_id: { type: "string", description: "Optional summary node id to expand or drill into." },
          max_results: {
            type: "integer",
            description: "Optional maximum number of hits to return.",
            minimum: 1,
          },
        },
        required: ["query"],
        additionalProperties: false,
      };
    case "cronjobs_list":
      return {
        type: "object",
        properties: {
          enabled_only: { type: "boolean", description: "Only return enabled cronjobs." },
        },
        additionalProperties: false,
      };
    case "cronjobs_get":
    case "cronjobs_delete":
      return {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Cronjob id." },
        },
        required: ["job_id"],
        additionalProperties: false,
      };
    case "cronjobs_create":
      return {
        type: "object",
        properties: {
          cron: { type: "string", description: "Cron expression." },
          teammate_id: {
            type: "string",
            description: "Existing active teammate id that will execute issues created by this cronjob.",
          },
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
        required: ["cron", "teammate_id", "description", "instruction"],
        additionalProperties: false,
      };
    case "teammates_list":
      return {
        type: "object",
        properties: {
          include_archived: {
            type: "boolean",
            description: "Whether archived teammates should be included in the roster listing.",
          },
          limit: {
            type: "integer",
            description: "Optional maximum number of teammates to return.",
          },
          offset: {
            type: "integer",
            description: "Optional roster offset for pagination.",
          },
        },
        additionalProperties: false,
      };
    case "teammates_create":
      return {
        type: "object",
        properties: {
          teammate_id: {
            type: "string",
            description: "Optional stable teammate id. Omit to let the runtime generate one.",
          },
          name: { type: "string", description: "Teammate display name." },
          instructions: {
            type: "string",
            description: "Optional role instructions that define the teammate's standing remit.",
          },
          capability_profile: {
            type: "object",
            description:
              "Optional routing hints used by the coordinator when deciding which teammate to delegate to.",
            properties: {
              summary: {
                type: "string",
                description: "Short summary of the teammate's specialty.",
              },
              capabilities: {
                type: "array",
                description: "Short capability tags such as frontend, research, or implementation.",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        },
        required: ["name"],
        additionalProperties: false,
      };
    case "teammate_skills_create":
      return {
        type: "object",
        properties: {
          teammate_id: {
            type: "string",
            description: "Existing teammate id that will own the skill bundle.",
          },
          skill_id: {
            type: "string",
            description: "Optional stable skill id used for the skill folder name.",
          },
          name: {
            type: "string",
            description: "Human-readable skill label, used as the SKILL.md description when skill_markdown is not provided.",
          },
          content: {
            type: "string",
            description: "The SKILL.md body content when skill_markdown is not provided.",
          },
          skill_markdown: {
            type: "string",
            description: "Optional full SKILL.md document including YAML frontmatter. Preferred for richer skills.",
          },
          granted_tools: {
            type: "array",
            description: "Optional granted tools written into holaboss frontmatter when skill_markdown is not provided.",
            items: { type: "string" },
          },
          granted_commands: {
            type: "array",
            description: "Optional granted commands written into holaboss frontmatter when skill_markdown is not provided.",
            items: { type: "string" },
          },
          sidecar_files: {
            type: "array",
            description: "Optional extra text files to create inside the skill directory, such as scripts/, references/, assets/, or agents/openai.yaml.",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Relative path inside the skill directory, for example scripts/fetch.sh.",
                },
                content: {
                  type: "string",
                  description: "UTF-8 file content for the sidecar file.",
                },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
          directories: {
            type: "array",
            description: "Optional empty directories to create inside the skill directory.",
            items: { type: "string" },
          },
          payload_mode: {
            type: "string",
            enum: ["skill_markdown", "name_content"],
            description:
              "Choose `skill_markdown` when sending a full SKILL.md document, or `name_content` when sending simple text-only skill fields.",
          },
        },
        required: ["teammate_id"],
        additionalProperties: false,
      };
    case "cronjobs_update":
      return {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Cronjob id." },
          teammate_id: {
            type: "string",
            description: "Optional replacement teammate id for future issue executions.",
          },
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
    case "delegate_task":
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
                teammate_id: {
                  type: "string",
                  description:
                    "Required teammate id for the delegated worker. Choose the assignee explicitly; do not rely on runtime auto-routing.",
                },
                parent_task_id: {
                  type: "string",
                  description:
                    "Optional parent task id when this delegated task should be created as a sub-task of an existing task.",
                },
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
              required: ["teammate_id", "goal"],
              additionalProperties: false,
            },
          },
          teammate_id: {
            type: "string",
            description:
              "Singleton alias: required teammate id for the delegated worker.",
          },
          parent_task_id: {
            type: "string",
            description:
              "Singleton alias: optional parent task id when creating a sub-task.",
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
        required: ["tasks"],
        additionalProperties: false,
      };
    case "get_task":
      return {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Delegated task id to inspect, for example `U5-2`. Do not pass a `subagent_id` UUID here.",
          },
        },
        required: ["task_id"],
        additionalProperties: false,
      };
    case "list_tasks":
      return {
        type: "object",
        properties: {
          statuses: {
            type: "array",
            description: "Optional delegated task statuses to include.",
            items: literalStringUnion(
              ["backlog", "todo", "in_progress", "in_review", "done", "blocked"],
              "Task status filter.",
            ),
          },
          limit: {
            type: "integer",
            description: "Optional maximum number of delegated tasks to return.",
            minimum: 1,
          },
        },
        additionalProperties: false,
      };
    case "reply_task":
      return {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description:
              "Delegated task id to reply to, for example `U5-2`. Do not pass a `subagent_id` UUID here.",
          },
          text: {
            type: "string",
            description:
              "Reply text to enqueue into the existing delegated task thread, usually the user's answer to a blocking question.",
          },
          model: {
            type: "string",
            description: "Optional model override for the queued task reply.",
          },
          priority: {
            type: "integer",
            description: "Optional queue priority override for the queued task reply.",
          },
        },
        required: ["task_id", "text"],
        additionalProperties: false,
      };
    case "cancel_task":
      return {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description:
              "Delegated task id whose active execution should be cancelled, for example `U5-2`. Do not pass a `subagent_id` UUID here.",
          },
        },
        required: ["task_id"],
        additionalProperties: false,
      };
    case "rerun_task":
      return {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description:
              "Delegated task id to rerun from its saved brief, for example `U5-2`. Do not pass a `subagent_id` UUID here.",
          },
          model: { type: "string", description: "Optional model override for the rerun." },
          priority: {
            type: "integer",
            description: "Optional queue priority override for the rerun.",
          },
        },
        required: ["task_id"],
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
          filename: { type: "string", description: "Optional HTML filename stem for the saved report." },
          summary: { type: "string", description: "Optional short summary for artifact metadata and follow-up context." },
          content: {
            type: "string",
            description:
              "Full self-contained HTML report content to save as an artifact. Put the detailed research findings in this field instead of in chat.",
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
    case "scratchpad_read":
      return { type: "object", properties: {}, additionalProperties: false };
    case "scratchpad_write":
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
    case "update_workspace_instructions":
      return {
        type: "object",
        properties: {
          op: literalStringUnion(
            ["read_current", "append_rule", "remove_rule", "replace_managed_section"],
            "Workspace-instruction operation. Valid values are exactly `read_current`, `append_rule`, `remove_rule`, and `replace_managed_section`. Use `read_current` for reads; do not use `read` or other aliases.",
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
    case "workspace_integrations_list_catalog":
      return { type: "object", properties: {}, additionalProperties: false };
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
    case "holaboss_workspace_integrations_propose_connect":
      return {
        type: "object",
        properties: {
          toolkit_slug: {
            type: "string",
            description:
              "Lowercase slug of the toolkit to connect (e.g. 'gmail', 'notion', 'linear'). Must be in the workspace integration store catalog.",
          },
          reason: {
            type: "string",
            description:
              "Optional short one-liner explaining why the user needs this integration. Surfaced inline on the Connect card.",
          },
        },
        required: ["toolkit_slug"],
        additionalProperties: false,
      };
    case "holaboss_workspace_integrations_set_default_account":
      return {
        type: "object",
        properties: {
          provider_id: {
            type: "string",
            description:
              "Lowercase Composio provider slug, e.g. 'gmail', 'github', 'notion'.",
          },
          connection_id: {
            type: "string",
            description:
              "The integration_connections.connection_id of the account to make this workspace's default for the provider. Obtain from `workspace_integrations_list_catalog` — the entries list connected accounts per toolkit.",
          },
        },
        required: ["provider_id", "connection_id"],
        additionalProperties: false,
      };
  }
}

function runtimeToolPromptGuidelines(toolId: RuntimeAgentToolId): string[] {
  const appBuilderToolGuidance = APP_BUILDER_RUNTIME_TOOL_IDS.has(toolId)
    ? [
        "Only the App Builder teammate should call workspace app build and lifecycle tools.",
        "If you are not running as App Builder, stop and route the app work there instead of improvising with generic file or terminal work.",
        "For dashboard-shape apps with `src/client/`, load `build-dashboard` once the SDK and runtime contract are in place and the task has moved into client-surface implementation.",
      ]
    : [];
  if (toolId === "holaboss_create_alignment_question") {
    return [
      "Pass `question` as either a single question object or a deck object with `questions: [...]`.",
      "Every question item must include a human-readable `prompt` and at least two `options` with `label` fields.",
      "Use `title` only as a short heading; do not rely on `title` alone when you can provide a clearer `prompt`.",
      "Use `allow_freeform: true` when the user may answer in their own words instead of only choosing an option.",
      "Keep question decks short and tightly related, usually 2-5 questions.",
    ];
  }
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
      "Write the full report as self-contained HTML in `content` instead of pasting the full report inline in chat.",
      "Use semantic headings, tables, lists, and concise inline CSS when that improves scanability; avoid scripts and remote assets unless the user explicitly asked for them.",
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
  if (toolId === "update_workspace_instructions") {
    return [
      "Use `update_workspace_instructions` when durable workspace knowledge should be recorded in root `AGENTS.md`.",
      "Valid `op` values are exactly `read_current`, `append_rule`, `remove_rule`, and `replace_managed_section`.",
      "Do not invent alias op names such as `read`; the read operation is `read_current`.",
      "Record durable user requirements and preferences, verified commands and procedures, stable workspace facts, conventions, decisions, and recurring blockers that future runs should reuse when they are clearly stable, likely to recur, or explicitly confirmed by the user, whether they came from the user, direct inspection, or grounded tool or subagent results.",
      "Do not record narrow one-off task requests, unresolved hypotheses, partial investigations, or temporary runtime state. When in doubt, leave it out until the pattern repeats or the user confirms it should persist.",
      "After recording durable guidance in `AGENTS.md`, if it is conditional, situational, or procedural rather than always-on policy, also create or update a workspace-local skill and keep a short skills index entry in `AGENTS.md`.",
      "Use `read_current` before replacing the managed section when you need to preserve or refine existing workspace instructions.",
      "Use `append_rule` for concise rules, `remove_rule` to retract one, and `replace_managed_section` for structured markdown templates, indexes, or larger rule sets.",
    ];
  }
  if (toolId === "teammates_list") {
    return [
      "Only the HR teammate should call `teammates_list`.",
      "Use `teammates_list` to inspect the live current roster before creating, reshaping, merging, or retiring teammates.",
      "Default to active teammates only. Include archived teammates only when you need historical overlap or restoration context.",
      "Prefer this tool over generic file inspection when you need the authoritative current teammate roster.",
    ];
  }
  if (toolId === "teammates_create") {
    return [
      "Only the HR teammate should call `teammates_create`.",
      "Use `teammates_create` when the workspace needs a new custom teammate identity with a defined remit.",
      "Use `teammates_create` as one step in teammate provisioning: first understand the durable remit, prerequisites, and required integrations, then create the teammate record.",
      "Keep this tool focused on teammate metadata: `name`, durable `instructions`, and `capability_profile` routing hints.",
      "If the role needs repeatable workflows, references, scripts, or structured operating rules, follow `teammates_create` with `teammate_skills_create` in the same bootstrap flow.",
      "Prefer short, stable capability tags in `capability_profile.capabilities` so future delegation matching stays predictable.",
    ];
  }
  if (toolId === "teammate_skills_create") {
    return [
      "Only the HR teammate should call `teammate_skills_create`.",
      "Use `teammate_skills_create` to create one filesystem-backed skill bundle for an existing teammate.",
      "Prefer `skill_markdown` plus `sidecar_files` and optional `directories` for real skill bundles; use `name` + `content` only for simple text-only skills.",
      "Place scripts under `scripts/`, reference docs under `references/`, templates or static files under `assets/`, and UI metadata under `agents/openai.yaml` when needed.",
      "Treat this as teammate-local skill authoring under `teammates/<teammate-id>/skills/<skill-id>/`; do not use it for shared workspace skills under `skills/`.",
    ];
  }
  if (toolId === "memory_retrieve") {
    return [
      "Use `memory_retrieve` when you need durable interaction memory that is not already available in the current prompt context.",
      "Prefer `mixed` mode for general recall, `summaries` for broad background, and `leaves` when you need exact supporting facts.",
      "Pass `tree_id` when you already know the relevant interaction entity tree, and `node_id` when drilling into a previously returned summary branch.",
      "Treat returned summaries as compressed memory context and leaf hits as the underlying evidence.",
      "Treat the returned hit payload as the answer surface. Do not inspect backing memory files with generic file tools unless a future dedicated memory follow-up tool explicitly requires it.",
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
  if (toolId === "delegate_task") {
    return [
      "Use `delegate_task` for longer-running, multi-step, or interruptible work that should continue while the main conversation remains free.",
      "Keep each delegated task narrowly scoped and self-contained. Pass delegated work through the canonical `tasks` array.",
      "Always choose and pass an explicit `teammate_id`. The manager owns teammate routing; do not omit the assignee and do not expect the runtime to choose one for you.",
      "When the work is intentionally a sub-task of an existing delegated task, pass its stable `parent_task_id` such as `U5-2` so the runtime records the hierarchy.",
      "The returned delegated-task payload exposes the stable `task_id` at the top level. If you inspect nested run details, do not use any `subagent_id` there as the task identifier.",
      "Use `tools` as coarse capability buckets such as `web`, `browser`, `terminal`, or `file`; do not treat them as raw low-level tool ids.",
      "Default delegated browser work to the agent browser. Set `use_user_browser_surface` only when the user explicitly says `use my browser`.",
      "Do not infer user-browser intent from `current tab`, `current page`, `this page`, generic browser requests, or operator-surface context alone.",
      "Delegate execution-heavy work instead of narrating that you will do it later without actually spawning the background task.",
      "When the user asks for work that needs capability missing from the current main-session run, delegate it instead of replying that the current run lacks those tools.",
      "For latest-news, source discovery, and similar external research, usually delegate with `tools: [\"web\"]` and escalate to `browser` only when direct interaction or UI verification is needed.",
      "When the ideal direct integration is missing, delegate with the capability bucket that can still solve the task: `browser` for UI/app state, `web` for public information, and `terminal` or `file` for workspace inspection.",
    ];
  }
  if (toolId === "get_task") {
    return [
      "Use `get_task` when the user is referring to a delegated work item or task rather than a low-level subagent run id.",
      "Pass the stable `task_id` such as `U5-2`, not the `subagent_id` UUID from a linked run payload.",
      "This reads persisted task state only; it does not block waiting for the task to change.",
      "Do not call this repeatedly in the same turn right after delegating a fresh task just to see if it finished; return control unless the task is already terminal or waiting on user input.",
    ];
  }
  if (toolId === "list_tasks") {
    return [
      "Use `list_tasks` for a task-oriented overview of delegated work in the current workspace.",
      "Filter by `statuses` when the user only wants blocked, in-progress, done, or similar subsets.",
      "This reads persisted task state only; it does not block waiting for any task to change.",
      "Do not use this as a polling loop in the same turn after spawning fresh delegated work.",
    ];
  }
  if (toolId === "reply_task") {
    return [
      "Use `reply_task` when a delegated task is blocked or waiting on user input and the user is answering that task's question.",
      "Pass the stable `task_id` such as `U5-2`, not the `subagent_id` UUID from a linked run payload.",
      "Forward the user's answer into `text` instead of paraphrasing it into a fresh new task.",
      "Prefer this over `rerun_task` when the task already exists and needs a reply in its existing thread.",
    ];
  }
  if (toolId === "cancel_task") {
    return [
      "Use `cancel_task` when the user wants to stop a delegated task and you know the task id.",
      "Pass the stable `task_id` such as `U5-2`, not the `subagent_id` UUID from a linked run payload.",
    ];
  }
  if (toolId === "rerun_task") {
    return [
      "Use `rerun_task` when the user wants to retry or restart an existing delegated task from its saved brief.",
      "Pass the stable `task_id` such as `U5-2`, not the `subagent_id` UUID from a linked run payload.",
      "Prefer this over `delegate_task` when the work item already exists and the intent is to rerun the same task rather than create a new one.",
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
  if (toolId === "scratchpad_read") {
    return [
      "Use `scratchpad_read` when a resumed or long-running session likely has session-scoped notes that matter for the current turn.",
      "Treat scratchpad notes as session continuity, not as durable memory or verified current truth.",
      "Read the scratchpad when you need the saved notes again; do not assume they are already in prompt context.",
      "When the scratchpad already contains the needed working state, prefer reading it instead of reopening or re-parsing large prior tool artifacts.",
    ];
  }
  if (toolId === "scratchpad_write") {
    return [
      "Use `scratchpad_write` for long-running working notes, interim findings, open questions, evidence ledgers, or compacted current state that should survive beyond the current prompt window.",
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
  if (toolId === "holaboss_workspace_integrations_propose_connect") {
    return [
      "When the user wants to USE a third-party service directly via chat (Gmail, Slack, Notion, Linear, GitHub, …) and there is NO matching `<toolkit>_<verb>` tool already in your tool list, call this tool. Connecting an integration is one OAuth click for the user, not an engineering task.",
      "DO NOT call this tool to satisfy a 'build me an app that uses X' request. App-building has its own connect+bind flow: scaffold the app first, declare the required `integration` in `app.runtime.yaml`, and let `workspace_apps_register` / `workspace_apps_ensure_running` surface `pending_integrations`. The chat UI auto-renders the per-app binding card from that response — that card both opens OAuth (if no accounts exist) AND binds the chosen account to the specific app. Calling propose_connect up-front creates a workspace-level connection without binding it to anything, the user clicks Connect once and thinks they're done, then the freshly-built app reports `integration_not_bound` because the per-app binding step was skipped. The screenshot the user takes is of an empty 'Connect X' state, polish has nothing meaningful to compare against, the dashboard ships broken.",
      "DELEGATE THE BUILD, DO NOT INLINE IT. App-building (scaffold → install → register → build → ensure_running, ~50+ tool calls) must run inside `delegate_task` to the App Builder teammate, NOT in the main chat session. The main session stays responsive for the user; App Builder does the long pipeline. After propose_connect (when it's actually needed) or after the user binds a connection, your follow-up action for the build phase is `delegate_task` with the build brief for App Builder — never `workspace_apps_scaffold` inline. Building in main session blocks chat, pollutes the user's turn history with read/edit/bash spam, and makes the polish pass turn (which the runtime auto-queues) collide with build output.",
      "INTEGRATION-VS-APP-BINDING — Integrations are user-level OAuth accounts; a single connected Gmail account can power any number of apps. Apps consume those accounts via a per-app binding. Two different chat cards exist for the two situations: a 'Connect <provider>' card (this tool) opens the OAuth flow for a brand-new account; a 'Pick a <provider> account for <app>' card auto-renders from `pending_integrations` and lets the user bind an existing connection to the app. Only call this tool when there is NO app context — the user is asking for direct-use of the service in chat.",
      "App context exception still applies: if `workspace_apps_register/build/ensure_running` returned `pending_integrations` entries where `available_accounts === 0`, you may call this tool once per such provider — the user has zero accounts and the binding card alone cannot open OAuth. For entries where `available_accounts >= 1`, the chat UI's binding card handles both account-pick and OAuth via 'Add another'; calling propose_connect on top creates a duplicate Connect card. Do NOT ship a 'safe mode' / 'manual mode' / 'no real recipient' fallback to avoid asking.",
      "Do NOT call `workspace_apps_scaffold` / `workspace_apps_build` to satisfy a 'connect X' request. Integrations and apps are separate concepts: integrations are user OAuth accounts, apps are user-built tools that consume those accounts.",
      "Pass `toolkit_slug` as a lowercase canonical slug (`gmail`, `notion`, `linear`, etc.) from the workspace integration store catalog. If unsure whether a service is in scope, name it; the runtime will reject unknown slugs and the user can clarify.",
      "Pass an optional one-line `reason` only when you actually have one ('to read your unread mail', 'to log this task in your Linear project'). Skip `reason` for bare 'connect X' requests.",
      "After this tool returns, do not also write '请去 Settings 连接' or similar manual instructions — the chat UI already renders a Connect card. Reply with one or two short lines: why you need it, then wait. The user will click Connect; a system message will tell you when the toolkit is ready.",
      "When you hit a `not_connected` / 401 from any MCP toolkit tool, the correct response is to propose_connect that provider — NOT to conclude the API is unavailable, switch to a fake-only mode, or quietly drop the feature.",
    ];
  }
  if (toolId === "workspace_apps_scaffold") {
    return [
      ...appBuilderToolGuidance,
      "This tool builds a brand-new user-facing app (TanStack Start project, dashboard, vibe-coded internal tool). It is NOT how a user connects an integration.",
      "If the user wants to connect, authorize, or otherwise gain OAuth access to a known third-party service, call `holaboss_workspace_integrations_propose_connect` instead — building an app for that is a category error.",
      "Use this only when the user actually asked for a new app, dashboard, tool, surface, internal product, or other UI/persistence/schedule-bearing capability.",
      "MANDATORY PRECONDITION: invoke `skill({ name: \"app-builder-sdk\" })` ONCE before calling this tool, and read its full output. The skill contains the SDK contract (5 primitives, provider id rules, package.json shape, density rules, anti-patterns, install protocol). Building from training-data priors alone produces apps that consistently miss the SDK shape, the npm semver pin, and the density/aesthetic rules — i.e. the failure mode users keep flagging. The 1-line catalog description is NOT enough; load the full SKILL.md.",
      "DELEGATE OR YOU'RE IN THE WRONG SESSION. This tool is the entry point of a ~50+ tool-call pipeline (scaffold → bun install → register → build → ensure_running → polish). If you are running in the main chat session (not a delegated subagent), STOP and call `delegate_task` with the full build brief for App Builder instead — that teammate will run this pipeline in the background while the user's chat stays responsive. Calling this tool directly from main session is the symptom of a wrong control-flow choice; the user has explicitly flagged this as a poor experience. The only acceptable callers of this tool are App Builder subagent sessions spawned by delegate_task.",
    ];
  }
  if (
    toolId === "workspace_apps_register" ||
    toolId === "workspace_apps_build" ||
    toolId === "workspace_apps_ensure_running"
  ) {
    return [
      ...appBuilderToolGuidance,
      "If the response includes a `pending_integrations` array, the app declares providers (Gmail / Twitter / Linear / etc.) that the user has not yet connected. You MUST call `holaboss_workspace_integrations_propose_connect` once per unique `provider_id` in that array — same turn is correct — before you can claim the app is ready.",
      "Do NOT interpret a `pending_integrations` non-empty response as 'the API is unavailable' or 'this provider doesn't expose what I need'. It means exactly one thing: the user hasn't completed OAuth for that toolkit yet. Propose connect and wait for the gate to re-dispatch your input.",
      "Do NOT report the app as 'done', 'in safe mode', 'manual mode', 'logging-only', 'preview mode', or any variant that means the app does not actually do what the user asked for. If a provider is still unconnected, the correct outcome is a Connect card in chat, not a shipped non-functional app.",
      "After you propose connects, stop. Do not retry the tool, do not call MCP tools that need those connections, do not poll. The runtime parks the input and re-dispatches it the moment every required connection is active.",
      "DASHBOARD APPS — POST-BUILD POLISH PASS IS AUTO-QUEUED: when `workspace_apps_ensure_running` returns `ready: true` for a dashboard-shape app (one with `src/client/`), the runtime automatically queues a polish-only input on the user-facing main session (the response includes `polish_pass_queued` listing the queued inputs). Do NOT also attempt an interface-design refactor pass inside the current turn. Wrap up the build turn cleanly — tell the user the app is built and that a polish pass will run next. The polish input dispatches as the next turn, with fresh context and a narrow `apps/<app_id>/src/client/` scope; that turn is where the rewrite happens.",
      "When that polish turn fires (you will see a `text` payload starting with `[Auto-queued post-build polish pass]`), follow it literally: invoke `interface-design`, REWRITE each `src/client/` file via `bash` heredoc (NOT `edit`), rebuild + restart, then verify with `browser_screenshot`. The polish turn's `text` payload tells you what to do and when it's done; do not bring concrete visual rules from elsewhere — the `interface-design` skill output is the sole authority for what the dashboard should look like.",
    ];
  }
  return appBuilderToolGuidance;
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
