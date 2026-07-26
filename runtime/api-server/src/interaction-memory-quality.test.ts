import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInteractionLeafArtifactRelatedInfo,
  ensureMinimumSemanticOwnerRelatedInfo,
  interactionLeafNeedsQualityRepair,
  isRequestShapedInteractionLeaf,
  needsModelAssistedInteractionLeafRelationRepair,
  relatedInfoNeedsCanonicalRewrite,
  restoreInteractionLeafContentFromSourceEvidence,
  shouldForceModelInteractionLeafRelationRepair,
} from "./interaction-memory-quality.js";

test("isRequestShapedInteractionLeaf detects clear user-request memories and ignores durable facts", () => {
  assert.equal(
    isRequestShapedInteractionLeaf({
      title: "User asked to find all billing-related emails",
      summary: "A one-off inbox search request.",
      body: "# User asked to find all billing-related emails\n\nThis was a temporary request.",
      subjectKey: "user_asked_to_find_all_billing_related_emails",
    }),
    true,
  );
  assert.equal(
    isRequestShapedInteractionLeaf({
      title: "AWS account 423623864703 exceeded zero-spend budget",
      summary: "A budget alert fired for the workspace account.",
      body: "# AWS account 423623864703 exceeded zero-spend budget\n\nThis is a durable operational fact.",
      subjectKey: "aws_account_423623864703_budget_alert",
    }),
    false,
  );
});

test("buildInteractionLeafArtifactRelatedInfo synthesizes derived_from and mentions from same-turn artifacts", () => {
  const relatedInfo = buildInteractionLeafArtifactRelatedInfo({
    sourceTurnInputId: "turn-1",
    artifactDescriptors: [
      {
        entityKey: "artifact:output:output-1",
        title: "outreach-delegated.md",
        sourceTurnInputId: "turn-1",
      },
      {
        entityKey: "artifact:tool-result:gmail:call-1",
        title: "gmail outreach result",
        sourceTurnInputId: "turn-1",
      },
      {
        entityKey: "artifact:output:output-ignored",
        title: "ignored.md",
        sourceTurnInputId: "turn-2",
      },
    ],
  });

  assert.deepEqual(relatedInfo.relatedEntities, [
    {
      entityType: "artifact",
      entityKey: "artifact:output:output-1",
      label: "outreach-delegated.md",
    },
    {
      entityType: "artifact",
      entityKey: "artifact:tool-result:gmail:call-1",
      label: "gmail outreach result",
    },
  ]);
  assert.deepEqual(relatedInfo.relations, [
    {
      relationType: "derived_from",
      entityKey: "artifact:output:output-1",
    },
    {
      relationType: "derived_from",
      entityKey: "artifact:tool-result:gmail:call-1",
    },
    {
      relationType: "mentions",
      entityKey: "artifact:output:output-1",
    },
    {
      relationType: "mentions",
      entityKey: "artifact:tool-result:gmail:call-1",
    },
  ]);
});

test("ensureMinimumSemanticOwnerRelatedInfo adds an about relation for artifact-only related info", () => {
  const relatedInfo = ensureMinimumSemanticOwnerRelatedInfo({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "artifact",
          entityKey: "artifact:output:output-1",
          label: "outreach.md",
        },
      ],
      relations: [
        {
          relationType: "derived_from",
          entityKey: "artifact:output:output-1",
        },
        {
          relationType: "mentions",
          entityKey: "artifact:output:output-1",
        },
      ],
    },
    ownerEntityType: "project",
    ownerEntityId: "interaction:project:builder-mode",
    ownerLabel: "Builder Mode",
  });

  assert.deepEqual(relatedInfo.relatedEntities, [
    {
      entityType: "artifact",
      entityKey: "artifact:output:output-1",
      label: "outreach.md",
    },
    {
      entityType: "project",
      entityKey: "project:entity:interaction:project:builder-mode",
      label: "Builder Mode",
    },
  ]);
  assert.deepEqual(relatedInfo.relations, [
    {
      relationType: "about",
      entityKey: "project:entity:interaction:project:builder-mode",
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

test("ensureMinimumSemanticOwnerRelatedInfo keeps richer semantic relations unchanged", () => {
  const relatedInfo = ensureMinimumSemanticOwnerRelatedInfo({
    relatedInfo: {
      relatedEntities: [
        {
          entityType: "person",
          entityKey: "person:entity:interaction:person:ben-book",
          label: "Ben Book",
        },
      ],
      relations: [
        {
          relationType: "contacted_by",
          entityKey: "person:entity:interaction:person:ben-book",
        },
      ],
    },
    ownerEntityType: "topic",
    ownerEntityId: "interaction:topic:personal-outreach",
    ownerLabel: "Personal outreach",
  });

  assert.deepEqual(relatedInfo, {
    relatedEntities: [
      {
        entityType: "person",
        entityKey: "person:entity:interaction:person:ben-book",
        label: "Ben Book",
      },
    ],
    relations: [
      {
        relationType: "contacted_by",
        entityKey: "person:entity:interaction:person:ben-book",
      },
    ],
  });
});

test("restoreInteractionLeafContentFromSourceEvidence replaces clipped summary and evidence with source evidence", () => {
  const restored = restoreInteractionLeafContentFromSourceEvidence({
    title: "External individuals contacted the user personally about holaboss",
    memoryType: "reference",
    body: [
      "# External individuals contacted the user personally about holaboss",
      "",
      "- Type: `reference`",
      "",
      "## Summary",
      "",
      "External individuals have emailed the user personally about holaboss...",
      "",
      "## Evidence",
      "",
      "Ben Book at anyIP ...",
      "",
    ].join("\n"),
    summary: "External individuals have emailed the user personally about holaboss...",
    assistantText: "Ben Book at anyIP reached out to the user personally about holaboss and followed up on the same thread.",
    evidenceLines: [
      "[gmail ops@example.com] holaboss_composio.gmail_fetch_emails => Ben Book at anyIP reached out to the user personally about holaboss and followed up on the same thread.",
      "[output_artifact document] outreach-deliverable.md => Ben Book at anyIP should stay attached to holaboss personal outreach memory.",
    ],
  });

  assert.equal(restored.changed, true);
  assert.equal(
    restored.summary,
    "Ben Book at anyIP reached out to the user personally about holaboss and followed up on the same thread.",
  );
  assert.match(restored.content, /## Evidence/);
  assert.match(restored.content, /outreach-deliverable\.md/);
  assert.ok(!/Ben Book at anyIP \.\.\./.test(restored.content));
});

test("restoreInteractionLeafContentFromSourceEvidence leaves clipped memories unchanged when no source evidence exists", () => {
  const body = [
    "# External individuals contacted the user personally about holaboss",
    "",
    "- Type: `reference`",
    "",
    "## Summary",
    "",
    "External individuals have emailed the user personally about holaboss...",
    "",
    "## Evidence",
    "",
    "Ben Book at anyIP ...",
    "",
  ].join("\n");

  const restored = restoreInteractionLeafContentFromSourceEvidence({
    title: "External individuals contacted the user personally about holaboss",
    memoryType: "reference",
    body,
    summary: "External individuals have emailed the user personally about holaboss...",
    assistantText: null,
    evidenceLines: [],
  });

  assert.equal(restored.changed, false);
  assert.equal(restored.summary, "External individuals have emailed the user personally about holaboss...");
  assert.equal(restored.content, body);
});

test("interactionLeafNeedsQualityRepair selects clipped, placeholder, and missing-artifact-provenance leaves", () => {
  assert.equal(
    interactionLeafNeedsQualityRepair({
      title: "Ben Book outreach summary",
      summary: "Ben Book at anyIP emailed the user personally...",
      body: "# Ben Book outreach summary\n\n## Summary\n\nBen Book at anyIP emailed the user personally...",
      subjectKey: "ben_book_outreach",
      relatedInfo: {
        relatedEntities: [
          {
            entityType: "artifact",
            entityKey: "artifact:output:output-1",
            label: "outreach.md",
          },
        ],
        relations: [
          {
            relationType: "derived_from",
            entityKey: "artifact:output:output-1",
          },
        ],
      },
      artifactDescriptors: [],
    }),
    true,
  );
  assert.equal(
    interactionLeafNeedsQualityRepair({
      title: "Builder Mode index",
      summary: "notion-related-pages.md summarized the Builder Mode research.",
      body: "# Builder Mode index\n\nConcrete detail retained.",
      subjectKey: "builder_mode_index",
      relatedInfo: {
        relatedEntities: [
          {
            entityType: "topic",
            entityKey: "topic:topic",
            label: "topic",
          },
        ],
        relations: [
          {
            relationType: "about",
            entityKey: "topic:topic",
          },
        ],
      },
      artifactDescriptors: [],
    }),
    true,
  );
  assert.equal(
    interactionLeafNeedsQualityRepair({
      title: "Deliverable-backed outreach memory",
      summary: "Ben Book at anyIP followed up on the rollout.",
      body: "# Deliverable-backed outreach memory\n\nConcrete detail retained.",
      subjectKey: "deliverable_backed_outreach",
      relatedInfo: {
        relatedEntities: [
          {
            entityType: "person",
            entityKey: "person:ben-book",
            label: "Ben Book",
          },
          {
            entityType: "artifact",
            entityKey: "artifact:output:output-1",
            label: "outreach.md",
          },
        ],
        relations: [
          {
            relationType: "contacted_by",
            entityKey: "person:ben-book",
          },
        ],
      },
      artifactDescriptors: [
        {
          entityKey: "artifact:output:output-1",
          title: "outreach.md",
          sourceTurnInputId: "turn-1",
        },
      ],
    }),
    true,
  );
  assert.equal(
    interactionLeafNeedsQualityRepair({
      title: "External outreach contact",
      summary: "Ben Book at anyIP emailed the user personally about holaboss.",
      body: "# External outreach contact\n\nConcrete detail retained.",
      subjectKey: "external_outreach_contact",
      relatedInfo: {
        relatedEntities: [
          {
            entityType: "person",
            entityKey: "person:ben-book",
            label: "Ben Book",
          },
          {
            entityType: "artifact",
            entityKey: "artifact:output:output-1",
            label: "outreach.md",
          },
        ],
        relations: [
          {
            relationType: "contacted_by",
            entityKey: "person:ben-book",
          },
          {
            relationType: "derived_from",
            entityKey: "artifact:output:output-1",
          },
        ],
      },
      artifactDescriptors: [
        {
          entityKey: "artifact:output:output-1",
          title: "outreach.md",
          sourceTurnInputId: "turn-1",
        },
      ],
    }),
    false,
  );
});

test("relatedInfoNeedsCanonicalRewrite detects legacy related keys that resolve to canonical workspace identities", () => {
  assert.equal(
    relatedInfoNeedsCanonicalRewrite({
      original: {
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
            relationType: "works_at",
            entityKey: "organization:anyip",
          },
        ],
      },
      canonical: {
        relatedEntities: [
          {
            entityType: "organization",
            entityKey: "organization:entity:interaction:customer:anyip",
            label: "anyIP",
          },
          {
            entityType: "person",
            entityKey: "person:entity:interaction:person:ben-book",
            label: "Ben Book",
          },
        ],
        relations: [
          {
            relationType: "contacted_by",
            entityKey: "person:entity:interaction:person:ben-book",
          },
          {
            relationType: "works_at",
            entityKey: "organization:entity:interaction:customer:anyip",
          },
        ],
      },
    }),
    true,
  );
  assert.equal(
    relatedInfoNeedsCanonicalRewrite({
      original: {
        relatedEntities: [
          {
            entityType: "person",
            entityKey: "person:entity:interaction:person:ben-book",
            label: "Ben Book",
          },
        ],
        relations: [
          {
            relationType: "contacted_by",
            entityKey: "person:entity:interaction:person:ben-book",
          },
        ],
      },
      canonical: {
        relatedEntities: [
          {
            entityType: "person",
            entityKey: "person:entity:interaction:person:ben-book",
            label: "Ben Book",
          },
        ],
        relations: [
          {
            relationType: "contacted_by",
            entityKey: "person:entity:interaction:person:ben-book",
          },
        ],
      },
    }),
    false,
  );
});

test("needsModelAssistedInteractionLeafRelationRepair detects empty or artifact-only relation graphs", () => {
  assert.equal(
    needsModelAssistedInteractionLeafRelationRepair({
      relatedInfo: {
        relatedEntities: [],
        relations: [],
      },
      hasProcessedMarker: false,
    }),
    true,
  );
  assert.equal(
    needsModelAssistedInteractionLeafRelationRepair({
      relatedInfo: {
        relatedEntities: [
          {
            entityType: "artifact",
            entityKey: "artifact:output:output-1",
            label: "outreach.md",
          },
        ],
        relations: [
          {
            relationType: "derived_from",
            entityKey: "artifact:output:output-1",
          },
          {
            relationType: "mentions",
            entityKey: "artifact:output:output-1",
          },
        ],
      },
      hasProcessedMarker: false,
    }),
    true,
  );
  assert.equal(
    needsModelAssistedInteractionLeafRelationRepair({
      relatedInfo: {
        relatedEntities: [
          {
            entityType: "topic",
            entityKey: "topic:entity:interaction:topic:builder-mode",
            label: "Builder Mode",
          },
          {
            entityType: "artifact",
            entityKey: "artifact:output:output-1",
            label: "outreach.md",
          },
        ],
        relations: [
          {
            relationType: "about",
            entityKey: "topic:entity:interaction:topic:builder-mode",
          },
          {
            relationType: "derived_from",
            entityKey: "artifact:output:output-1",
          },
        ],
      },
      hasProcessedMarker: false,
    }),
    true,
  );
  assert.equal(
    needsModelAssistedInteractionLeafRelationRepair({
      relatedInfo: {
        relatedEntities: [
          {
            entityType: "person",
            entityKey: "person:entity:interaction:person:ben-book",
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
            relationType: "about",
            entityKey: "person:entity:interaction:person:ben-book",
          },
          {
            relationType: "mentions",
            entityKey: "organization:anyip",
          },
        ],
      },
      hasProcessedMarker: false,
    }),
    false,
  );
  assert.equal(
    needsModelAssistedInteractionLeafRelationRepair({
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
      hasProcessedMarker: false,
    }),
    false,
  );
  assert.equal(
    needsModelAssistedInteractionLeafRelationRepair({
      relatedInfo: {
        relatedEntities: [],
        relations: [],
      },
      hasProcessedMarker: true,
    }),
    false,
  );
});

test("shouldForceModelInteractionLeafRelationRepair retries weak graphs only when the processed marker is stale or absent", () => {
  const artifactOnlyRelatedInfo = {
    relatedEntities: [
      {
        entityType: "artifact" as const,
        entityKey: "artifact:output:output-1",
        label: "outreach.md",
      },
    ],
    relations: [
      {
        relationType: "derived_from",
        entityKey: "artifact:output:output-1",
      },
      {
        relationType: "mentions",
        entityKey: "artifact:output:output-1",
      },
    ],
  };

  assert.equal(
    shouldForceModelInteractionLeafRelationRepair({
      relatedInfo: artifactOnlyRelatedInfo,
      hasProcessedMarker: false,
      strippedStaleRelatedInfo: false,
    }),
    true,
  );
  assert.equal(
    shouldForceModelInteractionLeafRelationRepair({
      relatedInfo: artifactOnlyRelatedInfo,
      hasProcessedMarker: true,
      strippedStaleRelatedInfo: false,
    }),
    false,
  );
  assert.equal(
    shouldForceModelInteractionLeafRelationRepair({
      relatedInfo: artifactOnlyRelatedInfo,
      hasProcessedMarker: true,
      strippedStaleRelatedInfo: true,
    }),
    true,
  );
  assert.equal(
    shouldForceModelInteractionLeafRelationRepair({
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
      hasProcessedMarker: false,
      strippedStaleRelatedInfo: false,
    }),
    false,
  );
});
