// Verifies the readiness helper resolves workspace/app from the grant +
// env, and reflects the runtime's typed readiness shape — including the
// per-provider filter path that vibe-coded UI most commonly uses.

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { getIntegrationStatus } from "../src/runtime/integration-status.ts"

type CapturedRequest = { url: string }
type ScriptedResponse = { status: number; body: unknown }

const captured: CapturedRequest[] = []
const scripted: ScriptedResponse[] = []

const scriptedFetch: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  captured.push({ url })
  const next = scripted.shift()
  if (!next) throw new Error("no scripted readiness response")
  return new Response(JSON.stringify(next.body), {
    status: next.status,
    headers: { "Content-Type": "application/json" },
  })
}

const ORIGINAL_ENV: Partial<Record<string, string | undefined>> = {}

function setEnv(key: string, value: string | undefined): void {
  if (!(key in ORIGINAL_ENV)) ORIGINAL_ENV[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

beforeEach(() => {
  captured.length = 0
  scripted.length = 0
})

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const key of Object.keys(ORIGINAL_ENV)) delete ORIGINAL_ENV[key]
})

describe("getIntegrationStatus", () => {
  test("parses workspace + app from grant and calls /readiness", async () => {
    setEnv("HOLABOSS_APP_GRANT", "grant:workspace-1:gmail:abc:nonce:sig")
    setEnv("WORKSPACE_API_URL", "http://runtime.local/api/v1")
    setEnv("HOLABOSS_INTEGRATION_BROKER_URL", undefined)

    scripted.push({ status: 200, body: { ready: true, issues: [] } })

    const result = await getIntegrationStatus({ fetchImpl: scriptedFetch })

    expect(result).toEqual({ ready: true, issues: [] })
    expect(captured.length).toBe(1)
    expect(captured[0]!.url).toBe(
      "http://runtime.local/api/v1/api/v1/integrations/readiness?workspace_id=workspace-1&app_id=gmail",
    )
  })

  test("falls back to broker URL when WORKSPACE_API_URL is unset", async () => {
    setEnv("HOLABOSS_APP_GRANT", "grant:workspace-1:gmail:abc:nonce:sig")
    setEnv("WORKSPACE_API_URL", undefined)
    setEnv("HOLABOSS_INTEGRATION_BROKER_URL", "http://127.0.0.1:8080/api/v1/integrations")

    scripted.push({ status: 200, body: { ready: true, issues: [] } })

    await getIntegrationStatus({ fetchImpl: scriptedFetch })

    expect(captured[0]!.url).toBe(
      "http://127.0.0.1:8080/api/v1/api/v1/integrations/readiness?workspace_id=workspace-1&app_id=gmail",
    )
  })

  test("surfaces typed issues and marks ready=false", async () => {
    setEnv("HOLABOSS_APP_GRANT", "grant:workspace-1:dash:abc:nonce:sig")
    setEnv("WORKSPACE_API_URL", "http://runtime.local")

    scripted.push({
      status: 200,
      body: {
        ready: false,
        issues: [
          {
            provider: "twitter",
            integrationKey: "twitter",
            code: "integration_not_connected",
            message: "Twitter is not connected for this workspace.",
          },
        ],
      },
    })

    const result = await getIntegrationStatus({ fetchImpl: scriptedFetch })

    expect(result.ready).toBe(false)
    expect(result.issues.length).toBe(1)
    expect(result.issues[0]!.code).toBe("integration_not_connected")
    expect(result.issues[0]!.provider).toBe("twitter")
  })

  test("provider filter narrows result + collapses ready when no matching issue", async () => {
    setEnv("HOLABOSS_APP_GRANT", "grant:workspace-1:dash:abc:nonce:sig")
    setEnv("WORKSPACE_API_URL", "http://runtime.local")

    scripted.push({
      status: 200,
      body: {
        ready: false,
        issues: [
          {
            provider: "twitter",
            integrationKey: "twitter",
            code: "integration_not_connected",
            message: "Twitter is not connected.",
          },
        ],
      },
    })

    const onlyGmail = await getIntegrationStatus({
      fetchImpl: scriptedFetch,
      provider: "gmail",
    })

    expect(onlyGmail.ready).toBe(true)
    expect(onlyGmail.issues.length).toBe(0)
  })

  test("provider filter retains the matching issue", async () => {
    setEnv("HOLABOSS_APP_GRANT", "grant:workspace-1:dash:abc:nonce:sig")
    setEnv("WORKSPACE_API_URL", "http://runtime.local")

    scripted.push({
      status: 200,
      body: {
        ready: false,
        issues: [
          {
            provider: "twitter",
            integrationKey: "twitter",
            code: "integration_not_connected",
            message: "Twitter is not connected.",
          },
        ],
      },
    })

    const onlyTwitter = await getIntegrationStatus({
      fetchImpl: scriptedFetch,
      provider: "twitter",
    })

    expect(onlyTwitter.ready).toBe(false)
    expect(onlyTwitter.issues.length).toBe(1)
    expect(onlyTwitter.issues[0]!.provider).toBe("twitter")
  })

  test("throws clearly when neither grant nor explicit ids are available", async () => {
    setEnv("HOLABOSS_APP_GRANT", undefined)
    setEnv("HOLABOSS_WORKSPACE_ID", undefined)
    setEnv("WORKSPACE_API_URL", "http://runtime.local")

    await expect(getIntegrationStatus({ fetchImpl: scriptedFetch })).rejects.toThrow(
      /could not resolve workspaceId\/appId/,
    )
  })

  test("throws when neither WORKSPACE_API_URL nor broker URL are set", async () => {
    setEnv("HOLABOSS_APP_GRANT", "grant:workspace-1:dash:abc:nonce:sig")
    setEnv("WORKSPACE_API_URL", undefined)
    setEnv("HOLABOSS_INTEGRATION_BROKER_URL", undefined)

    await expect(getIntegrationStatus({ fetchImpl: scriptedFetch })).rejects.toThrow(
      /no runtime API base URL/,
    )
  })

  test("unknown readiness codes coerce to integration_not_connected", async () => {
    setEnv("HOLABOSS_APP_GRANT", "grant:workspace-1:dash:abc:nonce:sig")
    setEnv("WORKSPACE_API_URL", "http://runtime.local")

    scripted.push({
      status: 200,
      body: {
        ready: false,
        issues: [
          {
            provider: "twitter",
            integrationKey: "twitter",
            code: "wildly_invented_state",
            message: "future code",
          },
        ],
      },
    })

    const result = await getIntegrationStatus({ fetchImpl: scriptedFetch })
    expect(result.issues[0]!.code).toBe("integration_not_connected")
  })
})
