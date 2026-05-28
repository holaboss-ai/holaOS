---
name: create-teammate
description: Create a teammate only after its stable responsibilities are understood, then add any teammate-local skill bundle with the split teammate runtime tools.
---

# Create Teammate

Use this skill when the workspace needs a new teammate identity, optionally followed by one or more teammate-local skills.

## Responsibility Discovery Gate
Do not create a teammate from a job title alone.

Before you call `teammates_create`, make sure you understand the stable remit:
- what work this teammate should own by default
- what it should explicitly not own
- how it differs from the current roster
- what recurring situations should route to it
- whether a durable local skill bundle is actually needed

If any of that is still vague, overlapping, or one-off:
- inspect the current teammate roster first
- infer what you can from the user's request and current workspace context
- ask only for the concrete missing responsibility details that block a durable definition
- do not create the teammate yet

## Core Rules
1. Create the teammate record first with `teammates_create`.
2. Keep `teammates_create` focused on teammate metadata only:
   - `name`
   - durable `instructions`
   - `capability_profile`
3. Create teammate-local skills separately with `teammate_skills_create`.
4. Teammate-local skills live under `teammates/<teammate-id>/skills/<skill-id>/`.
5. Use teammate-local skills only for reusable specialization that should follow that teammate across delegated runs. Do not create a skill for a one-off task brief.

## Workflow
1. Decide whether a new teammate is warranted.
   - Create a new teammate only when the role has a stable remit that is meaningfully different from existing teammates.
   - If the behavior is temporary, task-specific, or already covered by an existing teammate, do not create a new one.
2. Capture the stable remit before creation.
   - Identify responsibilities, boundaries, default work, and non-goals.
   - Compare that remit against the existing roster so you do not create an overlapping teammate.
   - If the remit is not durable enough to survive beyond the current task, stop and do not create the teammate.
3. Define the teammate metadata.
   - `name`: concise role label
   - `instructions`: durable standing remit, not a one-off task
   - `capability_profile.summary`: one-line routing summary
   - `capability_profile.capabilities`: short stable tags such as `research`, `frontend`, `implementation`, `ops`
   - `capability_profile.preferred_tools`: only real tool ids or stable tool buckets
4. Call `teammates_create`.
5. Decide whether the teammate also needs a local skill bundle.
   - Add a skill only when the teammate needs repeatable workflow guidance, bundled scripts, references, assets, or structured operating rules.
6. If needed, call `teammate_skills_create`.
   - Prefer `skill_markdown` for the canonical `SKILL.md`
   - Add `sidecar_files` for `scripts/`, `references/`, `assets/`, `agents/openai.yaml`, or other text files
   - Add `directories` only when an empty directory is intentionally needed

## Teammate Quality Bar
- The remit must be specific enough that another agent could predict when this teammate should or should not get the work.
- `instructions` should explain ownership, boundaries, and default behavior.
- Avoid copying the same sentence into `instructions`, `summary`, and the skill body.
- Capabilities should be routing hints, not paragraphs.
- Prefer one strong teammate over several overlapping vague teammates.

## Skill Quality Bar
1. The skill must have a valid `SKILL.md` with frontmatter:
   - `name: <skill-id>`
   - `description: <one-line summary>`
2. Keep `SKILL.md` concise.
3. Put detailed reference material into `references/` instead of bloating `SKILL.md`.
4. Put deterministic helpers into `scripts/`.
5. Put templates or static resources into `assets/`.
6. If the skill needs tool or command widening, declare them in `holaboss.granted_tools` and `holaboss.granted_commands`.

## Example Sequence
1. Call `teammates_create` for `Researcher`.
2. If the teammate needs a reusable sourcing workflow, call `teammate_skills_create` with:
   - `skill_markdown`
   - `scripts/fetch.sh`
   - `references/source-policy.md`

## Anti-Patterns
- Do not create a teammate before you understand its stable responsibilities.
- Do not create a teammate from a vague label like `researcher` or `builder` without defining ownership and boundaries.
- Do not stuff a one-off task brief into teammate creation.
- Do not create a teammate-local skill when a plain instruction block is enough.
- Do not put teammate-local skills under shared workspace `skills/`.
- Do not overload the teammate with multiple overlapping skills when one coherent bundle will do.
