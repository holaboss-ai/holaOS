import dns from "node:dns/promises";
import net from "node:net";

// SSRF guard for server-side fetches whose target URL is (in)directly
// influenced by an agent/caller. It resolves the host via DNS and refuses any
// URL that points at loopback / private / link-local / unique-local / reserved
// address space, defeating the classic "resolve to 169.254.169.254 / 127.0.0.1 /
// an internal 10.x host" metadata-and-intranet exfiltration pattern.
//
// Callers should ALSO use `redirect: "manual"` (or re-validate each Location)
// so a public URL cannot 30x-redirect into a blocked host after this check.

/**
 * Returns true if `ip` (a plain IPv4/IPv6 literal, no brackets) falls inside a
 * range we refuse to fetch from.
 */
export function isBlockedIpLiteral(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    return isBlockedIpv4(ip);
  }
  if (kind === 6) {
    return isBlockedIpv6(ip);
  }
  // Not an IP literal.
  return false;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    // Unparseable → treat as blocked (fail closed).
    return true;
  }
  const [a, b] = parts;
  // 0.0.0.0/8 (incl. 0.0.0.0)
  if (a === 0) {
    return true;
  }
  // 127.0.0.0/8 loopback
  if (a === 127) {
    return true;
  }
  // 10.0.0.0/8 private
  if (a === 10) {
    return true;
  }
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  // 192.168.0.0/16 private
  if (a === 192 && b === 168) {
    return true;
  }
  // 169.254.0.0/16 link-local (cloud metadata lives here)
  if (a === 169 && b === 254) {
    return true;
  }
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

function isBlockedIpv6(ipRaw: string): boolean {
  const ip = ipRaw.toLowerCase();
  // Loopback ::1 (and its expanded form) and unspecified ::
  if (ip === "::1" || ip === "::" || ip === "0:0:0:0:0:0:0:1" || ip === "0:0:0:0:0:0:0:0") {
    return true;
  }
  // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4 address.
  const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    return isBlockedIpv4(mapped[1]);
  }
  // fc00::/7 unique-local (fc00:: – fdff::)
  if (ip.startsWith("fc") || ip.startsWith("fd")) {
    return true;
  }
  // fe80::/10 link-local
  if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) {
    return true;
  }
  return false;
}

/**
 * Explicit ops/test opt-back-in: a comma-separated allowlist of host or
 * host:port entries (e.g. "127.0.0.1,localhost,10.0.0.5:8080") that bypass the
 * private-range block. Empty by default — the guard is fully closed unless an
 * operator (or a test harness) deliberately widens it.
 */
function allowedSsrfHosts(): Set<string> {
  const raw = (process.env.SANDBOX_SSRF_ALLOW_HOSTS ?? "").trim();
  if (!raw) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * Throws if `rawUrl` is not a safe, public http(s) URL. Resolves the host via
 * DNS and rejects when ANY resolved address is in a blocked range, when the
 * host is `localhost`, or when the host is an IP literal in a blocked range.
 * Also rejects on DNS-resolution failure (fail closed). Hosts explicitly listed
 * in SANDBOX_SSRF_ALLOW_HOSTS bypass the block.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("url must be a valid http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must use http or https");
  }

  // Strip IPv6 brackets: `[::1]` → `::1`.
  const host = url.hostname.replace(/^\[|\]$/g, "").trim().toLowerCase();
  if (!host) {
    throw new Error("url host is not allowed");
  }

  // Ops/test explicit allowlist — matches by host or host:port.
  const allowed = allowedSsrfHosts();
  if (allowed.has(host) || (url.port && allowed.has(`${host}:${url.port}`))) {
    return;
  }

  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("url host is not allowed (localhost)");
  }

  // If the host is already an IP literal, check it directly — no DNS needed.
  if (net.isIP(host)) {
    if (isBlockedIpLiteral(host)) {
      throw new Error("url resolves to a non-public address");
    }
    return;
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch {
    // DNS failure → fail closed rather than let the fetch resolve it later.
    throw new Error("url host could not be resolved");
  }
  if (resolved.length === 0) {
    throw new Error("url host could not be resolved");
  }
  for (const { address } of resolved) {
    if (isBlockedIpLiteral(address)) {
      throw new Error("url resolves to a non-public address");
    }
  }
}

export interface SsrfSafeFetchOptions {
  /** Request init forwarded to fetch (headers, method, signal, …). */
  init?: RequestInit;
  /** Max number of redirect hops to follow (default 5). */
  maxRedirects?: number;
  /**
   * When set, these header names (case-insensitive) are stripped on any hop
   * whose origin differs from the ORIGINAL request origin — so credentials are
   * never leaked to a redirect target on another host.
   */
  originScopedHeaders?: string[];
}

/**
 * A `fetch` that (a) SSRF-validates the initial URL and every redirect hop and
 * (b) follows redirects MANUALLY so a 30x to a blocked/other host can't be
 * auto-followed. Origin-scoped headers are dropped once we leave the original
 * origin. Returns the final non-redirect Response.
 */
export async function ssrfSafeFetch(
  rawUrl: string,
  options: SsrfSafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  const originScoped = new Set(
    (options.originScopedHeaders ?? []).map((h) => h.toLowerCase()),
  );
  const originalOrigin = new URL(rawUrl).origin;
  const baseHeaders = new Headers(options.init?.headers ?? {});

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicHttpUrl(currentUrl);

    const headers = new Headers(baseHeaders);
    if (originScoped.size > 0 && new URL(currentUrl).origin !== originalOrigin) {
      for (const name of originScoped) {
        headers.delete(name);
      }
    }

    const response = await fetch(currentUrl, {
      ...options.init,
      headers,
      redirect: "manual",
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return response;
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return response;
  }
  throw new Error("too many redirects");
}
