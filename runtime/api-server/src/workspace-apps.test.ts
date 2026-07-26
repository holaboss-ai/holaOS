import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import yaml from "js-yaml";

import {
  listWorkspaceMcpRegistryServers,
  migrateLegacyAppMcpServers,
  readWorkspaceYamlDocument,
  upsertWorkspaceMcpServerEntry,
  writeWorkspaceMcpRegistryEntry,
} from "./workspace-apps.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hb-wsapps-"));
}

function seedWorkspaceYaml(dir: string, mcpRegistry: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dir, "workspace.yaml"),
    yaml.dump({ agents: { id: "holaboss" }, mcp_registry: mcpRegistry }),
    "utf8",
  );
}

test("readWorkspaceYamlDocument returns a valid workspace.yaml untouched", () => {
  const dir = tmpWorkspace();
  fs.writeFileSync(
    path.join(dir, "workspace.yaml"),
    '"agents":\n  "id": "holaboss"\n"mcp_registry":\n  "servers": {}\n',
    "utf8",
  );

  const doc = readWorkspaceYamlDocument(dir);

  assert.equal((doc.agents as { id?: string })?.id, "holaboss");
  // No repair path taken → no quarantine copy.
  assert.equal(
    fs.readdirSync(dir).some((f) => f.includes("corrupt")),
    false,
  );
});

test("readWorkspaceYamlDocument self-heals a corrupt workspace.yaml with trailing garbage", () => {
  const dir = tmpWorkspace();
  const yamlPath = path.join(dir, "workspace.yaml");
  const valid =
    '"agents":\n  "id": "holaboss"\n"mcp_registry":\n  "allowlist":\n    "tool_ids":\n      - "gofunds.go_live"\n      - "gofunds.set_status"\n';
  // A stray process PATH appended after the valid document — the observed bug.
  fs.writeFileSync(
    yamlPath,
    `${valid}/Users/x/Developer/Holaboss/apps/node_modules/.bin:/usr/local/bin:/usr/bin\n`,
    "utf8",
  );

  const doc = readWorkspaceYamlDocument(dir);

  // 1) Recovered the valid config (not an empty fallback).
  assert.equal((doc.agents as { id?: string })?.id, "holaboss");
  const toolIds = (doc.mcp_registry as { allowlist?: { tool_ids?: string[] } })?.allowlist
    ?.tool_ids;
  assert.deepEqual(toolIds, ["gofunds.go_live", "gofunds.set_status"]);

  // 2) The file on disk was rewritten to valid, re-parseable YAML.
  const rewritten = fs.readFileSync(yamlPath, "utf8");
  assert.doesNotThrow(() => yaml.load(rewritten));
  assert.equal(rewritten.includes("node_modules/.bin"), false);

  // 3) The corrupt original was quarantined for diagnosis.
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("workspace.yaml.corrupt-")));
});

test("writeWorkspaceMcpRegistryEntry writes an app MCP into app_servers with owner_app_id", () => {
  const dir = tmpWorkspace();
  seedWorkspaceYaml(dir, { servers: {}, allowlist: { tool_ids: [] } });

  writeWorkspaceMcpRegistryEntry(dir, "helm", {
    mcpEnabled: true,
    mcpTools: ["go_live"],
    mcpPath: "/mcp/sse",
    mcpTimeoutMs: 30000,
    mcpPort: 13100,
  });

  const registry = readWorkspaceYamlDocument(dir).mcp_registry as {
    servers?: Record<string, unknown>;
    app_servers?: Record<string, { owner_app_id?: string; type?: string }>;
  };
  // Landed in the app-owned section, NOT the standalone pool.
  assert.equal(registry.servers?.helm, undefined);
  assert.equal(registry.app_servers?.helm?.owner_app_id, "helm");
  assert.equal(registry.app_servers?.helm?.type, "remote");
});

test("listWorkspaceMcpRegistryServers separates the standalone pool from app_servers", () => {
  const dir = tmpWorkspace();
  seedWorkspaceYaml(dir, {
    servers: { adspower: { type: "local", command: ["npx", "x"], enabled: true } },
    app_servers: {
      helm: { type: "remote", url: "https://e/mcp/helm", enabled: true, owner_app_id: "helm" },
    },
    allowlist: { tool_ids: [] },
  });

  const list = listWorkspaceMcpRegistryServers(dir);
  const adspower = list.find((s) => s.id === "adspower");
  const helm = list.find((s) => s.id === "helm");

  assert.equal(adspower?.appManaged, false);
  assert.equal(adspower?.ownerAppId, undefined);
  assert.equal(helm?.appManaged, true);
  assert.equal(helm?.ownerAppId, "helm");
});

test("upsertWorkspaceMcpServerEntry routes by ownerAppId; legacy started_at reads as app-owned", () => {
  const dir = tmpWorkspace();
  seedWorkspaceYaml(dir, {
    // A legacy app MCP still parked in the standalone pool (carries started_at).
    servers: {
      drawio: {
        type: "remote",
        url: "https://e/mcp/drawio",
        enabled: true,
        started_at: "2026-01-01T00:00:00Z",
      },
    },
    allowlist: { tool_ids: [] },
  });

  // Standalone user connect → stays in the pool.
  upsertWorkspaceMcpServerEntry(dir, {
    serverId: "notion",
    transport: "remote",
    url: "https://mcp.notion",
  });
  // App-owned connect (command/api-key app install) → app_servers.
  upsertWorkspaceMcpServerEntry(dir, {
    serverId: "jianguoyun",
    transport: "remote",
    url: "https://e/mcp/jgy",
    ownerAppId: "jianguoyun",
  });

  const byId = Object.fromEntries(
    listWorkspaceMcpRegistryServers(dir).map((s) => [s.id, s]),
  );
  assert.equal(byId.notion?.ownerAppId, undefined);
  assert.equal(byId.jianguoyun?.ownerAppId, "jianguoyun");
  // Back-compat: a legacy started_at server still groups under its app.
  assert.equal(byId.drawio?.ownerAppId, "drawio");
});

test("migrateLegacyAppMcpServers moves started_at servers into app_servers, leaves standalone + is idempotent", () => {
  const dir = tmpWorkspace();
  seedWorkspaceYaml(dir, {
    servers: {
      // reserved internal server — must never move
      workspace: { type: "local", command: [], enabled: true },
      // legacy app MCP parked in the standalone pool (carries started_at)
      helm: {
        type: "remote",
        url: "https://e/mcp/helm",
        enabled: true,
        started_at: "2026-01-01T00:00:00Z",
      },
      // genuine standalone (user-added) — no started_at
      adspower: { type: "local", command: ["npx", "x"], enabled: true },
    },
    allowlist: { tool_ids: [] },
  });

  const moved = migrateLegacyAppMcpServers(dir);
  assert.deepEqual(moved, ["helm"]);

  const registry = readWorkspaceYamlDocument(dir).mcp_registry as {
    servers?: Record<string, unknown>;
    app_servers?: Record<string, { owner_app_id?: string }>;
  };
  // helm relocated + tagged; standalone + workspace untouched.
  assert.equal(registry.servers?.helm, undefined);
  assert.equal(registry.app_servers?.helm?.owner_app_id, "helm");
  assert.ok(registry.servers?.adspower, "standalone server stays in the pool");
  assert.ok(registry.servers?.workspace, "reserved workspace server stays");

  // Idempotent: a second run finds nothing to move and does not rewrite.
  assert.deepEqual(migrateLegacyAppMcpServers(dir), []);
});
