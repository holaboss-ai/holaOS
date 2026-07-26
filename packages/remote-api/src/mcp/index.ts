import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createRouterClient } from "@orpc/server";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { outputsListInput } from "../contract/outputs";
import type { RemoteApiContext } from "../server/context";
import { remoteApiRouter } from "../server/router";

/**
 * MCP binding over the same oRPC contracts. Each exposed tool invokes the
 * router in-process, so it reuses `RemoteApiContext` and the auth middleware
 * (identity → workspace match) verbatim — agents and UI hit one contract set,
 * two transports. The exposed set is a curated subset (api-surface.md decisions
 * #17 etc.); this thin slice ships one read tool to prove the pipeline. The
 * exposure policy will move onto contract `.meta()` next.
 */
export interface CreateRemoteApiMcpServerOptions {
  /** Per-request context (services + optional identity); a factory is resolved per tool call. */
  context: RemoteApiContext | (() => RemoteApiContext | Promise<RemoteApiContext>);
  name?: string;
  version?: string;
}

export function createRemoteApiMcpServer(
  options: CreateRemoteApiMcpServerOptions,
): McpServer {
  const resolveContext = () =>
    typeof options.context === "function" ? options.context() : options.context;

  const server = new McpServer({
    name: options.name ?? "holaboss-remote-api",
    version: options.version ?? "0.1.0",
  });

  server.registerTool(
    "outputs_list",
    {
      description:
        "List a workspace's outputs (generated files and artifacts). Requires workspaceId.",
      inputSchema: outputsListInput.shape,
    },
    async (args) => {
      const client = createRouterClient(remoteApiRouter, {
        context: await resolveContext(),
      });
      const result = await client.outputs.list(args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}

type BaseRemoteApiContext = Omit<RemoteApiContext, "requestId" | "logger">;

export interface MountRemoteApiMcpOptions {
  /** Path the MCP endpoint is mounted at. Defaults to `/mcp`. */
  prefix?: `/${string}`;
  /**
   * Per-session base context (or a factory resolved at session-initialize).
   * The runtime supplies its service implementations here; attach `identity`
   * once the host verifies a workspace token and the authz middleware enforces
   * it (no-op while absent).
   */
  context:
    | BaseRemoteApiContext
    | ((
        request: FastifyRequest
      ) => BaseRemoteApiContext | Promise<BaseRemoteApiContext>);
}

function mcpSessionHeader(request: FastifyRequest): string | undefined {
  const value = request.headers["mcp-session-id"];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Mounts the MCP binding (Streamable HTTP) on an existing Fastify instance,
 * alongside the oRPC `/rpc` mount. Sessions are tracked by `mcp-session-id`: an
 * initialize request spins up a fresh server bound to that request's context;
 * later requests reuse it. Same contracts, same router, same authz as `/rpc`.
 */
export function mountRemoteApiMcp(
  app: FastifyInstance,
  options: MountRemoteApiMcpOptions
): void {
  const prefix: `/${string}` = options.prefix ?? "/mcp";
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
      const base =
        typeof options.context === "function"
          ? await options.context(request)
          : options.context;
      const server = createRemoteApiMcpServer({ context: base });
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
