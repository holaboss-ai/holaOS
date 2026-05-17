// Executes an action against a row.
// Runtime layer treats row data as Record<string, unknown>; agent-facing
// callbacks receive the inferred row type (handled by app.ts type signatures).

import type {
  ActionDef,
  BridgeClient,
  EmitConfig,
  ResourceDef,
  Step,
  StepResult,
} from "../types.ts"
import type { ZodTypeAny } from "zod"
import type { RuntimeState } from "./state.ts"

interface RunOpts {
  resourceName: string
  resourceDef: ResourceDef<ZodTypeAny, any>
  actionName: string
  actionDef: ActionDef<Record<string, unknown>, any, any>
  rowId: string
  input: Record<string, unknown>
  bridge: BridgeClient
  state: RuntimeState
  appId: string
}

export async function runAction(
  opts: RunOpts,
): Promise<{ ok: true; externalId?: string } | { fail: { code: string; message: string } }> {
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
      if (resourceDef.failedState !== undefined) {
        patch.status = resourceDef.failedState as string
      }
      state.updateRow(rowId, patch)

      if (resourceDef.failedState !== undefined) {
        syncOutput(
          state, resourceName, rowId, resourceDef.emit,
          resourceDef.failedState as string,
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
    state.pushAudit("step.complete", {
      app: appId, step: step.name, outcome: "ok", duration_ms: stepDur,
    })
  }

  if (actionDef.toState !== null) {
    state.updateRow(rowId, {
      status: actionDef.toState as string,
      ...(externalId ? { externalId } : {}),
    })
    const finalRow = state.getRow(rowId)!
    syncOutput(
      state, resourceName, rowId, resourceDef.emit,
      actionDef.toState as string,
      finalRow.data,
      finalRow.externalId,
    )
  }

  state.pushAudit("action.end", {
    app: appId, action: actionName, outcome: "ok",
    external_id: externalId,
    total_duration_ms: Date.now() - startTime,
  })

  return { ok: true, externalId }
}

function syncOutput(
  state: RuntimeState,
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
