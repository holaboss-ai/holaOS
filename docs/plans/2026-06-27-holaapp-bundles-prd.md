# Product Requirements Document: HolaApp Bundles

**Author**: Holaboss Team
**Date**: 2026-06-27
**Status**: Draft
**Branch**: `feat/hola-app-int`
**Stakeholders**: Desktop, Runtime, Backend (holaapp-backend), Frontend (apps/web)

---

> **Update (2026-06-27) — server-managed pivot.** Install is **server-managed**, not
> desktop-owned: the catalog, per-user install state, and each app's MCP + skills live on
> the server; the desktop is a thin client that triggers install and **applies** the
> server-provided provisioning to the local runtime. The canonical wire spec is
> [`2026-06-27-holaapp-marketplace-api-contract.md`](./2026-06-27-holaapp-marketplace-api-contract.md)
> — treat it as authoritative where it differs from this PRD. The product framing below
> (bundle concept, personalization, invisibility) stands; the **manifest now lives
> server-side**, not as a desktop `holaapp.yaml`. v1 scope: hosted surfaces, MCP-only,
> session auth, poll-based re-sync.

### 1. Executive Summary

A **HolaApp bundle** is one named, installable app for the Holaboss desktop. A user
installs it and it shows up in their HolaApps launcher — exactly like `need-review`
and `gofunds` appear today. Behind that single action, install transparently provisions
the app's **skills** (agent know-how) and **MCP tools** (agent actions) into the
workspace. Those internals are **never surfaced**: the user's entire mental model is
*"I installed an app, and my agent can copilot me in using it."*

A new **first-class manifest** (`holaapp.yaml`) defines the bundle. **A HolaApp is its
own concept with its own install path — it is NOT built on, and does not reuse or modify,
the existing `capability` system.** The install is **server-managed** (see the API contract): the
server owns the catalog, install state, and each app's MCP + skills; the desktop is a thin
client that **applies** the server-provided provisioning to the local runtime — writes MCP
to `workspace.yaml`, delivers the seed skill — never via the `capability` system.

**Personalization is the core differentiation.** The MCP tools are a *shared, fixed*
capability surface; the **skill is a per-user personalization layer**. Two users running
the same app with the same MCP get genuinely different copilots, because each one's skill
encodes how *they* want the agent to behave. The bundle therefore ships a **seed skill**
(a template), which is **copied into the user's workspace on install** and then diverges
— it becomes *theirs*. The app is commodity; the personalized agent is the moat.

### 2. Background & Context

Today a "HolaApp" is assembled from three pieces that live in three places and are
wired by three different mechanisms — **none of which packages all three together**:

| Mechanism | Web surface | Skills | MCP tools | Manifest / source of truth |
|---|---|---|---|---|
| **Web HolaApp** (need-review, gofunds) | ✅ frontend `/apps/<id>`, declared in backend `hola_app_definitions.ts` | ❌ | ✅ but **hardcoded** in desktop `WEB_HOLAAPP_MCP_TOOLS` | backend definition only |
| **Capability** | ❌ | ✅ "bundles one or more skills" | ✅ integrations + `mcp.servers[]` | `capabilities/<id>/capability.yaml` |
| **app-builder app** | ✅ `src/client` UI (local-only) | ❌ | ✅ `mcp{transport,port,tools[]}` | `app.runtime.yaml` |

Two facts make "unify into a bundle" the right move now:

- **`capability` is a separate, untouched concept.** It also bundles skills + integrations,
  but a HolaApp is a distinct, user-facing **app** — not a capability — and is built on its
  own manifest + installer. We deliberately do **not** fold HolaApp into capability or reuse
  its install path; the table above is context for *why a unifying app manifest is needed*,
  not a base to extend.
- **The fragmentation seam is live in this branch.** `WEB_HOLAAPP_MCP_TOOLS` hardcodes
  need-review's 9 MCP tools in desktop code, with a comment admitting it's a STOPGAP:
  *"The general source is the backend `GET /api/v1/apps` returning each app's MCP tool
  names."* That hardcoded list is exactly the metadata a bundle manifest should carry.

The desktop foundation is already in place: web HolaApp surfaces render in native
BrowserViews behind a versioned host bridge (`chat.start` → copilot), MCP attaches
per-workspace via `workspace.yaml`, and the runtime compiles MCP servers + capabilities
at agent run start. (As of this branch, the surface path is also `workspaceId`-free.)

### 3. Objectives & Success Metrics

**Goals**
1. A user can **install / uninstall** a HolaApp in one action; the surface appears in
   the launcher and the agent gains its copilot abilities — with **zero** exposure of
   skills/MCP internals.
2. **One manifest** (`holaapp.yaml`) is the single source of truth for a bundle; the
   three legacy mechanisms map onto it.
3. **Kill the stopgap**: per-app MCP tool lists come from the bundle/backend, not
   hardcoded desktop constants.
4. The agent **reliably** has the installed app's tools + skills on the next run.
5. **Personalization**: the app's skill is a per-user seed that is copied on install and
   diverges with use — the same app behaves differently per user — and a bundle update
   **never clobbers** that personalized instance.

**Non-Goals**
1. **Surfacing skills/MCP to the user** as managed objects — they are deliberately
   invisible plumbing. (This is the core principle, not an omission.)
2. **Touching the `capability` system at all** — HolaApp is fully separate. It does NOT
   use, fold in, or modify `capability_install` / `workspace-capabilities.ts`. The HolaApp
   installer owns its own skill-copy + MCP-attach (the latter reuses the desktop's existing
   `workspace.yaml` MCP write, which is already HolaApp-owned and capability-free).
3. **Multi-tenant / per-workspace install scoping** — single-tenant root today
   (`ROOT_WORKSPACE_ID`).
4. **A third-party app store with billing / community publishing** — Phase 3+.
5. **Per-app sandboxing / a new trust boundary** for v1 (first-party apps only).
6. **Personalizing the MCP layer** — personalization lives in the *skill* (judgment/style)
   only. MCP tools stay shared + deterministic; they are the capability/trust boundary.

**Success Metrics**
| Metric | Current | Target | Measurement |
|---|---|---|---|
| Install → activation (user sends ≥1 agent message in app context within 7d of install) | n/a | ≥ 60% | product analytics |
| Copilot attach reliability (installed app's MCP tools + skills present at next agent run) | unmeasured; stopgap risks drift | ≥ 99% | runtime telemetry on compiled MCP/capability set |
| Time-to-first agent action using the app's MCP tool | n/a | median < 3 min from install | trace on first successful tool call |
| Hardcoded per-app allowlists in desktop code | 1 (`WEB_HOLAAPP_MCP_TOOLS`) | **0** | code audit |
| Legacy bundling mechanisms | 3 | 1 manifest (others map onto it) | architecture review |
| Internals-leak incidents (skill/MCP shown in install/launcher UI) | n/a | **0** | design QA gate |
| First-party apps installable via the unified manifest | 0 | ≥ 3 (need-review, gofunds, + 1) | release checklist |

### 4. Target Users & Segments

- **Primary — the end user / operator** (the person running the desktop app). Mental
  model: *apps I install + an agent that copilots me*. Never sees a "skill" or an "MCP
  server." Wants capability without configuration.
- **Secondary — the app author / builder** (first-party today, third-party later).
  Wants one manifest to declare surface + copilot, not three registration points across
  three repos. Served by the app-builder SDK, which should emit a `holaapp.yaml`.
- **Internal — runtime/desktop engineers** who currently maintain the hardcoded
  allowlist + scattered definitions; the unified manifest removes that maintenance tax.

### 5. User Stories & Requirements

**P0 — Must Have**
| # | User Story | Acceptance Criteria |
|---|---|---|
| 1 | As a user, I can browse available HolaApps and **install** one, so it appears in my launcher. | Install action adds the app to the HolaApps launcher (same UI as today); no skill/MCP wording shown anywhere in the flow. |
| 2 | As a user, on install the system **transparently provisions** the app's MCP + skills so my agent can use them. | The HolaApp installer writes the app's MCP server(s) to `workspace.yaml` and **copies** its seed skill(s) into `skills/<id>/` (so they can personalize) — its own path, not `capability_install`; both present at the next agent run; **none surfaced in UI**. |
| 3 | As a user, I can open an installed app and have my **agent copilot** me with its live tools. | Opening the surface + Discuss/`chat.start` yields an agent that can call the app's MCP tools (e.g. `get_record`, `approve_record`) against live data, not just a snapshot. |
| 4 | As a user, I can **uninstall** an app and it fully goes away. | Uninstall removes the launcher entry, the `workspace.yaml` MCP entry, and the installed skills/capability; next agent run no longer has them. |
| 5 | As an author/engineer, a bundle is defined by **one `holaapp.yaml`**; need-review is migrated off the hardcoded list. | `WEB_HOLAAPP_MCP_TOOLS` is removed; need-review's tools come from its manifest (served by backend `GET /api/v1/apps`). |

**P1 — Should Have**
| # | User Story | Acceptance Criteria |
|---|---|---|
| 6 | As a user, an installed app stays **up to date** without losing how my agent learned to work. | Re-install/refresh re-reads the manifest idempotently (no duplicates) for surface + MCP; for the skill it does a **3-way merge** (base seed vs new seed vs my personalized instance) — a bundle update **never clobbers** personalization. |
| 7 | As a user, when an app needs a connection (e.g. Slack), I get a **one-time connect** step. | If the manifest declares a required `integration`, install surfaces a single "Connect <provider>" prompt; `needs_connection` is resolved before the app is "ready". |
| 8 | As an author, **local (app-builder) apps** install through the same manifest. | `surface.type: local` with `lifecycle`/`healthchecks`/`port` installs + runs identically to hosted apps from the user's POV. |
| 9 | As a user, opening an installed app, the agent **proactively offers** to help. | Surface shows a copilot affordance / the agent greets with app-aware guidance (driven by `agent_prompt`). |

**P2 — Nice to Have / Future**
| # | User Story | Acceptance Criteria |
|---|---|---|
| 10 | As an author, the **app-builder SDK emits a `holaapp.yaml`**. | Scaffolding a new app produces a valid bundle manifest end-to-end. |
| 11 | As a user, I can install **third-party / community** apps with a clear trust prompt. | Signed bundles + a per-app permission summary ("this app's agent can read & approve records"). |
| 12 | As an org, bundles are **versioned with rollback** in a registry. | Pinned versions; rollback to a prior bundle version. |

### 6. Solution Overview

**The unified manifest (`holaapp.yaml`)** — a superset of `capability.yaml` and
`app.runtime.yaml`, split into *what the user sees* and *the hidden copilot layer*:

```yaml
id: need-review                 # stable id — matches launcher entry + /apps/<id>
name: Need Review
description: Review and approve agent-produced records before they ship.
version: 0.1.0
icon: ./icon.png                # launcher favicon

# ── what the user SEES ───────────────────────────────────────────
surface:
  type: hosted                  # hosted | local | none
  path: /apps/need-review       # (hosted) frontend route under WEB_APP_BASE_URL
  # local variant (app-builder dashboard apps) instead provides:
  # type: local
  # lifecycle:  { setup: "bun install", start: "bun run server.ts", stop: "…" }
  # port: 3099
  # healthchecks: { http: { path: /health, timeout_s: 120 } }

# ── the hidden COPILOT layer (NEVER surfaced to the user) ─────────
copilot:
  skills:
    - seed: review-records      # SEED skill — COPIED into the user's workspace on
                                # install, then personalized & diverges (NOT a shared ref)
  mcp:
    servers:
      - id: need-review
        type: remote            # remote (hosted) | local (subprocess)
        url: ${MCP_BASE}/mcp/need-review/mcp
        auth: session           # session | { headers: … } | { env: … }
        tools:                  # the allowlist — REPLACES WEB_HOLAAPP_MCP_TOOLS
          [list_records, get_record, search_records, get_record_provenance,
           list_objects, approve_record, request_revision, reject_record, edit_record]
  agent_prompt: |
    When the user is in Need Review, help them triage and approve pending records…

# ── connections the app needs (optional) ─────────────────────────
integration:
  provider: null                # e.g. slack; null for session-auth apps
  credential_source: platform   # platform | user
  required: false
```

**Install pipeline (reuses existing machinery):**
1. **Catalog** lists installable apps from backend `GET /api/v1/apps`, now returning
   manifest metadata (surface + tool names) — *this is what removes the hardcoded list*.
2. **Install** = `POST /api/v1/apps/{id}/install`: the **server** provisions and records
   install state, returning `provisioning.mcp[]` (+ `skills[]`, v1: none). The **desktop
   applies** it to the local runtime — writes `provisioning.mcp[]` into `workspace.yaml`
   `mcp_registry` (+ allowlist) via the existing `attachWebHolaAppMcp` path, registers the
   surface in the launcher, and delivers any seed skill into `skills/<id>/`. No part
   touches the capability system. A delivered skill is the user's to personalize; its
   `version` is the **merge base** for updates. Wire shape: see the API contract.
3. **Runtime** compiles MCP servers + capabilities at run start (existing behavior) → the
   agent has the tools + skills on the next message.
4. **Surface** opens in the existing BrowserView host bridge; Discuss/`chat.start` is the copilot.
5. **Uninstall** reverses 2.

**Where surfaces come from (HolaApp's own two surface types — capability is NOT one of them):**
- **Hosted web HolaApp** (need-review, gofunds) → `surface.type: hosted` + `copilot.mcp` (remote). Replaces `WEB_HOLAAPP_MCP_TOOLS`.
- **Local app-builder app** → `surface.type: local` (lifecycle/healthchecks/port) + `copilot.mcp` (local).

`capability.yaml` and `capability_install` are intentionally **out of scope** — they stay as
their own separate system; the HolaApp manifest is a parallel, independent format.

**Personalization & skill divergence (the core differentiation).** Layers belong to
different owners, and only one personalizes:

| Layer | Belongs to | Per-user? | Why |
|---|---|---|---|
| Surface (web UI) | the app | no | shared product |
| MCP tools | the app | no | shared, deterministic — the capability/trust boundary |
| **Skill** | **the user** | **yes** | encodes *how this user wants the agent to behave* |

- **Seed, not shared ref.** The manifest's `copilot.skills` are **seeds**. Capability's
  default is `ref` (shared, never diverges) — the *opposite* of what personalization needs.
  Install must **copy** the seed into the user's workspace so their edits don't touch the
  shared template. The substrate already supports this: skills are workspace-local and
  edited in place (`customize-capability`), and the runtime is single-tenant (one workspace
  = one user), so the per-user skill instance is the natural unit.
- **Update = 3-way merge.** Record the installed seed + version as the **merge base**. A
  bundle update is `merge(base, new-seed, personalized-instance)` — never an overwrite.
  This is the one thing that silently breaks the model if install is treated as "re-read
  and replace."
- **Invisibility holds.** The user never sees "a skill"; they just notice their agent
  *gets them*. Personalization compounds with use → switching cost → moat.

### 7. Open Questions

| # | Question | Owner | Notes |
|---|---|---|---|
| 1 | **Trust model**: installing grants the agent new tools/skills. First-party = implicit trust; do we need *any* consent surface in v1, or defer all of it to P2 third-party? | Security / PM | Tension with the "nothing surfaced" principle — a consent step is itself a surfaced internal. |
| 2 | **Where does the catalog live?** Reuse the Marketplace overlay (currently workspace templates only; Apps sub-tab retired) or a new HolaApps store? | Design / Desktop | Affects IA and discovery. |
| 3 | **Skill delivery for hosted apps**: are `copilot.skills` embedded in the bundle, pulled from backend, or `ref` to workspace skills? Capability uses `ref`. | Runtime / Backend | Hosted apps have no local workspace dir to author skills into. |
| 4 | **Uninstall of shared deps**: if two apps `ref` the same skill or `provider`, do we ref-count before removal? | Runtime | Avoid yanking a dep another app needs. |
| 5 | **Does install ever run local code for a *hosted* app?** Most web HolaApps use remote MCP; app-builder apps run a local subprocess. Keep these strictly separate via `surface.type`? | Architecture | Determines packaging + security review. |
| 6 | **Backend ownership of the manifest**: does `holaapp.yaml` live with `hola_app_definitions.ts` (backend) and get served by `/api/v1/apps`, or is it a separate artifact? | Backend | Determines source of truth + deploy path. |
| 7 | **Personalization: learns vs configures.** Does the skill personalize from *explicit* user corrections during copilot, from *observed* behavior (it watches what you approve), or both? | PM / Runtime | The single biggest fork — decides whether the skill is configured or self-evolving, and what data feeds it. |

### 8. Timeline & Phasing

- **Phase 0 — Foundation (this branch, done/near-done).** Web HolaApp surface + host
  bridge + per-app MCP attach exist; surface path is `workspaceId`-free. No new work
  required to start Phase 1.
- **Phase 1 — Hosted bundles MVP (P0).** Define `holaapp.yaml`; backend `GET /api/v1/apps`
  returns manifest (surface + tool names); desktop install/uninstall for **hosted** apps;
  remove `WEB_HOLAAPP_MCP_TOOLS`; migrate need-review + gofunds. *Exit: a user can install,
  copilot, and uninstall need-review with no hardcoded tool list anywhere.*
- **Phase 2 — Connections + local apps (P1).** `integration` connect flow
  (`needs_connection`); `surface.type: local` so app-builder apps install via the same
  manifest; proactive copilot affordance.
- **Phase 3 — Authoring + ecosystem (P2).** app-builder SDK emits `holaapp.yaml`;
  third-party bundles + signing + per-app permission summary; versioned registry + rollback.

---

#### Dependencies & risks
- **Backend** must serve manifest metadata via `/api/v1/apps` (kills the stopgap) — the
  desktop install pipeline blocks on this.
- **Idempotency**: install/uninstall must be safe to repeat (model on `capability_install`).
- **Principle risk**: any required connect/consent step is a *surfaced internal*; keep it
  framed as the app's own setup, never as "skills/MCP."
