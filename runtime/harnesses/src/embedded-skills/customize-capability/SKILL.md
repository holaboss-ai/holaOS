---
name: customize-capability
description: Guide for modifying an already-installed workspace capability — adding or editing its MCP servers, skills, integrations, or agent guidance. Use when the user wants to customize, change, or extend an existing capability.
---

# Customize Capability

Modify a capability that is already installed in this workspace. The most common
request is giving it an **MCP server** so its agent gains new tools, but the same
flow covers adding skills, integrations, or guidance.

A capability's source of truth is its manifest at
`capabilities/<capability-id>/capability.yaml`. Re-installing reads that manifest
and upserts the capability — re-install IS the update mechanism, and it never
creates a duplicate.

## Workflow
1. Identify the capability id from the user's request.
2. Read the current state:
   - If `capabilities/<capability-id>/capability.yaml` exists, edit it in place.
   - If it does NOT exist (the capability was installed from the catalog), create
     it. Reconstruct the existing config first so nothing is dropped: keep the
     capability's current skills (as `ref`), its integrations, and its
     `agent_prompt`, then add your change on top.
3. Apply the change (see "Adding an MCP server" for the common case).
4. Call the `capability_install` tool with `capability_id: <capability-id>`.
   It re-reads the manifest and upserts the capability. A malformed manifest is
   rejected with a precise error — fix and retry.
5. Tell the user the change takes effect on the **next** agent run: the runtime
   compiles MCP servers at run start, so the current run won't see the new tools.
   Ask them to send a new message to pick them up.

## Adding an MCP server

Add an `mcp:` block to the manifest. Each server connects the capability's agent
to an MCP endpoint and exposes the tools you list.

Remote server (an HTTP/SSE MCP endpoint):

```yaml
mcp:
  servers:
    - id: x                              # letters/digits/_/-, unique in this capability
      type: remote
      url: https://mcp.example/sse
      headers:                           # optional — e.g. auth
        Authorization: Bearer <token>
      tools: [create_post, list_posts]   # which tools to expose (required, ≥1)
```

Local server (a subprocess speaking MCP over stdio):

```yaml
mcp:
  servers:
    - id: helper
      type: local
      command: [npx, "-y", "@modelcontextprotocol/server-everything"]
      environment:                       # optional
        SOME_TOKEN: "{env:SOME_TOKEN}"   # reads from the runtime environment
      tools: [echo, add]
```

Rules:
- `tools` must list at least one tool name — you declare exactly which tools to expose.
- Remote servers require `url`; local servers require `command`.
- Put auth in `headers` (remote) or `environment` (local). Both header and
  environment values may use `{env:VAR_NAME}` to read from the runtime environment
  instead of hard-coding secrets.
- Ask the user for the server url/command, which tools to expose, and any auth
  before writing the manifest.

The exposed tools become available to the capability's agent on the next run.

## After installing
Confirm what you changed and remind the user to start a new message so the agent
picks up the new MCP tools.
