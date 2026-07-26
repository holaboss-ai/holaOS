import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const AUTH_PANEL_PATH = new URL("./AuthPanel.tsx", import.meta.url);
const BILLING_SUMMARY_CARD_PATH = new URL("../billing/BillingSummaryCard.tsx", import.meta.url);
const INDEX_CSS_PATH = new URL("../../index.css", import.meta.url);

test("account auth panel reuses the shared billing summary card", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(source, /import \{ BillingSummaryCard \} from "@\/components\/billing\/BillingSummaryCard";/);
  assert.match(source, /const billingState = useDesktopBilling\(\);/);
  assert.match(source, /<BillingSummaryCard/);
  assert.doesNotMatch(source, /statusDescription/);
  assert.doesNotMatch(source, /Configure model providers and defaults for this desktop runtime\./);
  assert.doesNotMatch(source, /Configure known providers instead of editing raw runtime JSON\./);
  assert.doesNotMatch(source, /rgba\(/);
});

test("billing summary card exposes web-only billing actions", async () => {
  const source = await readFile(BILLING_SUMMARY_CARD_PATH, "utf8");

  assert.match(source, /function openBillingLink\(/);
  assert.match(source, /Add credits/);
  assert.match(source, />\s*Manage\s*</);
  assert.match(source, /openExternalUrl/);
  assert.match(source, /About credits/);
  assert.doesNotMatch(source, /shadow-md/);
  assert.doesNotMatch(source, /Available hosted credits/);
  assert.doesNotMatch(source, /Recent usage/);
  assert.doesNotMatch(source, /text-\[[0-9]+px\]/);
  assert.doesNotMatch(source, /bg-black\//);
});

test("runtime auth panel keeps holaboss-only runtime settings compact", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");
  const runtimeProviderSettingsBlock =
    source.match(/const runtimeProviderSettings = \([\s\S]*?\n  \);\n\n  if \(view === "account"\)/)?.[0] ?? "";

  assert.match(source, /Background tasks/);
  assert.match(source, /Subagent model/);
  assert.match(source, /Recall embeddings/);
  assert.match(source, /Image generation/);
  assert.match(source, /Follow composer/);
  assert.match(source, /Use the current composer model whenever hidden subagent work starts or continues\./);
  assert.match(source, /function runtimeConfigProviderHasModelToken\(/);
  assert.match(source, /const fixedProviderId: KnownProviderId = "holaboss";/);
  assert.match(source, /applyBackgroundTaskProviderSelection\(fixedProviderId\);/);
  assert.match(source, /applyRecallEmbeddingsProviderSelection\(fixedProviderId\);/);
  assert.match(source, /applyImageGenerationProviderSelection\(fixedProviderId\);/);
  assert.match(source, /const backgroundTaskModelOptions = uniqueValues\(\[/);
  assert.match(source, /const recallEmbeddingsModelOptions = uniqueValues\(\[/);
  assert.match(source, /const imageGenerationModelOptions = uniqueValues\(\[/);
  assert.match(source, /const subagentModelToken = \(runtimeConfig\?\.subagentModel \?\? ""\)\.trim\(\);/);
  assert.match(source, /const defaultChatModelOptions = buildDefaultChatModelOptions\(runtimeConfig\)\.filter\(/);
  assert.match(source, /const subagentModelOptions: SettingsMenuOption\[] = \[/);
  assert.match(source, /SUBAGENT_MODEL_FOLLOW_COMPOSER/);
  assert.match(source, /subagentModel:\s*token === SUBAGENT_MODEL_FOLLOW_COMPOSER \? "" : token/);
  assert.match(source, /if \(isSignedIn \|\| isProviderDraftDirty\) \{\s*return;\s*\}/);
  assert.match(source, /if \(backgroundTasksDraft\.providerId === "holaboss"\) \{\s*setBackgroundTasksDraft\(\{ providerId: "", model: "" \}\);\s*\}/);
  assert.match(source, /if \(recallEmbeddingsDraft\.providerId === "holaboss"\) \{\s*setRecallEmbeddingsDraft\(\{ providerId: "", model: "" \}\);\s*\}/);
  assert.match(source, /if \(imageGenerationDraft\.providerId === "holaboss"\) \{\s*setImageGenerationDraft\(\{ providerId: "", model: "" \}\);\s*\}/);
  assert.match(source, /!runtimeConfigProviderHasModelToken\(\s*runtimeConfig,\s*"holaboss_model_proxy",\s*option\.value,\s*\)/);
  assert.match(source, /const staleDefaultModel = runtimeConfigProviderHasModelToken\(\s*runtimeConfig,\s*"holaboss_model_proxy",\s*defaultChatModelToken,\s*\);/);
  assert.match(source, /const staleSubagentModel = runtimeConfigProviderHasModelToken\(\s*runtimeConfig,\s*"holaboss_model_proxy",\s*subagentModelToken,\s*\);/);
  assert.match(source, /setConfig\(\{\s*\.\.\.\(staleDefaultModel \? \{ defaultModel: "" \} : \{\}\),\s*\.\.\.\(staleSubagentModel \? \{ subagentModel: "" \} : \{\}\),\s*\}\)/);
  assert.match(source, /backgroundTaskModelOptions\.map\(\(modelId\) => \(/);
  assert.match(source, /recallEmbeddingsModelOptions\.map\(\(modelId\) => \(/);
  assert.match(source, /imageGenerationModelOptions\.map\(\(modelId\) => \(/);
  assert.match(source, /label="Model"/);
  assert.match(source, /Select a model to enable background tasks\./);
  assert.match(source, /Select a model to enable vector recall\./);
  assert.match(source, /Select a model to enable image generation\./);
  assert.match(source, /<SettingsStatusBadge tone="muted">\s*Using fallback\s*<\/SettingsStatusBadge>/);
  assert.match(source, /<SettingsStatusBadge tone="muted">Disabled<\/SettingsStatusBadge>/);
  assert.doesNotMatch(source, /Background Tasks Model/);
  assert.doesNotMatch(source, /__automatic__/);
  assert.doesNotMatch(source, /Runtime overview/);
  assert.doesNotMatch(source, /Connection details/);
  assert.doesNotMatch(source, /async function handleReloadRuntimeSettings\(\)/);
  assert.doesNotMatch(source, /providerAutosaveMessage/);
  assert.doesNotMatch(source, /Edit settings, then click Save changes\./);
  assert.doesNotMatch(source, /Reload settings/);
  assert.doesNotMatch(source, /<textarea/);
  assert.doesNotMatch(source, /<datalist/);
  assert.doesNotMatch(source, /title="Model providers"/);
  assert.doesNotMatch(source, /No providers connected/);
  assert.doesNotMatch(source, /Add provider/);
  assert.doesNotMatch(source, /label="Provider"/);
  assert.doesNotMatch(source, /function providerCatalogChatModelOptions\(/);
  assert.doesNotMatch(source, /function toggleProviderDraftModel\(/);
  assert.doesNotMatch(source, /function removeProviderDraftModel\(/);
  assert.match(source, /const setupLoadingPanel = \(/);
  assert.match(source, /Refreshing desktop connection\.\.\.|Connecting your account\.\.\./);
  assert.doesNotMatch(source, /Finishing setup/);
  assert.doesNotMatch(source, /Retry setup/);
  assert.doesNotMatch(source, /Sign-in completed\. Holaboss is finishing local runtime setup\./);
  assert.match(runtimeProviderSettingsBlock, /<div className="grid gap-6">/);
  assert.doesNotMatch(runtimeProviderSettingsBlock, /theme-subtle-surface mt-3 grid gap-4 rounded-\[20px\] border border-border\/40 p-4/);
  assert.match(runtimeProviderSettingsBlock, /<SettingsSection\s+title="Background tasks"/);
  assert.match(runtimeProviderSettingsBlock, /<SettingsSection\s+title="Recall embeddings"/);
  assert.match(runtimeProviderSettingsBlock, /<SettingsSection\s+title="Image generation"/);
  assert.doesNotMatch(runtimeProviderSettingsBlock, /<SettingsSection\s+title="Model providers"/);
  assert.doesNotMatch(runtimeProviderSettingsBlock, /<EmptyState/);
});

test("auth panel derives runtime readiness from the shared desktop runtime state", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(source, /import \{ useWorkspaceDesktop \} from "@\/lib\/workspaceDesktop";/);
  assert.match(source, /const \{ runtimeConfig: sharedRuntimeConfig \} = useWorkspaceDesktop\(\);/);
  assert.match(source, /const effectiveRuntimeConfig = sharedRuntimeConfig \?\? runtimeConfig;/);
  assert.match(
    source,
    /const \[hasLoadedRuntimeConfigDocument, setHasLoadedRuntimeConfigDocument\]\s*=\s*useState\(false\);/,
  );
  assert.match(
    source,
    /const \[hydratedRuntimeConfigDocument, setHydratedRuntimeConfigDocument\]\s*=\s*useState<string \| null>\(null\);/,
  );
  assert.match(source, /const hasHydratedProviderDrafts =\s*hasLoadedRuntimeConfigDocument &&\s*hydratedRuntimeConfigDocument === runtimeConfigDocument;/);
  assert.match(source, /Boolean\(effectiveRuntimeConfig\?\.authTokenPresent\)/);
  assert.match(source, /deriveProviderDraftsFromDocument\(\s*parseRuntimeConfigDocument\(runtimeConfigDocument\),\s*effectiveRuntimeConfig,\s*\)/);
  assert.match(source, /setHasLoadedRuntimeConfigDocument\(true\);/);
  assert.match(source, /setHydratedRuntimeConfigDocument\(runtimeConfigDocument\);/);
  assert.match(source, /if \(!hasHydratedProviderDrafts\) \{\s*return;\s*\}/);
});

test("auth panel manual save prefers edited provider credentials over previously persisted values", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(
    source,
    /const currentDocumentText\s*=\s*await window\.electronAPI\.runtime\.getConfigDocument\(\);/,
  );
  assert.match(
    source,
    /const nextProviders: Record<string, unknown> = \{ \.\.\.currentProviders \};/,
  );
  assert.match(
    source,
    /delete nextProviders\[runtimeProviderStorageId\(providerId\)\];/,
  );
  assert.match(
    source,
    /const nextModels: Record<string, unknown> = \{ \.\.\.currentModels \};/,
  );
  assert.match(
    source,
    /if \(\s*isKnownProviderId\(normalizedModelProviderId\) \|\|\s*normalizedModelProviderId === "holaboss_model_proxy"[\s\S]*delete nextModels\[token\];\s*\}/,
  );
  assert.match(source, /for \(const providerId of REMOVED_PROVIDER_IDS\) \{\s*delete nextProviders\[providerId\];\s*\}/);
  assert.match(
    source,
    /async function handleSaveRuntimeSettings\(providerId\?: KnownProviderId\) \{/,
  );
  assert.match(
    source,
    /function providerDraftValidationError\(providerId: KnownProviderId\): string \{/,
  );
  assert.match(source, /void providerId;\s*return "";/);
  assert.match(
    source,
    /const draftsToSave = providerId\s*\?/,
  );
  assert.match(
    source,
    /await persistRuntimeProviderSettings\(\s*draftsToSave,\s*backgroundTasksToSave,\s*recallEmbeddingsToSave,\s*imageGenerationToSave,\s*videoGenerationToSave,\s*\);/,
  );
  assert.match(source, /const recallEmbeddingsToSave = providerId\s*\?/);
  assert.match(source, /const nextDocument = withFixedHolabossWebSearch\(\{/);
  assert.match(source, /await window\.electronAPI\.runtime\.setConfigDocument\(nextDocumentText\);/);
  assert.match(source, /nextRuntime\.recall_embeddings = \{\s*provider: normalizedRecallEmbeddingsProviderId,\s*model: normalizedRecallEmbeddingsModel \|\| null,\s*\};/);
  assert.match(source, /delete nextRuntime\.recall_embeddings;/);
  assert.match(source, /delete nextRuntime\.recallEmbeddings;/);
});

test("auth panel fixes auxiliary runtime selectors to holaboss and clears them on sign-out", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(source, /const fixedProviderId: KnownProviderId = "holaboss";/);
  assert.match(source, /isSignedIn \? fixedProviderId : backgroundTasksDraft\.providerId/);
  assert.match(source, /isSignedIn \? fixedProviderId : recallEmbeddingsDraft\.providerId/);
  assert.match(source, /isSignedIn \? fixedProviderId : imageGenerationDraft\.providerId/);
  assert.match(source, /if \(isSignedIn \|\| isProviderDraftDirty\) \{\s*return;\s*\}/);
  assert.match(source, /if \(backgroundTasksDraft\.providerId === "holaboss"\) \{\s*setBackgroundTasksDraft\(\{ providerId: "", model: "" \}\);\s*\}/);
  assert.match(source, /if \(recallEmbeddingsDraft\.providerId === "holaboss"\) \{\s*setRecallEmbeddingsDraft\(\{ providerId: "", model: "" \}\);\s*\}/);
  assert.match(source, /if \(imageGenerationDraft\.providerId === "holaboss"\) \{\s*setImageGenerationDraft\(\{ providerId: "", model: "" \}\);\s*\}/);
  assert.doesNotMatch(source, /const connectedProviderIds =/);
  assert.doesNotMatch(source, /const availableProviderIds =/);
  assert.doesNotMatch(source, /function handleAddProvider\(/);
  assert.doesNotMatch(source, /label="Provider"/);
});

test("runtime auth panel removes provider branding chrome after collapsing to holaboss-only settings", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.doesNotMatch(source, /function ProviderBrandIcon\(/);
  assert.doesNotMatch(source, /holabossLogoUrl/);
  assert.doesNotMatch(
    source,
    /Catalog, base URL, and credentials come from your Holaboss runtime\s+binding\./,
  );
  assert.doesNotMatch(source, /Supported models/);
  assert.doesNotMatch(
    source,
    /No managed models are available yet\.\s+Refresh your runtime binding\s+to load the latest Holaboss catalog\./,
  );
  assert.doesNotMatch(source, /open=\{Boolean\(expandedProviderId\)\}/);
  assert.doesNotMatch(source, /renderProviderDrawerContent\(expandedProviderId\)/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /openaiLogoMarkup/);
});

test("auth settings controls rely on shared UI components instead of custom auth-settings-control CSS", async () => {
  const [authPanelSource, indexCssSource] = await Promise.all([
    readFile(AUTH_PANEL_PATH, "utf8"),
    readFile(INDEX_CSS_PATH, "utf8"),
  ]);

  assert.match(authPanelSource, /SettingsMenuSelectRow/);
  assert.doesNotMatch(authPanelSource, /import \{ Input \} from "@\/components\/ui\/input";/);
  assert.doesNotMatch(authPanelSource, /import \{ Switch \} from "@\/components\/ui\/switch";/);
  assert.doesNotMatch(authPanelSource, /auth-settings-control/);
  assert.doesNotMatch(indexCssSource, /auth-settings-control/);
});

test("holaboss proxy models come from the managed runtime catalog instead of local defaults", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");
  const holabossTemplate =
    source.match(/holaboss:\s*\{[\s\S]*?apiKeyPlaceholder: "hbrt\.v1\.your-proxy-token"[\s\S]*?\n\s*}/)?.[0] ?? "";

  assert.match(holabossTemplate, /defaultModels: \[\]/);
  assert.match(holabossTemplate, /defaultBackgroundModel: null/);
  assert.match(holabossTemplate, /defaultImageModel: null/);
  assert.match(holabossTemplate, /imageModelSuggestions: \[\]/);
  assert.doesNotMatch(holabossTemplate, /claude-/);
  assert.match(source, /function configuredRuntimeProviderModelIds\(/);
  assert.match(source, /function runtimeCatalogModelSupportsCapability\(/);
  assert.match(
    source,
    /configuredRuntimeProviderModelIds\(\s*runtimeConfig,\s*providerId,\s*"image_generation",?\s*\)/,
  );
  assert.match(
    source,
    /return configuredRuntimeProviderModelIds\(runtimeConfig,\s*providerId,\s*"chat"\);/,
  );
  assert.match(source, /if \(providerId === "holaboss"\) \{\s*return managedCatalogImageModels;\s*\}/);
  assert.match(source, /runtimeConfig\?\.defaultBackgroundModel/);
  assert.match(source, /runtimeConfig\?\.defaultEmbeddingModel/);
  assert.match(source, /runtimeConfig\?\.defaultImageModel/);
  assert.match(source, /markProviderSettingsDirty\(\);/);
  assert.match(source, /shouldAutoselectHolabossBackgroundDefault/);
  assert.match(source, /shouldAutoselectHolabossImageDefault/);
  assert.match(source, /hasHydratedProviderDrafts/);
  assert.match(source, /const runtimeProviderId = "holaboss_model_proxy";/);
  assert.match(source, /function runtimeProviderStorageId\(/);
  assert.match(source, /void providerId;\s*return "holaboss_model_proxy";/);
  assert.match(
    source,
    /return \[\s*"openai\/",\s*"google\/",\s*"anthropic\/",\s*"holaboss\/",\s*"holaboss_model_proxy\/",\s*\]/,
  );
  assert.match(source, /runtimeCatalogModelSupportsCapability\(model, "chat"\)/);
  assert.match(source, /providerId === "holaboss_model_proxy"/);
  assert.match(source, /const fixedProviderId: KnownProviderId = "holaboss";/);
  assert.doesNotMatch(source, /Managed and ready on this desktop\. Expand to edit the background tasks model\./);
});

test("account view uses an inline profile header and theme-colored sign-in action", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(source, /if \(view === "account"\) \{/);
  assert.match(
    source,
    // Card chrome migrated: `rounded-[24px]` → `rounded-3xl` (token
    // scale) and `shadow-card` dropped (settings adopt border-only
    // chrome — see SettingsCard).
    /if \(showsSetupPanel\) \{\s*return \(\s*<section className="theme-shell w-full max-w-none overflow-hidden rounded-3xl border border-border text-sm text-foreground">\s*<div className="px-4 py-5">\s*\{setupPanel\}\s*<\/div>/,
  );
  assert.match(source, /className="flex items-start justify-between gap-3"/);
  assert.match(source, /className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-primary bg-primary\/10 text-lg font-semibold text-primary"/);
  assert.doesNotMatch(source, /rounded-\[28px\] border border-border\/35 bg-card\/95 px-5 py-5 shadow-sm/);
  assert.match(source, /Sign in with browser/);
  assert.match(source, /Refresh session/);
  assert.match(source, /Sign out/);
});

test("web search provider is fixed to hidden managed Holaboss Search", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(source, /const WEB_SEARCH_PROVIDER_ID = "holaboss_search";/);
  assert.match(source, /const WEB_SEARCH_PROVIDER_KIND = "holaboss_search";/);
  assert.match(source, /function withFixedHolabossWebSearch\(/);
  assert.match(source, /provider: WEB_SEARCH_PROVIDER_ID/);
  assert.match(source, /\[WEB_SEARCH_PROVIDER_ID\]: holabossProvider/);
  assert.match(source, /delete nextProviders\.exa;/);
  assert.match(source, /delete nextProviders\.exa_hosted_mcp;/);
  assert.match(source, /const nextDocument = withFixedHolabossWebSearch\(\{/);
  assert.doesNotMatch(source, /title="Web search"/);
  assert.doesNotMatch(source, /label="Search provider"/);
  assert.doesNotMatch(source, /label="Search settings"/);
  assert.doesNotMatch(source, /label: "Exa"/);
  assert.doesNotMatch(source, /kind: "exa_hosted_mcp"/);
  assert.doesNotMatch(source, /mcp\.exa\.ai/);
  assert.doesNotMatch(source, /Optional for Exa/);
});

test("provider templates only expose the Holaboss proxy defaults", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");
  const providerTemplatesBlock =
    source.match(/const KNOWN_PROVIDER_TEMPLATES:[\s\S]*?function isKnownProviderId/)?.[0] ?? "";
  const holabossTemplate =
    providerTemplatesBlock.match(/holaboss:\s*\{[\s\S]*?apiKeyPlaceholder: "hbrt\.v1\.your-proxy-token"[\s\S]*?\n\s*}/)?.[0] ?? "";

  assert.match(source, /const KNOWN_PROVIDER_ORDER = \[\s*"holaboss"\s*\] as const;/);
  assert.match(holabossTemplate, /label: "Holaboss Proxy"/);
  assert.match(holabossTemplate, /defaultModels: \[\]/);
  assert.match(holabossTemplate, /defaultBackgroundModel: null/);
  assert.match(holabossTemplate, /defaultImageModel: null/);
  assert.match(source, /managedCatalogImageModels.length === 0 && template.defaultImageModel/);
  assert.match(source, /backgroundTaskDefaultModel\(providerId, runtimeConfig\)/);
  assert.match(source, /imageGenerationDefaultModel\(providerId, runtimeConfig\)/);
  assert.doesNotMatch(providerTemplatesBlock, /openai_codex:/);
  assert.doesNotMatch(providerTemplatesBlock, /openai_direct:/);
  assert.doesNotMatch(providerTemplatesBlock, /anthropic_direct:/);
  assert.doesNotMatch(providerTemplatesBlock, /gemini_direct:/);
  assert.doesNotMatch(providerTemplatesBlock, /ollama_direct:/);
  assert.doesNotMatch(providerTemplatesBlock, /openrouter_direct:/);
  assert.doesNotMatch(providerTemplatesBlock, /minimax_direct:/);
});
