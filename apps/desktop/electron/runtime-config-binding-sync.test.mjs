import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");

test("desktop runtime config prefers the bound Holaboss sandbox id when auth is present", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const readRuntimeConfigSection =
    source.match(
      /async function readRuntimeConfigFile\(\): Promise<Record<string, string>> \{[\s\S]*?\n}\n\nasync function readRuntimeConfigDocument/,
    )?.[0] ?? "";

  assert.match(
    readRuntimeConfigSection,
    /const bindingSandboxId = runtimeFirstNonEmptyString\([\s\S]*holabossIntegration\.sandbox_id[\s\S]*legacyPayload\.sandbox_id[\s\S]*\);/,
  );
  assert.match(
    readRuntimeConfigSection,
    /const sandboxId =[\s\S]*authToken && bindingSandboxId[\s\S]*\? bindingSandboxId[\s\S]*: runtimeFirstNonEmptyString\([\s\S]*runtimePayload\.sandbox_id[\s\S]*bindingSandboxId[\s\S]*\);/,
  );
  assert.match(
    readRuntimeConfigSection,
    /const subagentsPayload = runtimeConfigObject\(\s*runtimePayload\.subagents \?\? runtimePayload\.subAgents,\s*\);/,
  );
});

test("desktop runtime config writes Holaboss binding fields back into canonical runtime sections", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const writeRuntimeConfigSection =
    source.match(
      /async function writeRuntimeConfigFile\(update: RuntimeConfigUpdatePayload\) \{[\s\S]*?\n}\n\nfunction runtimeConfigField/,
    )?.[0] ?? "";

  assert.match(
    writeRuntimeConfigSection,
    /const runtimePayload = runtimeConfigObject\(currentDocument\.runtime\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /const holabossIntegration = runtimeConfigObject\([\s\S]*integrationsPayload\.holaboss[\s\S]*\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /const holabossProvider = runtimeConfigObject\([\s\S]*providersPayload\[RUNTIME_HOLABOSS_PROVIDER_ID\][\s\S]*\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /assignOrDelete\(holabossIntegration, "auth_token", next\.auth_token\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /assignOrDelete\(holabossIntegration, "sandbox_id", next\.sandbox_id\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /assignOrDelete\(holabossProvider, "api_key", next\.auth_token\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /assignOrDelete\(holabossProvider, "base_url", next\.model_proxy_base_url\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /assignOrDelete\(runtimePayload, "sandbox_id", next\.sandbox_id\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /assignOrDelete\(runtimePayload, "default_provider", next\.default_provider\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /const currentSubagents = runtimeConfigObject\(\s*runtimePayload\.subagents \?\? runtimePayload\.subAgents,\s*\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /assignOrDelete\(currentSubagents, "model", next\.subagent_model\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /\["defaultProvider", "default_provider"\],/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /const currentBackgroundTasks = runtimeConfigObject\(\s*runtimePayload\.background_tasks \?\? runtimePayload\.backgroundTasks,\s*\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /if \(Object\.keys\(currentSubagents\)\.length > 0\) \{\s*runtimePayload\.subagents = currentSubagents;\s*\} else \{\s*delete runtimePayload\.subagents;\s*\}/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /const managedDefaultBackgroundModel = normalizeRuntimeHolabossCatalogDefaultModelId\(\s*update\.defaultBackgroundModel,\s*\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /const managedDefaultEmbeddingModel = normalizeRuntimeHolabossCatalogDefaultModelId\(\s*update\.defaultEmbeddingModel,\s*\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /const currentImageGeneration = runtimeConfigObject\(\s*runtimePayload\.image_generation \?\? runtimePayload\.imageGeneration,\s*\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /const currentRecallEmbeddings = runtimeConfigObject\(\s*runtimePayload\.recall_embeddings \?\? runtimePayload\.recallEmbeddings,\s*\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /const managedDefaultImageModel = normalizeRuntimeHolabossCatalogDefaultModelId\(\s*update\.defaultImageModel,\s*\);/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /runtimePayload\.background_tasks = \{\s*provider: RUNTIME_HOLABOSS_PROVIDER_ID,\s*model: managedDefaultBackgroundModel,\s*\};/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /runtimePayload\.recall_embeddings = \{\s*provider: RUNTIME_HOLABOSS_PROVIDER_ID,\s*model: managedDefaultEmbeddingModel,\s*\};/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /runtimePayload\.image_generation = \{\s*provider: RUNTIME_HOLABOSS_PROVIDER_ID,\s*model: managedDefaultImageModel,\s*\};/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /integrations: integrationsPayload,/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /providers: providersPayload,/,
  );
  assert.match(
    writeRuntimeConfigSection,
    /runtime: runtimePayload,/,
  );
});

test("desktop runtime treats missing managed Holaboss default sections as stale and backfills them", async () => {
  const source = await readFile(mainSourcePath, "utf8");
  const refreshCheckSection =
    source.match(
      /function runtimeBindingNeedsManagedHolabossDefaultsRefresh\([\s\S]*?\n}\n\nfunction configuredProviderIdForRuntimeModelToken/,
    )?.[0] ?? "";

  assert.match(
    refreshCheckSection,
    /Boolean\(runtimeModelCatalogState\.defaultEmbeddingModel\) &&\s*\(Object\.keys\(currentRecallEmbeddings\)\.length === 0 \|\|/,
  );
  assert.match(
    refreshCheckSection,
    /Boolean\(runtimeModelCatalogState\.defaultBackgroundModel\) &&\s*\(Object\.keys\(currentBackgroundTasks\)\.length === 0 \|\|/,
  );
  assert.match(
    refreshCheckSection,
    /Boolean\(runtimeModelCatalogState\.defaultImageModel\) &&\s*\(Object\.keys\(currentImageGeneration\)\.length === 0 \|\|/,
  );
});
