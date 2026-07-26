import { implement, ORPCError } from "@orpc/server";
import { remoteApiContract } from "../contract";
import { errorLogFields, workspaceIdFromInput } from "../logging";
import type { RemoteApiContext } from "./context";

const base = implement(remoteApiContract).$context<RemoteApiContext>();

const SERVER_EVENT = "remote_api.server.request";

// Wraps every procedure: one start line, one success/error line with duration,
// all carrying the same requestId so a single grep reconstructs the call. No-op
// when no logger is in context (e.g. in-process unit tests).
const loggingMiddleware = base.middleware(async ({ context, next, path }, input) => {
  const logger = context.logger;
  if (!logger) {
    return next();
  }
  const procedure = path.join(".");
  const requestId = context.requestId;
  const workspaceId = workspaceIdFromInput(input);
  const startedAt = Date.now();
  logger.info(SERVER_EVENT, {
    event: SERVER_EVENT,
    outcome: "start",
    requestId,
    procedure,
    workspaceId,
  });
  try {
    const result = await next();
    logger.info(SERVER_EVENT, {
      event: SERVER_EVENT,
      outcome: "success",
      requestId,
      procedure,
      workspaceId,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    logger.error(SERVER_EVENT, {
      event: SERVER_EVENT,
      outcome: "error",
      requestId,
      procedure,
      workspaceId,
      durationMs: Date.now() - startedAt,
      ...errorLogFields(error),
    });
    throw error;
  }
});

// Authorization seam. When an identity is in context (the boundary verified a
// workspace token), assert the addressed workspace is the one the token grants.
// When absent (in-process path), no-op — so threading identity later changes no
// call sites. v1 enforces only the workspace match; scope checks are deferred.
const authzMiddleware = base.middleware(async ({ context, next }, input) => {
  const identity = context.identity;
  if (!identity) {
    return next();
  }
  const requestedWorkspaceId = workspaceIdFromInput(input);
  if (requestedWorkspaceId && requestedWorkspaceId !== identity.workspaceId) {
    throw new ORPCError("FORBIDDEN", {
      message: "caller is not authorized for the requested workspace",
    });
  }
  return next();
});

export const os = base.use(loggingMiddleware).use(authzMiddleware);
