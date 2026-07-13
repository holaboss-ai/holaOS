import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

test("desktop MiniMax defaults preserve current models, parameters, and endpoints", async () => {
  const [mainSource, authPanelSource, sharedCatalogSource, modelRoutingSource, docsSource] =
    await Promise.all([
      readFile(path.join(__dirname, "main.ts"), "utf8"),
      readFile(path.join(__dirname, "..", "src", "components", "auth", "AuthPanel.tsx"), "utf8"),
      readFile(path.join(__dirname, "..", "shared", "model-catalog.ts"), "utf8"),
      readFile(path.join(repoRoot, "runtime", "harnesses", "src", "model-routing.ts"), "utf8"),
      readFile(
        path.join(
          repoRoot,
          "website",
          "docs",
          "content",
          "docs",
          "contribute",
          "desktop",
          "model-configuration.mdx",
        ),
        "utf8",
      ),
    ]);

  assert.match(mainSource, /minimax_direct:\s*"https:\/\/api\.minimax\.io\/v1"/);
  assert.match(mainSource, /providerId === "minimax_direct"[\s\S]*url = `\$\{baseUrl\}\/models`/);
  assert.match(authPanelSource, /defaultModels: \["MiniMax-M3", "MiniMax-M2\.7"\]/);
  assert.match(authPanelSource, /defaultBackgroundModel: "MiniMax-M3"/);
  assert.match(
    sharedCatalogSource,
    /model_id: "MiniMax-M3"[\s\S]*input_modalities: \["text", "image", "video"\][\s\S]*context_window: 1_000_000/,
  );
  assert.match(
    sharedCatalogSource,
    /pricing_tiers_usd_per_million_tokens:[\s\S]*service_tier: "standard"[\s\S]*input_tokens_lte: 512_000[\s\S]*service_tier: "priority"[\s\S]*input_tokens_gt: 512_000/,
  );
  assert.match(
    sharedCatalogSource,
    /model_id: "MiniMax-M2\.7"[\s\S]*thinking_values: \[\.\.\.MINIMAX_M27_THINKING_VALUES\][\s\S]*context_window: 204_800/,
  );
  assert.match(modelRoutingSource, /case "minimax-m3":[\s\S]*contextWindow: 1_000_000/);
  assert.match(modelRoutingSource, /case "minimax-m2\.7":[\s\S]*contextWindow: 204_800/);
  assert.match(docsSource, /https:\/\/api\.minimax\.io\/anthropic/);
  assert.match(docsSource, /https:\/\/api\.minimax\.io\/v1/);
  assert.match(docsSource, /https:\/\/api\.minimaxi\.com\/anthropic/);
  assert.match(docsSource, /https:\/\/api\.minimaxi\.com\/v1/);
});
