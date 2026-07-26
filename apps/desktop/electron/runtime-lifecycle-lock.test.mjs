import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime start and stop are serialized behind lifecycle lock", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const lifecycleSection =
    source.match(
      /let runtimeLifecycleChain: Promise<void> = Promise.resolve\(\);[\s\S]*?async function getRuntimeConfig\(\): Promise<RuntimeConfigPayload>/,
    )?.[0] ?? "";
  const stopFunction =
    source.match(
      /async function stopEmbeddedRuntime\(\) \{[\s\S]*?\n}\n\nasync function startEmbeddedRuntime/,
    )?.[0] ?? "";
  const startFunction =
    source.match(
      /async function startEmbeddedRuntime\(\) \{[\s\S]*?\n}\n\nfunction persistFileBookmarks/,
    )?.[0] ?? "";

  assert.match(
    lifecycleSection,
    /function withRuntimeLifecycleLock<T>\(work: \(\) => Promise<T>\): Promise<T> \{/,
  );
  assert.match(
    lifecycleSection,
    /const run = runtimeLifecycleChain\.then\(work, work\);/,
  );
  assert.match(
    lifecycleSection,
    /runtimeLifecycleChain = run[\s\S]*?\.catch\(\(\) => undefined\);/,
  );

  assert.match(
    stopFunction,
    /await withRuntimeLifecycleLock\(async \(\) => \{/,
  );
  assert.match(
    startFunction,
    /return withRuntimeLifecycleLock\(async \(\) => \{/,
  );
});
