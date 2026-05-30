import assert from "node:assert/strict";
import test from "node:test";

import {
  ONBOARDING_ALIGNMENT_REPORT_SCHEMA_VERSION,
  ONBOARDING_ALIGNMENT_REPORT_TYPE,
  parseOnboardingAlignmentReport,
  sanitizeOnboardingAlignmentReport,
} from "../../../shared/onboarding-contract.js";

test("sanitizeOnboardingAlignmentReport normalizes the v2 alignment payload", () => {
  const report = sanitizeOnboardingAlignmentReport({
    summary: "Set up an agent-native CRM workspace",
    markdown: "# Alignment report",
    user_intent: {
      problem_statement: "Pipeline management is fragmented across tools.",
      desired_outcome: "Give the sales lead one workspace to monitor and delegate follow-up work.",
      success_criteria: ["Weekly pipeline digest", "Fast lead follow-up"],
      in_scope: ["Pipeline visibility", "Follow-up operations"],
      out_of_scope: ["Full billing automation"],
    },
    work_context: {
      business_context: "Boutique services agency with a small sales team.",
      current_workflows: [
        {
          name: "Lead follow-up",
          systems_used: ["hubspot", "gmail"],
          pain_points: ["Leads sit too long without follow-up"],
          agent_native_opportunity: "Assign and monitor follow-up work.",
        },
      ],
      existing_systems: [
        {
          system_id: "hubspot",
          purpose: "Source of truth for deals",
          status: "confirmed",
        },
      ],
      constraints: ["Keep v1 focused on sales only"],
    },
    research_basis: [
      {
        topic: "CRM operating model",
        finding: "A lightweight pipeline dashboard and digest creates early leverage.",
        implication: "Start with one app and one recurring digest.",
        source_type: "external_best_practice",
        confidence: "medium",
      },
    ],
    integrations: [
      {
        integration_id: "hubspot",
        required: true,
        rationale: "Primary deal context",
        context_unlocked: ["Deal stage", "Owner", "Last activity"],
        actions_unlocked: ["Read account activity"],
        consumed_by_teammates: ["sales-ops"],
      },
    ],
    teammates: [
      {
        teammate_id: "sales-ops",
        name: "Sales Ops",
        remit: "Own pipeline hygiene and follow-up orchestration.",
        jobs_to_be_done: ["Monitor stale deals", "Prepare weekly digests"],
        system_prompt: {
          mission: "Keep the pipeline current and actionable.",
          operating_rules: ["Prefer thin-slice execution first."],
          quality_bar: ["Never fabricate CRM state."],
        },
        tools: ["workspace_data_query", "cronjobs_create"],
        skills: [
          {
            skill_id: "pipeline-digest",
            purpose: "Create a weekly pipeline digest.",
            triggers: ["Weekly digest run"],
          },
        ],
      },
    ],
    workspace_rules: {
      summary: "Keep the workspace execution-focused and safe.",
      agents_md_sections: [
        {
          section: "Delegation",
          guidance: ["Use Sales Ops for pipeline work."],
        },
      ],
    },
    workspace_structure: [
      "clients/",
      { path: "playbooks/", purpose: "Repeatable SOPs" },
    ],
    apps: [
      {
        app_id: "deal-tracker",
        purpose: "Monitor the live pipeline.",
        starter_scope: ["Show stale deals", "Filter by owner"],
      },
    ],
    cronjobs: [
      {
        name: "weekly pipeline digest",
        owner_teammate_id: "sales-ops",
        cron: "0 9 * * 1",
        goal: "Summarize deal health each week.",
      },
    ],
    open_questions: ["Should the CRM app support shared ownership?"],
    implementation_notes: ["Start with the sales team only."],
  });

  assert.equal(report.report_type, ONBOARDING_ALIGNMENT_REPORT_TYPE);
  assert.equal(
    report.schema_version,
    ONBOARDING_ALIGNMENT_REPORT_SCHEMA_VERSION,
  );
  assert.equal(report.user_intent.problem_statement, "Pipeline management is fragmented across tools.");
  assert.deepEqual(report.work_context.current_workflows, [
    {
      name: "Lead follow-up",
      description: null,
      systems_used: ["hubspot", "gmail"],
      pain_points: ["Leads sit too long without follow-up"],
      agent_native_opportunity: "Assign and monitor follow-up work.",
      notes: [],
    },
  ]);
  assert.deepEqual(report.integrations, [
    {
      integration_id: "hubspot",
      required: true,
      rationale: "Primary deal context",
      context_unlocked: ["Deal stage", "Owner", "Last activity"],
      actions_unlocked: ["Read account activity"],
      consumed_by_teammates: ["sales-ops"],
      setup_notes: [],
    },
  ]);
  assert.deepEqual(report.apps, [
    {
      app_id: "deal-tracker",
      purpose: "Monitor the live pipeline.",
      primary_user: null,
      rationale: null,
      starter_scope: ["Show stale deals", "Filter by owner"],
      data_dependencies: [],
      notes: [],
    },
  ]);
  assert.deepEqual(report.cronjobs, [
    {
      job_id: "weekly-pipeline-digest",
      name: "weekly pipeline digest",
      owner_teammate_id: "sales-ops",
      required_integrations: [],
      schedule: "0 9 * * 1",
      goal: "Summarize deal health each week.",
      instruction: null,
      expected_output: null,
      review_policy: null,
      failure_policy: null,
      notes: [],
    },
  ]);
});

test("sanitizeOnboardingAlignmentReport maps legacy shorthand into the v2 contract", () => {
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

  assert.deepEqual(report.workspace_structure, {
    summary: null,
    paths: [
      { path: "clients/", purpose: null },
      { path: "playbooks/", purpose: "repeatable SOPs" },
    ],
    notes: [],
  });
  assert.deepEqual(report.apps, [
    {
      app_id: "deal-tracker",
      purpose: null,
      primary_user: null,
      rationale: null,
      starter_scope: [],
      data_dependencies: [],
      notes: [],
    },
    {
      app_id: "activity-feed",
      purpose: "Start with a thin recent-activity surface.",
      primary_user: null,
      rationale: null,
      starter_scope: ["Show recent events", "Filter by owner"],
      data_dependencies: [],
      notes: [],
    },
  ]);
  assert.deepEqual(report.teammates, [
    {
      teammate_id: "general",
      name: "General",
      remit: "Keep recommendations concise and execution-focused.",
      jobs_to_be_done: [],
      boundaries: [],
      inputs: [],
      outputs: [],
      system_prompt: {
        mission: "Keep recommendations concise and execution-focused.",
        operating_rules: [],
        escalation_rules: [],
        quality_bar: [],
        notes: [],
      },
      tools: [],
      skills: [
        {
          skill_id: "inbox-triage",
          title: null,
          purpose: null,
          triggers: [],
          inputs: [],
          outputs: [],
          notes: [],
        },
      ],
      handoffs: [],
      notes: [],
    },
  ]);
  assert.deepEqual(report.workspace_rules, {
    summary: "Keep recommendations concise and execution-focused.",
    agents_md_sections: [],
    notes: [],
  });
  assert.deepEqual(report.cronjobs, [
    {
      job_id: "weekly-pipeline-digest",
      name: "weekly pipeline digest",
      owner_teammate_id: "general",
      required_integrations: [],
      schedule: "0 9 * * 1",
      goal: null,
      instruction: null,
      expected_output: null,
      review_policy: null,
      failure_policy: null,
      notes: [],
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
