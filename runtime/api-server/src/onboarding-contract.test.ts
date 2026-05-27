import assert from "node:assert/strict";
import test from "node:test";

import {
  ONBOARDING_ALIGNMENT_REPORT_SCHEMA_VERSION,
  ONBOARDING_ALIGNMENT_REPORT_TYPE,
  parseOnboardingAlignmentReport,
  sanitizeOnboardingAlignmentReport,
} from "../../../shared/onboarding-contract.js";

test("sanitizeOnboardingAlignmentReport normalizes shorthand alignment payloads", () => {
  const report = sanitizeOnboardingAlignmentReport({
    summary: "Set up a lightweight CRM workspace",
    markdown: "# Alignment report",
    workspace_structure: ["clients/", { path: "playbooks/", purpose: "repeatable SOPs" }],
    app_builds: [
      "deal-tracker",
      {
        app_id: "activity-feed",
        summary: "Start with a thin recent-activity surface.",
        starter_scope: ["Show recent events", "Filter by owner"],
      },
    ],
    skills: ["inbox-triage"],
    cronjobs: [{ name: "weekly pipeline digest", cron: "0 9 * * 1" }],
    ai_manager_behavior: "Keep recommendations concise and execution-focused.",
    open_questions: ["Should the CRM app support shared ownership?"],
    implementation_notes: ["Start with the sales team only."],
  });

  assert.equal(report.report_type, ONBOARDING_ALIGNMENT_REPORT_TYPE);
  assert.equal(report.schema_version, ONBOARDING_ALIGNMENT_REPORT_SCHEMA_VERSION);
  assert.deepEqual(report.workspace_structure, {
    summary: null,
    paths: [
      { path: "clients/", purpose: null },
      { path: "playbooks/", purpose: "repeatable SOPs" },
    ],
    notes: [],
  });
  assert.deepEqual(report.app_builds, [
    {
      app_id: "deal-tracker",
      summary: null,
      starter_scope: [],
      notes: [],
    },
    {
      app_id: "activity-feed",
      summary: "Start with a thin recent-activity surface.",
      starter_scope: ["Show recent events", "Filter by owner"],
      notes: [],
    },
  ]);
  assert.deepEqual(report.ai_manager_behavior, {
    summary: "Keep recommendations concise and execution-focused.",
    personality_traits: [],
    default_behaviors: [],
    guardrails: [],
    notes: [],
  });
  assert.deepEqual(report.open_questions, [
    {
      question: "Should the CRM app support shared ownership?",
      blocking: false,
      notes: null,
    },
  ]);
});

test("parseOnboardingAlignmentReport rejects reports without summary or markdown", () => {
  assert.equal(
    parseOnboardingAlignmentReport({
      markdown: "# Alignment report",
    }),
    null,
  );
  assert.equal(
    parseOnboardingAlignmentReport({
      summary: "Missing markdown",
    }),
    null,
  );
});
