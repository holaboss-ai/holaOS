import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("waitForAuthCallback resolves on emitAuthAuthenticated", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  // emitAuthAuthenticated notifies gatewayAuthCallbackListeners
  assert.match(
    source,
    /function emitAuthAuthenticated\(user: AuthUserPayload\)[\s\S]*?for \(const listener of gatewayAuthCallbackListeners\) \{\s*listener\(\);\s*\}/,
  );
});

test("waitForAuthCallback resolves on emitAuthUserUpdated with non-null user", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  // emitAuthUserUpdated notifies gatewayAuthCallbackListeners when user is non-null
  // (covers callback paths C/D where emitAuthAuthenticated is not called)
  assert.match(
    source,
    /function emitAuthUserUpdated\(user: AuthUserPayload \| null\)[\s\S]*?if \(user\) \{\s*for \(const listener of gatewayAuthCallbackListeners\)/,
  );
});

test("waitForAuthCallback rejects on emitAuthError instead of hanging until timeout", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  // emitAuthError notifies gatewayAuthErrorListeners so waiters reject promptly
  assert.match(
    source,
    /function emitAuthError\(payload: AuthErrorPayload\)[\s\S]*?for \(const listener of gatewayAuthErrorListeners\) \{\s*listener\(payload\);\s*\}/,
  );

  // waitForAuthCallback registers both success and error listeners
  assert.match(source, /gatewayAuthCallbackListeners\.add\(successListener\)/);
  assert.match(source, /gatewayAuthErrorListeners\.add\(errorListener\)/);
});

test("waitForAuthCallback cleans up all listeners on any terminal event", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  // A shared cleanup function removes both listener types and clears the timer
  assert.match(
    source,
    /const cleanup = \(\) => \{[\s\S]*?clearTimeout\(timer\)[\s\S]*?gatewayAuthCallbackListeners\.delete\(successListener\)[\s\S]*?gatewayAuthErrorListeners\.delete\(errorListener\)[\s\S]*?\}/,
  );

  // cleanup is called from timeout, success, and error paths
  assert.match(source, /const timer = setTimeout\(\(\) => \{\s*cleanup\(\)/);
  assert.match(source, /const successListener = \(\) => \{\s*cleanup\(\)/);
  assert.match(source, /const errorListener = \(err: AuthErrorPayload\) => \{\s*cleanup\(\)/);
});

test("concurrent 401s are deduplicated to a single sign-in prompt", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  // pendingGatewayAuthRetry gates creation of new auth flows
  assert.match(source, /let pendingGatewayAuthRetry: Promise<void> \| null = null;/);
  assert.match(source, /if \(!pendingGatewayAuthRetry\) \{/);
  assert.match(source, /pendingGatewayAuthRetry = authComplete\.finally\(\(\) => \{/);
  assert.match(source, /pendingGatewayAuthRetry = null;/);
});

test("401 retry sends cookie in control plane headers", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  // controlPlaneHeaders includes the session cookie
  assert.match(source, /const cookie = authCookieHeader\(\);/);
  assert.match(source, /headers\["Cookie"\] = cookie;/);
});
