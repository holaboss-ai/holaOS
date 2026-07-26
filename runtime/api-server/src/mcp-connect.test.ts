// Covers the workspace.yaml writer behind the `mcp_connect` runtime tool:
// remote + local server shapes land in mcp_registry.servers, and the allowlist
// is deliberately never touched (CLI harnesses expose all of a connected
// server's tools; tool names aren't known at connect time).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import yaml from "js-yaml";

import { sameMcpTarget } from "./runtime-agent-tools.js";
import { upsertWorkspaceMcpServerEntry } from "./workspace-apps.js";

function readYaml(dir: string): Record<string, unknown> {
  return yaml.load(readFileSync(path.join(dir, "workspace.yaml"), "utf8")) as Record<
    string,
    unknown
  >;
}

test("upsertWorkspaceMcpServerEntry writes a remote server and preserves an existing allowlist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-mcp-connect-remote-"));
  // Seed a workspace.yaml with an app-owned server + allowlist already present.
  writeFileSync(
    path.join(dir, "workspace.yaml"),
    yaml.dump({
      mcp_registry: {
        servers: { existing_app: { type: "remote", url: "http://localhost:1/mcp", enabled: true } },
        allowlist: { tool_ids: ["existing_app.do_thing"] },
      },
    }),
    "utf8",
  );

  upsertWorkspaceMcpServerEntry(dir, {
    serverId: "acme",
    transport: "remote",
    url: "https://mcp.acme.com/sse",
    headers: { Authorization: "Bearer tok" },
  });

  const doc = readYaml(dir);
  const registry = doc.mcp_registry as Record<string, unknown>;
  const servers = registry.servers as Record<string, Record<string, unknown>>;
  assert.deepEqual(servers.acme, {
    type: "remote",
    enabled: true,
    url: "https://mcp.acme.com/sse",
    headers: { Authorization: "Bearer tok" },
  });
  // Existing server + allowlist are untouched (writer never edits the allowlist).
  assert.ok(servers.existing_app, "existing server preserved");
  assert.deepEqual(
    (registry.allowlist as Record<string, unknown>).tool_ids,
    ["existing_app.do_thing"],
  );
});

test("upsertWorkspaceMcpServerEntry writes a local command server (no allowlist created)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-mcp-connect-local-"));
  upsertWorkspaceMcpServerEntry(dir, {
    serverId: "local_mcp",
    transport: "local",
    command: ["npx", "-y", "@acme/mcp"],
    environment: { TOKEN: "x" },
  });

  const registry = readYaml(dir).mcp_registry as Record<string, unknown>;
  const servers = registry.servers as Record<string, Record<string, unknown>>;
  assert.deepEqual(servers.local_mcp, {
    type: "local",
    enabled: true,
    command: ["npx", "-y", "@acme/mcp"],
    environment: { TOKEN: "x" },
  });
  // No allowlist is fabricated for an agent-connected server.
  assert.equal(registry.allowlist, undefined);
});

// The connect flow reuses this to decide whether a derived-id collision is a
// reconnect (same target → overwrite in place) or a genuinely different server
// (must be disambiguated so it doesn't clobber the previous one).
test("sameMcpTarget: remote reconnect matches only the same URL", () => {
  const entry = { transport: "remote" as const, url: "https://mcp.acme.com/mcp/v1/" };
  assert.equal(sameMcpTarget(entry, "remote", "https://mcp.acme.com/mcp/v1/", []), true);
  // Different path on the SAME host (what host-derived ids collapse together).
  assert.equal(sameMcpTarget(entry, "remote", "https://mcp.acme.com/mcp/v2/", []), false);
  // A local command can never match a remote entry.
  assert.equal(sameMcpTarget(entry, "local", "", ["npx", "acme"]), false);
});

test("sameMcpTarget: local reconnect matches only the same command", () => {
  const entry = { transport: "local" as const, command: ["npx", "-y", "acme-mcp"] };
  assert.equal(sameMcpTarget(entry, "local", "", ["npx", "-y", "acme-mcp"]), true);
  assert.equal(sameMcpTarget(entry, "local", "", ["npx", "-y", "other-mcp"]), false);
});
