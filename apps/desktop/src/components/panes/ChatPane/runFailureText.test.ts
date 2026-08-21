import assert from "node:assert/strict";
import { test } from "node:test";

import { runFailedDetail, runtimeStateErrorDetail } from "./runFailureText";

const CREDITS = "You're out of credits. Top up your plan to keep using your agent.";

/**
 * Payloads below are the real `run_failed` shape (harness-host/src/pi.ts) unless
 * marked constructed. The gate's body is `{"detail":{"code":…}}`; the harness
 * attaches the captured raw response as `provider_http`.
 *
 * The bar is asymmetric. Failing to rewrite a wallet block leaves the user where
 * they already are — reading JSON. Rewriting something that is NOT a wallet block
 * is worse than the bug: it names the wrong problem and deletes the real message,
 * including any link that would have fixed it. The negative half of this file is
 * the load-bearing half.
 */

const walletCapture = (code: string) => ({
  status: 402,
  status_text: "Payment Required",
  parsed_body: { detail: { code, message: "User does not have sufficient quota" } },
});

// ------------------------------------------------------------------ positives

test("the default model's wire shape is recognized (the code is not in the message)", () => {
  // openai/gpt-5.4 is the desktop default -> openai-compatible wire -> the SDK
  // reads body.error, finds nothing in our {"detail":…} body, and reports
  // "no body". A text matcher misses this entirely; the capture still has it.
  assert.equal(
    runFailedDetail({
      type: "ProviderError",
      message:
        "402 status code (no body): User does not have sufficient quota for model proxy requests",
      provider: "openai",
      model: "openai/gpt-5.4",
      provider_http: walletCapture("model_proxy_insufficient_quota"),
    }),
    CREDITS,
  );
});

test("the anthropic wire shape is recognized too", () => {
  assert.equal(
    runFailedDetail({
      message:
        '402 {"detail":{"code":"model_proxy_insufficient_quota","message":"User does not have sufficient quota for model proxy requests"}}',
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      provider_http: walletCapture("model_proxy_insufficient_quota"),
    }),
    CREDITS,
  );
});

test("a prompt too big to afford gets its own, actionable message", () => {
  // Fixable by shortening the turn, so it must not collapse into "top up".
  const detail = runFailedDetail({
    message: "402 status code (no body)",
    provider_http: walletCapture("model_proxy_call_exceeds_balance"),
  });
  assert.match(detail, /remaining balance/);
  assert.doesNotMatch(detail, /out of credits/);
});

test("without a capture, the gate's nested body in the message still works", () => {
  // Surfaces that carry no captured response (the runtime's last_error is
  // {message} only, written from a thrown executor error).
  assert.equal(
    runFailedDetail({
      message:
        '402 {"detail":{"code":"model_proxy_insufficient_quota","message":"User does not have sufficient quota"}}',
    }),
    CREDITS,
  );
});

test("the poller's path into the same transcript gets the same treatment", () => {
  // Otherwise the bug reappears on the same screen by another route.
  assert.equal(
    runtimeStateErrorDetail({
      message:
        '402 {"detail":{"code":"model_proxy_insufficient_quota","message":"User does not have sufficient quota"}}',
    }),
    CREDITS,
  );
});

// ------------------------------------------------------------------ negatives

test("another model_proxy_* code is not a wallet block", () => {
  // Seven other model_proxy_* codes exist; a `startsWith("model_proxy_")` or a
  // bare includes("model_proxy_") would tell a user with a misconfigured proxy
  // to go buy credits.
  const detail = runFailedDetail({
    message: "503 Model proxy is not configured",
    provider: "openai",
    model: "openai/gpt-5.4",
    provider_http: {
      status: 503,
      parsed_body: { detail: { code: "model_proxy_not_configured" } },
    },
  });
  assert.doesNotMatch(detail, /credits|balance/i);
  assert.match(detail, /not configured/);
});

test("an OpenAI-style error code is not a wallet block", () => {
  // A matcher keyed on the presence of a "code" field rewrites this into
  // "you're out of credits" and deletes the actual cause.
  const raw =
    '401 {"error":{"message":"Incorrect API key provided: sk-***","code":"invalid_api_key"}}';
  assert.match(runFailedDetail({ message: raw }), /invalid_api_key/);
});

test("a rate limit is not a wallet block", () => {
  const raw = '429 {"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}';
  assert.match(runFailedDetail({ message: raw }), /rate_limit_exceeded/);
});

test("an agent DISCUSSING the error code keeps its own words", () => {
  // run_failed's message falls back to the assistant's own prose when there is
  // no error string (normalizeAssistantFailureMessage). A bare includes(code)
  // replaces the agent's answer with "you're out of credits" — the exact failure
  // mode this module exists to avoid, reachable by asking about the error.
  const prose =
    'Your gate returns {"code":"model_proxy_insufficient_quota"} when the wallet blocks a run — I will add a test for it.';
  assert.equal(runFailedDetail({ message: prose }), prose);
});

test("a BYO provider's own 402 is left completely alone", () => {
  // The BYO send path returns before the quota gate, so a 402 here is the
  // USER'S OWN provider account. Rewriting points at the wrong account and
  // deletes the link that would have fixed it.
  const raw =
    'OpenRouter API error (402): {"error":{"message":"This request requires more credits, or fewer max_tokens. To increase, visit https://openrouter.ai/settings/credits","code":402}}';
  const detail = runFailedDetail({ message: raw });
  assert.match(detail, /openrouter\.ai\/settings\/credits/);
  assert.doesNotMatch(detail, /Top up your plan/);
});

test("a stack trace that happens to contain 402 is not a wallet block", () => {
  // constructed — line:column numbers are the commonest way a bare 402 shows up.
  const raw =
    "TypeError: Cannot read properties of undefined (reading 'id')\n    at handleTurn (agent.js:402:17)";
  assert.match(runFailedDetail({ message: raw }), /TypeError/);
});

test("another service's 'insufficient quota' is not our wallet", () => {
  // Google Drive says this when the DRIVE is full — "top up your plan" is both
  // wrong and unfixable.
  const raw =
    'Google Drive error: {"error":{"code":403,"message":"The user\'s Drive storage quota has been exceeded.","reason":"insufficient quota"}}';
  assert.match(runFailedDetail({ message: raw }), /Drive storage quota/);
});

test("a string-valued FastAPI detail does not match or crash", () => {
  // Plain HTTPExceptions serialize detail as a string, not an object.
  const detail = runFailedDetail({
    message: "500 Internal Server Error",
    provider_http: { status: 500, parsed_body: { detail: "something broke" } },
  });
  assert.doesNotMatch(detail, /credits|balance/i);
});

// ------------------------------------------------------- prefix and structure

test("a wallet block carries no provider/model label", () => {
  // The label reads as a fault of that model, so the user tries switching, which
  // cannot work. (It also costs room against the 120-char truncation one caller
  // applies — enough to cut the longer of the two messages past its verb.)
  const detail = runFailedDetail({
    message: "402 status code (no body)",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    provider_http: walletCapture("model_proxy_insufficient_quota"),
  });
  assert.equal(detail, CREDITS);
  assert.doesNotMatch(detail, /anthropic|claude/i);
});

test("a non-wallet failure still gets its provider/model label", () => {
  assert.equal(
    runFailedDetail({
      message: "upstream timed out",
      provider: "openai",
      model: "gpt-5.4",
    }),
    "openai/gpt-5.4: upstream timed out",
  );
});

test("an already-labelled detail is not labelled twice", () => {
  assert.equal(
    runFailedDetail({
      message: "openai/gpt-5.4: upstream timed out",
      provider: "openai",
      model: "gpt-5.4",
    }),
    "openai/gpt-5.4: upstream timed out",
  );
});

test("an empty payload still says something", () => {
  assert.equal(runFailedDetail({}), "The run failed.");
  assert.equal(runtimeStateErrorDetail(null), "The run failed.");
});

test("the captured code wins over a stale code quoted in the message", () => {
  // buildPendingFailureRunFailed pairs attempt-1's message with attempt-N's
  // capture, so both can disagree. Telling someone at -89 credits to "start a
  // shorter conversation" sends them somewhere no shorter conversation reaches.
  assert.equal(
    runFailedDetail({
      message:
        '402 {"detail":{"code":"model_proxy_call_exceeds_balance","balanceCredits":1}}: User does not have sufficient quota',
      provider_http: walletCapture("model_proxy_insufficient_quota"),
    }),
    CREDITS,
  );
});

// ------------------------------------------------- round-3 regressions

test("an agent QUOTING the gate's body verbatim keeps its own words", () => {
  // The natural way to explain this error is to paste the body, so an anchor
  // that merely looks for the nested shape ANYWHERE is defeated by the very
  // conversation the feature invites. Reachable: run_failed's message falls back
  // to the assistant's prose, and on `aborted` (the user pressing Stop) no
  // capture is attached at all, so the text path is the only matcher.
  const prose = [
    "That 402 is the wallet gate. The body it returns is",
    '402 {"detail":{"code":"model_proxy_insufficient_quota","message":"User does not have sufficient quota for model proxy requests"}}',
    "and I have added a regression test for it.",
  ].join("\n");
  assert.equal(runFailedDetail({ message: prose }), prose);
});

test("a docs payload echoed by a tool result is not a wallet block", () => {
  const raw =
    'MCP tool "billing_docs" returned: {"detail":{"code":"model_proxy_insufficient_quota"},"note":"example payload from our docs"}';
  assert.equal(runFailedDetail({ message: raw }), raw);
});

test("a capture that is NOT a wallet block overrides a stale code in the text", () => {
  // The mirror of the precedence test above. The capture is the response the
  // request actually got; when it says "not a wallet block" that is an answer,
  // not a gap to fill from a concatenated message.
  // The message is a well-formed wire error carrying a wallet code, so the text
  // matcher WOULD accept it — only the capture stops it. Reachable whenever the
  // two disagree: the harness picks the capture by recency over a 5-minute
  // window, and a message built on an earlier attempt outlives its own response.
  const detail = runFailedDetail({
    message: '402 {"detail":{"code":"model_proxy_insufficient_quota"}}',
    provider_http: {
      status: 503,
      parsed_body: { detail: { code: "model_proxy_not_configured" } },
    },
  });
  assert.doesNotMatch(detail, /credits|balance/i);
});

test("a prototype-chain key in an untrusted body cannot escape the string type", () => {
  // `"code" in MESSAGES` is true for "toString" and returns a FUNCTION out of a
  // `: string` signature — into a React child, which throws for an object.
  // detail.code is untrusted upstream 4xx content.
  for (const code of ["toString", "__proto__", "constructor", "valueOf"]) {
    const detail = runFailedDetail({
      message: "500 upstream said something odd",
      provider_http: { status: 500, parsed_body: { detail: { code } } },
    });
    assert.equal(typeof detail, "string", `${code} produced a ${typeof detail}`);
    assert.doesNotMatch(detail, /native code|object Object/);
  }
});

test("a null or non-object detail in the captured body does not throw", () => {
  // `detail` is null on plenty of upstream bodies; reading `.code` off it is a
  // TypeError that takes down the whole failure render, so the run shows nothing
  // at all rather than an error.
  for (const detail of [null, "something broke", 42, ["a"]]) {
    assert.doesNotThrow(
      () =>
        runFailedDetail({
          message: "500 Internal Server Error",
          provider_http: { status: 500, parsed_body: { detail } },
        }),
      `detail=${JSON.stringify(detail)}`,
    );
  }
});

test("key order inside the gate's body does not matter", () => {
  // The real insufficient_quota body nests a "quota" object next to "code"; a
  // regex reaching for "code" inside "detail" dies the moment another key sorts
  // ahead of it, with nothing to catch it.
  assert.equal(
    runFailedDetail({
      message:
        '402 {"detail":{"quota":{"balance":-89,"totalAllocated":6000},"code":"model_proxy_insufficient_quota","message":"User does not have sufficient quota"}}',
    }),
    CREDITS,
  );
});

// ------------------------------------------------- round-4 regressions

test("a wallet code on a non-402 capture is ignored, and the recovery card survives", () => {
  // The capture is chosen by RECENCY across every endpoint the run touched, so
  // a wallet code can ride in on a response that was not a wallet block.
  // Rewriting here would delete the "<provider>/<model>: 5xx error code: 5xx"
  // string ModelErrorRecovery matches on, removing the "switch model and retry"
  // card — swapping a real remedy for a wrong one.
  const detail = runFailedDetail({
    message: "502 error code: 502",
    provider: "openai",
    model: "gpt-5.5",
    provider_http: {
      status: 500,
      parsed_body: { detail: { code: "model_proxy_insufficient_quota" } },
    },
  });
  assert.doesNotMatch(detail, /out of credits/);
  assert.match(detail, /5\d{2}\s+error\s+code:\s*5\d{2}/);
});

test("a capture with no parsed body does not suppress a legitimate text match", () => {
  // captureBody only fills parsed_body for json content types that parse within
  // 64 KB, but provider_http is attached either way. Keying the early return on
  // the wrapper showed raw JSON whenever the body was non-JSON or truncated.
  for (const parsedBody of [null, undefined, "402 {\"detail\":"]) {
    assert.equal(
      runFailedDetail({
        message:
          '402 {"detail":{"code":"model_proxy_insufficient_quota","message":"User does not have sufficient quota"}}',
        provider_http: {
          status: 402,
          content_type: "text/plain",
          parsed_body: parsedBody,
        },
      }),
      CREDITS,
      `parsed_body=${JSON.stringify(parsedBody)}`,
    );
  }
});

test("a wallet code nested under something other than detail is not our gate", () => {
  // Our gate replies {"detail":{"code":…}}. A code reached by recursing into
  // any key would accept a foreign body that merely mentions one.
  const raw = '402 {"error":{"code":"model_proxy_insufficient_quota"}}';
  assert.equal(runFailedDetail({ message: raw }), raw);
  assert.doesNotMatch(
    runFailedDetail({
      message: "402 upstream",
      provider_http: {
        status: 402,
        parsed_body: { error: { code: "model_proxy_insufficient_quota" } },
      },
    }),
    /out of credits/,
  );
});

test("a code merely mentioned elsewhere in the captured body is not a match", () => {
  // Guards a stringify-and-substring shortcut through the structured path.
  assert.doesNotMatch(
    runFailedDetail({
      message: "503 upstream",
      provider_http: {
        status: 402,
        parsed_body: {
          detail: {
            code: "model_proxy_not_configured",
            hint: "not model_proxy_insufficient_quota",
          },
        },
      },
    }),
    /out of credits|remaining balance/,
  );
});

test("a body truncated past parsing is not a wallet block", () => {
  // The capture truncates at 64 KB; a half-JSON string must not be pattern-read.
  const raw = '402 {"detail":{"code":"model_proxy_insufficient_quota","quota":{"bal';
  assert.equal(runFailedDetail({ message: raw }), raw);
});

test("trailing content after the wire JSON disqualifies the whole string", () => {
  // The end anchor is what separates a wire error from prose that opens with one.
  const raw =
    '402 {"detail":{"code":"model_proxy_insufficient_quota"}} — I hit this while testing.';
  assert.equal(runFailedDetail({ message: raw }), raw);
});

test("a 2xx prefix is not an SDK error message", () => {
  const raw = '200 {"detail":{"code":"model_proxy_insufficient_quota"}}';
  assert.equal(runFailedDetail({ message: raw }), raw);
});
