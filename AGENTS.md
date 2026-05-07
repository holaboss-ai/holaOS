# Repository Guidelines

## Workspace Instruction Persistence
Any requirement or rule mentioned by the user must be recorded in `AGENTS.md`, even when it appears scoped to a single turn or deliverable, unless the user explicitly says not to persist it.

When the user changes, retracts, or supersedes a prior requirement, update `AGENTS.md` to reflect the latest instruction state instead of leaving stale rules behind.

Use `AGENTS.md` as the canonical ledger of all user-stated requirements. After recording a requirement, classify it: always-on policy remains in `AGENTS.md`, while conditional, situational, or procedural requirements should also create or update a workspace-local skill.

## Workspace Skills Index
Keep a short index here for every workspace-local skill created from recorded requirements, including the skill id and when to use it. No workspace-local skills are currently installed.

## Commit & Pull Request Guidelines
Commit history follows Conventional Commits (`feat:`, `fix:`, `migrate:`, `chore:`, etc.) and must use a detailed, structured message format.

Commit message format:
1. First line: `<type>: <imperative summary>` scoped to one cohesive concern.
2. Blank line.
3. Bullet list describing what changed and why (APIs, models, migrations, deletions, wiring changes, behavior changes).
4. Include validation coverage in the body when relevant (tests/lint/commands run).

Example pattern:
```text
feat: add cronjobs API and expand proactive analyst bootstrap context

- add a new FastAPI cronjobs service with health and CRUD/list endpoints
- add typed cronjobs client helpers and API-key handling
- update proactive analyst bootstrap context to include profile cronjobs
- add/adjust tests for API, client, and prompt behavior
```

PRs should describe context, validation commands (e.g., `make check`, `npm run runtime:test`), linked issues, and screenshots/log excerpts for API or UI-affecting work. Highlight any Supabase branch or migration impacts and note required environment tweaks.
