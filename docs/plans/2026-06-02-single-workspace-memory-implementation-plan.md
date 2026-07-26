---
title: Single workspace memory implementation plan
date: 2026-06-02
status: draft
related:
  - 2026-05-20-memory-redesign-prd.md
  - 2026-05-24-memory-architecture-redesign-implementation-plan.md
  - 2026-05-25-memory-rag-implementation-plan.md
  - ../remote-workspace/05-engineering-review.md
  - ../memory-arch/gmail.md
  - ../memory-arch/github.md
  - ../memory-arch/notion.md
---

# Single workspace memory implementation plan

## Goal

Replace the current split memory topology with a single workspace-owned durable memory graph.

The target outcome is:

- every durable memory item belongs to exactly one workspace
- there is no separate `interaction` forest and `integration` forest as product architecture
- onboarding context fetch remains, but only as a bootstrap ingestion path
- day-to-day integration tool use also feeds the same workspace memory graph
- the 30-minute integration autofetch cron is removed
- account-derived memories remain in the workspace graph until changed by non-account-scoped memory actions
- the account-scoped integration-memory removal operation is removed

## Locked decisions

The following decisions are assumed fixed for this plan:

- keep the current memory operations and user-facing behavior as much as possible, except for removing account-scoped integration-memory deletion
- do not introduce a user-level shared memory corpus in this phase
- do not keep a separate durable integration-memory forest
- use a new unified semantic memory category named `workspace`
- store hidden provenance as separate evidence-reference records linked from workspace memory nodes
- keep onboarding context fetch
- remove the manual context-fetch re-trigger operation
- remove periodic background context refetch
- treat integration-tool results during workspace interaction as an ingestion source
- scope execution-time account-correlation work in this phase to the agent invocation path only
- make invocation-time resolution of a unified `account_namespace` on the agent path the first concrete implementation milestone for account attribution
- use per-turn gated ingestion for day-to-day turn-derived memory updates
- keep onboarding context fetch immediate
- keep any provenance required for backend operations internal rather than user-facing
- keep old account-derived memories when a workspace switches provider accounts
- remove the operation that deletes memory per integration account / connection
- use provider-specific curated bootstrap ingestion for onboarding context fetch rather than full raw-provider backfill
- organize the unified workspace graph under fixed top-level sections rather than free-form LLM top-level structure

## Current state

The repo currently has a real split between interaction memory and integration memory.

### Durable storage split

- interaction semantic memory is workspace-scoped
- integration semantic memory is effectively global / control-plane scoped
- generic semantic memory APIs route `interaction` to the workspace runtime DB and `integration` to the control-plane DB in `runtime/state-store/src/store.ts`
- the category type is currently hard-coded as `"interaction" | "integration"` in `runtime/state-store/src/store.ts`

### Runtime split

- `runtime/api-server/src/memory.ts` rebuilds interaction and integration trees separately
- `runtime/api-server/src/workspace-memory.ts` retrieves interaction and integration memory separately, then merges the results
- `runtime/api-server/src/memory-browser.ts` renders separate interaction and integration forests
- `runtime/api-server/src/turn-memory-writeback.ts` only writes interaction-derived durable memory today
- `runtime/api-server/src/integration-context-fetch.ts` writes integration-derived durable memory through the integration-memory path

### Integration fetch behavior today

- onboarding and manual context fetch run through `runtime/api-server/src/integration-context-fetch-manager.ts`
- a periodic worker in `runtime/api-server/src/integration-context-autofetch-worker.ts` retriggers fetch every 30 minutes for eligible connections
- new active connections also auto-trigger context fetch in `runtime/api-server/src/app.ts`

### Account attribution today

- onboarding / manual context fetch is account-precise because it is explicitly started with `connectionId`
- generic persisted MCP `tool_call` events do not reliably preserve `connection_id`
- the runtime does resolve a concrete account at execution time through bindings, defaults, and Composio account selection

This last point is important. The single-graph architecture should attribute integration-derived evidence from the live execution path, not from replaying generic stored `tool_call` events later.

For this phase, the relevant live execution path is the agent invocation path. Native app / runtime-bound integration execution can stay out of scope until the unified workspace-memory graph is already working for agent-driven tool use.

## Desired end state

The durable memory architecture should look like this:

- one workspace-owned durable memory graph
- one shared semantic writer / rebuild path
- one shared retrieval path
- one shared browser / inspection path
- multiple ingestion sources feeding the same graph

The ingestion sources should be:

- interaction-derived memory from normal turn writeback
- onboarding context fetch
- day-to-day integration tool results
- existing manual or proposal-driven memory writes

The ownership rule should be simple:

- if it is retrievable as durable memory, it belongs to a workspace

The source rule should also be simple:

- source affects evidence attribution, refreshability, and internal maintenance
- source does not decide which forest or storage domain the memory belongs to

The account-switching rule should be:

- switching the default account for a provider does not remove prior account-derived memories
- older account-derived memories remain in the workspace graph
- the system should not provide a dedicated account-scoped integration-memory removal operation in the new architecture

The ingestion cadence should be:

- onboarding context fetch: immediate
- day-to-day turn-derived integration evidence: evaluate on every completed turn and persist only when the turn produced meaningful memory-worthy evidence

The onboarding bootstrap policy should be:

- provider-specific and curated
- not a blind ingest of everything the current fetchers can see
- onboarding is the only context-fetch entrypoint in the target design

The graph organization policy should be:

- fixed top-level sections
- the fixed top-level section set is:
  - `Goals`
  - `Projects`
  - `Tasks`
  - `Decisions`
  - `People`
  - `Organizations`
  - `Systems`
  - `Artifacts`
  - `Knowledge`
  - `Processes`
  - `Issues & Risks`
  - `Preferences & Rules`
- top-level sections are sibling roots under one workspace root
- each node has one primary containment home in the tree
- relatedness across sections is expressed through relation edges rather than node duplication
- lower levels may still be organized dynamically under those fixed top-level anchors
- relation typing should be LLM-extensible rather than restricted to a tiny fixed vocabulary

## Non-goals

This plan does not try to:

- broadly redesign the current memory operations surface beyond removing account-scoped integration-memory deletion
- introduce a global user-level memory corpus
- redesign every provider fetcher from scratch
- remove all hidden provenance from the backend
- solve every future refresh policy in this phase
- expand provider coverage beyond current integration fetch support
- guarantee identical bootstrap ingestion volume across providers
- preserve the manual context-fetch re-trigger operation

## Key design constraints

### 1. One graph does not mean no provenance

The product model should stop exposing `interaction memory` vs `integration memory` as separate durable systems.

The backend still needs enough hidden provenance to support current and future operations.

At minimum, integration-derived evidence refs need:

- provider id
- stable account identity when available, such as handle or email
- `connectionId` when available
- provider-side object ids where available
- source turn / input linkage
- timestamps for observation and refresh

Without this, the unified graph becomes hard to maintain when:

- a workspace switches between multiple accounts for the same provider
- a user reauths and the provider-side connected-account id changes
- a later maintenance flow needs to understand which evidence came from which account even though account-scoped deletion is no longer exposed

### 2. Do not rely on replaying generic tool-call history

The persisted `tool_call` payload is useful for transcript and debugging, but it is not the right source of truth for account attribution.

The runtime should instead capture integration execution context at the point where the account binding is already resolved and pass that directly into memory ingestion.

For the agent path, the first concrete subproblem is:

- resolve a unified `account_namespace` during invocation for the selected integration account
- derive that namespace from the best available human-readable identity on the connection, such as handle or email
- use lower-level execution ids such as `connectedAccountId` or `connectionId` mainly as lookup / fallback plumbing rather than the primary memory-facing namespace

### 3. Provenance should live in separate evidence-reference records

The unified workspace graph should keep semantic meaning and source attribution separate.

The preferred model is:

- workspace memory nodes store semantic memory
- workspace memory edges store graph structure
- separate evidence-reference records store origin details

This is preferred over storing source attribution directly on semantic node rows because:

- one node may be supported by multiple sources
- source refs may need to be refreshed, cleared, or replaced independently of the semantic node
- account attribution and source-object linkage stay operational rather than shaping the graph schema
- the semantic graph remains about meaning rather than transport details

At minimum, an evidence-reference record should be able to capture:

- target memory node id
- evidence kind such as interaction turn, tool result, context fetch, or imported record
- provider id
- stable account identity when available
- `connectionId` when available
- provider-side object ids when available
- source turn / input ids
- observed and refreshed timestamps

### 4. Existing memory operations mostly stay

This migration should preserve current operations and behaviors as closely as possible.

The explicit exception is:

- remove the account-scoped integration-memory deletion operation from the product surface

The project is:

- a storage-topology and ingestion-topology rewrite

It is not:

- a broad redesign of memory product semantics

### 5. Turn-derived integration ingestion should be per-turn but gated

The current durable memory writeback path is not a strict per-turn immediate persist path.

It is triggered from completed-turn flow, but durable extraction currently persists in batches.

The target design should move day-to-day turn-derived ingestion toward:

- evaluating ingestion eligibility on every completed turn
- persisting only when the turn produced meaningful memory-worthy evidence
- avoiding unconditional writes just because a turn completed
- keeping context-fetch ingestion immediate because it is already an explicit standalone flow

This is preferred over strict batch-only behavior because:

- the memory graph becomes fresher
- integration-tool results from the latest turn become available sooner
- the model and product get a simpler mental model than waiting for arbitrary batch completion

This is preferred over unconditional per-turn writes because:

- it reduces low-value graph churn
- it avoids persisting weak or noisy turns by default
- it keeps write pressure bounded by evidence quality rather than raw turn count

### 6. Top-level graph structure should be fixed

The unified workspace graph should not allow the LLM to invent arbitrary top-level roots over time.

The top level should instead be a fixed section set owned by the product architecture.

This is preferred because:

- top-level drift is hard to debug and hard to migrate
- retrieval and browsing become more stable
- onboarding fetch and day-to-day turn ingestion can converge into the same durable topology
- later ranking and section-specific policies become easier to implement

The exact section list is still a design decision, but the structure rule is now fixed:

- fixed top-level sections
- sibling top-level sections under one workspace root
- one primary containment home per node
- dynamic organization only beneath those sections

The fixed top-level section set for the first implementation is:

- `Goals`
- `Projects`
- `Tasks`
- `Decisions`
- `People`
- `Organizations`
- `Systems`
- `Artifacts`
- `Knowledge`
- `Processes`
- `Issues & Risks`
- `Preferences & Rules`

### 7. Relatedness should use relation edges, not duplicate containment

The unified workspace graph should separate:

- containment, which determines where a node primarily lives
- relations, which determine how nodes across sections connect

The containment rule should be:

- each node has one canonical primary home in the tree
- the same conceptual node should not be duplicated across multiple top-level sections just to express relatedness

The relation rule should be:

- cross-section relatedness is expressed through relation edges
- relation vocabulary can be LLM-extensible
- the system may later normalize or rank relation labels, but it should not start with a tiny hard-coded vocabulary

This is preferred because:

- containment remains stable and navigable
- retrieval can traverse graph relations without forcing node duplication
- the LLM can capture nuanced relationships that do not fit a narrow predefined list

## Recommended rollout strategy

Use an incremental migration, not a big-bang rewrite.

The practical rules should be:

- add the new workspace-owned semantic category `workspace` first
- build the unified writer and readers on that new category
- migrate ingestion flows one by one
- dual-read or backfill where necessary
- stop writing to legacy interaction / integration semantic structures only after unified reads are proven
- delete legacy integration-tree ownership only at the end

## Phase 0: Lock the contract

Files:

- `docs/plans/2026-06-02-single-workspace-memory-implementation-plan.md`
- `docs/plans/2026-05-20-memory-redesign-prd.md`
- `docs/plans/2026-05-24-memory-architecture-redesign-implementation-plan.md`
- `docs/plans/2026-05-25-memory-rag-implementation-plan.md`

Work:

- record that durable memory ownership is now always workspace-level
- record that context fetch remains, but only as bootstrap ingestion
- record that manual context-fetch re-trigger is removed
- record that periodic integration autofetch is removed
- record that day-to-day integration tool use is an ingestion source
- record that account-scoped integration-memory deletion is intentionally removed in this phase
- record that hidden provenance remains allowed and required for backend maintenance
- record that account attribution should come from execution-time resolution, not replayed tool-call envelopes
- record that account switching does not implicitly remove older account-derived memories

Exit criteria:

- product and backend agree on the ownership model
- product and backend agree that the project is architectural, not a user-facing memory operation redesign
- downstream implementation can proceed without reopening the core topology debate

## Phase 1: Add a unified workspace semantic category

Files:

- `runtime/state-store/src/store.ts`
- `runtime/state-store/src/store.test.ts`
- any state-store migration helpers required by schema initialization

Work:

- extend `SemanticMemoryCategory` to include the new workspace-owned category `workspace`
- route the new category to the workspace runtime DB in `resolveSemanticMemoryScope`
- keep existing `interaction` and `integration` categories working during migration
- add or adapt helper APIs so unified graph code does not need to know whether the source was formerly interaction or integration
- add storage support for separate evidence-reference records linked from workspace memory nodes

Important note:

- the generic semantic-memory tables already support `workspace_id` plus arbitrary `category TEXT`
- this phase is mainly a code-routing and API-shape change, not a risky physical-schema redesign

Exit criteria:

- the state store can persist semantic nodes, edges, relations, search docs, and embeddings for a workspace-owned unified category
- no runtime read path depends on it yet

## Phase 2: Introduce one shared workspace-memory writer

Files:

- new helper module, likely `runtime/api-server/src/workspace-memory-writer.ts`
- `runtime/api-server/src/interaction-memory.ts`
- `runtime/api-server/src/integration-memory.ts`
- `runtime/api-server/src/memory.ts`

Work:

- introduce one shared runtime writer for the unified workspace graph
- define one shared node/edge/relation vocabulary for the unified graph
- define one evidence-reference vocabulary for hidden provenance
- move semantic-node creation, edge replacement, relation replacement, markdown-body generation, and embedding updates behind one shared writer
- keep source-specific normalization outside the writer
- keep legacy interaction and integration-specific builders available during transition

Recommendation:

- the writer should accept normalized graph mutations plus evidence-reference mutations
- it should not contain provider-specific fetch logic

Exit criteria:

- the runtime has one canonical way to write workspace semantic memory
- source-specific code can call into it without needing separate semantic forests

## Phase 3: Rewire onboarding context fetch into workspace graph ingestion

Files:

- `runtime/api-server/src/integration-context-fetch.ts`
- `runtime/api-server/src/integration-context-fetch-manager.ts`
- `runtime/api-server/src/integration-memory.ts`
- unified writer module from Phase 2

Work:

- keep onboarding-triggered fetch orchestration only as needed for the onboarding flow
- keep explicit `connectionId`-based fetch starts
- change provider fetchers so they no longer write into a separate integration semantic forest
- normalize fetched provider objects into evidence-bearing workspace memory mutations
- define a curated bootstrap policy per provider rather than ingesting every currently available fetch result
- write those mutations into the unified workspace graph
- write connection/account/source-object attribution as linked evidence refs
- keep this flow immediate rather than batched
- remove the standalone manual context-fetch trigger from the target surface

Important constraint:

- provider fetchers should continue using explicit connection/account identity from the fetch start
- do not replace that with inference from current defaults
- bootstrap fetch should prefer high-signal provider-specific coverage over maximum object-count coverage

Exit criteria:

- onboarding context fetch writes into the unified workspace graph
- no new integration semantic nodes are required for a separate global integration forest

## Phase 4: Remove integration autofetch

Files:

- `runtime/api-server/src/integration-context-autofetch-worker.ts`
- `runtime/api-server/src/integration-context-autofetch-worker.test.ts`
- `runtime/api-server/src/app.ts`
- any startup wiring or holder types that exist only for this worker

Work:

- stop starting the autofetch worker on app ready
- remove the wakeup path triggered when a connection becomes active
- remove periodic due-connection scanning and scheduling
- remove any now-unused connection fields that only support the recurring worker, if they are truly dead after the migration

Important constraint:

- do not remove onboarding fetch
- do not remove fetch-status reporting if it is still useful for explicit runs

Exit criteria:

- no 30-minute background integration refetch remains
- no automatic post-connect context fetch remains unless explicitly triggered by onboarding flow

## Phase 5: Add execution-time integration ingestion for day-to-day tool use

Files:

- `runtime/api-server/src/composio-mcp-host.ts`
- `runtime/api-server/src/composio-mcp-manager.ts`
- `runtime/api-server/src/composio-tool-registry.ts`
- `runtime/api-server/src/ts-runner.ts`
- `runtime/api-server/src/claimed-input-executor.ts`
- `runtime/api-server/src/turn-memory-writeback.ts`
- any helper module needed for per-turn integration execution context

Work:

- scope this phase to the agent invocation path rather than native app / broker-backed integration execution
- first, make invocation-time resolution of `account_namespace` reliable for the selected agent-path integration account
- capture the resolved execution context at the point where agent MCP tool execution already knows which Composio account will execute
- treat the Composio MCP tool catalog / call handler as the canonical agent-path capture surface because each tool entry already carries a fixed `connected_account_id`
- enrich that execution context with a unified `account_namespace` plus supporting ids such as `connectionId`
- treat `account_namespace` as the preferred account namespace for later memory evidence refs
- do not block memory ingestion when human-readable namespace enrichment is unavailable; the execution identity should still be usable with provider plus connected-account identity as fallback
- attach this execution context to the turn’s memory-ingestion pipeline
- persist that execution context as evidence refs on the resulting workspace memory nodes
- do not rely on later replay of generic stored `tool_call` events to recover the account
- feed this path into a per-turn gated ingestion path rather than per-tool-call immediate persistence

Implementation note:

- for the agent path, some account selection is effectively done at MCP-host bootstrap time for a workspace/toolkit, not only inside the final event payload
- the plan should treat that bootstrap selection as part of execution-time binding
- the direct native app / broker-backed path can be revisited later if the product needs workspace memory ingestion there too

Recommendation:

- add a dedicated internal structure for per-turn integration evidence context rather than overloading `ToolCallSummaryEntry` alone
- `ToolCallSummaryEntry` in `claimed-input-executor.ts` is currently too small to be the long-term source of memory attribution

Exit criteria:

- agent-path integration invocation can resolve and surface `account_namespace` for the selected account when the underlying connection data supports it
- live integration use during a turn can feed account-attributed evidence into memory ingestion
- the system no longer depends on generic event payload archaeology for account resolution

## Phase 6: Unify turn durable writeback

Files:

- `runtime/api-server/src/turn-memory-writeback.ts`
- `runtime/api-server/src/claimed-input-executor.ts`
- unified writer module from Phase 2

Work:

- keep the current interaction-derived candidate extraction flow
- extend durable writeback so integration-derived evidence from the same turn can also update the unified workspace graph
- move turn-derived persistence toward per-turn gated writeback rather than strict batch-only persistence
- gate persistence on meaningful memory-worthy evidence rather than unconditional post-turn writes
- keep source/evidence attribution hidden in backend state

Important constraint:

- this phase should not force a redesign of the current LLM extraction prompts unless necessary
- the main change is where durable output lands, not the higher-level extraction product

Exit criteria:

- interaction-derived and integration-derived memory updates both terminate in the same workspace graph
- the turn writeback path becomes the canonical daily-update path for workspace memory

## Phase 7: Move retrieval, browser, and sync to the unified graph

Files:

- `runtime/api-server/src/workspace-memory.ts`
- `runtime/api-server/src/memory-hybrid-retrieval.ts`
- `runtime/api-server/src/memory-browser.ts`
- `runtime/api-server/src/memory.ts`
- any tests covering retrieval and browser behavior

Work:

- stop splitting retrieval into separate interaction and integration fetch passes
- move vector search, lexical search, graph expansion, and reranking to the unified workspace graph
- update retrieval evidence structures so they no longer require the old category split as a first-class product concept
- update the memory browser so it renders one workspace memory graph instead of separate interaction and integration forests
- change `memory.sync` to rebuild one workspace graph instead of calling separate interaction and integration rebuilds

Recommendation:

- preserve hidden source labels in retrieval evidence where they help freshness and auditability
- avoid exposing the old architectural split in the main retrieval model

Exit criteria:

- retrieval reads from one workspace graph
- browser and graph inspection read from one workspace graph
- sync/rebuild reads and writes one workspace graph

## Phase 8: Backfill and migration

Files:

- new migration helper, likely under `runtime/api-server/src/` or `runtime/state-store/src/`
- `runtime/api-server/src/memory.ts`
- `runtime/api-server/src/workspace-memory.ts`
- any admin / test helpers required

Work:

- backfill current interaction semantic memory into the new workspace category
- backfill current workspace-visible integration semantic memory into the new workspace category
- preserve evidence/provenance where possible during backfill by emitting linked evidence refs
- add a per-workspace migration marker to prevent repeat backfills
- dual-read or fallback-read during the migration window if required

Important constraint:

- do not attempt to preserve the old forest shape exactly
- preserve durable content and operational attribution, then let the unified graph own final organization

Exit criteria:

- existing workspaces have a populated unified workspace graph
- unified retrieval and browser paths can operate without depending on legacy semantic reads for migrated workspaces

## Phase 9: Remove legacy split paths

Files:

- `runtime/api-server/src/integration-memory.ts`
- `runtime/api-server/src/interaction-memory.ts`
- `runtime/api-server/src/workspace-memory.ts`
- `runtime/api-server/src/memory-browser.ts`
- `runtime/state-store/src/store.ts`
- legacy tests that only validate the split topology

Work:

- stop writing to legacy interaction/integration semantic categories
- remove dead code that only exists to sustain separate forests
- simplify retrieval and browser code that still branches on legacy categories
- remove control-plane integration semantic storage if it is no longer needed
- remove the account-scoped integration-memory deletion endpoint and any runtime path that depends on separate integration-memory ownership

Exit criteria:

- the runtime no longer depends on separate interaction and integration semantic forests
- the only durable memory topology is the workspace-owned graph

## Risks

### Account switching risk

Risk:

- the same workspace may use different accounts of the same provider over time

Mitigation:

- capture execution-time account attribution
- preserve `connectionId` and stable account identity internally
- do not collapse provider identity and account identity into one field

### Reauth drift risk

Risk:

- provider-side connected-account ids can change on reauth even when the real account is the same

Mitigation:

- prefer Holaboss `connectionId` when available
- also preserve stable account identity such as handle or email

### Migration parity risk

Risk:

- retrieval or browser behavior may regress during the shift from dual-forest reads to unified reads

Mitigation:

- backfill first
- compare old and new reads during rollout
- switch write paths before fully deleting legacy read fallbacks

### Scope creep risk

Risk:

- this project can accidentally become a redesign of memory operations or provider coverage

Mitigation:

- keep the stated non-goals fixed
- treat this as an ownership-topology and ingestion-topology migration

## Validation strategy

Validation should cover:

- onboarding fetch populates the unified workspace graph
- no background integration fetch runs after startup or connection activation
- no manual context-fetch re-trigger remains in the target architecture
- interaction-derived turn writeback still works
- integration-tool-derived day-to-day ingestion works with correct account attribution
- retrieval parity for migrated workspaces
- browser / graph inspection parity for migrated workspaces
- workspace switching between multiple same-provider accounts does not merge evidence incorrectly
- reauth preserves account continuity where the runtime already dedupes by stable identity
- provider-specific bootstrap policies admit the intended curated subset rather than defaulting back to full-current fetch volume

Recommended tests:

- state-store tests for the new workspace semantic category
- onboarding/context-fetch tests proving bootstrap fetch still works while autofetch and manual re-trigger are gone
- turn writeback tests for mixed interaction plus integration evidence
- retrieval tests showing unified reads can cover what old interaction plus integration reads covered
- browser tests showing a single workspace graph view

## Recommended implementation order

1. lock this plan and the architecture vocabulary
2. add the unified workspace semantic category and store routing
3. add the shared workspace-memory writer
4. rewire onboarding context fetch into the shared writer
5. remove autofetch worker and post-connect auto-start
6. remove manual context-fetch re-trigger
7. add execution-time integration evidence capture
8. unify turn durable writeback
9. move retrieval/browser/sync to the unified graph
10. backfill existing workspaces
11. remove legacy split semantic paths

## Done when

This project is done when:

- every durable memory item lives in a workspace-owned graph
- onboarding context fetch writes into that graph
- live integration use writes into that graph
- there is no recurring integration autofetch cron
- retrieval, browser, and sync all operate on that graph
- current memory operations still work without requiring a separate integration-memory subsystem
