/**
 * Failure text for the transcript: what the user reads when a run dies.
 *
 * These live outside index.tsx because they are pure functions over an event
 * payload, and because ChatPane's module graph cannot be imported by a test
 * (`@/components/ui/icons` pulls a package whose exports map node's resolver
 * rejects). Keeping them here is what makes the behaviour testable at all.
 *
 * ## The wallet case
 *
 * A run blocked on credits reaches the transcript as the raw upstream body,
 * because the run's stored error is that body verbatim. In one production week
 * the same condition surfaced four different ways, only one of them a sentence.
 *
 * The signal to match on is `provider_http.parsed_body.detail.code`, NOT the
 * message text. The harness captures the raw upstream response into a ring
 * buffer and attaches it to `run_failed` (`providerHttpPayloadFromCapture`,
 * harness-host/src/pi.ts) precisely because the SDK destroys it: `payload.message`
 * is built by `extractDeepProviderMessage`, which descends `detail` → `message`
 * and returns only the human sentence, dropping `code`.
 *
 * That distinction decides whether this works at all. Which message shape the
 * SDK produces depends on the wire, and the wire depends on the model:
 *
 *   openai-completions / -responses  reads `body.error` → our `{"detail":…}`
 *                                    body yields "402 status code (no body)"
 *   anthropic-messages               reads the whole body → the JSON survives
 *
 * `agent-runtime-config.ts` routes `claude*`/`anthropic/*` to the native wire and
 * EVERYTHING ELSE to the openai-compatible one, and the desktop default model is
 * `openai/gpt-5.4`. So a text matcher would miss the default model entirely — it
 * would only ever fire for users who had switched to Claude. The structured
 * field is present on both wires.
 *
 * ## Why not match "402", or the code as a bare substring
 *
 * An earlier version matched `/\b402\b/` plus "payment required" and
 * "insufficient quota|credit". Measured against real inputs it was wrong in the
 * expensive direction — rewriting a NON-wallet failure is worse than showing raw
 * JSON, because it names the wrong problem and deletes the real message:
 *
 *  - the phrase rules caught zero real wallet blocks (all carry a leading 402)
 *    while being the sole trigger for false positives;
 *  - a bare 402 appears in stack traces (`agent.js:402:17`), durations, ports,
 *    and `at position 402`;
 *  - a BYO/custom-provider 402 means the USER'S OWN provider account is out of
 *    credit — that send path returns before the quota gate — so "top up your
 *    plan" names the wrong account and deletes the provider's remediation link;
 *  - one false positive erased the string `parseModelError` matches on, killing
 *    the "switch model and retry" card.
 *
 * A bare `includes(code)` over free text is not enough either: `run_failed`'s
 * message falls back to the assistant's own prose when no error string exists,
 * so an agent that merely DISCUSSES the error code would have its answer
 * replaced by "you're out of credits". Hence the anchored `detail`-nested form
 * below for the surfaces that have no structured capture.
 */

/**
 * Codes our quota gate emits (model_proxy/quota.py). Emitted only by that gate,
 * which the BYO path never reaches — so one of these is proof that the Holaboss
 * wallet, not the user's own provider, blocked the run.
 */
const WALLET_BLOCK_MESSAGES = {
  // Actionable WITHOUT topping up (send less), so it must not collapse into the
  // generic message.
  model_proxy_call_exceeds_balance:
    "This request costs more than your remaining balance. Top up, or start a shorter conversation.",
  model_proxy_insufficient_quota:
    "You're out of credits. Top up your plan to keep using your agent.",
} as const;

type WalletBlockCode = keyof typeof WALLET_BLOCK_MESSAGES;

/**
 * The gate's body is `{"detail":{"code":…}}`. Anchoring on that nesting is what
 * separates a real wire body from prose that happens to quote a code — the
 * latter would have to reproduce the whole structure to match.
 */
const NESTED_WALLET_CODE =
  /"detail"\s*:\s*\{[^{}]*"code"\s*:\s*"(model_proxy_insufficient_quota|model_proxy_call_exceeds_balance)"/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWalletBlockCode(value: unknown): value is WalletBlockCode {
  return typeof value === "string" && value in WALLET_BLOCK_MESSAGES;
}

/**
 * Read the gate's code out of the raw upstream response the harness captured.
 * This is the authoritative source: it survives both wires, and it carries
 * exactly one code, so there is no precedence question between two codes that a
 * concatenated message could otherwise present.
 */
export function walletBlockFromPayload(
  payload: Record<string, unknown>,
): string | null {
  const providerHttp = payload.provider_http;
  if (!isRecord(providerHttp)) {
    return null;
  }
  const parsedBody = providerHttp.parsed_body;
  if (!isRecord(parsedBody)) {
    return null;
  }
  // FastAPI also emits a string `detail` for plain HTTPExceptions.
  const detail = parsedBody.detail;
  if (!isRecord(detail)) {
    return null;
  }
  const code = detail.code;
  return isWalletBlockCode(code) ? WALLET_BLOCK_MESSAGES[code] : null;
}

/**
 * Last resort for surfaces that carry no captured response — the runtime's
 * `last_error` is `{message}` only, written from a thrown executor error. Kept
 * anchored to the gate's nested body shape (see NESTED_WALLET_CODE).
 */
export function walletBlockFromText(text: string): string | null {
  const match = NESTED_WALLET_CODE.exec(text);
  const code = match?.[1];
  return isWalletBlockCode(code) ? WALLET_BLOCK_MESSAGES[code] : null;
}

function walletBlock(
  payload: Record<string, unknown>,
  detail: string,
): string | null {
  return (
    walletBlockFromPayload(payload) ?? (detail ? walletBlockFromText(detail) : null)
  );
}

export function runFailedContextLabel(payload: Record<string, unknown>): string {
  const provider =
    typeof payload.provider === "string" ? payload.provider.trim() : "";
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (provider && model) {
    return `${provider}/${model}`;
  }
  return provider || model;
}

export function runFailedDetail(payload: Record<string, unknown>): string {
  const detail =
    typeof payload.error === "string"
      ? payload.error.trim()
      : typeof payload.message === "string"
        ? payload.message.trim()
        : "";
  // Returned WITHOUT the provider/model prefix: an empty wallet is a condition
  // of the account, not of the model that happened to be running. Labelled with
  // one, it reads as that model's fault, so the user's next move is to switch
  // models — which cannot work.
  const block = walletBlock(payload, detail);
  if (block) {
    return block;
  }
  const contextLabel = runFailedContextLabel(payload);
  if (!contextLabel) {
    return detail || "The run failed.";
  }
  if (!detail) {
    return `${contextLabel} failed.`;
  }
  return detail.startsWith(contextLabel)
    ? detail
    : `${contextLabel}: ${detail}`;
}

/**
 * The runtime-state poller's path into the same transcript, used when the SSE
 * stream missed the terminal event. Same wallet handling — otherwise the exact
 * bug this module exists to fix reappears on the same screen by another route.
 */
export function runtimeStateErrorDetail(value: unknown): string {
  if (typeof value === "string") {
    return walletBlockFromText(value) ?? value;
  }
  if (isRecord(value)) {
    const message = value.message;
    const error = value.error;
    const detail =
      typeof message === "string" && message.trim()
        ? message
        : typeof error === "string" && error.trim()
          ? error
          : "";
    const block = walletBlock(value, detail);
    if (block) {
      return block;
    }
    if (detail) {
      return detail;
    }
  }
  return "The run failed.";
}
