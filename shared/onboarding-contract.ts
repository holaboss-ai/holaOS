export const ONBOARDING_ALIGNMENT_REPORT_TYPE = "onboarding_alignment_report";
export const ONBOARDING_ALIGNMENT_REPORT_SCHEMA_VERSION = 1;

type UnknownRecord = Record<string, unknown>;

export type OnboardingAlignmentWorkspacePath = {
  path: string;
  purpose: string | null;
};

export type OnboardingAlignmentAppBuild = {
  app_id: string;
  summary: string | null;
  starter_scope: string[];
  notes: string[];
};

export type OnboardingAlignmentSkill = {
  skill_id: string;
  title: string | null;
  purpose: string | null;
  triggers: string[];
  notes: string[];
};

export type OnboardingAlignmentCronjob = {
  name: string;
  schedule: string | null;
  summary: string | null;
  instruction: string | null;
  notes: string[];
};

export type OnboardingAlignmentOpenQuestion = {
  question: string;
  blocking: boolean;
  notes: string | null;
};

export type OnboardingAlignmentWorkspaceStructure = {
  summary: string | null;
  paths: OnboardingAlignmentWorkspacePath[];
  notes: string[];
};

export type OnboardingAlignmentAiManagerBehavior = {
  summary: string | null;
  personality_traits: string[];
  default_behaviors: string[];
  guardrails: string[];
  notes: string[];
};

export type OnboardingAlignmentReport = {
  report_type: typeof ONBOARDING_ALIGNMENT_REPORT_TYPE;
  schema_version: typeof ONBOARDING_ALIGNMENT_REPORT_SCHEMA_VERSION;
  summary: string;
  markdown: string;
  workspace_structure: OnboardingAlignmentWorkspaceStructure;
  app_builds: OnboardingAlignmentAppBuild[];
  skills: OnboardingAlignmentSkill[];
  cronjobs: OnboardingAlignmentCronjob[];
  ai_manager_behavior: OnboardingAlignmentAiManagerBehavior;
  open_questions: OnboardingAlignmentOpenQuestion[];
  implementation_notes: string[];
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
    throw new Error(`workspace_structure.paths[${index}] must be an object or string`);
  }
  const path = readString(record, ["path", "id", "name", "directory"]);
  if (!path) {
    throw new Error(`workspace_structure.paths[${index}].path is required`);
  }
  return {
    path,
    purpose: readOptionalString(record, ["purpose", "summary", "description", "reason"]),
  };
}

function sanitizeWorkspaceStructure(
  value: unknown,
): OnboardingAlignmentWorkspaceStructure {
  if (Array.isArray(value)) {
    return {
      summary: null,
      paths: value.map((item, index) => sanitizeWorkspacePath(item, index)),
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
    paths: rawPaths.map((item, index) => sanitizeWorkspacePath(item, index)),
    notes: stringList(record.notes),
  };
}

function sanitizeAppBuild(
  value: unknown,
  index: number,
): OnboardingAlignmentAppBuild {
  if (typeof value === "string") {
    const appId = normalizedString(value);
    if (!appId) {
      throw new Error(`app_builds[${index}] must not be empty`);
    }
    return {
      app_id: appId,
      summary: null,
      starter_scope: [],
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`app_builds[${index}] must be an object or string`);
  }
  const appId = readString(record, ["app_id", "id", "slug", "name"]);
  if (!appId) {
    throw new Error(`app_builds[${index}].app_id is required`);
  }
  return {
    app_id: appId,
    summary: readOptionalString(record, ["summary", "description", "purpose", "title", "name"]),
    starter_scope: Array.isArray(record.starter_scope)
      ? stringList(record.starter_scope)
      : Array.isArray(record.scope)
        ? stringList(record.scope)
        : Array.isArray(record.slices)
          ? stringList(record.slices)
          : Array.isArray(record.core_features)
            ? stringList(record.core_features)
            : Array.isArray(record.features)
              ? stringList(record.features)
              : [],
    notes: stringList(record.notes),
  };
}

function sanitizeSkill(
  value: unknown,
  index: number,
): OnboardingAlignmentSkill {
  if (typeof value === "string") {
    const skillId = normalizedString(value);
    if (!skillId) {
      throw new Error(`skills[${index}] must not be empty`);
    }
    return {
      skill_id: skillId,
      title: null,
      purpose: null,
      triggers: [],
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`skills[${index}] must be an object or string`);
  }
  const skillId = readString(record, ["skill_id", "id", "slug", "name", "title"]);
  if (!skillId) {
    throw new Error(`skills[${index}].skill_id is required`);
  }
  return {
    skill_id: skillId,
    title: readOptionalString(record, ["title", "name"]),
    purpose: readOptionalString(record, ["purpose", "summary", "description"]),
    triggers: Array.isArray(record.triggers)
      ? stringList(record.triggers)
      : Array.isArray(record.when_to_use)
        ? stringList(record.when_to_use)
        : [],
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
      name,
      schedule: null,
      summary: null,
      instruction: null,
      notes: [],
    };
  }
  const record = asRecord(value);
  if (!record) {
    throw new Error(`cronjobs[${index}] must be an object or string`);
  }
  const name = readString(record, ["name", "id", "title"]);
  if (!name) {
    throw new Error(`cronjobs[${index}].name is required`);
  }
  return {
    name,
    schedule: readOptionalString(record, ["schedule", "cron"]),
    summary: readOptionalString(record, ["summary", "description", "purpose"]),
    instruction: readOptionalString(record, ["instruction", "prompt"]),
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
  const question = readString(record, ["question", "prompt", "summary", "description"]);
  if (!question) {
    throw new Error(`open_questions[${index}].question is required`);
  }
  return {
    question,
    blocking: record.blocking === true,
    notes: readOptionalString(record, ["notes", "note", "context"]),
  };
}

function sanitizeAiManagerBehavior(
  value: unknown,
): OnboardingAlignmentAiManagerBehavior {
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
    personality_traits: Array.isArray(record.personality_traits)
      ? stringList(record.personality_traits)
      : Array.isArray(record.personality)
        ? stringList(record.personality)
        : [],
    default_behaviors: Array.isArray(record.default_behaviors)
      ? stringList(record.default_behaviors)
      : Array.isArray(record.behaviors)
        ? stringList(record.behaviors)
        : [],
    guardrails: Array.isArray(record.guardrails)
      ? stringList(record.guardrails)
      : Array.isArray(record.constraints)
        ? stringList(record.constraints)
        : [],
    notes: stringList(record.notes),
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

  const rawAppBuilds = Array.isArray(value.app_builds)
    ? value.app_builds
    : Array.isArray(value.apps_to_create)
      ? value.apps_to_create
      : [];
  const rawSkills = Array.isArray(value.skills) ? value.skills : [];
  const rawCronjobs = Array.isArray(value.cronjobs) ? value.cronjobs : [];
  const rawOpenQuestions = Array.isArray(value.open_questions) ? value.open_questions : [];

  return {
    report_type: ONBOARDING_ALIGNMENT_REPORT_TYPE,
    schema_version: ONBOARDING_ALIGNMENT_REPORT_SCHEMA_VERSION,
    summary,
    markdown,
    workspace_structure: sanitizeWorkspaceStructure(value.workspace_structure),
    app_builds: rawAppBuilds.map((item, index) => sanitizeAppBuild(item, index)),
    skills: rawSkills.map((item, index) => sanitizeSkill(item, index)),
    cronjobs: rawCronjobs.map((item, index) => sanitizeCronjob(item, index)),
    ai_manager_behavior: sanitizeAiManagerBehavior(value.ai_manager_behavior),
    open_questions: rawOpenQuestions.map((item, index) => sanitizeOpenQuestion(item, index)),
    implementation_notes: stringList(value.implementation_notes),
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
