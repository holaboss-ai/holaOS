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

test("auth panel derives runtime readiness from the shared desktop runtime state", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  assert.match(source, /import \{ useWorkspaceDesktop \} from "@\/lib\/workspaceDesktop";/);
  assert.match(source, /const \{ runtimeConfig: sharedRuntimeConfig \} = useWorkspaceDesktop\(\);/);
  assert.match(source, /const effectiveRuntimeConfig = sharedRuntimeConfig \?\? runtimeConfig;/);
  assert.match(
    source,
    /const \[hasLoadedRuntimeConfigDocument, setHasLoadedRuntimeConfigDocument\]\s*=\s*useState\(false\);/,
  );
  assert.match(source, /Boolean\(effectiveRuntimeConfig\?\.authTokenPresent\)/);
  assert.match(source, /setHasLoadedRuntimeConfigDocument\(true\);/);
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

test("account view uses an inline profile header and theme-colored sign-in action", async () => {
  const source = await readFile(AUTH_PANEL_PATH, "utf8");

  // Setup takes over the whole panel until the runtime is bound; the
  // account header only renders once it isn't needed.
  assert.match(
    source,
    /if \(showsSetupPanel\) \{\s*return \(\s*<section[\s\S]*?\{setupPanel\}/,
  );
  // Inline profile header: avatar, display name, email underneath.
  assert.match(source, /<UserAvatar user=\{sessionAvatarUser\(session\)\} \/>/);
  assert.match(source, /sessionDisplayName\(session\) \|\|/);
  assert.match(source, /\{sessionEmail\(session\)\}/);
  assert.match(source, /Sign in/);
  assert.match(source, /Refresh session/);
  assert.match(source, /Sign out/);
});

