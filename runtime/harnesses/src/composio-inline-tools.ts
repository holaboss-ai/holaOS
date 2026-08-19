import { requestCapabilityJson } from "./capability-http.js";
import {
  readComposioInlineCache,
  writeComposioInlineCache,
} from "./composio-inline-cache.js";
import {
  resolveRuntimeToolCapabilityBaseUrl,
  runtimeToolHeaders,
} from "./runtime-tool-capability-client.js";
import type { HarnessRuntimeToolDefinitionLike } from "./runtime-capability-tools.js";

const COMPOSIO_INLINE_LIST_PATH = "/api/v1/capabilities/composio-inline-tools";
const COMPOSIO_INLINE_EXECUTE_PATH = "/api/v1/capabilities/composio-execute";
const COMPOSIO_SEARCH_PATH = "/api/v1/capabilities/composio-search";
const LIST_TIMEOUT_MS = 5_000;
// Catalog listing goes upstream to Composio on a cold cache — several seconds.
const SEARCH_TIMEOUT_MS = 20_000;
const EXECUTE_TIMEOUT_MS = 60_000;

interface InlineToolSummary {
  name: string;
  description: string;
  toolkit_slug: string;
  tool_slug: string;
  connected_account_id: string;
  input_schema: Record<string, unknown>;
  annotations?: Record<string, unknown> | null;
}

interface InlineListPayload {
  workspace_id: string;
  tools: InlineToolSummary[];
  unavailable?: Array<{ toolkit_slug: string; reason: string }>;
}

export interface ComposioInlineUnavailableEntry {
  toolkit_slug: string;
  reason: string;
}

export interface ResolveComposioInlineToolsResult {
  tools: HarnessRuntimeToolDefinitionLike[];
  unavailable: ComposioInlineUnavailableEntry[];
}

export interface ResolveComposioInlineToolsOptions {
  runtimeApiBaseUrl: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  inputId: string | null;
  selectedModel: string | null;
  /** Enables the cross-turn listing cache (see composio-inline-cache.ts). When
   *  omitted the listing is fetched every turn, as before. */
  workspaceDir?: string | null;
  fetchImpl?: typeof fetch;
}

export async function resolveComposioInlineTools(
  options: ResolveComposioInlineToolsOptions,
): Promise<ResolveComposioInlineToolsResult> {
  const baseUrl = resolveRuntimeToolCapabilityBaseUrl(options.runtimeApiBaseUrl);
  if (!baseUrl) {
    return { tools: [], unavailable: [] };
  }
  const headers = runtimeToolHeaders({
    workspaceId: options.workspaceId,
    sessionId: options.sessionId,
    inputId: options.inputId,
    selectedModel: options.selectedModel,
  });
  // The api-server's bootstrap already fetched this exact listing earlier in the
  // same turn; the shared on-disk cache lets this second read be free (see
  // composio-inline-cache.ts for the measured cost of not doing so).
  const cacheKey =
    options.workspaceDir && options.workspaceId
      ? { workspaceDir: options.workspaceDir, workspaceId: options.workspaceId }
      : null;
  let payload: InlineListPayload | null = null;
  const cached = cacheKey ? readComposioInlineCache(cacheKey) : null;
  if (isInlineListPayload(cached)) {
    payload = cached;
  } else {
    try {
      const response = await requestCapabilityJson({
        url: `${baseUrl}${COMPOSIO_INLINE_LIST_PATH}?workspace_id=${encodeURIComponent(options.workspaceId ?? "")}`,
        method: "GET",
        headers,
        signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        fetchImpl: options.fetchImpl,
      });
      payload = response.ok && isInlineListPayload(response.payload)
        ? response.payload
        : null;
    } catch {
      payload = null;
    }
    if (payload && cacheKey) {
      writeComposioInlineCache({ ...cacheKey, payload });
    }
  }
  if (!payload) {
    return { tools: [], unavailable: [] };
  }
  const ctx = { baseUrl, headers, fetchImpl: options.fetchImpl };
  const tools = payload.tools.map((entry) =>
    buildInlineToolDefinition(entry, ctx),
  );
  const unavailable = (payload.unavailable ?? []).map((entry) => ({
    toolkit_slug: entry.toolkit_slug,
    reason: entry.reason,
  }));
  // Hybrid model: the preloaded tools above are the common actions per
  // connected toolkit; these two meta-tools make the long tail reachable
  // without loading every schema into context. Only add them when the user
  // actually has connected integrations (else they're dead weight).
  const hasConnections =
    payload.tools.length > 0 || (payload.unavailable?.length ?? 0) > 0;
  if (hasConnections) {
    tools.push(...buildComposioMetaTools(ctx));
  }
  return { tools, unavailable };
}

function buildInlineToolDefinition(
  entry: InlineToolSummary,
  ctx: { baseUrl: string; headers: Record<string, string>; fetchImpl?: typeof fetch },
): HarnessRuntimeToolDefinitionLike {
  return {
    name: entry.name,
    label: entry.name,
    description: entry.description,
    promptSnippet: `${entry.name}: ${entry.description}`,
    parameters: entry.input_schema,
    execute: async (_callId, toolParams, signal) => {
      const startedAt = Date.now();
      const response = await requestCapabilityJson({
        url: `${ctx.baseUrl}${COMPOSIO_INLINE_EXECUTE_PATH}`,
        method: "POST",
        headers: {
          ...ctx.headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          toolkit_slug: entry.toolkit_slug,
          tool_slug: entry.tool_slug,
          connected_account_id: entry.connected_account_id,
          arguments: toolParams ?? {},
        }),
        signal: combineSignals(signal, AbortSignal.timeout(EXECUTE_TIMEOUT_MS)),
        fetchImpl: ctx.fetchImpl,
      });
      const durationMs = Date.now() - startedAt;
      const payload = isExecutePayload(response.payload) ? response.payload : null;
      if (!payload) {
        const marker = `[composio_error:transport_error:${entry.toolkit_slug}] composio-execute returned a non-JSON or invalid payload (status ${response.status})`;
        return {
          content: [{ type: "text" as const, text: marker }],
          details: {
            tool_id: entry.name,
            ok: false,
            toolkit_slug: entry.toolkit_slug,
            tool_slug: entry.tool_slug,
            error_marker: marker,
            duration_ms: durationMs,
          },
        };
      }
      if (payload.ok) {
        return {
          content: [{ type: "text" as const, text: serializeComposioPayload(payload.data) }],
          details: {
            tool_id: entry.name,
            ok: true,
            toolkit_slug: entry.toolkit_slug,
            tool_slug: entry.tool_slug,
            log_id: payload.log_id ?? null,
            raw: payload.data ?? null,
            duration_ms: durationMs,
          },
        };
      }
      const marker = payload.error_marker ?? `[composio_error:unknown_error:${entry.toolkit_slug}] composio-execute failed`;
      return {
        content: [{ type: "text" as const, text: marker }],
        details: {
          tool_id: entry.name,
          ok: false,
          toolkit_slug: entry.toolkit_slug,
          tool_slug: entry.tool_slug,
          error_marker: marker,
          error: payload.error ?? null,
          duration_ms: durationMs,
        },
      };
    },
  };
}

function buildComposioMetaTools(ctx: {
  baseUrl: string;
  headers: Record<string, string>;
  fetchImpl?: typeof fetch;
}): HarnessRuntimeToolDefinitionLike[] {
  const search: HarnessRuntimeToolDefinitionLike = {
    name: "composio_search_tools",
    label: "composio_search_tools",
    description:
      'Your preloaded integration tools are a capped common subset — every connected integration exposes more tools than the ones you can see. Use this before saying an action is impossible, and before describing what an integration can do. With `query`: search by capability (e.g. "create a calendar event") and get matching tools with their tool_slug and input schema. With only `toolkit_slug` and no query: list that integration\'s FULL tool catalog (names + slugs, no schemas — search by name to get one). Run any result with composio_execute_tool.',
    promptSnippet:
      "composio_search_tools: your preloaded integration tools are a subset — search or list a toolkit's full catalog here",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language capability to search for, e.g. 'send an email' or 'create issue'. Omit to list a toolkit's full catalog (toolkit_slug then required).",
        },
        toolkit_slug: {
          type: "string",
          description:
            "Restrict to one integration by slug (e.g. 'gmail', 'github'). Required when query is omitted.",
        },
      },
    },
    execute: async (_callId, toolParams, signal) => {
      const params = (toolParams ?? {}) as Record<string, unknown>;
      const query = typeof params.query === "string" ? params.query : "";
      const toolkitSlug =
        typeof params.toolkit_slug === "string" ? params.toolkit_slug : undefined;
      const response = await requestCapabilityJson({
        url: `${ctx.baseUrl}${COMPOSIO_SEARCH_PATH}`,
        method: "POST",
        headers: { ...ctx.headers, "content-type": "application/json" },
        body: JSON.stringify({ query, toolkit_slug: toolkitSlug }),
        signal: combineSignals(signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)),
        fetchImpl: ctx.fetchImpl,
      });
      const payload = (response.payload ?? {}) as {
        tools?: unknown;
        connected_toolkits?: unknown;
        tool_count?: unknown;
        detail?: unknown;
      };
      // A FAILED search must not read as a successful empty one.
      //
      // requestCapabilityJson resolves for non-2xx (it never throws), and an
      // error body carries `detail`, not `tools` — so serializing it produced
      // `{"tools": [], "connected_toolkits": []}`, which is indistinguishable
      // from "nothing matched". Observed live: a Notion search failed while the
      // upstream was returning 502s, the agent read it as "no such tool",
      // listed the entire toolkit catalogue instead, and spent 51.8s reading it.
      //
      // composio_execute_tool already surfaces failures with a
      // [composio_error:...] marker, which is why its 502s were visible in the
      // same trace. Search now follows that convention.
      if (!response.ok) {
        const detail =
          typeof payload.detail === "string" && payload.detail.trim()
            ? payload.detail.trim()
            : `composio-search failed (status ${response.status})`;
        // A 401 here is the RUNTIME's session, not the integration's.
        //
        // The cookie only identifies whose connections to scope results to; the
        // Composio credential lives server-side, past the gateway. But the
        // failure surfaced as a bare `401 {"error":"unauthorized"}` next to a
        // toolkit slug, and a model reading that concluded "the composio search
        // tools are unauthorized" — then went looking for a workaround for a
        // problem that had nothing to do with the toolkit. Observed live on a
        // Notion search.
        //
        // Saying which credential expired costs one line and stops the next
        // reader — human or model — drawing the same wrong conclusion.
        const sessionExpired = /\b401\b|unauthorized/i.test(detail);
        const cause = sessionExpired
          ? "\nThis is the runtime's own sign-in session, NOT the integration's authorization: the toolkit's connection is unaffected. Restarting the app re-establishes it. Do not suggest reconnecting the integration."
          : "";
        const scope = toolkitSlug ? `:${toolkitSlug}` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `[composio_error:search_failed${scope}] ${detail}${cause}\nThe search did NOT run — this is not "no matching tools". Retry, or list the toolkit's catalogue with only toolkit_slug.`,
            },
          ],
          details: { tool_id: "composio_search_tools", ok: false },
        };
      }
      const text = serializeComposioPayload({
        tools: payload.tools ?? [],
        connected_toolkits: payload.connected_toolkits ?? [],
        ...(typeof payload.tool_count === "number"
          ? { tool_count: payload.tool_count }
          : {}),
      });
      return {
        content: [{ type: "text" as const, text }],
        details: { tool_id: "composio_search_tools", ok: response.ok },
      };
    },
  };

  const execute: HarnessRuntimeToolDefinitionLike = {
    name: "composio_execute_tool",
    label: "composio_execute_tool",
    description:
      "Run any tool from a connected integration by toolkit_slug + tool_slug (discover slugs with composio_search_tools). Use this for actions not already in your preloaded tools. The account is resolved automatically.",
    promptSnippet:
      "composio_execute_tool: run a connected-integration tool by toolkit_slug + tool_slug",
    parameters: {
      type: "object",
      properties: {
        toolkit_slug: {
          type: "string",
          description: "Integration slug, e.g. 'gmail'.",
        },
        tool_slug: {
          type: "string",
          description: "Exact Composio tool slug, e.g. 'GMAIL_SEND_EMAIL'.",
        },
        arguments: {
          type: "object",
          description: "Tool input matching the tool's input schema.",
          additionalProperties: true,
        },
      },
      required: ["toolkit_slug", "tool_slug"],
    },
    execute: async (_callId, toolParams, signal) => {
      const params = (toolParams ?? {}) as Record<string, unknown>;
      const toolkitSlug =
        typeof params.toolkit_slug === "string" ? params.toolkit_slug : "";
      const toolSlug =
        typeof params.tool_slug === "string" ? params.tool_slug : "";
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      const startedAt = Date.now();
      const response = await requestCapabilityJson({
        url: `${ctx.baseUrl}${COMPOSIO_INLINE_EXECUTE_PATH}`,
        method: "POST",
        headers: { ...ctx.headers, "content-type": "application/json" },
        // No connected_account_id — the runtime resolves it from toolkit_slug.
        body: JSON.stringify({
          toolkit_slug: toolkitSlug,
          tool_slug: toolSlug,
          arguments: args,
        }),
        signal: combineSignals(signal, AbortSignal.timeout(EXECUTE_TIMEOUT_MS)),
        fetchImpl: ctx.fetchImpl,
      });
      const durationMs = Date.now() - startedAt;
      const payload = isExecutePayload(response.payload) ? response.payload : null;
      if (!payload) {
        const marker = `[composio_error:transport_error:${toolkitSlug}] composio-execute returned a non-JSON or invalid payload (status ${response.status})`;
        return {
          content: [{ type: "text" as const, text: marker }],
          details: {
            tool_id: "composio_execute_tool",
            ok: false,
            toolkit_slug: toolkitSlug,
            tool_slug: toolSlug,
            error_marker: marker,
            duration_ms: durationMs,
          },
        };
      }
      if (payload.ok) {
        return {
          content: [
            { type: "text" as const, text: serializeComposioPayload(payload.data) },
          ],
          details: {
            tool_id: "composio_execute_tool",
            ok: true,
            toolkit_slug: toolkitSlug,
            tool_slug: toolSlug,
            log_id: payload.log_id ?? null,
            raw: payload.data ?? null,
            duration_ms: durationMs,
          },
        };
      }
      const marker =
        payload.error_marker ??
        `[composio_error:unknown_error:${toolkitSlug}] composio-execute failed`;
      return {
        content: [{ type: "text" as const, text: marker }],
        details: {
          tool_id: "composio_execute_tool",
          ok: false,
          toolkit_slug: toolkitSlug,
          tool_slug: toolSlug,
          error_marker: marker,
          error: payload.error ?? null,
          duration_ms: durationMs,
        },
      };
    },
  };

  return [search, execute];
}

function serializeComposioPayload(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function isInlineListPayload(value: unknown): value is InlineListPayload {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.tools);
}

interface ExecutePayload {
  ok: boolean;
  data?: unknown;
  log_id?: string | null;
  error?: { code?: string; message?: string; toolkit_slug?: string; http_status?: number };
  error_marker?: string;
}

function isExecutePayload(value: unknown): value is ExecutePayload {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.ok === "boolean";
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const filtered = signals.filter((s): s is AbortSignal => s !== undefined);
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];
  const controller = new AbortController();
  for (const s of filtered) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
