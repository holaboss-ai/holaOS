import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainSourcePath = path.join(__dirname, "main.ts");
const chatPaneSourcePath = path.join(
  __dirname,
  "..",
  "src",
  "components",
  "panes",
  "ChatPane",
  "index.tsx",
);
const sharedCatalogPath = path.join(__dirname, "..", "shared", "model-catalog.ts");
const modelRoutingPath = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "runtime",
  "harnesses",
  "src",
  "model-routing.ts",
);

test("desktop runtime uses the managed holaboss catalog instead of local seed catalogs or local suppression", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /function normalizeRuntimeProviderModelGroups\(/);
  assert.match(source, /mergeManagedCatalog\(managedCatalogGroups\);/);
  assert.match(source, /function syncRuntimeModelCatalogFromBinding\(/);
  assert.doesNotMatch(source, /function isClaudeRuntimeModelId\(modelId: string\): boolean/);
  assert.doesNotMatch(source, /isUnsupportedHolabossRuntimeModel\(/);
  assert.doesNotMatch(source, /seedLegacyHolabossProxyModels/);
  assert.doesNotMatch(source, /RUNTIME_HOLABOSS_LEGACY_PROXY_MODELS/);
});

test("desktop model catalog carries reasoning metadata and the composer persists thinking preferences", async () => {
  const [mainSource, chatPaneSource, sharedCatalogSource] = await Promise.all([
    readFile(mainSourcePath, "utf8"),
    readFile(chatPaneSourcePath, "utf8"),
    readFile(sharedCatalogPath, "utf8"),
  ]);

  assert.match(sharedCatalogSource, /export const PROVIDER_MODEL_CATALOG: ProviderModelCatalog = \{/);
  assert.match(sharedCatalogSource, /holaboss_model_proxy:\s*\{[\s\S]*source: "backend"/);
  assert.match(sharedCatalogSource, /holaboss_model_proxy:\s*\{[\s\S]*"gpt-5\.5"/);
  assert.doesNotMatch(sharedCatalogSource, /openai_direct:/);
  assert.doesNotMatch(sharedCatalogSource, /anthropic_direct:/);
  assert.doesNotMatch(sharedCatalogSource, /gemini_direct:/);
  assert.doesNotMatch(sharedCatalogSource, /ollama_direct:/);
  assert.doesNotMatch(sharedCatalogSource, /openrouter_direct:/);
  assert.doesNotMatch(sharedCatalogSource, /minimax_direct:/);
  assert.match(sharedCatalogSource, /thinking_values:/);
  assert.match(sharedCatalogSource, /input_modalities:/);
  assert.match(mainSource, /catalogMetadataForProviderModel/);
  assert.match(mainSource, /function runtimeModelMetadataFromPayload\(/);
  assert.match(mainSource, /function managedHolabossRuntimeModelConfig\(/);
  assert.match(mainSource, /context_window: model\.contextWindow/);
  assert.match(mainSource, /max_tokens: model\.maxTokens/);
  assert.match(chatPaneSource, /CHAT_THINKING_STORAGE_KEY/);
  assert.match(chatPaneSource, /thinking_value: effectiveThinkingValue/);
});

test("desktop removes Codex as a configurable provider while retaining GPT-5 routing metadata", async () => {
  const [mainSource, modelRoutingSource] = await Promise.all([
    readFile(mainSourcePath, "utf8"),
    readFile(modelRoutingPath, "utf8"),
  ]);

  assert.doesNotMatch(mainSource, /const OPENAI_CODEX_DEFAULT_MODELS =/);
  assert.doesNotMatch(mainSource, /const OPENAI_CODEX_PROVIDER_ID =/);
  assert.doesNotMatch(modelRoutingSource, /openai-codex-responses/);
  assert.match(modelRoutingSource, /if \(api !== "openai-responses"\) \{/);
  assert.match(modelRoutingSource, /switch \(normalizedModelId\) \{[\s\S]*case "gpt-5\.5":[\s\S]*contextWindow: 1_000_000/);
});
