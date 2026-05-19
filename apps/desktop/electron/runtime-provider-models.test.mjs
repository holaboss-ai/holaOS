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
  "ChatPane.tsx",
);
const sharedCatalogPath = path.join(__dirname, "..", "shared", "model-catalog.ts");
const modelRoutingPath = path.join(
  __dirname,
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

test("desktop runtime normalizes stale direct-provider model aliases for Anthropic and Gemini", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(
    source,
    /const RUNTIME_LEGACY_DIRECT_PROVIDER_MODEL_ALIASES: Record<[\s\S]*?Record<string, string>[\s\S]*?> = \{/,
  );
  assert.match(source, /anthropic_direct:\s*\{[\s\S]*"claude-sonnet-4-5": "claude-sonnet-4-6"/);
  assert.match(source, /gemini_direct:\s*\{[\s\S]*"gemini-3.1-pro-preview": "gemini-2.5-pro"/);
  assert.match(source, /function normalizeRuntimeProviderModelId\(/);
  assert.match(source, /function normalizeRuntimeModelCapabilities\(/);
  assert.match(source, /function upsertRuntimeProviderModel\(/);
});

test("desktop runtime recognizes minimax provider label and strips minimax token prefix", async () => {
  const source = await readFile(mainSourcePath, "utf8");

  assert.match(source, /normalized\.includes\("minimax"\)[\s\S]*?return "MiniMax"/);
  assert.match(source, /normalizedPrefix\.includes\("minimax"\)/);
});

test("desktop model catalog carries reasoning metadata and the composer persists thinking preferences", async () => {
  const [mainSource, chatPaneSource, sharedCatalogSource] = await Promise.all([
    readFile(mainSourcePath, "utf8"),
    readFile(chatPaneSourcePath, "utf8"),
    readFile(sharedCatalogPath, "utf8"),
  ]);

  assert.match(sharedCatalogSource, /export const PROVIDER_MODEL_CATALOG: ProviderModelCatalog = \{/);
  assert.match(sharedCatalogSource, /openai_codex:\s*\{[\s\S]*"gpt-5\.5"/);
  assert.match(sharedCatalogSource, /openrouter_direct:\s*\{[\s\S]*"qwen\/qwen3\.6-plus"/);
  assert.match(sharedCatalogSource, /openrouter_direct:\s*\{[\s\S]*"xiaomi\/mimo-v2-pro"/);
  assert.match(sharedCatalogSource, /openrouter_direct:\s*\{[\s\S]*"z-ai\/glm-5-turbo"/);
  assert.match(sharedCatalogSource, /thinking_values:/);
  assert.match(sharedCatalogSource, /input_modalities:/);
  assert.match(mainSource, /catalogMetadataForProviderModel/);
  assert.match(mainSource, /function runtimeModelMetadataFromPayload\(/);
  assert.match(chatPaneSource, /CHAT_THINKING_STORAGE_KEY/);
  assert.match(chatPaneSource, /thinking_value: effectiveThinkingValue/);
  assert.match(chatPaneSource, /function ThinkingValueSelect\(/);
});

test("desktop codex wiring includes GPT-5.5 defaults and Codex-specific routing budgets", async () => {
  const [mainSource, modelRoutingSource] = await Promise.all([
    readFile(mainSourcePath, "utf8"),
    readFile(modelRoutingPath, "utf8"),
  ]);

  assert.match(mainSource, /const OPENAI_CODEX_DEFAULT_MODELS = \["gpt-5\.4", "gpt-5\.5", "gpt-5\.3-codex"\] as const;/);
  assert.match(modelRoutingSource, /if \(api !== "openai-responses" && api !== "openai-codex-responses"\)/);
  assert.match(modelRoutingSource, /if \(api === "openai-codex-responses"\) \{[\s\S]*case "gpt-5\.5":[\s\S]*contextWindow: 400_000/);
  assert.match(modelRoutingSource, /if \(api === "openai-codex-responses"\) \{[\s\S]*case "gpt-5\.4":[\s\S]*contextWindow: 1_000_000/);
  assert.match(modelRoutingSource, /switch \(normalizedModelId\) \{[\s\S]*case "gpt-5\.5":[\s\S]*contextWindow: 1_000_000/);
});
