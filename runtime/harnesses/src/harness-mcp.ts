import {
  type HarnessHostRequestBuildParams,
  type HarnessPreparedMcpServerPayload,
} from "./types.js";
import { browserToolsEnabledForSessionKind } from "./browser-session-gate.js";

const HOLABOSS_RUNTIME_MCP_SERVER_NAME = "holaboss_runtime";
const HOLABOSS_RUNTIME_TOOLS_MCP_SERVER_NAME = "holaboss_runtime_tools";
const HOLABOSS_RUNTIME_TOOLS_MCP_PATH = "/mcp/runtime-tools";
const HOLABOSS_RUNTIME_MCP_TIMEOUT_MS = 30_000;

/**
 * Prepend the Holaboss runtime MCP servers to the workspace MCP list so every
 * CLI harness reaches the Holaboss tool surface. Shared by the CLI harnesses so
 * the "expose the runtime endpoint" rule lives in exactly one place.
 *
 * Two entries are injected:
 *  - `holaboss_runtime` → `/mcp` (oRPC bridge; workspace read tools).
 *  - `holaboss_runtime_tools` → `/mcp/runtime-tools` (the runtime-tool surface
 *    pi wires in-process: web_search, image/video gen, reports, memory,
 *    cronjobs, …). Its handlers need per-run context, so this entry also
 *    carries the session/input/model headers, not just the workspace id.
 *
 * Each entry uses the same `{type:"remote", url, headers}` config shape as a
 * user-declared remote server, so each runner's materializer (codex TOML,
 * claude `--mcp-config`) maps it identically to any other remote MCP server.
 */
export function buildHarnessMcpServers(
  params: HarnessHostRequestBuildParams,
): Array<Record<string, unknown>> {
  const userServers = params.mcpServers.map((server) => ({
    name: server.name,
    config: { ...server.config },
    ...(server._holaboss_force_refresh ? { _holaboss_force_refresh: true } : {}),
  }));
  const runtimeServers = [
    buildHolabossRuntimeToolsMcpServerEntry(params),
    buildHolabossRuntimeMcpServerEntry(params),
  ].filter((entry): entry is Record<string, unknown> => entry !== null);
  return [...runtimeServers, ...userServers];
}

function optionalTrimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildHolabossRuntimeToolsMcpServerEntry(
  params: HarnessHostRequestBuildParams,
): Record<string, unknown> | null {
  const baseUrl = params.runtimeApiBaseUrl?.trim();
  if (!baseUrl) {
    return null;
  }
  const cleanBase = baseUrl.replace(/\/+$/, "");
  // Runtime-tool handlers scope their capability calls by these headers, which
  // the runtime reads back off the MCP connection (see runtime-tools-mcp.ts).
  // Session/input/model are known at request-build time, so bake them in here.
  const headers: Record<string, string> = {
    "x-holaboss-workspace-id": params.request.workspace_id,
  };
  const sessionId = optionalTrimmed(params.request.session_id);
  if (sessionId) {
    headers["x-holaboss-session-id"] = sessionId;
  }
  const inputId = optionalTrimmed(params.request.input_id);
  if (inputId) {
    headers["x-holaboss-input-id"] = inputId;
  }
  const selectedModel = optionalTrimmed(params.request.model);
  if (selectedModel) {
    headers["x-holaboss-selected-model"] = selectedModel;
  }
  // Browser tools are a separate capability family (not curated runtime tools,
  // not Composio) that pi wires in-process only when enabled for the session
  // kind. Honor that same gate for CLI harnesses: when enabled, advertise the
  // toggle + active browser surface as headers so the runtime-tools MCP server
  // merges the browser family in (it still self-gates on the desktop browser
  // being reachable, so a run without a live browser gets none — same as pi).
  if (browserToolsEnabledForSessionKind(params.request.session_kind)) {
    headers["x-holaboss-browser-tools-enabled"] = "true";
    const browserSpace = optionalTrimmed(params.browserSpace);
    if (browserSpace) {
      headers["x-holaboss-browser-space"] = browserSpace;
    }
  }
  const config: HarnessPreparedMcpServerPayload["config"] = {
    type: "remote",
    enabled: true,
    url: `${cleanBase}${HOLABOSS_RUNTIME_TOOLS_MCP_PATH}`,
    headers,
    timeout: HOLABOSS_RUNTIME_MCP_TIMEOUT_MS,
  };
  return {
    name: HOLABOSS_RUNTIME_TOOLS_MCP_SERVER_NAME,
    config,
  };
}

function buildHolabossRuntimeMcpServerEntry(
  params: HarnessHostRequestBuildParams,
): Record<string, unknown> | null {
  const baseUrl = params.runtimeApiBaseUrl?.trim();
  if (!baseUrl) {
    return null;
  }
  const cleanBase = baseUrl.replace(/\/+$/, "");
  // See claude-code.ts for the rationale on x-holaboss-workspace-id —
  // identity is no-op until the runtime parses tokens; the workspace
  // header is the today-only carrier.
  const config: HarnessPreparedMcpServerPayload["config"] = {
    type: "remote",
    enabled: true,
    url: `${cleanBase}/mcp`,
    headers: {
      "x-holaboss-workspace-id": params.request.workspace_id,
    },
    timeout: HOLABOSS_RUNTIME_MCP_TIMEOUT_MS,
  };
  return {
    name: HOLABOSS_RUNTIME_MCP_SERVER_NAME,
    config,
  };
}
