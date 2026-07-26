/**
 * Wire format for the `mcpMarketplace:healthCheck` IPC channel.
 *
 * Before a marketplace MCP server is attached, the renderer asks main to PROBE it with the
 * user's just-entered credentials — an MCP `initialize` handshake POSTed to the server's
 * streamable-HTTP endpoint, built with the SAME url + headers the attach uses (header/query
 * keys + the Better-Auth session bearer for hosted servers). The credentials ride only this
 * one direct probe to the MCP endpoint itself; they never touch a `/gateway/*` call. Doing
 * the probe in main reuses the attach's url/header resolution and keeps the session bearer
 * out of the renderer.
 */

/** Why a health check failed. `unauthorized` = the server rejected the credentials (HTTP
 * 401/403); `unreachable` = timeout, network error, or any other non-OK status. */
export type McpHealthCheckFailureReason = "unauthorized" | "unreachable";

export type McpHealthCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: McpHealthCheckFailureReason;
      /** HTTP status when the server answered (absent on timeout / network error). */
      status?: number;
      /** Diagnostic detail for logs — not necessarily user-facing. */
      message?: string;
    };
