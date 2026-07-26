export interface ActiveUserQuestionOption {
  id: string;
  label: string;
  description: string | null;
  answerText: string | null;
  recommended: boolean;
}

export interface ActiveUserQuestionItem {
  id: string;
  title: string | null;
  prompt: string;
  details: string | null;
  allowNotes: boolean;
  notesPlaceholder: string | null;
  allowFreeform: boolean;
  freeformPlaceholder: string | null;
  options: ActiveUserQuestionOption[];
}

export interface ActiveUserQuestion {
  title: string | null;
  details: string | null;
  questions: ActiveUserQuestionItem[];
}

// One answer per question, matching the runtime's
// `/ask-user-question/answer` contract (`answers[]`).
export interface ActiveUserQuestionAnswer {
  question_id: string;
  option_id?: string | null;
  response_text?: string | null;
  notes?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOption(
  value: unknown,
  index: number,
): ActiveUserQuestionOption | null {
  if (!isRecord(value)) {
    return null;
  }
  const label = readString(value.label);
  if (!label) {
    return null;
  }
  return {
    id: readString(value.id) ?? `option_${index + 1}`,
    label,
    description: readString(value.description),
    answerText: readString(value.answer_text),
    recommended: value.recommended === true,
  };
}

function parseItem(
  value: unknown,
  index: number,
): ActiveUserQuestionItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const prompt = readString(value.prompt);
  if (!prompt) {
    return null;
  }
  const rawOptions = Array.isArray(value.options) ? value.options : [];
  const options = rawOptions
    .map((option, optionIndex) => parseOption(option, optionIndex))
    .filter((option): option is ActiveUserQuestionOption => option !== null);
  const title = readString(value.title);
  return {
    id: readString(value.id) ?? `question_${index + 1}`,
    title: title && title !== prompt ? title : null,
    prompt,
    details: readString(value.details),
    allowNotes: value.allow_notes === true,
    notesPlaceholder: readString(value.notes_placeholder),
    // The runtime defaults freeform on; only an explicit `false` disables it.
    allowFreeform: value.allow_freeform !== false,
    freeformPlaceholder: readString(value.freeform_placeholder),
    options,
  };
}

// The session record already carries the runtime-sanitized shape
// (snake_case). This reader is defensive: it maps to camelCase, drops
// malformed entries, and returns null when nothing renderable survives so
// callers fall back to the plain markdown transcript.
export function parseActiveUserQuestion(
  raw: Record<string, unknown> | null | undefined,
): ActiveUserQuestion | null {
  if (!isRecord(raw)) {
    return null;
  }
  const rawQuestions = Array.isArray(raw.questions) ? raw.questions : [];
  const questions = rawQuestions
    .map((question, index) => parseItem(question, index))
    .filter((question): question is ActiveUserQuestionItem => question !== null);
  if (questions.length === 0) {
    return null;
  }
  return {
    title: readString(raw.title),
    details: readString(raw.details),
    questions,
  };
}

export function recommendedOption(
  question: ActiveUserQuestionItem,
): ActiveUserQuestionOption | null {
  return question.options.find((option) => option.recommended) ?? null;
}
