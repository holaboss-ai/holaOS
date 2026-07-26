import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compileWorkspaceRuntimePlanFromWorkspace,
  encodeWorkspaceMcpCatalog,
  effectiveMcpServerPayloads,
  mergePreparedMcpServerPayloads,
  mcpServerPayloads,
  mcpServersUnavailableForMissingEnv,
  mcpServerMappingMetadata,
  mcpServerIdMap,
  readWorkspaceRuntimePlanReferences,
  workspaceMcpCatalogFingerprint,
  workspaceMcpPhysicalServerId,
} from "./runner-prep.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("compileWorkspaceRuntimePlanFromWorkspace reads referenced prompt files from disk", () => {
  const root = makeTempDir("hb-runner-prep-");
  fs.writeFileSync(
    path.join(root, "workspace.yaml"),
    [
      "template_id: demo",
      "name: Demo",
      "agents:",
      "  id: main",
      "  model: gpt-5",
      "mcp_registry:",
      "  allowlist:",
      "    tool_ids: []",
      "  servers: {}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "AGENTS.md"), "You are concise.\n", "utf8");

  assert.deepEqual(readWorkspaceRuntimePlanReferences(root), {
    "AGENTS.md": "You are concise.\n",
  });

  const plan = compileWorkspaceRuntimePlanFromWorkspace({
    workspaceId: "workspace-1",
    workspaceDir: root,
  });
  assert.equal(plan.workspace_id, "workspace-1");
  assert.equal(plan.general_config.type, "single");
  assert.equal(plan.resolved_prompts.main.trim(), "You are concise.");
});

test("mcpServerIdMap assigns a stable physical workspace server id", () => {
  const compiledPlan = {
    resolved_mcp_servers: [{ server_id: "workspace" }, { server_id: "twitter" }],
    workspace_mcp_catalog: [{ tool_id: "workspace.lookup", module_path: "tools/a.py", symbol_name: "lookup" }],
  } as never;

  const mapping = mcpServerIdMap({
    workspaceId: "workspace-1",
    sandboxId: "sandbox-1",
    compiledPlan,
  });
  assert.equal(mapping.twitter, "twitter");
  assert.equal(mapping.workspace, workspaceMcpPhysicalServerId({ workspaceId: "workspace-1", sandboxId: "sandbox-1" }));
});

test("workspaceMcpCatalogFingerprint is stable for equivalent plans", () => {
  const planA = {
    workspace_mcp_catalog: [{ tool_id: "workspace.lookup", module_path: "tools/a.py", symbol_name: "lookup" }],
    resolved_mcp_servers: [{ server_id: "workspace", timeout_ms: 5000 }],
  } as never;
  const planB = {
    workspace_mcp_catalog: [{ tool_id: "workspace.lookup", module_path: "tools/a.py", symbol_name: "lookup" }],
    resolved_mcp_servers: [{ server_id: "workspace", timeout_ms: 5000 }],
  } as never;

  assert.equal(workspaceMcpCatalogFingerprint(planA), workspaceMcpCatalogFingerprint(planB));
});

test("encodeWorkspaceMcpCatalog preserves the workspace MCP catalog shape", () => {
  const compiledPlan = {
    workspace_mcp_catalog: [
      {
        tool_id: "workspace.lookup",
        tool_name: "lookup",
        module_path: "tools/a.py",
        symbol_name: "lookup_tool"
      }
    ]
  } as never;

  assert.deepEqual(
    JSON.parse(Buffer.from(encodeWorkspaceMcpCatalog(compiledPlan), "base64").toString("utf8")),
    [
      {
        tool_id: "workspace.lookup",
        tool_name: "lookup",
        module_path: "tools/a.py",
        symbol_name: "lookup_tool"
      }
    ]
  );
});

test("mcpServerMappingMetadata reports only rewritten logical ids", () => {
  assert.deepEqual(
    mcpServerMappingMetadata({
      workspace: "workspace__abc",
      twitter: "twitter"
    }),
    [
      {
        logical_id: "workspace",
        physical_id: "workspace__abc"
      }
    ]
  );
});

test("effectiveMcpServerPayloads replaces logical workspace server with sidecar payload", () => {
  const compiledPlan = {
    resolved_mcp_servers: [
      {
        server_id: "workspace",
        type: "remote",
        command: [],
        url: "http://old/mcp",
        headers: [],
        environment: [],
        timeout_ms: 9000,
      },
    ],
    workspace_mcp_catalog: [],
  } as never;

  const payloads = effectiveMcpServerPayloads({
    compiledPlan,
    sidecar: {
      physical_server_id: "workspace__abc",
      url: "http://127.0.0.1:9911/mcp",
      timeout_ms: 7000,
      reused: false,
    },
    serverIdMap: { workspace: "workspace__abc" },
  });

  assert.deepEqual(payloads, [
    {
      name: "workspace__abc",
      config: {
        type: "remote",
        enabled: true,
        url: "http://127.0.0.1:9911/mcp",
        headers: {},
        timeout: 7000,
      },
      _holaboss_force_refresh: true,
    },
  ]);
});

test("mcpServerPayloads skips a placeholder-shaped invalid secret instead of throwing; it is reported unavailable", () => {
  const compiledPlan = {
    resolved_mcp_servers: [
      {
        server_id: "context7",
        type: "remote",
        command: [],
        url: "https://mcp.context7.com/mcp",
        headers: [["CONTEXT7_API_KEY", "{env:ctx7sk-live-abc123}"]], // placeholder-shaped, invalid var name
        environment: [],
        timeout_ms: 15000,
      },
    ],
    resolved_mcp_tool_refs: [],
    workspace_mcp_catalog: [],
  } as never;

  // This used to throw and fail the entire run. Malformed placeholders are now
  // rejected at install (parseMcpServer); if one still reaches runtime (e.g. a
  // workspace.yaml server, which skips that validation) it degrades to a skipped
  // + surfaced server rather than aborting every run.
  assert.deepEqual(mcpServerPayloads(compiledPlan), []);
  const unavailable = mcpServersUnavailableForMissingEnv(compiledPlan);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].serverId, "context7");
  assert.match(unavailable[0].reason, /malformed placeholder/i);
});

test("mcpServerPayloads preserves literal MCP header secrets that are not env placeholders", () => {
  const compiledPlan = {
    resolved_mcp_servers: [
      {
        server_id: "context7",
        type: "remote",
        command: [],
        url: "https://mcp.context7.com/mcp",
        headers: [["CONTEXT7_API_KEY", "ctx7sk-live-abc123"]],
        environment: [],
        timeout_ms: 15000,
      },
    ],
    workspace_mcp_catalog: [],
  } as never;

  assert.deepEqual(mcpServerPayloads(compiledPlan), [
    {
      name: "context7",
      config: {
        type: "remote",
        enabled: true,
        url: "https://mcp.context7.com/mcp",
        headers: { CONTEXT7_API_KEY: "ctx7sk-live-abc123" },
        timeout: 15000,
      },
    },
  ]);
});

test("mcpServerPayloads skips a server whose required env var is unset (no whole-run abort)", () => {
  const compiledPlan = {
    resolved_mcp_servers: [
      {
        server_id: "need-review",
        type: "remote",
        command: [],
        url: "https://example.com/mcp",
        headers: [["Authorization", "{env:HOLABOSS_DEFINITELY_UNSET_VAR_XYZ}"]],
        environment: [],
        timeout_ms: 15000,
      },
      {
        server_id: "context7",
        type: "remote",
        command: [],
        url: "https://mcp.context7.com/mcp",
        headers: [["CONTEXT7_API_KEY", "literal-secret"]],
        environment: [],
        timeout_ms: 15000,
      },
    ],
    workspace_mcp_catalog: [],
  } as never;

  // The unconfigured server is dropped; the well-configured one survives.
  assert.deepEqual(
    mcpServerPayloads(compiledPlan).map((payload) => payload.name),
    ["context7"],
  );
});

test("mcpServersUnavailableForMissingEnv reports the env-skipped server with reason + its tool ids", () => {
  const compiledPlan = {
    resolved_mcp_servers: [
      {
        server_id: "x-poster__x",
        type: "remote",
        command: [],
        url: "https://mcp.example/sse",
        headers: [["Authorization", "{env:HOLABOSS_DEFINITELY_UNSET_VAR_XYZ}"]],
        environment: [],
        timeout_ms: 15000,
      },
      {
        server_id: "context7",
        type: "remote",
        command: [],
        url: "https://mcp.context7.com/mcp",
        headers: [["CONTEXT7_API_KEY", "literal-secret"]],
        environment: [],
        timeout_ms: 15000,
      },
    ],
    resolved_mcp_tool_refs: [
      { tool_id: "x-poster__x.publish", server_id: "x-poster__x", tool_name: "publish" },
      { tool_id: "x-poster__x.list", server_id: "x-poster__x", tool_name: "list" },
      { tool_id: "context7.search", server_id: "context7", tool_name: "search" },
    ],
    workspace_mcp_catalog: [],
  } as never;

  const unavailable = mcpServersUnavailableForMissingEnv(compiledPlan);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].serverId, "x-poster__x");
  assert.match(unavailable[0].reason, /HOLABOSS_DEFINITELY_UNSET_VAR_XYZ/);
  // every tool the skipped server would have contributed is reported as missing
  assert.deepEqual(unavailable[0].missingToolIds, ["x-poster__x.publish", "x-poster__x.list"]);
});

test("mcpServerPayloads: a malformed {env:...} placeholder skips the server instead of throwing", () => {
  const compiledPlan = {
    resolved_mcp_servers: [
      {
        server_id: "cap__x",
        type: "remote",
        command: [],
        url: "https://mcp.example/sse",
        headers: [["Authorization", "{env:MY-TOKEN}"]], // hyphen — malformed placeholder
        environment: [],
        timeout_ms: 15000,
      },
    ],
    resolved_mcp_tool_refs: [
      { tool_id: "cap__x.publish", server_id: "cap__x", tool_name: "publish" },
    ],
    workspace_mcp_catalog: [],
  } as never;

  // Used to throw and fail the whole run; now the server is dropped + reported.
  assert.deepEqual(mcpServerPayloads(compiledPlan), []);
  const unavailable = mcpServersUnavailableForMissingEnv(compiledPlan);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].serverId, "cap__x");
  assert.match(unavailable[0].reason, /malformed placeholder/i);
  assert.deepEqual(unavailable[0].missingToolIds, ["cap__x.publish"]);
});

test("mergePreparedMcpServerPayloads prefers later bootstrapped servers with the same name", () => {
  const merged = mergePreparedMcpServerPayloads(
    [
      {
        name: "twitter",
        config: {
          type: "remote",
          enabled: true,
          url: "http://localhost:13100/mcp/sse",
          headers: {},
          timeout: 30000
        }
      },
      {
        name: "linkedin",
        config: {
          type: "remote",
          enabled: true,
          url: "http://localhost:13101/mcp/sse",
          headers: {},
          timeout: 30000
        }
      }
    ],
    [
      {
        name: "twitter",
        config: {
          type: "remote",
          enabled: true,
          url: "http://127.0.0.1:38081/mcp/sse",
          headers: { "X-Workspace-Id": "workspace-1" },
          timeout: 60000
        }
      }
    ]
  );

  assert.deepEqual(merged, [
    {
      name: "twitter",
      config: {
        type: "remote",
        enabled: true,
        url: "http://127.0.0.1:38081/mcp/sse",
        headers: { "X-Workspace-Id": "workspace-1" },
        timeout: 60000
      },
      _holaboss_force_refresh: true
    },
    {
      name: "linkedin",
      config: {
        type: "remote",
        enabled: true,
        url: "http://localhost:13101/mcp/sse",
        headers: {},
        timeout: 30000
      }
    }
  ]);
});
