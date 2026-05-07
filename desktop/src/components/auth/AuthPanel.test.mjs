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

  assert.match(source, /Add credits/);
  assert.match(source, /Billing managed on web/);
  assert.match(source, />\s*Manage\s*</);
  assert.match(source, /openExternalUrl/);
  assert.doesNotMatch(source, /shadow-md/);
  assert.doesNotMatch(source, /Available hosted credits/);
  assert.doesNotMatch(source, /Recent usage/);
  assert.doesNotMatch(source, /text-\[[0-9]+px\]/);
  assert.doesNotMatch(source, /bg-black\//);
});

test("runtime auth panel keeps model provider settings compact", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");
  const runtimeProviderSettingsBlock =
    source.match(/const runtimeProviderSettings = \([\s\S]*?\n  \);\n\n  if \(view === "account"\)/)?.[0] ?? "";

  assert.match(source, /Background tasks/);
  assert.match(source, /Subagent model/);
  assert.match(source, /Provider model resolution needs attention/);
  assert.match(source, /No embedding model can be resolved from the currently connected providers\./);
  assert.match(source, /No image generation model can be resolved from the currently connected providers\./);
  assert.match(source, /className="flex items-start gap-3 rounded-xl bg-warning\/10 px-4 py-3 ring-1 ring-warning\/25"/);
  assert.match(source, /className="font-medium text-foreground"/);
  assert.match(source, /Used for memory recall and evolve tasks\./);
  assert.match(source, /Recall embeddings/);
  assert.match(source, /Advanced settings/);
  assert.match(source, /Used to preselect memory candidates for recall\./);
  assert.match(source, /Embedding indexing stays off the user input path\./);
  assert.match(
    source,
    /Until\s+embeddings have been indexed separately, recall continues\s+to use the staged path\./,
  );
  assert.match(source, /Image generation/);
  assert.match(
    source,
    /Used when the agent generates new images into the\s+workspace\./,
  );
  assert.match(source, /Select a model to enable image generation\./);
  assert.match(source, /Select a model to enable background tasks\./);
  assert.match(source, /Select a model to enable vector recall\./);
  assert.match(source, /Follow composer/);
  assert.match(source, /Used for new sessions and whenever the composer stays on Auto\./);
  assert.match(source, /Use the current composer model whenever hidden subagent work starts or continues\./);
  assert.match(source, /Optional override for hidden subagent runs\. Leave it on Follow composer to use the current composer model\./);
  assert.match(source, /function runtimeConfigProviderHasModelToken\(/);
  assert.match(source, /title="Model providers"/);
  assert.match(source, /No providers connected/);
  assert.match(
    source,
    /Pick one to give the agent access to a model\.\s+You can add more\s+later\./,
  );
  assert.match(source, /Add provider/);
  assert.match(source, /applyBackgroundTaskProviderSelection/);
  assert.match(source, /applyRecallEmbeddingsProviderSelection/);
  assert.match(source, /applyImageGenerationProviderSelection/);
  assert.match(source, /function providerCatalogChatModelOptions\(/);
  assert.match(source, /function toggleProviderDraftModel\(/);
  assert.match(source, /function removeProviderDraftModel\(/);
  assert.match(source, /import \{ Switch \} from "@\/components\/ui\/switch";/);
  assert.match(source, /<Switch\s+checked=\{selected\}/);
  assert.match(source, /aria-label=\{`Toggle \$\{option\.label\}`\}/);
  assert.match(source, /catalogModelOptions\.map\(\(option\) => \{/);
  assert.match(source, /selected \? "On" : "Off"/);
  assert.match(source, /Select at least one configured model before saving\./);
  assert.match(source, /Some saved models are not in the local catalog\./);
  assert.match(source, /const AUTH_PANEL_SELECT_TRIGGER_CLASS_NAME =/);
  assert.match(source, /hover:border-border/);
  assert.match(source, /overflow-hidden/);
  assert.match(source, /focus-visible:ring-0/);
  assert.match(source, /const backgroundTaskModelOptions = uniqueValues\(\[/);
  assert.match(source, /const recallEmbeddingsModelOptions = uniqueValues\(\[/);
  assert.match(source, /const imageGenerationModelOptions = uniqueValues\(\[/);
  assert.match(source, /const subagentModelToken = \(runtimeConfig\?\.subagentModel \?\? ""\)\.trim\(\);/);
  assert.match(source, /const defaultChatModelOptions = buildDefaultChatModelOptions\(runtimeConfig\)\.filter\(/);
  assert.match(source, /const subagentModelOptions: SettingsMenuOption\[] = \[/);
  assert.match(source, /SUBAGENT_MODEL_FOLLOW_COMPOSER/);
  assert.match(source, /subagentModel:\s*token === SUBAGENT_MODEL_FOLLOW_COMPOSER \? "" : token/);
  assert.match(source, /onClick=\{\(\) => setShowAdvancedRuntimeSettings\(true\)\}/);
  assert.match(source, /if \(!next\) setShowAdvancedRuntimeSettings\(false\);/);
  assert.match(source, /const advancedSettingsWarnings = \[/);
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
  assert.match(source, /!backgroundTasksDraft\.providerId \|\|\s*backgroundTaskModelOptions\.length === 0/);
  assert.match(source, /!recallEmbeddingsDraft\.providerId \|\|\s*recallEmbeddingsModelOptions\.length === 0/);
  assert.match(source, /!imageGenerationDraft\.providerId \|\|\s*imageGenerationModelOptions\.length === 0/);
  assert.match(source, /if \(\s*isProviderDraftDirty \|\|\s*recallEmbeddingsDraft\.providerId \|\|\s*connectedRecallEmbeddingProviderIds\.length === 0\s*\) \{\s*return;\s*\}/);
  assert.match(
    source,
    /applyRecallEmbeddingsProviderSelection\(\s*connectedRecallEmbeddingProviderIds\[0\] \?\? "",\s*\);/,
  );
  assert.match(
    source,
    /Selected provider is not connected\.\s+Background tasks\s+stay disabled until you reconnect it or choose another\s+provider\./,
  );
  assert.match(
    source,
    /Selected provider is not connected\.\s+Vector recall\s+stays disabled until you reconnect it or choose\s+another provider\./,
  );
  assert.match(
    source,
    /Selected provider is not connected\.\s+Image generation\s+stays disabled until you reconnect it or choose\s+another provider\./,
  );
  assert.doesNotMatch(source, /Background Tasks Model/);
  assert.doesNotMatch(source, /__automatic__/);
  assert.doesNotMatch(source, /Recall uses:/);
  assert.doesNotMatch(source, /Post-run uses:/);
  assert.doesNotMatch(source, /Runtime overview/);
  assert.doesNotMatch(source, /Connected now/);
  assert.doesNotMatch(source, /Ready to connect/);
  assert.doesNotMatch(source, /Connection details/);
  assert.doesNotMatch(source, /Recommended models configured/);
  assert.doesNotMatch(source, /async function handleReloadRuntimeSettings\(\)/);
  assert.doesNotMatch(source, /providerAutosaveMessage/);
  assert.doesNotMatch(source, /Edit settings, then click Save changes\./);
  assert.doesNotMatch(source, /Reload settings/);
  assert.doesNotMatch(source, /This provider will be disconnected when you save changes\./);
  assert.doesNotMatch(source, /<textarea/);
  assert.doesNotMatch(source, /<datalist/);
  assert.doesNotMatch(source, /set one manually in Advanced settings/);
  assert.match(source, /const setupLoadingPanel = \(/);
  assert.match(source, /Refreshing desktop connection\.\.\.|Connecting your account\.\.\./);
  assert.match(
    source,
    /Finalizing your desktop session and runtime binding\.\s+This should only\s+take a moment\./,
  );
  assert.doesNotMatch(source, /Finishing setup/);
  assert.doesNotMatch(source, /Retry setup/);
  assert.doesNotMatch(source, /Sign-in completed\. Holaboss is finishing local runtime setup\./);
  assert.match(runtimeProviderSettingsBlock, /<div className="grid gap-6">/);
  assert.doesNotMatch(runtimeProviderSettingsBlock, /theme-subtle-surface mt-3 grid gap-4 rounded-\[20px\] border border-border\/40 p-4/);
  assert.match(
    runtimeProviderSettingsBlock,
    /<SettingsSection\s+title="Model providers"\s+description="Connect the providers you want the agent to be able to use\."/,
  );
  assert.match(
    runtimeProviderSettingsBlock,
    // Card chrome migrated from `shadow-md` to bordered (matches the
    // full-screen settings reference's quieter look).
    /<div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card px-6 py-8 text-center">/,
  );
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
    /const normalizedBaseUrl = firstNonEmptyString\(\s*providerDraft\.baseUrl,\s*existingProviderPayload\.base_url as string \| undefined,\s*existingProviderPayload\.baseURL as string \| undefined,\s*existingProviderOptions\.base_url as string \| undefined,\s*existingProviderOptions\.baseURL as string \| undefined,\s*\);/,
  );
  assert.match(
    source,
    /const normalizedApiKey = firstNonEmptyString\(\s*providerDraft\.apiKey,\s*existingProviderPayload\.api_key as string \| undefined,\s*existingProviderPayload\.auth_token as string \| undefined,\s*existingProviderOptions\.api_key as string \| undefined,\s*existingProviderOptions\.apiKey as string \| undefined,\s*\);/,
  );
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
    /if \(\s*isKnownProviderId\(normalizedModelProviderId\) \|\|\s*normalizedModelProviderId === "holaboss_model_proxy"\s*\) \{\s*delete nextModels\[token\];\s*\}/,
  );
  assert.match(
    source,
    /async function handleSaveRuntimeSettings\(providerId\?: KnownProviderId\) \{/,
  );
  assert.match(
    source,
    /function providerDraftValidationError\(providerId: KnownProviderId\): string \{/,
  );
  assert.match(
    source,
    /requires an API key before it can be connected\./,
  );
  assert.match(
    source,
    /requires a base URL before it can be connected\./,
  );
  assert.match(
    source,
    /requires at least one model before it can be connected\./,
  );
  assert.match(
    source,
    /const draftsToSave = providerId\s*\?/,
  );
  assert.match(
    source,
    /await persistRuntimeProviderSettings\(\s*draftsToSave,\s*backgroundTasksToSave,\s*recallEmbeddingsToSave,\s*imageGenerationToSave,\s*\);/,
  );
  assert.match(source, /const recallEmbeddingsToSave = providerId\s*\?/);
  assert.match(source, /nextRuntime\.recall_embeddings = \{\s*provider: normalizedRecallEmbeddingsProviderId,\s*model: normalizedRecallEmbeddingsModel \|\| null,\s*\};/);
  assert.match(source, /delete nextRuntime\.recall_embeddings;/);
  assert.match(source, /delete nextRuntime\.recallEmbeddings;/);
});

test("auth panel disconnects connected providers immediately while keeping new direct providers staged until manual save", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(source, /const persistedProviderDrafts = deriveProviderDraftsFromDocument\(/);
  assert.match(source, /const providerConnected = \(providerId: KnownProviderId\) =>/);
  assert.match(source, /const providerDraftEnabled = \(providerId: KnownProviderId\) =>/);
  assert.match(source, /const hasPendingConnection = !isConnected && draftEnabled;/);
  assert.match(source, /const isDisconnecting = disconnectingProviderId === providerId;/);
  assert.match(source, /statusLabel = "Configuring";/);
  assert.match(source, /async function handleDisconnectRuntimeProvider\(providerId: KnownProviderId\) \{/);
  assert.match(source, /setDisconnectingProviderId\(providerId\);/);
  assert.match(source, /setDisconnectingProviderId\(null\);/);
  assert.match(source, /persistedBeforeDisconnect\.backgroundTasks/);
  assert.match(source, /persistedBeforeDisconnect\.imageGeneration/);
  assert.match(source, /KNOWN_PROVIDER_TEMPLATES\[providerId\]\.label} disconnected\./);
  assert.match(source, /onClick=\{\(\)\s*=>\s*void handleDisconnectRuntimeProvider\(providerId\)\s*\}/);
  assert.match(source, /Disconnecting…/);
  assert.match(source, /Disconnect/);
  assert.doesNotMatch(source, /Disconnect pending\. Save changes to apply\./);
  assert.doesNotMatch(source, /Undo/);
});

test("runtime auth panel keeps provider cards readable in dark themes", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(source, /function providerBrandIconMarkup/);
  assert.match(source, /import openaiLogoMarkup from "@\/assets\/providers\/openai\.svg\?raw"/);
  assert.match(source, /dangerouslySetInnerHTML=\{\{ __html: iconMarkup \}\}/);
  assert.match(source, /className=\{`block \$\{sizeClass\} text-foreground \[\&_svg\]:h-full \[\&_svg\]:w-full`\}/);
  assert.match(source, /rounded-full bg-background ring-2 ring-card/);
  assert.match(source, /text-sm font-medium text-foreground/);
  assert.match(source, /text-sm text-muted-foreground/);
  assert.doesNotMatch(source, /WebkitMaskImage/);
  assert.doesNotMatch(source, /text-text-main/);
});

test("auth settings controls use a neutral focus border instead of the theme ring color", async () => {
  const source = await readFile(INDEX_CSS_PATH, "utf8");
  const authSettingsFocusBlock =
    source.match(/\.auth-settings-control:focus,[\s\S]*?\n}\n/)?.[0] ?? "";

  assert.match(authSettingsFocusBlock, /\.auth-settings-control:focus,/);
  assert.match(authSettingsFocusBlock, /box-shadow: none;/);
  assert.match(authSettingsFocusBlock, /border-color: color-mix\(in oklch, var\(--border\) 72%, var\(--foreground\) 28%\);/);
  assert.doesNotMatch(authSettingsFocusBlock, /var\(--ring\)/);
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
  assert.match(source, /if \(providerId === "holaboss"\) \{\s*return managedCatalogModels;\s*\}/);
  assert.match(source, /if \(providerId === "holaboss"\) \{\s*return managedCatalogImageModels;\s*\}/);
  assert.match(source, /runtimeConfig\?\.defaultBackgroundModel/);
  assert.match(source, /runtimeConfig\?\.defaultEmbeddingModel/);
  assert.match(source, /runtimeConfig\?\.defaultImageModel/);
  assert.match(source, /markProviderSettingsDirty\(\);/);
  assert.match(source, /shouldAutoselectHolabossBackgroundDefault/);
  assert.match(source, /shouldAutoselectHolabossImageDefault/);
  assert.match(source, /hasHydratedProviderDrafts/);
  assert.match(source, /if \(providerId !== "holaboss" && normalizedModelIds.length === 0\)/);
  assert.match(source, /function runtimeProviderStorageId\(/);
  assert.match(source, /providerId === "holaboss" \? "holaboss_model_proxy" : providerId/);
  assert.match(
    source,
    /return \[\s*"openai\/",\s*"google\/",\s*"anthropic\/",\s*"holaboss\/",\s*"holaboss_model_proxy\/",\s*\]/,
  );
  assert.match(source, /function holabossSupportedModels\(/);
  assert.match(source, /runtimeCatalogModelSupportsCapability\(model, "chat"\)/);
  assert.match(
    source,
    /Catalog, base URL, and credentials come from your Holaboss runtime\s+binding\./,
  );
  assert.match(source, /Supported models/);
  assert.match(
    source,
    /No managed models are available yet\.\s+Refresh your runtime binding\s+to load the latest Holaboss catalog\./,
  );
  assert.match(source, /providerId === "holaboss_model_proxy"/);
  assert.match(source, /open=\{Boolean\(expandedProviderId\)\}/);
  assert.match(source, /renderProviderDrawerContent\(expandedProviderId\)/);
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
    /if \(showsSetupLoadingState\) \{\s*return \(\s*<section className="theme-shell w-full max-w-none overflow-hidden rounded-3xl border border-border text-sm text-foreground">\s*<div className="px-4 py-5">\s*\{setupLoadingPanel\}\s*<\/div>/,
  );
  assert.match(source, /className="flex items-start justify-between gap-3"/);
  assert.match(source, /className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-primary bg-primary\/10 text-lg font-semibold text-primary"/);
  assert.doesNotMatch(source, /rounded-\[28px\] border border-border\/35 bg-card\/95 px-5 py-5 shadow-sm/);
  assert.match(source, /Sign in with browser/);
  assert.match(source, /Refresh session/);
  assert.match(source, /Sign out/);
});

test("web search settings fall back to Exa when the managed Holaboss binding is unavailable", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(source, /function normalizeWebSearchProviderSelection\(/);
  assert.match(
    source,
    /providerId === "holaboss_search" &&\s*!runtimeConfigHasManagedWebSearchBinding\(runtimeConfig\)\s*\?\s*"exa"\s*:\s*providerId/,
  );
  assert.match(
    source,
    /const selectedProviderId = normalizeWebSearchProviderSelection\(/,
  );
  assert.match(
    source,
    /const managedWebSearchAvailable =\s*runtimeConfigHasManagedWebSearchBinding\(effectiveRuntimeConfig\)/,
  );
  assert.match(
    source,
    /disabled:\s*providerId === "holaboss_search" && !managedWebSearchAvailable/,
  );
  assert.match(
    source,
    /Holaboss Search is unavailable until you refresh your Holaboss runtime binding\./,
  );
});

test("direct Anthropic, OpenRouter, and Gemini defaults advertise current provider model ids", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");
  const providerTemplatesBlock =
    source.match(/const KNOWN_PROVIDER_TEMPLATES:[\s\S]*?function isKnownProviderId/)?.[0] ?? "";
  const openaiTemplate =
    providerTemplatesBlock.match(/openai_direct:\s*\{[\s\S]*?apiKeyPlaceholder: "sk-your-openai-key"[\s\S]*?\n\s*}/)?.[0] ?? "";
  const codexTemplate =
    providerTemplatesBlock.match(/openai_codex:\s*\{[\s\S]*?apiKeyPlaceholder: ""[\s\S]*?\n\s*}/)?.[0] ?? "";
  const anthropicTemplate =
    providerTemplatesBlock.match(/anthropic_direct:\s*\{[\s\S]*?apiKeyPlaceholder: "sk-ant-your-anthropic-key"[\s\S]*?\n\s*}/)?.[0] ?? "";
  const openrouterTemplate =
    providerTemplatesBlock.match(/openrouter_direct:\s*\{[\s\S]*?apiKeyPlaceholder: "sk-or-your-openrouter-key"[\s\S]*?\n\s*}/)?.[0] ?? "";
  const geminiTemplate =
    providerTemplatesBlock.match(/gemini_direct:\s*\{[\s\S]*?apiKeyPlaceholder: "AIza\.\.\.your-gemini-api-key"[\s\S]*?\n\s*}/)?.[0] ?? "";

  assert.match(
    openaiTemplate,
    /defaultModels: \["gpt-5\.4", "gpt-5\.3-codex"\]/,
  );
  assert.match(openaiTemplate, /defaultBackgroundModel: "gpt-5\.4"/);
  assert.match(openaiTemplate, /defaultImageModel: "gpt-image-1\.5"/);
  assert.match(
    openaiTemplate,
    /imageModelSuggestions:\s*\[\s*"gpt-image-1\.5",\s*"gpt-image-1",\s*"gpt-image-1-mini",\s*"chatgpt-image-latest",\s*\]/,
  );
  assert.doesNotMatch(openaiTemplate, /gpt-5\.4-mini/);

  assert.match(codexTemplate, /label: "OpenAI Codex"/);
  assert.match(codexTemplate, /defaultBaseUrl: "https:\/\/chatgpt\.com\/backend-api\/codex"/);
  assert.match(codexTemplate, /defaultModels: \["gpt-5\.4", "gpt-5\.5", "gpt-5\.3-codex"\]/);
  assert.match(codexTemplate, /defaultBackgroundModel: "gpt-5\.4"/);
  assert.match(codexTemplate, /defaultImageModel: null/);
  assert.match(source, /handleConnectCodexProvider\(providerId: KnownProviderId\)/);
  assert.match(source, /window\.electronAPI\.runtime\.connectCodexOAuth\(\)/);
  assert.match(source, /apiKey: providerId === "openai_codex" \? "" : apiKey/);
  assert.match(source, /providerId === "openai_codex"/);

  assert.match(
    anthropicTemplate,
    /defaultModels:\s*\[\s*"claude-sonnet-4-6",\s*"claude-opus-4-6",\s*"claude-haiku-4-5",\s*\]/,
  );
  assert.match(anthropicTemplate, /defaultBaseUrl: "https:\/\/api\.anthropic\.com"/);
  assert.doesNotMatch(anthropicTemplate, /defaultBaseUrl: "https:\/\/api\.anthropic\.com\/v1"/);
  assert.doesNotMatch(anthropicTemplate, /claude-sonnet-4-5/);

  assert.match(
    openrouterTemplate,
    /defaultModels:\s*\[\s*"openai\/gpt-5\.4",\s*"anthropic\/claude-sonnet-4-6",\s*"qwen\/qwen3\.6-plus",\s*\]/,
  );
  assert.match(openrouterTemplate, /defaultBackgroundModel: "openai\/gpt-5\.4"/);
  assert.match(openrouterTemplate, /defaultImageModel: "google\/gemini-3\.1-flash-image-preview"/);
  assert.match(
    openrouterTemplate,
    /imageModelSuggestions:\s*\[\s*"google\/gemini-3\.1-flash-image-preview"\s*\]/,
  );
  assert.doesNotMatch(openrouterTemplate, /claude-sonnet-4-5/);
  assert.doesNotMatch(openrouterTemplate, /gpt-5\.4-mini/);

  assert.match(
    geminiTemplate,
    /defaultModels: \["gemini-2\.5-pro", "gemini-2\.5-flash"\]/,
  );
  assert.match(geminiTemplate, /defaultImageModel: "gemini-3\.1-flash-image-preview"/);
  assert.match(
    geminiTemplate,
    /imageModelSuggestions:\s*\[\s*"gemini-3\.1-flash-image-preview",\s*"gemini-2\.5-flash-image",\s*\]/,
  );
  assert.match(source, /managedCatalogImageModels.length === 0 && template.defaultImageModel/);
  assert.match(source, /backgroundTaskDefaultModel\(providerId, runtimeConfig\)/);
  assert.match(source, /imageGenerationDefaultModel\(providerId, runtimeConfig\)/);
  assert.doesNotMatch(geminiTemplate, /gemini-3\.1-pro-preview/);
  assert.doesNotMatch(geminiTemplate, /gemini-2\.5-flash-lite/);
  assert.doesNotMatch(geminiTemplate, /gemini-3\.1-flash-lite-preview/);
});
