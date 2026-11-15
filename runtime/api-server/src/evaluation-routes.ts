import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { EvaluationServiceError, type EvaluationService } from "./evaluation-service.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function bundledHolaevalPath(): string {
  return path.join(
    MODULE_DIR,
    "embedded-capabilities",
    "local-model-review",
    "skills",
    "run-model-eval",
    "holaeval.py",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sessionIdFrom(request: FastifyRequest): string {
  const header = request.headers["x-holaboss-session-id"];
  const value = Array.isArray(header) ? header[0] : header;
  const body = isRecord(request.body) ? request.body : {};
  const fromBody = typeof body.session_id === "string" ? body.session_id : "";
  const sessionId = (value ?? fromBody ?? "").trim();
  if (!sessionId) {
    throw new EvaluationServiceError("NOT_FOUND", "no session id on the request");
  }
  return sessionId;
}

function send(reply: FastifyReply, run: () => unknown) {
  try {
    return reply.send(run());
  } catch (error) {
    if (error instanceof EvaluationServiceError) {
      return reply.code(error.statusCode).send({ detail: error.message, code: error.code });
    }
    return reply.code(500).send({ detail: error instanceof Error ? error.message : "evaluation request failed" });
  }
}

export function registerEvaluationAgentRoutes(app: FastifyInstance, service: () => EvaluationService): void {
  app.get("/api/v1/evaluations/agent", (request, reply) => send(reply, () => service().agentGet(sessionIdFrom(request))));

  app.post("/api/v1/evaluations/agent/plan", (request, reply) =>
    send(reply, () => {
      const body = isRecord(request.body) ? request.body : {};
      const { session_id: _sessionId, ...plan } = body;
      return service().agentSetPlan(sessionIdFrom(request), plan);
    }),
  );

  app.post("/api/v1/evaluations/agent/followups", (request, reply) =>
    send(reply, () => {
      const body = isRecord(request.body) ? request.body : {};
      return service().agentProposeFollowup(sessionIdFrom(request), {
        title: typeof body.title === "string" ? body.title : "",
        rationale: typeof body.rationale === "string" ? body.rationale : "",
        evidence: Array.isArray(body.evidence) ? body.evidence : [],
        runs: Array.isArray(body.runs) ? body.runs : [],
        estimate_minutes: typeof body.estimate_minutes === "number" ? body.estimate_minutes : null,
      });
    }),
  );

  app.post("/api/v1/evaluations/agent/opinion", (request, reply) =>
    send(reply, () => {
      const body = isRecord(request.body) ? request.body : {};
      if (typeof body.opinion_md !== "string") {
        throw new EvaluationServiceError("INVALID_PLAN", "opinion_md is required");
      }
      return service().agentWriteOpinion(sessionIdFrom(request), body.opinion_md);
    }),
  );

  app.post("/api/v1/evaluations/agent/posts", (request, reply) =>
    send(reply, () => {
      const body = isRecord(request.body) ? request.body : {};
      const allowed = ["x_post", "x_thread", "cn_post", "video_script"];
      const distribution = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
      if (Object.keys(distribution).length === 0) {
        throw new EvaluationServiceError("INVALID_PLAN", "pass at least one of x_post, x_thread, cn_post, video_script");
      }
      return service().agentDraftPosts(sessionIdFrom(request), distribution);
    }),
  );
}
