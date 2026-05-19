import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const MAIN_PATH = new URL("./main.ts", import.meta.url);
const RENDERER_PATH = new URL("../src/main.tsx", import.meta.url);
const ERROR_BOUNDARY_PATH = new URL(
  "../src/components/ui/ErrorBoundary.tsx",
  import.meta.url,
);
const RENDERER_SENTRY_PATH = new URL(
  "../src/lib/rendererSentry.ts",
  import.meta.url,
);
const APP_SHELL_PATH = new URL(
  "../src/components/layout/AppShell.tsx",
  import.meta.url,
);
const CHAT_PANE_PATH = new URL(
  "../src/components/panes/ChatPane.tsx",
  import.meta.url,
);

test("desktop main sentry init adds diagnostics enrichment and runtime env wiring", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(source, /enableLogs:\s*!!process\.env\.SENTRY_DSN/);
  assert.match(source, /attachScreenshot:\s*!!process\.env\.SENTRY_DSN/);
  assert.match(
    source,
    /consoleLoggingIntegration\(\{\s*levels:\s*\["info", "warn", "error"\]/,
  );
  assert.match(source, /beforeSend\(event, hint\)\s*\{\s*return enrichDesktopSentryEvent\(event, hint\);/);
  assert.match(source, /filename:\s*"desktop-runtime-diagnostics\.json"/);
  assert.match(source, /filename:\s*"runtime-log-tail\.txt"/);
  assert.match(source, /filename:\s*"runtime-config\.redacted\.json"/);
  assert.match(source, /HOLABOSS_RUNTIME_LOG_PATH:\s*runtimeLogsPath\(\)/);
  assert.match(source, /HOLABOSS_RUNTIME_CONFIG_PATH:\s*runtimeConfigPath\(\)/);
  assert.match(source, /HOLABOSS_DESKTOP_LAUNCH_ID:\s*DESKTOP_LAUNCH_ID/);
  assert.match(source, /app\.on\("web-contents-created"/);
  assert.match(source, /render-process-gone/);
  assert.match(source, /app\.on\("child-process-gone"/);
  assert.match(source, /app\.on\("browser-window-created"/);
  assert.match(source, /window\.on\("unresponsive"/);
});

test("renderer sentry wiring captures logs and adds renderer crash context", async () => {
  const [
    rendererSource,
    errorBoundarySource,
    rendererSentrySource,
    appShellSource,
    chatPaneSource,
  ] = await Promise.all([
    readFile(RENDERER_PATH, "utf8"),
    readFile(ERROR_BOUNDARY_PATH, "utf8"),
    readFile(RENDERER_SENTRY_PATH, "utf8"),
    readFile(APP_SHELL_PATH, "utf8"),
    readFile(CHAT_PANE_PATH, "utf8"),
  ]);

  assert.match(rendererSource, /enableLogs:\s*true/);
  assert.match(rendererSource, /maxBreadcrumbs:\s*200/);
  assert.match(
    rendererSource,
    /consoleLoggingIntegration\(\{\s*levels:\s*\["warn", "error"\]/,
  );
  assert.match(rendererSource, /eventLoopBlockIntegration\(\{\s*threshold:\s*2000/);
  assert.match(rendererSource, /beforeSend\(event, hint\)\s*\{\s*return enrichRendererSentryEvent\(event, hint\);/);
  assert.match(rendererSource, /Sentry\.setTag\("process_kind", "electron_renderer"\)/);
  assert.match(rendererSentrySource, /filename:\s*"renderer-diagnostics\.json"/);
  assert.match(rendererSentrySource, /process_kind:\s*"electron_renderer"/);
  assert.match(appShellSource, /useRendererSentrySection\("app_shell", appShellSentryState\)/);
  assert.match(appShellSource, /pushRendererSentryActivity\("runtime", "renderer runtime status changed"/);
  assert.match(chatPaneSource, /useRendererSentrySection\("chat_pane", chatPaneSentryState\)/);
  assert.match(chatPaneSource, /pushRendererSentryActivity\("chat", "chat error surfaced"/);
  assert.match(errorBoundarySource, /surface:\s*"renderer_error_boundary"/);
  assert.match(errorBoundarySource, /page_url:\s*window\.location\.href/);
});
