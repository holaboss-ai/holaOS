---
name: skill-creator
description: Guide for creating effective skills. Use when creating or updating a skill.
---

# Skill Creator

Use this skill when defining or updating reusable Codex skills.

## Workflow
1. Workspace-local skills always live under `skills/` at the workspace root.
2. Create or update each workspace skill under `skills/<skill-id>/` and save `SKILL.md` plus any helper files there.
3. This embedded skill is guidance only: do not write new workspace skills into `runtime/harnesses/src/embedded-skills/`.
4. Clarify the task and gather concrete examples.
5. Define minimal reusable structure and naming.
6. Enforce canonical `SKILL.md` format:
   - frontmatter is required and must include:
     - `name: <skill-id>` (must exactly match the directory name under `skills/`)
     - `description: <one-line summary>`
   - markdown body starts after frontmatter and contains practical usage guidance.
7. Start from this template and fill in concrete content:

```markdown
---
name: <skill-id>
description: <one-line summary>
---

# <Readable Skill Title>

## When To Use
- ...

## Workflow
1. ...
2. ...

## Examples
- ...
```

8. Keep `SKILL.md` concise; use references/scripts only when needed.
9. Validate with a real invocation path.
10. Iterate from usage feedback.
