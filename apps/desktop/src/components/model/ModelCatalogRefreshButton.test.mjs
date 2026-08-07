import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFile(path.join(__dirname, rel), "utf8");

test("the shared button drives the resync through the shared hook", async () => {
  const button = await read("ModelCatalogRefreshButton.tsx");
  // Delegates to the shared hook and shows a spinner while refreshing.
  assert.match(button, /useRefreshModelCatalog\(\)/);
  assert.match(button, /animate-spin/);
  // Stops the click from selecting/dismissing a host popover or select.
  assert.match(button, /stopPropagation\(\)/);
});

test("the hook re-pulls the catalogue and guards re-entrancy", async () => {
  const hook = await read("../../lib/useRefreshModelCatalog.ts");
  // Re-pulls via the main-process IPC (which broadcasts a fresh config).
  assert.match(hook, /window\.electronAPI\.runtime\.refreshModelCatalog\(\)/);
  // A single-flight guard so overlapping clicks coalesce.
  assert.match(hook, /inFlight/);
});

test("every named model selector wires in the shared resync button", async () => {
  const selectors = [
    "../panes/ChatPane/Composer/ModelCombobox.tsx", // composer
    "../harness/ChannelModelPicker.tsx", // channels
  ];
  for (const rel of selectors) {
    const source = await read(rel);
    assert.match(
      source,
      /ModelCatalogRefreshButton/,
      `${rel} should render the shared resync button`,
    );
  }
});
