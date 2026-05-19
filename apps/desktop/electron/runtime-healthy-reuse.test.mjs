import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const MAIN_PATH = new URL("./main.ts", import.meta.url);

test("startEmbeddedRuntime only reuses a healthy runtime when it matches the current launch", async () => {
  const source = await readFile(MAIN_PATH, "utf8");

  assert.match(
    source,
    /async function startEmbeddedRuntime\(\) \{[\s\S]*await bootstrapRuntimeDatabase\(\);[\s\S]*const preflightRuntimePort = await ensureRuntimePortAvailable\(\{\s*url,\s*sandboxRoot,\s*reason: "startup_preflight",\s*\}\);[\s\S]*if \(preflightRuntimePort === "reused"\) \{\s*return refreshRuntimeStatus\(\);\s*\}[\s\S]*if \(preflightRuntimePort === "blocked"\) \{[\s\S]*runtimeStatus = withDesktopBrowserStatus\(\{/,
  );
});
