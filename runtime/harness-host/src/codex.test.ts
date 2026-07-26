import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  codexAgentMessageDeltaChunk,
  codexMcpToolTraceFields,
  codexModelListToSupportedModels,
  codexReasoningText,
  codexToolTraceFields,
  isForeignCodexThreadNotification,
  prepareCodexHome,
} from "./codex.js";
import type { HarnessHostCodexRequest } from "./contracts.js";

// prepareCodexHome only reads mcp_servers + workspace_skill_dirs; the rest
// of the wire payload is irrelevant to it, so a partial cast keeps the
// tests focused.
function codexRequest(
  overrides: Partial<HarnessHostCodexRequest>,
): HarnessHostCodexRequest {
  return {
    mcp_servers: [],
    workspace_skill_dirs: [],
    ...overrides,
  } as unknown as HarnessHostCodexRequest;
}

// Point CODEX_HOME at a throwaway shared home so seedCodexAuthAndSessions
// never touches the real ~/.codex on the machine running the tests.
function withSharedCodexHome<T>(fn: (shared: string) => T): T {
  const shared = mkdtempSync(join(tmpdir(), "codex-shared-"));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = shared;
  try {
    return fn(shared);
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = prev;
    }
    rmSync(shared, { recursive: true, force: true });
  }
}

test("prepareCodexHome returns null with no servers and no skills", () => {
  withSharedCodexHome(() => {
    assert.equal(prepareCodexHome(codexRequest({})), null);
  });
});

test("prepareCodexHome writes config.toml with remote + local mcp tables", () => {
  withSharedCodexHome(() => {
    const prep = prepareCodexHome(
      codexRequest({
        mcp_servers: [
          {
            name: "runtime",
            config: { type: "remote", url: "https://x/mcp", headers: { "x-h": "1" } },
          },
          {
            name: "notion",
            config: { type: "local", command: ["npx", "pkg"], environment: { TOKEN: "t" } },
          },
        ],
      }),
    );
    assert.ok(prep);
    const toml = readFileSync(join(prep.codexHome, "config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers\.runtime\]/);
    assert.match(toml, /url = "https:\/\/x\/mcp"/);
    // Remote headers ride an inline `http_headers` map — codex ignores a
    // `[mcp_servers.NAME.headers]` sub-table, which would drop auth.
    assert.match(toml, /http_headers = \{ x-h = "1" \}/);
    assert.doesNotMatch(toml, /\[mcp_servers\.runtime\.headers\]/);
    // A url-based server requires the experimental rmcp client.
    assert.match(toml, /^features\.experimental_use_rmcp_client = true$/m);
    assert.match(toml, /\[mcp_servers\.notion\]/);
    assert.match(toml, /command = "npx"/);
    prep.cleanup();
    assert.equal(existsSync(prep.codexHome), false);
  });
});

test("codexToolTraceFields surfaces the command, output, and exit code", () => {
  const item = {
    type: "commandExecution",
    id: "call_1",
    command: "/bin/zsh -lc 'python3 -c \"print(1)\"'",
    commandActions: [{ type: "unknown", command: 'python3 -c "print(1)"' }],
    aggregatedOutput: "1\n",
    exitCode: 0,
    status: "completed",
  };
  // In-progress: clean title + the parsed inner command, no result yet.
  const started = codexToolTraceFields("commandExecution", item, false);
  assert.equal(started.tool_name, "shell");
  assert.deepEqual(started.tool_args, { command: 'python3 -c "print(1)"' });
  assert.equal(started.result, undefined);
  // Completed: result carries output + exit code, error stays false on exit 0.
  const done = codexToolTraceFields("commandExecution", item, true);
  assert.deepEqual(done.result, { exit_code: 0, output: "1\n" });
  assert.equal(done.error, false);
  // Non-zero exit flags the step as an error.
  const failed = codexToolTraceFields(
    "commandExecution",
    { ...item, exitCode: 2, status: "completed" },
    true,
  );
  assert.equal(failed.error, true);
});

test("codexAgentMessageDeltaChunk streams mid-message tokens verbatim, separates new items", () => {
  // First delta of the first item, no prior output → no separator.
  assert.equal(codexAgentMessageDeltaChunk("Hello", "", true), "Hello");
  // Mid-message tokens concatenate verbatim (not the first delta).
  assert.equal(codexAgentMessageDeltaChunk(" there", "Hello", false), " there");
  // First delta of a NEW item, prior output not newline-terminated → blank line.
  assert.equal(
    codexAgentMessageDeltaChunk("Next", "Hello there", true),
    "\n\nNext",
  );
  // First delta of a new item but prior output already ends in newline → none.
  assert.equal(codexAgentMessageDeltaChunk("Next", "Hello\n", true), "Next");
});

test("isForeignCodexThreadNotification drops other threads, keeps ours + unknowns", () => {
  // Different thread → foreign (subagent / memory-consolidation leak).
  assert.equal(
    isForeignCodexThreadNotification("thr_main", { threadId: "thr_sub" }),
    true,
  );
  // Our thread → keep.
  assert.equal(
    isForeignCodexThreadNotification("thr_main", { threadId: "thr_main" }),
    false,
  );
  // No threadId on the notification → keep (nothing to compare).
  assert.equal(isForeignCodexThreadNotification("thr_main", {}), false);
  // Our thread id not yet known → keep everything.
  assert.equal(
    isForeignCodexThreadNotification(null, { threadId: "thr_sub" }),
    false,
  );
});

test("codexReasoningText reads text, summary[], or content", () => {
  assert.equal(codexReasoningText({ type: "reasoning", text: "  thinking  " }), "thinking");
  assert.equal(
    codexReasoningText({
      type: "reasoning",
      summary: ["part one", { text: "part two" }, ""],
    }),
    "part one\n\npart two",
  );
  assert.equal(codexReasoningText({ type: "reasoning", content: "legacy" }), "legacy");
  assert.equal(codexReasoningText({ type: "reasoning" }), "");
});

test("codexMcpToolTraceFields maps mcpToolCall to a tool_call with the bare tool name", () => {
  const started = codexMcpToolTraceFields(
    "mcpToolCall",
    {
      type: "mcpToolCall",
      id: "call_9",
      server: "holaboss_runtime_tools",
      tool: "holaboss_workspace_integrations_propose_connect",
      arguments: { toolkit_slug: "gmail" },
    },
    false,
  );
  // Bare tool name (not server.tool) so the propose_connect card/gate still match.
  assert.equal(started.tool_name, "holaboss_workspace_integrations_propose_connect");
  assert.deepEqual(started.tool_args, { toolkit_slug: "gmail" });
  assert.equal(started.result, undefined);

  const failed = codexMcpToolTraceFields(
    "mcpToolCall",
    { type: "mcpToolCall", tool: "x", status: "failed", result: { note: "boom" } },
    true,
  );
  assert.equal(failed.error, true);
  assert.deepEqual(failed.result, { note: "boom" });
});

test("codexMcpToolTraceFields maps webSearch to a web_search tool_call", () => {
  const fields = codexMcpToolTraceFields(
    "webSearch",
    { type: "webSearch", query: "latest email" },
    true,
  );
  assert.equal(fields.tool_name, "web_search");
  assert.deepEqual(fields.tool_args, { query: "latest email" });
});

test("prepareCodexHome enables rmcp only when a remote server is present", () => {
  withSharedCodexHome(() => {
    // stdio-only: no remote server, so the experimental client stays off.
    const localOnly = prepareCodexHome(
      codexRequest({
        mcp_servers: [
          { name: "notion", config: { type: "local", command: ["npx", "pkg"] } },
        ],
      }),
    );
    assert.ok(localOnly);
    const localToml = readFileSync(
      join(localOnly.codexHome, "config.toml"),
      "utf8",
    );
    assert.doesNotMatch(localToml, /experimental_use_rmcp_client/);
    localOnly.cleanup();
  });
});

test("prepareCodexHome copies SKILL.md skills, skips dirs without one, and symlinks sessions", () => {
  withSharedCodexHome(() => {
    const good = mkdtempSync(join(tmpdir(), "codexskill-good-"));
    const bad = mkdtempSync(join(tmpdir(), "codexskill-bad-"));
    writeFileSync(join(good, "SKILL.md"), "# good skill");
    try {
      const prep = prepareCodexHome(
        codexRequest({ workspace_skill_dirs: [good, bad] }),
      );
      assert.ok(prep);
      assert.ok(
        existsSync(join(prep.codexHome, "skills", basename(good), "SKILL.md")),
      );
      assert.equal(
        existsSync(join(prep.codexHome, "skills", basename(bad))),
        false,
      );
      assert.ok(lstatSync(join(prep.codexHome, "sessions")).isSymbolicLink());
      prep.cleanup();
      assert.equal(existsSync(prep.codexHome), false);
    } finally {
      rmSync(good, { recursive: true, force: true });
      rmSync(bad, { recursive: true, force: true });
    }
  });
});

test("prepareCodexHome symlinks auth.json from the shared home when present", () => {
  withSharedCodexHome((shared) => {
    writeFileSync(join(shared, "auth.json"), '{"token":"x"}');
    const prep = prepareCodexHome(
      codexRequest({
        mcp_servers: [{ name: "runtime", config: { type: "remote", url: "https://x/mcp" } }],
      }),
    );
    assert.ok(prep);
    assert.ok(lstatSync(join(prep.codexHome, "auth.json")).isSymbolicLink());
    assert.equal(readFileSync(join(prep.codexHome, "auth.json"), "utf8"), '{"token":"x"}');
    prep.cleanup();
  });
});

test("prepareCodexHome disables native multi-agent + auto-memory before the mcp tables", () => {
  withSharedCodexHome(() => {
    const prep = prepareCodexHome(
      codexRequest({
        mcp_servers: [{ name: "runtime", config: { type: "remote", url: "https://x/mcp" } }],
      }),
    );
    assert.ok(prep);
    const toml = readFileSync(join(prep.codexHome, "config.toml"), "utf8");
    assert.match(toml, /^features\.multi_agent = false$/m);
    assert.match(toml, /^features\.memories = false$/m);
    assert.match(toml, /^memories\.generate_memories = false$/m);
    assert.match(toml, /^memories\.use_memories = false$/m);
    // Root dotted keys must sit above the first table header to be valid TOML.
    assert.ok(toml.indexOf("features.multi_agent") < toml.indexOf("[mcp_servers"));
    prep.cleanup();
  });
});

test("HOLABOSS_CODEX_MULTI_AGENT / HOLABOSS_CODEX_MEMORY opt back into the native features", () => {
  const prevMa = process.env.HOLABOSS_CODEX_MULTI_AGENT;
  const prevMem = process.env.HOLABOSS_CODEX_MEMORY;
  process.env.HOLABOSS_CODEX_MULTI_AGENT = "1";
  process.env.HOLABOSS_CODEX_MEMORY = "true";
  try {
    withSharedCodexHome(() => {
      const prep = prepareCodexHome(
        codexRequest({
          mcp_servers: [{ name: "runtime", config: { type: "remote", url: "https://x/mcp" } }],
        }),
      );
      assert.ok(prep);
      const toml = readFileSync(join(prep.codexHome, "config.toml"), "utf8");
      assert.doesNotMatch(toml, /multi_agent/);
      assert.doesNotMatch(toml, /memories/);
      // The mcp table is still written.
      assert.match(toml, /\[mcp_servers\.runtime\]/);
      prep.cleanup();
    });
  } finally {
    restoreEnv("HOLABOSS_CODEX_MULTI_AGENT", prevMa);
    restoreEnv("HOLABOSS_CODEX_MEMORY", prevMem);
  }
});

test("a skills-only managed home still writes config.toml with the disable keys", () => {
  withSharedCodexHome(() => {
    const good = mkdtempSync(join(tmpdir(), "codexskill-only-"));
    writeFileSync(join(good, "SKILL.md"), "# good skill");
    try {
      const prep = prepareCodexHome(codexRequest({ workspace_skill_dirs: [good] }));
      assert.ok(prep);
      const toml = readFileSync(join(prep.codexHome, "config.toml"), "utf8");
      assert.match(toml, /^features\.multi_agent = false$/m);
      assert.doesNotMatch(toml, /\[mcp_servers/);
      prep.cleanup();
    } finally {
      rmSync(good, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prev;
  }
}

test("codexModelListToSupportedModels maps model/list data, flags the default, and drops junk", () => {
  const models = codexModelListToSupportedModels([
    { id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true },
    { id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", isDefault: false },
    { id: "hidden", displayName: "Hidden", hidden: true }, // codex-internal → dropped
    { model: "fallback-id", displayName: "" }, // no id → use `model`; blank label → use id
    { default: true }, // no id/model → dropped entirely
    "not-an-object", // non-record → dropped
  ]);
  assert.deepEqual(models, [
    { id: "gpt-5.5", label: "GPT-5.5", provider: "openai", default: true },
    { id: "gpt-5.4-mini", label: "GPT-5.4-Mini", provider: "openai" },
    { id: "fallback-id", label: "fallback-id", provider: "openai" },
  ]);
});

test("codexModelListToSupportedModels returns [] for non-array input", () => {
  assert.deepEqual(codexModelListToSupportedModels(null), []);
  assert.deepEqual(codexModelListToSupportedModels(undefined), []);
  assert.deepEqual(codexModelListToSupportedModels({ data: [] }), []);
});
