/**
 * Bossman host runner — drives the Claude Agent SDK in-process and translates
 * its message stream into Holaboss `RunnerOutputEvent`s.
 *
 * Contrast with claude-code.ts (CLI subprocess + native auth): here we run the
 * SDK's `query()` loop directly and route it through the Holaboss model proxy
 * via `model_client`, so the run is billed and can target any proxied model.
 *
 * SPIKE STATUS: the wiring (proxy env, mcpServers, allowedTools, event mapping,
 * resume) is structurally complete but has NOT been type-checked against the
 * installed SDK or run live. Fields marked `TODO(validate)` are the ones to
 * confirm once `@anthropic-ai/claude-agent-sdk` is installed (see SPIKE.md).
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parseClaudeStreamDelta } from "./claude-code.js";
import type {
  HarnessHostBossmanRequest,
  JsonObject,
  RunnerEventType,
  RunnerOutputEvent,
} from "./contracts.js";

const HARNESS_ID = "bossman";

/**
 * Build the ANTHROPIC_BASE_URL the Claude engine should use.
 *
 * The engine only speaks Anthropic Messages and appends `/v1/messages`, so
 * Bossman must ALWAYS hit the proxy's `/anthropic` route — even for non-Claude
 * models (the proxy now accepts any catalog model there and lets LiteLLM
 * translate). The runtime hands a per-provider base (…/model-proxy/<provider>/v1,
 * e.g. …/openai/v1 when a GPT model is selected), so rewrite the
 * `…/model-proxy/<provider>[/v1]` tail to `…/model-proxy/anthropic`. The engine
 * then lands on `…/anthropic/v1/messages` (verified live: 200).
 */
function normalizeAnthropicBaseUrl(baseUrl: string | null | undefined): string | null {
  const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return null;
  }
  const rewritten = trimmed.replace(/(\/model-proxy)\/[^/]+(?:\/v1)?$/, "$1/anthropic");
  if (rewritten !== trimmed) {
    return rewritten;
  }
  // Base wasn't in the expected shape — fall back to stripping a trailing /v1.
  return trimmed.replace(/\/v1$/, "");
}

/**
 * request.mcp_servers entries are `{ name, config }` in HOLABOSS's schema
 * (`config.type` is "local" | "remote"). The Claude engine (and the SDK's
 * `mcpServers` option) expects Claude's schema instead — `stdio` / `http`. This
 * mirrors claude-code.ts's `materializeClaudeMcpConfig`: without the transform
 * the engine can't parse the servers and hangs on MCP init.
 */
function translateMcpServers(
  servers: JsonObject[],
  emit: (type: RunnerEventType, payload: Record<string, unknown>) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of servers) {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const config =
      entry.config && typeof entry.config === "object" ? (entry.config as JsonObject) : null;
    if (!name || !config) {
      continue;
    }
    if (config.enabled === false) {
      continue;
    }
    if (config.type === "local") {
      const command = Array.isArray(config.command)
        ? (config.command as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      if (command.length === 0) {
        continue;
      }
      out[name] = {
        type: "stdio",
        command: command[0],
        args: command.slice(1),
        env:
          config.environment && typeof config.environment === "object" ? config.environment : {},
      };
    } else if (config.type === "remote") {
      const url = typeof config.url === "string" ? config.url.trim() : "";
      if (!url) {
        continue;
      }
      out[name] = {
        type: "http",
        url,
        headers: config.headers && typeof config.headers === "object" ? config.headers : {},
      };
    } else {
      emit("mcp_server_unavailable", {
        server_id: name,
        reason: `unsupported mcp type: ${String(config.type)}`,
      });
    }
  }
  return out;
}

function buildUserContent(request: HarnessHostBossmanRequest): string {
  // TODO(validate): richer content blocks for attachments/images. For the spike
  // we send the instruction as text; image_urls/attachments come next.
  return request.instruction;
}

/** Map the SDK result's usage into the harness usage shape (keyed by model),
 *  matching claude-code's serializeUsage so the UI token display works. */
function sdkUsageToPayload(
  // biome-ignore lint/suspicious/noExplicitAny: SDK result usage shape pinned at install.
  message: any,
  model: string,
): Record<string, unknown> | null {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    [model || "unknown"]: {
      input_tokens: num(usage.input_tokens),
      output_tokens: num(usage.output_tokens),
      cache_read_tokens: num(usage.cache_read_input_tokens),
      cache_write_tokens: num(usage.cache_creation_input_tokens),
    },
  };
}

/**
 * Map a single Agent SDK stream message to zero-or-more RunnerOutputEvents.
 * Returns the (possibly updated) captured session id.
 *
 * TODO(validate): exact discriminants/field names of the SDK message union.
 * Based on the documented shapes: `system` (init, carries session_id),
 * `assistant` (message.content blocks: text | thinking | tool_use), `result`
 * (subtype: "success" | error variants, `result` text). We emit from full
 * assistant blocks (not partial stream_event deltas) to avoid double-emitting;
 * finer-grained streaming via `stream_event` is a follow-up.
 */
export function mapSdkMessage(
  // biome-ignore lint/suspicious/noExplicitAny: SDK union pinned at install time.
  message: any,
  emit: (type: RunnerEventType, payload: Record<string, unknown>) => void,
  capturedSessionId: string | null,
  toolNames: Map<string, string>,
  streamState: { streamedPartialContent: boolean },
): string | null {
  let sessionId = capturedSessionId;
  const type = message?.type;

  if (type === "system") {
    if (typeof message.session_id === "string" && message.session_id) {
      sessionId = message.session_id;
    }
    return sessionId;
  }

  // Token-level partial deltas. `includePartialMessages: true` makes the SDK
  // emit `stream_event` frames; surfacing them here streams text to the UI as
  // it's generated instead of only when a complete assistant block arrives.
  // Latch `streamedPartialContent` so the full `assistant` block below doesn't
  // re-emit the same text. Mirrors claude-code.ts.
  if (type === "stream_event") {
    const parsed = parseClaudeStreamDelta(message);
    if (parsed) {
      streamState.streamedPartialContent = true;
      if (parsed.kind === "text") {
        emit("output_delta", { delta: parsed.text });
      } else {
        emit("thinking_delta", { delta: parsed.text });
      }
    }
    return sessionId;
  }

  if (type === "assistant") {
    const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string") {
        // Skip when partial deltas already streamed this text (the normal case
        // under includePartialMessages); emit only as a fallback for builds that
        // don't stream partials, so text is never dropped or doubled.
        if (!streamState.streamedPartialContent) {
          emit("output_delta", { delta: block.text });
        }
      } else if (block?.type === "thinking" && typeof block.thinking === "string") {
        if (!streamState.streamedPartialContent) {
          emit("thinking_delta", { delta: block.thinking });
        }
      } else if (block?.type === "tool_use") {
        if (typeof block.id === "string" && typeof block.name === "string") {
          toolNames.set(block.id, block.name);
        }
        emit("tool_call", {
          tool_name: block.name,
          call_id: block.id,
          tool_args: block.input ?? {},
          phase: "in_progress",
        });
      }
    }
    return sessionId;
  }

  if (type === "user") {
    // tool_result blocks flowing back in — surface completion for the trace.
    const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        // The chat UI builds the tool trace step AND renders the Connect card
        // from `tool_name` + `result` on the completed event (it deep-searches
        // `result` for the propose_connect payload). Match claude-code's shape:
        // carry the tool name (looked up by call_id) and the raw output.
        emit("tool_call", {
          tool_name: (callId && toolNames.get(callId)) || "",
          call_id: callId,
          result: block.content ?? null,
          error: block.is_error === true,
          phase: "completed",
        });
        if (callId) {
          toolNames.delete(callId);
        }
      }
    }
    return sessionId;
  }

  return sessionId;
}

export async function runBossman(request: HarnessHostBossmanRequest): Promise<number> {
  let sequence = 0;
  const emit = (eventType: RunnerEventType, payload: Record<string, unknown>): void => {
    const event: RunnerOutputEvent = {
      session_id: request.session_id,
      input_id: request.input_id,
      sequence: sequence++,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      payload,
    };
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  // Use the runtime-resolved BARE catalog id (request.model_id), not
  // selected_model. selected_model carries a provider prefix (e.g.
  // holaboss_model_proxy/claude-sonnet-4-6) that the proxy's /anthropic route
  // rejects with model_id_invalid_format; model_id is the bare id the route
  // accepts (claude-sonnet-4-6, gpt-5.5, deepseek/deepseek-v4-pro) — same field
  // pi routes on.
  const model = request.model_id?.trim() || request.selected_model?.trim() || "";
  emit("run_started", { harness: HARNESS_ID, model, pid: process.pid });

  // Route the SDK through the Holaboss model proxy (billing + any-model).
  const proxyBase = normalizeAnthropicBaseUrl(request.model_client.base_url);
  if (proxyBase) {
    process.env.ANTHROPIC_BASE_URL = proxyBase;
  }
  if (request.model_client.api_key) {
    process.env.ANTHROPIC_AUTH_TOKEN = request.model_client.api_key;
    process.env.ANTHROPIC_API_KEY = request.model_client.api_key;
  }
  // The Holaboss gateway requires x-api-key AND the x-holaboss-* context headers
  // (user-id + sandbox-id, etc.) on every model call — the runtime supplies them
  // in model_client.default_headers (same set Hola forwards). The engine only
  // sends x-api-key on its own, so forward the rest via ANTHROPIC_CUSTOM_HEADERS.
  // Without these the gateway 401s and the SDK retry-loops (stuck "Working").
  const defaultHeaders = request.model_client.default_headers;
  if (defaultHeaders && typeof defaultHeaders === "object") {
    const lines = Object.entries(defaultHeaders)
      .filter(([k, v]) => typeof k === "string" && k && typeof v === "string" && v)
      .map(([k, v]) => `${k}: ${v}`);
    if (lines.length > 0) {
      process.env.ANTHROPIC_CUSTOM_HEADERS = lines.join("\n");
    }
  }

  const mcpServers = translateMcpServers(request.mcp_servers, emit);
  const allowedTools = Object.entries(request.tools ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const resume = request.persisted_harness_session_id?.trim() || undefined;
  const cwd = request.agent_cwd?.trim() || request.workspace_dir;

  async function* prompt() {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: buildUserContent(request) },
    };
  }

  let capturedSessionId: string | null = null;
  // call_id -> tool name, so the completed event can carry tool_name (the SDK's
  // tool_result blocks only carry the call id).
  const toolNames = new Map<string, string>();
  // Latched once any partial `stream_event` delta is seen, so the aggregate
  // assistant block doesn't re-emit already-streamed text.
  const streamState = { streamedPartialContent: false };
  try {
    for await (const message of query({
      prompt: prompt(),
      options: {
        model,
        // Runtime gates tools upstream (same posture as claude-code), so the
        // SDK auto-approves; the allowlist scopes what Claude may call.
        permissionMode: "bypassPermissions",
        systemPrompt: request.system_prompt || undefined,
        mcpServers,
        allowedTools: allowedTools.length ? allowedTools : undefined,
        includePartialMessages: true,
        resume,
        cwd,
        // maxTurns intentionally unset — let the native loop plan and iterate.
      },
      // biome-ignore lint/suspicious/noExplicitAny: SDK option shape pinned at install.
    } as any)) {
      capturedSessionId = mapSdkMessage(message, emit, capturedSessionId, toolNames, streamState);
      // biome-ignore lint/suspicious/noExplicitAny: SDK union pinned at install.
      const m = message as any;
      if (m?.type === "result") {
        if (m.subtype === "success") {
          emit("run_completed", {
            status: "completed",
            output: typeof m.result === "string" ? m.result : "",
            harness_session_id: capturedSessionId,
            usage: sdkUsageToPayload(m, model),
          });
          return 0;
        }
        emit("run_failed", {
          error:
            typeof m.result === "string" && m.result
              ? m.result
              : `bossman run ${m.subtype ?? "failed"}`,
          harness_session_id: capturedSessionId,
          usage: sdkUsageToPayload(m, model),
        });
        return 1;
      }
    }
    // Stream ended without an explicit result frame — treat as completed.
    emit("run_completed", {
      status: "completed",
      output: "",
      harness_session_id: capturedSessionId,
    });
    return 0;
  } catch (error) {
    emit("run_failed", {
      error: error instanceof Error ? error.message : String(error),
      harness_session_id: capturedSessionId,
    });
    return 1;
  }
}
