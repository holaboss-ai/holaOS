// Executes an action against a row.
// Runtime layer treats row data as Record<string, unknown>; agent-facing
// callbacks receive the inferred row type (handled by app.ts type signatures).

import type {
  ActionDef,
  ActionRunResult,
  BridgeClient,
  EmitConfig,
  ResourceDef,
  StateBackend,
  Step,
  StepResult,
  TurnContext,
} from "../types.ts"
import type { ZodTypeAny } from "zod"

interface RunOpts {
  resourceName: string
  resourceDef: ResourceDef<ZodTypeAny, any>
  actionName: string
  actionDef: ActionDef<Record<string, unknown>, any, any>
  rowId: string
  input: Record<string, unknown>
  bridge: BridgeClient
  state: StateBackend
  appId: string
  turnContext: TurnContext | null
}

export async function runAction(
  opts: RunOpts,
): Promise<ActionRunResult> {
  const {
    resourceName, resourceDef, actionName, actionDef,
    rowId, input, bridge, state, appId,
  } = opts

  const row = state.getRow(rowId)
  if (!row) return { fail: { code: "not_found", message: `row ${rowId} not found` } }

  if (!(actionDef.fromStates as readonly string[]).includes(row.status)) {
    return {
      fail: {
        code: "invalid_state",
        message: `action ${actionName} not allowed from state '${row.status}' (allowed: ${actionDef.fromStates.join("|")})`,
      },
    }
  }

  state.pushAudit("action.start", {
    app: appId, resource: resourceName, action: actionName,
    row_id: rowId, turn_id: row.createdInTurn, input,
  })

  const startTime = Date.now()
  const steps: Step<Record<string, unknown>, Record<string, unknown>>[] =
    actionDef.steps ?? (actionDef.run ? [{ name: actionName, run: actionDef.run }] : [])

  if (steps.length === 0) {
    return { fail: { code: "config_error", message: "action has no run or steps" } }
  }

  const persist = async (patch: Record<string, unknown>) => {
    const merged = { ...(state.getRow(rowId)!.data as object), ...patch }
    state.updateRow(rowId, { data: merged as Record<string, unknown> })
  }
  const log = (msg: string, extra?: Record<string, unknown>) =>
    state.pushAudit("step.complete", { app: appId, msg, extra })

  let externalId: string | undefined
  let actionData: unknown = undefined
  let nextStateOverride: string | null | undefined = undefined

  for (const step of steps) {
    const currentRow = state.getRow(rowId)!
    const ctx = {
      row: {
        ...(currentRow.data as object),
        id: rowId,
        status: currentRow.status,
        external_id: currentRow.externalId,
      } as Record<string, unknown>,
      input,
      bridge,
      persist,
      log,
      turnContext: opts.turnContext,
    }

    const stepStart = Date.now()
    let result: StepResult
    try {
      result = await step.run(ctx)
    } catch (e) {
      result = {
        fail: {
          kind: "error",
          code: "unhandled_exception",
          message: e instanceof Error ? e.message : String(e),
        },
      }
    }
    const stepDur = Date.now() - stepStart

    if ("fail" in result) {
      state.pushAudit("step.complete", {
        app: appId, step: step.name, outcome: "fail",
        duration_ms: stepDur, error: result.fail,
      })

      const patch: Partial<typeof row> = { errorMessage: result.fail.message }
      const failedState = actionDef.failedState ?? resourceDef.failedState
      if (failedState !== undefined) {
        patch.status = failedState as string
      }
      state.updateRow(rowId, patch)

      if (failedState !== undefined) {
        syncOutput(
          state, resourceName, rowId, resourceDef.emit,
          failedState as string,
          state.getRow(rowId)!.data,
          state.getRow(rowId)!.externalId,
        )
      }

      const isAuth = (result.fail as { code: string }).code === "not_connected"
      state.pushNotification({
        level: "error",
        summary: `${appId} ${actionName} failed at step ${step.name}: ${result.fail.message}`,
        agentHint: isAuth
          ? `Connection expired; ask user to reconnect.`
          : `Step ${step.name} failed; retry policy may apply.`,
        ref: { kind: resourceName, id: rowId },
      })

      state.pushAudit("action.end", {
        app: appId, action: actionName, outcome: "fail",
        total_duration_ms: Date.now() - startTime,
      })
      return {
        fail: { code: (result.fail as { code: string }).code ?? "step_failed", message: result.fail.message },
      }
    }

    if (result.externalId) externalId = result.externalId
    if ("data" in result && result.data !== undefined) actionData = result.data
    if ("nextState" in result && typeof result.nextState === "string") {
      nextStateOverride = result.nextState
    }
    state.pushAudit("step.complete", {
      app: appId, step: step.name, outcome: "ok", duration_ms: stepDur,
    })
  }

  const finalState = nextStateOverride ?? actionDef.toState
  if (finalState !== null) {
    if (!(resourceDef.states as readonly string[]).includes(finalState as string)) {
      const message = `action ${actionName} resolved invalid nextState '${finalState}'`
      const patch: Partial<typeof row> = { errorMessage: message }
      const failedState = actionDef.failedState ?? resourceDef.failedState
      if (failedState !== undefined) {
        patch.status = failedState as string
      }
      state.updateRow(rowId, patch)
      if (failedState !== undefined) {
        syncOutput(
          state, resourceName, rowId, resourceDef.emit,
          failedState as string,
          state.getRow(rowId)!.data,
          state.getRow(rowId)!.externalId,
        )
      }
      state.pushAudit("action.end", {
        app: appId, action: actionName, outcome: "fail",
        total_duration_ms: Date.now() - startTime,
      })
      return {
        fail: { code: "invalid_state", message },
      }
    }
    state.updateRow(rowId, {
      status: finalState as string,
      ...(externalId ? { externalId } : {}),
    })
    const finalRow = state.getRow(rowId)!
    syncOutput(
      state, resourceName, rowId, resourceDef.emit,
      finalState as string,
      finalRow.data,
      finalRow.externalId,
    )
  }

  state.pushAudit("action.end", {
    app: appId, action: actionName, outcome: "ok",
    external_id: externalId,
    total_duration_ms: Date.now() - startTime,
  })

  return {
    ok: true,
    ...(externalId ? { externalId } : {}),
    ...(actionData !== undefined ? { data: actionData } : {}),
  }
}

function syncOutput(
  state: StateBackend,
  resourceName: string,
  rowId: string,
  emit: EmitConfig<any> | undefined,
  status: string,
  rowData: Record<string, unknown>,
  externalId?: string,
): void {
  if (!emit || emit.surface === "none") return
  const enriched = { ...rowData, id: rowId, status, external_id: externalId }
  const summary = emit.summary?.(enriched) ?? null
  const deepLink = emit.deepLink?.(enriched) ?? null
  state.upsertOutput({
    resourceName, rowId, surface: emit.surface,
    status, summary, deepLink,
  })
}
