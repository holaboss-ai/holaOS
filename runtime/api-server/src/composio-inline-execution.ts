import {
  ComposioToolExecutionError,
  type ComposioService,
} from "./composio-service.js";
import { classifyPublishAction } from "./publish-action-classifier.js";
import {
  publishApprovalUnavailable,
  type PublishApprovalDecision,
  type PublishApprovalGate,
} from "./publish-approval-gate.js";

export interface ComposioInlineExecuteResult {
  ok: boolean;
  data: unknown;
  log_id: string | null;
  error?: {
    code: string;
    message: string;
    toolkit_slug: string;
    http_status?: number;
    response_body?: string;
    cf_ray?: string;
    origin_server?: string;
  };
  error_marker?: string;
  /** True when the error means "this connected account is no longer usable"
   *  (revoked / expired credential). Composio (remote) is the single source of
   *  truth for connection STATUS — we never write it locally; this flag only
   *  REPORTS the auth failure so the caller can invalidate cached schemas and
   *  surface a reconnect prompt. On the next resolve the remote-first resolver
   *  picks whatever account Composio now reports active (self-heal). */
  auth_failure?: boolean;
}

const COMPOSIO_AUTH_FAILURE_CODES = new Set<string>([
  "forbidden",
  "unauthorized",
  "auth_expired",
  "invalid_credentials",
  "token_expired",
  "invalid_token",
  "expired_credentials",
]);

/** Whether the Composio error means the connected account's credential is
 *  revoked / expired (vs a transient infra error or a mere scope gap).
 *  Conservative on purpose: only 401, or 403 with an explicit auth-failure
 *  code, counts. */
export function isComposioAuthFailure(
  httpStatus: number,
  code: string,
): boolean {
  if (httpStatus === 401) return true;
  if (httpStatus === 403 && COMPOSIO_AUTH_FAILURE_CODES.has(code.toLowerCase())) {
    return true;
  }
  return false;
}

export interface ComposioPublishApprovalContext {
  gate: PublishApprovalGate;
  workspaceId: string;
  sessionId: string;
  inputId?: string | null;
}

function publishApprovalBlock(params: {
  toolkitSlug: string;
  toolSlug: string;
  connectedAccountId: string;
  arguments: Record<string, unknown>;
  publishApproval?: ComposioPublishApprovalContext | null;
}): ComposioInlineExecuteResult | null {
  const action = classifyPublishAction({
    toolkitSlug: params.toolkitSlug,
    toolSlug: params.toolSlug,
  });
  if (!action) {
    return null;
  }
  let decision: PublishApprovalDecision = publishApprovalUnavailable();
  if (params.publishApproval) {
    try {
      decision = params.publishApproval.gate.authorize({
        workspaceId: params.publishApproval.workspaceId,
        sessionId: params.publishApproval.sessionId,
        inputId: params.publishApproval.inputId ?? null,
        action,
        toolkitSlug: params.toolkitSlug,
        connectedAccountId: params.connectedAccountId,
        arguments: params.arguments ?? {},
      });
    } catch {
      decision = publishApprovalUnavailable();
    }
  }
  if (decision.allowed) {
    return null;
  }
  return {
    ok: false,
    data: null,
    log_id: null,
    error: {
      code: decision.code,
      message: decision.message,
      toolkit_slug: params.toolkitSlug,
    },
    error_marker: `[composio_error:${decision.code}:${params.toolkitSlug}] ${decision.message}`,
    auth_failure: false,
  };
}

export async function executeComposioInlineTool(params: {
  composio: ComposioService;
  toolkitSlug: string;
  toolSlug: string;
  connectedAccountId: string;
  arguments: Record<string, unknown>;
  publishApproval?: ComposioPublishApprovalContext | null;
}): Promise<ComposioInlineExecuteResult> {
  const blocked = publishApprovalBlock(params);
  if (blocked) {
    return blocked;
  }
  try {
    const result = await params.composio.executeTool({
      toolSlug: params.toolSlug,
      connectedAccountId: params.connectedAccountId,
      arguments: params.arguments ?? {},
    });
    return {
      ok: true,
      data: result.data ?? null,
      log_id: result.logId,
    };
  } catch (error) {
    if (error instanceof ComposioToolExecutionError) {
      const code = error.detail.code || "unknown_error";
      const message =
        error.detail.message ?? `Composio tool ${params.toolSlug} failed`;
      return {
        ok: false,
        data: null,
        log_id: null,
        error: {
          code,
          message,
          toolkit_slug: params.toolkitSlug,
          http_status: error.httpStatus,
          response_body: error.detail.responseBody,
          cf_ray: error.detail.cfRay,
          origin_server: error.detail.originServer,
        },
        error_marker: `[composio_error:${code}:${params.toolkitSlug}] ${message}`,
        auth_failure: isComposioAuthFailure(error.httpStatus, code),
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      data: null,
      log_id: null,
      error: {
        code: "unknown_error",
        message,
        toolkit_slug: params.toolkitSlug,
      },
      error_marker: `[composio_error:unknown_error:${params.toolkitSlug}] ${message}`,
      auth_failure: false,
    };
  }
}
