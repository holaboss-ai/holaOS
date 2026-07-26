export interface HumanAgentError {
  /** Plain-language, user-facing line. Never raw internal jargon. */
  headline: string;
  /** The original text, surfaced only behind a "Show details" disclosure.
   *  Empty when the raw message already reads like a human sentence. */
  details: string;
}

const PATTERNS: { test: RegExp; headline: string }[] = [
  {
    test: /stale worker|abandoned by a stale|claimed input was abandoned|terminal event|runner emitted/i,
    headline: "This run was interrupted before it could finish. Try sending it again.",
  },
  {
    test: /timed out|timeout|deadline exceeded/i,
    headline: "This run took too long and timed out.",
  },
  {
    test: /econnrefused|enotfound|fetch failed|network|socket|disconnect|connection (refused|reset|closed)/i,
    headline: "Lost connection to the runtime while running this.",
  },
  {
    test: /out of memory|\boom\b|\bkilled\b|exit code (137|139)/i,
    headline: "The run ran out of resources before it could finish.",
  },
  {
    test: /rate limit|\b429\b|quota|too many requests/i,
    headline: "Hit a rate limit. Wait a moment, then try again.",
  },
  {
    test: /\bcancell?ed\b|\baborted\b/i,
    headline: "This run was cancelled.",
  },
];

const JARGON =
  /\b(worker|runner|runtime|stack|traceback|exception|payload|socket|emit(ted)?|sandbox|process|errno|exit code|null|undefined|nonetype|stderr|stdout)\b/i;
const CODEISH = /[{}[\]<>]|::|0x[0-9a-f]{4,}|\bat .+:\d+\)?/;

function looksTechnical(text: string): boolean {
  return JARGON.test(text) || CODEISH.test(text);
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Map a raw agent/runtime failure string to a calm, user-facing message.
 *  Keeps the original around (in `details`) for power users to expand —
 *  the caller decides whether to surface it. */
export function humanizeAgentError(
  raw: string | null | undefined,
): HumanAgentError {
  const text = (raw ?? "").trim();
  if (!text) {
    return { headline: "Something went wrong while running this.", details: "" };
  }

  for (const { test, headline } of PATTERNS) {
    if (test.test(text)) {
      return { headline, details: text };
    }
  }

  // Drop a short "Context: " prefix that the failure formatter may prepend.
  const body = text.replace(/^[^:\n]{1,40}:\s+/, "").trim() || text;

  if (looksTechnical(body)) {
    return { headline: "Something went wrong while running this.", details: text };
  }

  // Already reads like a human sentence — show it directly, no disclosure.
  return { headline: capitalize(body), details: "" };
}
