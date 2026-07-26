---
name: capability-creator
description: Guide for assembling a workspace capability (skills + integrations). Use when the user wants to create a capability.
---

# Capability Creator

A capability bundles one or more skills and the integrations they need into one
named, installable unit. Use this when the user wants to create a capability.

## Workflow
1. Clarify the outcome the capability should deliver and which platforms it touches.
2. Ensure each skill it needs exists under `skills/<skill-id>/`. Create any
   missing skill with the skill-creator guidance first.
3. Write the manifest to `capabilities/<capability-id>/capability.yaml` at the
   workspace root. Reference existing skills by `ref` (do not copy them). Declare
   each external service the capability needs under `integrations`.
4. Call the `capability_install` tool with `capability_id: <capability-id>`.
5. Report the result. If an integration comes back `needs_connection`, tell the
   user which one to connect.

## Manifest format

```yaml
id: <capability-id>            # must match the directory name
name: <Readable Name>
description: <one line>
version: 0.1.0
skills:
  - ref: <existing-skill-id>   # reference a workspace skill by id
integrations:
  - provider: <provider-id>    # e.g. linkedin, gmail, twitter
    required: true
    reason: <why this capability needs it>
agent_prompt: |
  <short guidance appended to AGENTS.md describing when/how to use this capability>
```

Keep the manifest minimal. Prefer `ref` skills over embedding `path` skills.
