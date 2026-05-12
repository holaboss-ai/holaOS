---
title: Universal block package architecture
date: 2026-05-09
status: draft
related:
  - 2026-05-06-pages-and-databases-design.md
  - 2026-04-01-app-surface-iframe-migration.md
  - 2026-03-31-marketplace-design.md
---

# Universal block package architecture

## 0. Status & decision summary

This document captures a revised direction for dashboard/page composition:

- remove the `native block` vs `custom block` split
- treat first-party blocks as **bundled block packages**, not privileged types
- keep structure in the **platform primitives** (pages, resources, bindings, runtime, permissions)
- keep flexibility in the **block implementations** themselves

This is a directional architecture note, not a frozen implementation plan. It is intended to keep product and engineering aligned while the block model is still being shaped.

### Decisions in this draft

| Topic | Choice |
|---|---|
| Native vs custom blocks | **One universal block model** |
| What holaOS ships | **Bundled first-party block packages + templates** |
| Main user-facing insertion surface | **Templates**, not raw block definitions |
| What remains platform-owned | **Pages, resources, bindings, runtime, permissions, versioning** |
| Extension mechanism | **Packages with typed definitions and templates** |
| Execution boundary | **Sandboxed runtime** (`iframe` or worker-backed host) |
| Agent mental model | **Definitions, templates, instances, resources, bindings** |

---

## 1. Why this exists

The product is trying to balance two pressures:

1. Users need enough structure that pages remain composable, editable, and understandable by agents.
2. Users also need enough freedom to "vibe code" new blocks without waiting for product engineering to add a new hardcoded type.

The earlier `native block` vs `custom block` framing creates the wrong asymmetry:

- first-party blocks become special
- user-authored blocks become second-class
- agents must learn two different models
- marketplace reuse becomes less clean than it should be

The better model is:

- one **block package system**
- first-party blocks are just **first-party packages**
- user and agent blocks use the **same contract**

That lets holaOS dogfood its own extension model from day one.

---

## 2. Design principles

### 2.1 Strict outside, flexible inside

The platform should be strict about:

- identity
- persistence
- bindings
- permissions
- execution boundaries
- versioning

The platform should be flexible about:

- rendering
- interaction design
- domain-specific logic
- internal block workflows

### 2.2 Templates are the main UX, not definitions

Most users should insert from a gallery of templates:

- `Weekly KPI`
- `Content calendar`
- `Pipeline board`
- `Posts by status`

Those templates sit on top of reusable block definitions.

### 2.3 Structure belongs in primitives, not special block types

The durable system should not depend on a growing union of hardcoded block classes.

Structure should instead live in:

- page/tree model
- resources
- bindings
- permissions
- runtime contract

### 2.4 First-party should not be privileged in the product model

First-party packages may be more trusted, more polished, and bundled by default, but they should still use the same definition/template/instance model that user-authored packages use.

---

## 3. Platform primitives

These are platform-level concepts. They are not themselves block definitions.

### 3.1 Pages

Pages own:

- block tree
- ordering
- layout slots
- titles, icons, metadata
- page-level parameters and filters

### 3.2 Resources

Resources are reusable typed things that blocks can consume or produce.

Examples:

- SQL query
- user database
- table/view
- parameter
- action
- derived dataset

### 3.3 Bindings

Bindings connect block inputs to resources or to other block outputs.

This is the main composition primitive.

### 3.4 Runtime

The runtime owns:

- sandboxed execution
- message passing
- persistence APIs
- permission checks
- lifecycle hooks

### 3.5 Versioning

Versioning owns:

- instance duplication
- package forking
- history
- publish / rollback

---

## 4. Core object model

The architecture has four main entities:

- `BlockPackage`
- `BlockDefinition`
- `BlockTemplate`
- `BlockInstance`

And two supporting entities:

- `Resource`
- `BindingSpec`

### 4.1 Type sketch

```ts
type Capability =
  | "visualization"
  | "collection_view"
  | "controller"
  | "action"
  | "data_consumer"
  | "data_producer"
  | "layout"
  | "text"

type PackageTrust = "bundled" | "verified" | "local"

interface BlockPackage {
  package_id: string
  publisher: "holaboss" | "marketplace" | "workspace"
  version: string
  trust: PackageTrust
  definitions: BlockDefinition[]
  templates: BlockTemplate[]
}

interface BlockDefinition {
  definition_id: string
  name: string
  capabilities: Capability[]
  props_schema: JsonSchema
  input_ports: PortSchema[]
  output_ports: PortSchema[]
  permissions: PermissionSpec[]
  runtime: RuntimeSpec
}

interface BlockTemplate {
  template_id: string
  definition_id: string
  title: string
  category: string
  icon?: string
  description?: string
  default_props?: Record<string, unknown>
  default_bindings?: BindingSpec[]
  suggested_layout?: LayoutSpec
}

interface BlockInstance {
  id: string
  page_id: string
  definition_ref: {
    package_id: string
    definition_id: string
    version: string
  }
  template_ref?: string
  props: Record<string, unknown>
  bindings: BindingSpec[]
  layout: LayoutSpec
  state_ref?: string
}

interface Resource {
  id: string
  kind: "query" | "table" | "database" | "parameter" | "action" | "dataset"
  schema: JsonSchema
  refresh_policy?: RefreshPolicy
}
```

---

## 5. Definitions, templates, and instances

This distinction is important and should stay explicit.

### 5.1 Block definition

A definition is the reusable executable component contract.

It declares:

- what props it accepts
- what inputs it can consume
- what outputs it can emit
- what permissions it needs
- how it runs

Example:

- `kpi_card`
- `chart_panel`
- `collection_view`
- `date_filter`

### 5.2 Block template

A template is a curated preset built on a definition.

It supplies:

- default title
- default props
- default bindings
- category/icon
- suggested layout

Example:

- `Revenue KPI`
- `Upcoming meetings`
- `Published posts by status`

### 5.3 Block instance

An instance is the concrete thing on a page.

It stores:

- which definition it uses
- optional template lineage
- current props
- current bindings
- current layout
- persisted local state reference

### 5.4 Why both definition and template are required

If the system has only templates:

- versioning gets muddy
- reuse gets muddy
- forking behavior gets muddy

Definitions give you executable identity. Templates give you user-friendly starting points.

---

## 6. First-party and user-authored packages

There is one package system with three trust classes.

### 6.1 Bundled packages

Shipped with holaOS.

Examples:

- text and rich content blocks
- chart blocks
- collection blocks
- control blocks
- action blocks

These are first-party, but not architecturally privileged.

### 6.2 Verified packages

Installed from a marketplace or organization-approved source.

These may have broader permissions than purely local packages, depending on product policy.

### 6.3 Local packages

Created by the user or agent inside the workspace.

These are the main mechanism for "vibe coded" custom blocks.

---

## 7. Resources and bindings

This is where most of the product structure should live.

### 7.1 Resources

Blocks should not reach into random hidden state. They should bind to typed resources.

Useful resource kinds:

- `query`
- `database`
- `table`
- `parameter`
- `action`
- `dataset`

Some resources are page-scoped, some workspace-scoped.

### 7.2 Bindings

Bindings connect:

- resource -> block input
- block output -> block input
- parameter -> resource input
- parameter -> block input

Sketch:

```ts
interface BindingSpec {
  target_input: string
  source:
    | { kind: "resource"; resource_id: string; path?: string }
    | { kind: "block_output"; block_id: string; output: string; path?: string }
    | { kind: "literal"; value: unknown }
}
```

### 7.3 Why bindings matter

Bindings are the balance point between flexibility and structure.

They let the platform understand:

- what data a block depends on
- how filters propagate
- what can be rewired by an agent
- what can be validated statically

Without typed bindings, a page becomes a pile of opaque apps.

---

## 8. Runtime contract

Every block definition runs inside a sandboxed host controlled by the platform.

### 8.1 Execution modes

Initial execution modes:

- `iframe`
- `worker`

`iframe` is the expected default for UI-heavy blocks. This aligns with the existing direction of app-surface isolation work. See [2026-04-01-app-surface-iframe-migration.md](/Users/jeffrey/Desktop/holaboss/holaOS-oss-feat-dashboard-design/docs/plans/2026-04-01-app-surface-iframe-migration.md).

### 8.2 Runtime responsibilities

The runtime should provide:

- mount / unmount
- prop delivery
- input delivery
- output publication
- storage APIs
- permission mediation
- error boundaries

### 8.3 Permissions

Permissions should be explicit in the definition manifest.

Examples:

- read query results
- read workspace databases
- trigger actions
- network access
- file access
- persistent storage

The platform should decide which permission sets are allowed for:

- bundled packages
- verified packages
- local packages

---

## 9. Capability taxonomy

Definitions should advertise capabilities so the system and agents can reason about them without hardcoding product-specific type unions.

Initial capability classes:

- `text`
- `layout`
- `visualization`
- `collection_view`
- `controller`
- `action`
- `data_consumer`
- `data_producer`

These are not block types. They are traits.

Examples:

| Definition | Capabilities |
|---|---|
| `rich_text` | `text` |
| `grid_container` | `layout` |
| `kpi_card` | `visualization`, `data_consumer` |
| `collection_view` | `collection_view`, `data_consumer` |
| `date_range_filter` | `controller`, `data_producer` |
| `run_workflow_button` | `action` |

---

## 10. User flow

The user journey should feel progressively more powerful without exposing too much machinery too early.

### 10.1 Recommended progression

1. Insert a block from a template
2. Rebind its data
3. Change props and layout
4. Duplicate or fork the instance
5. Fork the underlying definition into a local package
6. Publish the package if it becomes reusable

### 10.2 Forking semantics

There should be two distinct actions:

- **Duplicate instance**: copy the block on the page with the same definition
- **Fork definition**: create a new local definition derived from the current one

That avoids confusing a page-level edit with a reusable component edit.

---

## 11. Agent tool surface

Agents should operate on the same model users do.

Suggested tool families:

- `pages.create`
- `pages.update`
- `blocks.insert`
- `blocks.update`
- `blocks.move`
- `blocks.remove`
- `blocks.duplicate`
- `blocks.fork_definition`
- `resources.create_query`
- `resources.create_parameter`
- `resources.update`
- `bindings.connect`
- `bindings.disconnect`
- `packages.create`
- `packages.publish`

The important point is that the agent should not need a separate "special native block" API surface.

---

## 12. Example mental model

Under this architecture:

- `KPI Card` is a bundled first-party `BlockDefinition`
- `Revenue KPI` is a first-party `BlockTemplate`
- `My weekly MRR delta card` is a `BlockInstance`
- `My benchmark-aware radial KPI` can become a local forked `BlockDefinition`
- if that becomes useful across pages, it can be published as a workspace or marketplace package

This is the exact symmetry we want:

- first-party and user-authored blocks are the same kind of thing
- only trust, packaging, and polish differ

---

## 13. Why this is the right balance

### 13.1 If the product is too structured

- every new idea requires product work
- users are trapped inside predefined visual grammar
- agent creativity is artificially capped

### 13.2 If the product is too flexible

- every page becomes a pile of unrelated mini-apps
- cross-block composition becomes weak
- permissions and debugging become messy
- agents lose reliable semantics

### 13.3 The balance

This architecture keeps structure in:

- resources
- bindings
- page model
- permissions
- versioning

And keeps flexibility in:

- block implementation
- UI
- behavior
- packaging

That is the intended balance: **one extension model, many packages, strong composition primitives**.

---

## 14. Open questions

These are still unresolved and should be answered in follow-up docs before implementation:

1. Should every query be represented as a first-class `Resource`, or can some first-party packages encapsulate private query definitions safely?
2. What permissions are allowed for local packages by default?
3. What is the package authoring format inside a workspace: file-based manifest, generated app scaffold, or database-backed artifact with a generated file mirror?
4. How should package version upgrades affect existing block instances?
5. Should outputs be pull-based, push-based, or both?
6. Which first-party package set should ship in v1?

---

## 15. Immediate next step

The next doc should define the concrete schemas and lifecycle for:

- `PortSchema`
- `PermissionSpec`
- `RuntimeSpec`
- `LayoutSpec`
- package manifest layout
- fork/publish/version semantics

That is the layer needed before any implementation plan makes sense.
