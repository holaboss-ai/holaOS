import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const BILLING_SETTINGS_PANEL_PATH = new URL("./BillingSettingsPanel.tsx", import.meta.url);

test("billing settings panel renders a standalone billing page", async () => {
  const source = await readFile(BILLING_SETTINGS_PANEL_PATH, "utf8");

  assert.match(source, /BillingSummaryCard/);
  assert.match(source, /useDesktopBilling/);
  assert.match(source, /void refresh\(\);/);
  assert.match(source, /aria-label=\{isLoading \? "Refreshing usage" : "Refresh usage"\}/);
  assert.match(source, /\{isLoading \? "Refreshing\.\.\." : "Refresh"\}/);
  assert.match(source, /Usage record/);
  assert.match(source, /Reactivate/);
  assert.doesNotMatch(source, /Hosted credits and managed usage for this desktop account\./);
  assert.doesNotMatch(source, /Website usage & billing/);
  assert.doesNotMatch(source, /Billing overview/);
  assert.doesNotMatch(source, /Holaboss credits apply to managed desktop usage only\./);
});
