import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime binding exchange wraps network failures with the exchange URL", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const exchangeFunction =
    source.match(
      /async function exchangeDesktopRuntimeBinding\([\s\S]*?\n}\n\nfunction emitAuthAuthenticated/,
    )?.[0] ?? "";

  assert.match(
    exchangeFunction,
    /const exchangeUrl = `\$\{controlPlaneBaseUrl\}\$\{DESKTOP_RUNTIME_BINDING_EXCHANGE_PATH\}`;/,
  );
  assert.match(
    exchangeFunction,
    /catch \(error\) \{\s*throw new Error\(\s*`Runtime binding exchange request failed for \$\{exchangeUrl\}: \$\{error instanceof Error \? error\.message : String\(error\)\}`/,
  );
});

test("desktop runtime consumes the authoritative model catalog from exchange and the dedicated catalog endpoint", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /const DESKTOP_RUNTIME_MODEL_CATALOG_PATH =\s*"\/api\/v1\/desktop-runtime\/model-catalog";/,
  );
  assert.match(
    source,
    /interface RuntimeBindingExchangePayload \{[\s\S]*default_background_model\?: string;[\s\S]*default_image_model\?: string;[\s\S]*catalog_version\?: string;[\s\S]*provider_model_groups\?: RuntimeProviderModelGroupPayload\[];/,
  );
  assert.match(
    source,
    /interface RuntimeModelCatalogPayload \{[\s\S]*defaultBackgroundModel: string \| null;[\s\S]*defaultImageModel: string \| null;[\s\S]*providerModelGroups: RuntimeProviderModelGroupPayload\[];/,
  );
  assert.match(
    source,
    /interface RuntimeProviderModelPayload \{[\s\S]*capabilities\?: string\[];/,
  );
  assert.match(
    source,
    /async function fetchDesktopRuntimeModelCatalog\(\): Promise<RuntimeModelCatalogResponsePayload>/,
  );
  assert.match(source, /async function syncRuntimeModelCatalogFromBinding\(/);
  assert.match(source, /await syncRuntimeModelCatalogFromBinding\(binding\);/);
});

test("desktop runtime refreshes stale managed catalogs immediately when a default is missing", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const refreshFunction =
    source.match(
      /function shouldRefreshRuntimeModelCatalog\(force = false\): boolean \{[\s\S]*?\n}\n\nfunction hasRecentRuntimeModelCatalogRefreshFailure/,
    )?.[0] ?? "";

  assert.match(
    refreshFunction,
    /if \(\s*!runtimeModelCatalogState\.defaultBackgroundModel \|\|\s*!runtimeModelCatalogState\.defaultEmbeddingModel \|\|\s*!runtimeModelCatalogState\.defaultImageModel\s*\) \{\s*return true;\s*\}/,
  );
});

test("desktop runtime backfills managed Holaboss defaults into runtime config after catalog refresh", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /async function syncManagedHolabossDefaultsToRuntimeConfigIfNeeded\([\s\S]*await writeRuntimeConfigFile\(\{\s*defaultBackgroundModel: managedCatalog\.defaultBackgroundModel,\s*defaultEmbeddingModel: managedCatalog\.defaultEmbeddingModel,\s*defaultImageModel: managedCatalog\.defaultImageModel,\s*\}\);[\s\S]*return true;/,
  );
  assert.match(
    source,
    /await persistRuntimeModelCatalog\(payload\);[\s\S]*syncManagedHolabossDefaultsToRuntimeConfigIfNeeded\(payload\)[\s\S]*syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded\(\)[\s\S]*await emitRuntimeConfig\(\);/,
  );
  assert.match(
    source,
    /if \(!shouldRefreshRuntimeModelCatalog\(Boolean\(options\?\.force\)\)\) \{[\s\S]*syncManagedHolabossDefaultsToRuntimeConfigIfNeeded\(\)[\s\S]*syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded\(\)[\s\S]*await emitRuntimeConfig\(\);[\s\S]*return runtimeModelCatalogState;\s*\}/,
  );
  assert.match(
    source,
    /async function getRuntimeConfigWithoutCatalogRefresh\(\): Promise<RuntimeConfigPayload> \{[\s\S]*syncManagedHolabossDefaultsToRuntimeConfigIfNeeded\(managedCatalog\)[\s\S]*syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded\(\)[\s\S]*return getRuntimeConfigSnapshot\(runtimeModelCatalogState\);[\s\S]*return getRuntimeConfigSnapshot\(managedCatalog\);[\s\S]*\}/,
  );
});

test("desktop runtime backfills missing Codex default models for existing OAuth configs", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /function withProviderDefaultModels\([\s\S]*const existingModelIds = runtimeDocumentProviderModelIds\(document, providerId\);[\s\S]*nextModels\[\`\$\{providerId\}\/\$\{normalizedModelId\}\`\] = \{\s*provider: providerId,\s*model: normalizedModelId,\s*\};[\s\S]*return \{\s*\.\.\.document,\s*models: nextModels,\s*\};/,
  );
  assert.match(
    source,
    /function withOpenAiCodexProviderState\([\s\S]*return withProviderDefaultModels\(\{[\s\S]*providers: nextProviders,[\s\S]*\}, OPENAI_CODEX_PROVIDER_ID, OPENAI_CODEX_DEFAULT_MODELS\);/,
  );
  assert.match(
    source,
    /async function syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded\(\): Promise<boolean> \{[\s\S]*withProviderDefaultModels\([\s\S]*OPENAI_CODEX_PROVIDER_ID,[\s\S]*OPENAI_CODEX_DEFAULT_MODELS,[\s\S]*await writeRuntimeConfigTextAtomically\(nextText\);[\s\S]*return true;\s*\}/,
  );
  assert.match(
    source,
    /async function getRuntimeConfigDocumentText\(\): Promise<string> \{\s*await syncOpenAiCodexDefaultsToRuntimeConfigIfNeeded\(\);/,
  );
});
