import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import yaml from "js-yaml";

import {
  bootstrapComposioMcpForWorkspace,
  COMPOSIO_REGISTRY_SERVER_ID,
  removeComposioMcpRegistryEntry,
  writeComposioMcpRegistryEntry,
} from "./composio-tool-registry.js";
import { ComposioService } from "./composio-service.js";

function createTempWorkspace(prefix = "composio-mcp-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, "workspace.yaml"), "", "utf8");
  return dir;
}

function readWorkspaceYaml(workspaceDir: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(workspaceDir, "workspace.yaml"), "utf8");
  return (yaml.load(raw) as Record<string, unknown> | undefined) ?? {};
}

// Guard: COMPOSIO_REGISTRY_SERVER_ID must satisfy the validator regex in
// workspace-runtime-plan.ts (TOOL_ID_PATTERN). The validator runs at agent-run
// time, AFTER yaml is on disk — if this drifts we'd ship a workspace.yaml
// that crashes pi with "tool id ... must match strict 'server.tool' format".
// Mirror the regex here on purpose: catch drift even if the validator regex
// is loosened upstream (we still need to stay strict on our own ids).
test("COMPOSIO_REGISTRY_SERVER_ID matches the plan validator's TOOL_ID_PATTERN", () => {
  const TOOL_ID_PATTERN = /^(?<server>[A-Za-z0-9][A-Za-z0-9_-]*)\.(?<tool>[A-Za-z0-9][A-Za-z0-9_-]*)$/;
  const sampleToolId = `${COMPOSIO_REGISTRY_SERVER_ID}.gmail_get_profile`;
  const match = TOOL_ID_PATTERN.exec(sampleToolId);
  assert.ok(
    match,
    `tool id '${sampleToolId}' must match TOOL_ID_PATTERN — server segment cannot start with underscore`,
  );
  assert.equal(match?.groups?.server, COMPOSIO_REGISTRY_SERVER_ID);
});

test("writeComposioMcpRegistryEntry adds a holaboss_composio server + tool_ids entry", () => {
  const workspaceDir = createTempWorkspace();
  try {
    writeComposioMcpRegistryEntry(workspaceDir, {
      serverUrl: "http://127.0.0.1:13150/mcp",
      toolNames: ["gmail_get_profile"],
    });
    const doc = readWorkspaceYaml(workspaceDir) as {
      mcp_registry?: {
        servers?: Record<string, { type?: string; url?: string; enabled?: boolean }>;
        allowlist?: { tool_ids?: string[] };
      };
    };
    assert.equal(doc.mcp_registry?.servers?.holaboss_composio?.type, "remote");
    assert.equal(doc.mcp_registry?.servers?.holaboss_composio?.url, "http://127.0.0.1:13150/mcp");
    assert.equal(doc.mcp_registry?.servers?.holaboss_composio?.enabled, true);
    assert.deepEqual(doc.mcp_registry?.allowlist?.tool_ids, [
      "holaboss_composio.gmail_get_profile",
    ]);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("writeComposioMcpRegistryEntry preserves coexisting app server entries", () => {
  const workspaceDir = createTempWorkspace();
  try {
    // Seed: an app already wrote its entry (mimicking writeWorkspaceMcpRegistryEntry).
    fs.writeFileSync(
      path.join(workspaceDir, "workspace.yaml"),
      yaml.dump({
        mcp_registry: {
          servers: {
            twitter: {
              type: "remote",
              url: "http://127.0.0.1:13100/mcp/sse",
              enabled: true,
            },
          },
          allowlist: { tool_ids: ["twitter.create_post", "twitter.list_posts"] },
        },
      }),
      "utf8",
    );

    writeComposioMcpRegistryEntry(workspaceDir, {
      serverUrl: "http://127.0.0.1:13150/mcp",
      toolNames: ["gmail_get_profile"],
    });

    const doc = readWorkspaceYaml(workspaceDir) as {
      mcp_registry: {
        servers: Record<string, unknown>;
        allowlist: { tool_ids: string[] };
      };
    };
    assert.ok(doc.mcp_registry.servers.twitter, "twitter app entry should remain");
    assert.ok(doc.mcp_registry.servers.holaboss_composio, "composio entry should be added");
    assert.deepEqual(doc.mcp_registry.allowlist.tool_ids, [
      "twitter.create_post",
      "twitter.list_posts",
      "holaboss_composio.gmail_get_profile",
    ]);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("writeComposioMcpRegistryEntry replaces its own previous tool_ids (no duplicates after re-bootstrap)", () => {
  const workspaceDir = createTempWorkspace();
  try {
    writeComposioMcpRegistryEntry(workspaceDir, {
      serverUrl: "http://127.0.0.1:13150/mcp",
      toolNames: ["gmail_get_profile"],
    });
    writeComposioMcpRegistryEntry(workspaceDir, {
      serverUrl: "http://127.0.0.1:13151/mcp",
      toolNames: [
        "gmail_get_profile",
        "composio_gmail_fetch_emails",
      ],
    });
    const doc = readWorkspaceYaml(workspaceDir) as {
      mcp_registry: { allowlist: { tool_ids: string[] } };
    };
    assert.deepEqual(doc.mcp_registry.allowlist.tool_ids, [
      "holaboss_composio.gmail_get_profile",
      "holaboss_composio.composio_gmail_fetch_emails",
    ]);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("writeComposioMcpRegistryEntry drops legacy __composio__ entries (pre-rename cleanup)", () => {
  const workspaceDir = createTempWorkspace();
  try {
    // Seed: workspace.yaml from a pre-release build using the broken id.
    fs.writeFileSync(
      path.join(workspaceDir, "workspace.yaml"),
      yaml.dump({
        mcp_registry: {
          servers: {
            twitter: { type: "remote", url: "http://127.0.0.1:13100/mcp/sse" },
            __composio__: { type: "remote", url: "http://127.0.0.1:13150/mcp" },
          },
          allowlist: {
            tool_ids: ["twitter.create_post", "__composio__.gmail_get_profile"],
          },
        },
      }),
      "utf8",
    );
    writeComposioMcpRegistryEntry(workspaceDir, {
      serverUrl: "http://127.0.0.1:13151/mcp",
      toolNames: ["gmail_get_profile"],
    });
    const doc = readWorkspaceYaml(workspaceDir) as {
      mcp_registry: {
        servers: Record<string, unknown>;
        allowlist: { tool_ids: string[] };
      };
    };
    assert.equal(doc.mcp_registry.servers.__composio__, undefined, "legacy server entry must be gone");
    assert.ok(doc.mcp_registry.servers.holaboss_composio, "new server entry should be present");
    assert.ok(doc.mcp_registry.servers.twitter, "twitter entry should remain untouched");
    assert.deepEqual(doc.mcp_registry.allowlist.tool_ids, [
      "twitter.create_post",
      "holaboss_composio.gmail_get_profile",
    ]);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("removeComposioMcpRegistryEntry strips only the holaboss_composio server + its tool_ids", () => {
  const workspaceDir = createTempWorkspace();
  try {
    fs.writeFileSync(
      path.join(workspaceDir, "workspace.yaml"),
      yaml.dump({
        mcp_registry: {
          servers: {
            twitter: { type: "remote", url: "http://127.0.0.1:13100/mcp/sse" },
            holaboss_composio: { type: "remote", url: "http://127.0.0.1:13150/mcp" },
          },
          allowlist: {
            tool_ids: [
              "twitter.create_post",
              "holaboss_composio.gmail_get_profile",
            ],
          },
        },
      }),
      "utf8",
    );
    removeComposioMcpRegistryEntry(workspaceDir);
    const doc = readWorkspaceYaml(workspaceDir) as {
      mcp_registry: { servers: Record<string, unknown>; allowlist: { tool_ids: string[] } };
    };
    assert.equal(doc.mcp_registry.servers.holaboss_composio, undefined);
    assert.ok(doc.mcp_registry.servers.twitter, "twitter entry should remain");
    assert.deepEqual(doc.mcp_registry.allowlist.tool_ids, ["twitter.create_post"]);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("bootstrapComposioMcpForWorkspace boots the host, writes the registry, and serves a real MCP client end-to-end", async () => {
  const workspaceDir = createTempWorkspace();
  try {
    // Stand in for Hono's /api/composio/execute. We never let the real
    // Composio backend get called — that's verified in Step 0.
    const honoCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      honoCalls.push({ url, body });
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            emailAddress: "tommy@holaboss.ai",
            messagesTotal: 626,
            threadsTotal: 611,
          },
          log_id: "log_test123",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const composioService = new ComposioService({
      honoBaseUrl: "https://app.holaboss.test",
      authCookie: "hb_session=test",
      fetchImpl,
    });

    const bootstrap = await bootstrapComposioMcpForWorkspace({
      workspaceDir,
      honoBaseUrl: "https://app.holaboss.test",
      authCookie: "hb_session=test",
      catalog: [
        {
          name: "gmail_get_profile",
          description:
            "Read the authenticated Gmail user's profile (email address, message count, thread count). Read-only.",
          toolkit_slug: "gmail",
          tool_slug: "GMAIL_GET_PROFILE",
          connected_account_id: "ca_4vYjam9qHD46",
          input_schema: {
            type: "object",
            title: "GmailGetProfileRequest",
            properties: {
              user_id: {
                type: "string",
                default: "me",
                description:
                  "User identifier — 'me' for the authenticated user.",
                examples: ["me", "user@example.com"],
              },
            },
          },
          annotations: { readOnlyHint: true },
        },
      ],
      composioService,
    });

    // Registry: server entry + tool id written.
    const doc = readWorkspaceYaml(workspaceDir) as {
      mcp_registry: {
        servers: Record<string, { url?: string }>;
        allowlist: { tool_ids: string[] };
      };
    };
    assert.equal(doc.mcp_registry.servers.holaboss_composio?.url, bootstrap.url);
    assert.deepEqual(doc.mcp_registry.allowlist.tool_ids, [
      "holaboss_composio.gmail_get_profile",
    ]);

    // End-to-end: an MCP client connects to the host and calls the tool.
    const client = new Client({ name: "composio-test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(bootstrap.url));
    await client.connect(transport);

    try {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 1);
      assert.equal(tools.tools[0]?.name, "gmail_get_profile");

      const call = await client.callTool({
        name: "gmail_get_profile",
        arguments: {},
      });
      assert.equal(call.isError ?? false, false);
      const structured = call.structuredContent as { emailAddress?: string; messagesTotal?: number };
      assert.equal(structured.emailAddress, "tommy@holaboss.ai");
      assert.equal(structured.messagesTotal, 626);

      // Hono got exactly one call with the expected shape.
      assert.equal(honoCalls.length, 1);
      assert.equal(honoCalls[0]?.url, "https://app.holaboss.test/api/composio/execute");
      assert.deepEqual(honoCalls[0]?.body, {
        tool_slug: "GMAIL_GET_PROFILE",
        connected_account_id: "ca_4vYjam9qHD46",
        arguments: {},
      });
    } finally {
      await client.close();
    }

    await bootstrap.close();
    const afterClose = readWorkspaceYaml(workspaceDir) as {
      mcp_registry: { servers: Record<string, unknown>; allowlist: { tool_ids: string[] } };
    };
    assert.equal(afterClose.mcp_registry.servers.holaboss_composio, undefined);
    assert.deepEqual(afterClose.mcp_registry.allowlist.tool_ids, []);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
