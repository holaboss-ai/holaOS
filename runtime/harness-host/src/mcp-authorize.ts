import { createRuntime, type ServerDefinition } from "mcporter";

import {
  clearMcpOAuthToken,
  mcpOAuthTokenCacheDir,
  readMcpOAuthAccessToken,
} from "../../harnesses/src/index.js";

/**
 * Out-of-turn OAuth authorization for a user-connected remote MCP server.
 *
 * Why this lives here (and is spawned by the api-server, not run in a chat
 * turn): completing OAuth requires an interactive browser consent that can take
 * as long as the human takes — far past any per-turn discovery deadline, and
 * something a chat turn must never launch. So the api-server spawns the
 * harness-host `authorize-mcp` subcommand, which opens the system browser +
 * listens on a loopback redirect (mcporter's OAuth session), waits for consent,
 * and persists the token to the SAME `tokenCacheDir` the per-turn harness reads
 * back (see `readMcpOAuthAccessToken`). After this, turns authenticate silently
 * via the replayed bearer header — no OAuth machinery on the hot path.
 */
export interface AuthorizeMcpServerParams {
  workspaceDir: string;
  serverId: string;
  url: string;
  /** Any static headers already configured on the server (preserved). */
  headers?: Record<string, string>;
  /** How long to wait for the user to complete the browser consent. */
  timeoutMs?: number;
  /** Re-auth / switch account: wipe the existing token first so a FRESH browser
   *  consent runs instead of silently reusing the current account. */
  reauthorize?: boolean;
}

export interface AuthorizeMcpServerResult {
  ok: boolean;
  tool_count: number;
  detail: string;
}

const DEFAULT_AUTHORIZE_TIMEOUT_MS = 180_000;
// Fixed loopback port for the OAuth callback (see oauthRedirectUrl below).
const MCP_OAUTH_CALLBACK_PORT = 51703;

export async function authorizeMcpServerOAuth(
  params: AuthorizeMcpServerParams,
): Promise<AuthorizeMcpServerResult> {
  const serverId = params.serverId.trim();
  const url = params.url.trim();
  if (!serverId || !url) {
    return { ok: false, tool_count: 0, detail: "server id and url are required" };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, tool_count: 0, detail: `invalid server url: ${url}` };
  }

  const oauthTimeoutMs =
    params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_AUTHORIZE_TIMEOUT_MS;
  const definition: ServerDefinition = {
    name: serverId,
    description: `Holaboss MCP server ${serverId}`,
    command: {
      kind: "http",
      url: parsedUrl,
      headers: params.headers ?? {},
    },
    // Force the OAuth path (vs relying on ad-hoc 401 promotion) so the token is
    // persisted under our shared tokenCacheDir regardless of transport quirks.
    auth: "oauth",
    tokenCacheDir: mcpOAuthTokenCacheDir(params.workspaceDir, serverId),
    // Also mark ad-hoc so mcporter's connect-error path can (re)promote on 401.
    source: { kind: "local", path: "<adhoc>" },
    // Pin the loopback callback to a FIXED port instead of a random one. Users
    // retry auth several times, and each random-port attempt leaves a browser
    // tab whose callback server dies when that attempt ends — approving on a
    // stale tab then redirects to a dead port ("can't reach 127.0.0.1"). A fixed
    // port means any tab's redirect lands on whatever attempt is currently live.
    oauthRedirectUrl: `http://127.0.0.1:${MCP_OAUTH_CALLBACK_PORT}/callback`,
  };

  // Re-auth / switch account: wipe every persisted token FIRST so the flow can't
  // silently reuse the current account — a fresh browser consent runs instead.
  if (params.reauthorize) {
    clearMcpOAuthToken(params.workspaceDir, serverId);
  }

  // A FRESH token (different from any pre-existing one) means the OAuth handshake
  // succeeded — that is the real success signal, independent of the tool list.
  const initialToken = readMcpOAuthAccessToken(params.workspaceDir, serverId);
  const freshTokenPersisted = (): boolean => {
    const current = readMcpOAuthAccessToken(params.workspaceDir, serverId);
    return Boolean(current) && current !== initialToken;
  };
  const authorizedResult = (count: number): AuthorizeMcpServerResult => ({
    ok: true,
    tool_count: count,
    detail:
      count > 0
        ? `Authorized '${serverId}' — discovered ${count} tool${count === 1 ? "" : "s"}.`
        : `Authorized '${serverId}'. Its tools load on your next message.`,
  });

  let runtime: Awaited<ReturnType<typeof createRuntime>> | null = null;
  try {
    runtime = await createRuntime({
      servers: [definition],
      rootDir: params.workspaceDir,
      clientInfo: { name: "holaboss-desktop-authorize", version: "1" },
      oauthTimeoutMs,
    });
    // autoAuthorize:true launches the interactive browser consent flow, persists
    // the token mid-flow (during the code exchange), THEN lists tools. Some
    // servers are slow/flaky listing tools right after auth (transport
    // fallbacks) — which would otherwise hang this whole flow AFTER the user has
    // already signed in. So race the tool list against a "token appeared" poll:
    // the instant a fresh token is on disk, auth SUCCEEDED — return immediately
    // and let the tools load on the next turn.
    const listOutcome = runtime
      .listTools(serverId, {
        autoAuthorize: true,
        // On re-auth we just wiped the token; don't let any residual cached
        // credential short-circuit the fresh consent.
        allowCachedAuth: !params.reauthorize,
        includeSchema: false,
      })
      .then(
        (tools) =>
          ({ kind: "tools", count: Array.isArray(tools) ? tools.length : 0 }) as const,
      )
      .catch((error) => ({ kind: "error", error }) as const);

    const outcome = await Promise.race([
      listOutcome,
      pollForFreshToken(freshTokenPersisted, oauthTimeoutMs).then(
        (ok) => (ok ? ({ kind: "token" } as const) : ({ kind: "timeout" } as const)),
      ),
    ]);

    if (outcome.kind === "tools") {
      return authorizedResult(outcome.count);
    }
    if (outcome.kind === "token") {
      return authorizedResult(0);
    }
    if (outcome.kind === "error") {
      // The tool list threw — but if OAuth still persisted a fresh token, auth
      // worked and the tools just failed to list this once.
      if (freshTokenPersisted()) {
        return authorizedResult(0);
      }
      const error = outcome.error;
      return {
        ok: false,
        tool_count: 0,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    // timeout: no fresh token within the consent window
    return {
      ok: false,
      tool_count: 0,
      detail: `Authorization timed out for '${serverId}' — the sign-in was not completed.`,
    };
  } catch (error) {
    if (freshTokenPersisted()) {
      return authorizedResult(0);
    }
    return {
      ok: false,
      tool_count: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Do NOT block on close. mcporter's buggy post-auth retry can leave a second
    // OAuth flow (its own callback server) open, and close() then hangs — which
    // would stop this function returning even though the token is already saved,
    // so the result JSON never gets written and the whole authorize appears
    // stuck. Cap the close; the CLI wrapper's process.exit() reclaims whatever
    // is still open.
    await Promise.race([
      Promise.resolve(runtime?.close()).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  }
}

/**
 * Poll the token cache until a FRESH token lands (auth completed) or timeout.
 * Fast interval so we return — and close the runtime — the instant the token is
 * saved, before mcporter's buggy post-auth retry (StreamableHTTP "already
 * started" → SSE fallback) can re-prompt and pop a second browser tab.
 */
async function pollForFreshToken(
  hasFreshToken: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasFreshToken()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}
