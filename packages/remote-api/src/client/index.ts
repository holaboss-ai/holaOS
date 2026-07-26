import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { remoteApiContract } from "../contract";
import { generateRequestId, REQUEST_ID_HEADER } from "../logging";

export type RemoteApiClient = ContractRouterClient<typeof remoteApiContract>;

type UrlResolver = string | (() => string | Promise<string>);
type HeadersResolver =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

export interface CreateRemoteApiClientOptions {
  /**
   * Base URL of the runtime RPC endpoint (e.g. `http://127.0.0.1:8080/rpc`).
   * Pass a function to resolve it lazily per request — the embedded runtime's
   * port can change across restarts.
   */
  url: UrlResolver;
  headers?: HeadersResolver;
  /** Override fetch (tests / non-browser hosts). */
  fetch?: typeof fetch;
}

async function resolveStaticHeaders(
  headers: HeadersResolver | undefined
): Promise<Record<string, string>> {
  if (!headers) {
    return {};
  }
  return typeof headers === "function" ? await headers() : headers;
}

export function createRemoteApiClient(
  options: CreateRemoteApiClientOptions
): RemoteApiClient {
  const link = new RPCLink({
    url: options.url,
    fetch: options.fetch,
    // Attach a correlation id so the runtime can tie its start/success/error log
    // lines for this call together. The client itself does not log; this header
    // is the only client-side concern.
    headers: async () => {
      const headers = await resolveStaticHeaders(options.headers);
      if (!headers[REQUEST_ID_HEADER]) {
        headers[REQUEST_ID_HEADER] = generateRequestId();
      }
      return headers;
    },
  });
  return createORPCClient(link);
}
