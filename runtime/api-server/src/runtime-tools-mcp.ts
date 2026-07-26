import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  createHarnessRuntimeToolDefinition,
  resolveComposioInlineTools,
  resolveHarnessDesktopBrowserToolDefinitions,
  RUNTIME_AGENT_TOOL_DEFINITIONS,
  type HarnessRuntimeToolDefinitionLike,
  type RuntimeAgentToolId,
} from "../../harnesses/src/index.js";

/**
 * Runtime-tools MCP bridge for CLI harnesses (claude-code / codex).
 *
 * `pi` wires the Holaboss runtime tools in-process; every other harness only
 * reaches Holaboss over MCP. The oRPC `/mcp` mount exposes a read-only sliver
 * (`outputs_list`). This mount exposes the same runtime-tool surface pi uses —
 * built by the shared `createHarnessRuntimeToolDefinition` factory, so schemas
 * and handlers are one source of truth — as MCP tools. Each tool's handler
 * HTTP-calls the runtime's own `/api/v1/capabilities/runtime-tools/*` routes
 * (identical to how pi's tools reach them), carrying the per-run context
 * (workspace / session / input / selected model) that the harness injects as
 * request headers when it connects.
 *
 * First cut ships a curated, low-blast-radius subset; widen `CURATED_RUNTIME_
 * TOOL_IDS` to expand parity.
 */

// Every id must exist in RUNTIME_AGENT_TOOL_DEFINITIONS (asserted at module load
// below). Deliberately excludes desktop-only (open_macos_settings), session
// terminal/app-lifecycle, and pi-owned todo tools for the first cut.
const CURATED_RUNTIME_TOOL_IDS = [
  "web_search",
  "image_generate",
  "video_generate",
  "download_url",
  "send_file",
  "holahub_upload_image",
  "write_report",
  "memory_retrieve",
  "remember",
  "cronjobs_list",
  "cronjobs_get",
  "cronjobs_create",
  "cronjobs_update",
  "cronjobs_delete",
  "cronjobs_run_now",
  // Self-contained workspace utilities (no pause/redispatch semantics).
  "update_workspace_instructions",
  "skill",
  "workspace_integrations_list_catalog",
  // Integration connect/config. propose_connect returns its "Connect" card
  // synchronously; the pause/resume is handled at the runtime dispatch layer,
  // not in the harness — the integration-proposal gate scans this tool's
  // output_event (including the MCP text-content result shape) to defer the
  // next input, and re-dispatches when the OAuth connection goes active. So it
  // works for external harnesses too, not just pi. set_default_account is a
  // plain synchronous mutate whose new tools apply on the next turn.
  "holaboss_workspace_integrations_propose_connect",
  "holaboss_workspace_integrations_set_default_account",
  // Connect an MCP server (remote URL or local command) to the workspace — the
  // agent's self-service "connect this MCP" path. Writes workspace.yaml; the new
  // server's tools apply on the next turn.
  "mcp_connect",
  // Force re-discovery of connected MCP servers' tools (whole-workspace).
  "mcp_refresh",
  // macOS host permission remediation (no-op off macOS).
  "open_macos_settings",
] as const satisfies readonly RuntimeAgentToolId[];

const CURATED_RUNTIME_TOOL_ID_SET: ReadonlySet<string> = new Set(
  CURATED_RUNTIME_TOOL_IDS,
);

interface RuntimeToolMcpContext {
  runtimeApiBaseUrl: string;
  workspaceId: string | null;
  sessionId: string | null;
  inputId: string | null;
  selectedModel: string | null;
  browserToolsEnabled: boolean;
  browserSpace: "agent" | null;
}

function headerValue(
  headers: FastifyRequest["headers"],
  name: string,
): string | null {
  const value = headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/**
 * The runtime tools' handlers HTTP-call the runtime's own capability routes, so
 * they need the base URL the harness used to reach us. Reconstruct it from the
 * incoming request — guaranteed reachable (it's literally the URL the harness
 * connected to) and dependency-free.
 */
function selfBaseUrl(request: FastifyRequest): string {
  const scheme =
    headerValue(request.headers, "x-forwarded-proto") ??
    request.protocol ??
    "http";
  const host = headerValue(request.headers, "host") ?? "127.0.0.1";
  return `${scheme}://${host}`;
}

function readBrowserSpaceHeader(
  request: FastifyRequest,
): "agent" | null {
  const raw = headerValue(request.headers, "x-holaboss-browser-space");
  return raw === "agent" ? raw : null;
}

function readRuntimeToolMcpContext(request: FastifyRequest): RuntimeToolMcpContext {
  return {
    runtimeApiBaseUrl: selfBaseUrl(request),
    workspaceId: headerValue(request.headers, "x-holaboss-workspace-id"),
    sessionId: headerValue(request.headers, "x-holaboss-session-id"),
    inputId: headerValue(request.headers, "x-holaboss-input-id"),
    selectedModel: headerValue(request.headers, "x-holaboss-selected-model"),
    // The harness injects this only when browser tools are enabled for the run
    // (mirrors pi's session-kind gate — see harness-mcp.ts). Absent → disabled.
    browserToolsEnabled:
      headerValue(request.headers, "x-holaboss-browser-tools-enabled") === "true",
    browserSpace: readBrowserSpaceHeader(request),
  };
}

function buildCuratedRuntimeToolDefinitions(
  ctx: RuntimeToolMcpContext,
): HarnessRuntimeToolDefinitionLike[] {
  return RUNTIME_AGENT_TOOL_DEFINITIONS.filter((tool) =>
    CURATED_RUNTIME_TOOL_ID_SET.has(tool.id),
  ).map((tool) =>
    createHarnessRuntimeToolDefinition(tool.id, tool.description, {
      runtimeApiBaseUrl: ctx.runtimeApiBaseUrl,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      inputId: ctx.inputId,
      selectedModel: ctx.selectedModel,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Mirror pi's per-call tool-output cap (wrapToolWithOutputCap, harness-host).
const RUNTIME_TOOL_RESULT_MAX_BYTES = (() => {
  const raw = process.env.HOLABOSS_MAX_TOOL_OUTPUT_BYTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50 * 1024;
})();

/**
 * Turn a runtime/browser/composio tool result into the model-facing MCP content,
 * bounded in size. Two defenses against context blowups on CLI harnesses:
 *   1. Forward ONLY the tool's `content` (already compacted for browser
 *      capability tools) — never `details`, which can carry a full
 *      pre-compaction `raw` payload (observed at 300KB+). The old bridge did
 *      `JSON.stringify(result)` of the whole envelope, re-inlining that raw.
 *   2. Cap the serialized text at RUNTIME_TOOL_RESULT_MAX_BYTES (default 50KB,
 *      env-overridable) with a truncation note — a per-call ceiling matching pi.
 * Exported for unit tests.
 */
export function boundedMcpToolContent(
  result: unknown,
  maxBytes: number = RUNTIME_TOOL_RESULT_MAX_BYTES,
): Array<{ type: "text"; text: string }> {
  let text: string;
  if (typeof result === "string") {
    text = result;
  } else if (isRecord(result) && Array.isArray(result.content)) {
    text = result.content
      .map((part) =>
        isRecord(part) && typeof part.text === "string"
          ? part.text
          : typeof part === "string"
            ? part
            : JSON.stringify(part),
      )
      .join("\n");
  } else if (isRecord(result)) {
    // No content array — serialize the object but strip `details` so a large
    // `details.raw` never reaches the model.
    const { details: _details, ...rest } = result;
    text = JSON.stringify(rest);
  } else {
    text = JSON.stringify(result ?? null);
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    const note = `\n\n[Tool output truncated: exceeded the ${(maxBytes / 1024).toFixed(0)}KB per-call cap. Narrow the tool's arguments (lower limits / tighter filters) and retry.]`;
    const room = Math.max(0, maxBytes - Buffer.byteLength(note, "utf8"));
    text = `${Buffer.from(text, "utf8").subarray(0, room).toString("utf8")}${note}`;
  }
  return [{ type: "text", text }];
}

function createRuntimeToolsMcpServer(ctx: RuntimeToolMcpContext): Server {
  const definitions = buildCuratedRuntimeToolDefinitions(ctx);
  const byName = new Map(definitions.map((def) => [def.name, def]));

  // Composio integration tools (Gmail, Slack, …) are dynamic — one per tool of
  // each ACTIVE connected toolkit for this workspace — so they can't live in the
  // static curated list. `pi` resolves them in-process via the same helper and
  // folds them into its toolset; CLI harnesses only reach Holaboss over MCP, so
  // resolve them here too and expose them on this server. Without this the
  // capability manifest advertises the connected tools to the model but there's
  // no callable surface, so the agent reports it "can't use" them. Resolved once
  // per MCP session (i.e. per run), so a freshly-connected integration shows up
  // on the next run — the same as pi.
  let composioToolsPromise: Promise<HarnessRuntimeToolDefinitionLike[]> | null =
    null;
  const ensureComposioTools = (): Promise<HarnessRuntimeToolDefinitionLike[]> => {
    if (!composioToolsPromise) {
      composioToolsPromise = resolveComposioInlineTools({
        runtimeApiBaseUrl: ctx.runtimeApiBaseUrl,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        inputId: ctx.inputId,
        selectedModel: ctx.selectedModel,
      })
        .then((result) => {
          for (const tool of result.tools) {
            // Curated runtime tools win a name collision (composio tool names
            // are toolkit-prefixed, so this shouldn't happen in practice).
            if (!byName.has(tool.name)) {
              byName.set(tool.name, tool);
            }
          }
          return result.tools;
        })
        .catch(() => []);
    }
    return composioToolsPromise;
  };

  // Browser tools (browser_navigate, browser_click, …) are a third family —
  // not curated runtime tools, not Composio. pi resolves them in-process via
  // this same resolver when its per-run `browser_tools_enabled` flag is set;
  // CLI harnesses reach Holaboss only over MCP, so honor the same gate here.
  // The harness injects `x-holaboss-browser-tools-enabled` (mirroring pi's
  // session-kind gate); when it's off we skip the resolver entirely. When it's
  // on, the resolver still self-gates on the desktop browser capability being
  // reachable, so a run without a live browser yields an empty set — matching
  // pi. Resolved once per MCP session (per run), like composio.
  let browserToolsPromise: Promise<HarnessRuntimeToolDefinitionLike[]> | null =
    null;
  const ensureBrowserTools = (): Promise<HarnessRuntimeToolDefinitionLike[]> => {
    if (!ctx.browserToolsEnabled) {
      return Promise.resolve([]);
    }
    if (!browserToolsPromise) {
      browserToolsPromise = resolveHarnessDesktopBrowserToolDefinitions({
        runtimeApiBaseUrl: ctx.runtimeApiBaseUrl,
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
        inputId: ctx.inputId,
        space: ctx.browserSpace,
      })
        .then((tools) => {
          for (const tool of tools) {
            // Curated runtime tools win a name collision (browser tool names are
            // `browser_*`-prefixed, so this shouldn't happen in practice).
            if (!byName.has(tool.name)) {
              byName.set(tool.name, tool);
            }
          }
          return tools;
        })
        .catch(() => []);
    }
    return browserToolsPromise;
  };

  const server = new Server(
    { name: "holaboss-runtime-tools", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await Promise.all([ensureComposioTools(), ensureBrowserTools()]);
    // `byName` now holds curated runtime tools + any resolved composio +
    // browser tools, deduped by name.
    return {
      tools: [...byName.values()].map((def) => ({
        name: def.name,
        description: def.description,
        // Runtime tool `parameters` are already JSON Schema object schemas.
        inputSchema: def.parameters as { type: "object"; [key: string]: unknown },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (callRequest) => {
    // Make sure composio + browser tools are merged before we look the call up —
    // a client could call a tool it discovered on a prior ListTools without
    // re-listing.
    await Promise.all([ensureComposioTools(), ensureBrowserTools()]);
    const def = byName.get(callRequest.params.name);
    if (!def) {
      return {
        isError: true,
        content: [
          { type: "text", text: `unknown runtime tool: ${callRequest.params.name}` },
        ],
      };
    }
    try {
      const args = isRecord(callRequest.params.arguments)
        ? callRequest.params.arguments
        : {};
      const result = await def.execute(randomUUID(), args, undefined);
      // Forward only the bounded, model-facing content — not the whole envelope
      // (whose `details.raw` can be 300KB+ and would blow up the harness context).
      return { content: boundedMcpToolContent(result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });

  return server;
}

function mcpSessionHeader(request: FastifyRequest): string | undefined {
  const value = request.headers["mcp-session-id"];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Path CLI harnesses point their injected `holaboss_runtime_tools` MCP server
 * at. Kept distinct from the oRPC `/mcp` mount so the two surfaces stay
 * decoupled.
 */
export const RUNTIME_TOOLS_MCP_PREFIX = "/mcp/runtime-tools";

/**
 * Mounts the runtime-tools MCP bridge (Streamable HTTP) on the runtime's
 * Fastify app. Sessions are tracked by `mcp-session-id`: an initialize request
 * builds a server bound to that request's per-run context headers; later
 * requests on the same session reuse it. Mirrors the `/mcp` (oRPC) mount.
 */
export function mountRuntimeToolsMcp(
  app: FastifyInstance,
  options: { prefix?: `/${string}` } = {},
): void {
  const prefix: `/${string}` = options.prefix ?? RUNTIME_TOOLS_MCP_PREFIX;
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.all(prefix, async (request, reply) => {
    const sessionId = mcpSessionHeader(request);
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (request.method !== "POST" || !isInitializeRequest(request.body)) {
        reply.code(400).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid MCP session" },
          id: null,
        });
        return;
      }
      const server = createRuntimeToolsMcpServer(
        readRuntimeToolMcpContext(request),
      );
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          transports.set(id, created);
        },
      });
      created.onclose = () => {
        if (created.sessionId) {
          transports.delete(created.sessionId);
        }
      };
      await server.connect(created);
      transport = created;
    }

    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
}
