# Plugin Template SDK

A guide for building a new plugin template (think: "Research Feed", "Meeting Notes", "Bug Triage") with the minimum hand-rolled code.

> **TL;DR** — Drop one `defineTemplate({...})` call into `plugin-templates.ts` and register it in `WORKSPACE_PLUGIN_TEMPLATE_DEFINITIONS`. If you need a custom dashboard view, add one React file + one `registerPluginSurface()` call + one import line in the surfaces barrel. You do **not** edit `WorkspaceOverviewPane.tsx`, `plugin-template-sdk.ts`, or the surface registry plumbing.

---

## What the SDK does for you

| You write | The SDK does |
|---|---|
| A declarative `PluginTemplateSpec` | Synthesizes the `WorkspacePluginTemplatePayload` (template chooser metadata) |
| Object + dashboard declarations | Calls `store.upsertBase` / `upsertBaseObject` / `upsertBaseField` / `upsertBaseDashboard` in the right order |
| A draft plugin name | Handles `(workspace_id, slug)` collision avoidance for repeated drafts |
| A domain prompt + completion rule | Composes the full onboarding system prompt, slotted into a shared scaffold |
| A config parser + workflow callback (instantiate path) | Wraps everything in a workspace transaction |

What the SDK does **not** know about (you still own these):

- Parsing the user's collected instantiation config (`parseInstantiationConfig`)
- Authoring workflow nodes/edges (`instantiateWorkflows`)
- Composing the dashboard surface's runtime config blob (`dashboards[].buildSurface`)
- Writing the React component that renders your custom dashboard surface

---

## Mental model

A plugin template is a recipe for spawning a **plugin instance** inside a workspace. The instance has:

- A **WorkspacePluginRecord** — the plugin row (name, icon, status, template id/version, config blob).
- A **Base** — a per-instance container the plugin owns.
- One or more **BaseObjects** — table-like schemas (`research_report`, `meeting_note`, etc.) with fields.
- One or more **BaseDashboards** — each dashboard's `definition` carries a `plugin_surface = { kind, ...config }` blob that references a React component registered against `kind`.
- Zero or more **Workflows** — only authored from instantiation config if your template ships pre-baked workflows; chat-led templates let the onboarding agent author them at runtime.

The template `kind` strings are stored in the database; the React components that render them are looked up at runtime via the surface registry (see [Surfaces](#dashboard-surfaces) below).

---

## Step-by-step: build a new template

### 1. Add a `defineTemplate({...})` block

Open `runtime/api-server/src/plugin-templates.ts`. Below the existing Research Feed block, add your template:

```ts
import { defineTemplate, type WorkspacePluginTemplateDefinition } from "./plugin-template-sdk.js";

const MEETING_NOTES_TEMPLATE_DEFINITION: WorkspacePluginTemplateDefinition = defineTemplate({
  id: "meeting_notes",
  version: "1",
  name: "Meeting Notes",
  icon: "📓",
  summary: "...",
  description: "...",
  draftPluginName: "Meeting Notes Draft",
  pluginVariables: [],
  workflowVariables: [/* keys your workflows will reference as {{workflow.<key>}} */],
  baseDescription: ({ plugin }) => `Meeting Notes base for ${plugin.name}.`,
  objects: [/* see below */],
  dashboards: [/* see below — N entries allowed, materialized in spec order */],
  operations: [/* optional — dashboard affordances that spawn a primed main session, see below */],
  onboarding: {/* see below */},
  parseInstantiationConfig: (input) => {/* parse → typed config */},
  resolveInstantiationContext: (typedConfig) => ({
    pluginName: /* derive from config */,
    pluginDescription: /* derive from config */,
    pluginConfig: typedConfig as Record<string, unknown>,
  }),
  // Optional — omit if your template has no programmatic instantiate path
  // (i.e. all workflows are authored by the onboarding agent in chat).
  instantiateWorkflows: ({ typedConfig, plugin, objects }) => [/* WorkflowInstantiation[] */],
});

// Register it
const WORKSPACE_PLUGIN_TEMPLATE_DEFINITIONS: Record<string, WorkspacePluginTemplateDefinition> = {
  research_feed: RESEARCH_FEED_TEMPLATE_DEFINITION,
  meeting_notes: MEETING_NOTES_TEMPLATE_DEFINITION,
};
```

### 2. Declare your objects + fields

Each object becomes a `BaseObject`; each field becomes a `BaseField`:

```ts
objects: [
  {
    idSuffix: "meeting_note",      // objectId = `${pluginId}_meeting_note`
    slugSuffix: "meeting-note",     // slug = `${pluginSlug}-meeting-note`
    name: "meeting_note",
    description: ({ plugin }) => `Meeting notes for ${plugin.name}.`,
    fields: [
      { key: "title", label: "Title", fieldType: "string", semanticRole: "title", isRequired: true },
      { key: "attendees", label: "Attendees", fieldType: "string" },
      { key: "transcript", label: "Transcript", fieldType: "text" },
      { key: "summary", label: "Summary", fieldType: "text" },
      { key: "occurred_at", label: "Occurred at", fieldType: "datetime", semanticRole: "primary_timestamp" },
    ],
    // Use configureFields when a field's config depends on instantiation
    // input (e.g. enum options derived from collected user choices).
    // typedConfig is `null` during startOnboarding and the parsed config
    // during instantiate.
    configureFields: ({ typedConfig }) => [/* override fields[] entirely */],
  },
],
```

Valid `fieldType` values come from `BaseFieldType` in `runtime/state-store/src/store.ts` — `string`, `text`, `number`, `boolean`, `enum`, `status`, `date`, `datetime`, `money`, `percent`, `json`, `foreign_key`, `attachment`, `formula`, `lookup`, `rollup`, plus a few system field types.

### 3. Declare your dashboards

```ts
dashboards: [
  {
    idSuffix: "feed",                       // dashboardId = `${pluginId}_feed`
    name: "Feed",                            // user-visible label
    description: "Browse meeting notes by date.",
    buildSurface: ({ plugin, objects, typedConfig }) => ({
      kind: "meeting_note_browser",          // the React surface key (see Surfaces below)
      config: {
        object_id: objects.meeting_note.objectId,
        object_slug: objects.meeting_note.slug,
        // any other config your surface component needs
      },
    }),
  },
],
```

If you reuse an existing surface kind (like `research_report_browser`), no extra React work needed — just emit the config that surface expects.

### 4. Author the onboarding prompt

```ts
onboarding: {
  title: "Start Meeting Notes onboarding",
  description: "Short blurb shown on the template chooser.",
  welcomeMessage: "Hi! Let's set up your Meeting Notes plugin. ...",
  collectionGuidance: ["Source of recordings", "Tagging conventions", ...],
  workflowConstraints: [/* extra template-specific rules — the SDK auto-injects the "every workflow must end in object_write into one of this plugin's objects" rule */],
  domainPrompt: `# Meeting Notes onboarding

## Your role
...

## What is fixed (do not try to change)
...

## What you are collecting
...

## Interview flow
...

## Workflow shape (what you construct)
...`,
  onboardingCompleteRule:
    "Call plugin_onboarding_complete when at least one meeting-note workflow is saved AND the user confirms they are done. Do not call it preemptively.",
},
```

The shared scaffold automatically appends a `## Workflow constraints` section (universal terminus rule + any `workflowConstraints` you supply), a `## Completion` section (with your `onboardingCompleteRule` verbatim), and the universal `## Style` block. You do **not** include those yourself — and you do not need to spell out the "every workflow must end in `object_write` into one of this plugin's own objects" rule in your `domainPrompt`; the SDK derives the object list from `spec.objects` and emits it.

The global plugin-onboarding runtime prompt (in `agent-runtime-prompt.ts`) already supplies cross-cutting guidance — the `plugin_workflow_create → plugin_workflow_variable_set → plugin_workflow_test` sequence, `plugin_rename` usage, variable substitution semantics. Do not duplicate those in your `domainPrompt`.

### 5. Parse the instantiation config

`parseInstantiationConfig` runs once at the top of `instantiate` and produces the typed value that flows into `resolveInstantiationContext`, `configureFields`, `buildSurface`, and `instantiateWorkflows`. Throw on invalid input.

```ts
interface MeetingNotesConfig {
  plugin_name: string;
  recording_source: string;
}

parseInstantiationConfig: (input: unknown): MeetingNotesConfig => {
  if (!input || typeof input !== "object") throw new Error("config must be an object");
  const candidate = input as Record<string, unknown>;
  const plugin_name = requiredString(candidate.plugin_name, "plugin_name");
  const recording_source = requiredString(candidate.recording_source, "recording_source");
  return { plugin_name, recording_source };
},

resolveInstantiationContext: (typedConfig) => {
  const config = typedConfig as MeetingNotesConfig;
  return {
    pluginName: config.plugin_name,
    pluginDescription: `Meeting Notes instance for ${config.plugin_name}.`,
    pluginConfig: config as Record<string, unknown>,
  };
},
```

### 6. (Optional) Pre-bake workflows in `instantiateWorkflows`

If your template ships ready-to-use workflows, return them from `instantiateWorkflows`. The SDK calls `store.createWorkflow` for each entry inside the same transaction.

```ts
instantiateWorkflows: ({ typedConfig, plugin, objects, templateId, templateVersion }) => [
  {
    workflowId: `${plugin.pluginId}__nightly_summary`,
    name: "Nightly summary",
    description: "Summarizes today's meeting notes at 10pm.",
    nodes: [/* WorkflowNodeRecord[] — same shape you'd build by hand today */],
    edges: [/* WorkflowEdgeRecord[] */],
    metadata: {
      plugin_id: plugin.pluginId,
      template_id: templateId,
      template_version: templateVersion,
      declared_variables: [/* WorkflowVariableDecl[] */],
      variables: {/* initial variable values */},
    },
  },
],
```

If your template is chat-led (the onboarding agent authors workflows at runtime via `plugin_workflow_create`), **omit** `instantiateWorkflows` entirely.

### 7. (Optional) Declare operations

Operations are template-declared "starting points" surfaced as affordances on the dashboard. Clicking one spawns a fresh main session bound to the plugin and pre-seeds it with a synthetic assistant turn from `assistantPrefill` — the agent then drives the operation in chat.

```ts
operations: [
  {
    id: "add_category",                       // stable, addressed by surface buttons
    label: "Add category",                    // surfaced on the affordance
    assistantPrefill: ({ plugin }) => [
      `Let's add a new research category to **${plugin.name}**.`,
      "",
      "Tell me what you'd like to track and where I should look.",
    ].join("\n"),
  },
],
```

`assistantPrefill` receives the concrete `WorkspacePluginRecord`, so the seed text can name the plugin and bind tool calls. Keep the text plain-spoken — it lands as the first message a user reads in the spawned session. Avoid runtime jargon (`plugin_id`, node graph language, cron, enum types); use the user's vocabulary.

Surfaces dispatch operations through `useStartPluginOperation` from `@/plugin-surfaces/sdk`:

```tsx
const startOperation = useStartPluginOperation();
await startOperation({ workspaceId, pluginId, operationId: "add_category" });
```

---

## Dashboard surfaces

The store treats `BaseDashboardRecord.definition` as opaque — there is no declarative dashboard UI in the database. Your dashboard's `buildSurface` returns a `{ kind, config }` blob; at render time, `WorkspaceOverviewPane` looks up a React component by `kind` in the surface registry and hands it the config.

### Reuse an existing surface kind

If your template fits an existing surface (e.g. `research_report_browser`), set `kind` to its string and emit the config it expects. No new code.

### Write a new surface

If you need a custom view, follow this three-step pattern:

**A.** Write the React component. Place it anywhere logical (`apps/desktop/src/components/...`). It should accept the `PluginSurfaceProps` shape:

```tsx
import type { PluginSurfaceProps } from "@/plugin-surfaces/sdk";

export function MeetingNoteBrowser(props: PluginSurfaceProps) {
  const { workspaceId, pluginId, schema, surfaceConfig } = props;
  // parse surfaceConfig — it's the raw blob you emitted from buildSurface
  // render whatever React you want
  return <div>...</div>;
}
```

**B.** Register the kind. Add a new file under `apps/desktop/src/plugin-surfaces/`:

```tsx
// apps/desktop/src/plugin-surfaces/meeting-note-browser.tsx
import { registerPluginSurface } from "./registry";
import { MeetingNoteBrowser } from "@/components/.../MeetingNoteBrowser";

registerPluginSurface("meeting_note_browser", MeetingNoteBrowser);
```

**C.** Wire the registration into the barrel. Add one import line to `apps/desktop/src/plugin-surfaces/index.ts`:

```ts
import "./builtin";
import "./meeting-note-browser";   // <-- add this
```

Done. `WorkspaceOverviewPane` does not change.

### Platform API for surfaces

Surface authors should `import { ... } from "@/plugin-surfaces/sdk"` for any cross-cutting behavior. Currently re-exported:

| Hook | Purpose |
|---|---|
| `useStageMainSessionEntity` | The `@`-into-chat behavior for records. Spawns a new main session titled with the record's title, attaches a JSON descriptor of the record, and prefills the composer with an `@mention`. Use from any "ask about this record in chat" affordance. |
| `useStartPluginOperation` | Click handler for template-declared operations. Spawns a new main session bound to the plugin, server-pre-seeded with the operation's `assistantPrefill`, and switches the right pane onto that session. |
| `useOpenIssueDetailTab` | Open an issue inside the internal tab strip. |
| `useOpenWorkspaceOutput` | Open workspace outputs (files, URLs) in the browser tab strip. |
| `findBrowserTabMatch` | Find an existing browser tab matching a URL/file — useful for "open or focus" semantics. |

Do not reach past this aggregator into `components/layout/shell/*` from surface code. If your surface needs a platform capability that isn't re-exported yet, add it to `sdk.ts` and update this doc — that's the contract, not arbitrary internal imports.

---

## Spec reference

The full `PluginTemplateSpec` shape, from `runtime/api-server/src/plugin-template-sdk.ts`:

```ts
interface PluginTemplateSpec {
  id: string;                       // template_id, e.g. "research_feed"
  version: string;                  // bump on breaking spec changes
  name: string;                     // display name in the chooser
  icon: string;                     // single emoji or short string
  summary: string;                  // one-line catalog blurb
  description: string;              // longer description
  draftPluginName: string;          // name used while the user is still onboarding

  pluginVariables: PluginVariableDecl[];      // plugin-global variables — {{plugin.<key>}}
  workflowVariables: WorkflowVariableDecl[];  // workflow-local variables — {{workflow.<key>}}

  objects: PluginObjectSpec[];      // ≥1 required
  dashboards: PluginDashboardSpec[]; // ≥1 required (N supported, spec order preserved)
  operations?: PluginOperationSpec[]; // optional dashboard affordances

  baseDescription: (ctx: { plugin }) => string;

  onboarding: {
    title: string;
    description: string;
    welcomeMessage: string;
    collectionGuidance: string[];
    workflowConstraints: string[];
    domainPrompt: string;
    onboardingCompleteRule: string;
  };

  // Optional override; defaults to { onboarding_mode: "chat", onboarding_status: "pending", collected_context: {} }
  draftPluginConfig?: () => Record<string, unknown>;

  parseInstantiationConfig: (input: unknown) => unknown;
  resolveInstantiationContext: (typedConfig: unknown) => {
    pluginName: string;
    pluginDescription: string;
    pluginConfig: Record<string, unknown>;
  };

  instantiateWorkflows?: (ctx: {
    typedConfig: unknown;
    plugin; base; objects: Record<string, BaseObjectRecord>;
    templateId: string; templateVersion: string;
  }) => PluginWorkflowInstantiation[];
}
```

### Field types

```ts
interface PluginFieldSpec {
  key: string;
  label: string;
  fieldType: BaseFieldType;       // see store.ts for the full union
  semanticRole?: string | null;   // "title" | "status" | "primary_timestamp" | ...
  isRequired?: boolean;
  isSystem?: boolean;
  defaultValue?: unknown;
  config?: Record<string, unknown> | null;   // e.g. { options: [...] } for enum/status
}
```

Field `position` is auto-assigned by array order — don't pass it.

### Object spec

```ts
interface PluginObjectSpec {
  idSuffix: string;     // → objectId = `${pluginId}_${idSuffix}`
  slugSuffix: string;   // → slug = `${pluginSlug}-${slugSuffix}`
  name: string;         // logical name stored on the row (snake_case)
  description: (ctx: { plugin }) => string;
  fields: PluginFieldSpec[];
  configureFields?: (ctx: { typedConfig: unknown | null }) => PluginFieldSpec[];
}
```

`configureFields`, when present, **replaces** `fields` for that object. Use it when a field's config depends on the instantiation input (e.g. enum options derived from user-collected categories).

### Dashboard spec

```ts
interface PluginDashboardSpec {
  idSuffix: string;
  name: string;
  description: string;
  buildSurface: (ctx: {
    plugin;
    objects: Record<string, BaseObjectRecord>;  // keyed by object's idSuffix
    typedConfig: unknown | null;
  }) => { kind: string; config: Record<string, unknown> };
}
```

### Operation spec

```ts
interface PluginOperationSpec {
  id: string;     // stable id — surfaces address an operation by this string
  label: string;  // affordance label
  assistantPrefill: (ctx: { plugin: WorkspacePluginRecord }) => string;
  // Resolved server-side at click time; becomes the synthetic assistant
  // turn seeded into the spawned main session.
}
```

---

## Scope boundaries

What the SDK supports and what it deliberately leaves out:

- **One object per plugin** is the surfaced contract — `PluginTemplateInstantiationResult.object` is singular. The shell builder supports multiple internally; lifting this is a follow-up when a template needs it.
- **Multiple dashboards per plugin** are supported. Declare them as `dashboards: [...]` in spec order; the SDK materializes all of them and the result returns `dashboards: BaseDashboardRecord[]`. Surfaces that need to pick a default treat `dashboards[0]` as canonical.
- **No declarative UI for surfaces.** A custom surface is a freeform React file; the store-side dashboard `definition` is opaque.
- **No declarative workflow DSL.** `instantiateWorkflows` returns `WorkflowNodeRecord[]` + `WorkflowEdgeRecord[]` directly.
- **No runtime-tool authoring from templates.** Templates consume the existing plugin runtime tools (`plugin_workflow_create`, `plugin_variable_set`, the `plugin_workflow_*` family). Adding a new tool is a platform-side concern.

---

## PR checklist for a new template

- [ ] `defineTemplate({...})` block added to `plugin-templates.ts` and registered in `WORKSPACE_PLUGIN_TEMPLATE_DEFINITIONS`.
- [ ] If a new surface kind: React component written, registration file added under `plugin-surfaces/`, barrel updated.
- [ ] If operations are declared: each `assistantPrefill` reads as plain user-facing text (no `plugin_id`, no workflow-node jargon, no cron syntax).
- [ ] `runtime/api-server` typecheck passes.
- [ ] `apps/desktop` typecheck passes.
- [ ] Optional: snapshot test pinning the SDK-composed `system_prompt` (mirror of `plugin-templates.test.ts`).
