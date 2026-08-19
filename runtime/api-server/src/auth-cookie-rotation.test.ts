import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { ComposioService } from "./composio-service.js";

/**
 * The runtime's session cookie has to survive rotation.
 *
 * It arrives once, in HOLABOSS_AUTH_COOKIE, from the spawn environment.
 * Better-auth reissues the cookie silently (the backend sends a fresh
 * Set-Cookie on get-session and most auth-touching endpoints), and the desktop
 * follows that — its authCookieHeader() deliberately stopped caching for this
 * exact reason. The runtime did not, so its cookie-authenticated calls
 * eventually 401 while chat keeps working on the model-proxy key. Observed
 * live: a Composio search failing with 401 {"error":"unauthorized"}.
 */

function service(cookie: string) {
  return new ComposioService({
    honoBaseUrl: "https://example.test",
    authCookie: cookie,
    fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
  });
}

test("a rotated cookie replaces the one taken at startup", () => {
  const composio = service("better-auth.session=old");
  composio.setAuthCookie("better-auth.session=new");
  assert.equal(composio.authCookie, "better-auth.session=new");
});

test("the cookie is read through a getter, not captured per call site", () => {
  // Three call sites send Cookie: proxy, listConnections and searchTools. If
  // any captured the constructor value, a rotation would fix some and not
  // others — the confusing half-broken state.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(path.join(here, "composio-service.ts"), "utf-8");
  assert.match(text, /get authCookie\(\): string/);
  assert.doesNotMatch(
    text,
    /readonly authCookie/,
    "a readonly field cannot be rotated",
  );
});

test("an empty push is ignored rather than signing the runtime out", () => {
  // "" means "the desktop does not know yet" — during startup, or when
  // better-auth storage is briefly unreadable. Adopting it would turn a
  // transient gap into a hard 401 on every subsequent call.
  const composio = service("better-auth.session=live");
  composio.setAuthCookie("");
  composio.setAuthCookie("   ");
  assert.equal(composio.authCookie, "better-auth.session=live");
});

test("the leading '; ' from better-auth is stripped on both paths", () => {
  // Passed verbatim, Hono on Workers sees an empty leading cookie pair and the
  // session middleware crashes — a generic 500 instead of a clean 401. The
  // constructor already handled this; the rotation path has to as well, or a
  // refresh reintroduces the bug the constructor was fixing.
  const composio = service("; better-auth.session=one");
  assert.equal(composio.authCookie, "better-auth.session=one");
  composio.setAuthCookie("; better-auth.session=two");
  assert.equal(composio.authCookie, "better-auth.session=two");
});
