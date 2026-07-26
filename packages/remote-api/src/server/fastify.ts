import { RPCHandler } from "@orpc/server/fastify";
import { CORSPlugin } from "@orpc/server/plugins";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  generateRequestId,
  REQUEST_ID_HEADER,
  type RemoteApiLogger,
} from "../logging";
import type { RemoteApiContext } from "./context";
import { remoteApiRouter } from "./router";

/** The host-supplied part of the context — requestId/logger are filled per request. */
type BaseRemoteApiContext = Omit<RemoteApiContext, "requestId" | "logger">;

export interface MountRemoteApiOptions {
  /** Route prefix the RPC handler is mounted under. Defaults to `/rpc`. */
  prefix?: `/${string}`;
  /**
   * The per-request base context (or a factory). The runtime supplies its
   * workspaces service implementation here.
   */
  context:
    | BaseRemoteApiContext
    | ((
        request: FastifyRequest
      ) => BaseRemoteApiContext | Promise<BaseRemoteApiContext>);
  /** Logger the request-path middleware writes through (e.g. a pino adapter). */
  logger?: RemoteApiLogger;
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Mounts the Remote API oRPC router on an existing Fastify instance. Coexists
 * with the runtime's REST routes — only requests under `prefix` are handled.
 * Each request gets a correlation id (honored from `x-request-id` if the client
 * sent one, otherwise generated) that the logging middleware stamps on every
 * line and that is echoed back in the response header.
 */
export function mountRemoteApi(
  app: FastifyInstance,
  options: MountRemoteApiOptions
): void {
  const prefix: `/${string}` = options.prefix ?? "/rpc";
  const handler = new RPCHandler(remoteApiRouter, {
    plugins: [new CORSPlugin()],
  });

  app.all(`${prefix}/*`, async (request, reply) => {
    const base =
      typeof options.context === "function"
        ? await options.context(request)
        : options.context;
    const requestId = headerValue(request, REQUEST_ID_HEADER) ?? generateRequestId();
    reply.header(REQUEST_ID_HEADER, requestId);

    const context: RemoteApiContext = {
      ...base,
      requestId,
      logger: options.logger,
    };
    const { matched } = await handler.handle(request, reply, {
      prefix,
      context,
    });
    if (!matched) {
      reply.status(404).send({ detail: "not found" });
    }
  });
}
