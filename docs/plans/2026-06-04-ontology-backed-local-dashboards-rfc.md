---
title: Ontology-backed local operational database, bases, objects, dashboards, views, and teams
date: 2026-06-04
status: draft
related:
  - 2026-04-01-app-surface-iframe-migration.md
  - 2026-05-27-teammates-v1-decisions-and-open-questions.md
  - 2026-05-24-memory-architecture-redesign-note.md
---

# Ontology-backed local operational database, bases, objects, dashboards, views, and teams

## 0. Status and decision summary

This document proposes a new product foundation for holaOS.

The foundation is not:

- dashboard first
- app first
- code generation first

The foundation is:

- a local no-code operational database in SQLite
- inspired by tools like Airtable and NocoDB
- extended with workflow semantics, integrations, automations, and teammates
- surfaced through objects with multiple views, plus dashboards for heavier multi-object visualization
- surfaced to both humans and agents through the same underlying runtime model and primitives

### Decision in this draft

- the product core is a local operational database, not a dashboard
- the root bundle is a `base`
- objects are the primary table-like units inside a base and carry multiple views
- dashboards are heavier multi-object surfaces inside a base, not the foundation
- the agent should build and evolve the database through first-class tools
- SQLite remains the canonical local operational store
- integrations, teammates, automations, object views, and dashboards all attach to the same local model
- the runtime owns rendering, validation, lifecycle, preview, and publish
- the frontend and the tool surface should be parallel clients over the same model, not separate authoring systems
- this path is separate from app-builder
- custom app code is out of scope for the default path

---

## 1. Product framing

The right mental model is:

- local Airtable or NocoDB
- plus workflow/runtime semantics
- plus integrations
- plus automations
- plus teammates
- plus object views
- plus dashboards

The closest analogy is:

- workspace
- base
- object
- dashboard
- view

where:

- `base` is the root operational bundle
- `object` is the primary table-like unit inside a base
- `view` is a lower-level presentation over one object such as `grid`, `list`, `gallery`, or `kanban`
- `dashboard` is a heavier multi-object surface that mixes views, metrics, and richer visualization components

The user should be able to ask for an operational system in domain language, and the agent should build:

- the database schema
- the linked records
- the objects
- the views
- the workflows
- the teammate bindings
- the integrations
- the dashboards

The user is not really asking for:

- a dashboard in isolation
- a web app in isolation
- a bundle of frontend code

They are asking for:

- an operational database with useful objects, views, and dashboards

The important constraint for v1 is:

- the system must be directly usable by a human builder
- but that must not introduce a second authoring model that later burdens agent-driven building

So the intended shape is:

- one canonical database and metadata model
- one canonical set of runtime primitives
- a frontend authoring/runtime surface for humans
- a tool surface for agents

not:

- one model for humans
- a different model for agents
- or extra manual-only concepts that agents must later work around

Structurally, that means:

- a workspace can contain many bases
- a base can contain many objects and dashboards
- an object can contain multiple views
- a dashboard can mix data from multiple object sources

---

## 2. Worked examples

The system should be domain-general.

Social media operations is one example.

Investment operations is another.

### 2.1 Example A: social media operations

User asks:

- "build me a system for running day-to-day social media operations"

The workflow might be:

1. strategy generation
2. human approval of strategies
3. strategy execution
4. human review of composed posts
5. approve and send
6. continuous retrieval of post metrics

The system should create:

- tables such as `strategies`, `post_drafts`, `published_posts`, `metric_snapshots`
- linked records between strategies, drafts, and published posts
- teammates such as `strategy_generator` and `post_composer`
- integrations for publishing and metrics retrieval
- objects and dashboards such as `Strategies`, `Execution`, `Post review`, and `Metrics`

### 2.2 Example B: investment operations

User asks:

- "build me a system to support how I research and execute investments"

The workflow might be:

1. idea intake or screening
2. teammate-generated research or thesis draft
3. human review of thesis and risks
4. watchlist management
5. order proposal and approval
6. position and portfolio monitoring
7. continuous retrieval of market and performance metrics

The system should create:

- tables such as `investment_ideas`, `research_theses`, `order_proposals`, `positions`, `market_snapshots`
- linked records between ideas, theses, orders, and positions
- teammates such as `idea_screener` and `thesis_researcher`
- integrations for market data, portfolio data, and execution where supported
- objects and dashboards such as `Ideas`, `Research`, `Orders`, `Portfolio`, and `Market metrics`

These examples differ in domain, but the product shape is the same:

- database core
- workflow semantics
- integrations
- teammates
- object views and dashboards

---

## 3. Why this exists

Several things already point in this direction:

1. workspace-local SQLite is the right place for fast local operational state
2. teammate execution is now a real runtime primitive
3. integrations and automations can populate and act on local state
4. dashboard-shaped workflow surfaces are useful, but app generation is too expensive and brittle as the default path

What is missing is a single product abstraction that unifies them.

Without that abstraction, the system drifts into weak shapes:

- every workflow request becomes an app-building request
- the visible surface is coupled to bespoke frontend code
- teammates become detached background logic
- SQLite becomes an implementation detail instead of the operational model
- dashboards become thin shells over unstructured logic

What we want instead is:

- operational database first
- object views and dashboards second

not:

- dashboard or surface first
- data model second

---

## 4. Non-goals

This draft does not propose:

- generating a custom JavaScript application as the default path
- requiring `apps/<id>/`, `package.json`, `server.ts`, or `src/client/` for normal builds
- using app build, register, restart, or process-management steps as part of authoring
- treating the system as only a dashboard builder
- turning the runtime into a general-purpose BI platform
- replacing one-off reports with operational systems
- exposing arbitrary write-capable SQL to object views or dashboards

This RFC is intentionally not about app-builder.

---

## 5. Core concept: ontology-backed local operational database

The core primitive is a local operational database.

That database has:

- tables or object types
- typed fields
- linked records and relations
- records
- states
- events
- views
- formulas or derived fields
- actions
- automations
- teammate responsibilities
- integration sync definitions

SQLite stores the materialized state of that model.

Integrations sync into it.

Teammates operate on it.

Automations schedule around it.

Interfaces read from it.

Database tools inspect it.

The frontend runtime is therefore a surface over the same shared object graph that the rest of the system uses.

---

## 6. Base architecture

### 6.1 Layer 1: schema layer

The schema layer defines:

- tables or object types
- field identities
- field types
- semantic roles for selected fields
- foreign-key references and relations
- derived fields
- state machines
- allowed actions
- workflow queues
- declarative projections

For one workflow, that might mean:

- `Strategy`
- `PostDraft`
- `PublishedPost`
- `MetricSnapshot`

with relations like:

- `Strategy -> PostDraft`
- `PostDraft -> PublishedPost`
- `PublishedPost -> MetricSnapshot`

For another workflow, that might mean:

- `InvestmentIdea`
- `ResearchThesis`
- `OrderProposal`
- `Position`

with relations like:

- `InvestmentIdea -> ResearchThesis`
- `ResearchThesis -> OrderProposal`
- `OrderProposal -> Position`

### 6.1.1 Typed field contract

The runtime should distinguish between three separate concepts:

- field identity
- field type
- optional semantic role

Field identity is domain-specific.

Examples:

- `approval_state`
- `thesis_summary`
- `last_reviewed_at`
- `risk_level`

Field type is normalized and drives validation, storage behavior, and component compatibility.

Useful field types include:

- `string`
- `text`
- `number`
- `boolean`
- `status`
- `enum`
- `date`
- `datetime`
- `duration`
- `money`
- `percent`
- `metric`
- `rich_text`
- `json`
- `foreign_key`

The field model should be stricter than a flat type enum.

In practice, we likely need a field-type registry with several classes of field:

- primitive fields such as `string`, `number`, `boolean`, `date`, `datetime`
- relational fields such as `foreign_key`, `lookup`, `linked_records`
- computed fields such as `formula`, `rollup`, `count`
- system and audit fields such as `id`, `created_at`, `updated_at`, `created_by`
- presentation-oriented fields such as `attachment`, `icon`, `cover_image`, `rich_text`

Each field type should carry runtime behavior, not just a label.

At minimum, a field-type definition should specify:

- storage representation in SQLite
- accepted input shape
- normalized output shape
- filter operators
- sort behavior
- aggregation compatibility
- validation rules
- component compatibility

Semantic role is optional metadata that tells the frontend runtime how a field can be used in generic components.

Useful semantic roles include:

- `title`
- `subtitle`
- `primary_status`
- `owner`
- `priority`
- `start_time`
- `end_time`
- `due_time`
- `cover_image`
- `icon`

Metric fields should usually remain ordinary typed fields or view-level selections rather than object-level semantic roles.

An object may have zero, one, or many metrics, and which one is primary is often dashboard- or view-specific rather than schema-level.

For example, a `Strategy` object may have:

- `strategy_name`: `string`, role `title`
- `campaign_name`: `string`, role `subtitle`
- `approval_state`: `status`, role `primary_status`
- `last_reviewed_at`: `datetime`

An `InvestmentIdea` object may have:

- `ticker`: `string`, role `title`
- `thesis_summary`: `text`, role `subtitle`
- `review_state`: `status`, role `primary_status`
- `expected_return`: `percent`

Generic components should not depend on arbitrary field names like `status` or `date`.

They should be able to ask for:

- a field of type `status`
- or a field carrying the role `primary_status`

depending on the component contract.

Metric-oriented components should usually bind through:

- explicit view definitions
- explicit component bindings
- or selected metric fields by type

rather than assuming every object has a built-in primary or secondary metric.

### 6.1.2 Structural system fields

Some fields are still genuinely system-level and should exist consistently across records or be derivable consistently.

Examples:

- `id`
- `object_type`
- `created_at`
- `updated_at`

These are different from domain-facing typed fields and semantic roles.

### 6.1.3 Linked records, foreign keys, and relations

Objects should be able to reference other objects directly.

That means the model should support foreign-key typed fields such as:

- `strategy_id`
- `post_draft_id`
- `portfolio_id`
- `owner_user_id`

with declarations like:

- field type `foreign_key`
- referenced object type
- optional cardinality and nullability rules

Not every relationship needs to be represented as an inline foreign key.

The model should support both:

- inline foreign-key fields for simple one-to-one or many-to-one references
- explicit relation tables for many-to-many or semantically named relationships

Relations should also declare explicit semantics rather than existing only as ad hoc foreign keys.

Useful relation semantics include:

- `belongs_to`
- `has_many`
- `many_to_many`
- `one_to_one`

The runtime should support first-class relation operations such as:

- link record
- unlink record
- list related records
- show related-record display value
- enforce relation cardinality rules

That lets the runtime support patterns such as:

- `PostDraft.strategy_id -> Strategy.id`
- `OrderProposal.idea_id -> InvestmentIdea.id`
- `WorkItem.owner_user_id -> User.id`
- `PublishedPost <-> Tag` through a relation table

The frontend runtime can then use these references for:

- detail navigation
- related-record panes
- owner badges
- grouped queues
- drill-down flows

### 6.2 Layer 2: local SQLite store

SQLite is the local canonical operational store.

It should contain:

- canonical record tables
- relation tables
- event and audit tables
- workflow queue tables
- sync state tables
- materialized views for object views and dashboards

Important rules:

- ordinary frontend reads come from local SQLite
- live provider calls are for sync and actions, not normal page reads
- durable user-facing workflow state is local first

### 6.3 Layer 3: projections and derived fields

The system needs declarative projections over the operational database.

Those projections should support:

- filtering
- grouping
- sorting
- formulas, lookups, rollups, and other derived fields
- projections for object views and dashboards

Examples:

- records awaiting approval
- queued work by owner
- portfolio exposure by sector
- published-post performance by channel

In v1, objects do not need first-class saved named views as user-authored records.

Instead:

- `grid`, `list`, `gallery`, and `kanban` are built-in display modes of an object
- current filter, sort, grouping, and visible-field state can remain lightweight
- reusable projection records can be introduced later if needed

Dashboards and runtime evaluation should still rely on declarative backend-owned projections rather than bespoke per-surface logic.

Derived fields should not be treated as loosely embedded expressions.

They should compile from a validated declarative representation into SQL or other runtime execution plans with support for:

- dependency resolution
- cycle detection
- relation-aware lookups
- rollups across linked records
- type checking
- deterministic error reporting

### 6.4 Layer 4: workflow semantics

A generic no-code database is not enough for the product we want.

The system also needs first-class workflow semantics such as:

- approvals
- queues
- ownership
- retries
- escalation
- sync state
- deterministic actions

These should be part of the runtime contract, not hand-built on every system from scratch.

### 6.5 Layer 5: integration layer

Integrations in this path are not app-local code.

They are runtime-bound capabilities that can:

- ingest source data into local tables
- execute deterministic provider actions
- refresh remote status into local state

Examples:

- sync content calendar inputs
- publish an approved post
- retrieve post-performance metrics
- sync market data
- ingest portfolio positions
- refresh exposure or performance snapshots

For ingestion, the integration contract should be schema-aware.

An integration should be able to declare:

- destination schema contributions
- external record identity
- incremental sync cursor shape
- relation/link emissions
- batch or stream behavior

The runtime should be able to consume normalized sync objects that separate:

- target table
- external record id
- primitive field payload
- linked-record payload

That is a better base for agent-built systems than having every integration hand-write row mutations.

### 6.6 Layer 6: teammate and automation layer

Supporting teammates are generated against the same database.

They should own work such as:

- generating strategies
- composing posts
- screening ideas
- drafting investment theses
- performing queued execution work
- collecting metrics
- handling retries and exceptions

They should not become the source of truth. They operate on the source of truth.

Automations should own:

- sync schedules
- recurring ingestion
- record-change triggers
- periodic metric retrieval
- queue polling
- escalation timers

### 6.7 Layer 7: object views and dashboards

Objects are the primary user-facing units inside a base.

An object is essentially the table-like unit a human works with directly.

Each object can expose multiple views such as:

- `grid`
- `list`
- `gallery`
- `kanban`

Those views are usually the main day-to-day working surfaces for that object.

Dashboards are separate, heavier surfaces over the same base.

A dashboard is not the root object and not the same thing as an object view.

It is a richer multi-object surface that can combine:

- views from multiple objects
- summary metrics
- richer charts and visualizations
- mixed components on a single surface

So the intended frontend shape is:

- a base contains objects
- each object contains one or more views
- a base may also contain dashboards that mix data from multiple object sources

The builder agent should select from supported object-view and dashboard primitives.

It should not emit custom UI code for the default path.

Components should prefer binding against:

- structural system fields
- typed fields
- semantic roles
- linked-record references

before falling back to explicit field wiring.

### 6.8 Backend / frontend contract

The backend and frontend should have a strict separation of responsibilities.

The backend owns:

- schema
- records
- linked records and relations
- views
- formulas
- workflow state
- approvals
- typed actions
- integrations
- teammate execution
- automations
- permissions

The frontend owns:

- object view composition
- dashboard composition
- component layout
- local ephemeral UI state such as open drawers, active tabs, and search text
- invoking typed backend actions

The frontend should not own business logic.

The frontend runtime is a thin renderer over backend truth.

The usual flow should be:

1. integrations or teammates write to the operational database
2. backend updates records, relations, queues, and declarative projections
3. object views and dashboards re-render from those projections
4. user invokes a typed action such as approve, reject, send, or refresh
5. backend executes that action and updates durable state
6. object views and dashboards re-render again from the updated backend state

This is the reason semantic roles and typed fields exist at all.

They are part of the contract between backend and frontend.

A component should be able to ask the backend for:

- the display title
- the default status field
- the owner
- the linked records
- the allowed actions

without domain-specific frontend code for every workflow.

The backend also needs first-class permission and policy semantics.

That should include:

- role definitions
- table-level permissions
- field-level visibility and editability
- action permissions
- row-level policies
- object-view and dashboard visibility rules

Operational systems will often have different readers, approvers, operators, and teammates, so permissions cannot be an afterthought or a frontend-only concern.

### 6.9 How this supports the example cases

The same backend and frontend contract supports both social-media and investment workflows.

For social-media operations:

- backend tables hold strategies, post drafts, approvals, published posts, and metrics snapshots
- teammates generate strategies and compose drafts into those tables
- integrations publish approved posts and refresh performance data
- projections expose "awaiting strategy approval", "drafts awaiting review", and "post performance by channel"
- object views render queues and review flows, while dashboards can render mixed metrics and monitoring surfaces

For investment operations:

- backend tables hold ideas, research theses, risk assessments, order proposals, positions, and market snapshots
- teammates screen ideas and draft research into those tables
- integrations refresh market, portfolio, and execution-related data where supported
- projections expose "ideas awaiting triage", "theses awaiting approval", "orders awaiting review", and "portfolio exposure by dimension"
- object views render research and order workflows, while dashboards can render mixed portfolio and market monitoring surfaces

The important point is that the frontend runtime does not need a different product architecture for each case.

What changes is:

- schema
- views
- teammate bindings
- integrations
- actions
- object definitions
- dashboard definitions

What stays the same is:

- database foundation
- workflow semantics
- backend/frontend contract
- tool-driven authoring model

### 6.10 Layer 8: database tool layer

The same local store should be inspectable through deterministic database tools.

At minimum, the runtime needs tools for:

- listing tables
- describing table shape
- sampling rows
- running bounded read-only queries against approved tables and views

These are not the primary authoring surface.

They are the inspection and validation surface used by:

- agents during build
- agents during debugging
- users or operators during validation

Mutations still go through typed actions, not ad hoc SQL.

In addition to raw inspection tools, the runtime should expose compiled metadata and introspection.

Agents, object views, and dashboards should be able to ask for:

- effective schema
- field capabilities
- relation metadata
- derived-field dependency graphs
- component-compatible bindings
- action contracts

This is important because the system being authored is richer than raw tables alone.

---

## 7. Agent build flow

The builder should not start from "generate UI".

It should start from "define the operational database and bind it to objects, views, and dashboards".

### 7.1 Recommended build phases

1. requirement intake
2. operating-model proposal
3. schema definition
4. integration binding
5. teammate and automation binding
6. view and dashboard definition
7. runtime validation
8. preview
9. publish

### 7.2 What the agent should do

For any given workflow, the agent should do something like:

1. infer or propose the core tables or objects
2. define the state machines, approval points, field types, semantic roles, and object references
3. bind the relevant teammates
4. bind the relevant integrations
5. define the required views
6. define objects, views, and dashboards from the supported vocabulary
7. validate that all schema, views, actions, and bindings resolve
8. preview the result
9. publish it into the workspace

For a social-media workflow, that might mean pages like:

- `Strategies`
- `Execution`
- `Post review`
- `Metrics`

For an investment workflow, that might mean pages like:

- `Ideas`
- `Research`
- `Orders`
- `Portfolio`
- `Market metrics`

### 7.3 What the agent should not do

It should not:

- scaffold an app
- write `package.json`
- write `server.ts`
- write React components
- manage ports or processes
- build client bundles
- restart lifecycle services to make the surface appear

Those are app-builder concerns and are outside this path.

### 7.4 Human and agent symmetry

The same platform primitives should be usable from both:

- the frontend surface used by a human builder
- the runtime tools used by an agent builder

Human-first in v1 does not mean:

- a separate manual authoring stack
- extra concepts that exist only in the frontend
- or a later translation layer from human-authored artifacts into agent-authored artifacts

It means:

- the human can directly use the foundational database, object views, and dashboard builder in v1
- the agent later uses the same schema, object, view, action, trigger, teammate, integration, and dashboard primitives through tools
- frontend components and tool operations should map closely enough that they are different clients over the same model

---

## 8. Required runtime tool surface

This RFC assumes a dedicated tool surface for building and evolving the database, its objects and views, and its dashboards.

The exact tool names can change, but the capability surface should look roughly like this.

### 8.1 Schema-definition tools

- `base_object_define`
- `base_object_update`
- `base_field_define`
- `base_field_update`
- `base_relation_define`
- `base_link_records`
- `base_unlink_records`
- `base_view_define`
- `base_formula_define`
- `base_action_define`
- `base_policy_define`

These tools should:

- persist durable base artifacts
- apply or queue required SQLite migrations
- keep the declared schema and local store in sync

### 8.2 Binding tools

- `base_integration_bind`
- `base_teammate_bind`
- `base_automation_define`
- `base_trigger_define`
- `base_permission_define`

These tools should attach the operational layer to the same database, not to a separate app.

### 8.3 Dashboard-definition tools

- `base_dashboard_define`
- `base_dashboard_navigation_define`
- `base_dashboard_filter_define`
- `base_dashboard_component_bind`

These tools should define:

- dashboards
- sections
- component kinds
- mixed-object data bindings
- surfaced actions

### 8.4 Validation and preview tools

- `base_validate`
- `base_schema_introspect`
- `base_view_explain`
- `base_dashboard_preview`
- `base_publish`
- `base_diff`

These tools should let the agent:

- verify schema and bindings
- inspect compiled metadata
- confirm views execute
- confirm dashboards resolve to supported primitives
- inspect what will change before publish

### 8.5 Data inspection tools

The runtime also needs read-only data inspection tools such as:

- `workspace_data_list_tables`
- `workspace_data_describe_table`
- `workspace_data_sample_rows`
- `workspace_data_query`

These remain useful in the new path, but as inspection tools rather than primary authoring tools.

### 8.6 Important authoring rule

The agent should use these tools as the primary authoring surface.

The tools should persist definition metadata into runtime-owned SQLite tables and compiled runtime state.

The agent should not need to hand-author the full implementation directly.

---

## 9. Recommended metadata model

The system should persist both operational data and definition metadata in SQLite.

The definition layer should be live runtime state, not primarily a pile of config files.

The runtime tools are the preferred authoring surface.

### 9.1 Recommended metadata tables

The exact table names can change, but the durable model should look roughly like this:

#### `bases`

- one row per named base
- base identity, title, description, and lifecycle metadata

#### `base_objects`

- object definitions owned by a base
- record type identity and structural metadata

#### `base_fields`

- field definitions, types, roles, validation, and storage metadata

#### `base_relations`

- foreign-key and relation definitions
- cardinality, nullability, and display metadata

#### `base_views`

- declarative projection definitions
- filter, sort, group, projection, formula, lookup, and rollup metadata

#### `base_actions`

- typed actions, transitions, provider effects, and persistence metadata

#### `base_triggers`

- event-driven or scheduled trigger definitions
- trigger condition, target action, teammate target, and retry metadata

#### `base_dashboards`

- dashboard definitions and navigation metadata
- dashboard identity, title, and layout metadata

#### `base_dashboard_components`

- dashboard component instances, bindings, layout metadata, and surfaced actions

#### `base_teammate_bindings`

- teammate remit inside a base
- queue subscriptions, allowed actions, and escalation metadata

#### `base_integration_bindings`

- attachment between a base and a reusable workspace integration connection
- capability, provider, scope, and binding metadata

#### `base_permissions`

- roles, policy definitions, field permissions, action permissions, and row-level rules

#### operational tables

- actual business records
- queue state
- approvals
- metrics snapshots
- sync cursors
- audit and event history

### 9.2 Export and import

V1 does not require file-based authoring or file-based source of truth.

If export/import is added later, it should be implemented as:

- export: serialize SQLite metadata for a base into a portable artifact
- import: validate a portable artifact and write it into SQLite metadata tables

That preserves SQLite as the canonical runtime model while leaving room for portability later.

---

## 10. Minimal v1 primitive set

The first version does not need full platform breadth.

It needs a small, coherent primitive set that maps to real operational systems.

### 10.1 Data primitives

- object
- field
- field type
- semantic role
- foreign key
- relation
- relation operation
- record state
- event

### 10.2 View primitives

- view
- `grid`
- `list`
- `gallery`
- `kanban`
- formula
- lookup
- rollup
- metric
- grouping
- filter
- sort

In v1, the built-in display modes are not first-class saved user view records by default.

They are built-in object surfaces that may use lightweight current state, while reusable projection records remain extensible for later.

### 10.3 Execution primitives

- deterministic action
- delegated teammate task
- event trigger
- workflow queue
- sync job
- cron trigger

### 10.4 Dashboard primitives

- dashboard
- section
- filter bar
- action bar
- approval queue
- progress strip
- metrics section
- detail pane
- chart
- mixed panel

### 10.5 Record detail primitives

- generic autogenerated detail surface
- generic autogenerated edit surface
- single-record editing

### 10.6 Integration primitives

- source binding
- destination binding
- sync definition
- sync cursor
- external record identity
- action capability

### 10.7 Teammate primitives

- teammate
- remit
- queue subscription
- allowed actions
- escalation target

### 10.8 Governance primitives

- role
- permission
- policy
- row-level rule

### 10.9 Required runtime behaviors

- compile schema definitions to SQLite schema
- materialize declarative projections over local state
- bind object views to those objects
- bind dashboards to one or more object views
- bind integrations and teammates to the same database
- expose deterministic inspection tools over the same local SQLite state
- expose compiled metadata and binding introspection over the same model
- render object views and dashboards from a fixed component vocabulary
- render a generic autogenerated detail/edit surface for records
- persist all durable workflow state locally
- preview and publish without requiring a custom app lifecycle

---

## 11. Validation and lifecycle

The build is not done unless:

- the schema compiles
- required SQLite schema changes apply cleanly
- integrations are declared and bound correctly
- teammate permissions and queue bindings resolve
- declarative projections execute
- formulas, lookups, and rollups compile without dependency or type errors
- database inspection tools can read the resulting tables and views
- required structural fields, typed fields, semantic roles, and references resolve for bound components
- every object view and dashboard resolves to supported kinds and component contracts
- surfaced actions map to real typed actions
- permissions and row-level policies resolve against declared roles and actions
- preview renders successfully
- publish does not require app build or custom lifecycle work

### Lifecycle principle

The runtime should own lifecycle for this path.

That means:

- no per-base server process
- no per-base port management
- no dashboard build step in the app sense
- no manual restart requirement just to see the surface

Publishing should feel closer to:

- compile
- validate
- preview
- publish

not:

- scaffold
- install
- build
- boot
- restart

---

## 12. What to avoid

### Do not bring into this path

- app scaffolding
- dashboard-specific frontend code generation
- manual process lifecycle management
- dashboard-local business logic
- dashboard-local write-capable SQL
- a second local state model parallel to shared workspace SQLite

### Do not stop at a generic no-code database

A plain Airtable-like database is too weak by itself.

This system also needs:

- approvals
- queues
- ownership
- teammate bindings
- deterministic actions
- escalation
- sync state

The goal is:

- Airtable-like database foundation
- plus workflow/runtime semantics
- plus object views and dashboards

not:

- a local Airtable clone only

---

## 13. Open design questions

### Decisions already locked for v1

The following decisions are already resolved for v1 in the current direction:

- each generated solution is a named root bundle modeled as a `base`
- SQLite is the canonical source of truth for both operational data and definition metadata
- export/import can be added later as a serialization layer over SQLite metadata, but is not part of the primary v1 persistence model
- the frontend surface and the tool surface are parallel clients over the same canonical model and primitive set
- human-usable v1 does not justify a separate authoring model that would later burden agent-driven building
- v1 assumes a single workspace context and does not require full collaborative authoring UX
- views and derived projections are defined through a declarative DSL compiled by the runtime
- `grid`, `list`, `gallery`, and `kanban` are built-in object display modes in v1 rather than first-class saved view records
- v1 does not require saved named object presets or saved named object views
- records use a generic autogenerated detail/edit surface in v1 rather than per-object custom layouts
- v1 supports single-record editing, while bulk edit and bulk actions can be deferred
- the minimum field-type set includes `string`, `text`, `number`, `boolean`, `enum`, `status`, `date`, `datetime`, `money`, `percent`, `json`, `foreign_key`, `attachment`, `formula`, `lookup`, and `rollup`, alongside structural system fields such as `id`, `created_at`, `updated_at`, and `created_by`
- integrations may write through declared runtime-owned sync and update pipelines
- teammates do not raw-write by default and should operate through typed actions and workflow transitions
- the minimum permission model includes roles, table permissions, field visibility and editability, action permissions, and row-level policies
- the minimum view surface includes data views such as `grid`, `list`, `gallery`, and `kanban`
- the minimum dashboard primitive set includes `detail`, `approval_queue`, `metrics`, `filters`, `actions`, `group_tabs`, `related_records`, `chart`, and mixed panels
- a base may contain multiple objects and dashboards
- each object may contain multiple views
- dashboards mix data from multiple object sources with stronger visualization components
- row-level policies should be simple declarative rules in v1 rather than a general policy language
- typed actions should return a structured result with fields such as `status`, `next_state`, `record_patch`, `external_effect`, `message`, and `error`
- triggers are first-class runtime primitives, and can react to record creation, record updates, or other supported events by invoking actions, teammate runs, or automation work
- typed actions and trigger executions run in the background in v1 rather than mixing inline and queued execution modes
- backend audit and event history exists in v1, while record-level timeline UI can be deferred
- the implementation should reuse the existing teammate and integration runtime contracts where possible without inheriting app-builder packaging assumptions

### 13.1 View-definition format

Locked for v1:

- views are defined through a constrained declarative DSL compiled by the runtime
- raw SQL is not the primary authoring model
- built-in object display modes are not first-class saved view records by default

### 13.2 Artifact persistence

Locked for v1:

- SQLite is the source of truth for definition metadata and operational state
- runtime tools author SQLite-backed metadata directly
- export and import may be added later as a portability layer

### 13.3 Interface variety

Are dashboards sufficient, or should the runtime explicitly model multiple heavyweight surface classes from day one?

Recommendation in this draft:

- keep the core model simple in v1:
- objects with multiple views for day-to-day work
- dashboards as the heavier mixed-source surface

### 13.4 Team write permissions

Locked for v1:

- teammates do not raw-write by default
- teammates invoke typed actions and workflow transitions
- integrations may write through declared runtime-owned sync and update pipelines

### 13.5 Human approval semantics

How should approval points be modeled?

Recommendation in this draft:

- explicit approval records and actions, not hidden booleans on unrelated rows

That matters directly for workflows like:

- approve strategy
- approve post
- approve thesis
- approve order

### 13.6 Scope of the field-type registry

How much of the field surface should be in v1?

Recommendation in this draft:

- start with a constrained but extensible field-type registry
- explicitly separate primitive, relational, computed, system, and presentation-oriented field classes
- avoid locking the system into a tiny flat enum that later cannot express lookups, rollups, audit fields, or specialized editors cleanly

### 13.7 Permission and policy model

Locked for v1:

- start with roles, table and field permissions, action permissions, and row-level policies
- keep policy evaluation backend-owned
- do not make permissions merely a view- or dashboard-visibility feature

---

## 14. Proposed phased implementation

### Phase 1: local database foundation

- define the durable SQLite metadata model
- compile schema to local SQLite
- introduce typed fields, linked records, and declarative projections
- expose read-only database inspection tools

### Phase 2: workflow semantics

- add approvals, queues, ownership, retries, and sync state
- add deterministic actions over the database

### Phase 3: integrations and teammates

- bind integrations for ingestion and deterministic actions
- bind teammates and automations to the same database

### Phase 4: objects, views, and dashboards

- introduce object-view and dashboard vocabulary
- support object views for day-to-day work and dashboards for heavier mixed-source monitoring and visualization

### Phase 5: tool-driven builder flow

- expose the schema, binding, view, and dashboard tool surface
- move agent authoring to tool calls instead of code generation

### Phase 6: natural-language system generation

- requirement -> operational database -> integrations + teammates + object views + dashboards
- support common workflow classes such as approvals, operations queues, watchlists, portfolio tracking, and metrics review

### Reuse from the existing integration and teammate runtime

The v1 implementation should reuse existing runtime patterns where they already match the new product shape.

The goal is not to inherit the app-builder path.

The goal is to reuse the durable execution contracts that already exist underneath it.

The most reusable pieces are:

- teammate capability profiles as the durable summary of what a teammate is meant to do
- teammate-local skills as the durable operating instructions and attached assets for a teammate
- teammate task lifecycle as the execution model for delegated work
- task assignment, blocking, handoff, priority, and run-state tracking
- integration requirement declarations including provider, capability, scopes, credential source, and identity resolution
- integration readiness checks before attempting provider-backed actions
- provider-effect action wrappers that distinguish ready, blocked, failed, and successful execution
- the existing split between integration connection and integration binding

In practice, that means the new system should prefer patterns such as:

- a database action delegating work by creating a teammate task instead of hand-rolling background-job contracts
- a provider-backed action checking readiness and returning a typed blocked state instead of failing late against an upstream API
- a bound integration referring to a reusable workspace connection rather than embedding provider credentials into a base artifact
- a queue or approval surface reflecting existing task states such as `todo`, `in_progress`, `in_review`, `done`, and `blocked`

These runtime patterns map well onto the new database-first foundation:

- teammate tasks become execution records for schema objects and workflow actions
- integration bindings become attachments between bases, actions, and reusable workspace connections
- capability profiles and skills become the durable contract for what a teammate can own in a base
- readiness and provider-effect semantics become part of typed action execution

What should not be reused directly:

- app-scoped assumptions such as `appId` and app grants as the primary identity model
- app-builder file layout or lifecycle concerns
- any assumption that the authored artifact is a JavaScript application

So the implementation principle is:

- reuse runtime contracts
- do not reuse app packaging assumptions

That lets the v1 ship faster while still keeping this path clearly separate from app-builder.

---

## 15. Acceptance criteria

This direction is successful if a user can say:

- "build me a social media operations system"

or:

- "build me an investment operations system"

and the system can produce the right domain-specific result in either case:

- a local SQLite-backed operational database
- the relevant objects, linked records, and views
- the relevant teammates for that workflow
- the relevant integrations for ingestion and deterministic actions
- the right object views and dashboards for that domain
- typed actions for approval, rejection, revision, execution, and refresh

For example, a social-media system might produce:

- `Strategies`
- `Execution`
- `Post review`
- `Metrics`

while an investment system might produce:

- `Ideas`
- `Research`
- `Orders`
- `Portfolio`
- `Market metrics`

without requiring the default implementation path to be:

- scaffold an app
- write frontend code
- build a client bundle
- manage app lifecycle

The agent should achieve the result primarily by calling database, view, and dashboard runtime tools.

---

## 16. Recommendation

The recommended direction is:

- make the local operational database the product foundation
- keep SQLite as the source of truth
- add workflow/runtime semantics on top of that foundation
- attach integrations, automations, teammates, object views, and dashboards to the same base-backed database
- let agents build systems through first-class database, view, and dashboard tools
- let the runtime own rendering, lifecycle, validation, preview, and publish

That gives holaOS a stronger and more general product shape:

- database core
- workflow semantics
- integrations
- teammates
- object views
- dashboards
- tool-driven authoring

instead of:

- dashboards
- app code
- app lifecycle
- and workflow logic

all evolving as separate systems.
