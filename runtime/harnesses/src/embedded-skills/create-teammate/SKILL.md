---
name: create-teammate
description: Provision a production-ready teammate only after its stable responsibilities, prerequisites, and reusable operating guidance are understood.
---

# Create Teammate

Use this skill when the workspace needs a new teammate identity, usually followed by one or more teammate-local skills and any prerequisite integration setup.

## Responsibility Discovery Gate
Do not create a teammate from a job title alone.

Before you call `teammates_create`, make sure you understand the stable remit:
- what work this teammate should own by default
- what it should explicitly not own
- how it differs from the current roster
- what recurring situations should route to it
- what integrations, references, or recurring workflows the role depends on
- what durable local skill bundle is needed for the role to be effective immediately

If any of that is still vague, overlapping, or one-off:
- inspect the current teammate roster first, preferably with `teammates_list`
- infer what you can from the user's request and current workspace context
- ask only for the concrete missing responsibility details that block a durable definition
- do not create the teammate yet

## Production Bootstrap Rule
Do not stop at a thin teammate profile.

When a new specialist teammate is warranted, provision it so it can do real work immediately:
- identify required integrations or connected apps
- ask the user to connect missing prerequisites instead of silently accepting a crippled setup
- synthesize a durable operating playbook from the role request and available workspace context
- create teammate-local skills when the role needs repeatable workflows, references, scripts, assets, or structured operating rules

## Core Rules
1. Create the teammate record first with `teammates_create`.
2. Keep `teammates_create` focused on teammate metadata only:
   - `name`
   - durable `instructions`
   - `capability_profile`
3. Create teammate-local skills separately with `teammate_skills_create`.
4. Teammate-local skills live under `teammates/<teammate-id>/skills/<skill-id>/`.
5. Use teammate-local skills for reusable specialization that should follow that teammate across delegated runs. Do not create a skill for a one-off task brief.

## Workflow
1. Decide whether a new teammate is warranted.
   - Create a new teammate only when the role has a stable remit that is meaningfully different from existing teammates.
   - If the behavior is temporary, task-specific, or already covered by an existing teammate, do not create a new one.
2. Capture the stable remit before creation.
   - Identify responsibilities, boundaries, default work, and non-goals.
   - Compare that remit against the existing roster so you do not create an overlapping teammate.
   - Use `teammates_list` for the authoritative live roster instead of guessing from file layout or stale memory.
   - If the remit is not durable enough to survive beyond the current task, stop and do not create the teammate.
3. Inspect prerequisites before creation.
   - Identify which integrations, connected apps, files, references, or workspace capabilities this teammate will rely on.
   - If the role depends on an integration that is missing or disconnected, ask the user to connect it before finalizing the teammate.
   - Do not pretend the teammate is production-ready if a critical prerequisite is still absent.
4. Synthesize the operating playbook.
   - Turn the role request into durable operating guidance, not just a title and a sentence.
   - Decide what should live in standing `instructions` versus a teammate-local skill bundle.
   - Default toward creating at least one teammate-local skill for specialist roles with repeatable workflows.
5. Define the teammate metadata.
   - `name`: concise role label
   - `instructions`: durable standing remit, not a one-off task
   - `capability_profile.summary`: one-line routing summary
   - `capability_profile.capabilities`: short stable tags such as `research`, `frontend`, `implementation`, `ops`
6. Call `teammates_create`.
7. Decide whether the teammate also needs a local skill bundle.
   - For specialist roles, the answer is usually yes.
   - Add a skill when the teammate needs repeatable workflow guidance, bundled scripts, references, assets, or structured operating rules.
8. If needed, call `teammate_skills_create`.
   - Prefer `skill_markdown` for the canonical `SKILL.md`
   - Add `sidecar_files` for `scripts/`, `references/`, `assets/`, `agents/openai.yaml`, or other text files
   - Add `directories` only when an empty directory is intentionally needed

## Teammate Quality Bar
- The remit must be specific enough that another agent could predict when this teammate should or should not get the work.
- `instructions` should explain ownership, boundaries, default behavior, and readiness expectations.
- Avoid copying the same sentence into `instructions`, `summary`, and the skill body.
- Capabilities should be routing hints, not paragraphs.
- Prefer one strong teammate over several overlapping vague teammates.
- If the role depends on a missing integration or missing local workflow guidance, do not present it as finished.

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
1. Inspect the roster and determine whether `Twitter Researcher` is a durable new role or overlaps an existing researcher.
2. Check whether the workspace has the required X/Twitter integration. If not, ask the user to connect it.
3. Call `teammates_create` with durable instructions and capability tags for the role.
4. Create a teammate-local `twitter-research` skill with:
   - `skill_markdown`
   - any reusable scripts the role needs
   - references such as sourcing policy, evaluation heuristics, and output expectations

## Anti-Patterns
- Do not create a teammate before you understand its stable responsibilities.
- Do not create a teammate from a vague label like `researcher` or `builder` without defining ownership and boundaries.
- Do not ship a specialist teammate that obviously needs an integration but has no path to that integration.
- Do not stop at a one-paragraph teammate profile when the role needs reusable workflow guidance.
- Do not stuff a one-off task brief into teammate creation.
- Do not create a teammate-local skill when a plain instruction block is enough.
- Do not put teammate-local skills under shared workspace `skills/`.
- Do not overload the teammate with multiple overlapping skills when one coherent bundle will do.
