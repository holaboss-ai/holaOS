---
name: mcp-configurator
description: Add or update workspace MCP servers using holaOS mcp_registry syntax.
---

# MCP Configurator

Use this skill when the task is to add, remove, or update MCP access in a holaOS workspace.

## Core Rules
1. Edit `workspace.yaml` at the workspace root. Do not create `mcp.json`, `.cursor/mcp.json`, `claude_desktop_config.json`, or another generic MCP config unless the user explicitly asks for that format.
2. Workspace-level MCP lives under `mcp_registry`.
3. Tool ids in `mcp_registry.allowlist.tool_ids` must use strict `server.tool` syntax.
4. Omitting `mcp_registry.allowlist.tool_ids` or setting it to `[]` means all discovered tools from enabled configured servers stay available for that run.
5. Mixed mode is valid: some servers can be constrained by explicit allowlisted tool ids while other enabled servers stay discover-all.
6. This embedded skill is guidance only. When the user asks to add MCP to a workspace, update the target workspace config instead of writing new files under `runtime/harnesses/src/embedded-skills/`.

## Remote Server Shape

Use this shape for remote HTTP MCP servers:

```yaml
mcp_registry:
  servers:
    context7:
      type: remote
      url: https://mcp.context7.com/mcp
      enabled: true
      timeout_ms: 30000
      headers:
        CONTEXT7_API_KEY: "{env:CONTEXT7_API_KEY}"
  allowlist:
    tool_ids:
      - context7.lookup
      - context7.search
```

Header values must be either:
- a literal secret value
- or `{env:ENV_VAR_NAME}`

This is invalid:

```yaml
headers:
  CONTEXT7_API_KEY: "{env:ctx7sk-live-abc123}"
```

That is a placeholder-shaped literal secret, not an environment-variable reference.

## Local Server Shape

Use this shape for local stdio MCP servers:

```yaml
mcp_registry:
  servers:
    my_server:
      type: local
      command:
        - npx
        - -y
        - "@acme/my-mcp"
      enabled: true
      timeout_ms: 30000
      environment:
        MY_SERVER_API_KEY: "{env:MY_SERVER_API_KEY}"
```

Local MCP commands must be a non-empty list of command tokens.

## Workspace Tool Catalog Shape

Use `mcp_registry.catalog` for workspace-local tools implemented inside the repo:

```yaml
mcp_registry:
  servers:
    workspace:
      type: local
  catalog:
    workspace.echo:
      module_path: tools.echo
      symbol: echo_tool
  allowlist:
    tool_ids:
      - workspace.echo
```

Notes:
- `mcp_registry.servers.workspace` must stay `local`.
- The runtime owns the actual workspace MCP host command, so do not try to wire a custom `command` for `workspace`.
- Each `workspace.<tool>` allowlist entry must have a matching `mcp_registry.catalog` entry.

## App-Managed MCP

If the MCP tools come from a workspace app's `app.runtime.yaml` `mcp.tools`, prefer the app-managed flow:
- keep the app manifest correct
- let the runtime reconcile `mcp_registry.servers.<app_id>` and `mcp_registry.allowlist.tool_ids`
- do not hand-maintain those generated entries unless the task explicitly requires it

## Verification
1. Re-open `workspace.yaml` and confirm the final shape is `mcp_registry`, not a generic MCP config format.
2. Confirm every allowlisted tool id is `server.tool`.
3. Confirm every referenced server id exists under `mcp_registry.servers`.
4. Confirm placeholder syntax is `{env:ENV_VAR_NAME}` when environment indirection is intended.
5. Remember that MCP config changes take effect on the next run, not retroactively inside the already running harness session.
