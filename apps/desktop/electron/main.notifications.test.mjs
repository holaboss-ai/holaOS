import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const PRELOAD_PATH = new URL("./preload.ts", import.meta.url);
const TYPES_PATH = new URL("../src/types/electron.d.ts", import.meta.url);

test("main notification IPC path reuses cached results during transient runtime failures", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /const runtimeNotificationListCache = new Map</);
  assert.match(
    source,
    /function isRuntimeHealthcheckStartupFailureMessage\(message: string\): boolean \{[\s\S]*did not pass health checks/s,
  );
  assert.match(source, /function runtimeNotificationListCacheKey\(/);
  assert.match(source, /function emptyRuntimeNotificationListResponse\(\): RuntimeNotificationListResponsePayload/);
  assert.match(source, /runtimeNotificationListCache\.set\(cacheKey,\s*response\);/);
  assert.match(source, /include_cronjob_source:\s*options\?\.includeCronjobSource === true \? true : undefined/);
  assert.match(source, /source_type: options\?\.sourceType \?\? undefined/);
  assert.match(
    source,
    /if \(isTransientRuntimeError\(error\)\) \{\s*return \(\s*runtimeNotificationListCache\.get\(cacheKey\) \?\?\s*emptyRuntimeNotificationListResponse\(\)\s*\);/s,
  );
  // Matches the function definition `isRuntimeHealthcheckStartupFailureMessage(message: string)`.
  // Earlier versions of this regex used `\(message\)` (literal closing paren), which never
  // matched any callsite because main.ts passes `failureMessage` / `error.message`.
  assert.match(source, /isRuntimeHealthcheckStartupFailureMessage\(message:/);
  assert.match(source, /runtimeNotificationListCache\.clear\(\);/);
});

test("desktop bridge exposes native notifications for minimized main-session completions", async () => {
  const [mainSource, preloadSource, typesSource] = await Promise.all([
    readFile(MAIN_PATH, "utf8"),
    readFile(PRELOAD_PATH, "utf8"),
    readFile(TYPES_PATH, "utf8"),
  ]);

  assert.match(mainSource, /interface DesktopNativeNotificationPayload \{/);
  assert.match(mainSource, /function shouldShowNativeDesktopNotification\(\)/);
  assert.match(mainSource, /function shouldUseMacDevelopmentNotificationFallback\(\): boolean \{/);
  assert.match(mainSource, /return process\.platform === "darwin" && !app\.isPackaged;/);
  assert.match(mainSource, /function appleScriptStringLiteral\(value: string\): string \{/);
  assert.match(mainSource, /function showMacDevelopmentNotificationFallback\(payload: \{/);
  assert.match(mainSource, /spawn\("osascript", \["-e", script\], \{/);
  assert.match(mainSource, /logNativeDesktopNotificationEvent\("dev_fallback_requested"/);
  assert.match(mainSource, /logNativeDesktopNotificationEvent\("dev_fallback_shown"/);
  assert.match(mainSource, /logNativeDesktopNotificationEvent\("dev_fallback_failed"/);
  assert.match(
    mainSource,
    /function shouldShowNativeDesktopNotification\(\): boolean \{\s*return Boolean\(\s*mainWindow &&\s*!mainWindow\.isDestroyed\(\) &&\s*mainWindow\.isMinimized\(\),\s*\);\s*\}/s,
  );
  assert.match(mainSource, /function logNativeDesktopNotificationEvent\(/);
  assert.match(mainSource, /function showNativeDesktopNotification\(/);
  assert.match(mainSource, /return new Promise<boolean>\(\(resolve\) => \{/);
  assert.match(mainSource, /new Notification\(\{/);
  assert.match(mainSource, /Notification\.isSupported\(\)/);
  assert.match(mainSource, /logNativeDesktopNotificationEvent\("show_requested"/);
  assert.match(mainSource, /if \(shouldUseMacDevelopmentNotificationFallback\(\)\) \{\s*return showMacDevelopmentNotificationFallback\(\{/s);
  assert.match(mainSource, /notification\.on\("show", \(\) => \{/);
  assert.match(mainSource, /logNativeDesktopNotificationEvent\("shown"/);
  assert.match(mainSource, /notification\.on\("failed", \(_event, error\) => \{/);
  assert.match(mainSource, /logNativeDesktopNotificationEvent\("failed"/);
  assert.match(mainSource, /notification\.on\("close", \(\) => \{/);
  assert.match(mainSource, /logNativeDesktopNotificationEvent\("closed"/);
  assert.match(mainSource, /const showTimeout = setTimeout\(\(\) => \{[\s\S]*settle\(false\);[\s\S]*\}, 1500\);/);
  assert.match(mainSource, /logNativeDesktopNotificationEvent\("show_timeout"/);
  assert.match(mainSource, /if \(process\.platform === "darwin"\) \{\s*app\.dock\?\.show\(\);\s*app\.focus\(\{ steal: true \}\);\s*\} else \{\s*app\.focus\(\);\s*\}/s);
  assert.match(mainSource, /notification\.on\("click", \(\) => \{[\s\S]*logNativeDesktopNotificationEvent\("clicked"[\s\S]*focusOrCreateMainWindow\(\);/s);
  assert.match(mainSource, /"ui:showNativeNotification"/);
  assert.match(preloadSource, /showNativeNotification: \(payload: \{/);
  assert.match(preloadSource, /ipcRenderer\.invoke\("ui:showNativeNotification", payload\)/);
  assert.match(typesSource, /interface DesktopNativeNotificationPayload \{/);
  assert.match(typesSource, /force\?: boolean;/);
  assert.match(typesSource, /interface RuntimeNotificationListOptionsPayload \{/);
  assert.match(
    typesSource,
    /showNativeNotification: \(\s*payload: DesktopNativeNotificationPayload\s*\) => Promise<boolean>;/,
  );
});
