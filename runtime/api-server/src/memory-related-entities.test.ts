import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  appendDurableMemoryRelatedSections,
  canonicalizeDurableMemoryRelatedInfo,
  extractDurableMemoryRelatedInfo,
  mergeArtifactDerivedRelations,
  parseDurableMemoryRelatedInfo,
  stripDurableMemoryRelatedSections,
} from "./memory-related-entities.js";
import { buildWorkspaceRelatedEntityResolver } from "./workspace-related-entity-resolver.js";
import { canonicalInteractionEntityKey } from "./workspace-related-entity-keys.js";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("appendDurableMemoryRelatedSections round-trips through parseDurableMemoryRelatedInfo", () => {
  const baseMarkdown = [
    "# External individuals have emailed the user personally about holaboss",
    "",
    "## Summary",
    "",
    "Found concrete outreach threads worth remembering.",
    "",
    "## Evidence",
    "",
    "Ben Book at anyIP followed up on social proxy work.",
    "",
  ].join("\n");

  const markdown = appendDurableMemoryRelatedSections(baseMarkdown, {
    relatedEntities: [
      {
        entityType: "person",
        entityKey: "person:ben-book",
        label: "Ben Book",
      },
      {
        entityType: "organization",
        entityKey: "organization:anyip",
        label: "anyIP",
      },
    ],
    relations: [
      {
        relationType: "contacted_by",
        entityKey: "person:ben-book",
      },
      {
        relationType: "works_at",
        entityKey: "organization:anyip",
      },
      {
        relationType: "requires_followup_from",
        entityKey: "person:ben-book",
      },
    ],
  });

  assert.match(markdown, /## Related Entities/);
  assert.match(markdown, /`person:ben-book` \| Ben Book/);
  assert.match(markdown, /`contacted_by` -> `person:ben-book` \| Ben Book/);
  assert.match(
    markdown,
    /`requires_followup_from` -> `person:ben-book` \| Ben Book/,
  );

  assert.deepEqual(parseDurableMemoryRelatedInfo(markdown), {
    relatedEntities: [
      {
        entityType: "organization",
        entityKey: "organization:anyip",
        label: "anyIP",
      },
      {
        entityType: "person",
        entityKey: "person:ben-book",
        label: "Ben Book",
      },
    ],
    relations: [
      {
        relationType: "contacted_by",
        entityKey: "person:ben-book",
      },
      {
        relationType: "requires_followup_from",
        entityKey: "person:ben-book",
      },
      {
        relationType: "works_at",
        entityKey: "organization:anyip",
      },
    ],
  });

  assert.equal(stripDurableMemoryRelatedSections(markdown).trim(), baseMarkdown.trim());
});

test("mergeArtifactDerivedRelations preserves semantic relations while adding artifact provenance", () => {
  const merged = mergeArtifactDerivedRelations({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "person",
          entityKey: "person:ben-book",
          label: "Ben Book",
        },
      ],
      relations: [
        {
          relationType: "contacted_by",
          entityKey: "person:ben-book",
        },
      ],
    },
    artifactContexts: [
      {
        sourceKind: "output_artifact",
        treeId: "tree-output-1",
        title: "outreach-delegated.md",
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: "artifact:output:output-1",
        excerpts: ["Ben Book at anyIP followed up on the rollout."],
      },
    ],
  });

  assert.deepEqual(merged.relatedEntities, [
    {
      entityType: "artifact",
      entityKey: "artifact:output:output-1",
      label: "outreach-delegated.md",
    },
    {
      entityType: "person",
      entityKey: "person:ben-book",
      label: "Ben Book",
    },
  ]);
  assert.deepEqual(merged.relations, [
    {
      relationType: "contacted_by",
      entityKey: "person:ben-book",
    },
    {
      relationType: "derived_from",
      entityKey: "artifact:output:output-1",
    },
    {
      relationType: "mentions",
      entityKey: "artifact:output:output-1",
    },
  ]);
});

test("extractDurableMemoryRelatedInfo normalizes entities, custom relation types, and synthesizes mention relations", async () => {
  const recordedUserPrompts: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as {
            messages?: Array<{ role?: string; content?: string }>;
          })
        : null;
    const userMessage = body?.messages?.find((message) => message.role === "user");
    if (typeof userMessage?.content === "string") {
      recordedUserPrompts.push(userMessage.content);
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                related_entities: [
                  {
                    entity_type: "person",
                    label: "Ben Book",
                  },
                  {
                    entity_type: "organization",
                    label: "anyIP",
                  },
                ],
                relations: [
                  {
                    relation_type: "contacted_by",
                    entity_type: "person",
                    entity_label: "Ben Book",
                  },
                  {
                    relation_type: "requires approval from",
                    entity_type: "organization",
                    entity_label: "anyIP",
                  },
                ],
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const result = await extractDurableMemoryRelatedInfo({
    modelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-1",
      modelId: "gpt-5.4-mini",
      apiStyle: "openai_compatible",
    },
    memoryType: "reference",
    subjectKey: "holaboss_personal_outreach",
    title: "External individuals have emailed the user personally about holaboss",
    summary: "Found durable outreach context.",
    content: "# External individuals have emailed the user personally about holaboss\n\nFound durable outreach context.\n",
    tags: ["outreach"],
    artifactContexts: [
      {
        sourceKind: "tool_result",
        treeId: "tool-tree-1",
        title: "gmail outreach search",
        provider: "gmail",
        accountNamespace: "ops@example.com",
        canonicalEntityKey: "artifact:tool-result:gmail:call-1",
        excerpts: ["Ben Book at anyIP asked for a response about holaboss."],
      },
    ],
  });

  assert.deepEqual(result.relatedEntities, [
    {
      entityType: "organization",
      entityKey: "organization:anyip",
      label: "anyIP",
    },
    {
      entityType: "person",
      entityKey: "person:ben-book",
      label: "Ben Book",
    },
  ]);
  assert.deepEqual(result.relations, [
    {
      relationType: "contacted_by",
      entityKey: "person:ben-book",
    },
    {
      relationType: "mentions",
      entityKey: "organization:anyip",
    },
    {
      relationType: "mentions",
      entityKey: "person:ben-book",
    },
    {
      relationType: "requires_approval_from",
      entityKey: "organization:anyip",
    },
  ]);
  assert.equal(recordedUserPrompts.length, 1);
  assert.match(recordedUserPrompts[0] ?? "", /artifact:tool-result:gmail:call-1/);
});

test("extractDurableMemoryRelatedInfo includes structured artifact evidence in the relation prompt", async () => {
  const recordedUserPrompts: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as {
            messages?: Array<{ role?: string; content?: string }>;
          })
        : null;
    const userMessage = body?.messages?.find((message) => message.role === "user");
    if (typeof userMessage?.content === "string") {
      recordedUserPrompts.push(userMessage.content);
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                related_entities: [],
                relations: [],
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  await extractDurableMemoryRelatedInfo({
    modelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-1",
      modelId: "gpt-5.4-mini",
      apiStyle: "openai_compatible",
    },
    memoryType: "reference",
    subjectKey: "holaboss_personal_outreach",
    title: "External individuals have emailed the user personally about holaboss",
    summary: "Found durable outreach context.",
    content: "# External individuals have emailed the user personally about holaboss\n\nFound durable outreach context.\n",
    tags: ["outreach"],
    artifactContexts: [
      {
        sourceKind: "output_artifact",
        treeId: "output-tree-1",
        title: "outreach-delegated.md",
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: "artifact:output:output-1",
        excerpts: ["The deliverable states that Ben Book should stay attached to Builder Mode outreach."],
      },
    ],
  });

  assert.equal(recordedUserPrompts.length, 1);
  const prompt = recordedUserPrompts[0] ?? "";
  assert.match(prompt, /Structured artifact evidence:/);
  assert.match(prompt, /Source kind: output_artifact/);
  assert.match(prompt, /Canonical artifact key: artifact:output:output-1/);
  assert.match(prompt, /Builder Mode outreach/i);
});

test("extractDurableMemoryRelatedInfo bounds structured artifact evidence in the relation prompt", async () => {
  const recordedUserPrompts: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as {
            messages?: Array<{ role?: string; content?: string }>;
          })
        : null;
    const userMessage = body?.messages?.find((message) => message.role === "user");
    if (typeof userMessage?.content === "string") {
      recordedUserPrompts.push(userMessage.content);
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                related_entities: [],
                relations: [],
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const longExcerpt = "Builder Mode artifact evidence ".repeat(40);
  await extractDurableMemoryRelatedInfo({
    modelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-1",
      modelId: "gpt-5.4-mini",
      apiStyle: "openai_compatible",
    },
    memoryType: "reference",
    subjectKey: "builder_mode_rollup",
    title: "Builder Mode artifact rollup",
    summary: "Bound the relation prompt artifact context.",
    content: "# Builder Mode artifact rollup\n\nBound the relation prompt artifact context.\n",
    artifactContexts: Array.from({ length: 6 }, (_value, index) => ({
      sourceKind: "output_artifact" as const,
      treeId: `output-tree-${index + 1}`,
      title: `artifact-${index + 1}.md`,
      provider: null,
      accountNamespace: null,
      canonicalEntityKey: `artifact:output:output-${index + 1}`,
      excerpts: [
        `${longExcerpt} excerpt-a-${index + 1}`,
        `${longExcerpt} excerpt-b-${index + 1}`,
        `${longExcerpt} excerpt-c-${index + 1}`,
      ],
    })),
  });

  assert.equal(recordedUserPrompts.length, 1);
  const prompt = recordedUserPrompts[0] ?? "";
  assert.match(prompt, /artifact-1\.md/);
  assert.match(prompt, /artifact-4\.md/);
  assert.doesNotMatch(prompt, /artifact-5\.md/);
  assert.doesNotMatch(prompt, /artifact-6\.md/);
  assert.match(prompt, /\.\.\. 2 more artifact contexts omitted/);
  assert.match(prompt, /\.\.\. 1 more excerpt omitted/);
  assert.doesNotMatch(prompt, /excerpt-c-1/);
  assert(prompt.length < 10_500);
});

test("extractDurableMemoryRelatedInfo retries once when the first pass returns only generic placeholders", async () => {
  const recordedUserPrompts: string[] = [];
  const recordedSystemPrompts: string[] = [];
  let callCount = 0;
  globalThis.fetch = (async (_input, init) => {
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as {
            messages?: Array<{ role?: string; content?: string }>;
          })
        : null;
    const userMessage = body?.messages?.find((message) => message.role === "user");
    const systemMessage = body?.messages?.find((message) => message.role === "system");
    if (typeof userMessage?.content === "string") {
      recordedUserPrompts.push(userMessage.content);
    }
    if (typeof systemMessage?.content === "string") {
      recordedSystemPrompts.push(systemMessage.content);
    }
    callCount += 1;
    const payload = callCount === 1
      ? {
          related_entities: [
            {
              entity_type: "artifact",
              label: "artifact",
            },
            {
              entity_type: "topic",
              label: "topic",
            },
          ],
          relations: [
            {
              relation_type: "about",
              entity_type: "artifact",
              entity_label: "artifact",
            },
          ],
        }
      : {
          related_entities: [
            {
              entity_type: "person",
              label: "Ben Book",
            },
            {
              entity_type: "organization",
              label: "anyIP",
            },
          ],
          relations: [
            {
              relation_type: "contacted_by",
              entity_type: "person",
              entity_label: "Ben Book",
            },
          ],
        };
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(payload),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  const result = await extractDurableMemoryRelatedInfo({
    modelClient: {
      baseUrl: "https://runtime.example/api/v1/model-proxy/openai/v1",
      apiKey: "token-1",
      modelId: "gpt-5.4-mini",
      apiStyle: "openai_compatible",
    },
    memoryType: "reference",
    subjectKey: "holaboss_personal_outreach",
    title: "External individuals have emailed the user personally about holaboss",
    summary: "Found durable outreach context.",
    content: "# External individuals have emailed the user personally about holaboss\n\nFound durable outreach context.\n",
    tags: ["outreach"],
    artifactContexts: [
      {
        sourceKind: "output_artifact",
        treeId: "output-tree-1",
        title: "outreach-delegated.md",
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: "artifact:output:output-1",
        excerpts: ["Ben Book at anyIP followed up on Builder Mode outreach."],
      },
    ],
  });

  assert.equal(callCount, 2);
  assert.equal(recordedUserPrompts.length, 2);
  assert.equal(recordedSystemPrompts.length, 2);
  assert.match(recordedSystemPrompts[1] ?? "", /previous extraction was too generic/i);
  assert.match(recordedSystemPrompts[1] ?? "", /do not return generic placeholders/i);
  assert.deepEqual(result.relatedEntities, [
    {
      entityType: "organization",
      entityKey: "organization:anyip",
      label: "anyIP",
    },
    {
      entityType: "person",
      entityKey: "person:ben-book",
      label: "Ben Book",
    },
  ]);
  assert.deepEqual(result.relations, [
    {
      relationType: "contacted_by",
      entityKey: "person:ben-book",
    },
    {
      relationType: "mentions",
      entityKey: "organization:anyip",
    },
    {
      relationType: "mentions",
      entityKey: "person:ben-book",
    },
  ]);
});

test("canonicalizeDurableMemoryRelatedInfo resolves placeholder artifact labels to one canonical output artifact key", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    outputTargets: [
      {
        treeId: "output-tree-1",
        rootNodeId: "output-root-1",
        title: "notion-related-pages.md",
        outputId: "output-1",
        outputType: "markdown",
        filePath: "outputs/notion-related-pages.md",
        artifactId: "artifact-1",
        sourceTurnInputId: "turn-1",
        observedAt: "2026-06-05T00:00:00.000Z",
      },
    ],
  });

  const result = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "artifact",
          entityKey: "artifact:.-notion-related-pages.md",
          label: "notion-related-pages.md",
        },
        {
          entityType: "artifact",
          entityKey: "artifact:artifact",
          label: "artifact",
        },
      ],
      relations: [
        {
          relationType: "about",
          entityKey: "artifact:.-notion-related-pages.md",
        },
        {
          relationType: "mentions",
          entityKey: "artifact:artifact",
        },
      ],
    },
    resolver,
    sourceTurnInputId: "turn-1",
  });

  assert.deepEqual(result, {
    relatedEntities: [
      {
        entityType: "artifact",
        entityKey: "artifact:output:output-1",
        label: "notion-related-pages.md",
      },
    ],
    relations: [
      {
        relationType: "about",
        entityKey: "artifact:output:output-1",
      },
    ],
  });
});

test("canonicalizeDurableMemoryRelatedInfo resolves output titles to canonical output keys even when the output tree is not materialized", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    outputTargets: [
      {
        treeId: null,
        rootNodeId: null,
        title: "legacy-handoff.md",
        outputId: "output-unmaterialized-1",
        outputType: "document",
        filePath: "outputs/reports/legacy-handoff.md",
        artifactId: "artifact-legacy-handoff-1",
        sourceTurnInputId: "turn-1",
        observedAt: "2026-06-05T00:00:00.000Z",
      },
    ],
  });

  const result = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "artifact",
          entityKey: "artifact:legacy-handoff.md",
          label: "legacy-handoff.md",
        },
      ],
      relations: [
        {
          relationType: "derived_from",
          entityKey: "artifact:legacy-handoff.md",
        },
      ],
    },
    resolver,
    sourceTurnInputId: "turn-1",
  });

  assert.deepEqual(result, {
    relatedEntities: [
      {
        entityType: "artifact",
        entityKey: "artifact:output:output-unmaterialized-1",
        label: "legacy-handoff.md",
      },
    ],
    relations: [
      {
        relationType: "derived_from",
        entityKey: "artifact:output:output-unmaterialized-1",
      },
    ],
  });
});

test("canonicalizeDurableMemoryRelatedInfo resolves dot-slash artifact labels to one canonical output artifact key", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    outputTargets: [
      {
        treeId: "output-tree-1",
        rootNodeId: "output-root-1",
        title: "notion-related-pages.md",
        outputId: "output-1",
        outputType: "markdown",
        filePath: "outputs/notion-related-pages.md",
        artifactId: "artifact-1",
        sourceTurnInputId: "turn-1",
        observedAt: "2026-06-05T00:00:00.000Z",
      },
    ],
  });

  const result = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "artifact",
          entityKey: "artifact:.-notion-related-pages.md",
          label: "./notion-related-pages.md",
        },
      ],
      relations: [
        {
          relationType: "about",
          entityKey: "artifact:.-notion-related-pages.md",
        },
      ],
    },
    resolver,
    sourceTurnInputId: "turn-1",
  });

  assert.deepEqual(result, {
    relatedEntities: [
      {
        entityType: "artifact",
        entityKey: "artifact:output:output-1",
        label: "notion-related-pages.md",
      },
    ],
    relations: [
      {
        relationType: "about",
        entityKey: "artifact:output:output-1",
      },
    ],
  });
});

test("canonicalizeDurableMemoryRelatedInfo rewrites generic placeholder keys to label-derived fallback keys when labels are concrete", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    outputTargets: [],
  });
  const result = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "topic",
          entityKey: "topic:topic",
          label: "渠道设计",
        },
      ],
      relations: [
        {
          relationType: "about",
          entityKey: "topic:topic",
        },
      ],
    },
    resolver,
    sourceTurnInputId: null,
  });

  assert.equal(result.relatedEntities.length, 1);
  assert.equal(result.relatedEntities[0]?.entityType, "topic");
  assert.equal(result.relatedEntities[0]?.label, "渠道设计");
  assert.match(result.relatedEntities[0]?.entityKey ?? "", /^topic:label-[0-9a-f]{12}$/);
  assert.notEqual(result.relatedEntities[0]?.entityKey, "topic:topic");
  assert.deepEqual(result.relations, [
    {
      relationType: "about",
      entityKey: result.relatedEntities[0]!.entityKey,
    },
  ]);
});

test("canonicalizeDurableMemoryRelatedInfo resolves non-ASCII interaction entity labels to canonical workspace identities", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [
      {
        workspaceId: "workspace-1",
        entityId: "interaction:topic:channel-design",
        entityType: "topic",
        canonicalName: "渠道设计",
        slug: "topic-channel-design",
        summary: "Channel design planning topic.",
        aliases: ["渠道设计主线"],
        isSystem: false,
        status: "active",
        createdAt: "2026-06-05T00:00:00.000Z",
        updatedAt: "2026-06-06T00:00:00.000Z",
      },
    ],
    outputTargets: [],
  });
  const result = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "topic",
          entityKey: "topic:label-deadbeef0000",
          label: "渠道设计",
        },
      ],
      relations: [
        {
          relationType: "about",
          entityKey: "topic:label-deadbeef0000",
        },
      ],
    },
    resolver,
    sourceTurnInputId: null,
  });

  assert.deepEqual(result, {
    relatedEntities: [
      {
        entityType: "topic",
        entityKey: canonicalInteractionEntityKey("topic", "interaction:topic:channel-design"),
        label: "渠道设计",
      },
    ],
    relations: [
      {
        relationType: "about",
        entityKey: canonicalInteractionEntityKey("topic", "interaction:topic:channel-design"),
      },
    ],
  });
});

test("canonicalizeDurableMemoryRelatedInfo resolves non-ASCII artifact titles through current artifact context", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    outputTargets: [],
  });
  const result = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "artifact",
          entityKey: "artifact:label-deadbeef0001",
          label: "主叙事阶段",
        },
      ],
      relations: [
        {
          relationType: "mentions",
          entityKey: "artifact:label-deadbeef0001",
        },
      ],
    },
    resolver,
    sourceTurnInputId: "turn-1",
    artifactContexts: [
      {
        sourceKind: "output_artifact",
        treeId: "output-tree-cn",
        title: "主叙事阶段",
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: "artifact:output:output-cn",
        excerpts: ["当前主叙事阶段的交付内容。"],
      },
    ],
  });

  assert.deepEqual(result, {
    relatedEntities: [
      {
        entityType: "artifact",
        entityKey: "artifact:output:output-cn",
        label: "主叙事阶段",
      },
    ],
    relations: [
      {
        relationType: "mentions",
        entityKey: "artifact:output:output-cn",
      },
    ],
  });
});

test("canonicalizeDurableMemoryRelatedInfo resolves artifact titles through current artifact context even without a workspace resolver", () => {
  const result = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "artifact",
          entityKey: "artifact:label-deadbeef0001",
          label: "主叙事阶段",
        },
      ],
      relations: [
        {
          relationType: "mentions",
          entityKey: "artifact:label-deadbeef0001",
        },
      ],
    },
    resolver: null,
    sourceTurnInputId: "turn-1",
    artifactContexts: [
      {
        sourceKind: "output_artifact",
        treeId: "output-tree-cn",
        title: "主叙事阶段",
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: "artifact:output:output-cn",
        excerpts: ["当前主叙事阶段的交付内容。"],
      },
    ],
  });

  assert.deepEqual(result, {
    relatedEntities: [
      {
        entityType: "artifact",
        entityKey: "artifact:output:output-cn",
        label: "主叙事阶段",
      },
    ],
    relations: [
      {
        relationType: "mentions",
        entityKey: "artifact:output:output-cn",
      },
    ],
  });
});

test("canonicalizeDurableMemoryRelatedInfo prefers the current artifact context when duplicate artifact titles exist", () => {
  const resolver = buildWorkspaceRelatedEntityResolver({
    interactionEntities: [],
    outputTargets: [
      {
        treeId: "output-tree-older",
        rootNodeId: "output-root-older",
        title: "status-report.md",
        outputId: "output-older",
        outputType: "markdown",
        filePath: "outputs/status-report.md",
        artifactId: "artifact-older",
        sourceTurnInputId: "turn-1",
        observedAt: "2026-06-05T00:00:00.000Z",
      },
      {
        treeId: "output-tree-current",
        rootNodeId: "output-root-current",
        title: "status-report.md",
        outputId: "output-current",
        outputType: "markdown",
        filePath: "outputs/status-report.md",
        artifactId: "artifact-current",
        sourceTurnInputId: "turn-1",
        observedAt: "2026-06-06T00:00:00.000Z",
      },
    ],
  });

  const result = canonicalizeDurableMemoryRelatedInfo({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "artifact",
          entityKey: "artifact:status-report.md",
          label: "status-report.md",
        },
      ],
      relations: [
        {
          relationType: "derived_from",
          entityKey: "artifact:status-report.md",
        },
      ],
    },
    resolver,
    sourceTurnInputId: "turn-1",
    artifactContexts: [
      {
        sourceKind: "output_artifact",
        treeId: "output-tree-older",
        title: "status-report.md",
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: "artifact:output:output-older",
        excerpts: [],
      },
    ],
  });

  assert.deepEqual(result, {
    relatedEntities: [
      {
        entityType: "artifact",
        entityKey: "artifact:output:output-older",
        label: "status-report.md",
      },
    ],
    relations: [
      {
        relationType: "derived_from",
        entityKey: "artifact:output:output-older",
      },
    ],
  });
});
