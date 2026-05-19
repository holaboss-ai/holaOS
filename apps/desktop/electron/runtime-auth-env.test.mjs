import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const authPopupPreloadPath = path.join(__dirname, "authPopupPreload.ts");

test("embedded runtime launch forwards auth base URL alongside the auth cookie", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const startFunction =
    source.match(
      /async function startEmbeddedRuntime\(\) \{[\s\S]*?\n}\n\nfunction persistFileBookmarks/,
    )?.[0] ?? "";

  assert.match(
    startFunction,
    /env:\s*\{[\s\S]*HOLABOSS_AUTH_BASE_URL:\s*AUTH_BASE_URL,[\s\S]*HOLABOSS_AUTH_COOKIE:\s*authCookieHeader\(\)\s*\?\?\s*"",/,
  );
});

test("embedded runtime bridge uses the same proactive base URL resolution as interactive calls", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /function runtimeProactiveBridgeBaseUrl\(\)\s*\{\s*return proactiveBaseUrl\(\);\s*\}/,
  );
  assert.match(
    source,
    /PROACTIVE_ENABLE_REMOTE_BRIDGE:\s*"0"/,
  );
  assert.match(
    source,
    /PROACTIVE_BRIDGE_BASE_URL:\s*runtimeProactiveBridgeBaseUrl\(\)/,
  );
});

test("desktop runtime control plane base URL prefers the explicit sandbox gateway override", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /const DESKTOP_CONTROL_PLANE_BASE_URL =\s*configuredRemoteBaseUrl\(\s*\["HOLABOSS_DESKTOP_CONTROL_PLANE_BASE_URL"\],\s*packagedDesktopConfig\.desktopControlPlaneBaseUrl,\s*\)\s*\|\|\s*serviceBaseUrlFromControlPlane\(BACKEND_BASE_URL, 3060\);/,
  );
});

test("auth popup runtime defaults prefer the explicit sandbox gateway override", async () => {
  const source = await readFile(authPopupPreloadPath, "utf8");

  assert.match(
    source,
    /const CONTROL_PLANE_BASE_URL =\s*configuredRemoteBaseUrl\("HOLABOSS_DESKTOP_CONTROL_PLANE_BASE_URL"\)\s*\|\|\s*serviceBaseUrlFromHost\(BACKEND_BASE_URL, 3060\);/,
  );
});
