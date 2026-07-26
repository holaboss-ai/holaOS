import {
  createRemoteApiClient,
  type RemoteApiClient,
} from "@holaboss/remote-api/client";

// The embedded runtime boots asynchronously and its port can change across
// restarts, so renderer-direct calls must tolerate a "not listening yet"
// window — otherwise every call that fires during startup throws
// "Failed to fetch" until the socket is up. This mirrors the readiness wait +
// retry the main-process path (requestWorkspaceRuntimeJson) applied before
// outputs/memory moved onto the Remote API.
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 150;
const FETCH_RETRIES = 4;
const FETCH_RETRY_BASE_MS = 150;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitForRunningRuntime() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let status = await window.electronAPI.runtime.getStatus();
  while (status.status !== "running" || !status.url) {
    // Terminal states won't become ready by waiting — let the caller surface
    // the real error instead of blocking for the full timeout.
    if (
      status.status === "disabled" ||
      status.status === "missing" ||
      status.status === "stopped" ||
      status.status === "error" ||
      Date.now() > deadline
    ) {
      return status;
    }
    await delay(READY_POLL_MS);
    status = await window.electronAPI.runtime.getStatus();
  }
  return status;
}

async function resolveRuntimeRpcUrl(): Promise<string> {
  const status = await waitForRunningRuntime();
  const baseUrl = status?.url?.replace(/\/+$/u, "");
  if (!baseUrl) {
    throw new Error("Embedded runtime is not ready (no url yet).");
  }
  return `${baseUrl}/rpc`;
}

// A failed connection rejects with `TypeError: Failed to fetch`, which means the
// request never reached the runtime — safe to replay for both queries and
// mutations (the same rule the main-process path used for ECONNREFUSED).
const retryingFetch: typeof fetch = async (input, init) => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt += 1) {
    // A Request body stream can only be consumed once; clone the pristine
    // original per attempt so a replay isn't handed an already-used Request.
    const attemptInput = input instanceof Request ? input.clone() : input;
    try {
      return await fetch(attemptInput, init);
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      lastError = error;
      await delay(FETCH_RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastError;
};

/**
 * Renderer-side oRPC client that talks to the runtime directly over HTTP. The
 * runtime base URL is resolved lazily per request so it survives runtime
 * restarts (the embedded runtime's port can change), and both the URL resolver
 * and fetch tolerate the runtime's async startup.
 */
export const remoteApi: RemoteApiClient = createRemoteApiClient({
  url: resolveRuntimeRpcUrl,
  fetch: retryingFetch,
});

/**
 * Tell the runtime the user skipped the given integration proposals for a
 * session, so the pending-integration gate stops blocking and the deferred turn
 * resumes. Best-effort; the caller clears its banner optimistically.
 */
export async function declineIntegrationProposals(params: {
  workspaceId: string;
  sessionId: string;
  slugs: string[];
}): Promise<void> {
  const status = await waitForRunningRuntime();
  const baseUrl = status?.url?.replace(/\/+$/u, "");
  if (!baseUrl) {
    throw new Error("Embedded runtime is not ready (no url yet).");
  }
  await retryingFetch(`${baseUrl}/api/v1/integrations/proposals/decline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspace_id: params.workspaceId,
      session_id: params.sessionId,
      slugs: params.slugs,
    }),
  });
}
