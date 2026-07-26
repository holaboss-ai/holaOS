import assert from "node:assert/strict";
import test from "node:test";

import { mcpToolNameAliasesNeededForModel } from "./pi.js";

// Models that call tools by the EXACT registered name (Claude, GPT/OpenAI,
// Gemini) must NOT get the `mcp__<server>__<tool>` name aliases — those double a
// kebab-named MCP server's tool count in the list the model sees (e.g. AdsPower).
test("exact-name models do not need MCP tool-name aliases", () => {
  for (const model of [
    "claude-opus-4-8",
    "anthropic/claude-sonnet-5",
    "Claude Sonnet 5",
    "gpt-5.4",
    "openai/gpt-5.4",
    "google/gemini-2.5-pro",
    "gemini-2.5-flash",
  ]) {
    assert.equal(
      mcpToolNameAliasesNeededForModel(model),
      false,
      `${model} should skip aliases`,
    );
  }
});

// GLM-family and anything we don't recognize keep the aliases as a safety net —
// GLM guesses the SDK namespacing + original (kebab) tool spelling.
test("GLM and unrecognized models keep MCP tool-name aliases", () => {
  for (const model of [
    "z-ai/glm-4.6",
    "thudm/glm-4",
    "GLM-4.5-Air",
    "some-unknown-model",
    "",
  ]) {
    assert.equal(
      mcpToolNameAliasesNeededForModel(model),
      true,
      `${model} should keep aliases`,
    );
  }
});
