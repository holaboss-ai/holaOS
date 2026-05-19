import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime binding refreshes when managed Holaboss defaults are still missing", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const provisionFunction =
    source.match(
      /async function provisionRuntimeBindingForAuthenticatedUser\([\s\S]*?\n}\n\nasync function ensureRuntimeBindingReadyForWorkspaceFlow/,
    )?.[0] ?? "";

  assert.match(
    source,
    /function runtimeBindingNeedsManagedHolabossDefaultsRefresh\(\s*config: Record<string, string>,\s*document: Record<string, unknown>,\s*\): boolean \{/,
  );
  assert.match(
    source,
    /!runtimeModelCatalogState\.defaultBackgroundModel \|\|[\s\S]*!runtimeModelCatalogState\.defaultImageModel/,
  );
  assert.match(
    source,
    /const currentDocument = await readRuntimeConfigDocument\(\);/,
  );
  assert.match(
    source,
    /const managedDefaultsNeedRefresh =[\s\S]*runtimeBindingNeedsManagedHolabossDefaultsRefresh\(\s*currentConfig,\s*currentDocument,\s*\);/,
  );
  assert.match(
    provisionFunction,
    /!runtimeConfigNeedsBindingRefresh\(currentConfig, userId\) &&[\s\S]*!managedDefaultsNeedRefresh/,
  );
});
