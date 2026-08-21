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
 * That distinction decides whether this works at all. Which message shape you get
 * depends on the wire (`harnesses/src/model-routing.ts` picks one of four), and
 * the OpenAI-family wires destroy the code:
 *
 *   openai-responses / openai-completions  read `body.error`; our `{"detail":…}`
 *                                          body has none, so the SDK reports
 *                                          "402 status code (no body)"
 *   anthropic-messages                     reads the whole body → JSON survives
 *
 * The desktop's effective default model comes from the control-plane binding
 * (`runtimeConfig?.defaultModel`), falling back to `openai/gpt-5.4` — an
 * OpenAI-family model either way, so it takes `openai-responses` and the code is
 * destroyed. A text matcher would therefore only ever have fired for users who
 * had switched to Claude. The captured response is present on every wire.
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
 * Free-text matching is the whole false-positive surface, so it is used ONLY
 * when no capture exists, and even then the WHOLE string must be a wire error.
 * `run_failed`'s message falls back to the assistant's own prose when there is
 * no error string, so an agent explaining this very error — quoting the gate's
 * body, which is the natural way to explain it — would otherwise have its answer
 * replaced by "you're out of credits".
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWalletBlockCode(value: unknown): value is WalletBlockCode {
  // hasOwnProperty, not `in`: `in` walks the prototype chain, so an upstream
  // body with `"code":"toString"` would return Object.prototype.toString — a
  // FUNCTION out of a `: string` signature, into a React child. `detail.code`
  // is untrusted 4xx content, including a user's own BYO provider's.
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(WALLET_BLOCK_MESSAGES, value)
  );
}

/** The gate's body is `{"detail":{"code":…}}`. */
function walletCodeFromBody(body: unknown): WalletBlockCode | null {
  if (!isRecord(body)) {
    return null;
  }
  // FastAPI also emits a string `detail` for plain HTTPExceptions.
  const detail = body.detail;
  if (!isRecord(detail)) {
    return null;
  }
  return isWalletBlockCode(detail.code) ? detail.code : null;
}

/**
 * Read the gate's code out of the raw upstream response the harness captured.
 * This is the authoritative source: it survives every wire, and it is the actual
 * response to the actual failed request rather than a string something built.
 */
export function walletBlockFromPayload(
  payload: Record<string, unknown>,
): string | null {
  const providerHttp = payload.provider_http;
  if (!isRecord(providerHttp)) {
    return null;
  }
  // The status must agree with the code. The capture is selected by RECENCY
  // over a 5-minute window across every endpoint the run touched (embeddings
  // included), so a wallet code can ride in on a response that was not a wallet
  // block. Accepting one would not just reword the failure: replacing a
  // "<provider>/<model>: 5xx error code: 5xx" message deletes the string
  // ModelErrorRecovery matches on, and with it the "switch model and retry"
  // card — trading a real remedy for a wrong one.
  if (providerHttp.status !== 402) {
    return null;
  }
  const code = walletCodeFromBody(providerHttp.parsed_body);
  return code ? WALLET_BLOCK_MESSAGES[code] : null;
}

/**
 * Last resort for surfaces that carry no captured response.
 *
 * PARSED, not pattern-matched. The SDK builds its message as exactly
 * `${status} ${JSON.stringify(body)}` (APIError.makeMessage), so requiring the
 * whole string to be that shape is what separates a real wire error from prose
 * quoting one — an explanation has words around the JSON, and they break the
 * anchors. Parsing also makes key order irrelevant: a regex reaching for "code"
 * inside "detail" silently stops matching the moment another key sorts ahead of
 * it, and the gate's own body already nests a "quota" object alongside.
 */
export function walletBlockFromText(text: string): string | null {
  // 4xx only: the doc's justification is that this is an SDK-built error
  // message, and a 2xx never is. `\d{3}` also accepted "200 {...}" and "999 {...}".
  const match = /^4\d{2} (\{[\s\S]*\})$/.exec(text.trim());
  if (!match) {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const code = walletCodeFromBody(body);
  return code ? WALLET_BLOCK_MESSAGES[code] : null;
}

function walletBlock(
  payload: Record<string, unknown>,
  detail: string,
): string | null {
  const structured = walletBlockFromPayload(payload);
  if (structured) {
    return structured;
  }
  // Defer to the capture only when it actually carries a parsed body. A capture
  // whose body was non-JSON or truncated past parsing (captureBody only fills
  // parsed_body for json content types that parse within 64 KB) has told us
  // nothing, yet `provider_http` is attached either way — so keying on the
  // wrapper suppressed a legitimate text match and showed raw JSON instead.
  //
  // When the body IS parsed and is not a wallet block, that is an answer rather
  // than a gap: falling through would let a stale code quoted in a concatenated
  // message override the response the request actually got.
  const capture = payload.provider_http;
  if (isRecord(capture) && isRecord(capture.parsed_body)) {
    return null;
  }
  return detail ? walletBlockFromText(detail) : null;
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
