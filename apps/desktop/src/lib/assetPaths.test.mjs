import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetPathsPath = path.join(__dirname, "assetPaths.ts");
const topTabsBarPath = path.join(__dirname, "..", "components", "layout", "TopTabsBar.tsx");
const authPanelPath = path.join(__dirname, "..", "components", "auth", "AuthPanel.tsx");
const marketplaceGalleryPath = path.join(__dirname, "..", "components", "marketplace", "MarketplaceGallery.tsx");

test("holaboss logo URL respects the Vite base URL", async () => {
  const source = await readFile(assetPathsPath, "utf8");

  assert.match(source, /export const holabossLogoUrl = `\$\{import\.meta\.env\.BASE_URL\}logo\.svg`;/);
});

test("packaged renderer logo usage goes through the shared asset URL", async () => {
  const [topTabsBarSource, authPanelSource, marketplaceGallerySource] = await Promise.all([
    readFile(topTabsBarPath, "utf8"),
    readFile(authPanelPath, "utf8"),
    readFile(marketplaceGalleryPath, "utf8")
  ]);

  for (const source of [topTabsBarSource, authPanelSource, marketplaceGallerySource]) {
    assert.match(source, /holabossLogoUrl/);
    assert.doesNotMatch(source, /["']\/logo\.svg["']/);
  }
});
