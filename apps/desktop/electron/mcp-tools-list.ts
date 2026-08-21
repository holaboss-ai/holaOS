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
 * Per-page request timeout. Discovery runs on the pre-turn hot path (every attach
 * loop before a turn), and pagination multiplies any slowness by the page count —
 * so an unbounded request could stall a turn behind a server that never answers.
 */
export const MCP_TOOLS_LIST_PAGE_TIMEOUT_MS = 10_000;

/**
 * Parse one `tools/list` response body, keeping the cursor.
 *
 * Handles both a plain JSON-RPC body and the Streamable-HTTP variant, where the
 * server answers with an SSE stream of `data:` events.
 */
export function parseMcpToolsListPage(text: string): McpToolsListPage | null {
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
  // Nothing that looks like a tools/list result — an error body, a truncated
  // stream, HTML from a proxy. NOT the same as "a page with no tools", and the
  // difference matters: an empty page is a complete answer, an unparseable one
  // means we never learned what this server exposes.
  return null;
}

/** Tool names from a single response, for callers that don't paginate. */
export function parseMcpToolsListResponse(text: string): string[] {
  return parseMcpToolsListPage(text)?.tools ?? [];
}

export type FetchAllMcpToolNamesParams = {
  url: string;
  headers: Record<string, string>;
  sessionId?: string;
  /** Prefix for warnings, e.g. `[web-holaapp] <id>`. */
  label: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  /** Per-page timeout; see MCP_TOOLS_LIST_PAGE_TIMEOUT_MS. */
  timeoutMs?: number;
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
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_MCP_TOOLS_LIST_PAGES; page += 1) {
    // Every early exit below keeps the names gathered so far and reports
    // complete:false. Returning what we have beats returning nothing — but it
    // must never be mistaken for the whole list, or a caller caches a truncated
    // set (these caches only clear on uninstall) and the missing tools stay
    // invisible to the agent for the rest of the install.
    let body: string;
    try {
      const resp = await doFetch(params.url, {
        method: "POST",
        // Bound each page independently: a 20-page walk must not become a
        // 20x-unbounded stall in front of the user's turn.
        signal: AbortSignal.timeout(
          params.timeoutMs ?? MCP_TOOLS_LIST_PAGE_TIMEOUT_MS,
        ),
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
      body = await resp.text();
    } catch (err) {
      // A rejected fetch (DNS/TLS/ECONNRESET/abort) on page 2+ must not discard
      // page 1 by propagating — the caller's catch would turn a partial list
      // into no tools at all, which is worse than the single-page behaviour
      // this function replaced.
      warn(`${params.label} tools/list request failed: ${String(err)}`);
      return { tools: names, complete: false };
    }

    const parsed = parseMcpToolsListPage(body);
    if (!parsed) {
      warn(`${params.label} tools/list returned an unparseable body`);
      return { tools: names, complete: false };
    }
    for (const name of parsed.tools) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }

    // No cursor is the only signal that means "you have everything".
    if (!parsed.nextCursor) {
      return { tools: names, complete: true };
    }
    // A cursor we've already followed means the server is looping (the spec asks
    // for stable cursors, so this is a server bug, not an exotic case). Stop —
    // but as INCOMPLETE, because the remaining pages were never read.
    if (seenCursors.has(parsed.nextCursor)) {
      warn(
        `${params.label} tools/list repeated cursor '${parsed.nextCursor}' — stopping, tool list may be truncated`,
      );
      return { tools: names, complete: false };
    }
    seenCursors.add(parsed.nextCursor);
    cursor = parsed.nextCursor;
  }

  warn(`${params.label} tools/list stopped at the ${MAX_MCP_TOOLS_LIST_PAGES}-page cap`);
  return { tools: names, complete: false };
}
