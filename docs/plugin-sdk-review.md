# Plugin Template SDK — Review Notes

Review of the plugin-template SDK and its first consumer, against the code as it
stands. Companion to the builder guide in [`plugin-sdk.md`](./plugin-sdk.md);
that doc says *how to use* the SDK, this one is *what I'd change*.

Files reviewed:

- `runtime/api-server/src/plugin-template-sdk.ts` — core SDK
- `runtime/api-server/src/plugin-templates.ts` — Research Feed (only consumer)
- `runtime/api-server/src/plugin-template-prompt-scaffold.ts` — shared prompt
- `apps/desktop/src/plugin-surfaces/{registry,sdk,useStartPluginOperation}.ts`

**Verdict:** the layering is right and the abstraction earns its keep — domain
templates drop to a declarative spec, mechanics (identity collision, upserts,
prompt composition, transactions) live in one place, and the surface registry
keeps UI out of the runtime. The findings below are about hardening the
contract before a second and third template land and bake today's rough edges
into precedent. Nothing here is a blocker; #1 and #2 are the ones worth doing
*before* the next template author copies the Research Feed shape.

---

## Priority

| # | Severity | Finding | Fix size |
|---|----------|---------|----------|
| 1 | High (DX) | `PluginTemplateSpec` isn't generic over its config type — every callback gets `unknown` and templates cast | Medium |
| 2 | High (DX) | `configureFields` *replaces* `fields`, so the full field set is duplicated and can silently drift | Small–Medium |
| 3 | Med | `spec.workflowVariables` is collected but never surfaced (not in payload, not attached to workflows) | Small |
| 4 | Med | Spec validation runs per-call after writes, not once at `defineTemplate` | Small |
| 5 | Med | `TEMPLATE_PAYLOAD_PLACEHOLDER_PLUGIN` sentinel cast runs the description callback at module load | Small–Medium |
| 6 | Low | Non-null assertions on `objects[...]` lookups hide misconfiguration | Small |
| 7 | Low | `cleanupAbandonedDraftsForTemplate` cascade-deletes `in_progress` drafts on every start | Confirm intent |
| 8 | Low | Docs nits + no direct SDK unit test | Small |

---

## 1. Thread the config type through the spec (generic `PluginTemplateSpec<TConfig>`)

`parseInstantiationConfig: (input: unknown) => unknown` returns `unknown`, and
every downstream callback (`resolveInstantiationContext`, `configureFields`,
`buildSurface`, `instantiateWorkflows`) receives `typedConfig: unknown | null`.
The result is that the one real template casts on every access:

```ts
// plugin-templates.ts
const config = typedConfig as ResearchFeedOnboardingConfig | null;   // ×3
const object = objects.research_report!;                              // ×2
const config = typedConfig as ResearchFeedOnboardingConfig;          // ×2 more
```

`parseInstantiationConfig` is *exactly* the validation boundary that should
mint a real type — after it runs, everything downstream knows the shape. Making
the spec generic lets the SDK carry that type for free:

```ts
export interface PluginTemplateSpec<TConfig> {
  parseInstantiationConfig: (input: unknown) => TConfig;
  resolveInstantiationContext: (cfg: TConfig) => { ... };
  objects: PluginObjectSpec<TConfig>[];        // configureFields(cfg: TConfig | null)
  dashboards: PluginDashboardSpec<TConfig>[];  // buildSurface(... typedConfig: TConfig | null)
  instantiateWorkflows?: (ctx: { typedConfig: TConfig; ... }) => ...;
}

export function defineTemplate<TConfig>(
  spec: PluginTemplateSpec<TConfig>,
): WorkspacePluginTemplateDefinition { ... }
```

`TConfig` is inferred from `parseInstantiationConfig`'s return, so a template
author writes the parser once and every callback is typed — no casts, and a
typo in a config field becomes a compile error instead of a runtime
`undefined`. This is the single highest-leverage change while there's still
only one consumer to migrate.

## 2. `configureFields` should *patch* fields, not replace them

Today `configureFields`, when present, returns the **entire** field list and
the static `fields` array is ignored
(`buildPluginShellFromSpec`: `objectSpec.configureFields ? configureFields(...) : fields`).
In Research Feed that means the full six-field schema is written **twice** —
once in `fields` (lines ~174–214) and again, nearly identically, in
`configureFields` (lines ~222–254) — differing only in the `type` enum's
`options`. Any future field edit has to be made in both places or they drift,
and `fields` is still *required* by the type even though it's dead when
`configureFields` exists.

Two ways out, either is fine:

- **Patch API:** `configureFields(ctx: { fields: PluginFieldSpec[]; typedConfig })`
  receives the static `fields` and returns a modified copy — author edits one
  field, not the list.
- **Per-field resolver:** allow `config` (or the whole field) to be a function
  of `typedConfig`, e.g. `config: (cfg) => ({ options: cfg?.categories ?? [] })`.
  Then Research Feed's `configureFields` disappears entirely.

The patch API is the smaller change and reads better at the call site.

## 3. `workflowVariables` is a dead spec field

`spec.workflowVariables` is typed and set
(`plugin-templates.ts:148` → `RESEARCH_FEED_WORKFLOW_VARIABLE_DECLS`) but the
SDK never consumes it: `buildTemplatePayload` emits `plugin_variables` and
**not** `workflow_variables`, and the workflow records get their
`declared_variables` from the template hand-copying the same const into
`metadata.declared_variables` (`plugin-templates.ts:344`). So the field looks
load-bearing but is inert, and the real wiring is manual duplication.

Pick one:

- **Surface it:** add `workflow_variables` to `WorkspacePluginTemplatePayload`
  and have `instantiate` stamp `declared_variables: spec.workflowVariables`
  onto each created workflow's metadata automatically (template stops copying
  the const).
- **Drop it** from the spec if the editor reads `declared_variables` off the
  workflow record and the payload doesn't need it.

Right now it's the worst of both — present, typed, and doing nothing.

## 4. Validate the spec at `defineTemplate`, not per call

The "must declare at least one object and one dashboard" guard lives inside
both `startOnboarding` and `instantiate`, *after* `buildPluginShellFromSpec`
has already created the plugin/base/objects in the transaction (it rolls back,
but it's wasted work and a late failure). A malformed template also isn't
caught until a user clicks it.

Move structural checks (`objects.length >= 1`, `dashboards.length >= 1`, unique
`idSuffix`/`slugSuffix`, non-empty `id`/`version`) into `defineTemplate` so a
bad spec throws at module load — the same place `buildTemplatePayload` already
runs. Definition-time failure is a build/boot error, not a user-facing one.

## 5. The placeholder-plugin sentinel is fragile

`buildTemplatePayload` renders each object's `description(...)` with
`TEMPLATE_PAYLOAD_PLACEHOLDER_PLUGIN`, a `{} as unknown as WorkspacePluginRecord`
sentinel, to produce the template-chooser blurb. This runs at module load and
assumes the callback only ever touches `plugin.name`/`plugin.slug`. A callback
that reads anything else (e.g. `plugin.config.x`) silently renders `"{plugin}"`
noise or throws at import.

Cleaner: split the fixed-structure description from the per-instance one — make
the chooser blurb a plain `string` on the object spec (`displayDescription`),
and keep the `(ctx) => string` form only for the instance-time description.
Then no sentinel, and the constraint ("don't reference instance fields in the
chooser blurb", currently a comment) becomes structural.

## 6. Replace `objects[...]!` lookups with a checked accessor

`shell.objects[firstObject.idSuffix]!` (×2 each in start/instantiate) and the
templates' `objects.research_report!` lean on non-null assertions. If an
`idSuffix` is mistyped in `buildSurface`/`instantiateWorkflows`, `!` turns a
config error into a downstream `undefined`. A one-liner helper —
`requireObject(objects, "research_report")` that throws
`object "<suffix>" not declared on template "<id>"` — gives a pinpoint message
instead. (Generic keying from #1 makes the `firstObject` ones disappear too.)

## 7. Confirm the abandoned-draft sweep is meant to nuke `in_progress`

`cleanupAbandonedDraftsForTemplate` runs on every
`startWorkspacePluginTemplateOnboarding` and cascade-deletes *every* plugin of
the same template whose `onboarding_status` is `pending` **or** `in_progress`.
The comment frames this as clearing orphaned drafts, but `in_progress` means
the user got partway through a real onboarding. Net effects to confirm are
intended:

- A user can never have two in-flight drafts of the same template; starting one
  silently destroys the other (and cascades its workflows/bases via
  `cascadeDeleteWorkspacePlugin`).
- The cascade relies on `deleteBase` cascading objects/fields/dashboards — worth
  a one-line assertion in `store.ts` or a test so a future store change doesn't
  leak rows.

If concurrent drafts should be possible, scope the sweep to truly-abandoned
(e.g. `pending` only, or older than N minutes) rather than all `in_progress`.

## 8. Docs nits + test gap

- `plugin-sdk.md` spec reference (~line 341) shows `onboardingCompleteRule: string`
  as required; it's optional in code (`onboardingCompleteRule?: string`). Same
  block omits `operations?` and `draftPluginConfig?`.
- The guide should warn about the #2 duplication footgun until it's fixed, and
  note that `workflowVariables` (#3) is currently inert.
- There's `plugin-templates.test.ts` but no `plugin-template-sdk.test.ts`. The
  SDK has logic worth pinning independently of any template: identity collision
  avoidance (`nextAvailablePluginIdentity` suffixing), payload synthesis with
  the sentinel, the spec-validation guard from #4, and transaction rollback on a
  throwing `instantiateWorkflows`.

---

## Smaller notes (not worth a section)

- `nextAvailablePluginIdentity` pages `listWorkspacePlugins({ limit: 500 })`; a
  workspace past 500 plugins could collide. Fine for now — leave a comment.
- `slugifyForPlugin` always sets `pluginId === slug`; the separate
  `usedPluginIds` check only matters for legacy rows where they diverged. OK,
  just non-obvious.
- `version` is stored on the plugin row but nothing reads it for migration.
  Fine to defer, but "bump on breaking changes" implies a migration story that
  doesn't exist yet — say so in the doc.
- `useStartPluginOperation` throws on blank inputs but the surface caller must
  `catch`; consider a toast-on-failure convention documented in the surface SDK.

---

## Suggested order

1. **#1 generic config** + **#2 configureFields** together — they touch the same
   call sites and migrating Research Feed once is cheaper than twice.
2. **#4 eager validation** + **#6 checked accessor** — small, make failures loud.
3. **#3 workflowVariables** — decide surface-or-drop before template #2 copies
   the manual pattern.
4. **#5 sentinel** and **#8 docs/tests** — cleanup, no rush.
5. **#7** — just confirm intent; may be a no-op.
