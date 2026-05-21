import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  ComposioService,
  ComposioToolExecutionError,
  type ComposioServiceConfig,
} from "./composio-service.js";

/**
 * One Composio tool exposure: maps an MCP tool name visible to the agent
 * to a Composio (toolkit, tool_slug, connected_account) triple. Schemas
 * come straight from Composio's tool catalog (see Step 0 appendix in
 * docs/plans/2026-05-19-agent-direct-integration-tools.md).
 */
export interface ComposioMcpToolEntry {
  name: string;
  description: string;
  toolkit_slug: string;
  tool_slug: string;
  connected_account_id: string;
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface ComposioMcpHostCliRequest {
  host: string;
  port: number;
  server_name: string;
  hono_base_url: string;
  auth_cookie: string;
  tools_json_base64: string;
}

type ComposioMcpHostDeps = {
  createHttpServer?: typeof createServer;
  logger?: Pick<typeof console, "error" | "info">;
  composioService?: ComposioService;
};

const MCP_METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed." },
  id: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, key: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return Number(value);
}

export function decodeComposioMcpHostCliRequest(encoded: string): ComposioMcpHostCliRequest {
  const trimmed = encoded.trim();
  if (!trimmed) {
    throw new Error("request_base64 is required");
  }
  const raw = Buffer.from(trimmed, "base64").toString("utf8");
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("request payload must be an object");
  }
  return {
    host: requiredString(parsed.host ?? "127.0.0.1", "host"),
    port: requiredPositiveInteger(parsed.port, "port"),
    server_name: requiredString(parsed.server_name ?? "holaboss_composio", "server_name"),
    hono_base_url: requiredString(parsed.hono_base_url, "hono_base_url"),
    auth_cookie: requiredString(parsed.auth_cookie, "auth_cookie"),
    tools_json_base64: requiredString(parsed.tools_json_base64, "tools_json_base64"),
  };
}

export function decodeComposioMcpToolCatalog(encoded: string): ComposioMcpToolEntry[] {
  const trimmed = encoded.trim();
  if (!trimmed) {
    return [];
  }
  const raw = Buffer.from(trimmed, "base64").toString("utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("composio tool catalog must be an array");
  }
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`composio tool catalog entry ${index} must be an object`);
    }
    return {
      name: requiredString(entry.name, `catalog[${index}].name`),
      description: typeof entry.description === "string" ? entry.description : "",
      toolkit_slug: requiredString(entry.toolkit_slug, `catalog[${index}].toolkit_slug`),
      tool_slug: requiredString(entry.tool_slug, `catalog[${index}].tool_slug`),
      connected_account_id: requiredString(
        entry.connected_account_id,
        `catalog[${index}].connected_account_id`,
      ),
      input_schema: isRecord(entry.input_schema)
        ? entry.input_schema
        : { type: "object", properties: {} },
      output_schema: isRecord(entry.output_schema) ? entry.output_schema : undefined,
      annotations: isRecord(entry.annotations) ? entry.annotations : undefined,
    };
  });
}

interface ToolListEntry {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

function entryToToolListing(entry: ComposioMcpToolEntry): ToolListEntry {
  return {
    name: entry.name,
    description: entry.description || `Composio ${entry.toolkit_slug}.${entry.tool_slug}`,
    inputSchema: entry.input_schema,
    outputSchema: entry.output_schema,
    annotations: entry.annotations,
  };
}

interface ToolErrorResult {
  content: Array<Record<string, unknown>>;
  isError: true;
  structuredContent?: Record<string, unknown>;
}

function toolErrorResult(message: string, structured?: Record<string, unknown>): ToolErrorResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/**
 * Build the MCP tool-call handler. Kept as a separate factory so unit
 * tests can exercise it without spinning up the HTTP server.
 */
export function buildCallToolHandler(
  catalog: ComposioMcpToolEntry[],
  composio: ComposioService,
) {
  const byName = new Map(catalog.map((entry) => [entry.name, entry]));
  return async (toolName: string, args: Record<string, unknown>) => {
    const entry = byName.get(toolName);
    if (!entry) {
      return toolErrorResult(`Unknown Composio tool: ${toolName}`);
    }
    try {
      const result = await composio.executeTool({
        toolSlug: entry.tool_slug,
        connectedAccountId: entry.connected_account_id,
        arguments: args,
      });
      const payload = (result.data ?? null) as Record<string, unknown> | null;
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload ?? undefined,
        _meta: result.logId ? { composio_log_id: result.logId } : undefined,
      };
    } catch (error) {
      if (error instanceof ComposioToolExecutionError) {
        return toolErrorResult(
          error.detail.message ?? `Composio tool ${entry.tool_slug} failed`,
          { error: error.detail, http_status: error.httpStatus },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult(message);
    }
  };
}

function jsonResponse(
  response: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

function getRequestPath(request: IncomingMessage): string {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  return url.pathname;
}

async function handleMcpPost(
  request: IncomingMessage,
  response: ServerResponse,
  serverName: string,
  tools: ToolListEntry[],
  callHandler: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  const server = new Server(
    { name: serverName, version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (callRequest) => {
    const args = isRecord(callRequest.params.arguments) ? callRequest.params.arguments : {};
    return (await callHandler(callRequest.params.name, args)) as Record<string, unknown>;
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  await transport.handleRequest(request, response);
}

export async function startComposioMcpHost(
  request: ComposioMcpHostCliRequest,
  deps: ComposioMcpHostDeps = {},
): Promise<HttpServer> {
  const catalog = decodeComposioMcpToolCatalog(request.tools_json_base64);
  const serviceConfig: ComposioServiceConfig = {
    honoBaseUrl: request.hono_base_url,
    authCookie: request.auth_cookie,
  };
  const composio = deps.composioService ?? new ComposioService(serviceConfig);
  const tools = catalog.map(entryToToolListing);
  const callHandler = buildCallToolHandler(catalog, composio);

  const logger = deps.logger ?? console;
  const serverFactory = deps.createHttpServer ?? createServer;

  const httpServer = serverFactory(async (incoming, outgoing) => {
    const requestPath = getRequestPath(incoming);
    if (requestPath !== "/mcp") {
      jsonResponse(outgoing, 404, {
        jsonrpc: "2.0",
        error: { code: -32601, message: "Not found" },
        id: null,
      });
      return;
    }
    if (incoming.method !== "POST") {
      jsonResponse(outgoing, 405, MCP_METHOD_NOT_ALLOWED);
      return;
    }

    try {
      await handleMcpPost(incoming, outgoing, request.server_name, tools, callHandler);
    } catch (error) {
      logger.error("Composio MCP host request failed", error);
      if (!outgoing.headersSent) {
        jsonResponse(outgoing, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(request.port, request.host, () => resolve());
  });

  logger.info(
    "Starting Composio MCP host at %s:%s with %s tools",
    request.host,
    request.port,
    tools.length,
  );
  return httpServer;
}

export async function runComposioMcpHostCli(
  argv: string[],
  deps: ComposioMcpHostDeps = {},
): Promise<number> {
  const requestBase64 = argv[0] === "--request-base64" ? argv[1] ?? "" : argv[0] ?? "";
  if (!requestBase64) {
    process.stderr.write("request_base64 is required\n");
    return 2;
  }

  let server: HttpServer | null = null;
  try {
    const request = decodeComposioMcpHostCliRequest(requestBase64);
    server = await startComposioMcpHost(request, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }

  const shutdown = async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await new Promise<void>(() => {});
  return 0;
}

async function main(): Promise<void> {
  process.exitCode = await runComposioMcpHostCli(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
