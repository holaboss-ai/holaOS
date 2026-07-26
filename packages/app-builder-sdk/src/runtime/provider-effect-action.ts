import type { ZodSchema } from "zod"

import type {
  ActionDef,
  BridgeClient,
  ProxyResult,
  StateTuple,
  StepContext,
} from "../types.ts"
import {
  getIntegrationStatus,
  type IntegrationStatusCode,
  type IntegrationStatusIssue,
  type IntegrationStatusResult,
} from "./integration-status.ts"

export interface ProviderEffectBlocked {
  provider: string
  integrationKey: string
  code: IntegrationStatusCode
  message: string
  source: "readiness" | "bridge"
}

export interface ProviderEffectFailure {
  provider: string
  code: string
  message: string
  source: "readiness" | "bridge"
  upstreamStatus?: number
  upstreamBody?: unknown
}

export interface ProviderEffectSuccess<TRequest, TResult> {
  provider: string
  request: TRequest
  result: TResult
  status: number
}

export interface ProviderEffectActionOptions<
  TRow extends Record<string, unknown>,
  States extends StateTuple,
  TInput = Record<string, unknown>,
  TRequest = unknown,
  TResult = unknown,
> {
  provider: string
  fromStates: readonly States[number][]
  toState: States[number]
  blockedState: States[number]
  failedState?: States[number]
  schema?: ZodSchema<TInput>
  toolName?: string
  getStatus?: (ctx: StepContext<TRow, TInput>) => Promise<IntegrationStatusResult>
  buildRequest: (
    ctx: StepContext<TRow, TInput>,
  ) => TRequest | Promise<TRequest>
  execute: (params: {
    bridge: BridgeClient
    ctx: StepContext<TRow, TInput>
    request: TRequest
  }) => Promise<ProxyResult<TResult>>
  persistSuccess?: (
    payload: ProviderEffectSuccess<TRequest, TResult>,
    ctx: StepContext<TRow, TInput>,
  ) => Partial<TRow> | Promise<Partial<TRow>>
  persistBlocked?: (
    payload: ProviderEffectBlocked,
    ctx: StepContext<TRow, TInput>,
  ) => Partial<TRow> | Promise<Partial<TRow>>
  persistFailure?: (
    payload: ProviderEffectFailure,
    ctx: StepContext<TRow, TInput>,
  ) => Partial<TRow> | Promise<Partial<TRow>>
  deriveExternalId?: (
    payload: ProviderEffectSuccess<TRequest, TResult>,
    ctx: StepContext<TRow, TInput>,
  ) => string | number | null | undefined | Promise<string | number | null | undefined>
}

export function providerEffectAction<
  TRow extends Record<string, unknown>,
  States extends StateTuple,
  TInput = Record<string, unknown>,
  TRequest = unknown,
  TResult = unknown,
>(
  options: ProviderEffectActionOptions<TRow, States, TInput, TRequest, TResult>,
): ActionDef<TRow, States, TInput> {
  return {
    fromStates: options.fromStates,
    toState: options.toState,
    failedState: options.failedState,
    schema: options.schema,
    toolName: options.toolName,
    run: async (ctx) => {
      let readiness: IntegrationStatusResult
      try {
        readiness = options.getStatus
          ? await options.getStatus(ctx)
          : await getIntegrationStatus({ provider: options.provider })
      } catch (error) {
        const failure = readinessFailure(options.provider, error)
        await persistPatch(
          ctx,
          options.persistFailure ? await options.persistFailure(failure, ctx) : {},
        )
        return {
          fail: {
            kind: "error",
            code: failure.code,
            message: failure.message,
          },
        }
      }
      const blocked = firstBlockedIssue(readiness, options.provider)
      if (blocked) {
        await persistPatch(ctx, options.persistBlocked ? await options.persistBlocked(blocked, ctx) : {})
        return {
          ok: true,
          data: {
            blocked: true,
            provider: options.provider,
            blocker: blocked,
          },
          nextState: options.blockedState as string,
        }
      }

      const request = await options.buildRequest(ctx)
      const result = await options.execute({
        bridge: ctx.bridge,
        ctx,
        request,
      })

      if (result.kind === "error") {
        if (result.code === "not_connected") {
          const bridgeBlocked = blockedFromBridgeError(options.provider, result.message)
          await persistPatch(
            ctx,
            options.persistBlocked ? await options.persistBlocked(bridgeBlocked, ctx) : {},
          )
          return {
            ok: true,
            data: {
              blocked: true,
              provider: options.provider,
              request,
              blocker: bridgeBlocked,
            },
            nextState: options.blockedState as string,
          }
        }

        const failure = failureFromBridgeError(options.provider, result)
        await persistPatch(
          ctx,
          options.persistFailure ? await options.persistFailure(failure, ctx) : {},
        )
        return { fail: result }
      }

      const success: ProviderEffectSuccess<TRequest, TResult> = {
        provider: options.provider,
        request,
        result: result.data,
        status: result.status,
      }
      await persistPatch(
        ctx,
        options.persistSuccess ? await options.persistSuccess(success, ctx) : {},
      )

      const externalId = options.deriveExternalId
        ? await normalizeExternalId(await options.deriveExternalId(success, ctx))
        : undefined

      return {
        ok: true,
        ...(externalId ? { externalId } : {}),
        data: {
          blocked: false,
          provider: options.provider,
          request,
          result: result.data,
          status: result.status,
        },
      }
    },
  }
}

function firstBlockedIssue(
  readiness: IntegrationStatusResult,
  provider: string,
): ProviderEffectBlocked | null {
  if (readiness.ready) {
    return null
  }
  const issue = pickIssue(readiness.issues, provider)
  if (!issue) {
    return {
      provider,
      integrationKey: provider,
      code: "integration_not_connected",
      message: `Provider '${provider}' is not ready for this app.`,
      source: "readiness",
    }
  }
  return {
    provider: issue.provider || provider,
    integrationKey: issue.integrationKey || provider,
    code: issue.code,
    message: issue.message || `Provider '${provider}' is not ready for this app.`,
    source: "readiness",
  }
}

function pickIssue(
  issues: IntegrationStatusIssue[],
  provider: string,
): IntegrationStatusIssue | null {
  if (!Array.isArray(issues) || issues.length === 0) {
    return null
  }
  const normalized = provider.trim().toLowerCase()
  return (
    issues.find(
      (issue) =>
        issue.provider.trim().toLowerCase() === normalized ||
        issue.integrationKey.trim().toLowerCase() === normalized,
    ) ??
    issues[0] ??
    null
  )
}

function blockedFromBridgeError(provider: string, message: string): ProviderEffectBlocked {
  return {
    provider,
    integrationKey: provider,
    code: "integration_not_connected",
    message,
    source: "bridge",
  }
}

function failureFromBridgeError(provider: string, error: {
  code: string
  message: string
  upstreamStatus?: number
  upstreamBody?: unknown
}): ProviderEffectFailure {
  return {
    provider,
    code: error.code,
    message: error.message,
    source: "bridge",
    upstreamStatus: error.upstreamStatus,
    upstreamBody: error.upstreamBody,
  }
}

function readinessFailure(provider: string, error: unknown): ProviderEffectFailure {
  const message = error instanceof Error ? error.message : String(error)
  return {
    provider,
    code: "integration_readiness_failed",
    message,
    source: "readiness",
  }
}

async function persistPatch<TRow>(
  ctx: StepContext<TRow, unknown>,
  patch: Partial<TRow>,
): Promise<void> {
  if (Object.keys(patch as object).length === 0) {
    return
  }
  await ctx.persist(patch)
}

async function normalizeExternalId(
  value: string | number | null | undefined | Promise<string | number | null | undefined>,
): Promise<string | undefined> {
  const resolved = await value
  if (typeof resolved === "string" && resolved.trim().length > 0) {
    return resolved.trim()
  }
  if (typeof resolved === "number" && Number.isFinite(resolved)) {
    return String(resolved)
  }
  return undefined
}
