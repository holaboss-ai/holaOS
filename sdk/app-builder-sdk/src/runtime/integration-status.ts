// Integration readiness probe — the canonical way for an SDK app to ask
// "can I currently use <provider>?" without touching the upstream API.
//
// Why this exists: vibe-coded apps that fetch `https://api.<provider>.com/...`
// to detect "connected" state break the moment the upstream host moves
// (X rebrand: api.twitter.com → api.x.com, Discord scope-only `discord`
// slug vs `discordbot`, etc.). The runtime already knows whether the
// current workspace has an active binding + active connection for each
// provider the app declared, and exposes it as a single endpoint —
// this helper is the SDK shape over that endpoint.
//
// Usage from a TanStack Start server function / loader:
//
//   import { getIntegrationStatus } from "@holaboss/app-builder-sdk"
//   const status = await getIntegrationStatus()
//   if (!status.ready) {
//     // status.issues describes which provider needs which action
//   }

const READINESS_CODES = [
  "ready",
  "integration_not_bound",
  "integration_not_connected",
  "integration_needs_reauth",
] as const

export type IntegrationStatusCode = (typeof READINESS_CODES)[number]

function asReadinessCode(value: unknown): IntegrationStatusCode {
  return (READINESS_CODES as readonly string[]).includes(value as string)
    ? (value as IntegrationStatusCode)
    : "integration_not_connected"
}

export interface IntegrationStatusIssue {
  provider: string
  integrationKey: string
  code: IntegrationStatusCode
  message: string
}

export interface IntegrationStatusResult {
  ready: boolean
  issues: IntegrationStatusIssue[]
}

export interface GetIntegrationStatusOpts {
  /** Optional override for the runtime API base, no trailing slash.
   *  Defaults to WORKSPACE_API_URL env; falls back to stripping `/integrations`
   *  off HOLABOSS_INTEGRATION_BROKER_URL. */
  apiBaseUrl?: string
  workspaceId?: string
  appId?: string
  grant?: string
  /** Narrow the result to a single provider. `ready` reflects that provider
   *  only; `issues` contains at most one entry. Useful for per-toolkit UI. */
  provider?: string
  fetchImpl?: typeof fetch
}

function parseGrant(grant: string): { workspaceId: string; appId: string } | null {
  if (typeof grant !== "string" || !grant.startsWith("grant:")) return null
  const parts = grant.split(":")
  if (parts.length < 3) return null
  const workspaceId = parts[1] ?? ""
  const appId = parts[2] ?? ""
  if (!workspaceId || !appId) return null
  return { workspaceId, appId }
}

function resolveApiBaseUrl(override: string | undefined): string {
  const explicit = override?.trim()
  if (explicit) return explicit.replace(/\/+$/, "")
  const workspaceApi = (process.env.WORKSPACE_API_URL ?? "").trim()
  if (workspaceApi) return workspaceApi.replace(/\/+$/, "")
  const broker = (process.env.HOLABOSS_INTEGRATION_BROKER_URL ?? "").trim()
  if (broker) {
    return broker.replace(/\/+$/, "").replace(/\/integrations$/, "")
  }
  return ""
}

export async function getIntegrationStatus(
  opts: GetIntegrationStatusOpts = {},
): Promise<IntegrationStatusResult> {
  let workspaceId = opts.workspaceId?.trim() || process.env.HOLABOSS_WORKSPACE_ID || ""
  let appId = opts.appId?.trim() || ""
  if (!appId || !workspaceId) {
    const fromGrant = parseGrant(opts.grant ?? process.env.HOLABOSS_APP_GRANT ?? "")
    if (fromGrant) {
      if (!workspaceId) workspaceId = fromGrant.workspaceId
      if (!appId) appId = fromGrant.appId
    }
  }
  if (!workspaceId || !appId) {
    throw new Error(
      "getIntegrationStatus: could not resolve workspaceId/appId. Set HOLABOSS_WORKSPACE_ID + HOLABOSS_APP_GRANT in the app process, or pass workspaceId/appId explicitly.",
    )
  }

  const apiBaseUrl = resolveApiBaseUrl(opts.apiBaseUrl)
  if (!apiBaseUrl) {
    throw new Error(
      "getIntegrationStatus: no runtime API base URL available. Set WORKSPACE_API_URL or HOLABOSS_INTEGRATION_BROKER_URL.",
    )
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${apiBaseUrl}/api/v1/integrations/readiness?workspace_id=${encodeURIComponent(workspaceId)}&app_id=${encodeURIComponent(appId)}`
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  })
  if (!response.ok) {
    throw new Error(
      `getIntegrationStatus: runtime readiness returned ${response.status} ${response.statusText}`,
    )
  }
  const raw = (await response.json()) as {
    ready?: boolean
    issues?: Array<{ provider?: string; integrationKey?: string; code?: string; message?: string }>
  }
  const allIssues: IntegrationStatusIssue[] = Array.isArray(raw.issues)
    ? raw.issues.map((it) => ({
        provider: typeof it.provider === "string" ? it.provider : "",
        integrationKey: typeof it.integrationKey === "string" ? it.integrationKey : "",
        code: asReadinessCode(it.code),
        message: typeof it.message === "string" ? it.message : "",
      }))
    : []

  if (opts.provider) {
    const target = opts.provider.trim().toLowerCase()
    const filtered = allIssues.filter(
      (issue) =>
        issue.provider.trim().toLowerCase() === target ||
        issue.integrationKey.trim().toLowerCase() === target,
    )
    return {
      ready: filtered.length === 0,
      issues: filtered,
    }
  }

  return {
    ready: raw.ready === true && allIssues.length === 0,
    issues: allIssues,
  }
}
