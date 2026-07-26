import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  callWorkspaceTool,
  decodeWorkspaceMcpHostCliRequest,
  inspectWorkspaceTools
} from "./workspace-mcp-host.js";

function encodeRequest(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function encodeCatalog(entries: Array<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(entries), "utf8").toString("base64");
}

function makeWorkspaceWithNodeTool(): { root: string; workspaceDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-workspace-mcp-host-"));
  const workspaceDir = path.join(root, "workspace");
  const toolsDir = path.join(workspaceDir, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(
    path.join(toolsDir, "echo.mjs"),
    [
      "export async function echo_tool(args) {",
      "  return args.text;",
      "}",
      "echo_tool.description = 'Echo text';",
      "echo_tool.inputSchema = {",
      "  type: 'object',",
      "  properties: { text: { type: 'string' } },",
      "  required: ['text']",
      "};",
      ""
    ].join("\n"),
    "utf8"
  );
  return { root, workspaceDir };
}

test("decodeWorkspaceMcpHostCliRequest decodes a valid request payload", () => {
  const request = decodeWorkspaceMcpHostCliRequest(
    encodeRequest({
      workspace_dir: "/tmp/workspace-1",
      catalog_json_base64: "W10=",
      host: "127.0.0.1",
      port: 8080,
      server_name: "workspace__abc123"
    })
  );

  assert.deepEqual(request, {
    workspace_dir: "/tmp/workspace-1",
    catalog_json_base64: "W10=",
    host: "127.0.0.1",
    port: 8080,
    server_name: "workspace__abc123"
  });
});

test("inspectWorkspaceTools loads Node workspace tools in-process", async () => {
  const { root, workspaceDir } = makeWorkspaceWithNodeTool();
  try {
    const tools = await inspectWorkspaceTools({
      workspace_dir: workspaceDir,
      catalog_json_base64: encodeCatalog([
        {
          tool_id: "workspace.echo",
          tool_name: "echo",
          module_path: "tools.echo",
          symbol_name: "echo_tool"
        }
      ]),
      host: "127.0.0.1",
      port: 8080,
      server_name: "workspace__abc123"
    });

    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "echo");
    assert.equal(tools[0]?.description, "Echo text");
    assert.deepEqual(tools[0]?.inputSchema, {
      type: "object",
      properties: {
        text: { type: "string" }
      },
      required: ["text"]
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspectWorkspaceTools rejects unsupported non-Node workspace tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-workspace-mcp-host-unsupported-"));
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  try {
    await assert.rejects(
      inspectWorkspaceTools({
        workspace_dir: workspaceDir,
        catalog_json_base64: encodeCatalog([
          {
            tool_id: "workspace.echo",
            tool_name: "echo",
            module_path: "tools.echo",
            symbol_name: "echo_tool"
          }
        ]),
        host: "127.0.0.1",
        port: 8080,
        server_name: "workspace__abc123"
      }),
      /workspace_mcp_catalog_entry_invalid at mcp_registry\.catalog\.workspace\.echo\.module_path/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("callWorkspaceTool invokes Node workspace tools in-process", async () => {
  const { root, workspaceDir } = makeWorkspaceWithNodeTool();
  try {
    const result = await callWorkspaceTool(
      {
        workspace_dir: workspaceDir,
        catalog_json_base64: encodeCatalog([
          {
            tool_id: "workspace.echo",
            tool_name: "echo",
            module_path: "tools.echo",
            symbol_name: "echo_tool"
          }
        ]),
        host: "127.0.0.1",
        port: 8080,
        server_name: "workspace__abc123"
      },
      "echo",
      { text: "hello" }
    );

    assert.deepEqual(result, {
      content: [{ type: "text", text: "hello" }],
      structuredContent: { result: "hello" }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("callWorkspaceTool reloads Node workspace tools between calls", async () => {
  const { root, workspaceDir } = makeWorkspaceWithNodeTool();
  const toolPath = path.join(workspaceDir, "tools", "echo.mjs");
  try {
    const request = {
      workspace_dir: workspaceDir,
      catalog_json_base64: encodeCatalog([
        {
          tool_id: "workspace.echo",
          tool_name: "echo",
          module_path: "tools.echo",
          symbol_name: "echo_tool"
        }
      ]),
      host: "127.0.0.1",
      port: 8080,
      server_name: "workspace__abc123"
    };

    const first = await callWorkspaceTool(request, "echo", { text: "hello" });
    assert.deepEqual(first, {
      content: [{ type: "text", text: "hello" }],
      structuredContent: { result: "hello" }
    });

    fs.writeFileSync(
      toolPath,
      [
        "export async function echo_tool(args) {",
        "  return `updated:${args.text}`;",
        "}",
        "echo_tool.description = 'Echo text';",
        "echo_tool.inputSchema = {",
        "  type: 'object',",
        "  properties: { text: { type: 'string' } },",
        "  required: ['text']",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const second = await callWorkspaceTool(request, "echo", { text: "hello" });
    assert.deepEqual(second, {
      content: [{ type: "text", text: "updated:hello" }],
      structuredContent: { result: "updated:hello" }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("callWorkspaceTool rejects unsupported non-Node workspace tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hb-workspace-mcp-host-unsupported-"));
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  try {
    await assert.rejects(
      callWorkspaceTool(
        {
          workspace_dir: workspaceDir,
          catalog_json_base64: encodeCatalog([
            {
              tool_id: "workspace.echo",
              tool_name: "echo",
              module_path: "tools.echo",
              symbol_name: "echo_tool"
            }
          ]),
          host: "127.0.0.1",
          port: 8080,
          server_name: "workspace__abc123"
        },
        "echo",
        { text: "hello" }
      ),
      /workspace_mcp_catalog_entry_invalid at mcp_registry\.catalog\.workspace\.echo\.module_path/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inspectWorkspaceTools loads multiple Node-backed tools in catalog order", async () => {
  const { root, workspaceDir } = makeWorkspaceWithNodeTool();
  try {
    fs.writeFileSync(
      path.join(workspaceDir, "tools", "lookup.mjs"),
      [
        "export async function lookup_tool(args) {",
        "  return { value: args.key ?? null };",
        "}",
        "lookup_tool.description = 'Lookup value';",
        "lookup_tool.inputSchema = {",
        "  type: 'object',",
        "  properties: { key: { type: 'string' } }",
        "};",
        ""
      ].join("\n"),
      "utf8"
    );

    const tools = await inspectWorkspaceTools({
      workspace_dir: workspaceDir,
      catalog_json_base64: encodeCatalog([
        {
          tool_id: "workspace.echo",
          tool_name: "echo",
          module_path: "tools.echo",
          symbol_name: "echo_tool"
        },
        {
          tool_id: "workspace.lookup",
          tool_name: "lookup",
          module_path: "tools.lookup",
          symbol_name: "lookup_tool"
        }
      ]),
      host: "127.0.0.1",
      port: 8080,
      server_name: "workspace__abc123"
    });

    assert.deepEqual(tools.map((tool) => tool.name), ["echo", "lookup"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
