/**
 * MCP `tools/list` enumeration, including pagination.
 *
 * Why this is its own module: the names returned here are written into
 * `mcp_registry.allowlist.tool_ids`, and the pi harness filters the agent's tools
 * to that allowlist — so a tool that never got enumerated is silently unavailable
 * to the agent, with no error raised anywhere. `tools/list` is paginated (a server
 * with more tools than fit in one response returns a `nextCursor`), and reading
 * only the first page is why an app could offer `upload_image` while `create_post`
 * was simply absent.
 *
 * Split out of main.ts so this can be tested against a stubbed transport rather
 * than by pattern-matching source text.
 */

/** One page of a `tools/list` response. */
export type McpToolsListPage = { tools: string[]; nextCursor: string | null };

/**
 * How many pages to follow before giving up. Bounded so a server that keeps
 * handing back a cursor cannot spin discovery forever.
 */
export const MAX_MCP_TOOLS_LIST_PAGES = 20;

/**
 * Parse one `tools/list` response body, keeping the cursor.
 *
 * Handles both a plain JSON-RPC body and the Streamable-HTTP variant, where the
 * server answers with an SSE stream of `data:` events.
 */
export function parseMcpToolsListPage(text: string): McpToolsListPage {
  const fromJson = (raw: string): McpToolsListPage | null => {
    try {
      const obj = JSON.parse(raw) as {
        result?: { tools?: Array<{ name?: unknown }>; nextCursor?: unknown };
      };
      const tools = obj?.result?.tools;
      if (Array.isArray(tools)) {
        const cursor = obj?.result?.nextCursor;
        return {
          tools: tools
            .map((tool) => tool?.name)
            .filter((name): name is string => typeof name === "string"),
          nextCursor:
            typeof cursor === "string" && cursor.length > 0 ? cursor : null,
        };
      }
    } catch {
      // not plain JSON — could be an SSE stream; fall through
    }
    return null;
  };

  const direct = fromJson(text);
  if (direct) {
    return direct;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^data:\s*(.*)$/);
    if (match) {
      const parsed = fromJson(match[1]);
      if (parsed) {
        return parsed;
      }
    }
  }
  return { tools: [], nextCursor: null };
}

/** Tool names from a single response, for callers that don't paginate. */
export function parseMcpToolsListResponse(text: string): string[] {
  return parseMcpToolsListPage(text).tools;
}

export type FetchAllMcpToolNamesParams = {
  url: string;
  headers: Record<string, string>;
  sessionId?: string;
  /** Prefix for warnings, e.g. `[web-holaapp] <id>`. */
  label: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
};

/**
 * Enumerate EVERY tool a server exposes, following `tools/list` pagination.
 *
 * `complete` reports whether the whole list was read. Callers MUST NOT cache a
 * partial list: the desktop's tool caches are only cleared on uninstall, so a
 * transient failure mid-pagination would otherwise pin the truncated tool set for
 * the rest of the install.
 */
export async function fetchAllMcpToolNames(
  params: FetchAllMcpToolNamesParams,
): Promise<{ tools: string[]; complete: boolean }> {
  const doFetch = params.fetchImpl ?? fetch;
  const warn = params.log ?? ((message: string) => console.warn(message));
  const names: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_MCP_TOOLS_LIST_PAGES; page += 1) {
    const resp = await doFetch(params.url, {
      method: "POST",
      headers: {
        ...params.headers,
        ...(params.sessionId ? { "Mcp-Session-Id": params.sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2 + page,
        method: "tools/list",
        params: cursor ? { cursor } : {},
      }),
    });
    if (!resp.ok) {
      warn(`${params.label} tools/list → ${resp.status}`);
      return { tools: names, complete: false };
    }
    const { tools, nextCursor } = parseMcpToolsListPage(await resp.text());
    for (const name of tools) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    // A server repeating its cursor would loop forever; treat it as the end.
    if (!nextCursor || nextCursor === cursor) {
      return { tools: names, complete: true };
    }
    cursor = nextCursor;
  }

  warn(`${params.label} tools/list stopped at the ${MAX_MCP_TOOLS_LIST_PAGES}-page cap`);
  return { tools: names, complete: false };
}
