import type { AppHandleInternal } from "../app.ts"
import type {
  ActionRunResult,
  BridgeClient,
  RowRecord,
  TurnContext,
} from "../types.ts"

export const LOCAL_APP_ACTION_API_PATH = "/__holaboss/actions/run"
export const LOCAL_APP_ACTION_HEALTH_PATH = "/__holaboss/actions/health"

export interface LocalAppActionTurnContext {
  turnId?: string | null
  inputId?: string | null
  sessionId?: string | null
}

export interface LocalAppActionInvokeParams {
  actionName: string
  rowId?: string | null
  resourceName?: string | null
  rowData?: Record<string, unknown> | null
  rowStatus?: string | null
  input?: Record<string, unknown> | null
  turnContext?: LocalAppActionTurnContext | null
}

export interface LocalAppActionRowPayload {
  id: string
  resource: string
  status: string
  data: Record<string, unknown>
  external_id: string | null
  error_message: string | null
  created_in_turn: string | null
  session_id: string | null
  created_at: string
  updated_at: string
}

export interface LocalAppActionInvokeResult {
  ok: boolean
  created_row: boolean
  row: LocalAppActionRowPayload | null
  action: ActionRunResult
}

export interface LocalAppActionApi {
  invoke(params: LocalAppActionInvokeParams): Promise<LocalAppActionInvokeResult>
  handleRequest(request: Request): Promise<Response>
}

export function createLocalAppActionApi(params: {
  app: AppHandleInternal
  bridge: BridgeClient
}): LocalAppActionApi {
  const { app, bridge } = params

  async function invoke(input: LocalAppActionInvokeParams): Promise<LocalAppActionInvokeResult> {
    const actionName = nonEmptyString(input.actionName)
    if (!actionName) {
      throw new Error("actionName is required")
    }

    const turnContext = normalizedTurnContext(input.turnContext)
    const providedRowId = nonEmptyString(input.rowId)
    let createdRow = false
    let rowId: string

    if (providedRowId) {
      rowId = providedRowId
    } else {
      const resourceName = nonEmptyString(input.resourceName)
      if (!resourceName) {
        throw new Error("resourceName is required when rowId is omitted")
      }
      const resource = app._resources.get(resourceName)
      if (!resource) {
        throw new Error(`resource '${resourceName}' is not registered`)
      }
      if (!isRecord(input.rowData)) {
        throw new Error("rowData must be an object when rowId is omitted")
      }
      const row = app.createRow(resource, input.rowData, {
        status: nonEmptyString(input.rowStatus) ?? undefined,
        turnContext: turnContext ?? undefined,
      })
      rowId = row.id
      createdRow = true
    }

    const action = await app.runAction({
      actionName,
      rowId,
      input: isRecord(input.input) ? input.input : {},
      bridge,
      turnContext: turnContext ?? undefined,
    })
    const row = app._state.getRow(rowId) ?? null

    return {
      ok: !("fail" in action),
      created_row: createdRow,
      row: row ? rowPayload(row) : null,
      action,
    }
  }

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "GET" && url.pathname === LOCAL_APP_ACTION_HEALTH_PATH) {
      return jsonResponse(200, {
        ok: true,
        path: LOCAL_APP_ACTION_API_PATH,
      })
    }
    if (request.method !== "POST" || url.pathname !== LOCAL_APP_ACTION_API_PATH) {
      return jsonResponse(404, {
        ok: false,
        error: { code: "not_found", message: "Not found" },
      })
    }

    let parsed: unknown
    try {
      parsed = await request.json()
    } catch {
      return jsonResponse(400, {
        ok: false,
        error: { code: "invalid_json", message: "request body must be valid JSON" },
      })
    }
    if (!isRecord(parsed)) {
      return jsonResponse(400, {
        ok: false,
        error: { code: "invalid_body", message: "request body must be an object" },
      })
    }

    try {
      const result = await invoke({
        actionName:
          nonEmptyString(parsed.action_name) ??
          nonEmptyString(parsed.actionName) ??
          "",
        rowId:
          nonEmptyString(parsed.row_id) ??
          nonEmptyString(parsed.rowId) ??
          null,
        resourceName:
          nonEmptyString(parsed.resource_name) ??
          nonEmptyString(parsed.resourceName) ??
          null,
        rowData: isRecord(parsed.row_data)
          ? parsed.row_data
          : isRecord(parsed.rowData)
            ? parsed.rowData
            : null,
        rowStatus:
          nonEmptyString(parsed.row_status) ??
          nonEmptyString(parsed.rowStatus) ??
          null,
        input: isRecord(parsed.input) ? parsed.input : null,
        turnContext:
          normalizedTurnContextFromBody(parsed.turn_context) ??
          normalizedTurnContextFromBody(parsed.turnContext) ??
          normalizedTurnContextFromHeaders(request.headers),
      })
      return jsonResponse(200, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status =
        /not registered|not found|required/i.test(message) ? 404
        : /must be an object|must be valid JSON|invalid/i.test(message) ? 400
        : /not allowed from state/i.test(message) ? 409
        : 500
      return jsonResponse(status, {
        ok: false,
        error: {
          code: status === 500 ? "action_failed" : "invalid_request",
          message,
        },
      })
    }
  }

  return {
    invoke,
    handleRequest,
  }
}

function normalizedTurnContext(
  turnContext: LocalAppActionTurnContext | null | undefined,
): TurnContext | null {
  if (!turnContext) {
    return null
  }
  const sessionId = nonEmptyString(turnContext.sessionId)
  const turnId = nonEmptyString(turnContext.turnId) ?? nonEmptyString(turnContext.inputId)
  const inputId = nonEmptyString(turnContext.inputId) ?? turnId
  if (!sessionId || !turnId) {
    return null
  }
  return {
    sessionId,
    turnId,
    ...(inputId ? { inputId } : {}),
  }
}

function normalizedTurnContextFromBody(value: unknown): LocalAppActionTurnContext | null {
  if (!isRecord(value)) {
    return null
  }
  return {
    turnId: nonEmptyString(value.turn_id) ?? nonEmptyString(value.turnId) ?? null,
    inputId: nonEmptyString(value.input_id) ?? nonEmptyString(value.inputId) ?? null,
    sessionId: nonEmptyString(value.session_id) ?? nonEmptyString(value.sessionId) ?? null,
  }
}

function normalizedTurnContextFromHeaders(headers: Headers): LocalAppActionTurnContext | null {
  const sessionId = nonEmptyString(headers.get("x-holaboss-session-id"))
  const inputId = nonEmptyString(headers.get("x-holaboss-input-id"))
  const turnId = nonEmptyString(headers.get("x-holaboss-turn-id")) ?? inputId
  if (!sessionId || !turnId) {
    return null
  }
  return {
    sessionId,
    turnId,
    inputId,
  }
}

function rowPayload(row: RowRecord): LocalAppActionRowPayload {
  return {
    id: row.id,
    resource: row.resource,
    status: row.status,
    data: { ...row.data },
    external_id: row.externalId ?? null,
    error_message: row.errorMessage ?? null,
    created_in_turn: row.createdInTurn ?? null,
    session_id: row.sessionId ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null
}
