import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime config bootstrap does not block on remote catalog refreshes", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /async function getRuntimeConfigSnapshot\(/);
  assert.match(
    source,
    /function refreshRuntimeModelCatalogInBackground\(\): void \{[\s\S]*refreshRuntimeModelCatalogIfNeeded\(\)[\s\S]*emitRuntimeConfig\(\);[\s\S]*\}/,
  );
  assert.match(
    source,
    /async function getRuntimeConfig\(\): Promise<RuntimeConfigPayload> \{\s*refreshRuntimeModelCatalogInBackground\(\);\s*return getRuntimeConfigSnapshot\(runtimeModelCatalogState\);\s*\}/,
  );
  assert.match(
    source,
    /async function emitRuntimeConfig\(config\?: RuntimeConfigPayload\) \{\s*const payload = config \?\? \(await getRuntimeConfigWithoutCatalogRefresh\(\)\);/,
  );
});

test("desktop runtime model catalog fetches time out instead of hanging bootstrap forever", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /const RUNTIME_MODEL_CATALOG_FETCH_TIMEOUT_MS = 8_000;/);
  assert.match(source, /const controller = new AbortController\(\);/);
  assert.match(
    source,
    /const timeout = setTimeout\(\(\) => \{\s*controller\.abort\(\);\s*\}, RUNTIME_MODEL_CATALOG_FETCH_TIMEOUT_MS\);/,
  );
  assert.match(source, /signal: controller\.signal,/);
  assert.match(
    source,
    /timed out after \$\{RUNTIME_MODEL_CATALOG_FETCH_TIMEOUT_MS\}ms/,
  );
  assert.match(source, /clearTimeout\(timeout\);/);
});
