"""What every suite-standard@1.1 grader shares: outcomes and one normalized response shape."""

import json
import re

PASS = "pass"
WRONG = "wrong"
UNFINISHED = "unfinished"
FORMAT_ERROR = "format_error"
ABSTAINED = "abstained"
OUTCOMES = (PASS, WRONG, UNFINISHED, FORMAT_ERROR, ABSTAINED)

_THINK = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def verdict(outcome, detail=""):
    return {"outcome": outcome, "detail": detail}


def _arguments(raw):
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def normalize_response(response):
    """Ollama's /api/chat message (or the same fields at top level) → content, tool_calls, done_reason.

    Thinking is never graded: <think> blocks are removed from content and the separate `thinking` field
    is ignored. A tool call whose arguments are not a JSON object keeps arguments=None, so graders can
    report it as a format error instead of guessing.
    """
    msg = response.get("message", response)
    content = _THINK.sub("", msg.get("content") or "").strip()
    calls = []
    for call in msg.get("tool_calls") or []:
        fn = call.get("function", call)
        calls.append({"name": fn.get("name") or "", "arguments": _arguments(fn.get("arguments"))})
    return {"content": content, "tool_calls": calls, "done_reason": response.get("done_reason") or "stop"}
