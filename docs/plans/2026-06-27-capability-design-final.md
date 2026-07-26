# Capability — design (final)

**Date:** 2026-06-27
**Status:** Locked positioning. First implementation pass landed on `feat/capability-redesign`.
**Supersedes:** `2026-06-25-capability-integration-mcp-bridge-design.md` (the MCP-bridge
direction is abandoned — see §2).

### Implementation status (branch `feat/capability-redesign`)

Done:
- **Strip the model** — `agent_prompt` + AGENTS.md injection removed; `version` optional and
  dropped from the catalog DTO/contract; embedded seeds updated. Tests green.
- **Detail UI** — `CapabilityDetailPane` reads as equipment: readable inline skills
  (SKILL.md), Connections, on/off; version badge gone.
- **Empty state** — de-workspaced copy.
- **Seed library (first batch)** — `content-repurposer`, `linkedin-ghostwriter` added next to
  `competitor-watch`, `inbox-triage`.
- **Directory (scoped) + entry** — `CapabilityDirectoryPane` browses the capability catalog
  (cards + search + Add/Added), opened from the `+` menu (Browse / Create), over the existing
  `capabilities.catalog`/`install` Remote API.

Deferred (not yet built):
- **Manual create picker** (§9 option 2) — `+` → Create still routes to the agent-assembled
  flow; the name + pick-skills + pick-integrations form is not built.
- **Plugin importer** (§10).
- **Central Hono catalog + Directory Skills/Connectors tabs** (§12) — only the holaOS-served
  Capabilities directory exists; the cross-repo central catalog and the other two tabs are open.
- **Visual verification** — the readable-skills data flow has been typechecked, not yet run in
  Electron.

---

## 1. What a capability is

> **A capability is a themed, installable bundle that groups a related set of
> `integrations` + `skills`, so the single agent is set up for a domain in one step
> instead of the user assembling the pieces by hand. It is global.**

The value is **convenience + coherence**: "install Sales" brings the right connectors +
the right know-how together, the way ChatGPT's "Sales" app bundles 29 apps + 21 skills, or
Claude's "Carta" plugin bundles its skills + connector. Same shape, same reason — a general
agent gets specialized to a domain by grouping connectors and know-how.

A capability is **passive equipment**. Enabling it makes its integrations' tools and its
skills present; the agent (or the user) then uses them.

## 2. What a capability is NOT (guardrails — these were tried and removed)

- **Not invoked.** The unit of invocation is the **skill** (`/skill-id` in the composer, or
  model auto-selects by description). The user never "calls" a capability. With many skills,
  routing is handled by an **index/router skill** inside the bundle — not by the capability.
- **No prompt.** A capability carries **no `agent_prompt`** and injects nothing into the
  system prompt. Orientation/routing lives in skills (loaded on demand). Injecting capability
  prompt text — now that everything is global — would bloat and cross-wire the one system
  prompt. `agent_prompt` is deleted.
- **No own MCP / no auth bridge.** Tools and auth come from `integrations` (and the apps that
  back them). A capability does not bundle its own MCP server or resolve credentials. The
  PR #130 `mcp.servers[]` field is demoted to a rare edge (a tool nobody has installed yet),
  not the main path.
- **No auto-run.** Scheduling/recurrence is a separate cronjob / app `sync` that *uses* a
  skill — not a property of the capability.
- **No version / marketplace machinery** for v1 (see §9).

## 3. Data model — definition vs state

Mirror how Claude/Codex split it: a portable manifest file holds the **definition**; the
enable/disable **state** lives separately (Claude → settings.json, Codex → config.toml).

| Layer | Where | Holds |
|---|---|---|
| **Definition** | `capability.yaml` (file) | what the capability *is* — name + which skills/integrations it groups. **This is the future-distributable artifact.** |
| **State** | `data.db` record | `enabled` on/off. Never in the manifest. |

Future distribution = share `capability.yaml` + its referenced skill files. We are **not**
building a marketplace now; we just keep the door open by keeping the manifest a file.

## 4. The manifest (`capability.yaml`)

YAML, for stack consistency (our skills' frontmatter and existing capability files are YAML)
and because it is **agent-authored**. Thin — identity + references only.

```yaml
id: competitor-watch
name: Competitor Watch
icon: 🔍
description: Skills + connections for tracking competitor activity on X.   # display only — never injected

integrations:            # references — connectors bring their own tools + auth
  - twitter
skills:                  # references — one may be an index/router skill
  - competitor-analysis

# agent_prompt  — REMOVED
# version       — REMOVED (UI cruft)
# mcp           — omit; edge-case only
```

```jsonc
// data.db — state only, not distributed
{ "capability_id": "competitor-watch", "enabled": true }
```

Built-in capabilities (e.g. `inbox-triage`, `competitor-watch`) ship as seed `capability.yaml`
files in the repo. User/agent-created capabilities are written in the same form — definition
and distribution use one file; state is stored separately.

## 5. Scope — global

Post workspace-removal (single-tenant root), capabilities are a **runtime-global feature**
(peer to memory / cron / integrations / apps), one namespace for the single agent. No
per-workspace sets, no per-project capabilities. Drop all "workspace" framing.

## 6. Invocation

The composer invokes **skills** (`/skill-id`, or auto by description). A capability is only
**enabled/disabled**; enabling it makes its skills available and its integrations connected.
The capability itself is never typed or invoked. In the detail UI, each skill row offers a
"use in chat" affordance that quotes `/skill` into the composer — linking management to use
without making the capability itself invocable.

## 7. UI

Two surfaces (`CapabilitiesPane`, `CapabilityDetailPane` — both exist; evolve them). Lead with
**what it equips**, make skills readable, list the connections, expose on/off. No workspace
wording, no version badge.

**List** — the agent's capabilities (global):
```
🔍 Competitor Watch    ● on    🐦        Track competitor activity on X   >
✍️ LinkedIn Ghostwriter ● on    in        Draft LinkedIn posts in my voice >
💬 Comment Responder    ○ off   🐦 in     Reply to comments in my voice    >
```

**Detail** — job first, parts readable, plumbing folded:
```
🔍 Competitor Watch                         [● on / off]
Skills + connections for tracking competitor activity on X.   ← plain description

Connections   🐦 Twitter (connected)         ← integrations, for trust/control

Skills (1)                                    ← readable, not buried
┌ competitor-analysis · Analyze competitor activity into a digest   ▾ ┐
│  (renders SKILL.md inline via readFilePreview + ReactMarkdown,        │
│   same pattern as SkillsPane)                                          │
└───────────────────────────────────────────────────────────────────────┘
   [use in chat →]   [edit in Skills →]
```

## 8. Changes from current code

- **Delete `agent_prompt`** from `capability.yaml` parsing/install (`workspace-capabilities.ts`)
  and the AGENTS.md injection (`appendAgentPrompt` / `removeAgentPrompt`).
- **Demote `mcp.servers[]`** (PR #130) to an optional edge; it is not the main tool path.
- **Drop `version`** from the manifest and the detail UI badge.
- **Rescope to root** — remove residual workspace framing now that the runtime is single-tenant
  (state record is a global row; "Customize your workspace" copy → the agent's capabilities).
- **Build the readable-skills detail** (inline SKILL.md) and the global list; remove the
  version badge and workspace wording.

## 9. Creation & customization

A capability is a thin grouping of existing skills + integrations, so both paths are cheap and
write the **same `capability.yaml`**:

- **Agent-assembled (primary, matches our philosophy):** user states intent ("set me up to
  watch competitors on X"); the agent picks/creates the skills, identifies the integrations,
  writes the manifest, installs it. The `customize-capability` skill already does this
  (re-install = upsert). "Add LinkedIn to my competitor watch" → agent edits the refs.
- **Manual picker (the originally-requested "manual assembly", now trivial):** a light form —
  name + icon, multi-select skills (from the existing skill list), multi-select integrations
  (from connected) → save. Not a builder; just grouping existing things. Customize = re-open
  and add/remove.

## 10. Skill compatibility & plugin import

- **Skills are directly compatible across us / Claude / Codex** — all use `SKILL.md` + YAML
  frontmatter. Keep our frontmatter aligned so skills are portable both ways; this lets us
  seed from good external skills cheaply.
- **Whole plugins are NOT directly compatible** — Claude/Codex connectors are raw MCP + host-
  driven OAuth (which our runtime does not do), and they bundle commands/agents/hooks we
  deliberately dropped. So provide an **importer**: `Claude/Codex plugin → capability` — take
  its `skills/` directly, map `.mcp.json`/`.app.json` to our integrations (or the edge `mcp`),
  ignore the rest. Keep our thin `capability.yaml` as the native form; do **not** adopt
  `plugin.json` wholesale (it re-imports the complexity we stripped).

## 11. Seed library (launch infrastructure — ships WITH the mechanism)

An empty capability system is a blank canvas; users won't know how to start. The base library
is the product at launch:

- **Curated skills** — author our own social/content/marketing skills; selectively import the
  genuinely cross-domain external ones (writing/research/summarize). Fit > quantity; do not
  cargo-cult Claude's coding-domain catalog.
- **Integrations** — already have (composio providers + HolaApps; reference apps
  `engagement-inbox` / `content-calendar` / `post-analytics` / `messaging-dashboard` show the
  on-domain shapes).
- **Pre-built capabilities** — a handful of recognizable packs, each with **starter prompts**
  (the "what do I type" chips): Competitor Watch, Inbox Triage, Content Repurposer, LinkedIn
  Ghostwriter, Engagement Inbox, Weekly Report.

"Don't know how to play" is answered at three levels: pre-built capabilities (the menu) →
starter prompts (what to type) → agent assembly (state intent, it builds).

## 12. Directory (discovery / distribution entry)

A browsable catalog (like Claude's Directory) — the storefront for the seed library and the
answer to discovery. **Served by the Hono backend** (central, curated, updatable without a
desktop release), consumed renderer-first per CLAUDE.md (`@holaboss/app-sdk/react`), same
pattern as marketplace/templates/skills today.

```
Hono backend (frontend/apps/server)   ← catalog source of truth
  /directory/skills · /connectors · /capabilities  (search / filter / sort + install payload)
        │ @holaboss/app-sdk/react (renderer-first)
        ▼
Desktop  ← Directory pane: Skills / Connectors / Capabilities tabs, search, cards, +add, installed-state
        │ "add" → install into local runtime
        ▼
holaOS runtime  ← install target (materialize skill / write capability.yaml+record / start integration connect)
```

- Three tabs map to our model: **Skills**, **Connectors** (integrations), **Capabilities**.
- **Directory** (browse-to-add, from Hono) is distinct from **`CapabilitiesPane`** (my
  installed, from local runtime). Directory cards show installed/not-installed state.

## 13. Out of scope

- **Distribution / marketplace** — deferred; the file manifest keeps the door open.
- **Triggers / scheduling** — cron / app `sync`, separate.
- **Own-MCP / OAuth bridge** — abandoned (integrations own tools + auth).
- **Per-project capabilities** — capabilities are global only.
