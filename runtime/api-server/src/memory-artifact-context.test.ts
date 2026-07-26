import assert from "node:assert/strict";
import test from "node:test";

import { artifactContextEvidenceLines } from "./memory-artifact-context.js";

test("artifactContextEvidenceLines formats structured artifact excerpts into repair evidence lines", () => {
  const evidenceLines = artifactContextEvidenceLines({
    artifactContexts: [
      {
        sourceKind: "tool_result",
        treeId: "tree-tool-1",
        title: "holaboss_composio.gmail_fetch_emails",
        provider: "gmail",
        accountNamespace: "ops@example.com",
        canonicalEntityKey: "artifact:tool-result:gmail:call-1",
        excerpts: [
          "Ben Book at anyIP reached out personally about holaboss.",
          "Follow-up should stay attached to the same thread.",
        ],
      },
      {
        sourceKind: "output_artifact",
        treeId: "tree-output-1",
        title: "outreach-delegated.md",
        provider: null,
        accountNamespace: null,
        canonicalEntityKey: "artifact:output:output-1",
        excerpts: [
          "Ben Book at anyIP should stay attached to holaboss personal outreach memory.",
        ],
      },
    ],
    maxExcerptsPerArtifact: 2,
    maxCharsPerExcerpt: 90,
  });

  assert.deepEqual(evidenceLines, [
    "[tool_result gmail ops@example.com] holaboss_composio.gmail_fetch_emails => Ben Book at anyIP reached out personally about holaboss.",
    "[tool_result gmail ops@example.com] holaboss_composio.gmail_fetch_emails => Follow-up should stay attached to the same thread.",
    "[output_artifact] outreach-delegated.md => Ben Book at anyIP should stay attached to holaboss personal outreach memory.",
  ]);
});
