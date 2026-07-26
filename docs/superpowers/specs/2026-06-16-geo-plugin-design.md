# GEO Plugin — Design Spec

**Date:** 2026-06-16
**Branch:** `feat/geo-plugin`
**Status:** Design — pending implementation plan

## Summary

A new workspace **plugin template** for **GEO (Generative Engine Optimization)**: tracking and improving a brand's visibility inside AI answer engines (ChatGPT-style chat, Perplexity-style search, Gemini, etc.).

It mirrors the existing **Research Feed** template (`runtime/api-server/src/plugin-templates.ts`): a fixed object model + dashboard surface, a chat-led onboarding agent, and scheduled agent-authored workflows that write records into the base. A new React dashboard surface is registered in `apps/desktop/src/plugin-surfaces/`.

The build is **phased**: Phase 1 ships visibility tracking end-to-end; Phase 2 adds content audit.

## Goals

- Let a brand track whether AI answer engines mention/recommend it for the prompts that matter, over time and against competitors.
- Report the table-stakes GEO metrics: a normalized visibility score, share-of-voice, rank, sentiment, cited sources, competitor presence.
- Phase 2: audit the brand's own pages for GEO-readiness and produce prioritized, actionable fixes.

## Non-goals (explicit cuts, for leanness)

These are deliberately out of scope. They are the GEO differentiators with the worst ROI for a lean plugin, and several are unproven in the market:

- AI content generation / agentic publishing to improve GEO.
- Revenue/traffic attribution (visibility → leads/revenue).
- Proprietary prompt-volume / "AI keyword" panel data.
- Edge bot-serving (serving AI-optimized HTML to retrieval crawlers).
- Push-notification alerting (v1 uses in-dashboard drift flags only).
- Geo/persona/language segmentation of queries.
- High-fidelity scraping of real AI UIs (see Data Layer below).

## Data layer (the key constraint)

Mainstream GEO tools get fidelity by scraping real AI UIs + SERP (for Google AI Overviews). v1 deliberately takes the **cheap, lower-fidelity path**: the runtime's **native web search** (`native-web-search.ts`) + the workspace's **configured LLM providers**. This approximates ChatGPT-style / Perplexity-style / Gemini answers well; it does **not** faithfully reproduce Google AI Overviews (which needs SERP data).

**Design rule:** the answer-collection step is isolated inside the visibility workflow. The object model, scoring, and dashboard do not depend on how an answer was obtained, so the data layer can later be swapped to a rented scraper (e.g. Bright Data / Apify) or per-engine APIs without touching the schema or UI.

**Engines are config-driven:** the `engine` enum on `geo_visibility` is populated at instantiation from the LLM providers the workspace has configured (same `configureFields` pattern Research Feed uses for category options). No hardcoded engine list.

## Architecture

New plugin template `geo` added via `defineTemplate(...)` in `runtime/api-server/src/plugin-templates.ts` and registered in the template registry. A new dashboard surface kind `geo_visibility_browser` (+ Phase 2 audit surface) is registered in `apps/desktop/src/plugin-surfaces/`.

Lifecycle reuses the SDK as-is: `startOnboarding` → chat collection → `instantiate` (creates base, objects, dashboard, optional workflows) → `resolveOperation` (button-shaped agent actions).

## Data model (base objects)

### `geo_prompt` (Phase 1)
A tracked query the brand wants to win. First-class object so users add/remove prompts over time via an operation.

| field | type | notes |
|---|---|---|
| `text` | string (title) | the prompt/query |
| `topic` | enum | grouping; options seeded from onboarding |
| `intent` | string | optional, e.g. informational/commercial |
| `is_active` | status | `active` / `paused`, default `active` |

Prompts are **hybrid**: the onboarding agent auto-suggests a starter set from the brand + topics; the user edits/approves. (No tool knows the exact prompts real users type — all seeds are synthetic approximations.)

### `geo_visibility` (Phase 1)
One record per *(prompt × engine × run)*.

| field | type | notes |
|---|---|---|
| `prompt` | string | prompt text (denormalized for display) |
| `engine` | enum | options config-driven from workspace providers |
| `run_date` | string/date | when the run happened |
| `brand_mentioned` | status | `yes` / `no` |
| `rank` | number | position the brand appears in the answer, null if absent |
| `sentiment` | enum | `positive` / `neutral` / `negative` |
| `citations` | attachment/JSON | list of cited domains/URLs |
| `competitors_mentioned` | string/JSON | competitor names found |
| `answer_excerpt` | string/attachment | the raw answer text for drill-down |

### `geo_audit_finding` (Phase 2)
Content-audit results for the brand's own pages.

| field | type | notes |
|---|---|---|
| `url` | string (title) | audited page |
| `finding` | string | what's wrong / the observation |
| `category` | enum | citability / structure / schema / freshness / crawler-access |
| `severity` | enum | high / medium / low |
| `recommendation` | string | the actionable fix |
| `status` | status | `open` / `done`, default `open` |

## Derived metrics (computed in the surface, not stored)

- **Visibility score (0–100)** — headline metric: frequency × prominence (rank-weighted) of brand mentions across recent runs.
- **Share of voice** — brand mentions vs. competitor mentions on the same prompts.
- **Drift flag** — per prompt/engine, flag a significant visibility drop vs. the prior run. In-dashboard only (no push notifications in v1).

## Operations (dashboard buttons)

Each spawns a bound agent session seeded with `assistantPrefill`, same mechanism as Research Feed's "Add category".

- **Add tracked prompt** (P1) — chat to add a prompt + topic.
- **Run visibility check now** (P1) — trigger an immediate run across active prompts × engines.
- **Run content audit** (P2) — audit the brand's URL set.

## Workflows (agent-authored, scheduled)

- **Visibility workflow** (P1, cron, e.g. daily/weekly): for each active `geo_prompt` × each configured engine → native web search + LLM → parse brand presence, rank, sentiment, competitors, cited domains → write `geo_visibility` rows.
- **Audit workflow** (P2, on-demand/weekly): fetch brand pages → analyze GEO-readiness (incl. a cheap AI-crawler accessibility check: `robots.txt` / GPTBot/ClaudeBot/PerplexityBot) → write `geo_audit_finding` rows.

## Dashboard surface(s)

**`geo_visibility_browser`** (P1) — React component registered in `plugin-surfaces`:
- Headline **visibility score** + trend over time.
- **Per-engine presence** matrix (prompt × engine, mentioned/rank).
- **Prompt list** with latest status and drift flags.
- **Competitor comparison** (share of voice).
- Drill-down to an individual answer + its citations.

**Audit surface** (P2) — findings grouped by severity/category with recommendation text and an open/done status toggle. Implemented as a second tab/dashboard.

## Onboarding (chat-led)

Collects: plugin name, brand name + domain, competitors, initial tracked prompts (+ topics, auto-suggested then edited), engines to track (from configured providers), check schedule, (P2) audit URL set.

## Build phasing

- **Phase 1 (v1):** visibility tracking end-to-end — `geo_prompt` + `geo_visibility`, visibility workflow, `geo_visibility_browser` surface, onboarding, "Add prompt" + "Run check now" operations, derived score / SoV / drift flag.
- **Phase 2:** content audit — `geo_audit_finding`, audit workflow (incl. crawler-access check), audit surface, "Run audit" operation.

## Testing

- **Template unit tests** (mirror existing plugin-template tests): object/field shape, config-driven `engine`/`topic` enum population, `buildSurface` config shape, `parseInstantiationConfig`, operation resolution.
- **Scoring**: pure-function tests for visibility score, share-of-voice, and drift-flag computation against fixtures.
- **Surface**: basic render test of `geo_visibility_browser` with a representative schema + records.
- Workflow agent behavior validated via the runtime's existing workflow test patterns.

## Open questions

- Exact cron defaults for the visibility workflow (daily vs weekly) — pick a sensible default during implementation; user-overridable in onboarding.
- Whether `citations` / `competitors_mentioned` use the `attachment` field type (like `report_html`) or a JSON string field — confirm against `BaseFieldType` capabilities during planning.
