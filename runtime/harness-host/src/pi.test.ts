import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import JSZip from "jszip";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { fauxAssistantMessage, registerFauxProvider, type Model } from "@mariozechner/pi-ai";
import { streamOpenAIResponses } from "../node_modules/@mariozechner/pi-ai/dist/providers/openai-responses.js";
import { generateSummary } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js";
import { createHarnessSkillWideningState } from "../../harnesses/src/index.js";

import type { HarnessHostPiRequest } from "./contracts.js";
import {
  buildPiProviderConfig,
  buildPiPromptPayload,
  createPiSkillToolDefinition,
  buildPiMcpServerBindings,
  buildPiMcpToolName,
  compactPiSession,
  createPiTodoToolDefinitions,
  createPiEventMapperState,
  filterPiToolDefinitionsForRequest,
  filterPiRuntimeToolDefinitionsForHost,
  createPiMcpCustomTools,
  mapPiSessionEvent,
  piCompactionReserveTokens,
  requestedPiThinkingBudgets,
  requestedPiThinkingConfig,
  requestedPiThinkingLevel,
  refreshPiSkillCatalog,
  resolvePiSkillDirs,
  runtimeToolSelectedModelForPiRequest,
  workspaceBoundaryOverrideRequested,
  workspaceBoundaryViolationForToolCall,
  runPi
} from "./pi.js";

interface XlsxPopulateCell {
  value(value: unknown): XlsxPopulateCell;
}

interface XlsxPopulateWorksheet {
  cell(row: number, column: number): XlsxPopulateCell;
}

interface XlsxPopulateWorkbook {
  sheet(indexOrName: number | string): XlsxPopulateWorksheet | undefined;
  outputAsync(): Promise<Buffer | Uint8Array | ArrayBuffer>;
}

interface XlsxPopulateStatic {
  fromBlankAsync(): Promise<XlsxPopulateWorkbook>;
}

const nodeRequire = createRequire(import.meta.url);
const XlsxPopulate = nodeRequire("xlsx-populate") as XlsxPopulateStatic;

function baseRequest(): HarnessHostPiRequest {
  return {
    workspace_id: "workspace-1",
    workspace_dir: "/tmp/workspace-1",
    session_id: "session-1",
    browser_tools_enabled: false,
    input_id: "input-1",
    instruction: "List the files",
    debug: false,
    harness_session_id: undefined,
    persisted_harness_session_id: undefined,
    provider_id: "openai",
    model_id: "gpt-5.1",
    timeout_seconds: 30,
    runtime_api_base_url: "http://127.0.0.1:5060",
    system_prompt: "You are concise.",
    workspace_skill_dirs: [],
    mcp_servers: [],
    mcp_tool_refs: [],
    workspace_config_checksum: "checksum-1",
    run_started_payload: { phase: "booting" },
    model_client: {
      model_proxy_provider: "openai_compatible",
      api_key: "token",
      base_url: "https://runtime.example/api/v1/model-proxy/openai/v1",
      default_headers: {
        "X-API-Key": "token",
      },
    },
  };
}

function withoutPiNativeEvents<T extends { event_type: string }>(events: readonly T[]): T[] {
  return events.filter((event) => event.event_type !== "pi_native_event");
}

function onlyPiNativeEvents<T extends { event_type: string; payload: Record<string, unknown> }>(events: readonly T[]): T[] {
  return events.filter((event) => event.event_type === "pi_native_event");
}

function derivedPiEvents(...args: Parameters<typeof mapPiSessionEvent>) {
  return withoutPiNativeEvents(mapPiSessionEvent(...args));
}

function createCompactionUserMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

async function runCompactionSummaryScenario(params: {
  contextWindow: number;
  reserveTokens: number;
  messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }>;
  thresholdBytes: number;
}) {
  const prompts: string[] = [];
  let summaryIndex = 0;
  const registration = registerFauxProvider({
    models: [
      {
        id: "faux-compaction",
        name: "Faux Compaction",
        contextWindow: params.contextWindow,
        maxTokens: params.reserveTokens,
      },
    ],
    tokenSize: { min: 1000, max: 1000 },
  });

  const responder = (context: any) => {
    const promptText = context.messages[0]?.content?.[0]?.text ?? "";
    prompts.push(promptText);
    if (Buffer.byteLength(promptText, "utf8") > params.thresholdBytes) {
      throw new Error("Your input exceeds the context window of this model.");
    }
    summaryIndex += 1;
    return fauxAssistantMessage(`summary-${summaryIndex}`);
  };

  registration.setResponses(Array.from({ length: 32 }, () => responder));

  try {
    const model = registration.getModel("faux-compaction");
    assert.ok(model);
    const summary = await generateSummary(
      params.messages as never,
      model as Model<"faux">,
      params.reserveTokens,
      "token",
      undefined,
      undefined,
      undefined,
      undefined,
      "compaction-session",
    );
    return {
      summary,
      prompts,
      callCount: registration.state.callCount,
    };
  } finally {
    registration.unregister();
  }
}

test("pi normalizes array-wrapped openai-compatible error bodies", async () => {
  const { APIError } = await import("openai");
  const error = APIError.generate(
    400,
    [
      {
        error: {
          code: 400,
          message: "User location is not supported for the API use.",
          status: "FAILED_PRECONDITION",
        },
      },
    ],
    undefined,
    new Headers()
  );

  assert.equal(error.message, "400 User location is not supported for the API use.");
  assert.deepEqual(error.error, {
    code: 400,
    message: "User location is not supported for the API use.",
    status: "FAILED_PRECONDITION",
  });
});

test("filterPiToolDefinitionsForRequest enforces the projected tool map and aliases", () => {
  const filtered = filterPiToolDefinitionsForRequest(
    {
      tools: {
        read: true,
        glob: true,
        list: true,
        ripgrep: true,
        skill: true,
        web_search: false,
      },
    },
    [
      { name: "read" },
      { name: "ripgrep" },
      { name: "find" },
      { name: "ls" },
      { name: "skill" },
      { name: "web_search" },
      { name: "bash" },
    ]
  );

  assert.deepEqual(
    filtered.map((tool) => tool.name),
    ["read", "ripgrep", "find", "ls", "skill"]
  );
});

test("filterPiToolDefinitionsForRequest keeps the legacy grep request key working for ripgrep", () => {
  const filtered = filterPiToolDefinitionsForRequest(
    {
      tools: {
        grep: true,
      },
    },
    [{ name: "ripgrep" }, { name: "bash" }]
  );

  assert.deepEqual(
    filtered.map((tool) => tool.name),
    ["ripgrep"]
  );
});

test("filterPiRuntimeToolDefinitionsForHost removes host-native duplicates from runtime tools", () => {
  const filtered = filterPiRuntimeToolDefinitionsForHost([
    { name: "skill" },
    { name: "todoread" },
    { name: "todowrite" },
    { name: "web_search" },
    { name: "memory_retrieve" },
    { name: "browser_navigate" },
  ]);

  assert.deepEqual(
    filtered.map((tool) => tool.name),
    ["memory_retrieve", "browser_navigate"]
  );
});

test("runtimeToolSelectedModelForPiRequest preserves the original selected model token", () => {
  assert.equal(
    runtimeToolSelectedModelForPiRequest({
      selected_model: "holaboss_model_proxy/gpt-5.4",
      provider_id: "openai",
      model_id: "gpt-5.4",
    }),
    "holaboss_model_proxy/gpt-5.4",
  );
  assert.equal(
    runtimeToolSelectedModelForPiRequest({
      selected_model: "   ",
      provider_id: "openai",
      model_id: "gpt-5.4",
    }),
    "openai/gpt-5.4",
  );
});

test("mapPiSessionEvent extracts nested Gemini provider error messages", () => {
  const sessionFile = "/tmp/pi-session.jsonl";

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "google-generative-ai",
          provider: "gemini_direct",
          model: "gemini-2.5-flash",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage:
            "{\"error\":{\"message\":\"{\\n  \\\"error\\\": {\\n    \\\"code\\\": 400,\\n    \\\"message\\\": \\\"User location is not supported for the API use.\\\",\\n    \\\"status\\\": \\\"FAILED_PRECONDITION\\\"\\n  }\\n}\\n\",\"code\":400,\"status\":\"Bad Request\"}}",
          timestamp: Date.now(),
        },
      } as never,
      sessionFile,
      createPiEventMapperState()
    ),
    [
      {
        event_type: "run_failed",
        payload: {
          type: "ProviderError",
          message: "User location is not supported for the API use.",
          stop_reason: "error",
          provider: "gemini_direct",
          model: "gemini-2.5-flash",
          event: "message_end",
          source: "pi",
          harness_session_id: sessionFile,
        },
      },
    ]
  );
});

test("mapPiSessionEvent emits a pi_native_event passthrough for non-streaming Pi session events", () => {
  const sessionFile = "/tmp/pi-session.jsonl";
  const cases = [
    {
      event: { type: "agent_start" } as const,
      nativeType: "agent_start",
    },
    {
      event: { type: "turn_start" } as const,
      nativeType: "turn_start",
    },
    {
      event: {
        type: "message_start",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        },
      } as const,
      nativeType: "message_start",
    },
    {
      event: {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "README.md" },
        partialResult: { progress: "halfway" },
      } as const,
      nativeType: "tool_execution_update",
    },
    {
      event: {
        type: "queue_update",
        steering: ["check logs"],
        followUp: [],
      } as const,
      nativeType: "queue_update",
    },
    {
      event: {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: "provider overloaded",
      } as const,
      nativeType: "auto_retry_start",
    },
    {
      event: {
        type: "auto_retry_end",
        success: true,
        attempt: 1,
      } as const,
      nativeType: "auto_retry_end",
    },
  ];

  for (const { event, nativeType } of cases) {
    const nativeEvents = onlyPiNativeEvents(mapPiSessionEvent(event as never, sessionFile, createPiEventMapperState()));

    assert.equal(nativeEvents.length, 1);
    assert.deepEqual(nativeEvents[0], {
      event_type: "pi_native_event",
      payload: {
        native_type: nativeType,
        native_event: JSON.parse(JSON.stringify(event)),
        event: nativeType,
        source: "pi",
        harness_session_id: sessionFile,
      },
    });
  }
});

test("mapPiSessionEvent trims cumulative partial state from message_update pi_native_event payloads", () => {
  const sessionFile = "/tmp/pi-session.jsonl";
  const nativeEvents = onlyPiNativeEvents(
    mapPiSessionEvent(
      {
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        } as never,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Hello",
          partial: {
            content: [{ type: "text", text: "Hello world" }],
          } as never,
        },
      } as never,
      sessionFile,
      createPiEventMapperState()
    )
  );

  assert.deepEqual(nativeEvents, [
    {
      event_type: "pi_native_event",
      payload: {
        native_type: "message_update",
        native_event: {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "Hello",
          },
        },
        event: "message_update",
        source: "pi",
        harness_session_id: sessionFile,
      },
    },
  ]);
});

async function createDocxBuffer(lines: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const body = lines.map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function createPptxBuffer(slides: string[]): Promise<Buffer> {
  const zip = new JSZip();
  slides.forEach((slide, index) => {
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>${slide}</a:t></p:sld>`
    );
  });
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function createXlsxBuffer(rows: string[][]): Promise<Buffer> {
  const workbook = await XlsxPopulate.fromBlankAsync();
  const worksheet = workbook.sheet(0);
  if (!worksheet) {
    throw new Error("Failed to create default workbook sheet.");
  }
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      worksheet.cell(rowIndex + 1, columnIndex + 1).value(value);
    });
  });
  const output = await workbook.outputAsync();
  if (Buffer.isBuffer(output)) {
    return output;
  }
  if (output instanceof Uint8Array) {
    return Buffer.from(output);
  }
  return Buffer.from(output);
}

function createPdfBuffer(text: string): Buffer {
  const escapedText = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT\n/F1 24 Tf\n72 120 Td\n(${escapedText}) Tj\nET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  let output = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += object;
  }
  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, "utf8");
}

test("mapPiSessionEvent maps text, thinking, tool, and completion events", () => {
  const state = createPiEventMapperState(
    new Map([
      [
        buildPiMcpToolName("workspace", "lookup"),
        {
          piToolName: buildPiMcpToolName("workspace", "lookup"),
          serverId: "workspace",
          toolId: "workspace.lookup",
          toolName: "lookup",
        },
      ],
    ]),
    new Map([
      [
        "customer_lookup",
        {
          skillId: "customer_lookup",
          skillName: "customer_lookup",
          filePath: "/tmp/workspace-1/skills/customer_lookup/SKILL.md",
          baseDir: "/tmp/workspace-1/skills/customer_lookup",
          grantedTools: [],
          grantedCommands: [],
        },
      ],
    ])
  );
  const sessionFile = "/tmp/pi-session.jsonl";

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Hello",
          partial: {} as never,
        },
      },
      sessionFile,
      state
    ),
    [
      {
        event_type: "output_delta",
        payload: {
          delta: "Hello",
          event: "message_update",
          source: "pi",
          content_index: 0,
          delta_kind: "output",
        },
      },
    ]
  );

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "message_update",
        message: {} as never,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 1,
          delta: "Need to inspect files",
          partial: {} as never,
        },
      },
      sessionFile,
      state
    ),
    [
      {
        event_type: "thinking_delta",
        payload: {
          delta: "Need to inspect files",
          event: "message_update",
          source: "pi",
          content_index: 1,
          delta_kind: "thinking",
        },
      },
    ]
  );

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic_direct",
          model: "claude-sonnet-4-6",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: "404 Not Found",
          timestamp: Date.now(),
        },
      } as never,
      sessionFile,
      createPiEventMapperState()
    ),
    [
      {
        event_type: "run_failed",
        payload: {
          type: "ProviderError",
          message: "404 Not Found",
          stop_reason: "error",
          provider: "anthropic_direct",
          model: "claude-sonnet-4-6",
          event: "message_end",
          source: "pi",
          harness_session_id: sessionFile,
        },
      },
    ]
  );

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "agent_end",
        messages: [],
      },
      sessionFile,
      {
        ...createPiEventMapperState(),
        terminalState: "failed",
      }
    ),
    []
  );

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: buildPiMcpToolName("workspace", "lookup"),
        args: { query: "hello" },
      },
      sessionFile,
      state
    ),
    [
      {
        event_type: "tool_call",
        payload: {
          phase: "started",
          tool_name: "lookup",
          tool_args: { query: "hello" },
          result: null,
          error: false,
          event: "tool_execution_start",
          source: "pi",
          call_id: "call-1",
          pi_tool_name: buildPiMcpToolName("workspace", "lookup"),
          mcp_server_id: "workspace",
          tool_id: "workspace.lookup",
        },
      },
    ]
  );

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: buildPiMcpToolName("workspace", "lookup"),
        result: { ok: true },
        isError: false,
      },
      sessionFile,
      state
    ),
    [
      {
        event_type: "tool_call",
        payload: {
          phase: "completed",
          tool_name: "lookup",
          tool_args: { query: "hello" },
          result: { ok: true },
          error: false,
          event: "tool_execution_end",
          source: "pi",
          call_id: "call-1",
          pi_tool_name: buildPiMcpToolName("workspace", "lookup"),
          mcp_server_id: "workspace",
          tool_id: "workspace.lookup",
        },
      },
    ]
  );

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "tool_execution_start",
        toolCallId: "skill-call-1",
        toolName: "skill",
        args: { name: "customer_lookup", args: "Focus on the loyalty tier section." },
      },
      sessionFile,
      state
    ),
    [
      {
        event_type: "tool_call",
        payload: {
          phase: "started",
          tool_name: "skill",
          tool_args: { name: "customer_lookup", args: "Focus on the loyalty tier section." },
          result: null,
          error: false,
          event: "tool_execution_start",
          source: "pi",
          call_id: "skill-call-1",
        },
      },
      {
        event_type: "skill_invocation",
        payload: {
          phase: "started",
          requested_name: "customer_lookup",
          skill_id: "customer_lookup",
          skill_name: "customer_lookup",
          skill_location: "/tmp/workspace-1/skills/customer_lookup/SKILL.md",
          granted_tools_expected: [],
          granted_commands_expected: [],
          args: "Focus on the loyalty tier section.",
          error: false,
          event: "tool_execution_start",
          source: "pi",
          call_id: "skill-call-1",
        },
      },
    ]
  );

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "tool_execution_end",
        toolCallId: "skill-call-1",
        toolName: "skill",
        result: {
          details: {
            skill_id: "customer_lookup",
            skill_name: "customer_lookup",
            skill_file_path: "/tmp/workspace-1/skills/customer_lookup/SKILL.md",
            policy_widening: {
              scope: "run",
              workspace_boundary_override: false,
              managed_tools: ["bash", "deploy"],
              granted_tools: ["deploy"],
              active_granted_tools: ["deploy"],
              managed_commands: ["deploy-docs"],
              granted_commands: ["deploy-docs"],
              active_granted_commands: ["deploy-docs"],
            },
          },
        },
        isError: false,
      },
      sessionFile,
      state
    ),
    [
      {
        event_type: "tool_call",
        payload: {
          phase: "completed",
          tool_name: "skill",
          tool_args: { name: "customer_lookup", args: "Focus on the loyalty tier section." },
          result: {
            details: {
              skill_id: "customer_lookup",
              skill_name: "customer_lookup",
              skill_file_path: "/tmp/workspace-1/skills/customer_lookup/SKILL.md",
              policy_widening: {
                scope: "run",
                workspace_boundary_override: false,
                managed_tools: ["bash", "deploy"],
                granted_tools: ["deploy"],
                active_granted_tools: ["deploy"],
                managed_commands: ["deploy-docs"],
                granted_commands: ["deploy-docs"],
                active_granted_commands: ["deploy-docs"],
              },
            },
          },
          error: false,
          event: "tool_execution_end",
          source: "pi",
          call_id: "skill-call-1",
        },
      },
      {
        event_type: "skill_invocation",
        payload: {
          phase: "completed",
          requested_name: "customer_lookup",
          skill_id: "customer_lookup",
          skill_name: "customer_lookup",
          skill_location: "/tmp/workspace-1/skills/customer_lookup/SKILL.md",
          widening_scope: "run",
          managed_tools: ["bash", "deploy"],
          granted_tools: ["deploy"],
          active_granted_tools: ["deploy"],
          workspace_boundary_override: false,
          managed_commands: ["deploy-docs"],
          granted_commands: ["deploy-docs"],
          active_granted_commands: ["deploy-docs"],
          args: "Focus on the loyalty tier section.",
          error: false,
          error_message: null,
          event: "tool_execution_end",
          source: "pi",
          call_id: "skill-call-1",
        },
      },
    ]
  );

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "compaction_start",
        reason: "threshold",
      },
      sessionFile,
      state
    ),
    [
      {
        event_type: "auto_compaction_start",
        payload: {
          reason: "threshold",
          event: "auto_compaction_start",
          source: "pi",
        },
      },
    ]
  );

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "compaction_end",
        reason: "threshold",
        result: {
          summary: "Kept the latest implementation details.",
          firstKeptEntryId: "entry-1",
          tokensBefore: 12345,
          details: {
            modifiedFiles: ["runtime/harness-host/src/pi.ts"],
          },
        },
        aborted: false,
        willRetry: true,
        errorMessage: undefined,
      },
      sessionFile,
      state
    ),
    [
      {
        event_type: "auto_compaction_end",
        payload: {
          result: {
            summary: "Kept the latest implementation details.",
            firstKeptEntryId: "entry-1",
            tokensBefore: 12345,
            details: {
              modifiedFiles: ["runtime/harness-host/src/pi.ts"],
            },
          },
          aborted: false,
          will_retry: true,
          error_message: null,
          event: "auto_compaction_end",
          source: "pi",
        },
      },
    ]
  );

  assert.deepEqual(
    derivedPiEvents(
      {
        type: "agent_end",
        messages: [],
      },
      sessionFile,
      state
    ),
    [
      {
        event_type: "run_completed",
        payload: {
          status: "success",
          event: "agent_end",
          source: "pi",
          harness_session_id: sessionFile,
          context_usage: null,
        },
      },
    ]
  );
});

test("createPiTodoToolDefinitions persists phased session todo state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-"));
  const stateDir = path.join(root, ".holaboss", "pi-agent");
  const [todoRead, todoWrite] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-1",
  });
  const textBlock = (result: Awaited<ReturnType<typeof todoRead.execute>>) => result.content[0] as { text: string };

  const emptyResult = await todoRead.execute("call-read-empty", {}, undefined, undefined, {} as never);
  assert.equal(textBlock(emptyResult).text, "No todo items are currently recorded for this session.");
  assert.deepEqual((emptyResult.details as { todos: unknown[] }).todos, []);

  const writeResult = await todoWrite.execute(
    "call-write",
    {
      ops: [
        {
          op: "replace",
          phases: [
            {
              name: "Investigation",
              tasks: [
                {
                  content: "Inspect todowrite wiring",
                  status: "in_progress",
                  details: "runtime/harness-host/src/pi.ts",
                },
                {
                  content: "Add tests",
                },
              ],
            },
            {
              name: "Verification",
              tasks: [
                {
                  content: "Verify session persistence",
                },
              ],
            },
          ],
        },
      ],
    },
    undefined,
    undefined,
    {} as never
  );
  assert.match(textBlock(writeResult).text, /Updated todo plan with 3 tasks across 2 phases\./);

  const rereadResult = await todoRead.execute("call-read", {}, undefined, undefined, {} as never);
  assert.deepEqual((rereadResult.details as { phases: unknown[] }).phases, [
    {
      id: "phase-1",
      name: "Investigation",
      tasks: [
        {
          id: "task-1",
          content: "Inspect todowrite wiring",
          status: "in_progress",
          details: "runtime/harness-host/src/pi.ts",
        },
        {
          id: "task-2",
          content: "Add tests",
          status: "pending",
        },
      ],
    },
    {
      id: "phase-2",
      name: "Verification",
      tasks: [
        {
          id: "task-3",
          content: "Verify session persistence",
          status: "pending",
        },
      ],
    },
  ]);
  assert.deepEqual((rereadResult.details as { todos: unknown[] }).todos, [
    { content: "Inspect todowrite wiring", status: "in_progress" },
    { content: "Add tests", status: "pending" },
    { content: "Verify session persistence", status: "pending" },
  ]);

  const persistedStatePath = path.join(stateDir, "todos", "session-1.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(persistedStatePath, "utf8")), {
    version: 2,
    session_id: "session-1",
    updated_at: (rereadResult.details as { updated_at: string }).updated_at,
    phases: [
      {
        id: "phase-1",
        name: "Investigation",
        tasks: [
          {
            id: "task-1",
            content: "Inspect todowrite wiring",
            status: "in_progress",
            details: "runtime/harness-host/src/pi.ts",
          },
          {
            id: "task-2",
            content: "Add tests",
            status: "pending",
          },
        ],
      },
      {
        id: "phase-2",
        name: "Verification",
        tasks: [
          {
            id: "task-3",
            content: "Verify session persistence",
            status: "pending",
          },
        ],
      },
    ],
    next_task_id: 4,
    next_phase_id: 3,
  });

  const [otherSessionRead] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-2",
  });
  const otherSessionResult = await otherSessionRead.execute("call-read-other", {}, undefined, undefined, {} as never);
  assert.deepEqual((otherSessionResult.details as { todos: unknown[] }).todos, []);

  await todoWrite.execute(
    "call-clear",
    {
      ops: [
        {
          op: "replace",
          phases: [],
        },
      ],
    },
    undefined,
    undefined,
    {} as never
  );
  const clearedResult = await todoRead.execute("call-read-cleared", {}, undefined, undefined, {} as never);
  assert.equal(textBlock(clearedResult).text, "No todo items are currently recorded for this session.");
  assert.deepEqual((clearedResult.details as { todos: unknown[] }).todos, []);
});

test("createPiTodoToolDefinitions applies incremental phased todo ops", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-ops-"));
  const stateDir = path.join(root, ".holaboss", "pi-agent");
  const [todoRead, todoWrite] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-1",
  });

  await todoWrite.execute(
    "call-replace",
    {
      ops: [
        {
          op: "replace",
          phases: [
            {
              name: "Implementation",
              tasks: [{ content: "Wire host todo state" }, { content: "Run host tests" }],
            },
          ],
        },
      ],
    },
    undefined,
    undefined,
    {} as never
  );

  await todoWrite.execute(
    "call-update",
    {
      ops: [
        { op: "update", id: "task-1", status: "completed" },
        { op: "add_phase", name: "Verification", tasks: [{ content: "Smoke test runtime flows" }] },
        { op: "add_task", phase: "phase-2", content: "Document the phased todo contract" },
        { op: "remove_task", id: "task-2" },
      ],
    },
    undefined,
    undefined,
    {} as never
  );

  const rereadResult = await todoRead.execute("call-read", {}, undefined, undefined, {} as never);
  assert.deepEqual((rereadResult.details as { phases: unknown[] }).phases, [
    {
      id: "phase-1",
      name: "Implementation",
      tasks: [
        {
          id: "task-1",
          content: "Wire host todo state",
          status: "completed",
        },
      ],
    },
    {
      id: "phase-2",
      name: "Verification",
      tasks: [
        {
          id: "task-3",
          content: "Smoke test runtime flows",
          status: "in_progress",
        },
        {
          id: "task-4",
          content: "Document the phased todo contract",
          status: "pending",
        },
      ],
    },
  ]);
  assert.deepEqual((rereadResult.details as { todos: unknown[] }).todos, [
    { content: "Wire host todo state", status: "completed" },
    { content: "Smoke test runtime flows", status: "in_progress" },
    { content: "Document the phased todo contract", status: "pending" },
  ]);
});

test("createPiTodoToolDefinitions preserves blocked tasks without auto-promoting later pending work", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-blocked-"));
  const stateDir = path.join(root, ".holaboss", "pi-agent");
  const [todoRead, todoWrite] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-1",
  });

  await todoWrite.execute(
    "call-replace",
    {
      ops: [
        {
          op: "replace",
          phases: [
            {
              name: "Implementation",
              tasks: [
                { content: "Wait for approval" },
                { content: "Continue after approval" },
              ],
            },
          ],
        },
      ],
    },
    undefined,
    undefined,
    {} as never
  );

  await todoWrite.execute(
    "call-block",
    {
      ops: [
        {
          op: "update",
          id: "task-1",
          status: "blocked",
          details: "Blocked waiting for approval.",
        },
      ],
    },
    undefined,
    undefined,
    {} as never
  );

  const rereadResult = await todoRead.execute("call-read", {}, undefined, undefined, {} as never);
  assert.deepEqual((rereadResult.details as { phases: unknown[] }).phases, [
    {
      id: "phase-1",
      name: "Implementation",
      tasks: [
        {
          id: "task-1",
          content: "Wait for approval",
          status: "blocked",
          details: "Blocked waiting for approval.",
        },
        {
          id: "task-2",
          content: "Continue after approval",
          status: "pending",
        },
      ],
    },
  ]);
});

test("createPiTodoToolDefinitions rejects legacy todo payload aliases", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-invalid-"));
  const stateDir = path.join(root, ".holaboss", "pi-agent");
  const [, todoWrite] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-1",
  });

  await assert.rejects(
    () =>
      todoWrite.execute(
        "call-invalid",
        {
          ops: [
            {
              op: "replace",
              phases: [
                {
                  title: "Implementation",
                  tasks: [{ title: "Wire host todo state" }],
                },
              ],
            },
          ],
        },
        undefined,
        undefined,
        {} as never
      ),
    /Todo phases require `name`; use `name` instead of `title`\./
  );
});

test("createPiTodoToolDefinitions returns repair guidance for hallucinated todo ops", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-repair-"));
  const stateDir = path.join(root, ".holaboss", "pi-agent");
  const [, todoWrite] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-1",
  });

  await assert.rejects(
    () =>
      todoWrite.execute(
        "call-invalid-set-status",
        {
          ops: [{ op: "set_status", id: "task-1", status: "completed" }],
        },
        undefined,
        undefined,
        {} as never
      ),
    /Unsupported todo op "set_status".*Use `update` to change an existing task's status by task id.*Call `todoread` first if you need the current task ids\./is
  );

  await assert.rejects(
    () =>
      todoWrite.execute(
        "call-invalid-update-task",
        {
          ops: [{ op: "update_task", id: "task-1", status: "completed" }],
        },
        undefined,
        undefined,
        {} as never
      ),
    /Unsupported todo op "update_task".*Use `update` to change an existing task's status by task id\./is
  );

  await assert.rejects(
    () =>
      todoWrite.execute(
        "call-invalid-replace-all",
        {
          ops: [
            {
              op: "replace_all",
              phases: [{ name: "Implementation", tasks: [{ content: "Wire host todo state" }] }],
            },
          ],
        },
        undefined,
        undefined,
        {} as never
      ),
    /Unsupported todo op "replace_all".*Use `replace` to replace the entire phased plan\./is
  );
});

test("createPiTodoToolDefinitions exposes explicit todo op guidance to the model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-todo-prompting-"));
  const stateDir = path.join(root, ".holaboss", "pi-agent");
  const [todoRead, todoWrite] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-1",
  });

  assert.match(
    todoRead.description ?? "",
    /phase ids and task ids needed for later `todowrite` calls/i
  );
  assert.match(
    todoRead.promptSnippet ?? "",
    /recover the phase\/task ids needed for later `todowrite` mutations/i
  );
  assert.match(
    (todoRead.promptGuidelines ?? []).join("\n"),
    /recover the exact phase ids and task ids before calling `update`, `add_task`, or `remove_task`/i
  );

  assert.match(
    todoWrite.description ?? "",
    /Valid `op` values are exactly `replace`, `add_phase`, `add_task`, `update`, and `remove_task`/i
  );
  assert.match(
    todoWrite.promptSnippet ?? "",
    /using only these `op` values: `replace`, `add_phase`, `add_task`, `update`, and `remove_task`/i
  );
  const todoWriteGuidelines = (todoWrite.promptGuidelines ?? []).join("\n");
  assert.match(
    todoWriteGuidelines,
    /Do not invent alias op names such as `replace_all`, `update_task`, or `set_status`/i
  );
  assert.match(
    todoWriteGuidelines,
    /Use `name` for phase titles and `content` for task text; do not use `title` for either/i
  );

  const todoWriteSchema = todoWrite.parameters as Record<string, unknown>;
  const opsSchema = (todoWriteSchema.properties as { ops: { description?: string; items?: { anyOf?: Array<Record<string, unknown>> } } }).ops;
  assert.match(
    opsSchema.description ?? "",
    /Valid `op` values are exactly `replace`, `add_phase`, `add_task`, `update`, and `remove_task`/i
  );
  assert.match(opsSchema.description ?? "", /Use `name` for phase titles and `content` for task text/i);
  const updateSchema = opsSchema.items?.anyOf?.find(
    (entry) => ((entry.properties as Record<string, unknown> | undefined)?.op as { const?: string } | undefined)?.const === "update"
  );
  assert.match(
    (updateSchema?.description as string | undefined) ?? "",
    /Use this for status changes, content edits, notes, or details/i
  );
  const fallbackSchema = opsSchema.items?.anyOf?.find(
    (entry) => (entry.description as string | undefined)?.includes("Fallback validation branch")
  );
  assert.ok(fallbackSchema);
});

test("buildPiMcpServerBindings converts remote and local MCP payloads into mcporter definitions", () => {
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    mcp_servers: [
      {
        name: "remote-server",
        config: {
          type: "remote",
          enabled: true,
          url: "http://127.0.0.1:8765/mcp",
          headers: { Authorization: "Bearer token" },
          timeout: 15000,
        },
      },
      {
        name: "local-server",
        config: {
          type: "local",
          enabled: true,
          command: ["node", "server.js", "--stdio"],
          environment: { API_KEY: "token-1" },
          timeout: 9000,
        },
      },
    ],
  };

  const bindings = buildPiMcpServerBindings(request);

  assert.deepEqual(bindings, [
    {
      serverId: "remote-server",
      timeoutMs: 15000,
      definition: {
        name: "remote-server",
        description: "Holaboss MCP server remote-server",
        command: {
          kind: "http",
          url: new URL("http://127.0.0.1:8765/mcp"),
          headers: { Authorization: "Bearer token" },
        },
      },
    },
    {
      serverId: "local-server",
      timeoutMs: 9000,
      definition: {
        name: "local-server",
        description: "Holaboss MCP server local-server",
        command: {
          kind: "stdio",
          command: "node",
          args: ["server.js", "--stdio"],
          cwd: "/tmp/workspace-1",
        },
        env: { API_KEY: "token-1" },
      },
    },
  ]);
});

test("resolvePiSkillDirs returns existing source skill directories in order", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-skills-workspace-"));
  const emptyEmbeddedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-skills-empty-"));
  const skillAlphaDir = path.join(workspaceDir, "skills", "alpha");
  const skillBetaDir = path.join(workspaceDir, "skills", "beta");
  fs.mkdirSync(skillAlphaDir, { recursive: true });
  fs.mkdirSync(skillBetaDir, { recursive: true });
  const previousEmbeddedSkillsDir = process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    workspace_dir: workspaceDir,
    workspace_skill_dirs: [
      skillAlphaDir,
      skillAlphaDir,
      path.join(workspaceDir, "skills", "missing"),
      skillBetaDir,
    ],
  };

  try {
    process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = emptyEmbeddedRoot;
    assert.deepEqual(resolvePiSkillDirs(request), [
      fs.realpathSync(skillAlphaDir),
      fs.realpathSync(skillBetaDir),
    ]);
  } finally {
    if (previousEmbeddedSkillsDir === undefined) {
      delete process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
    } else {
      process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = previousEmbeddedSkillsDir;
    }
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(emptyEmbeddedRoot, { recursive: true, force: true });
  }
});

test("resolvePiSkillDirs does not auto-prepend embedded skill directories when the request omits them", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-skills-workspace-"));
  const embeddedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-embedded-skills-"));
  const skillAlphaDir = path.join(workspaceDir, "skills", "alpha");
  fs.mkdirSync(skillAlphaDir, { recursive: true });
  const previousEmbeddedSkillsDir = process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    workspace_dir: workspaceDir,
    workspace_skill_dirs: [skillAlphaDir],
  };

  try {
    fs.mkdirSync(path.join(embeddedRoot, "skill-creator"), { recursive: true });
    fs.mkdirSync(path.join(embeddedRoot, "skill-installer"), { recursive: true });
    fs.writeFileSync(
      path.join(embeddedRoot, "skill-creator", "SKILL.md"),
      "---\nname: skill-creator\ndescription: Skill creator\n---\n# Skill Creator\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(embeddedRoot, "skill-installer", "SKILL.md"),
      "---\nname: skill-installer\ndescription: Skill installer\n---\n# Skill Installer\n",
      "utf8",
    );
    process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedRoot;
    assert.deepEqual(
      resolvePiSkillDirs(request).map((skillDir) => path.basename(skillDir)),
      ["alpha"],
    );
  } finally {
    if (previousEmbeddedSkillsDir === undefined) {
      delete process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
    } else {
      process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = previousEmbeddedSkillsDir;
    }
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(embeddedRoot, { recursive: true, force: true });
  }
});

test("resolvePiSkillDirs discovers workspace skill directories created after the request snapshot", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-skills-workspace-"));
  const emptyEmbeddedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-skills-empty-"));
  const skillAlphaDir = path.join(workspaceDir, "skills", "alpha");
  const skillBetaDir = path.join(workspaceDir, "skills", "beta");
  fs.mkdirSync(skillAlphaDir, { recursive: true });
  fs.mkdirSync(skillBetaDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillAlphaDir, "SKILL.md"),
    "---\nname: alpha\ndescription: Alpha skill\n---\n# Alpha\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(skillBetaDir, "SKILL.md"),
    "---\nname: beta\ndescription: Beta skill\n---\n# Beta\n",
    "utf8",
  );
  const previousEmbeddedSkillsDir = process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    workspace_dir: workspaceDir,
    workspace_skill_dirs: [skillAlphaDir],
  };

  try {
    process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = emptyEmbeddedRoot;
    assert.deepEqual(
      resolvePiSkillDirs(request).map((skillDir) => path.basename(skillDir)),
      ["alpha", "beta"],
    );
  } finally {
    if (previousEmbeddedSkillsDir === undefined) {
      delete process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
    } else {
      process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = previousEmbeddedSkillsDir;
    }
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(emptyEmbeddedRoot, { recursive: true, force: true });
  }
});

test("buildPiPromptPayload resolves quoted embedded skills only when the request explicitly grants the skill dir", async () => {
  const embeddedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-embedded-quoted-skills-"));
  const previousEmbeddedSkillsDir = process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
  const skillCreatorDir = path.join(embeddedRoot, "skill-creator");

  try {
    fs.mkdirSync(skillCreatorDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillCreatorDir, "SKILL.md"),
      "---\nname: skill-creator\ndescription: Skill creator\n---\n# Skill Creator\nUse the canonical skill format.\n",
      "utf8",
    );
    process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = embeddedRoot;

    const prompt = await buildPiPromptPayload({
      ...baseRequest(),
      instruction: ["/skill-creator", "", "Use it to define the new skill."].join("\n"),
      workspace_skill_dirs: [skillCreatorDir],
    });

    assert.match(prompt.text, /Quoted workspace skills:/);
    assert.match(prompt.text, /<skill name="skill-creator"/);
    assert.match(prompt.text, /Use the canonical skill format\./);
    assert.match(prompt.text, /Use it to define the new skill\./);
  } finally {
    if (previousEmbeddedSkillsDir === undefined) {
      delete process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
    } else {
      process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = previousEmbeddedSkillsDir;
    }
    fs.rmSync(embeddedRoot, { recursive: true, force: true });
  }
});

test("createPiSkillToolDefinition refreshes the skill catalog before invocation", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-dynamic-skill-tool-"));
  const emptyEmbeddedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-dynamic-skill-tool-empty-"));
  const skillDirs: string[] = [];
  const skillMetadataByAlias = new Map<string, {
    skillId: string;
    skillName: string;
    filePath: string;
    baseDir: string;
    grantedTools: string[];
    grantedCommands: string[];
  }>();
  const skillWideningState = createHarnessSkillWideningState(
    skillMetadataByAlias,
    ["bash", "read", "skill"],
    [],
  );
  const previousEmbeddedSkillsDir = process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;

  try {
    process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = emptyEmbeddedRoot;
    const tool = createPiSkillToolDefinition(
      skillMetadataByAlias,
      skillWideningState,
      false,
      {
        refreshCatalog: () =>
          refreshPiSkillCatalog({
            skillDirs,
            skillMetadataByAlias,
            skillWideningState,
            availableToolNames: ["bash", "read", "skill"],
            availableCommandIds: [],
          }),
      },
    );

    const jokeMakingDir = path.join(workspaceDir, "skills", "joke-making");
    fs.mkdirSync(jokeMakingDir, { recursive: true });
    fs.writeFileSync(
      path.join(jokeMakingDir, "SKILL.md"),
      [
        "---",
        "name: joke-making",
        "description: Generate jokes.",
        "holaboss_granted_tools: [bash]",
        "---",
        "# Joke Making",
        "",
        "Create jokes in different tones without becoming cruel.",
        "",
      ].join("\n"),
      "utf8",
    );
    skillDirs.push(jokeMakingDir);

    const result = await tool.execute(
      "call-1",
      {
        name: "joke-making",
        args: "Discovery check only.",
      },
      undefined,
      undefined,
      {} as never,
    );
    const textBlock = result.content.find((block) => block.type === "text");
    assert.equal(typeof textBlock?.text, "string");
    assert.match(String(textBlock?.text), /<skill name="joke-making"/);
    assert.match(String(textBlock?.text), /Discovery check only\./);
    assert.deepEqual(
      [...new Set([...skillMetadataByAlias.values()].map((metadata) => metadata.skillId))].sort(),
      ["joke-making"],
    );
    const details = result.details as {
      policy_widening?: {
        granted_tools?: string[];
        active_granted_tools?: string[];
      };
    };
    assert.deepEqual(details.policy_widening?.granted_tools, ["bash"]);
    assert.deepEqual(details.policy_widening?.active_granted_tools, ["bash"]);
  } finally {
    if (previousEmbeddedSkillsDir === undefined) {
      delete process.env.HOLABOSS_EMBEDDED_SKILLS_DIR;
    } else {
      process.env.HOLABOSS_EMBEDDED_SKILLS_DIR = previousEmbeddedSkillsDir;
    }
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(emptyEmbeddedRoot, { recursive: true, force: true });
  }
});

test("workspaceBoundaryOverrideRequested requires explicit insist signal", () => {
  assert.equal(workspaceBoundaryOverrideRequested("Read ./README.md"), false);
  assert.equal(
    workspaceBoundaryOverrideRequested("I insist you access files outside workspace boundary to compare ../other-repo"),
    true
  );
  assert.equal(
    workspaceBoundaryOverrideRequested("workspace_boundary_override=true please inspect /Users/shared/reference.md"),
    true
  );
});

test("workspaceBoundaryViolationForToolCall blocks outside-workspace paths and allows override", () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-workspace-boundary-"));
  const policy = {
    workspaceDir,
    workspaceRealDir: fs.realpathSync(workspaceDir),
    overrideRequested: false,
    allowedExternalDirs: [],
  };
  const overridePolicy = { ...policy, overrideRequested: true };

  try {
    assert.match(
      String(
        workspaceBoundaryViolationForToolCall({
          toolName: "read",
          toolParams: { path: "../outside.txt" },
          policy,
        })
      ),
      /outside workspace/i
    );
    assert.match(
      String(
        workspaceBoundaryViolationForToolCall({
          toolName: "bash",
          toolParams: { command: "cd ../other && ls" },
          policy,
        })
      ),
      /outside workspace|outside-workspace|external directory/i
    );
    assert.equal(
      workspaceBoundaryViolationForToolCall({
        toolName: "read",
        toolParams: { path: "../outside.txt" },
        policy: overridePolicy,
      }),
      null
    );
    assert.equal(
      workspaceBoundaryViolationForToolCall({
        toolName: "mcp__twitter__create_post",
        toolParams: { path: "/v1/posts" },
        policy,
      }),
      null
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("buildPiProviderConfig registers runtime-configured ollama models for the Pi harness", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-model-registry-"));
  try {
    const request: HarnessHostPiRequest = {
      ...baseRequest(),
      provider_id: "ollama_direct",
      model_id: "qwen2.5:0.5b",
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "ollama",
        base_url: "http://localhost:11434/v1",
        default_headers: {
          Authorization: "Bearer ollama",
        },
      },
    };

    const authStorage = AuthStorage.create(path.join(stateDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(
      authStorage,
      path.join(stateDir, "models.json"),
    );
    modelRegistry.registerProvider(request.provider_id, buildPiProviderConfig(request));

    const model = modelRegistry.find("ollama_direct", "qwen2.5:0.5b");
    assert.ok(model);
    assert.equal(model.provider, "ollama_direct");
    assert.equal(model.id, "qwen2.5:0.5b");
    assert.equal(model.api, "openai-completions");
    assert.equal(model.baseUrl, "http://localhost:11434/v1");
    assert.deepEqual(model.compat, {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("buildPiProviderConfig preserves direct OpenRouter endpoints and headers", () => {
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    provider_id: "openrouter_direct",
    model_id: "openai/gpt-5.4",
    model_client: {
      model_proxy_provider: "openai_compatible",
      api_key: "sk-or-test",
      base_url: "https://openrouter.ai/api/v1",
      default_headers: {
        "HTTP-Referer": "https://holaboss.ai",
        "X-OpenRouter-Title": "holaOS",
        "X-OpenRouter-Categories": "personal-agent,general-chat",
      },
    },
  };

  const providerConfig = buildPiProviderConfig(request);

  assert.equal(providerConfig.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(providerConfig.apiKey, "sk-or-test");
  assert.equal(providerConfig.api, "openai-completions");
  assert.deepEqual(providerConfig.headers, {
    "HTTP-Referer": "https://holaboss.ai",
    "X-OpenRouter-Title": "holaOS",
    "X-OpenRouter-Categories": "personal-agent,general-chat",
  });
  assert.equal(providerConfig.authHeader, true);
  assert.equal(providerConfig.models[0]?.id, "openai/gpt-5.4");
  assert.equal(providerConfig.models[0]?.api, "openai-completions");
  assert.equal(providerConfig.models[0]?.contextWindow, 1_050_000);
  assert.equal(providerConfig.models[0]?.maxTokens, 128_000);
  assert.equal(providerConfig.models[0]?.compat, undefined);
});

test("buildPiProviderConfig uses OpenAI Responses API for direct GPT-5 models", () => {
  const providerConfig = buildPiProviderConfig({
    ...baseRequest(),
    provider_id: "openai_direct",
    model_id: "gpt-5.4",
    model_client: {
      model_proxy_provider: "openai_compatible",
      api_key: "sk-openai-test",
      base_url: "https://api.openai.com/v1",
    },
  });

  assert.equal(providerConfig.api, "openai-responses");
  assert.equal(providerConfig.models[0]?.api, "openai-responses");
  assert.equal(providerConfig.models[0]?.contextWindow, 1_050_000);
  assert.equal(providerConfig.models[0]?.maxTokens, 128_000);
  assert.equal(providerConfig.models[0]?.compat, undefined);
});

test("buildPiProviderConfig uses OpenAI Codex Responses API for Codex OAuth GPT-5 models", () => {
  const providerConfig = buildPiProviderConfig({
    ...baseRequest(),
    provider_id: "openai_codex",
    model_id: "gpt-5.4",
    model_client: {
      model_proxy_provider: "openai_compatible",
      api_key: "codex-access-token",
      base_url: "https://chatgpt.com/backend-api/codex",
    },
  });

  assert.equal(providerConfig.api, "openai-codex-responses");
  assert.equal(providerConfig.baseUrl, "https://chatgpt.com/backend-api/codex");
  assert.equal(providerConfig.models[0]?.api, "openai-codex-responses");
});

test("buildPiProviderConfig uses OpenAI Responses API for managed Holaboss GPT-5 models", () => {
  const providerConfig = buildPiProviderConfig({
    ...baseRequest(),
    provider_id: "holaboss_model_proxy",
    model_id: "gpt-5.4",
    model_client: {
      model_proxy_provider: "openai_compatible",
      api_key: "hbmk-test",
      base_url: "http://127.0.0.1:3060/api/v1/model-proxy/openai/v1",
      default_headers: {
        "X-Holaboss-User-Id": "user-1",
      },
    },
  });

  assert.equal(providerConfig.api, "openai-responses");
  assert.equal(providerConfig.models[0]?.api, "openai-responses");
  assert.deepEqual(providerConfig.headers, {
    "X-Holaboss-User-Id": "user-1",
  });
  assert.deepEqual(providerConfig.models[0]?.cost, {
    input: 2.5,
    output: 15,
    cacheRead: 0.25,
    cacheWrite: 0,
  });
  assert.equal(providerConfig.models[0]?.contextWindow, 1_050_000);
  assert.equal(providerConfig.models[0]?.maxTokens, 128_000);
});

test("pi compaction reserves 30 percent of the model context window", () => {
  assert.equal(piCompactionReserveTokens(1_050_000), 315_000);
  assert.equal(piCompactionReserveTokens(65_536), 19_661);
  assert.equal(piCompactionReserveTokens(65_535), 19_661);
  assert.equal(piCompactionReserveTokens(0), 0);
});

test("buildPiProviderConfig preserves catalog pricing after runtime provider registration", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-pricing-registry-"));

  try {
    const request: HarnessHostPiRequest = {
      ...baseRequest(),
      provider_id: "holaboss_model_proxy",
      model_id: "gpt-5.4",
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "hbmk-test",
        base_url: "http://127.0.0.1:3060/api/v1/model-proxy/openai/v1",
      },
    };

    const authStorage = AuthStorage.create(path.join(stateDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(
      authStorage,
      path.join(stateDir, "models.json"),
    );
    modelRegistry.registerProvider(request.provider_id, buildPiProviderConfig(request));

    const model = modelRegistry.find("holaboss_model_proxy", "gpt-5.4");
    assert.ok(model);
    assert.deepEqual(model.cost, {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("OpenAI Responses proxy routes request prompt cache retention and stable cache keys", async () => {
  const previousCacheRetention = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = "long";

  try {
    const providerConfig = buildPiProviderConfig({
      ...baseRequest(),
      provider_id: "holaboss_model_proxy",
      model_id: "gpt-5.4",
      model_client: {
        model_proxy_provider: "openai_compatible",
        api_key: "hbmk-test",
        base_url: "http://127.0.0.1:3060/api/v1/model-proxy/openai/v1",
      },
    });
    const templateModel = providerConfig.models[0];
    assert.ok(templateModel);
    const model: Model<"openai-responses"> = {
      ...templateModel,
      api: "openai-responses",
      provider: "holaboss_model_proxy",
      baseUrl: providerConfig.baseUrl,
      headers: providerConfig.headers,
    };

    const payload = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out capturing OpenAI Responses payload")), 1000);
      streamOpenAIResponses(
        model,
        {
          messages: [
            {
              role: "user",
              content: "hello",
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: "hbmk-test",
          sessionId: "session-1",
          onPayload: async (params) => {
            clearTimeout(timeout);
            resolve(params as Record<string, unknown>);
            throw new Error("stop after payload capture");
          },
        },
      );
    });

    assert.equal(payload.prompt_cache_key, "session-1");
    assert.equal(payload.prompt_cache_retention, "24h");
  } finally {
    if (previousCacheRetention === undefined) {
      delete process.env.PI_CACHE_RETENTION;
    } else {
      process.env.PI_CACHE_RETENTION = previousCacheRetention;
    }
  }
});

test("buildPiProviderConfig uses Anthropic Messages API for managed Holaboss Claude models", () => {
  const providerConfig = buildPiProviderConfig({
    ...baseRequest(),
    provider_id: "holaboss_model_proxy",
    model_id: "claude-sonnet-4-6",
    model_client: {
      model_proxy_provider: "anthropic_native",
      api_key: "hbmk-test",
      base_url: "http://127.0.0.1:3060/api/v1/model-proxy/anthropic/v1",
      default_headers: {
        "X-Holaboss-User-Id": "user-1",
      },
    },
  });

  assert.equal(providerConfig.api, "anthropic-messages");
  assert.equal(providerConfig.baseUrl, "http://127.0.0.1:3060/api/v1/model-proxy/anthropic");
  assert.equal(providerConfig.models[0]?.api, "anthropic-messages");
  assert.deepEqual(providerConfig.headers, {
    "X-Holaboss-User-Id": "user-1",
  });
  assert.equal(providerConfig.models[0]?.contextWindow, 1_000_000);
  assert.equal(providerConfig.models[0]?.maxTokens, 64_000);
});

test("requestedPiThinkingLevel maps provider-native values into Pi thinking levels", () => {
  assert.equal(requestedPiThinkingLevel({ thinking_value: "none" }), "off");
  assert.equal(requestedPiThinkingLevel({ thinking_value: "minimal" }), "minimal");
  assert.equal(requestedPiThinkingLevel({ thinking_value: "8192" }), "medium");
  assert.equal(requestedPiThinkingLevel({ thinking_value: "32768" }), "high");
  assert.equal(requestedPiThinkingLevel({ thinking_value: "-1" }), "high");
  assert.equal(requestedPiThinkingLevel({ thinking_value: "max" }), "xhigh");
  assert.equal(requestedPiThinkingLevel({ thinking_value: null }), null);
});

test("requestedPiThinkingConfig preserves provider-native numeric budgets", () => {
  assert.deepEqual(requestedPiThinkingConfig({ thinking_value: "-1" }), {
    rawValue: "-1",
    level: "high",
    thinkingBudgets: { high: -1 },
  });
  assert.deepEqual(requestedPiThinkingConfig({ thinking_value: "24576" }), {
    rawValue: "24576",
    level: "high",
    thinkingBudgets: { high: 24576 },
  });
  assert.deepEqual(requestedPiThinkingBudgets({ thinking_value: "128" }), {
    minimal: 128,
  });
});

test("buildPiProviderConfig enables reasoning only when a thinking value is requested", () => {
  const withoutThinking = buildPiProviderConfig(baseRequest());
  const withThinking = buildPiProviderConfig({
    ...baseRequest(),
    thinking_value: "medium",
  });

  assert.equal(withoutThinking.models[0]?.reasoning, false);
  assert.equal(withThinking.models[0]?.reasoning, true);
});

test("buildPiProviderConfig preserves provider-native reasoning labels for generic OpenAI-compatible routes", () => {
  const providerConfig = buildPiProviderConfig({
    ...baseRequest(),
    provider_id: "custom_openai_compat",
    model_id: "custom-reasoner",
    model_client: {
      model_proxy_provider: "openai_compatible",
      api_key: "custom-key",
      base_url: "https://api.example.com/v1",
    },
    thinking_value: "default",
  });

  assert.equal(providerConfig.api, "openai-completions");
  assert.deepEqual(providerConfig.models[0]?.compat?.reasoningEffortMap, {
    low: "default",
  });
});

test("buildPiProviderConfig uses pi-ai native Google provider for direct Gemini models", () => {
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    provider_id: "gemini_direct",
    model_id: "gemini-2.5-flash",
    model_client: {
      model_proxy_provider: "google_compatible",
      api_key: "gemini-test-key",
      base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    },
  };

  const providerConfig = buildPiProviderConfig(request);

  assert.equal(providerConfig.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(providerConfig.api, "google-generative-ai");
  assert.equal(providerConfig.authHeader, false);
  assert.equal(providerConfig.models[0]?.api, "google-generative-ai");
  assert.equal(providerConfig.models[0]?.contextWindow, 1_048_576);
  assert.equal(providerConfig.models[0]?.maxTokens, 65_536);
  assert.equal(providerConfig.models[0]?.compat, undefined);
});

test("buildPiProviderConfig disables store for Google-compatible proxy routes", () => {
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    provider_id: "openai",
    model_id: "gemini-2.5-flash",
    model_client: {
      model_proxy_provider: "google_compatible",
      api_key: "hbmk-test-key",
      base_url: "http://127.0.0.1:3060/api/v1/model-proxy/google/v1",
    },
  };

  const providerConfig = buildPiProviderConfig(request);

  assert.equal(providerConfig.baseUrl, "http://127.0.0.1:3060/api/v1/model-proxy/google/v1");
  assert.equal(providerConfig.api, "openai-completions");
  assert.deepEqual(providerConfig.models[0]?.compat, {
    supportsStore: false,
  });
});

test("buildPiProviderConfig falls back to legacy limits for unknown custom models", () => {
  const providerConfig = buildPiProviderConfig({
    ...baseRequest(),
    provider_id: "custom_openai_compat",
    model_id: "custom-reasoner",
    model_client: {
      model_proxy_provider: "openai_compatible",
      api_key: "custom-key",
      base_url: "https://api.example.com/v1",
    },
  });

  assert.equal(providerConfig.models[0]?.contextWindow, 65_536);
  assert.equal(providerConfig.models[0]?.maxTokens, 8_192);
});

test("createPiMcpCustomTools filters discovery to allowlisted tools and forwards calls via mcporter", async () => {
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    mcp_servers: [
      {
        name: "workspace",
        config: {
          type: "remote",
          enabled: true,
          url: "http://127.0.0.1:7000/mcp",
          timeout: 12000,
        },
      },
    ],
    mcp_tool_refs: [
      {
        tool_id: "workspace.lookup",
        server_id: "workspace",
        tool_name: "lookup",
      },
    ],
  };
  const calls: Array<{ server: string; toolName: string; args: Record<string, unknown> | undefined }> = [];
  const runtime = {
    listTools: async () => [
      {
        name: "lookup",
        description: "Look something up",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      },
      {
        name: "write_back",
        description: "Should not be exposed",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
    callTool: async (server: string, toolName: string, options?: { args?: Record<string, unknown> }) => {
      calls.push({ server, toolName, args: options?.args });
      return {
        structuredContent: {
          ok: true,
          echo: options?.args,
        },
      };
    },
  };

  const bindings = buildPiMcpServerBindings(request);
  const toolset = await createPiMcpCustomTools(request, runtime as never, bindings);

  assert.equal(toolset.customTools.length, 1);
  assert.equal(toolset.customTools[0]?.name, buildPiMcpToolName("workspace", "lookup"));
  assert.deepEqual(Array.from(toolset.mcpToolMetadata.values()), [
    {
      piToolName: buildPiMcpToolName("workspace", "lookup"),
      serverId: "workspace",
      toolId: "workspace.lookup",
      toolName: "lookup",
    },
  ]);

  const result = await toolset.customTools[0]!.execute(
    "call-1",
    { query: "hello" } as never,
    undefined,
    undefined,
    {} as never
  );

  assert.deepEqual(calls, [
    {
      server: "workspace",
      toolName: "lookup",
      args: { query: "hello" },
    },
  ]);
  assert.equal(result.content[0]?.type, "text");
  assert.match(String((result.content[0] as { text: string }).text), /"ok": true/);
});

test("createPiMcpCustomTools exposes all discovered tools when no MCP allowlist is provided", async () => {
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    mcp_servers: [
      {
        name: "context7",
        config: {
          type: "remote",
          enabled: true,
          url: "https://mcp.context7.com/mcp",
          timeout: 12000,
        },
      },
    ],
    mcp_tool_refs: [],
  };

  const runtime = {
    listTools: async () => [
      {
        name: "lookup",
        description: "Look something up",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "search",
        description: "Search docs",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    callTool: async () => ({ structuredContent: { ok: true } }),
  };

  const bindings = buildPiMcpServerBindings(request);
  const toolset = await createPiMcpCustomTools(request, runtime as never, bindings);

  assert.equal(toolset.customTools.length, 2);
  assert.deepEqual(
    Array.from(toolset.mcpToolMetadata.values()).map((metadata) => metadata.toolId).sort(),
    ["context7.lookup", "context7.search"]
  );
});

test("createPiMcpCustomTools keeps unrestricted discovery for servers without explicit tool refs even when other servers are allowlisted", async () => {
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    mcp_servers: [
      {
        name: "gmail",
        config: {
          type: "remote",
          enabled: true,
          url: "http://127.0.0.1:7000/mcp",
          timeout: 12000,
        },
      },
      {
        name: "context7",
        config: {
          type: "remote",
          enabled: true,
          url: "https://mcp.context7.com/mcp",
          timeout: 12000,
        },
      },
    ],
    mcp_tool_refs: [
      {
        tool_id: "gmail.gmail_search",
        server_id: "gmail",
        tool_name: "gmail_search",
      },
    ],
  };

  const runtime = {
    listTools: async (serverId: string) => {
      if (serverId === "gmail") {
        return [
          {
            name: "gmail_search",
            description: "Search Gmail",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "gmail_delete_thread",
            description: "Should not be exposed",
            inputSchema: { type: "object", properties: {} },
          },
        ];
      }
      return [
        {
          name: "lookup",
          description: "Look something up",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "search",
          description: "Search docs",
          inputSchema: { type: "object", properties: {} },
        },
      ];
    },
    callTool: async () => ({ structuredContent: { ok: true } }),
  };

  const toolset = await createPiMcpCustomTools(request, runtime as never, buildPiMcpServerBindings(request));

  assert.deepEqual(
    toolset.customTools.map((tool) => tool.name).sort(),
    [
      buildPiMcpToolName("context7", "lookup"),
      buildPiMcpToolName("context7", "search"),
      buildPiMcpToolName("gmail", "gmail_search"),
    ]
  );
  assert.deepEqual(
    Array.from(toolset.mcpToolMetadata.values()).map((metadata) => metadata.toolId).sort(),
    ["context7.lookup", "context7.search", "gmail.gmail_search"]
  );
});

test("createPiMcpCustomTools retries discovery until allowlisted MCP tools appear", async () => {
  const request: HarnessHostPiRequest = {
    ...baseRequest(),
    mcp_servers: [
      {
        name: "twitter",
        config: {
          type: "remote",
          enabled: true,
          url: "http://127.0.0.1:7001/mcp",
          timeout: 5000,
        },
      },
    ],
    mcp_tool_refs: [
      {
        tool_id: "twitter.twitter_create_post",
        server_id: "twitter",
        tool_name: "twitter_create_post",
      },
    ],
  };

  let listCalls = 0;
  const runtime = {
    listTools: async () => {
      listCalls += 1;
      if (listCalls === 1) {
        return [];
      }
      return [
        {
          name: "twitter_create_post",
          description: "Create a post",
          inputSchema: {
            type: "object",
            properties: {
              content: { type: "string" },
            },
          },
        },
      ];
    },
    callTool: async () => ({ content: [{ type: "text", text: "{\"ok\":true}" }] }),
  };

  const toolset = await createPiMcpCustomTools(request, runtime as never, buildPiMcpServerBindings(request));

  assert.equal(toolset.customTools.length, 1);
  assert.equal(listCalls, 2);
  assert.deepEqual(Array.from(toolset.mcpToolMetadata.values()), [
    {
      piToolName: buildPiMcpToolName("twitter", "twitter_create_post"),
      serverId: "twitter",
      toolId: "twitter.twitter_create_post",
      toolName: "twitter_create_post",
    },
  ]);
});

test("runPi emits run_started and terminal success when the session completes", async () => {
  const request = baseRequest();
  const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  let sentContent: unknown;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const fakeSession = {
    subscribe(listener: (event: unknown) => void) {
      this.listener = listener;
      return () => {};
    },
    async sendUserMessage(content: unknown) {
      sentContent = content;
      this.listener?.({
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Done",
          partial: {},
        },
      });
      this.listener?.({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          api: "openai-responses",
          provider: "holaboss_model_proxy",
          model: "gpt-5.4",
          usage: {
            input: 120,
            output: 40,
            cacheRead: 80,
            cacheWrite: 12,
            totalTokens: 252,
            cost: {
              input: 0.3,
              output: 0.6,
              cacheRead: 0.02,
              cacheWrite: 0,
              total: 0.92,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
      this.listener?.({
        type: "compaction_start",
        reason: "threshold",
      });
      this.listener?.({
        type: "compaction_end",
        reason: "threshold",
        result: {
          summary: "Compacted older context.",
          firstKeptEntryId: "entry-1",
          tokensBefore: 1234,
        },
        aborted: false,
        willRetry: false,
      });
      this.listener?.({
        type: "agent_end",
        messages: [],
      });
    },
    async abort() {},
    dispose() {},
    listener: undefined as ((event: unknown) => void) | undefined,
  };

  process.stdout.write = ((chunk: string | Uint8Array) => {
    const lines = String(chunk)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event_type: string; payload: Record<string, unknown> });
    events.push(...lines);
    return true;
  }) as typeof process.stdout.write;

  try {
    const exitCode = await runPi(request, {
      createSession: async () => ({
        session: fakeSession as never,
        sessionFile: "/tmp/pi-session.jsonl",
        mcpToolMetadata: new Map(),
        skillMetadataByAlias: new Map(),
        dispose: async () => {},
      }),
    });

    assert.equal(exitCode, 0);
    const derivedEvents = withoutPiNativeEvents(events);
    assert.deepEqual(
      derivedEvents.map((event) => event.event_type),
      ["run_started", "output_delta", "auto_compaction_start", "auto_compaction_end", "run_completed"]
    );
    assert.deepEqual(sentContent, [
      {
        type: "text",
        text: "List the files",
      },
    ]);
    assert.equal(events[0]?.payload.harness_session_id, "/tmp/pi-session.jsonl");
    assert.equal(derivedEvents[4]?.payload.harness_session_id, "/tmp/pi-session.jsonl");
    assert.deepEqual(derivedEvents[4]?.payload.usage, {
      input_tokens: 200,
      uncached_input_tokens: 120,
      output_tokens: 40,
      cached_input_tokens: 80,
      cache_write_input_tokens: 12,
      total_tokens: 252,
      cost_input_usd: 0.3,
      cost_output_usd: 0.6,
      estimated_cost_usd: 0.92,
    });
    assert.equal(derivedEvents[2]?.payload.reason, "threshold");
    assert.deepEqual(derivedEvents[3]?.payload.result, {
      summary: "Compacted older context.",
      firstKeptEntryId: "entry-1",
      tokensBefore: 1234,
    });
    assert.deepEqual(
      onlyPiNativeEvents(events).map((event) => event.payload.native_type),
      ["message_update", "message_end", "compaction_start", "compaction_end", "agent_end"]
    );
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("runPi emits terminal failure from assistant error messages and suppresses trailing agent_end success", async () => {
  const request = baseRequest();
  const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const fakeSession = {
    subscribe(listener: (event: unknown) => void) {
      this.listener = listener;
      return () => {};
    },
    async sendUserMessage() {
      this.listener?.({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          api: "anthropic-messages",
          provider: "anthropic_direct",
          model: "claude-sonnet-4-6",
          usage: {
            input: 12,
            output: 7,
            cacheRead: 3,
            cacheWrite: 0,
            totalTokens: 22,
            cost: { input: 0.12, output: 0.35, cacheRead: 0.01, cacheWrite: 0, total: 0.48 },
          },
          stopReason: "error",
          errorMessage: "404 Not Found",
          timestamp: Date.now(),
        },
      });
      this.listener?.({
        type: "agent_end",
        messages: [],
      });
    },
    async abort() {},
    dispose() {},
    listener: undefined as ((event: unknown) => void) | undefined,
  };

  process.stdout.write = ((chunk: string | Uint8Array) => {
    const lines = String(chunk)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event_type: string; payload: Record<string, unknown> });
    events.push(...lines);
    return true;
  }) as typeof process.stdout.write;

  try {
    const exitCode = await runPi(request, {
      createSession: async () => ({
        session: fakeSession as never,
        sessionFile: "/tmp/pi-session.jsonl",
        mcpToolMetadata: new Map(),
        skillMetadataByAlias: new Map(),
        dispose: async () => {},
      }),
    });

    assert.equal(exitCode, 0);
    const derivedEvents = withoutPiNativeEvents(events);
    assert.deepEqual(
      derivedEvents.map((event) => event.event_type),
      ["run_started", "run_failed"]
    );
    assert.equal(derivedEvents[1]?.payload.message, "404 Not Found");
    assert.equal(derivedEvents[1]?.payload.harness_session_id, "/tmp/pi-session.jsonl");
    assert.deepEqual(derivedEvents[1]?.payload.usage, {
      input_tokens: 15,
      uncached_input_tokens: 12,
      output_tokens: 7,
      cached_input_tokens: 3,
      cache_write_input_tokens: 0,
      total_tokens: 22,
      cost_input_usd: 0.12,
      cost_output_usd: 0.35,
      estimated_cost_usd: 0.48,
    });
    assert.deepEqual(
      onlyPiNativeEvents(events).map((event) => event.payload.native_type),
      ["message_end", "agent_end"]
    );
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("runPi suppresses post-run PI auto-compaction while preserving pre-prompt safety checks", async () => {
  const request = baseRequest();
  const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const fakeSession = {
    subscribe(listener: (event: unknown) => void) {
      this.listener = listener;
      return () => {};
    },
    async _checkCompaction(_assistantMessage: unknown, skipAbortedCheck = true) {
      this.listener?.({
        type: "compaction_start",
        reason: skipAbortedCheck === false ? "threshold" : "overflow",
      });
      this.listener?.({
        type: "compaction_end",
        reason: skipAbortedCheck === false ? "threshold" : "overflow",
        result: {
          summary: skipAbortedCheck === false ? "Pre-prompt safety compaction." : "Post-run compaction.",
          firstKeptEntryId: skipAbortedCheck === false ? "entry-pre" : "entry-post",
        },
        aborted: false,
        willRetry: false,
      });
    },
    async sendUserMessage() {
      await this._checkCompaction?.({ role: "assistant" }, false);
      this.listener?.({
        type: "agent_end",
        messages: [],
      });
      await this._checkCompaction?.({ role: "assistant" });
    },
    async abort() {},
    dispose() {},
    listener: undefined as ((event: unknown) => void) | undefined,
  };

  process.stdout.write = ((chunk: string | Uint8Array) => {
    const lines = String(chunk)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event_type: string; payload: Record<string, unknown> });
    events.push(...lines);
    return true;
  }) as typeof process.stdout.write;

  try {
    const exitCode = await runPi(request, {
      createSession: async () => ({
        session: fakeSession as never,
        sessionFile: "/tmp/pi-session.jsonl",
        mcpToolMetadata: new Map(),
        skillMetadataByAlias: new Map(),
        dispose: async () => {},
      }),
    });

    assert.equal(exitCode, 0);
    const derivedEvents = withoutPiNativeEvents(events);
    assert.deepEqual(
      derivedEvents.map((event) => event.event_type),
      ["run_started", "auto_compaction_start", "auto_compaction_end", "run_completed"]
    );
    assert.equal(derivedEvents[1]?.payload.reason, "threshold");
    assert.deepEqual(
      onlyPiNativeEvents(events).map((event) => event.payload.native_type),
      ["compaction_start", "compaction_end", "agent_end"]
    );
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("runPi emits waiting_user and blocks the active todo when the question tool completes", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-run-waiting-user-"));
  const stateDir = path.join(workspaceDir, ".holaboss", "pi-agent");
  const [, todoWrite] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-1",
  });
  await todoWrite.execute(
    "call-seed",
    {
      ops: [
        {
          op: "replace",
          phases: [
            {
              name: "Implementation",
              tasks: [
                {
                  content: "Wait for deploy confirmation",
                  status: "in_progress",
                },
                {
                  content: "Only continue after confirmation",
                },
              ],
            },
          ],
        },
      ],
    },
    undefined,
    undefined,
    {} as never
  );

  const request = {
    ...baseRequest(),
    workspace_dir: workspaceDir,
  };
  const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const fakeSession = {
    subscribe(listener: (event: unknown) => void) {
      this.listener = listener;
      return () => {};
    },
    async sendUserMessage() {
      this.listener?.({
        type: "tool_execution_start",
        toolCallId: "question-1",
        toolName: "question",
        args: { question: "Should I deploy to production?" },
      });
      this.listener?.({
        type: "tool_execution_end",
        toolCallId: "question-1",
        toolName: "question",
        result: { question: "Should I deploy to production?" },
        isError: false,
      });
      this.listener?.({
        type: "agent_end",
        messages: [],
      });
    },
    async abort() {},
    dispose() {},
    listener: undefined as ((event: unknown) => void) | undefined,
  };

  process.stdout.write = ((chunk: string | Uint8Array) => {
    const lines = String(chunk)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event_type: string; payload: Record<string, unknown> });
    events.push(...lines);
    return true;
  }) as typeof process.stdout.write;

  try {
    const exitCode = await runPi(request, {
      createSession: async () => ({
        session: fakeSession as never,
        sessionFile: "/tmp/pi-session.jsonl",
        mcpToolMetadata: new Map(),
        skillMetadataByAlias: new Map(),
        dispose: async () => {},
      }),
    });

    assert.equal(exitCode, 0);
    const derivedEvents = withoutPiNativeEvents(events);
    assert.deepEqual(
      derivedEvents.map((event) => event.event_type),
      ["run_started", "tool_call", "tool_call", "run_completed"]
    );
    assert.equal(derivedEvents[3]?.payload.status, "waiting_user");

    const persistedStatePath = path.join(stateDir, "todos", "session-1.json");
    const persisted = JSON.parse(fs.readFileSync(persistedStatePath, "utf8"));
    assert.equal(persisted.phases[0]?.tasks[0]?.status, "blocked");
    assert.equal(persisted.phases[0]?.tasks[1]?.status, "pending");
    assert.match(
      String(persisted.phases[0]?.tasks[0]?.details ?? ""),
      /Blocked waiting for user input: Should I deploy to production\?/,
    );
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("runPi emits waiting_user when a persisted todo is still blocked at run completion", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-run-blocked-todo-"));
  const stateDir = path.join(workspaceDir, ".holaboss", "pi-agent");
  const [, todoWrite] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-1",
  });
  await todoWrite.execute(
    "call-seed",
    {
      ops: [
        {
          op: "replace",
          phases: [
            {
              name: "Outreach",
              tasks: [
                {
                  content: "Continue the blocked DM attempt after the user decides what to do next",
                  status: "blocked",
                },
              ],
            },
          ],
        },
      ],
    },
    undefined,
    undefined,
    {} as never
  );

  const request = {
    ...baseRequest(),
    workspace_dir: workspaceDir,
  };
  const events: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const fakeSession = {
    subscribe(listener: (event: unknown) => void) {
      this.listener = listener;
      return () => {};
    },
    async sendUserMessage() {
      this.listener?.({
        type: "agent_end",
        messages: [],
      });
    },
    async abort() {},
    dispose() {},
    listener: undefined as ((event: unknown) => void) | undefined,
  };

  process.stdout.write = ((chunk: string | Uint8Array) => {
    const lines = String(chunk)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event_type: string; payload: Record<string, unknown> });
    events.push(...lines);
    return true;
  }) as typeof process.stdout.write;

  try {
    const exitCode = await runPi(request, {
      createSession: async () => ({
        session: fakeSession as never,
        sessionFile: "/tmp/pi-session.jsonl",
        mcpToolMetadata: new Map(),
        skillMetadataByAlias: new Map(),
        dispose: async () => {},
      }),
    });

    assert.equal(exitCode, 0);
    const derivedEvents = withoutPiNativeEvents(events);
    assert.deepEqual(
      derivedEvents.map((event) => event.event_type),
      ["run_started", "run_completed"]
    );
    assert.equal(derivedEvents[1]?.payload.status, "waiting_user");
  } finally {
    process.stdout.write = originalWrite;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("compactPiSession returns a structured result for successful snapshot compaction", async () => {
  let disposed = false;
  const result = await compactPiSession(baseRequest(), {
    createSession: async () => ({
      session: {
        compact: async () => ({
          summary: "Condensed older context.",
          firstKeptEntryId: "entry-42",
          tokensBefore: 12345,
          details: {
            modifiedFiles: ["src/pi.ts"],
          },
        }),
      } as never,
      sessionFile: "/tmp/pi-session.jsonl",
      mcpToolMetadata: new Map(),
      skillMetadataByAlias: new Map(),
      dispose: async () => {
        disposed = true;
      },
    }),
  });

  assert.equal(result.compacted, true);
  assert.equal(result.session_file, "/tmp/pi-session.jsonl");
  assert.deepEqual(result.result, {
    summary: "Condensed older context.",
    firstKeptEntryId: "entry-42",
    tokensBefore: 12345,
    details: {
      modifiedFiles: ["src/pi.ts"],
    },
  });
  assert.equal(result.reason, null);
  assert.equal(result.diagnostics, null);
  assert.equal(result.error, null);
  assert.equal(disposed, true);
});

test("generateSummary compacts the left side first and merges the raw right side when it fits", async () => {
  const result = await runCompactionSummaryScenario({
    contextWindow: 9_800,
    reserveTokens: 4_000,
    thresholdBytes: 100_000,
    messages: [
      createCompactionUserMessage("L".repeat(10_000)),
      createCompactionUserMessage("A".repeat(6_000)),
      createCompactionUserMessage("B".repeat(6_000)),
    ],
  });

  assert.equal(result.callCount, 2);
  assert.equal(result.summary, "summary-2");
  assert.equal(result.prompts.length, 2);
  assert.ok(result.prompts.every((prompt) => !prompt.includes("<continuity-overlap>")));
  assert.ok(!result.prompts[0]?.includes("<previous-summary>"));
  assert.match(result.prompts[0] ?? "", /L{100}/);
  assert.match(result.prompts[1] ?? "", /<previous-summary>\nsummary-1\n<\/previous-summary>/);
  assert.match(result.prompts[1] ?? "", /A{100}|B{100}/);
  assert.ok(!result.prompts[1]?.includes("[Summary]:"));
});

test("generateSummary independently compacts the right side before merging summaries when raw right content still does not fit", async () => {
  const result = await runCompactionSummaryScenario({
    contextWindow: 9_000,
    reserveTokens: 4_000,
    thresholdBytes: 100_000,
    messages: [
      createCompactionUserMessage("L".repeat(10_000)),
      createCompactionUserMessage("A".repeat(6_000)),
      createCompactionUserMessage("B".repeat(6_000)),
    ],
  });

  assert.equal(result.callCount, 4);
  assert.equal(result.summary, "summary-4");
  assert.ok(result.prompts.every((prompt) => !prompt.includes("<continuity-overlap>")));
  assert.ok(result.prompts.some((prompt) => prompt.includes("[Summary]: summary-3")));
  assert.ok(result.prompts.some((prompt) => prompt.includes("<previous-summary>\nsummary-1\n</previous-summary>")));
});

test("compactPiSession prefers native post-run maintenance compaction when available", async () => {
  let disposed = false;
  let manualCompactCalls = 0;
  let continueCalls = 0;
  let listener: ((event: unknown) => void) | undefined;
  const branch: Array<Record<string, unknown>> = [
    {
      id: "assistant-1",
      type: "message",
      timestamp: "2026-04-20T10:00:00.000Z",
      message: {
        role: "assistant",
      },
    },
  ];
  const session = {
    messages: [
      {
        role: "assistant",
      },
    ],
    agent: {
      continue: async () => {
        continueCalls += 1;
      },
      hasQueuedMessages: () => true,
    },
    sessionManager: {
      getBranch: () => branch,
      getLeafId: () => "assistant-1",
    },
    subscribe(nextListener: (event: unknown) => void) {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    },
    async _checkCompaction() {
      listener?.({
        type: "compaction_start",
        reason: "threshold",
      });
      branch.push({
        id: "compaction-1",
        type: "compaction",
        timestamp: "2026-04-20T10:00:01.000Z",
        summary: "Condensed older context.",
        firstKeptEntryId: "entry-42",
        tokensBefore: 12345,
        details: {
          modifiedFiles: ["src/pi.ts"],
        },
      });
      listener?.({
        type: "compaction_end",
        reason: "threshold",
        result: {
          summary: "Condensed older context.",
          firstKeptEntryId: "entry-42",
          tokensBefore: 12345,
          details: {
            modifiedFiles: ["src/pi.ts"],
          },
        },
        aborted: false,
        willRetry: false,
      });
      setTimeout(() => {
        void session.agent.continue();
      }, 0);
    },
    async compact() {
      manualCompactCalls += 1;
      throw new Error("manual fallback should not run");
    },
  };
  const result = await compactPiSession(baseRequest(), {
    createSession: async () => ({
      session: session as never,
      sessionFile: "/tmp/pi-session.jsonl",
      mcpToolMetadata: new Map(),
      skillMetadataByAlias: new Map(),
      dispose: async () => {
        disposed = true;
      },
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(result.compacted, true);
  assert.equal(result.session_file, "/tmp/pi-session.jsonl");
  assert.deepEqual(result.result, {
    summary: "Condensed older context.",
    firstKeptEntryId: "entry-42",
    tokensBefore: 12345,
    details: {
      modifiedFiles: ["src/pi.ts"],
    },
  });
  assert.equal(result.reason, null);
  assert.equal(result.error, null);
  assert.equal(manualCompactCalls, 0);
  assert.equal(continueCalls, 0);
  assert.equal(disposed, true);
});

test("compactPiSession bypasses native post-run maintenance when force_compaction is true", async () => {
  let manualCompactCalls = 0;
  let maintenanceCalls = 0;
  const result = await compactPiSession(
    {
      ...baseRequest(),
      force_compaction: true,
    },
    {
      createSession: async () => ({
        session: {
          messages: [
            {
              role: "assistant",
            },
          ],
          agent: {
            continue: async () => {},
            hasQueuedMessages: () => true,
          },
          sessionManager: {
            getBranch: () => [],
            getLeafId: () => null,
          },
          subscribe() {
            return () => {};
          },
          async _checkCompaction() {
            maintenanceCalls += 1;
          },
          async compact() {
            manualCompactCalls += 1;
            return {
              summary: "Forced compaction summary.",
              firstKeptEntryId: "entry-7",
              tokensBefore: 54321,
            };
          },
        } as never,
        sessionFile: "/tmp/pi-session.jsonl",
        mcpToolMetadata: new Map(),
        skillMetadataByAlias: new Map(),
        dispose: async () => {},
      }),
    },
  );

  assert.equal(result.compacted, true);
  assert.equal(result.reason, null);
  assert.equal(result.error, null);
  assert.deepEqual(result.result, {
    summary: "Forced compaction summary.",
    firstKeptEntryId: "entry-7",
    tokensBefore: 54321,
  });
  assert.equal(maintenanceCalls, 0);
  assert.equal(manualCompactCalls, 1);
});

test("compactPiSession surfaces native post-run maintenance failures without manual fallback", async () => {
  let manualCompactCalls = 0;
  let listener: ((event: unknown) => void) | undefined;
  const result = await compactPiSession(baseRequest(), {
    createSession: async () => ({
      session: {
        messages: [
          {
            role: "assistant",
          },
        ],
        agent: {
          continue: async () => {},
          hasQueuedMessages: () => false,
        },
        sessionManager: {
          getBranch: () => [
            {
              id: "assistant-1",
              type: "message",
              timestamp: "2026-04-20T10:00:00.000Z",
              message: {
                role: "assistant",
              },
            },
          ],
          getLeafId: () => "assistant-1",
        },
        subscribe(nextListener: (event: unknown) => void) {
          listener = nextListener;
          return () => {
            listener = undefined;
          };
        },
        async _checkCompaction() {
          listener?.({
            type: "compaction_start",
            reason: "threshold",
          });
          listener?.({
            type: "compaction_end",
            reason: "threshold",
            result: undefined,
            aborted: false,
            willRetry: false,
            errorMessage:
              "Auto-compaction failed: Turn prefix summarization failed: 422 status code (no body)",
          });
        },
        async compact() {
          manualCompactCalls += 1;
          throw new Error("manual fallback should not run");
        },
      } as never,
      sessionFile: "/tmp/pi-session.jsonl",
      mcpToolMetadata: new Map(),
      skillMetadataByAlias: new Map(),
      dispose: async () => {},
    }),
  });

  assert.equal(result.compacted, false);
  assert.equal(result.reason, null);
  assert.equal(result.result, null);
  assert.equal(result.error?.name, "PiSnapshotCompactionError");
  assert.equal(
    result.error?.message,
    "Auto-compaction failed: Turn prefix summarization failed: 422 status code (no body)",
  );
  assert.equal(
    result.error?.provider_message,
    "Auto-compaction failed: Turn prefix summarization failed: 422 status code (no body)",
  );
  assert.equal(manualCompactCalls, 0);
});

test("compactPiSession returns structured error diagnostics for snapshot compaction failures", async () => {
  let listener: ((event: unknown) => void) | undefined;
  const result = await compactPiSession(baseRequest(), {
    createSession: async () => ({
      session: {
        subscribe(nextListener: (event: unknown) => void) {
          listener = nextListener;
          return () => {
            listener = undefined;
          };
        },
        async compact() {
          listener?.({
            type: "compaction_start",
            reason: "manual",
          });
          listener?.({
            type: "compaction_end",
            reason: "manual",
            result: undefined,
            aborted: false,
            willRetry: false,
            errorMessage:
              "Compaction failed: Turn prefix summarization failed: 422 status code (no body)",
          });
          const error = new Error(
            "Turn prefix summarization failed: 422 status code (no body)",
          ) as Error & {
            status?: number;
            error?: Record<string, unknown>;
          };
          error.name = "APIError";
          error.status = 422;
          error.error = {
            type: "invalid_request_error",
            message: "422 status code (no body)",
          };
          throw error;
        },
      } as never,
      sessionFile: "/tmp/pi-session.jsonl",
      mcpToolMetadata: new Map(),
      skillMetadataByAlias: new Map(),
      dispose: async () => {},
    }),
  });

  assert.equal(result.compacted, false);
  assert.equal(result.reason, null);
  assert.equal(result.result, null);
  assert.deepEqual(result.diagnostics, {
    compaction_start: {
      type: "compaction_start",
      reason: "manual",
    },
    compaction_end: {
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      will_retry: false,
      error_message:
        "Compaction failed: Turn prefix summarization failed: 422 status code (no body)",
      result: null,
    },
  });
  assert.equal(result.error?.name, "APIError");
  assert.equal(
    result.error?.message,
    "Turn prefix summarization failed: 422 status code (no body)",
  );
  assert.equal(result.error?.status_code, 422);
  assert.equal(
    result.error?.provider_message,
    "422 status code (no body)",
  );
});

test("buildPiPromptPayload inlines native images, extracts common document formats, and falls back for binary files", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-attachments-"));
  const attachmentsDir = path.join(workspaceDir, ".holaboss", "input-attachments", "batch-1");
  const imagePath = path.join(attachmentsDir, "diagram.png");
  const textPath = path.join(attachmentsDir, "notes.txt");
  const docxPath = path.join(attachmentsDir, "notes.docx");
  const pptxPath = path.join(attachmentsDir, "slides.pptx");
  const xlsxPath = path.join(attachmentsDir, "sheet.xlsx");
  const pdfPath = path.join(attachmentsDir, "summary.pdf");
  const binaryPath = path.join(attachmentsDir, "archive.bin");
  const folderPath = path.join(workspaceDir, "docs");
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const docxBytes = await createDocxBuffer(["Quarterly plan", "Ship the feature"]);
  const pptxBytes = await createPptxBuffer(["Roadmap", "Launch"]);
  const xlsxBytes = await createXlsxBuffer([
    ["Name", "Value"],
    ["alpha", "1"],
  ]);
  const pdfBytes = createPdfBuffer("Hello PDF");

  fs.mkdirSync(attachmentsDir, { recursive: true });
  fs.writeFileSync(imagePath, imageBytes);
  fs.writeFileSync(textPath, "alpha\nbeta\n");
  fs.writeFileSync(docxPath, docxBytes);
  fs.writeFileSync(pptxPath, pptxBytes);
  fs.writeFileSync(xlsxPath, xlsxBytes);
  fs.writeFileSync(pdfPath, pdfBytes);
  fs.writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(path.join(folderPath, "notes.md"), "# scoped folder\n", "utf8");

  try {
    const prompt = await buildPiPromptPayload({
      ...baseRequest(),
      workspace_dir: workspaceDir,
      attachments: [
        {
          id: "attachment-image",
          kind: "image",
          name: "diagram.png",
          mime_type: "image/png",
          size_bytes: imageBytes.length,
          workspace_path: ".holaboss/input-attachments/batch-1/diagram.png",
        },
        {
          id: "attachment-text",
          kind: "file",
          name: "notes.txt",
          mime_type: "text/plain",
          size_bytes: 11,
          workspace_path: ".holaboss/input-attachments/batch-1/notes.txt",
        },
        {
          id: "attachment-docx",
          kind: "file",
          name: "notes.docx",
          mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size_bytes: docxBytes.length,
          workspace_path: ".holaboss/input-attachments/batch-1/notes.docx",
        },
        {
          id: "attachment-pptx",
          kind: "file",
          name: "slides.pptx",
          mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          size_bytes: pptxBytes.length,
          workspace_path: ".holaboss/input-attachments/batch-1/slides.pptx",
        },
        {
          id: "attachment-xlsx",
          kind: "file",
          name: "sheet.xlsx",
          mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size_bytes: xlsxBytes.length,
          workspace_path: ".holaboss/input-attachments/batch-1/sheet.xlsx",
        },
        {
          id: "attachment-pdf",
          kind: "file",
          name: "summary.pdf",
          mime_type: "application/pdf",
          size_bytes: pdfBytes.length,
          workspace_path: ".holaboss/input-attachments/batch-1/summary.pdf",
        },
        {
          id: "attachment-binary",
          kind: "file",
          name: "archive.bin",
          mime_type: "application/octet-stream",
          size_bytes: 4,
          workspace_path: ".holaboss/input-attachments/batch-1/archive.bin",
        },
        {
          id: "attachment-folder",
          kind: "folder",
          name: "docs",
          mime_type: "inode/directory",
          size_bytes: 0,
          workspace_path: "docs",
        },
      ],
    });

    assert.match(prompt.text, /Attached images:/);
    assert.match(prompt.text, /diagram\.png \(image\/png\) at \.\/\.holaboss\/input-attachments\/batch-1\/diagram\.png/);
    assert.match(prompt.text, /\[Document: notes\.txt\]/);
    assert.match(prompt.text, /alpha\nbeta/);
    assert.match(prompt.text, /\[Document: summary\.pdf\]/);
    assert.match(prompt.text, /<pdf filename="summary\.pdf" pages="1">/);
    assert.match(prompt.text, /<links total="0" pages="1">/);
    assert.match(prompt.text, /<text_item_summary items="1"/);
    assert.match(prompt.text, /Hello PDF/);
    assert.match(prompt.text, /<embedded_images scanned_pages="1" total_pages="1">/);
    assert.match(prompt.text, /<summary total_images="0" \/>/);
    assert.match(prompt.text, /<rendered_pages scanned_pages="1" total_pages="1">/);
    assert.match(prompt.text, /\[Document: notes\.docx\]/);
    assert.match(prompt.text, /<docx filename="notes\.docx">/);
    assert.match(prompt.text, /Quarterly plan/);
    assert.match(prompt.text, /\[Document: slides\.pptx\]/);
    assert.match(prompt.text, /<pptx filename="slides\.pptx">/);
    assert.match(prompt.text, /Roadmap/);
    assert.match(prompt.text, /\[Document: sheet\.xlsx\]/);
    assert.match(prompt.text, /<excel filename="sheet\.xlsx">/);
    assert.match(prompt.text, /Name,Value/);
    assert.match(prompt.text, /Attached folders:/);
    assert.match(prompt.text, /docs \(folder, inode\/directory\) at \.\/docs/);
    assert.match(prompt.text, /Treat attached folders as scoped workspace context\./);
    assert.doesNotMatch(prompt.text, /scoped folder/);
    assert.match(prompt.text, /Other attachments are staged in the workspace and should be inspected from these paths:/);
    assert.match(prompt.text, /archive\.bin \(file, application\/octet-stream\) at \.\/\.holaboss\/input-attachments\/batch-1\/archive\.bin/);
    assert.deepEqual(prompt.images, [
      {
        type: "image",
        data: imageBytes.toString("base64"),
        mimeType: "image/png",
      },
    ]);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("buildPiPromptPayload inlines image_urls from data URLs and remote image fetches", async () => {
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://example.com/reference.png") {
      return new Response(imageBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const prompt = await buildPiPromptPayload({
      ...baseRequest(),
      attachments: [],
      image_urls: [
        `data:image/png;base64,${imageBytes.toString("base64")}`,
        "https://example.com/reference.png",
        "https://example.com/missing.png",
      ],
    });

    assert.ok(!prompt.text.includes("Attachments: none."));
    assert.match(prompt.text, /Referenced image URLs:/);
    assert.match(prompt.text, /\[Image URL 1\] data URL/);
    assert.match(prompt.text, /\[Image URL 2\] https:\/\/example\.com\/reference\.png/);
    assert.match(prompt.text, /Image URLs not inlined as image inputs:/);
    assert.match(prompt.text, /\[Image URL 3\] https:\/\/example\.com\/missing\.png/);
    assert.deepEqual(prompt.images, [
      {
        type: "image",
        data: imageBytes.toString("base64"),
        mimeType: "image/png",
      },
      {
        type: "image",
        data: imageBytes.toString("base64"),
        mimeType: "image/png",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildPiPromptPayload omits empty attachment and image-input sentinel text", async () => {
  const prompt = await buildPiPromptPayload({
    ...baseRequest(),
    attachments: [],
  });

  assert.equal(prompt.text, "List the files");
  assert.ok(!prompt.text.includes("Attachments: none."));
  assert.ok(!prompt.text.includes("Image inputs: none."));
  assert.deepEqual(prompt.images, []);
});

test("buildPiPromptPayload keeps runtime context in a separate prompt section", async () => {
  const prompt = await buildPiPromptPayload({
    ...baseRequest(),
    attachments: [],
    context_messages: ["Previous summary", "User prefers terse answers"],
  });

  assert.match(
    prompt.text,
    /^List the files\s+Runtime context:\s+\[Runtime Context 1\]\s+Previous summary\s+\[\/Runtime Context 1\]\s+\[Runtime Context 2\]\s+User prefers terse answers\s+\[\/Runtime Context 2\]$/
  );
  assert.ok(prompt.text.startsWith("List the files\n\nRuntime context:\n\n[Runtime Context 1]"));
});

test("buildPiPromptPayload frames persisted todo state as advisory continuity when resuming", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-resume-todo-"));
  const stateDir = path.join(workspaceDir, ".holaboss", "pi-agent");
  fs.mkdirSync(path.join(workspaceDir, ".holaboss", "pi-sessions"), { recursive: true });
  const persistedSessionPath = path.join(workspaceDir, ".holaboss", "pi-sessions", "session-1.jsonl");
  fs.writeFileSync(persistedSessionPath, "", "utf8");

  const [, todoWrite] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-1",
  });
  await todoWrite.execute(
    "call-seed",
    {
      ops: [
        {
          op: "replace",
          phases: [
            {
              name: "Implementation",
              tasks: [{ content: "Resume the existing work" }],
            },
          ],
        },
      ],
    },
    undefined,
    undefined,
    {} as never
  );

  try {
    const prompt = await buildPiPromptPayload({
      ...baseRequest(),
      workspace_dir: workspaceDir,
      persisted_harness_session_id: persistedSessionPath,
    });

    assert.match(prompt.text, /Resumed session note:/);
    assert.match(prompt.text, /Treat the user's newest message as the primary instruction for this turn\./i);
    assert.match(prompt.text, /Use `todoread` when you need the current phase\/task ids before continuing or updating the persisted plan\./i);
    assert.match(prompt.text, /Only restore and continue the persisted todo immediately when the user's newest message clearly asks to continue it or clearly advances the same work\./i);
    assert.match(prompt.text, /If the user's newest message is conversational, brief, acknowledges prior progress, or is otherwise ambiguous about continuation, respond to that message directly first and ask whether they want to continue the unfinished work\./i);
    assert.match(
      prompt.text,
      /valid `op` values are exactly `replace`, `add_phase`, `add_task`, `update`, and `remove_task`/i
    );
    assert.match(
      prompt.text,
      /Do not invent alias op names such as `replace_all`, `update_task`, or `set_status`/i
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("buildPiPromptPayload does not fall back to persisted session file when requested id is stale", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-stale-requested-session-"));
  const stateDir = path.join(workspaceDir, ".holaboss", "pi-agent");
  fs.mkdirSync(path.join(workspaceDir, ".holaboss", "pi-sessions"), { recursive: true });
  const persistedSessionPath = path.join(workspaceDir, ".holaboss", "pi-sessions", "session-1.jsonl");
  fs.writeFileSync(persistedSessionPath, "", "utf8");

  const [, todoWrite] = createPiTodoToolDefinitions({
    stateDir,
    sessionId: "session-1",
  });
  await todoWrite.execute(
    "call-seed",
    {
      ops: [
        {
          op: "replace",
          phases: [
            {
              name: "Implementation",
              tasks: [{ content: "Resume the existing work" }],
            },
          ],
        },
      ],
    },
    undefined,
    undefined,
    {} as never
  );

  try {
    const prompt = await buildPiPromptPayload({
      ...baseRequest(),
      workspace_dir: workspaceDir,
      harness_session_id: "session-1",
      persisted_harness_session_id: persistedSessionPath,
    });

    assert.doesNotMatch(prompt.text, /Resumed session note:/);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("buildPiPromptPayload expands leading slash skill references into quoted skill blocks", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-slash-skills-"));
  const skillsDir = path.join(workspaceDir, "skills");
  const customerLookupDir = path.join(skillsDir, "customer_lookup");
  fs.mkdirSync(customerLookupDir, { recursive: true });
  fs.writeFileSync(
    path.join(customerLookupDir, "SKILL.md"),
    [
      "---",
      'description: "Look up customer state before replying."',
      "---",
      "",
      "# Customer Lookup",
      "",
      "Check the customer profile before writing the response.",
    ].join("\n"),
    "utf8"
  );

  try {
    const prompt = await buildPiPromptPayload({
      ...baseRequest(),
      workspace_dir: workspaceDir,
      workspace_skill_dirs: [skillsDir],
      instruction: ["/customer_lookup", "", "Draft the follow-up email."].join("\n"),
    });

    assert.match(prompt.text, /Quoted workspace skills:/);
    assert.match(prompt.text, /<skill name="customer_lookup" location=".*customer_lookup\/SKILL\.md">/);
    assert.match(prompt.text, /References are relative to .*customer_lookup/);
    assert.match(prompt.text, /Check the customer profile before writing the response\./);
    assert.match(prompt.text, /Draft the follow-up email\./);
    assert.doesNotMatch(prompt.text, /^\/customer_lookup$/m);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("buildPiPromptPayload rejects attachment paths outside workspace boundary", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-pi-attachment-boundary-"));
  const outsideFile = path.join(path.dirname(workspaceDir), "outside.txt");
  fs.writeFileSync(outsideFile, "outside");

  try {
    await assert.rejects(
      async () =>
        await buildPiPromptPayload({
          ...baseRequest(),
          workspace_dir: workspaceDir,
          attachments: [
            {
              id: "attachment-outside",
              kind: "file",
              name: "outside.txt",
              mime_type: "text/plain",
              size_bytes: 7,
              workspace_path: "../outside.txt",
            },
          ],
        }),
      /outside workspace boundary/i
    );
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.rmSync(outsideFile, { force: true });
  }
});
