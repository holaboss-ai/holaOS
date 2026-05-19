import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime binding lock always releases without rejecting the lock promise", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const lockFunction =
    source.match(
      /async function withRuntimeBindingRefreshLock<T>\([\s\S]*?\n}\n\nasync function getRuntimeConfig/,
    )?.[0] ?? "";

  assert.match(
    lockFunction,
    /let releaseLock = \(\) => \{\};[\s\S]*runtimeBindingRefreshPromise = new Promise<void>\(\(resolve\) => \{\s*releaseLock = resolve;\s*\}\);/,
  );
  assert.doesNotMatch(lockFunction, /lockState\.reject|reject\(error\)/);
  assert.match(
    lockFunction,
    /finally \{\s*releaseLock\(\);\s*runtimeBindingRefreshPromise = null;/,
  );
});
