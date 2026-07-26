export const ONBOARDING_ALIGNMENT_REPORT_TYPE = "onboarding_alignment_report";
export const ONBOARDING_ALIGNMENT_REPORT_SCHEMA_VERSION = 2;

type UnknownRecord = Record<string, unknown>;

const WORK_CONTEXT_SYSTEM_STATUSES = [
  "confirmed",
  "assumed",
  "unknown",
] as const;
const RESEARCH_SOURCE_TYPES = [
  "user",
  "workspace",
  "external_best_practice",
] as const;
const RESEARCH_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
const CRONJOB_REVIEW_POLICIES = [
  "auto",
  "notify",
  "approval_required",
] as const;

export type OnboardingAlignmentUserIntent = {
  problem_statement: string | null;
  desired_outcome: string | null;
  success_criteria: string[];
  in_scope: string[];
  out_of_scope: string[];
};

export type OnboardingAlignmentWorkContextWorkflow = {
  name: string;
  description: string | null;
  systems_used: string[];
  pain_points: string[];
  agent_native_opportunity: string | null;
  notes: string[];
};

export type OnboardingAlignmentWorkContextSystem = {
  system_id: string;
  purpose: string | null;
  status: (typeof WORK_CONTEXT_SYSTEM_STATUSES)[number];
  notes: string[];
};

export type OnboardingAlignmentWorkContext = {
  business_context: string | null;
  current_workflows: OnboardingAlignmentWorkContextWorkflow[];
  existing_systems: OnboardingAlignmentWorkContextSystem[];
  constraints: string[];
  notes: string[];
};

export type OnboardingAlignmentResearchBasisItem = {
  topic: string;
  finding: string | null;
  implication: string | null;
  source_type: (typeof RESEARCH_SOURCE_TYPES)[number];
  confidence: (typeof RESEARCH_CONFIDENCE_LEVELS)[number];
  notes: string[];
};

export type OnboardingAlignmentIntegration = {
  integration_id: string;
  required: boolean;
  rationale: string | null;
  context_unlocked: string[];
  actions_unlocked: string[];
  setup_notes: string[];
};

export type OnboardingAlignmentWorkspaceRulesSection = {
  section: string;
  guidance: string[];
};

export type OnboardingAlignmentWorkspaceRules = {
  summary: string | null;
  agents_md_sections: OnboardingAlignmentWorkspaceRulesSection[];
  notes: string[];
};

export type OnboardingAlignmentWorkspacePath = {
  path: string;
  purpose: string | null;
};

export type OnboardingAlignmentWorkspaceStructure = {
  summary: string | null;
  paths: OnboardingAlignmentWorkspacePath[];
  notes: string[];
};

export type OnboardingAlignmentApp = {
  app_id: string;
  purpose: string | null;
  primary_user: string | null;
  rationale: string | null;
  starter_scope: string[];
  data_dependencies: string[];
  notes: string[];
};

export type OnboardingAlignmentCronjob = {
  job_id: string;
  name: string;
  required_integrations: string[];
  schedule: string | null;
  goal: string | null;
  instruction: string | null;
  expected_output: string | null;
  review_policy: (typeof CRONJOB_REVIEW_POLICIES)[number] | null;
  failure_policy: string | null;
  notes: string[];
};

export type OnboardingAlignmentOpenQuestion = {
  question: string;
  blocking: boolean;
  notes: string | null;
};

export type OnboardingAlignmentReport = {
  report_type: typeof ONBOARDING_ALIGNMENT_REPORT_TYPE;
  schema_version: typeof ONBOARDING_ALIGNMENT_REPORT_SCHEMA_VERSION;
  summary: string;
  markdown: string;
  user_intent: OnboardingAlignmentUserIntent;
  work_context: OnboardingAlignmentWorkContext;
  research_basis: OnboardingAlignmentResearchBasisItem[];
  integrations: OnboardingAlignmentIntegration[];
  workspace_rules: OnboardingAlignmentWorkspaceRules;
  workspace_structure: OnboardingAlignmentWorkspaceStructure;
  apps: OnboardingAlignmentApp[];
  cronjobs: OnboardingAlignmentCronjob[];
  open_questions: OnboardingAlignmentOpenQuestion[];
  implementation_notes: string[];
};

type LegacyAiManagerBehavior = {
  summary: string | null;
  personality_traits: string[];
  default_behaviors: string[];
  guardrails: string[];
  notes: string[];
};

function normalizedString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as UnknownRecord;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizedString(item))
    .filter((item) => item.length > 0);
}

function stringListLoose(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }
  return stringList(value);
}

function readString(
  value: UnknownRecord,
  keys: string[],
  fallback = "",
): string {
  for (const key of keys) {
    const normalized = normalizedString(value[key]);
    if (normalized) {
      return normalized;
    }
  }
  return fallback;
}

function readOptionalString(
  value: UnknownRecord,
  keys: string[],
): string | null {
  const normalized = readString(value, keys);
  return normalized || null;
}

function readStringList(
  value: UnknownRecord,
  keys: string[],
): string[] {
  for (const key of keys) {
    const items = stringListLoose(value[key]);
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

function readArray(
  value: UnknownRecord,
  keys: string[],
): unknown[] {
  for (const key of keys) {
    if (Array.isArray(value[key])) {
      return value[key] as unknown[];
    }
  }
  return [];
}

function readBoolean(
  value: UnknownRecord,
  keys: string[],
  fallback = false,
): boolean {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "string") {
      const normalized = candidate.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
  }
  return fallback;
}

function readEnumValue<T extends string>(
  value: UnknownRecord,
  keys: string[],
  allowed: readonly T[],
  fallback: T,
): T {
  const allowedSet = new Set<string>(allowed);
  for (const key of keys) {
    const normalized = normalizedString(value[key]).toLowerCase();
    if (normalized && allowedSet.has(normalized)) {
      return normalized as T;
    }
  }
  return fallback;
}

function defaultSlug(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function sanitizeUserIntent(
  value: unknown,
): OnboardingAlignmentUserIntent {
  if (typeof value === "string") {
    const problemStatement = normalizedString(value);
    return {
      problem_statement: problemStatement || null,
      desired_outcome: null,
      success_criteria: [],
      in_scope: [],
      out_of_scope: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    return {
      problem_statement: null,
      desired_outcome: null,
      success_criteria: [],
      in_scope: [],
      out_of_scope: [],
    };
  }
  return {
    problem_statement: readOptionalString(record, [
      "problem_statement",
      "problem",
      "summary",
      "description",
    ]),
    desired_outcome: readOptionalString(record, [
      "desired_outcome",
      "outcome",
      "goal",
      "target_state",
    ]),
    success_criteria: readStringList(record, [
      "success_criteria",
      "success_metrics",
      "success",
    ]),
    in_scope: readStringList(record, ["in_scope", "scope"]),
    out_of_scope: readStringList(record, ["out_of_scope", "excluded_scope"]),
  };
}

function sanitizeWorkContextWorkflow(
  value: unknown,
  index: number,
): OnboardingAlignmentWorkContextWorkflow {
  if (typeof value === "string") {
    const name = normalizedString(value);
    if (!name) {
      throw new Error(`work_context.current_workflows[${index}] must not be empty`);
    }
    return {
      name,
      description: null,
      systems_used: [],
      pain_points: [],
      agent_native_opportunity: null,
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(
      `work_context.current_workflows[${index}] must be an object or string`,
    );
  }
  const name = readString(record, ["name", "title", "workflow"]);
  if (!name) {
    throw new Error(`work_context.current_workflows[${index}].name is required`);
  }
  return {
    name,
    description: readOptionalString(record, [
      "description",
      "summary",
      "purpose",
    ]),
    systems_used: readStringList(record, [
      "systems_used",
      "systems",
      "tools",
      "integrations",
    ]),
    pain_points: readStringList(record, [
      "pain_points",
      "bottlenecks",
      "problems",
    ]),
    agent_native_opportunity: readOptionalString(record, [
      "agent_native_opportunity",
      "opportunity",
      "automation_opportunity",
    ]),
    notes: stringList(record.notes),
  };
}

function sanitizeWorkContextSystem(
  value: unknown,
  index: number,
): OnboardingAlignmentWorkContextSystem {
  if (typeof value === "string") {
    const systemId = normalizedString(value);
    if (!systemId) {
      throw new Error(`work_context.existing_systems[${index}] must not be empty`);
    }
    return {
      system_id: systemId,
      purpose: null,
      status: "unknown",
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(
      `work_context.existing_systems[${index}] must be an object or string`,
    );
  }
  const systemId = readString(record, ["system_id", "integration_id", "id", "name"]);
  if (!systemId) {
    throw new Error(`work_context.existing_systems[${index}].system_id is required`);
  }
  return {
    system_id: systemId,
    purpose: readOptionalString(record, [
      "purpose",
      "summary",
      "description",
      "role",
    ]),
    status: readEnumValue(
      record,
      ["status"],
      WORK_CONTEXT_SYSTEM_STATUSES,
      "unknown",
    ),
    notes: stringList(record.notes),
  };
}

function sanitizeWorkContext(
  value: unknown,
): OnboardingAlignmentWorkContext {
  if (typeof value === "string") {
    const businessContext = normalizedString(value);
    return {
      business_context: businessContext || null,
      current_workflows: [],
      existing_systems: [],
      constraints: [],
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    return {
      business_context: null,
      current_workflows: [],
      existing_systems: [],
      constraints: [],
      notes: [],
    };
  }
  return {
    business_context: readOptionalString(record, [
      "business_context",
      "summary",
      "description",
      "context",
    ]),
    current_workflows: readArray(record, [
      "current_workflows",
      "workflows",
    ]).map((item, itemIndex) => sanitizeWorkContextWorkflow(item, itemIndex)),
    existing_systems: readArray(record, [
      "existing_systems",
      "systems",
    ]).map((item, itemIndex) => sanitizeWorkContextSystem(item, itemIndex)),
    constraints: readStringList(record, ["constraints", "guardrails"]),
    notes: stringList(record.notes),
  };
}

function sanitizeResearchBasisItem(
  value: unknown,
  index: number,
): OnboardingAlignmentResearchBasisItem {
  if (typeof value === "string") {
    const topic = normalizedString(value);
    if (!topic) {
      throw new Error(`research_basis[${index}] must not be empty`);
    }
    return {
      topic,
      finding: topic,
      implication: null,
      source_type: "external_best_practice",
      confidence: "medium",
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`research_basis[${index}] must be an object or string`);
  }
  const topic = readString(record, ["topic", "title", "subject"]);
  if (!topic) {
    throw new Error(`research_basis[${index}].topic is required`);
  }
  return {
    topic,
    finding: readOptionalString(record, [
      "finding",
      "summary",
      "description",
    ]),
    implication: readOptionalString(record, [
      "implication",
      "why_it_matters",
      "impact",
    ]),
    source_type: readEnumValue(
      record,
      ["source_type", "source"],
      RESEARCH_SOURCE_TYPES,
      "external_best_practice",
    ),
    confidence: readEnumValue(
      record,
      ["confidence"],
      RESEARCH_CONFIDENCE_LEVELS,
      "medium",
    ),
    notes: stringList(record.notes),
  };
}

function sanitizeIntegration(
  value: unknown,
  index: number,
): OnboardingAlignmentIntegration {
  if (typeof value === "string") {
    const integrationId = normalizedString(value);
    if (!integrationId) {
      throw new Error(`integrations[${index}] must not be empty`);
    }
    return {
      integration_id: integrationId,
      required: true,
      rationale: null,
      context_unlocked: [],
      actions_unlocked: [],
      setup_notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`integrations[${index}] must be an object or string`);
  }
  const integrationId = readString(record, [
    "integration_id",
    "provider_id",
    "system_id",
    "id",
    "name",
  ]);
  if (!integrationId) {
    throw new Error(`integrations[${index}].integration_id is required`);
  }
  return {
    integration_id: integrationId,
    required: readBoolean(record, ["required"], true),
    rationale: readOptionalString(record, [
      "rationale",
      "purpose",
      "summary",
      "description",
    ]),
    context_unlocked: readStringList(record, [
      "context_unlocked",
      "data_unlocked",
      "context",
    ]),
    actions_unlocked: readStringList(record, [
      "actions_unlocked",
      "actions",
      "capabilities",
    ]),
    setup_notes: readStringList(record, [
      "setup_notes",
      "notes",
      "prerequisites",
    ]),
  };
}

function sanitizeWorkspaceRulesSection(
  value: unknown,
  index: number,
): OnboardingAlignmentWorkspaceRulesSection {
  if (typeof value === "string") {
    const section = normalizedString(value);
    if (!section) {
      throw new Error(`workspace_rules.agents_md_sections[${index}] must not be empty`);
    }
    return {
      section,
      guidance: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(
      `workspace_rules.agents_md_sections[${index}] must be an object or string`,
    );
  }
  const section = readString(record, ["section", "title", "name"]);
  if (!section) {
    throw new Error(
      `workspace_rules.agents_md_sections[${index}].section is required`,
    );
  }
  return {
    section,
    guidance: readStringList(record, ["guidance", "rules", "points"]),
  };
}

function sanitizeWorkspaceRules(
  value: unknown,
): OnboardingAlignmentWorkspaceRules {
  if (typeof value === "string") {
    const summary = normalizedString(value);
    return {
      summary: summary || null,
      agents_md_sections: [],
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    return {
      summary: null,
      agents_md_sections: [],
      notes: [],
    };
  }
  return {
    summary: readOptionalString(record, [
      "summary",
      "description",
      "purpose",
    ]),
    agents_md_sections: readArray(record, [
      "agents_md_sections",
      "sections",
    ]).map((item, itemIndex) => sanitizeWorkspaceRulesSection(item, itemIndex)),
    notes: stringList(record.notes),
  };
}

function sanitizeWorkspacePath(
  value: unknown,
  index: number,
): OnboardingAlignmentWorkspacePath {
  if (typeof value === "string") {
    const path = normalizedString(value);
    if (!path) {
      throw new Error(`workspace_structure.paths[${index}] must not be empty`);
    }
    return {
      path,
      purpose: null,
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(
      `workspace_structure.paths[${index}] must be an object or string`,
    );
  }
  const path = readString(record, ["path", "id", "name", "directory"]);
  if (!path) {
    throw new Error(`workspace_structure.paths[${index}].path is required`);
  }
  return {
    path,
    purpose: readOptionalString(record, [
      "purpose",
      "summary",
      "description",
      "reason",
    ]),
  };
}

function sanitizeWorkspaceStructure(
  value: unknown,
): OnboardingAlignmentWorkspaceStructure {
  if (Array.isArray(value)) {
    return {
      summary: null,
      paths: value.map((item, itemIndex) => sanitizeWorkspacePath(item, itemIndex)),
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    return {
      summary: null,
      paths: [],
      notes: [],
    };
  }
  const rawPaths = Array.isArray(record.paths)
    ? record.paths
    : Array.isArray(record.directories)
      ? record.directories
      : Array.isArray(record.folders)
        ? record.folders
        : [];
  return {
    summary: readOptionalString(record, ["summary", "purpose", "description"]),
    paths: rawPaths.map((item, itemIndex) => sanitizeWorkspacePath(item, itemIndex)),
    notes: stringList(record.notes),
  };
}

function sanitizeApp(
  value: unknown,
  index: number,
): OnboardingAlignmentApp {
  if (typeof value === "string") {
    const appId = normalizedString(value);
    if (!appId) {
      throw new Error(`apps[${index}] must not be empty`);
    }
    return {
      app_id: appId,
      purpose: null,
      primary_user: null,
      rationale: null,
      starter_scope: [],
      data_dependencies: [],
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`apps[${index}] must be an object or string`);
  }
  const appId = readString(record, ["app_id", "id", "slug", "name"]);
  if (!appId) {
    throw new Error(`apps[${index}].app_id is required`);
  }
  return {
    app_id: appId,
    purpose: readOptionalString(record, [
      "purpose",
      "summary",
      "description",
      "title",
    ]),
    primary_user: readOptionalString(record, [
      "primary_user",
      "user",
      "owner",
    ]),
    rationale: readOptionalString(record, [
      "rationale",
      "reason",
      "why",
    ]),
    starter_scope: readStringList(record, [
      "starter_scope",
      "scope",
      "slices",
      "core_features",
      "features",
    ]),
    data_dependencies: readStringList(record, [
      "data_dependencies",
      "required_data",
      "integrations",
    ]),
    notes: stringList(record.notes),
  };
}

function sanitizeCronjob(
  value: unknown,
  index: number,
): OnboardingAlignmentCronjob {
  if (typeof value === "string") {
    const name = normalizedString(value);
    if (!name) {
      throw new Error(`cronjobs[${index}] must not be empty`);
    }
    return {
      job_id: defaultSlug(name, `cronjob-${index + 1}`),
      name,
      required_integrations: [],
      schedule: null,
      goal: null,
      instruction: null,
      expected_output: null,
      review_policy: null,
      failure_policy: null,
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`cronjobs[${index}] must be an object or string`);
  }
  const name = readString(record, ["name", "title"]);
  if (!name) {
    throw new Error(`cronjobs[${index}].name is required`);
  }
  return {
    job_id:
      readString(record, ["job_id", "id", "slug"]) ||
      defaultSlug(name, `cronjob-${index + 1}`),
    name,
    required_integrations: readStringList(record, [
      "required_integrations",
      "integrations",
      "depends_on_integrations",
    ]),
    schedule: readOptionalString(record, ["schedule", "cron"]),
    goal: readOptionalString(record, [
      "goal",
      "summary",
      "purpose",
      "description",
    ]),
    instruction: readOptionalString(record, ["instruction", "prompt"]),
    expected_output: readOptionalString(record, [
      "expected_output",
      "output",
      "delivery",
    ]),
    review_policy: readOptionalString(record, ["review_policy"])
      ? readEnumValue(
          record,
          ["review_policy"],
          CRONJOB_REVIEW_POLICIES,
          "notify",
        )
      : null,
    failure_policy: readOptionalString(record, [
      "failure_policy",
      "on_failure",
      "error_handling",
    ]),
    notes: stringList(record.notes),
  };
}

function sanitizeOpenQuestion(
  value: unknown,
  index: number,
): OnboardingAlignmentOpenQuestion {
  if (typeof value === "string") {
    const question = normalizedString(value);
    if (!question) {
      throw new Error(`open_questions[${index}] must not be empty`);
    }
    return {
      question,
      blocking: false,
      notes: null,
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`open_questions[${index}] must be an object or string`);
  }
  const question = readString(record, [
    "question",
    "prompt",
    "summary",
    "description",
  ]);
  if (!question) {
    throw new Error(`open_questions[${index}].question is required`);
  }
  return {
    question,
    blocking: record.blocking === true,
    notes: readOptionalString(record, ["notes", "note", "context"]),
  };
}

function sanitizeLegacyAiManagerBehavior(
  value: unknown,
): LegacyAiManagerBehavior {
  if (typeof value === "string") {
    const summary = normalizedString(value);
    return {
      summary: summary || null,
      personality_traits: [],
      default_behaviors: [],
      guardrails: [],
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    return {
      summary: null,
      personality_traits: [],
      default_behaviors: [],
      guardrails: [],
      notes: [],
    };
  }
  return {
    summary: readOptionalString(record, ["summary", "description", "purpose"]),
    personality_traits: readStringList(record, [
      "personality_traits",
      "personality",
    ]),
    default_behaviors: readStringList(record, [
      "default_behaviors",
      "behaviors",
    ]),
    guardrails: readStringList(record, ["guardrails", "constraints"]),
    notes: stringList(record.notes),
  };
}

function legacyWorkspaceRules(
  behavior: LegacyAiManagerBehavior,
): OnboardingAlignmentWorkspaceRules {
  const guidance = [
    ...behavior.default_behaviors,
    ...behavior.guardrails,
    ...behavior.personality_traits.map(
      (trait) => `Preferred manager trait: ${trait}`,
    ),
    ...behavior.notes,
  ];
  return {
    summary: behavior.summary,
    agents_md_sections:
      guidance.length > 0
        ? [
            {
              section: "AI manager behavior",
              guidance,
            },
          ]
        : [],
    notes: [],
  };
}

export function sanitizeOnboardingAlignmentReport(
  value: UnknownRecord,
): OnboardingAlignmentReport {
  const summary = readString(value, ["summary"]);
  if (!summary) {
    throw new Error("alignment report summary is required");
  }
  const markdown = readString(value, ["markdown"]);
  if (!markdown) {
    throw new Error("alignment report markdown is required");
  }

  const legacyBehavior = sanitizeLegacyAiManagerBehavior(value.ai_manager_behavior);

  const rawResearchBasis = Array.isArray(value.research_basis)
    ? value.research_basis
    : Array.isArray(value.research)
      ? value.research
      : [];
  const rawIntegrations = Array.isArray(value.integrations)
    ? value.integrations
    : Array.isArray(value.required_integrations)
      ? value.required_integrations
      : [];
  const rawApps = Array.isArray(value.apps)
    ? value.apps
    : Array.isArray(value.app_builds)
      ? value.app_builds
      : Array.isArray(value.apps_to_create)
        ? value.apps_to_create
        : [];
  const rawCronjobs = Array.isArray(value.cronjobs) ? value.cronjobs : [];
  const rawOpenQuestions = Array.isArray(value.open_questions)
    ? value.open_questions
    : [];

  return {
    report_type: ONBOARDING_ALIGNMENT_REPORT_TYPE,
    schema_version: ONBOARDING_ALIGNMENT_REPORT_SCHEMA_VERSION,
    summary,
    markdown,
    user_intent: sanitizeUserIntent(value.user_intent),
    work_context: sanitizeWorkContext(value.work_context),
    research_basis: rawResearchBasis.map((item, itemIndex) =>
      sanitizeResearchBasisItem(item, itemIndex),
    ),
    integrations: rawIntegrations.map((item, itemIndex) =>
      sanitizeIntegration(item, itemIndex),
    ),
    workspace_rules:
      value.workspace_rules !== undefined
        ? sanitizeWorkspaceRules(value.workspace_rules)
        : legacyWorkspaceRules(legacyBehavior),
    workspace_structure: sanitizeWorkspaceStructure(value.workspace_structure),
    apps: rawApps.map((item, itemIndex) => sanitizeApp(item, itemIndex)),
    cronjobs: rawCronjobs.map((item, itemIndex) =>
      sanitizeCronjob(item, itemIndex),
    ),
    open_questions: rawOpenQuestions.map((item, itemIndex) =>
      sanitizeOpenQuestion(item, itemIndex),
    ),
    implementation_notes: Array.isArray(value.implementation_notes)
      ? stringList(value.implementation_notes)
      : Array.isArray(value.implementation_plan)
        ? stringList(value.implementation_plan)
        : stringListLoose(value.implementation_notes),
  };
}

export function parseOnboardingAlignmentReport(
  value: unknown,
): OnboardingAlignmentReport | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  try {
    return sanitizeOnboardingAlignmentReport(record);
  } catch {
    return null;
  }
}
