---
name: skill-installer
description: Install workspace skills from curated sources or import open-source skills from GitHub.
---

# Skill Installer

Use this skill to install workspace skills into the workspace-local `skills/` directory, where the runtime auto-discovers them on the next run.

## Import an open-source skill from GitHub (preferred)

Open-source skills (e.g. `github.com/anthropics/skills`) are just `SKILL.md` folders in the same format used here, so they can be imported whole. Use the runtime endpoint — it fetches the entire folder (`SKILL.md` plus bundled `scripts/`, `references/`, `assets/`), maps foreign frontmatter (`allowed-tools` → `holaboss_granted_tools`, aligns `name` to the installed id), and writes it under `skills/<id>/`:

- Preview (no write): `POST /api/v1/workspaces/{workspaceId}/skills/import-github/preview` with `{ "url": "<github folder or SKILL.md URL>" }` — returns the parsed name, description, granted tools, and file list so you can confirm before installing.
- Install: `POST /api/v1/workspaces/{workspaceId}/skills/import-github` with the same body.

Accepts `github.com/<owner>/<repo>/tree/<ref>/<path>` (folder), `.../blob/<ref>/<path>/SKILL.md` (single file), or a bare repo. Pass an optional `"ref"` for a specific branch/tag/commit (defaults to the repo's default branch). Skills whose bundled scripts assume tools this sandbox lacks still install and work as pure guidance.

## Notes
1. Install each workspace skill under `skills/<skill-id>/` with its `SKILL.md` plus any helper files. For skills you author by hand, create these files directly with the Write tool.
2. Guidance only: do not install workspace skills into `runtime/harnesses/src/embedded-skills/`. Do not install into `$CODEX_HOME/skills` unless the user explicitly asks for a global install rather than a workspace install.
