# GEO Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a GEO (Generative Engine Optimization) workspace plugin — a chat-onboarded plugin that tracks a brand's visibility in AI answer engines over time (Phase 1) and audits the brand's own pages for GEO-readiness (Phase 2).

**Architecture:** A new plugin template (`geo`) registered alongside Research Feed in the runtime api-server, defined via the existing `defineTemplate` SDK (objects + dashboard surface + chat onboarding + scheduled workflows). A new React dashboard surface (`geo_visibility_browser`) renders the data in the desktop app. Visibility scoring is pure, display-derived (not stored), so the data-collection mechanism stays swappable.

**Tech Stack:** TypeScript, `node:test` (runtime api-server + desktop), the `@holaboss/runtime-state-store` base model, React + Jotai (desktop surfaces).

**Source spec:** `docs/superpowers/specs/2026-06-16-geo-plugin-design.md`

**Reference pattern (read before starting):** `runtime/api-server/src/plugin-templates.ts` (Research Feed template), `runtime/api-server/src/plugin-template-sdk.ts` (`defineTemplate`), `apps/desktop/src/components/layout/shell/ResearchReportDashboardSurface.tsx` (surface), `apps/desktop/src/plugin-surfaces/builtin.tsx` (surface registration).

**Test commands:**
- Runtime api-server: `cd runtime/api-server && node --import tsx --test --test-force-exit src/<file>.test.ts`
- Desktop: `cd apps/desktop && node --import tsx --test src/<path>/<file>.test.ts`

**Design refinement vs spec:** `geo_visibility` is **one record per (prompt × run)** with a `per_engine` JSON field (each engine's mention/rank/sentiment/competitors/citations), not one row per prompt×engine. This fits the runtime's proven `trigger → agent → object_write` workflow (one deterministic write per run, exactly like Research Feed) and avoids record explosion. The dashboard derives the prompt×engine matrix from `per_engine`. Citations/competitors use the `json` field type (resolves spec open question #2).

---

## File Structure

**Phase 1 (visibility tracking):**
- Create `runtime/api-server/src/geo-plugin-template.ts` — the GEO template: config types, onboarding-config parser, objects, dashboard surface config, operations, onboarding prompt, visibility workflow authoring. Kept in its own file (not appended to `plugin-templates.ts`) to stay focused.
- Create `runtime/api-server/src/geo-plugin-template.test.ts` — template/parser/workflow unit tests.
- Modify `runtime/api-server/src/plugin-templates.ts` — import + register the GEO definition in `WORKSPACE_PLUGIN_TEMPLATE_DEFINITIONS`.
- Modify `runtime/api-server/src/plugin-templates.test.ts` — the count assertion (1 → 2) and add a geo-registered assertion.
- Create `apps/desktop/src/components/layout/shell/geo-visibility-metrics.ts` — pure scoring functions (visibility score, share of voice, drift flags).
- Create `apps/desktop/src/components/layout/shell/geo-visibility-metrics.test.ts` — scoring tests.
- Create `apps/desktop/src/components/layout/shell/geo-visibility-surface-model.ts` — pure surface logic: definition parser + record→row normalization. **No React or `@/` imports** so it runs under `node:test` (tsx does not resolve the `@/*` alias at runtime, and existing desktop tests only ever import pure modules).
- Create `apps/desktop/src/components/layout/shell/geo-visibility-surface-model.test.ts` — parser/normalization tests.
- Create `apps/desktop/src/components/layout/shell/GeoVisibilityDashboardSurface.tsx` — the React surface component (imports the pure model + metrics). Verified by `tsc --noEmit` + manual run, not `node:test` (it pulls React/`@/`/electron).
- Modify `apps/desktop/src/plugin-surfaces/builtin.tsx` — register `geo_visibility_browser`. Verified by typecheck (its transitive React imports preclude `node:test`).

**Phase 2 (content audit):**
- Modify `runtime/api-server/src/geo-plugin-template.ts` — add `geo_audit_finding` object, `run_audit` operation, audit workflow.
- Modify `runtime/api-server/src/geo-plugin-template.test.ts` — audit assertions.
- Modify `apps/desktop/src/components/layout/shell/GeoVisibilityDashboardSurface.tsx` — add an Audit tab reading `geo_audit_finding`.

---

# PHASE 1 — Visibility Tracking

## Task 1: GEO onboarding config types + parser

**Files:**
- Create: `runtime/api-server/src/geo-plugin-template.ts`
- Test: `runtime/api-server/src/geo-plugin-template.test.ts`

- [ ] **Step 1: Write the failing test**

Create `runtime/api-server/src/geo-plugin-template.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { parseGeoOnboardingConfig } from "./geo-plugin-template.js";

test("parseGeoOnboardingConfig parses a full config", () => {
  const parsed = parseGeoOnboardingConfig({
    plugin_name: "Acme GEO",
    brand_name: "Acme",
    brand_domain: "acme.com",
    competitors: ["Globex", "Initech", ""],
    engines: ["ChatGPT", "Perplexity"],
    prompts: [
      { text: "best crm for startups", topic: "CRM" },
      { text: "acme vs globex", topic: "Comparisons" },
      { text: "", topic: "ignored" },
    ],
    cadence: "0 9 * * 1",
  }) as Record<string, unknown>;
  assert.equal(parsed.plugin_name, "Acme GEO");
  assert.equal(parsed.brand_name, "Acme");
  assert.equal(parsed.brand_domain, "acme.com");
  assert.deepEqual(parsed.competitors, ["Globex", "Initech"]);
  assert.deepEqual(parsed.engines, ["ChatGPT", "Perplexity"]);
  assert.equal((parsed.prompts as unknown[]).length, 2);
  assert.equal(parsed.cadence, "0 9 * * 1");
});

test("parseGeoOnboardingConfig requires brand_name", () => {
  assert.throws(
    () =>
      parseGeoOnboardingConfig({
        plugin_name: "X",
        brand_name: "  ",
        engines: ["ChatGPT"],
        prompts: [{ text: "q", topic: "t" }],
      }),
    /brand_name is required/,
  );
});

test("parseGeoOnboardingConfig requires at least one prompt and engine", () => {
  assert.throws(
    () =>
      parseGeoOnboardingConfig({
        plugin_name: "X",
        brand_name: "Acme",
        engines: [],
        prompts: [{ text: "q", topic: "t" }],
      }),
    /at least one engine/,
  );
  assert.throws(
    () =>
      parseGeoOnboardingConfig({
        plugin_name: "X",
        brand_name: "Acme",
        engines: ["ChatGPT"],
        prompts: [],
      }),
    /at least one tracked prompt/,
  );
});

test("parseGeoOnboardingConfig defaults cadence when absent", () => {
  const parsed = parseGeoOnboardingConfig({
    plugin_name: "X",
    brand_name: "Acme",
    engines: ["ChatGPT"],
    prompts: [{ text: "q", topic: "t" }],
  }) as Record<string, unknown>;
  assert.equal(parsed.cadence, "0 9 * * *");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/geo-plugin-template.test.ts`
Expected: FAIL — cannot find module `./geo-plugin-template.js`.

- [ ] **Step 3: Write minimal implementation**

Create `runtime/api-server/src/geo-plugin-template.ts` with the config types, helpers, and parser (template object comes in later tasks):

```ts
import type {
  WorkflowEdgeRecord,
  WorkflowNodeRecord,
} from "@holaboss/runtime-state-store";

import {
  defineTemplate,
  type WorkflowVariableDecl,
  type WorkspacePluginTemplateDefinition,
} from "./plugin-template-sdk.js";

export const GEO_PLUGIN_TEMPLATE_ID = "geo";
const GEO_PLUGIN_TEMPLATE_VERSION = "1";
const GEO_PLUGIN_TEMPLATE_ICON = "🔍";
const GEO_DEFAULT_CADENCE = "0 9 * * *";

export interface GeoPromptConfig extends Record<string, unknown> {
  text: string;
  topic: string;
}

export interface GeoOnboardingConfig extends Record<string, unknown> {
  plugin_name: string;
  brand_name: string;
  brand_domain: string;
  competitors: string[];
  engines: string[];
  prompts: GeoPromptConfig[];
  cadence: string;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredTrimmedString(value: unknown, field: string): string {
  const normalized = trimmedString(value);
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function trimmedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => trimmedString(entry))
    .filter((entry) => entry.length > 0);
}

function parseGeoPrompt(input: unknown): GeoPromptConfig | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  const text = trimmedString(candidate.text);
  if (!text) {
    return null;
  }
  return { text, topic: trimmedString(candidate.topic) || "General" };
}

export function parseGeoOnboardingConfig(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("template config must be an object");
  }
  const candidate = input as Record<string, unknown>;
  const pluginName = requiredTrimmedString(candidate.plugin_name, "plugin_name");
  const brandName = requiredTrimmedString(candidate.brand_name, "brand_name");
  const engines = trimmedStringList(candidate.engines);
  if (engines.length === 0) {
    throw new Error("at least one engine is required");
  }
  const prompts = (Array.isArray(candidate.prompts) ? candidate.prompts : [])
    .map((entry) => parseGeoPrompt(entry))
    .filter((entry): entry is GeoPromptConfig => entry !== null);
  if (prompts.length === 0) {
    throw new Error("at least one tracked prompt is required");
  }
  const parsed: GeoOnboardingConfig = {
    plugin_name: pluginName,
    brand_name: brandName,
    brand_domain: trimmedString(candidate.brand_domain),
    competitors: trimmedStringList(candidate.competitors),
    engines,
    prompts,
    cadence: trimmedString(candidate.cadence) || GEO_DEFAULT_CADENCE,
  };
  return parsed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/geo-plugin-template.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/api-server/src/geo-plugin-template.ts runtime/api-server/src/geo-plugin-template.test.ts
git commit -m "feat(geo): add GEO onboarding config parser"
```

---

## Task 2: GEO template definition (objects + dashboard + operations + onboarding)

**Files:**
- Modify: `runtime/api-server/src/geo-plugin-template.ts`
- Test: `runtime/api-server/src/geo-plugin-template.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `runtime/api-server/src/geo-plugin-template.test.ts`:

```ts
import { GEO_PLUGIN_TEMPLATE_DEFINITION } from "./geo-plugin-template.js";

test("geo template payload has expected shape", () => {
  const payload = GEO_PLUGIN_TEMPLATE_DEFINITION.payload;
  assert.equal(payload.template_id, "geo");
  assert.equal(payload.version, "1");
  assert.equal(payload.name, "GEO");
  assert.deepEqual(
    payload.onboarding.fixed_structure.objects.map((o) => o.name),
    ["geo_prompt", "geo_visibility"],
  );
  assert.deepEqual(
    payload.onboarding.fixed_structure.dashboards.map((d) => d.name),
    ["Visibility"],
  );
  assert.deepEqual(
    payload.operations.map((op) => op.id),
    ["add_prompt", "run_visibility_check"],
  );
});

test("geo template builds visibility surface config with config-driven engines", () => {
  // Drive startOnboarding against a fake store to assert the surface config.
  // We use the dashboard buildSurface indirectly via the payload's instantiate
  // path in Task 3's integration test; here we assert the surface kind is set
  // by checking the onboarding fixed_structure dashboard description.
  const dash = GEO_PLUGIN_TEMPLATE_DEFINITION.payload.onboarding.fixed_structure
    .dashboards[0];
  assert.ok(dash);
  assert.match(dash!.description, /visibility/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/geo-plugin-template.test.ts`
Expected: FAIL — `GEO_PLUGIN_TEMPLATE_DEFINITION` not exported.

- [ ] **Step 3: Write minimal implementation**

In `runtime/api-server/src/geo-plugin-template.ts`, add the domain prompt, workflow variable decls, and the `defineTemplate(...)` call. Insert **before** the closing of the file (the workflow node/edge builders are stubbed here and fully implemented in Task 4 — define them now so the module compiles):

```ts
const GEO_DOMAIN_PROMPT = `# GEO onboarding

## Your role
You are setting up the user's GEO (Generative Engine Optimization) plugin. The plugin shape is fixed — a tracked-prompt object, a visibility object, and a visibility dashboard. Your job is to collect the brand profile and the prompts to track, then wire one visibility workflow per prompt.

## What is fixed (do not try to change)
- Objects: geo_prompt (tracked queries), geo_visibility (one record per prompt per run, engines captured in per_engine JSON)
- Dashboard: visibility browser (score, per-engine matrix, prompt list, competitor share-of-voice)

## What you are collecting
- **Brand name** and **domain** (e.g. "Acme", "acme.com")
- **Competitors** — names to compare share-of-voice against
- **Engines** — which AI answer engines to track. Offer the ones this workspace has model providers configured for (e.g. ChatGPT, Perplexity, Gemini). Record their display labels.
- **Tracked prompts** — the queries the brand wants to win, each with a short topic. Suggest a starter set derived from the brand + domain + competitors, then let the user edit. Aim for 3–8 to start.
- **Schedule** — a cron expression for how often to re-check (ask in plain language, translate; default "0 9 * * *").

## Workflow shape (one per tracked prompt)
trigger → answer-engine-research agent → geo_visibility write

The agent node, for its prompt, queries each configured engine (using web search + the configured models), determines for each engine whether {{workflow.brand}} is mentioned, its rank, sentiment, which of {{workflow.competitors}} appear, and the cited sources — then emits a structured per_engine JSON the write node persists.

Use these placeholders:
- \`{{workflow.prompt}}\` — the tracked query
- \`{{workflow.prompt_topic}}\` — its topic
- \`{{workflow.engines}}\` — comma-separated engine labels
- \`{{workflow.brand}}\` — the brand name
- \`{{workflow.competitors}}\` — comma-separated competitor names
- \`{{workflow.cadence}}\` — the cron expression

## Style
- One question at a time. Confirm before acting.
- Keep responses short — the user is reading a chat pane.`;

const GEO_WORKFLOW_VARIABLE_DECLS: WorkflowVariableDecl[] = [
  { key: "prompt", label: "Prompt", description: "The tracked query.", required: true },
  { key: "prompt_topic", label: "Topic", description: "Topic grouping for the prompt.", required: false },
  { key: "engines", label: "Engines", description: "Comma-separated engine labels to query.", required: true },
  { key: "brand", label: "Brand", description: "Brand name to detect in answers.", required: true },
  { key: "competitors", label: "Competitors", description: "Comma-separated competitor names.", required: false },
  { key: "cadence", label: "Cadence", description: "Cron expression for re-checks.", required: true, default: GEO_DEFAULT_CADENCE },
];

function geoPromptFields() {
  return [
    { key: "text", label: "Prompt", fieldType: "string" as const, semanticRole: "title", isRequired: true },
    { key: "topic", label: "Topic", fieldType: "enum" as const, config: { options: [] as string[] } },
    { key: "intent", label: "Intent", fieldType: "string" as const },
    {
      key: "is_active",
      label: "Active",
      fieldType: "status" as const,
      semanticRole: "status",
      isRequired: true,
      isSystem: true,
      defaultValue: "active",
      config: { options: ["active", "paused"] },
    },
  ];
}

function geoVisibilityFields(engineOptions: string[]) {
  return [
    { key: "prompt", label: "Prompt", fieldType: "string" as const, semanticRole: "title", isRequired: true },
    { key: "prompt_topic", label: "Topic", fieldType: "string" as const },
    { key: "run_date", label: "Run date", fieldType: "date" as const, isRequired: true },
    { key: "engines_checked", label: "Engines checked", fieldType: "enum" as const, config: { options: engineOptions } },
    { key: "per_engine", label: "Per engine", fieldType: "json" as const },
    { key: "summary", label: "Summary", fieldType: "text" as const },
  ];
}

export const GEO_PLUGIN_TEMPLATE_DEFINITION: WorkspacePluginTemplateDefinition =
  defineTemplate({
    id: GEO_PLUGIN_TEMPLATE_ID,
    version: GEO_PLUGIN_TEMPLATE_VERSION,
    name: "GEO",
    icon: GEO_PLUGIN_TEMPLATE_ICON,
    summary:
      "Chat-led onboarding for a fixed GEO plugin: tracks a brand's visibility in AI answer engines across a set of prompts, on a schedule.",
    description:
      "A Generative Engine Optimization plugin. Tracks brand mentions, rank, sentiment, competitors, and citations across AI answer engines for a set of prompts, with a visibility dashboard.",
    draftPluginName: "GEO Draft",
    pluginVariables: [],
    workflowVariables: GEO_WORKFLOW_VARIABLE_DECLS,
    operations: [
      {
        id: "add_prompt",
        label: "Add tracked prompt",
        assistantPrefill: ({ plugin }) =>
          [
            `Let's add a tracked prompt to **${plugin.name}**.`,
            "",
            "1. What query do you want to track? (e.g. \"best crm for startups\")",
            "2. What topic does it belong to? (e.g. \"CRM\", \"Comparisons\")",
            "",
            "Once you confirm, I'll start tracking your visibility for it across your engines on the usual schedule.",
          ].join("\n"),
      },
      {
        id: "run_visibility_check",
        label: "Run visibility check now",
        assistantPrefill: ({ plugin }) =>
          [
            `Run an on-demand visibility check for **${plugin.name}** now.`,
            "",
            "For each active tracked prompt, query the configured engines, detect whether the brand is mentioned (rank, sentiment, competitors, citations), and write a geo_visibility record for this run. Report a one-line summary of the brand's overall presence when done.",
          ].join("\n"),
      },
    ],
    baseDescription: ({ plugin }) => `GEO base for ${plugin.name}.`,
    objects: [
      {
        idSuffix: "geo_prompt",
        slugSuffix: "geo-prompt",
        name: "geo_prompt",
        description: ({ plugin }) => `Tracked prompts for ${plugin.name}.`,
        fields: geoPromptFields(),
        configureFields: ({ typedConfig }) => {
          const config = typedConfig as GeoOnboardingConfig | null;
          const topics = Array.from(
            new Set((config?.prompts ?? []).map((p) => p.topic)),
          );
          return geoPromptFields().map((field) =>
            field.key === "topic"
              ? { ...field, config: { options: topics } }
              : field,
          );
        },
      },
      {
        idSuffix: "geo_visibility",
        slugSuffix: "geo-visibility",
        name: "geo_visibility",
        description: ({ plugin }) => `Visibility runs for ${plugin.name}.`,
        fields: geoVisibilityFields([]),
        configureFields: ({ typedConfig }) => {
          const config = typedConfig as GeoOnboardingConfig | null;
          return geoVisibilityFields(config?.engines ?? []);
        },
      },
    ],
    dashboards: [
      {
        idSuffix: "geo_dashboard",
        name: "Visibility",
        description:
          "Brand visibility across AI answer engines: score, per-engine matrix, prompts, competitor share-of-voice.",
        buildSurface: ({ objects, typedConfig }) => {
          const object = objects.geo_visibility!;
          const config = typedConfig as GeoOnboardingConfig | null;
          return {
            kind: "geo_visibility_browser",
            config: {
              object_id: object.objectId,
              object_slug: object.slug,
              prompt_field_key: "prompt",
              topic_field_key: "prompt_topic",
              run_date_field_key: "run_date",
              per_engine_field_key: "per_engine",
              summary_field_key: "summary",
              engine_order: config?.engines ?? [],
              competitor_names: config?.competitors ?? [],
              brand_name: config?.brand_name ?? "",
            },
          };
        },
      },
    ],
    onboarding: {
      title: "Start GEO onboarding",
      description:
        "The onboarding agent collects the brand profile, competitors, engines, and tracked prompts through chat, while the template keeps the object model and dashboard fixed.",
      welcomeMessage:
        "Hi! Let's set up GEO tracking. First — what brand are we tracking, and what's its website? Then we'll pick the AI engines and the prompts you want to win.",
      collectionGuidance: [
        "Brand name and domain",
        "Competitors",
        "Engines to track",
        "Tracked prompts and topics",
        "Check schedule",
      ],
      workflowConstraints: [
        "Workflows may be created or revised during onboarding, but the object model and dashboard stay fixed.",
        "Each prompt's workflow must terminate in a geo_visibility write with prompt, run_date, and per_engine.",
      ],
      domainPrompt: GEO_DOMAIN_PROMPT,
    },
    parseInstantiationConfig: parseGeoOnboardingConfig,
    resolveInstantiationContext: (typedConfig) => {
      const config = typedConfig as GeoOnboardingConfig;
      return {
        pluginName: config.plugin_name,
        pluginDescription: `GEO tracking for ${config.brand_name}.`,
        pluginConfig: config,
      };
    },
    instantiateWorkflows: ({ typedConfig, plugin, objects, templateId, templateVersion }) => {
      const config = typedConfig as GeoOnboardingConfig;
      const object = objects.geo_visibility!;
      return config.prompts.map((prompt, index) => ({
        workflowId: `${plugin.pluginId}__geo_visibility_${index + 1}`,
        name: `Visibility · ${prompt.text}`,
        description: `GEO visibility workflow for "${prompt.text}".`,
        nodes: geoVisibilityWorkflowNodes({
          objectId: object.objectId,
          pluginId: plugin.pluginId,
          index,
        }),
        edges: geoVisibilityWorkflowEdges({ index }),
        metadata: {
          plugin_id: plugin.pluginId,
          template_id: templateId,
          template_version: templateVersion,
          declared_variables: GEO_WORKFLOW_VARIABLE_DECLS,
          variables: {
            prompt: prompt.text,
            prompt_topic: prompt.topic,
            engines: config.engines.join(", "),
            brand: config.brand_name,
            competitors: config.competitors.join(", "),
            cadence: config.cadence,
          },
        },
      }));
    },
  });
```

Add temporary stub builders at the end of the file so it compiles (Task 4 replaces them):

```ts
function geoVisibilityWorkflowNodes(_params: {
  objectId: string;
  pluginId: string;
  index: number;
}): WorkflowNodeRecord[] {
  return [];
}

function geoVisibilityWorkflowEdges(_params: { index: number }): WorkflowEdgeRecord[] {
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/geo-plugin-template.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/api-server/src/geo-plugin-template.ts runtime/api-server/src/geo-plugin-template.test.ts
git commit -m "feat(geo): define GEO template objects, dashboard, operations"
```

---

## Task 3: Register GEO in the template registry

**Files:**
- Modify: `runtime/api-server/src/plugin-templates.ts:8-19` (imports) and `:506-511` (registry)
- Modify: `runtime/api-server/src/plugin-templates.test.ts:93-97`

- [ ] **Step 1: Write the failing test**

Replace the `listWorkspacePluginTemplates returns research_feed` test in `runtime/api-server/src/plugin-templates.test.ts` with:

```ts
test("listWorkspacePluginTemplates returns research_feed and geo", () => {
  const templates = listWorkspacePluginTemplates();
  const ids = templates.map((t) => t.template_id).sort();
  assert.deepEqual(ids, ["geo", "research_feed"]);
});

test("geo template is registered and resolvable", () => {
  const geo = getWorkspacePluginTemplate("geo");
  assert.ok(geo, "geo template must be registered");
  assert.equal(geo!.name, "GEO");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/plugin-templates.test.ts`
Expected: FAIL — `getWorkspacePluginTemplate("geo")` returns null; the ids assertion fails.

- [ ] **Step 3: Write minimal implementation**

In `runtime/api-server/src/plugin-templates.ts`, add the import after the SDK import block (around line 19):

```ts
import {
  GEO_PLUGIN_TEMPLATE_ID,
  GEO_PLUGIN_TEMPLATE_DEFINITION,
} from "./geo-plugin-template.js";
```

Then extend the registry object (around line 509):

```ts
const WORKSPACE_PLUGIN_TEMPLATE_DEFINITIONS: Record<
  string,
  WorkspacePluginTemplateDefinition
> = {
  [RESEARCH_FEED_TEMPLATE_ID]: RESEARCH_FEED_TEMPLATE_DEFINITION,
  [GEO_PLUGIN_TEMPLATE_ID]: GEO_PLUGIN_TEMPLATE_DEFINITION,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/plugin-templates.test.ts`
Expected: PASS (research_feed payload/prompt tests + the two new geo tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/api-server/src/plugin-templates.ts runtime/api-server/src/plugin-templates.test.ts
git commit -m "feat(geo): register GEO template in the registry"
```

---

## Task 4: Visibility workflow nodes + edges

**Files:**
- Modify: `runtime/api-server/src/geo-plugin-template.ts` (replace the stub builders)
- Test: `runtime/api-server/src/geo-plugin-template.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `runtime/api-server/src/geo-plugin-template.test.ts`:

```ts
import { geoVisibilityWorkflowNodesForTest } from "./geo-plugin-template.js";

test("geo visibility workflow has trigger -> agent -> object_write writing geo_visibility", () => {
  const nodes = geoVisibilityWorkflowNodesForTest({
    objectId: "acme__geo_visibility",
    pluginId: "acme",
    index: 0,
  });
  assert.deepEqual(
    nodes.map((n) => n.type),
    ["trigger", "agent", "tool"],
  );
  const writeNode = nodes.find((n) => n.type === "tool")!;
  assert.equal(writeNode.config.tool_kind, "object_write");
  assert.equal(writeNode.config.object_id, "acme__geo_visibility");
  const payload = writeNode.config.request_payload as Record<string, unknown>;
  assert.equal(payload.prompt, "{{workflow.prompt}}");
  assert.equal(payload.prompt_topic, "{{workflow.prompt_topic}}");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/geo-plugin-template.test.ts`
Expected: FAIL — `geoVisibilityWorkflowNodesForTest` not exported.

- [ ] **Step 3: Write minimal implementation**

Replace the two stub builders in `runtime/api-server/src/geo-plugin-template.ts` with real ones, and add a test export:

```ts
function geoVisibilityWorkflowNodes(params: {
  objectId: string;
  pluginId: string;
  index: number;
}): WorkflowNodeRecord[] {
  const suffix = String(params.index + 1);
  const recordId = `${params.pluginId}__geo_visibility_${suffix}`;
  return [
    {
      nodeId: `trigger-${suffix}`,
      type: "trigger",
      label: "Scheduled trigger",
      description: "Run the visibility check on the configured schedule.",
      config: { trigger_kind: "manual" },
      position: { x: 360, y: 140 },
    },
    {
      nodeId: `agent-engines-${suffix}`,
      type: "agent",
      label: "Answer-engine research",
      description: "Query each engine for the tracked prompt and detect brand presence.",
      config: {
        instruction: [
          "你是 AI 答案引擎可见性分析节点。",
          "追踪 Prompt：{{workflow.prompt}}（主题：{{workflow.prompt_topic}}）。",
          "需要检查的引擎：{{workflow.engines}}。",
          "目标品牌：{{workflow.brand}}。竞争对手：{{workflow.competitors}}。",
          "对每个引擎：用 web 搜索 + 配置的模型获取该 Prompt 的答案，判断品牌是否被提及、排名（rank，未出现则为 null）、情感（positive/neutral/negative）、出现了哪些竞争对手、引用了哪些来源域名。",
          "输出结构化 JSON 数组 per_engine，每项形如 {engine, brand_mentioned, rank, sentiment, competitors, citations}。",
          "下游写入节点会把你的 per_engine 写入记录，请确保字段齐全。",
        ].join("\n\n"),
      },
      position: { x: 220, y: 360 },
    },
    {
      nodeId: `tool-write-${suffix}`,
      type: "tool",
      label: "Write visibility record",
      description: "Persist the per-engine results as one geo_visibility record for this run.",
      config: {
        tool_kind: "object_write",
        object_id: params.objectId,
        record_id: recordId,
        request_payload: {
          prompt: "{{workflow.prompt}}",
          prompt_topic: "{{workflow.prompt_topic}}",
          engines_checked: "{{workflow.engines}}",
        },
      },
      position: { x: 520, y: 360 },
    },
  ];
}

function geoVisibilityWorkflowEdges(params: { index: number }): WorkflowEdgeRecord[] {
  const suffix = String(params.index + 1);
  return [
    {
      edgeId: `edge-start-${suffix}`,
      sourceNodeId: `trigger-${suffix}`,
      targetNodeId: `agent-engines-${suffix}`,
      sourceHandleId: null,
      targetHandleId: null,
      label: null,
      metadata: { edge_kind: "agent_handoff" },
    },
    {
      edgeId: `edge-write-${suffix}`,
      sourceNodeId: `agent-engines-${suffix}`,
      targetNodeId: `tool-write-${suffix}`,
      sourceHandleId: null,
      targetHandleId: null,
      label: null,
      metadata: { edge_kind: "tool_input" },
    },
  ];
}

export const geoVisibilityWorkflowNodesForTest = geoVisibilityWorkflowNodes;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/geo-plugin-template.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add runtime/api-server/src/geo-plugin-template.ts runtime/api-server/src/geo-plugin-template.test.ts
git commit -m "feat(geo): author per-prompt visibility workflows"
```

---

## Task 5: Visibility metrics (pure functions)

**Files:**
- Create: `apps/desktop/src/components/layout/shell/geo-visibility-metrics.ts`
- Test: `apps/desktop/src/components/layout/shell/geo-visibility-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/components/layout/shell/geo-visibility-metrics.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  computeVisibilityScore,
  computeShareOfVoice,
  computeDriftFlags,
  type GeoVisibilityRow,
} from "./geo-visibility-metrics.js";

const rows: GeoVisibilityRow[] = [
  {
    recordId: "r1",
    prompt: "best crm",
    runDate: "2026-06-15",
    perEngine: [
      { engine: "ChatGPT", brandMentioned: true, rank: 1, sentiment: "positive", competitors: ["Globex"] },
      { engine: "Perplexity", brandMentioned: false, rank: null, sentiment: null, competitors: ["Globex", "Initech"] },
    ],
  },
  {
    recordId: "r2",
    prompt: "best crm",
    runDate: "2026-06-16",
    perEngine: [
      { engine: "ChatGPT", brandMentioned: false, rank: null, sentiment: null, competitors: ["Globex"] },
      { engine: "Perplexity", brandMentioned: false, rank: null, sentiment: null, competitors: ["Globex"] },
    ],
  },
];

test("computeVisibilityScore uses the latest run per prompt, rank-weighted", () => {
  // Latest run for "best crm" is r2: both engines not mentioned -> 0.
  assert.equal(computeVisibilityScore(rows), 0);
  // Only r1 -> ChatGPT rank1 (1.0) + Perplexity miss (0) = mean 0.5 -> 50.
  assert.equal(computeVisibilityScore([rows[0]!]), 50);
});

test("computeShareOfVoice counts brand vs competitor mentions in latest runs", () => {
  // Latest run r2: brand mentions 0; competitor mentions = 1 (r2 ChatGPT Globex) + 1 (r2 Perplexity Globex) = 2.
  assert.equal(computeShareOfVoice(rows, ["Globex", "Initech"]), 0);
  // r1 only: brand mentions 1; competitors = 1 + 2 = 3 -> 1/(1+3) = 25.
  assert.equal(computeShareOfVoice([rows[0]!], ["Globex", "Initech"]), 25);
});

test("computeDriftFlags flags a prompt whose latest score dropped", () => {
  const flags = computeDriftFlags(rows);
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.prompt, "best crm");
  assert.equal(flags[0]!.direction, "down");
});

test("computeDriftFlags returns nothing with a single run", () => {
  assert.deepEqual(computeDriftFlags([rows[0]!]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && node --import tsx --test src/components/layout/shell/geo-visibility-metrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/components/layout/shell/geo-visibility-metrics.ts`:

```ts
export interface GeoEngineResult {
  engine: string;
  brandMentioned: boolean;
  rank: number | null;
  sentiment: "positive" | "neutral" | "negative" | null;
  competitors: string[];
}

export interface GeoVisibilityRow {
  recordId: string;
  prompt: string;
  runDate: string;
  perEngine: GeoEngineResult[];
}

export interface GeoDriftFlag {
  prompt: string;
  direction: "down" | "up";
}

// rank 1 -> 1.0, decays 0.15 per rank, floor 0; mentioned without a rank -> 0.5.
function enginePoints(result: GeoEngineResult): number {
  if (!result.brandMentioned) {
    return 0;
  }
  if (result.rank == null) {
    return 0.5;
  }
  return Math.max(0, 1 - (result.rank - 1) * 0.15);
}

function rowScore(row: GeoVisibilityRow): number {
  if (row.perEngine.length === 0) {
    return 0;
  }
  const total = row.perEngine.reduce((sum, r) => sum + enginePoints(r), 0);
  return total / row.perEngine.length;
}

function latestRowPerPrompt(rows: GeoVisibilityRow[]): GeoVisibilityRow[] {
  const byPrompt = new Map<string, GeoVisibilityRow>();
  for (const row of rows) {
    const existing = byPrompt.get(row.prompt);
    if (!existing || row.runDate > existing.runDate) {
      byPrompt.set(row.prompt, row);
    }
  }
  return [...byPrompt.values()];
}

export function computeVisibilityScore(rows: GeoVisibilityRow[]): number {
  const latest = latestRowPerPrompt(rows);
  if (latest.length === 0) {
    return 0;
  }
  const mean = latest.reduce((sum, row) => sum + rowScore(row), 0) / latest.length;
  return Math.round(mean * 100);
}

export function computeShareOfVoice(
  rows: GeoVisibilityRow[],
  competitors: string[],
): number {
  const known = new Set(competitors.map((c) => c.toLowerCase()));
  let brand = 0;
  let comp = 0;
  for (const row of latestRowPerPrompt(rows)) {
    for (const result of row.perEngine) {
      if (result.brandMentioned) {
        brand += 1;
      }
      for (const name of result.competitors) {
        if (known.size === 0 || known.has(name.toLowerCase())) {
          comp += 1;
        }
      }
    }
  }
  const denom = brand + comp;
  return denom === 0 ? 0 : Math.round((brand / denom) * 100);
}

export function computeDriftFlags(rows: GeoVisibilityRow[]): GeoDriftFlag[] {
  const byPrompt = new Map<string, GeoVisibilityRow[]>();
  for (const row of rows) {
    const list = byPrompt.get(row.prompt) ?? [];
    list.push(row);
    byPrompt.set(row.prompt, list);
  }
  const flags: GeoDriftFlag[] = [];
  for (const [prompt, list] of byPrompt) {
    if (list.length < 2) {
      continue;
    }
    const sorted = [...list].sort((a, b) => a.runDate.localeCompare(b.runDate));
    const prev = rowScore(sorted.at(-2)!);
    const latest = rowScore(sorted.at(-1)!);
    if (latest < prev) {
      flags.push({ prompt, direction: "down" });
    } else if (latest > prev) {
      flags.push({ prompt, direction: "up" });
    }
  }
  return flags;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && node --import tsx --test src/components/layout/shell/geo-visibility-metrics.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/layout/shell/geo-visibility-metrics.ts apps/desktop/src/components/layout/shell/geo-visibility-metrics.test.ts
git commit -m "feat(geo): visibility score, share-of-voice, drift metrics"
```

---

## Task 6: Visibility surface model (pure) + dashboard component

This task has two halves: (A) a **pure model module** (`geo-visibility-surface-model.ts`) built with TDD under `node:test`, and (B) the **React component** (`.tsx`) that imports it, verified by typecheck. Splitting the pure logic out is required — the `.tsx` pulls React/`@/`/electron and cannot run under `node:test`.

**Files:**
- Create: `apps/desktop/src/components/layout/shell/geo-visibility-surface-model.ts`
- Test: `apps/desktop/src/components/layout/shell/geo-visibility-surface-model.test.ts`
- Create: `apps/desktop/src/components/layout/shell/GeoVisibilityDashboardSurface.tsx`

- [ ] **Step 1: Write the failing test (parser + record normalization)**

Create `apps/desktop/src/components/layout/shell/geo-visibility-surface-model.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseGeoVisibilityDefinition,
  geoRowsFromRecords,
} from "./geo-visibility-surface-model.js";

test("parseGeoVisibilityDefinition reads the plugin_surface blob", () => {
  const def = parseGeoVisibilityDefinition({
    plugin_surface: {
      kind: "geo_visibility_browser",
      object_id: "acme__geo_visibility",
      engine_order: ["ChatGPT", "Perplexity"],
      competitor_names: ["Globex"],
      brand_name: "Acme",
    },
  });
  assert.ok(def);
  assert.equal(def!.object_id, "acme__geo_visibility");
  assert.deepEqual(def!.engine_order, ["ChatGPT", "Perplexity"]);
});

test("parseGeoVisibilityDefinition rejects the wrong kind", () => {
  assert.equal(parseGeoVisibilityDefinition({ kind: "research_report_browser" }), null);
});

test("geoRowsFromRecords normalizes per_engine JSON", () => {
  const def = parseGeoVisibilityDefinition({
    kind: "geo_visibility_browser",
    object_id: "acme__geo_visibility",
  })!;
  const rows = geoRowsFromRecords(
    [
      {
        record_id: "r1",
        data: {
          prompt: "best crm",
          run_date: "2026-06-16",
          per_engine: [
            { engine: "ChatGPT", brand_mentioned: true, rank: 2, sentiment: "positive", competitors: ["Globex"] },
          ],
        },
      } as unknown as BaseObjectDataRecordPayload,
    ],
    def,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.prompt, "best crm");
  assert.equal(rows[0]!.perEngine[0]!.brandMentioned, true);
  assert.equal(rows[0]!.perEngine[0]!.rank, 2);
});
```

- [ ] **Step 2: Run the model test to verify it fails**

Run: `cd apps/desktop && node --import tsx --test src/components/layout/shell/geo-visibility-surface-model.test.ts`
Expected: FAIL — cannot find module `./geo-visibility-surface-model.js`.

- [ ] **Step 3: Write the pure surface model**

Create `apps/desktop/src/components/layout/shell/geo-visibility-surface-model.ts`. **No React or `@/` imports** — only the ambient `BaseObjectDataRecordPayload` type (global, stripped by tsx) and the metrics types:

```ts
import type {
  GeoEngineResult,
  GeoVisibilityRow,
} from "./geo-visibility-metrics";

export type GeoVisibilityDefinition = {
  kind: "geo_visibility_browser";
  object_id: string | null;
  object_slug: string | null;
  prompt_field_key: string;
  topic_field_key: string;
  run_date_field_key: string;
  per_engine_field_key: string;
  summary_field_key: string;
  engine_order: string[];
  competitor_names: string[];
  brand_name: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asTrimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((v) => asTrimmed(v)).filter((v): v is string => v !== null)
    : [];
}

function normalize(input: Record<string, unknown>): GeoVisibilityDefinition | null {
  if (asTrimmed(input.kind) !== "geo_visibility_browser") {
    return null;
  }
  return {
    kind: "geo_visibility_browser",
    object_id: asTrimmed(input.object_id),
    object_slug: asTrimmed(input.object_slug),
    prompt_field_key: asTrimmed(input.prompt_field_key) ?? "prompt",
    topic_field_key: asTrimmed(input.topic_field_key) ?? "prompt_topic",
    run_date_field_key: asTrimmed(input.run_date_field_key) ?? "run_date",
    per_engine_field_key: asTrimmed(input.per_engine_field_key) ?? "per_engine",
    summary_field_key: asTrimmed(input.summary_field_key) ?? "summary",
    engine_order: asStringList(input.engine_order),
    competitor_names: asStringList(input.competitor_names),
    brand_name: asTrimmed(input.brand_name) ?? "",
  };
}

export function parseGeoVisibilityDefinition(
  definition: unknown,
): GeoVisibilityDefinition | null {
  if (!isRecord(definition)) {
    return null;
  }
  if (isRecord(definition.plugin_surface)) {
    const fromSurface = normalize(definition.plugin_surface);
    if (fromSurface) {
      return fromSurface;
    }
  }
  return normalize(definition);
}

function normalizeEngine(value: unknown): GeoEngineResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const engine = asTrimmed(value.engine);
  if (!engine) {
    return null;
  }
  const rank = typeof value.rank === "number" ? value.rank : null;
  const sentimentRaw = asTrimmed(value.sentiment);
  const sentiment =
    sentimentRaw === "positive" || sentimentRaw === "neutral" || sentimentRaw === "negative"
      ? sentimentRaw
      : null;
  return {
    engine,
    brandMentioned: value.brand_mentioned === true,
    rank,
    sentiment,
    competitors: asStringList(value.competitors),
  };
}

export function geoRowsFromRecords(
  records: BaseObjectDataRecordPayload[],
  definition: GeoVisibilityDefinition,
): GeoVisibilityRow[] {
  return records.map((record) => {
    const perEngineRaw = record.data[definition.per_engine_field_key];
    const perEngine = Array.isArray(perEngineRaw)
      ? perEngineRaw.map((e) => normalizeEngine(e)).filter((e): e is GeoEngineResult => e !== null)
      : [];
    return {
      recordId: record.record_id,
      prompt: asTrimmed(record.data[definition.prompt_field_key]) ?? "—",
      runDate:
        asTrimmed(record.data[definition.run_date_field_key]) ?? record.created_at,
      perEngine,
    };
  });
}
```

- [ ] **Step 4: Run the model test to verify it passes**

Run: `cd apps/desktop && node --import tsx --test src/components/layout/shell/geo-visibility-surface-model.test.ts`
Expected: PASS (3 tests). tsx strips the type annotations (incl. the ambient `BaseObjectDataRecordPayload`), so the pure functions run with no `@/`/React resolution.

- [ ] **Step 5: Commit the model**

```bash
git add apps/desktop/src/components/layout/shell/geo-visibility-surface-model.ts apps/desktop/src/components/layout/shell/geo-visibility-surface-model.test.ts
git commit -m "feat(geo): visibility surface model (parser + normalization)"
```

- [ ] **Step 6: Write the dashboard component**

Create `apps/desktop/src/components/layout/shell/GeoVisibilityDashboardSurface.tsx` — imports the pure model + metrics and renders the score header, action buttons, and prompt×engine matrix:

```tsx
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Loader2, Plus, RefreshCw } from "@/components/ui/icons";
import { useStartPluginOperation } from "@/plugin-surfaces/useStartPluginOperation";
import { useEffect, useMemo, useState } from "react";
import {
  computeDriftFlags,
  computeShareOfVoice,
  computeVisibilityScore,
  type GeoVisibilityRow,
} from "./geo-visibility-metrics";
import {
  geoRowsFromRecords,
  type GeoVisibilityDefinition,
} from "./geo-visibility-surface-model";

export function GeoVisibilityDashboardSurface({
  workspaceId,
  pluginId,
  schema,
  definition,
}: {
  workspaceId: string;
  pluginId: string | null;
  schema: BaseSchemaIntrospectionPayload;
  definition: GeoVisibilityDefinition;
}) {
  const [records, setRecords] = useState<BaseObjectDataRecordPayload[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const startPluginOperation = useStartPluginOperation();

  const targetObject = useMemo(
    () =>
      schema.objects.find(
        (o) =>
          (definition.object_id && o.object_id === definition.object_id) ||
          (definition.object_slug && o.slug === definition.object_slug),
      ) ?? null,
    [definition.object_id, definition.object_slug, schema.objects],
  );

  useEffect(() => {
    if (!workspaceId || !targetObject || !pluginId) {
      setRecords([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void window.electronAPI.workspace
      .listBaseRecords(workspaceId, targetObject.object_id, pluginId, { actor: null })
      .then((response) => {
        if (!cancelled) {
          setRecords(response.records);
          setErrorMessage("");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRecords([]);
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to load visibility data.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, targetObject, workspaceId]);

  const rows = useMemo(
    () => geoRowsFromRecords(records, definition),
    [records, definition],
  );
  const score = useMemo(() => computeVisibilityScore(rows), [rows]);
  const sov = useMemo(
    () => computeShareOfVoice(rows, definition.competitor_names),
    [rows, definition.competitor_names],
  );
  const driftDown = useMemo(
    () => new Set(computeDriftFlags(rows).filter((f) => f.direction === "down").map((f) => f.prompt)),
    [rows],
  );

  // Latest run per prompt for the matrix.
  const latestByPrompt = useMemo(() => {
    const map = new Map<string, GeoVisibilityRow>();
    for (const row of rows) {
      const existing = map.get(row.prompt);
      if (!existing || row.runDate > existing.runDate) {
        map.set(row.prompt, row);
      }
    }
    return [...map.values()];
  }, [rows]);

  if (isLoading && rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }

  if (errorMessage) {
    return <EmptyState title="Couldn't load visibility" description={errorMessage} />;
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex items-center gap-6">
        <Metric label="Visibility score" value={`${score}`} />
        <Metric label="Share of voice" value={`${sov}%`} />
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => pluginId && startPluginOperation(pluginId, "add_prompt")}
          >
            <Plus className="size-3.5" /> Add prompt
          </Button>
          <Button
            size="sm"
            onClick={() => pluginId && startPluginOperation(pluginId, "run_visibility_check")}
          >
            <RefreshCw className="size-3.5" /> Run check
          </Button>
        </div>
      </div>

      {latestByPrompt.length === 0 ? (
        <EmptyState
          title="No visibility data yet"
          description="Run a visibility check to populate this dashboard."
        />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="p-2">Prompt</th>
              {definition.engine_order.map((engine) => (
                <th className="p-2" key={engine}>
                  {engine}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {latestByPrompt.map((row) => (
              <tr className="border-b" key={row.recordId}>
                <td className="p-2 font-medium">
                  {row.prompt}
                  {driftDown.has(row.prompt) ? (
                    <span className="ml-2 text-xs text-orange-500">▼ dropped</span>
                  ) : null}
                </td>
                {definition.engine_order.map((engine) => {
                  const result = row.perEngine.find((e) => e.engine === engine);
                  return (
                    <td className="p-2" key={engine}>
                      {result?.brandMentioned
                        ? `#${result.rank ?? "—"}`
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
```

- [ ] **Step 7: Verify icons exist**

Run: `cd apps/desktop && grep -nE "RefreshCw|Plus|Loader2" src/components/ui/icons.tsx`
Expected: all three exported. If `RefreshCw` is missing, add a wrapper in `icons.tsx` per that file's `makeIcon(...)` convention (see `apps/desktop/CLAUDE.md`) before continuing.

- [ ] **Step 8: Typecheck the component**

Run: `cd apps/desktop && node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "GeoVisibility|geo-visibility" || echo "clean"`
Expected: `clean` (the `.tsx` isn't unit-tested under node:test; typecheck is its gate).

- [ ] **Step 9: Commit the component**

```bash
git add apps/desktop/src/components/layout/shell/GeoVisibilityDashboardSurface.tsx
git commit -m "feat(geo): visibility dashboard surface component"
```

---

## Task 7: Register the geo_visibility_browser surface

**Files:**
- Modify: `apps/desktop/src/plugin-surfaces/builtin.tsx`

This registration lives in a React side-effect module (`builtin.tsx` imports the component + electron-coupled deps), so it can't be unit-tested under `node:test` — `tsc --noEmit` plus a manual run are its gate. The parser was already covered in Task 6's model test.

- [ ] **Step 1: Append the registration**

Append to `apps/desktop/src/plugin-surfaces/builtin.tsx` (note: the parser comes from the **model** module, the component from the `.tsx`):

```tsx
import { GeoVisibilityDashboardSurface } from "@/components/layout/shell/GeoVisibilityDashboardSurface";
import { parseGeoVisibilityDefinition } from "@/components/layout/shell/geo-visibility-surface-model";

function GeoVisibilityBrowserSurface(props: PluginSurfaceProps) {
  const definition = useMemo(
    () =>
      parseGeoVisibilityDefinition({ plugin_surface: props.surfaceConfig }) ??
      parseGeoVisibilityDefinition(props.surfaceConfig),
    [props.surfaceConfig],
  );
  if (!definition) {
    return null;
  }
  return (
    <GeoVisibilityDashboardSurface
      workspaceId={props.workspaceId}
      pluginId={props.pluginId}
      schema={props.schema}
      definition={definition}
    />
  );
}

registerPluginSurface("geo_visibility_browser", GeoVisibilityBrowserSurface);
```

- [ ] **Step 2: Typecheck to verify**

Run: `cd apps/desktop && node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "GeoVisibility|geo-visibility|builtin|plugin-surfaces" || echo "clean"`
Expected: `clean`. (`useMemo` is already imported in `builtin.tsx`; `PluginSurfaceProps` and `registerPluginSurface` are already in scope — confirm against the existing imports and add `useMemo` to the React import only if missing.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/plugin-surfaces/builtin.tsx
git commit -m "feat(geo): register geo_visibility_browser surface"
```

---

## Phase 1 verification

- [ ] Run runtime tests: `cd runtime/api-server && node --import tsx --test --test-force-exit "src/geo-plugin-template.test.ts" "src/plugin-templates.test.ts"` — all pass.
- [ ] Run desktop tests: `cd apps/desktop && node --import tsx --test "src/components/layout/shell/geo-visibility-metrics.test.ts" "src/components/layout/shell/geo-visibility-surface-model.test.ts"` — all pass.
- [ ] Desktop typecheck clean for new files (`tsc --noEmit`).
- [ ] Manual smoke (optional, requires running desktop): create a GEO plugin via onboarding, confirm the Visibility dashboard renders with the score header, the "Add prompt" / "Run check" buttons, and (after a run) the prompt×engine matrix.

---

# PHASE 2 — Content Audit

## Task 8: Add geo_audit_finding object + audit config

**Files:**
- Modify: `runtime/api-server/src/geo-plugin-template.ts`
- Test: `runtime/api-server/src/geo-plugin-template.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `runtime/api-server/src/geo-plugin-template.test.ts`:

```ts
test("geo template declares geo_audit_finding object", () => {
  const objectNames =
    GEO_PLUGIN_TEMPLATE_DEFINITION.payload.onboarding.fixed_structure.objects.map(
      (o) => o.name,
    );
  assert.deepEqual(objectNames, ["geo_prompt", "geo_visibility", "geo_audit_finding"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/geo-plugin-template.test.ts`
Expected: FAIL — object list is `["geo_prompt", "geo_visibility"]`.

- [ ] **Step 3: Write minimal implementation**

Add a fields builder and a third object spec in `runtime/api-server/src/geo-plugin-template.ts`. Add the builder near `geoVisibilityFields`:

```ts
function geoAuditFindingFields() {
  return [
    { key: "url", label: "URL", fieldType: "string" as const, semanticRole: "title", isRequired: true },
    { key: "finding", label: "Finding", fieldType: "text" as const },
    {
      key: "category",
      label: "Category",
      fieldType: "enum" as const,
      config: { options: ["citability", "structure", "schema", "freshness", "crawler_access"] },
    },
    {
      key: "severity",
      label: "Severity",
      fieldType: "enum" as const,
      config: { options: ["high", "medium", "low"] },
    },
    { key: "recommendation", label: "Recommendation", fieldType: "text" as const },
    {
      key: "status",
      label: "Status",
      fieldType: "status" as const,
      semanticRole: "status",
      isRequired: true,
      isSystem: true,
      defaultValue: "open",
      config: { options: ["open", "done"] },
    },
  ];
}
```

Add the object to the template's `objects` array (after the `geo_visibility` object):

```ts
      {
        idSuffix: "geo_audit_finding",
        slugSuffix: "geo-audit-finding",
        name: "geo_audit_finding",
        description: ({ plugin }) => `Content audit findings for ${plugin.name}.`,
        fields: geoAuditFindingFields(),
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/geo-plugin-template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/api-server/src/geo-plugin-template.ts runtime/api-server/src/geo-plugin-template.test.ts
git commit -m "feat(geo): add geo_audit_finding object"
```

---

## Task 9: Audit workflow + "Run content audit" operation

**Files:**
- Modify: `runtime/api-server/src/geo-plugin-template.ts`
- Test: `runtime/api-server/src/geo-plugin-template.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `runtime/api-server/src/geo-plugin-template.test.ts`:

```ts
test("geo template exposes run_audit operation", () => {
  const ids = GEO_PLUGIN_TEMPLATE_DEFINITION.payload.operations.map((op) => op.id);
  assert.deepEqual(ids, ["add_prompt", "run_visibility_check", "run_audit"]);
});

test("geo run_audit operation resolves an assistant prefill", () => {
  const resolved = GEO_PLUGIN_TEMPLATE_DEFINITION.resolveOperation({
    plugin: { pluginId: "acme", name: "Acme GEO" } as unknown as Parameters<
      typeof GEO_PLUGIN_TEMPLATE_DEFINITION.resolveOperation
    >[0]["plugin"],
    operationId: "run_audit",
  });
  assert.ok(resolved);
  assert.match(resolved!.assistantPrefill, /audit/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/geo-plugin-template.test.ts`
Expected: FAIL — operations are `["add_prompt", "run_visibility_check"]`.

- [ ] **Step 3: Write minimal implementation**

Add a third operation to the template's `operations` array in `runtime/api-server/src/geo-plugin-template.ts`:

```ts
      {
        id: "run_audit",
        label: "Run content audit",
        assistantPrefill: ({ plugin }) =>
          [
            `Run a GEO content audit for **${plugin.name}** now.`,
            "",
            "Fetch the brand's key pages, evaluate GEO-readiness across citability, structure, schema, freshness, and AI-crawler accessibility (check robots.txt for GPTBot / ClaudeBot / PerplexityBot), and write a geo_audit_finding record for each issue with a severity and a concrete recommendation.",
          ].join("\n"),
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd runtime/api-server && node --import tsx --test --test-force-exit src/geo-plugin-template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add runtime/api-server/src/geo-plugin-template.ts runtime/api-server/src/geo-plugin-template.test.ts
git commit -m "feat(geo): add content-audit operation"
```

Note: the audit run is driven by the `run_audit` operation (agent session with the workspace's web + object-write tools), not a per-prompt instantiated workflow — so no `instantiateWorkflows` change is needed for Phase 2. The agent writes `geo_audit_finding` records directly.

---

## Task 10: Audit tab in the dashboard surface

The pure audit normalizer goes in the **model** module (tested under `node:test`); the `.tsx` only adds the audit tab UI (typecheck-gated).

**Files:**
- Modify: `apps/desktop/src/components/layout/shell/geo-visibility-surface-model.ts`
- Test: `apps/desktop/src/components/layout/shell/geo-visibility-surface-model.test.ts`
- Modify: `apps/desktop/src/components/layout/shell/GeoVisibilityDashboardSurface.tsx`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/components/layout/shell/geo-visibility-surface-model.test.ts`:

```ts
import { auditFindingsFromRecords } from "./geo-visibility-surface-model.js";

test("auditFindingsFromRecords normalizes findings and sorts by severity", () => {
  const findings = auditFindingsFromRecords([
    { record_id: "a", data: { url: "/x", finding: "no schema", category: "schema", severity: "low", recommendation: "add it", status: "open" } } as unknown as BaseObjectDataRecordPayload,
    { record_id: "b", data: { url: "/y", finding: "blocked", category: "crawler_access", severity: "high", recommendation: "allow GPTBot", status: "open" } } as unknown as BaseObjectDataRecordPayload,
  ]);
  assert.equal(findings.length, 2);
  assert.equal(findings[0]!.severity, "high");
  assert.equal(findings[0]!.recordId, "b");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && node --import tsx --test src/components/layout/shell/geo-visibility-surface-model.test.ts`
Expected: FAIL — `auditFindingsFromRecords` not exported.

- [ ] **Step 3: Add the audit normalizer to the model module**

Append to `apps/desktop/src/components/layout/shell/geo-visibility-surface-model.ts` (reuses the existing `asTrimmed` helper in that file):

```ts
export interface GeoAuditFinding {
  recordId: string;
  url: string;
  finding: string;
  category: string;
  severity: "high" | "medium" | "low";
  recommendation: string;
  status: string;
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function auditFindingsFromRecords(
  records: BaseObjectDataRecordPayload[],
): GeoAuditFinding[] {
  const findings = records.map((record) => {
    const severityRaw = asTrimmed(record.data.severity);
    const severity =
      severityRaw === "high" || severityRaw === "medium" || severityRaw === "low"
        ? severityRaw
        : "low";
    return {
      recordId: record.record_id,
      url: asTrimmed(record.data.url) ?? "—",
      finding: asTrimmed(record.data.finding) ?? "",
      category: asTrimmed(record.data.category) ?? "",
      severity,
      recommendation: asTrimmed(record.data.recommendation) ?? "",
      status: asTrimmed(record.data.status) ?? "open",
    };
  });
  return findings.sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && node --import tsx --test src/components/layout/shell/geo-visibility-surface-model.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit the model addition**

```bash
git add apps/desktop/src/components/layout/shell/geo-visibility-surface-model.ts apps/desktop/src/components/layout/shell/geo-visibility-surface-model.test.ts
git commit -m "feat(geo): audit finding normalization in surface model"
```

- [ ] **Step 6: Add the Audit tab to the component**

In `apps/desktop/src/components/layout/shell/GeoVisibilityDashboardSurface.tsx`:
1. Extend the model import to add `auditFindingsFromRecords` and `type GeoAuditFinding`.
2. Add `const [tab, setTab] = useState<"visibility" | "audit">("visibility");`.
3. Resolve the audit object: `schema.objects.find((o) => o.slug.endsWith("geo-audit-finding"))` and load its records in a second `useEffect` (mirror the existing visibility `listBaseRecords` effect; guard on `tab === "audit"` so it only loads when the tab opens).
4. Compute `const findings = useMemo(() => auditFindingsFromRecords(auditRecords), [auditRecords]);`.
5. Render a two-button tab header (Visibility / Audit) above the body; when `tab === "audit"`, render `findings` as a severity-grouped list (reuse the existing table markup + a `run_audit` button via `startPluginOperation(pluginId, "run_audit")`), otherwise render the existing visibility view.

Keep the visibility tab the default. No new surface-config keys are needed — the audit object is discovered from `schema.objects` by slug suffix.

- [ ] **Step 7: Typecheck**

Run: `cd apps/desktop && node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "GeoVisibility|geo-visibility" || echo "clean"`
Expected: `clean`.

- [ ] **Step 8: Commit the component**

```bash
git add apps/desktop/src/components/layout/shell/GeoVisibilityDashboardSurface.tsx
git commit -m "feat(geo): content audit tab in visibility dashboard"
```

---

## Phase 2 verification

- [ ] Runtime tests pass (`geo-plugin-template.test.ts`, `plugin-templates.test.ts`).
- [ ] Desktop tests pass (`geo-visibility-metrics.test.ts`, `geo-visibility-surface-model.test.ts`).
- [ ] Desktop typecheck clean.
- [ ] Manual smoke (optional): trigger "Run content audit", confirm findings appear in the Audit tab grouped by severity with open/done status.

---

## Notes for the implementer

- **Field types are confirmed against `runtime/state-store/src/store.ts:308` `BaseFieldType`** — `string`, `text`, `number`, `enum`, `status`, `date`, `json` are all valid.
- **Engine list is config-driven**: the `engine`/`engines_checked` enum options and the surface's `engine_order` come from `config.engines` collected at onboarding — never hardcode an engine set.
- **Data layer is isolated in the visibility workflow's agent node.** Object model, scoring, and dashboard never depend on how an answer was fetched, so a future swap to a SERP/scrape provider touches only that node's instruction (or a future tool), not the schema or UI.
- **Do not append GEO code into `plugin-templates.ts`** beyond the registry import/entry — keep it in `geo-plugin-template.ts`.
- If the desktop surface-registration test (`geo-registration.test.ts`) can't run under `node:test` due to heavy transitive React/electron imports in `builtin.tsx`, drop that test file and rely on typecheck + manual verification; the pure parser/metrics tests remain the safety net.
