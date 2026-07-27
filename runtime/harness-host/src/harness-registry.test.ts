import assert from "node:assert/strict";
import test from "node:test";

import { listHarnessHostPlugins, requireHarnessHostPluginByCommand, resolveHarnessHostPluginByCommand } from "./harness-registry.js";

test("listHarnessHostPlugins exposes registered harness host plugins", () => {
  assert.deepEqual(
    listHarnessHostPlugins().map((plugin) => ({ id: plugin.id, command: plugin.command })),
    [
      { id: "pi", command: "run-pi" },
      { id: "claude-code", command: "run-claude-code" },
      { id: "codex", command: "run-codex" },
    ]
  );
});

test("resolveHarnessHostPluginByCommand matches commands case-insensitively", () => {
  assert.equal(resolveHarnessHostPluginByCommand(" RUN-PI ")?.id, "pi");
  assert.equal(resolveHarnessHostPluginByCommand("run-unknown"), null);
});

test("requireHarnessHostPluginByCommand falls back to pi for unregistered commands", () => {
  // A legacy invocation targeting a since-removed harness must run pi rather
  // than crash with `unsupported command`.
  assert.equal(requireHarnessHostPluginByCommand("run-unknown").id, "pi");
});
