import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("before-quit waits for embedded runtime cleanup before allowing Electron to exit", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /let appQuitCleanupPromise: Promise<void> \| null = null;/);
  assert.match(source, /let appQuitCleanupFinished = false;/);
  assert.match(
    source,
    /async function ensureAppQuitCleanup\(\): Promise<void> \{[\s\S]*Promise\.allSettled\(\[\s*stopDesktopBrowserService\(\),\s*stopEmbeddedRuntime\(\),\s*\]\)[\s\S]*appQuitCleanupFinished = true;[\s\S]*\}/,
  );
  assert.match(
    source,
    /app\.on\("before-quit", \(event\) => \{[\s\S]*if \(appQuitCleanupFinished\) \{\s*return;\s*\}[\s\S]*event\.preventDefault\(\);[\s\S]*void ensureAppQuitCleanup\(\)\.finally\(\(\) => \{\s*app\.quit\(\);\s*\}\);[\s\S]*\}\);/,
  );
});

test("stopEmbeddedRuntime tears down a healthy detached runtime when the child handle is missing", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /async function stopEmbeddedRuntime\(\) \{[\s\S]*const running = runtimeProcess;[\s\S]*if \(!running\) \{[\s\S]*const url = runtimeBaseUrl\(\);[\s\S]*if \(await isRuntimeHealthy\(url\)\) \{[\s\S]*await terminateDetachedRuntime\(\{\s*reason: "quit_without_child_handle",\s*url,\s*sandboxRoot: runtimeSandboxRoot\(\),\s*\}\);[\s\S]*runtimeStatus = withDesktopBrowserStatus\(\{/,
  );
});
