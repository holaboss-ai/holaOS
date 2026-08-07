import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "ManualAutomationDialog.tsx");

test("manual create dialog exposes a model picker fed by the composer catalog", async () => {
  const source = await readFile(sourcePath, "utf8");

  // The create draft carries a pinned model (null => workspace default).
  assert.match(source, /model: string \| null/);
  // Fed by the same catalog the chat composer offers.
  assert.match(source, /useChatComposerModelSelection\(\)/);
  assert.match(source, /MODEL_WORKSPACE_DEFAULT/);
  // Surfaced as its own field, with a stale-model fallback entry.
  assert.match(source, /<Field label="Model">/);
  assert.match(source, /modelNotInCatalog/);
  // The chosen model flows into the create draft handed to onCreate.
  assert.match(source, /projectId,\s*model,/);
});

test("create dialog exposes a reasoning-effort picker scoped to the model", async () => {
  const source = await readFile(sourcePath, "utf8");

  // The create draft carries a pinned reasoning effort (null => model default).
  assert.match(source, /thinkingValue: string \| null/);
  // Effort levels come from the model-scoped helper, gated on the model
  // actually offering any (non-reasoning models hide the field).
  assert.match(source, /automationThinkingChoiceForModel\(/);
  assert.match(source, /thinkingChoice\.thinkingValues\.length > 0/);
  assert.match(source, /<Field label="Thinking">/);
  // The chosen effort flows into the create draft handed to onCreate.
  assert.match(source, /model,\s*thinkingValue,/);
});

test("create dialog offers a catalogue resync next to the model picker", async () => {
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /ModelCatalogRefreshButton/);
});

test("create dialog scopes the model list to the selected agent", async () => {
  const source = await readFile(sourcePath, "utf8");

  // Model options come from the agent-scoped helper, not the raw chat catalog.
  assert.match(source, /automationModelChoiceForHarness\(/);
  assert.match(source, /\.\.\.modelChoice\.options/);
  // Changing the agent re-scopes + reconciles the pinned model.
  assert.match(source, /const handleHarnessChange = /);
  assert.match(source, /reconcileAutomationModel\(/);
  assert.match(source, /onChange=\{handleHarnessChange\}/);
});
