import type {
  BridgeClient,
  BridgeError,
  HttpMethod,
  ProviderRegistry,
  ProxyResult,
} from "./types.ts"

// In real SDK, this hits /broker/proxy via fetch. For the experiment we
// allow tests to inject a mock transport so we can simulate provider errors
// deterministically.

export type TransportFn = (req: {
  method: HttpMethod
  url: string
  body?: unknown
}) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>

export function createBridge(opts: {
  provider: ProviderRegistry
  transport: TransportFn
}): BridgeClient {
  const { provider, transport } = opts

  return {
    async call<T>(method: HttpMethod, path: string, body?: unknown): Promise<ProxyResult<T>> {
      // Resolve path → absolute URL using provider.baseUrl
      const url = path.startsWith("http") ? path : `${provider.baseUrl}${path}`

      // Host allowlist check — endpoint shape errors fail BEFORE network
      const host = new URL(url).host
      if (!provider.allowedHosts.includes(host)) {
        return makeError("validation_failed", `host ${host} not allowed for ${provider.id}`)
      }

      let resp
      try {
        resp = await transport({ method, url, body })
      } catch (e) {
        return makeError("upstream_error", e instanceof Error ? e.message : String(e))
      }

      if (resp.status >= 200 && resp.status < 300) {
        return { kind: "ok", data: resp.body as T, status: resp.status }
      }

      const retryAfter = resp.headers?.["retry-after"]
        ? Number(resp.headers["retry-after"])
        : undefined

      if (resp.status === 429) {
        return makeError("rate_limited", extractMessage(resp.body) ?? "rate limit", {
          upstreamStatus: 429,
          upstreamBody: resp.body,
          retryAfter,
        })
      }
      if (resp.status === 401 || resp.status === 403) {
        return makeError(
          "not_connected",
          extractMessage(resp.body) ?? `auth failed (${resp.status})`,
          {
            upstreamStatus: resp.status,
            upstreamBody: resp.body,
            reauthUrl: `/integrations/${provider.id}/connect`,
          },
        )
      }
      if (resp.status === 404) {
        return makeError("not_found", extractMessage(resp.body) ?? "not found", {
          upstreamStatus: 404,
          upstreamBody: resp.body,
        })
      }
      if (resp.status >= 400 && resp.status < 500) {
        return makeError(
          "validation_failed",
          extractMessage(resp.body) ?? `client error ${resp.status}`,
          { upstreamStatus: resp.status, upstreamBody: resp.body },
        )
      }
      return makeError("upstream_error", `upstream ${resp.status}`, {
        upstreamStatus: resp.status,
        upstreamBody: resp.body,
      })
    },
  }
}

function makeError(
  code: BridgeError["code"],
  message: string,
  extra: Partial<BridgeError> = {},
): BridgeError {
  return { kind: "error", code, message, ...extra }
}

function extractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined
  const r = body as Record<string, unknown>
  if (typeof r.message === "string") return r.message
  if (typeof r.error === "string") return r.error
  return undefined
}
